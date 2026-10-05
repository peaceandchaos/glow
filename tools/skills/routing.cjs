const { existsSync, readFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { z } = require('zod');

const routingPath = 'tools/skills/routing.json';
const changeSubject = '<change>';

const pattern = z.string().transform((source, context) => {
  try {
    return new RegExp(source, 'iu');
  } catch {
    context.addIssue({
      code: 'custom',
      message: 'must be a valid regular expression',
    });
    return z.NEVER;
  }
});
const globs = z
  .array(z.string().min(1))
  .min(1)
  .transform(list => list.map(globPattern));
const id = z.string().regex(/^[a-z0-9-]+$/u);
const segmentWithoutLeadingDot = '[\\w-][\\w.-]*';
const skillFilePath = z
  .string()
  .regex(
    new RegExp(
      `^(?:${segmentWithoutLeadingDot}/)*${segmentWithoutLeadingDot}$`,
      'u',
    ),
  );
const statuses = z
  .array(z.enum(['added', 'modified', 'deleted', 'renamed']))
  .min(1);
const ruleFields = {
  id,
  why: z.string().min(1),
  skills: z.array(z.string().min(1)).min(1),
  excludePaths: globs.optional(),
};
const fileRule = z.strictObject({
  ...ruleFields,
  scope: z.literal('file'),
  paths: globs.optional(),
  status: statuses.optional(),
  addedLines: pattern.optional(),
  removedExports: z.literal(true).optional(),
});
const changeRule = z.strictObject({
  ...ruleFields,
  scope: z.literal('change'),
  minChangedLines: z.int().positive().optional(),
  commitSubject: pattern.optional(),
});
// A tier describes the whole change. It ignores files under excludePaths, and
// every other file must pass its file filters, so its limits count only those.
const tier = z.strictObject({
  ...ruleFields,
  replaces: z.array(id).min(1),
  paths: globs.optional(),
  status: statuses.optional(),
  unlessRules: z.array(id).min(1).optional(),
  maxFiles: z.int().positive().optional(),
  maxChangedLines: z.int().positive().optional(),
});
const routingSchema = z.strictObject({
  roots: z.record(
    id,
    z.strictObject({
      env: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
      default: z.string().min(1).optional(),
    }),
  ),
  skills: z.record(id, z.string()),
  // Files beside a skill's SKILL.md that the lock also hashes, by path inside
  // the skill folder.
  skillFiles: z.record(id, z.array(skillFilePath).min(1)).default({}),
  tiers: z.array(tier).default([]),
  rules: z.array(z.discriminatedUnion('scope', [fileRule, changeRule])).min(1),
});

function parseRouting(text) {
  const routing = routingSchema.parse(JSON.parse(text));
  const problems = [];
  const rules = new Map();
  const checkSkills = (owner, skills) => {
    for (const skill of skills) {
      if (!routing.skills[skill])
        problems.push(`${owner} names unknown skill ${skill}.`);
    }
  };
  for (const [skill, root] of Object.entries(routing.skills)) {
    if (!routing.roots[root])
      problems.push(`Skill ${skill} names unknown root ${root}.`);
  }
  for (const rule of routing.rules) {
    if (rules.has(rule.id)) problems.push(`Rule ${rule.id} appears twice.`);
    rules.set(rule.id, rule);
    checkSkills(`Rule ${rule.id}`, rule.skills);
  }
  for (const {
    id: tierId,
    replaces,
    unlessRules = [],
    skills,
  } of routing.tiers) {
    for (const ruleId of replaces) {
      if (!rules.has(ruleId))
        problems.push(`Tier ${tierId} replaces unknown rule ${ruleId}.`);
    }
    for (const ruleId of unlessRules) {
      const rule = rules.get(ruleId);
      if (rule?.scope !== 'file' || needsContent(rule))
        problems.push(
          `Tier ${tierId} needs a path-only file rule, not ${ruleId}.`,
        );
    }
    checkSkills(`Tier ${tierId}`, skills);
  }
  checkSkills('skillFiles', Object.keys(routing.skillFiles));
  if (problems.length) throw new Error(problems.join('\n'));
  return routing;
}

function globPattern(glob) {
  let source = '';
  let braces = 0;
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (glob.startsWith('**/', index)) {
      source += '(?:.*/)?';
      index += 2;
    } else if (glob.startsWith('**', index)) {
      source += '.*';
      index += 1;
    } else if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else if (character === '{') {
      braces += 1;
      source += '(?:';
    } else if (character === '}' && braces) {
      braces -= 1;
      source += ')';
    } else if (character === ',' && braces) source += '|';
    else source += character.replace(/[$()+.[\\\]^{|}]/u, '\\$&');
  }
  return new RegExp(`^${source}$`, 'u');
}

