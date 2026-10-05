const { execFileSync, spawnSync } = require('node:child_process');
const {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} = require('node:fs');
const { join } = require('node:path');
const { z } = require('zod');
const { cleanEnvironment, git } = require('../verification/snapshot.cjs');
const { citation, readLock } = require('./catalog.cjs');
const { readRange } = require('./change.cjs');
const {
  actor,
  missingKey,
  pullReceipts,
  readPublicKey,
  receiptProblems,
  receiptSchema,
} = require('./receipts.cjs');
const { globPattern, requiredSkills } = require('./routing.cjs');

const recordsDirectory = 'tools/skills/records';
const recordFile = /^tools\/skills\/records\/([a-z0-9-]+)\.json$/u;

const changeId = /^[a-z0-9-]+$/u;
const patchId = z.string().regex(/^[0-9a-f]{40}$/u);
const baseSchema = z.strictObject({
  commit: z.string().regex(/^[0-9a-f]{40}$/u),
  patch: patchId.optional(),
});
const findingSchema = z
  .strictObject({
    finding: z.string().min(1),
    cites: z.string().min(1),
    commit: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/u)
      .optional(),
    patch: patchId.optional(),
    none: z.string().min(1).optional(),
    open: z.string().min(1).optional(),
  })
  .refine(
    finding =>
      [finding.commit, finding.none, finding.open].filter(
        status => status !== undefined,
      ).length === 1,
    'needs exactly one status: "commit" with the fixing commit, "none" with the reason none was needed, or "open" with what is left to do',
  )
  .refine(
    finding => finding.patch === undefined || finding.commit !== undefined,
    'has a "patch" without the "commit" it identifies',
  );
const recordSchema = z.strictObject({
  change: z.string().regex(changeId),
  base: baseSchema,
  skills: z
    .array(
      z.strictObject({
        skill: z.string().min(1),
        files: z.array(z.string().min(1)).min(1),
        reason: z.string().min(1).optional(),
        findings: z.array(findingSchema),
        receipts: z.array(receiptSchema),
      }),
    )
    .min(1),
  review: z
    .strictObject({
      skills: z
        .array(
          z.strictObject({
            skill: z.string().min(1),
            findings: z.array(findingSchema),
            receipts: z.array(receiptSchema),
          }),
        )
        .min(1),
    })
    .optional(),
});

// A copy keeps its patch-id unless a conflict changed its diff.
function patchIds(root, revisions) {
  const run = (args, input) =>
    execFileSync('git', args, {
      cwd: root,
      env: cleanEnvironment(),
      encoding: 'utf8',
      input,
      maxBuffer: 256 * 1024 * 1024,
    });
  const log = run([
    'log',
    '--patch',
    '--no-color',
    '--no-ext-diff',
    '--find-renames',
    '--format=commit %H',
    ...revisions,
  ]);
  const ids = new Map();
  for (const line of run(['patch-id', '--stable'], log).split('\n')) {
    const [patch, commit] = line.split(' ');
    if (commit) ids.set(commit, patch);
  }
  return ids;
}

function rangeCommits(root, change) {
  const commits = new Map(
    git(root, ['rev-list', `${change.base}..${change.head}`])
      .split('\n')
      .filter(Boolean)
      .map(commit => [commit, undefined]),
  );
  for (const [commit, patch] of patchIds(root, [
    `${change.base}..${change.head}`,
  ]))
    commits.set(commit, patch);
  return commits;
}

function isAncestor(root, older, newer) {
  const { status } = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', older, newer],
    { cwd: root, env: cleanEnvironment(), stdio: 'ignore' },
  );
  if (status === 0 || status === 1) return status === 0;
  throw new Error(
    `git merge-base --is-ancestor ${older} ${newer} exited with ${status}.`,
  );
}

function isCommit(root, commit) {
  return (
    spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], {
      cwd: root,
      env: cleanEnvironment(),
      stdio: 'ignore',
    }).status === 0
  );
}

function resolveBase(root, head, base, commits) {
  if (isCommit(root, base.commit) && isAncestor(root, base.commit, head))
    return base.commit;
  const copy =
    base.patch && [...commits].find(([, patch]) => patch === base.patch);
  return copy ? copy[0] : null;
}

function baseOf(root, commit) {
  const patch = patchIds(root, ['-1', commit]).get(commit);
  return patch ? { commit, patch } : { commit };
}

function startsOf(root, texts, head, commits) {
  const starts = new Set();
  for (const text of texts) {
    let parsed;
    try {
      parsed = z.object({ base: baseSchema }).safeParse(JSON.parse(text));
    } catch {
      continue;
    }
    const start =
      parsed.success && resolveBase(root, head, parsed.data.base, commits);
    if (start) starts.add(start);
  }
  return starts;
}

