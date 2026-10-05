const { createHash } = require('node:crypto');
const { existsSync, readdirSync, readFileSync } = require('node:fs');
const { delimiter, join } = require('node:path');
const { git } = require('../verification/snapshot.cjs');
const { readLock } = require('./catalog.cjs');
const { headReader } = require('./records.cjs');
const { parseRouting, rootDirectory, routingPath } = require('./routing.cjs');

// pstack's own TDD skill differs from the routed user copy. The bare name tdd
// loads the user copy, so the doctor allows this one copy at this exact hash.
const allowedShadows = {
  'pstack:tdd':
    '276f883002b7a0b9be4ec982d0752fc68eaceed8e6db502316a87aa4600d152e',
};

const sha256 = text => createHash('sha256').update(text).digest('hex');

// Other places a session may load a skill from. No catalogued name may live
// there. SKILL_DOCTOR_ADD_DIRS lists the folders that a launcher passes to
// claude --add-dir, whose .claude/skills folders a session also reads.
function discoverable(repository, roots, skill, env) {
  const synced = roots.user ? join(roots.user, 'synced') : null;
  const added = (env.SKILL_DOCTOR_ADD_DIRS ?? '').split(delimiter);
  return [
    ...[repository, ...added.filter(Boolean)].map(folder =>
      join(folder, '.claude/skills', skill, 'SKILL.md'),
    ),
    ...(synced && existsSync(synced)
      ? readdirSync(synced).map(folder =>
          join(synced, folder, skill, 'SKILL.md'),
        )
      : []),
  ].filter(file => existsSync(file));
}

function nestedProblems(skill, folder, files, copy) {
  const problems = [];
  for (const [path, { sha256: pinned }] of Object.entries(files ?? {})) {
    const file = join(folder, path);
    if (!existsSync(file)) {
      problems.push(`${skill}: ${copy} has no ${path} (${file}).`);
      continue;
    }
    const hash = sha256(readFileSync(file, 'utf8'));
    if (hash !== pinned)
      problems.push(
        `${skill}: ${path} in ${copy} hashes ${hash.slice(0, 8)}, but the lock pins ${pinned.slice(0, 8)} (${file}).`,
      );
  }
  return problems;
}

// Compares every copy of every catalogued skill in every root with the lock at
// HEAD. `shadows` maps <root>:<skill> to the one differing hash allowed there.
function checkSkillCopies(repository, env, shadows = allowedShadows) {
  const read = headReader(repository, 'HEAD');
  const head = git(repository, ['rev-parse', 'HEAD']);
  const routing = parseRouting(read(routingPath));
  const { lock, problems: lockProblems } = readLock(read, routing);
  const skills = Object.keys(routing.skills).sort();
  if (!lock)
    return { problems: lockProblems, notes: [], skills: 0, copies: 0, head };
  const roots = Object.fromEntries(
    Object.keys(routing.roots).map(name => [
      name,
      rootDirectory(routing, name, env, repository),
    ]),
  );
  const problems = [];
  const notes = [];
  let copies = 0;
  for (const skill of skills) {
    const routed = routing.skills[skill];
    const locked = lock.skills[skill]?.sha256;
    if (!locked) {
      problems.push(`${skill}: it is catalogued but not in the lock.`);
      continue;
    }
    const routedFile = join(roots[routed], skill, 'SKILL.md');
    if (!existsSync(routedFile))
      problems.push(
        `${skill}: its routed root ${routed} has no copy (${routedFile}).`,
      );
    for (const [root, directory] of Object.entries(roots)) {
      const file = join(directory, skill, 'SKILL.md');
      if (!existsSync(file)) continue;
      copies += 1;
      const copy = `the ${root === routed ? 'routed' : 'duplicate'} copy in ${root}`;
      problems.push(
        ...nestedProblems(
          skill,
          join(directory, skill),
          lock.skills[skill].files,
          copy,
        ),
      );
      const hash = sha256(readFileSync(file, 'utf8'));
      if (hash === locked) continue;
      if (root !== routed && shadows[`${root}:${skill}`] === hash)
        notes.push(
          `${skill}: ${root}:${skill} differs from the lock (${hash.slice(0, 8)}), and is an allowed shadow.`,
        );
      else
        problems.push(
          `${skill}: ${copy} hashes ${hash.slice(0, 8)}, but the lock pins ${locked.slice(0, 8)} (${file}).`,
        );
    }
    for (const file of discoverable(repository, roots, skill, env))
      problems.push(
        `${skill}: Claude Code can also find a copy outside the routed roots (${file}).`,
      );
  }
  return { problems, notes, skills: skills.length, copies, head };
}

module.exports = { allowedShadows, checkSkillCopies };