function matchesAny(path, patterns) {
  return patterns.some(glob => glob.test(path));
}

function needsContent(rule) {
  return (
    rule.addedLines !== undefined ||
    rule.removedExports !== undefined ||
    rule.minChangedLines !== undefined ||
    rule.commitSubject !== undefined
  );
}

function filePaths(file) {
  return file.status === 'renamed' ? [file.from, file.path] : [file.path];
}

function excluded(rule, file) {
  return (
    rule.excludePaths !== undefined &&
    filePaths(file).every(path => matchesAny(path, rule.excludePaths))
  );
}

function fileMatches(rule, file, change) {
  if (excluded(rule, file)) return null;
  if (rule.paths && !filePaths(file).some(path => matchesAny(path, rule.paths)))
    return null;
  if (rule.status && !rule.status.includes(file.status)) return null;
  if (rule.addedLines !== undefined) {
    const lines = change.added.get(file.path) ?? [];
    if (!lines.some(line => rule.addedLines.test(line))) return null;
  }
  if (rule.removedExports) {
    const names = change.removedExports.get(file.path);
    return names ? { subject: file.path, detail: names.join(', ') } : null;
  }
  return { subject: file.path };
}

function changeMatch(rule, change) {
  const files = change.files.filter(file => !excluded(rule, file));
  if (!files.length) return null;
  const details = [];
  if (rule.minChangedLines !== undefined) {
    let lines = 0;
    for (const file of files) lines += change.lines.get(file.path) ?? 0;
    if (lines < rule.minChangedLines) return null;
    details.push(`${lines} changed lines`);
  }
  if (rule.commitSubject !== undefined) {
    const subjects = change.subjects.filter(subject =>
      rule.commitSubject.test(subject),
    );
    if (!subjects.length) return null;
    details.push(...subjects);
  }
  if (!details.length) return { subject: changeSubject };
  return { subject: changeSubject, detail: details.join('; ') };
}

function ruleMatches(rule, change) {
  if (rule.scope === 'change') {
    const match = changeMatch(rule, change);
    return match ? [match] : [];
  }
  const matches = [];
  for (const file of change.files) {
    const match = fileMatches(rule, file, change);
    if (match) matches.push(match);
  }
  return matches;
}

const counted = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

function tierMatch(tier, routing, change) {
  const files = change.files.filter(file => !excluded(tier, file));
  if (!files.length) return null;
  if (tier.maxFiles !== undefined && files.length > tier.maxFiles) return null;
  const unless = routing.rules.filter(rule =>
    tier.unlessRules?.includes(rule.id),
  );
  const passes = file =>
    (!tier.paths ||
      filePaths(file).every(path => matchesAny(path, tier.paths))) &&
    (!tier.status || tier.status.includes(file.status)) &&
    !unless.some(rule => fileMatches(rule, file, change));
  if (!files.every(passes)) return null;
  const details = [];
  if (tier.maxFiles !== undefined) details.push(counted(files.length, 'file'));
  if (tier.maxChangedLines !== undefined) {
    let lines = 0;
    for (const file of files) lines += change.lines.get(file.path) ?? 0;
    if (lines > tier.maxChangedLines) return null;
    details.push(counted(lines, 'changed line'));
  }
  if (!details.length) return { subject: changeSubject };
  return { subject: changeSubject, detail: details.join(', ') };
}

// The first matching tier wins. A plan has no line counts, so it skips a tier
// with a line limit and keeps the rules that tier would replace.
function matchTier(routing, change) {
  const skipped = [];
  for (const tier of routing.tiers) {
    if (change.kind === 'plan' && tier.maxChangedLines !== undefined) {
      skipped.push(tier.id);
      continue;
    }
    const match = tierMatch(tier, routing, change);
    if (match) return { tier, match, skipped };
  }
  return { tier: null, skipped };
}