function rangeEnd(root, start, starts, head) {
  let end = head;
  let distance = Infinity;
  for (const other of starts) {
    if (other === start || !isAncestor(root, start, other)) continue;
    const count = Number(
      git(root, ['rev-list', '--count', `${start}..${other}`]),
    );
    if (count < distance) [end, distance] = [other, count];
  }
  return end;
}

const requiredOf = (routing, change) =>
  new Map(
    requiredSkills(routing, change).required.map(({ skill, reasons }) => [
      skill,
      reasons,
    ]),
  );

function recordScope(root, routing, start, end, head) {
  const later = rangeCommits(root, { base: start, head });
  const own = readRange(root, start, end);
  const ownCommits = new Map(
    git(root, ['rev-list', `${start}..${end}`])
      .split('\n')
      .filter(Boolean)
      .map(commit => [commit, later.get(commit)]),
  );
  return { own, ownCommits, later, required: requiredOf(routing, own) };
}

function headReader(root, head) {
  return path =>
    git(root, ['ls-tree', head, '--', path])
      ? git(root, ['show', `${head}:${path}`])
      : null;
}

function workingReader(root) {
  return path =>
    existsSync(join(root, path))
      ? readFileSync(join(root, path), 'utf8')
      : null;
}

function sectionsOf(path, record) {
  return [
    ...record.skills.map(entry => ({ path, role: 'author', entry })),
    ...(record.review?.skills ?? []).map(entry => ({
      path,
      role: 'review',
      entry,
    })),
  ];
}

function describeIssues(path, error) {
  return error.issues.map(
    issue => `${path}: ${issue.path.join('.') || 'record'} ${issue.message}`,
  );
}

function readRecords(root, change) {
  const records = [];
  const problems = [];
  for (const file of change.files) {
    const match = recordFile.exec(file.path);
    if (!match || file.status === 'deleted') continue;
    let parsed;
    try {
      parsed = recordSchema.safeParse(
        JSON.parse(git(root, ['show', `${change.head}:${file.path}`])),
      );
    } catch (error) {
      problems.push(`${file.path}: ${error.message}`);
      continue;
    }
    if (!parsed.success)
      problems.push(...describeIssues(file.path, parsed.error));
    else if (parsed.data.change !== match[1])
      problems.push(`${file.path}: change must be ${match[1]}.`);
    else records.push({ path: file.path, record: parsed.data });
  }
  return { records, problems };
}

const labelOf = ({ path, role, entry }) =>
  `${path}: ${role === 'review' ? 'review of ' : ''}${entry.skill}`;

function entryProblems(section, routing, required) {
  const { role, entry } = section;
  const problems = [];
  if (!routing.skills[entry.skill])
    problems.push(
      `${labelOf(section)} is not a catalogued skill in tools/skills/routing.json.`,
    );
  else if (role === 'author' && !required.has(entry.skill) && !entry.reason)
    problems.push(
      `${labelOf(section)} is not required for this change; give a reason for applying it.`,
    );
  if (!entry.findings.length)
    problems.push(
      `${labelOf(section)} has no findings. When the skill found nothing, record that with "none" and the reason.`,
    );
  return problems;
}

function citationProblems(section, lock) {
  const { skill, findings } = section.entry;
  const locked = lock.skills[skill];
  if (!locked) return [];
  return findings.flatMap(({ finding, cites }) => {
    const { nested, section: cited, sections } = citation(locked, cites);
    if (sections.headings.includes(cited) || sections.rules.includes(cited))
      return [];
    return [
      `${labelOf(section)} finding "${finding}" cites "${cites}", which is not a heading or numbered rule of ${nested ? `${skill}/${nested}` : skill} in tools/skills/catalog.lock.json.`,
    ];
  });
}

function findingProblems(section, commits, pullRequest) {
  const problems = [];
  for (const { finding, commit: cited, patch, open } of section.entry
    .findings) {
    if (pullRequest && open !== undefined)
      problems.push(
        `${labelOf(section)} finding "${finding}" is open: ${open} A pull request needs every finding fixed or closed with "none".`,
      );
    if (cited === undefined) continue;
    const citation = `${labelOf(section)} finding "${finding}" cites ${cited}`;
    const bySha = [...commits.keys()].filter(commit =>
      commit.startsWith(cited),
    );
    if (!patch)
      problems.push(
        `${citation} without its patch-id. Run npm run skills:record -- <change-id> <base> to add it.`,
      );
    else if (bySha.length === 1 && commits.get(bySha[0]) !== patch)
      problems.push(`${citation}, whose patch-id is not ${patch}.`);
    else if (bySha.length !== 1 && ![...commits.values()].includes(patch))
      problems.push(
        `${citation}, which matches no commit in this range by SHA or patch-id.`,
      );
  }
  return problems;
}

