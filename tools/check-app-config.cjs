const { readFileSync } = require('node:fs');
const { join } = require('node:path');

// config.ts is gitignored, so the credential scan never sees it, yet the
// bundler ships whatever it holds. It may contain only comments and
// `export const NAME = 'text';` statements for the names config.example.ts
// exports. Problems name the line and the name, never the value.
const statement = /export const ([A-Za-z_$][\w$]*) =\s*(['"])[^'"\\\n]*\2;?/y;
const comment = /\/\/[^\n]*|\/\*[\s\S]*?\*\//y;
const space = /\s+/y;

function scan(text, path) {
  const names = [];
  const problems = [];
  let index = 0;
  const lineAt = at => text.slice(0, at).split('\n').length;
  const take = pattern => {
    pattern.lastIndex = index;
    const match = pattern.exec(text);
    if (match) index = pattern.lastIndex;
    return match;
  };
  while (index < text.length) {
    if (take(space) || take(comment)) continue;
    const at = index;
    const match = take(statement);
    if (match) {
      names.push({ name: match[1], line: lineAt(at) });
      continue;
    }
    problems.push(
      `${path}:${lineAt(at)} is not a comment or an export const with a plain string`,
    );
    index =
      text.indexOf('\n', at) === -1 ? text.length : text.indexOf('\n', at);
  }
  return { names, problems };
}

function inspectAppConfig(config, example) {
  const path = 'packages/app/src/config.ts';
  const allowed = new Set(
    scan(example, 'config.example.ts').names.map(n => n.name),
  );
  const { names, problems } = scan(config, path);
  for (const { name, line } of names)
    if (!allowed.has(name))
      problems.push(
        `${path}:${line} exports ${name}, which config.example.ts does not`,
      );
  return problems;
}

function checkAppConfig(root) {
  const source = join(root, 'packages/app/src');
  return inspectAppConfig(
    readFileSync(join(source, 'config.ts'), 'utf8'),
    readFileSync(join(source, 'config.example.ts'), 'utf8'),
  );
}

module.exports = { checkAppConfig, inspectAppConfig };