function byText(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function requiredSkills(routing, change) {
  const skipped = [];
  const required = new Map();
  if (!change.files.length)
    return { tier: null, required: [], skipped, skippedTiers: [] };
  const { tier, match, skipped: skippedTiers } = matchTier(routing, change);
  const add = (owner, matches) => {
    for (const skill of owner.skills) {
      if (!required.has(skill)) required.set(skill, []);
      required.get(skill).push({ rule: owner.id, why: owner.why, matches });
    }
  };
  if (tier) add(tier, [match]);
  for (const rule of routing.rules) {
    if (tier?.replaces.includes(rule.id)) continue;
    if (change.kind === 'plan' && needsContent(rule)) {
      skipped.push(rule.id);
      continue;
    }
    const matches = ruleMatches(rule, change);
    if (!matches.length) continue;
    matches.sort((a, b) => byText(a.subject, b.subject));
    add(rule, matches);
  }
  return {
    tier,
    required: [...required]
      .sort(([a], [b]) => byText(a, b))
      .map(([skill, reasons]) => ({
        skill,
        reasons: reasons.sort((a, b) => byText(a.rule, b.rule)),
      })),
    skipped: skipped.sort(byText),
    skippedTiers,
  };
}

function rootDirectory(routing, name, env, repository) {
  const root = routing.roots[name];
  const configured = env[root.env] ?? root.default;
  if (!configured) {
    throw new Error(
      `Skill root ${name} is not configured. Set ${root.env} to the directory that holds <skill>/SKILL.md.`,
    );
  }
  const directory = configured.startsWith('~/')
    ? join(homedir(), configured.slice(2))
    : resolve(repository, configured);
  if (!existsSync(directory)) {
    throw new Error(
      `Skill root ${name} does not exist at ${directory}. Set ${root.env} to the directory that holds <skill>/SKILL.md.`,
    );
  }
  return directory;
}

// A skill in the user or repository root has its bare name as its reference.
// Every other root is a plugin, named for its root, as the installer maps it.
function qualifiedReference(routing, skill) {
  const root = routing.skills[skill];
  return root === 'user' || root === 'repo' ? skill : `${root}:${skill}`;
}

// The Skill tool cannot load a skill with disable-model-invocation, and it lists
// a repository skill only through a plugin copy, whose reference the check
// rejects. A full Read makes the receipt for both.
function loadInstruction(routing, skill, file, text) {
  return routing.skills[skill] === 'repo' ||
    /^---\n(?:(?!---\n).*\n)*?disable-model-invocation:\s*true\s*\n/u.test(text)
    ? `read all of ${file}`
    : `load ${qualifiedReference(routing, skill)} from ${file}`;
}

function localSkillFile(routing, skill, env, repository) {
  if (!routing.skills[skill]) return null;
  try {
    return resolveSkill(routing, skill, env, repository);
  } catch {
    return null;
  }
}

function receiptStep(routing, skill, env, repository, nested) {
  const file = localSkillFile(routing, skill, env, repository);
  if (!file)
    return nested
      ? `read all of ${nested} in the ${skill} skill folder`
      : `follow the line that npm run skills:required prints for ${skill}`;
  return nested
    ? `read all of ${join(dirname(file), nested)}`
    : loadInstruction(routing, skill, file, readFileSync(file, 'utf8'));
}

function resolveSkill(routing, skill, env, repository) {
  const root = routing.skills[skill];
  const file = join(
    rootDirectory(routing, root, env, repository),
    skill,
    'SKILL.md',
  );
  if (!existsSync(file))
    throw new Error(
      `Skill ${skill} has no SKILL.md in root ${root} (${file}).`,
    );
  const name = /^---\n(?:(?!---\n).*\n)*?name:\s*(\S+)\s*\n/u.exec(
    readFileSync(file, 'utf8'),
  );
  if (name?.[1] !== skill)
    throw new Error(`${file} does not declare name: ${skill}.`);
  return file;
}

module.exports = {
  globPattern,
  routingPath,
  changeSubject,
  loadInstruction,
  parseRouting,
  qualifiedReference,
  receiptStep,
  requiredSkills,
  resolveSkill,
  rootDirectory,
  skillFilePath,
};