function coverageProblems(required, entries, path) {
  const holder = path
    ? { prefix: `${path}: `, gap: 'this record does not cover it' }
    : { prefix: '', gap: 'no skill record covers it' };
  const problems = [];
  for (const [skill, reasons] of required) {
    const patterns = entries
      .filter(entry => entry.skill === skill)
      .flatMap(entry => entry.files.map(globPattern));
    for (const { rule, matches } of reasons) {
      const missing = matches
        .map(match => match.subject)
        .filter(subject => !patterns.some(pattern => pattern.test(subject)));
      if (missing.length)
        problems.push(
          `${holder.prefix}${skill} is required by ${rule} for ${missing.join(', ')}, but ${holder.gap}.`,
        );
    }
  }
  return problems;
}

function recordProblems(path, record, start, scope, context) {
  const { routing, lock, key, pullRequest, step } = context;
  const problems = [];
  const seen = new Set();
  for (const section of sectionsOf(path, record)) {
    const id = `${section.role} ${section.entry.skill}`;
    if (seen.has(id)) problems.push(`${labelOf(section)} appears twice.`);
    seen.add(id);
    problems.push(
      ...entryProblems(section, routing, scope.required),
      ...findingProblems(section, scope.later, pullRequest),
      ...(lock ? citationProblems(section, lock) : []),
    );
  }
  if (pullRequest && !record.review)
    problems.push(
      `${path} has no review section, and a pull request needs an independent review of every record. The reviewer follows the line that npm run skills:required prints for each required skill, then runs npm run skills:record -- ${record.change} <base> --review.`,
    );
  problems.push(...coverageProblems(scope.required, record.skills, path));
  if (lock && key) {
    const change = { base: start, basePatch: record.base.patch };
    const bind = commits => ({ key, lock, routing, change, commits });
    problems.push(
      ...receiptProblems(path, record, [...scope.required.keys()], {
        author: bind(scope.ownCommits),
        review: bind(scope.later),
        step,
      }),
    );
  }
  return problems;
}

function recordTextsAt(root, head) {
  return git(root, [
    'ls-tree',
    '-r',
    '--name-only',
    head,
    '--',
    recordsDirectory,
  ])
    .split('\n')
    .filter(path => recordFile.test(path))
    .map(path => git(root, ['show', `${head}:${path}`]));
}

function checkRecords(root, routing, change, { pullRequest, step }) {
  const required = requiredOf(routing, change);
  const { records, problems } = readRecords(root, change);
  const commits = rangeCommits(root, change);
  const read = headReader(root, change.head);
  const checked = required.size > 0 || records.length > 0;
  const { lock, problems: lockProblems } = readLock(read, routing);
  if (checked) problems.push(...lockProblems);
  const key = readPublicKey(read);
  if (!records.length) {
    if (required.size && !problems.length)
      problems.push(
        `No skill record changed in this range. Run npm run skills:record -- <change-id> <base>.`,
      );
    problems.push(...coverageProblems(required, [], null));
  }
  const starts = startsOf(
    root,
    recordTextsAt(root, change.head),
    change.head,
    commits,
  );
  const covered = new Set();
  for (const { path, record } of records) {
    const start = resolveBase(root, change.head, record.base, commits);
    if (!start) {
      problems.push(
        `${path}: base ${record.base.commit.slice(0, 12)} is neither HEAD nor an ancestor of HEAD, and no commit in the range has its patch-id.`,
      );
      continue;
    }
    const end = rangeEnd(root, start, starts, change.head);
    const scope = recordScope(root, routing, start, end, change.head);
    for (const commit of scope.ownCommits.keys()) covered.add(commit);
    problems.push(
      ...recordProblems(path, record, start, scope, {
        routing,
        lock,
        key,
        pullRequest,
        step,
      }),
    );
  }
  const uncovered = [...commits.keys()].filter(commit => !covered.has(commit));
  if (records.length && uncovered.length)
    problems.push(
      `No changed record's range holds ${uncovered.length} of the range's commits, from ${uncovered.at(-1).slice(0, 12)} to ${uncovered[0].slice(0, 12)}. Give a record a base at or below ${uncovered.at(-1).slice(0, 12)}, or check from a later base.`,
    );
  if (checked && lock && !key) problems.push(missingKey());
  return {
    problems,
    commits: commits.size,
    records: records.map(({ path }) => path),
    required: required.size,
  };
}

