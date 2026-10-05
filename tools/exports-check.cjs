const { readFileSync } = require('node:fs');
const { dirname, join, posix, relative } = require('node:path');
const ts = require('typescript');
const { z } = require('zod');
const { git } = require('./verification/snapshot.cjs');

const entriesPath = 'tools/verification/export-entries.json';
const reason = z.string().min(1);
const entriesSchema = z.strictObject({
  projects: z.array(z.string().min(1)).min(1),
  files: z.array(z.strictObject({ path: z.string().min(1), reason })),
  exports: z.array(
    z.strictObject({
      file: z.string().min(1),
      name: z.string().min(1),
      reason,
    }),
  ),
});

function readProgram(root, project) {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(root, project),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: diagnostic => {
        throw new Error(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        );
      },
    },
  );
  return ts.createProgram(parsed.fileNames, parsed.options);
}

function moduleSpecifier(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier
  )
    return node.moduleSpecifier;
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference)
  )
    return node.moduleReference.expression;
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
  )
    return node.arguments[0];
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
    return node.argument.literal;
  return undefined;
}

function importedNames(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return ['*'];
    const names = clause.name ? ['default'] : [];
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) names.push('*');
    else if (bindings)
      for (const element of bindings.elements)
        names.push((element.propertyName ?? element.name).text);
    return names;
  }
  if (ts.isExportDeclaration(node)) {
    const clause = node.exportClause;
    if (!clause || ts.isNamespaceExport(clause)) return ['*'];
    return clause.elements.map(
      element => (element.propertyName ?? element.name).text,
    );
  }
  if (ts.isImportTypeNode(node) && node.qualifier)
    return [node.qualifier.getText().split('.')[0]];
  return ['*'];
}

function addImports(imported, from, node) {
  if (!imported.has(from)) imported.set(from, new Set());
  for (const name of importedNames(node)) imported.get(from).add(name);
}

// JavaScript tools import TypeScript source by relative path, outside every project.
function addJavaScriptImports(root, tracked, exported, imported) {
  for (const path of tracked) {
    if (!/\.[cm]?js$/u.test(path)) continue;
    const file = ts.createSourceFile(
      path,
      readFileSync(join(root, path), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const visit = node => {
      const specifier = moduleSpecifier(node)?.text;
      if (specifier?.startsWith('.')) {
        const target = posix.join(dirname(path), specifier);
        const from = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']
          .map(suffix => target + suffix)
          .find(candidate => exported.has(candidate));
        if (from) addImports(imported, from, node);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
}

function readModules(root, projects) {
  const tracked = new Set(git(root, ['ls-files']).split('\n'));
  const exported = new Map();
  const imported = new Map();
  for (const project of projects) {
    const program = readProgram(root, project);
    const checker = program.getTypeChecker();
    const own = file => {
      const path = relative(root, file.fileName);
      return !file.isDeclarationFile && tracked.has(path) ? path : null;
    };
    const target = specifier => {
      const symbol = specifier && checker.getSymbolAtLocation(specifier);
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      return declaration && ts.isSourceFile(declaration)
        ? own(declaration)
        : null;
    };
    for (const file of program.getSourceFiles()) {
      const path = own(file);
      if (!path) continue;
      const symbol = checker.getSymbolAtLocation(file);
      exported.set(
        path,
        symbol ? checker.getExportsOfModule(symbol).map(item => item.name) : [],
      );
      const visit = node => {
        const from = target(moduleSpecifier(node));
        if (from) addImports(imported, from, node);
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
  }
  addJavaScriptImports(root, tracked, exported, imported);
  return { exported, imported };
}

function checkExports(root) {
  const entries = entriesSchema.parse(
    JSON.parse(readFileSync(join(root, entriesPath), 'utf8')),
  );
  const { exported, imported } = readModules(root, entries.projects);
  const isImported = (file, name) =>
    imported.get(file)?.has('*') || imported.get(file)?.has(name);
  const problems = [];
  const entryFiles = new Set();
  for (const { path } of entries.files) {
    entryFiles.add(path);
    if (!exported.get(path)?.length)
      problems.push(
        `${entriesPath}: ${path} is listed as an entry point but is not a source file with exports.`,
      );
  }
  const entryExports = new Set();
  for (const { file, name } of entries.exports) {
    entryExports.add(`${file}\0${name}`);
    if (!exported.get(file)?.includes(name))
      problems.push(`${entriesPath}: ${file} does not export ${name}.`);
    else if (isImported(file, name))
      problems.push(
        `${entriesPath}: ${file} ${name} is imported now; remove its entry.`,
      );
  }
  for (const [file, names] of [...exported].sort()) {
    if (entryFiles.has(file)) continue;
    for (const name of [...names].sort())
      if (!isImported(file, name) && !entryExports.has(`${file}\0${name}`))
        problems.push(`${file}: ${name} is exported but never imported.`);
  }
  return problems;
}

try {
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  const problems = checkExports(root);
  if (problems.length) {
    console.error(
      [
        'Unused exports fail. Import the export, stop exporting it, or list it with a reason in tools/verification/export-entries.json:',
        ...problems,
      ].join('\n'),
    );
    process.exitCode = 1;
  } else {
    console.log('Every export is imported or listed as an entry.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
