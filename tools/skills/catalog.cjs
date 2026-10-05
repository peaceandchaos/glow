const { createHash } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { z } = require('zod');
const { resolveSkill } = require('./routing.cjs');

const lockPath = 'tools/skills/catalog.lock.json';
const lockedFile = {
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  headings: z.array(z.string().min(1)),
  rules: z.array(z.string().min(1)),
};
const lockSchema = z.strictObject({
  skills: z.record(
    z.string().min(1),
    z.strictObject({
      ...lockedFile,
      files: z.record(z.string().min(1), z.strictObject(lockedFile)).optional(),
    }),
  ),
});

// A rule is a numbered line, named by its heading and number, as in "Steps 2".
function sections(text) {
  const headings = [];
  const rules = [];
  let heading = '';
  let fenced = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    if (fenced) continue;
    const title = /^#{1,6}\s+(.+?)\s*$/u.exec(line);
    const rule = /^(\d+)\.\s+\S/u.exec(line);
    if (title) {
      heading = title[1];
      if (!headings.includes(heading)) headings.push(heading);
    } else if (rule && !rules.includes(`${heading} ${rule[1]}`)) {
      rules.push(`${heading} ${rule[1]}`);
    }
  }
  return { headings, rules };
}

function lockFile(text) {
  return {
    sha256: createHash('sha256').update(text).digest('hex'),
    ...sections(text),
  };
}

function nestedFile(skill, directory, path) {
  const file = join(directory, path);
  if (!existsSync(file))
    throw new Error(`Skill ${skill} has no file ${path} (${file}).`);
  return lockFile(readFileSync(file, 'utf8'));
}

function buildLock(routing, env, root) {
  const skills = {};
  for (const skill of Object.keys(routing.skills).sort()) {
    const file = resolveSkill(routing, skill, env, root);
    skills[skill] = lockFile(readFileSync(file, 'utf8'));
    const nested = routing.skillFiles[skill];
    if (nested)
      skills[skill].files = Object.fromEntries(
        nested.map(path => [path, nestedFile(skill, dirname(file), path)]),
      );
  }
  return { skills };
}

function citation(locked, cites) {
  const split = cites.indexOf(': ');
  const nested = cites.slice(0, split);
  return split > 0 && locked.files && Object.hasOwn(locked.files, nested)
    ? {
        nested,
        section: cites.slice(split + 2),
        sections: locked.files[nested],
      }
    : { nested: undefined, section: cites, sections: locked };
}

// `read` returns a file's text from the tree being checked, or null.
function readLock(read, routing) {
  const text = read(lockPath);
  if (text === null)
    return {
      lock: null,
      problems: [
        `No ${lockPath}. Run npm run skills:catalog -- --lock and commit it.`,
      ],
    };
  const lock = lockSchema.parse(JSON.parse(text));
  const listed = Object.keys(lock.skills).sort().join(' ');
  const catalogued = Object.keys(routing.skills).sort().join(' ');
  return {
    lock,
    problems:
      listed === catalogued
        ? []
        : [
            `${lockPath} does not list the skills in tools/skills/routing.json. Run npm run skills:catalog -- --lock.`,
          ],
  };
}

module.exports = { buildLock, citation, lockPath, readLock, sections };