function citePatch(root, commits, finding) {
  if (finding.commit === undefined) return;
  if (!finding.patch) {
    let commit;
    try {
      commit = git(root, [
        'rev-parse',
        '--verify',
        `${finding.commit}^{commit}`,
      ]);
    } catch {
      return;
    }
    finding.patch = patchIds(root, ['-1', commit]).get(commit);
  }
  const inRange = [...commits.keys()].some(commit =>
    commit.startsWith(finding.commit),
  );
  const copy = [...commits].find(([, patch]) => patch === finding.patch);
  if (!inRange && copy) finding.commit = copy[0].slice(0, 12);
}

function scaffoldAuthor(record, required) {
  for (const { skill, reasons } of required) {
    let entry = record.skills.find(candidate => candidate.skill === skill);
    if (!entry) {
      entry = { skill, files: [], findings: [], receipts: [] };
      record.skills.push(entry);
    }
    for (const { matches } of reasons) {
      for (const { subject } of matches) {
        if (!entry.files.some(glob => globPattern(glob).test(subject)))
          entry.files.push(subject);
      }
    }
    entry.files.sort();
  }
  record.skills.sort((a, b) => (a.skill < b.skill ? -1 : 1));
}

function scaffoldReview(record, required) {
  record.review ??= { skills: [] };
  for (const { skill } of required) {
    if (!record.review.skills.some(entry => entry.skill === skill))
      record.review.skills.push({ skill, findings: [], receipts: [] });
  }
  record.review.skills.sort((a, b) => (a.skill < b.skill ? -1 : 1));
}

// Pulls receipts for one side of the record, skipping every session and agent
// pair that holds a receipt on the other side. The command cannot tell which
// pair runs it, so a review run keeps and pulls only receipts made in the
// folder it runs in. In a worktree of the reviewer's own, those are its loads.
function pullSection(record, start, scope, pull) {
  const own = record.review ? record.review.skills : [];
  const [entries, others] = pull.review
    ? [own, record.skills]
    : [record.skills, own];
  const excluded = new Set(others.flatMap(entry => entry.receipts).map(actor));
  const context = {
    key: pull.key,
    lock: pull.lock,
    routing: pull.routing,
    change: { base: start, basePatch: record.base.patch },
    commits: pull.review ? scope.later : scope.ownCommits,
    folder: pull.review ? pull.folder : null,
  };
  const missing = [];
  for (const entry of entries) {
    if (!pull.routing.skills[entry.skill]) continue;
    const pulled = pullReceipts(entry, pull.candidates, context, excluded);
    for (const nested of pulled.missing)
      if (nested !== undefined || scope.required.has(entry.skill))
        missing.push({ skill: entry.skill, nested });
  }
  return missing;
}

function reviewedRecord(root, change, path, id) {
  const relativePath = `${recordsDirectory}/${id}.json`;
  if (!existsSync(path))
    throw new Error(
      `${relativePath} does not exist. The author runs npm run skills:record -- ${id} <base> first.`,
    );
  const record = recordSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const { commit, patch } = record.base;
  if (
    commit !== change.base &&
    (!patch || baseOf(root, change.base).patch !== patch)
  )
    throw new Error(
      `${relativePath} has base ${commit.slice(0, 12)}, but this run's base is ${change.base.slice(0, 12)}. Run the review with the record's base.`,
    );
  return record;
}

function writeRecord(root, change, id, pull) {
  if (!changeId.test(id))
    throw new Error('Name the change in lowercase-with-dashes.');
  const directory = join(root, recordsDirectory);
  const path = join(directory, `${id}.json`);
  let record;
  if (pull.review) record = reviewedRecord(root, change, path, id);
  else {
    record = existsSync(path)
      ? recordSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
      : { change: id, skills: [] };
    record.base = baseOf(root, change.base);
  }
  const others = existsSync(directory)
    ? readdirSync(directory)
        .filter(file => file.endsWith('.json') && file !== `${id}.json`)
        .map(file => readFileSync(join(directory, file), 'utf8'))
    : [];
  const starts = startsOf(
    root,
    others,
    change.head,
    rangeCommits(root, change),
  );
  const end = rangeEnd(root, change.base, starts, change.head);
  const scope = recordScope(root, pull.routing, change.base, end, change.head);
  const required = requiredSkills(pull.routing, scope.own).required;
  if (pull.review) scaffoldReview(record, required);
  else scaffoldAuthor(record, required);
  const section = pull.review ? record.review.skills : record.skills;
  for (const finding of section.flatMap(entry => entry.findings))
    citePatch(root, scope.later, finding);
  const missing = pull.lock
    ? pullSection(record, change.base, scope, pull)
    : [];
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return { path, missing };
}

module.exports = { checkRecords, headReader, workingReader, writeRecord };
