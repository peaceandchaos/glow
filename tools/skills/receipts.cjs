const { createPublicKey, verify } = require('node:crypto');
const { z } = require('zod');
const { citation } = require('./catalog.cjs');
const { qualifiedReference, skillFilePath } = require('./routing.cjs');

const publicKeyPath = 'tools/skills/receipt-public-key.pem';
const hex = length =>
  z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`, 'u'));
const receiptFields = {
  client: z.enum(['claude-code', 'cursor']),
  skill: z.string().min(1),
  source: z.enum(['Skill', 'Read']),
  sha256: hex(64),
  partial: z.boolean(),
  session: z.string().min(1).nullable(),
  agent: z.string().min(1).nullable(),
  agentType: z.string().min(1).nullable(),
  toolUseId: z.string().min(1).nullable(),
  time: z.iso.datetime(),
  cwd: hex(64).nullable(),
  commonDir: hex(64).nullable(),
  branch: z.string().min(1).nullable(),
  head: hex(40).nullable(),
  headPatch: hex(40).nullable(),
  sig: z.string().min(1),
};
// The hook installed before qualified references signs v: 1, with no skillRef.
const receiptSchema = z.discriminatedUnion('v', [
  z.strictObject({ v: z.literal(1), ...receiptFields }),
  z.strictObject({
    v: z.literal(2),
    skillRef: z.string().min(1),
    file: skillFilePath.optional(),
    ...receiptFields,
  }),
]);

function canonical(fields) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
  );
}

function readPublicKey(read) {
  const text = read(publicKeyPath);
  return text === null ? null : createPublicKey(text);
}

function missingKey() {
  return `No public key at ${publicKeyPath}. Run node tools/skills/install-receipt-hook.mjs --apply, then commit the public key it prints to that path.`;
}

function signed(receipt, key) {
  const { sig, ...fields } = receipt;
  try {
    return verify(
      null,
      Buffer.from(canonical(fields)),
      key,
      Buffer.from(sig, 'base64'),
    );
  } catch {
    return false;
  }
}

function bound(receipt, change, commits) {
  if (receipt.head === change.base || commits.has(receipt.head)) return true;
  return (
    receipt.headPatch !== null &&
    (receipt.headPatch === change.basePatch ||
      [...commits.values()].includes(receipt.headPatch))
  );
}

function receiptFault(receipt, skill, context) {
  if (receipt.skill !== skill) return `is for ${receipt.skill}`;
  if (context.key && !signed(receipt, context.key))
    return 'has a signature that the committed public key does not verify';
  if (!context.routing.skills[receipt.skill])
    return 'names a skill outside the catalog';
  const routed = qualifiedReference(context.routing, receipt.skill);
  if (receipt.v === 2 && receipt.skillRef !== routed)
    return `loads ${receipt.skillRef}, but the root that tools/skills/routing.json names loads it as ${routed}`;
  const locked = context.lock.skills[receipt.skill];
  const pinned =
    receipt.file === undefined ? locked : locked?.files?.[receipt.file];
  if (pinned?.sha256 !== receipt.sha256)
    return `hashes a ${receipt.file ?? 'SKILL.md'} that is not the one in tools/skills/catalog.lock.json`;
  if (receipt.partial) return 'records a partial read';
  if (!bound(receipt, context.change, context.commits))
    return 'was made on a commit outside this change';
  return null;
}

function neededReceipts(entry, lock) {
  const locked = lock.skills[entry.skill];
  const cited = locked
    ? entry.findings.map(({ cites }) => citation(locked, cites).nested)
    : [];
  return [...new Set([undefined, ...cited])];
}

const hintSubject = (skill, nested) =>
  nested === undefined ? `${skill} has` : `${skill} cites ${nested}, which has`;

const actor = receipt => `${receipt.session} ${receipt.agent}`;
const reviewer = receipt =>
  `${actor(receipt)} in ${String(receipt.cwd).slice(0, 12)}`;

function receiptProblems(path, record, required, contexts) {
  const problems = [];
  const validIn = (entry, context, label, authorFolders = new Set()) =>
    entry.receipts.filter(receipt => {
      const fault =
        receiptFault(receipt, entry.skill, context) ??
        (authorFolders.has(receipt.cwd)
          ? "was made in the folder of one of this record's author receipts"
          : null);
      if (fault)
        problems.push(
          `${path}: ${label}${entry.skill} receipt ${receipt.toolUseId ?? receipt.sig.slice(0, 12)} ${fault}.`,
        );
      return !fault;
    });
  const { step } = contexts;
  const { lock } = contexts.author;
  for (const entry of record.skills) {
    const valid = validIn(entry, contexts.author, '');
    for (const nested of neededReceipts(entry, lock))
      if (!valid.some(receipt => receipt.file === nested))
        problems.push(
          `${path}: ${hintSubject(entry.skill, nested)} no valid author receipt. To make one, ${step(entry.skill, nested)}, then run npm run skills:record -- ${record.change} <base>.`,
        );
  }
  if (!record.review) return problems;
  const authorReceipts = record.skills.flatMap(entry => entry.receipts);
  const authors = new Set(authorReceipts.map(actor));
  const authorFolders = new Set(authorReceipts.map(receipt => receipt.cwd));
  const reviewers = new Set(
    record.review.skills.flatMap(entry => entry.receipts).map(reviewer),
  );
  if (reviewers.size > 1)
    problems.push(
      `${path}: one session and agent pair in one folder reviews a record, but its review receipts come from ${reviewers.size}: ${[...reviewers].join(', ')}.`,
    );
  for (const entry of record.review.skills) {
    const valid = validIn(
      entry,
      contexts.review,
      'review of ',
      authorFolders,
    ).filter(receipt => !authors.has(actor(receipt)));
    for (const nested of neededReceipts(entry, lock))
      if (!valid.some(receipt => receipt.file === nested))
        problems.push(
          `${path}: review of ${hintSubject(entry.skill, nested)} no valid receipt from a session and agent pair that made none of this record's author receipts. To make one, the reviewer must ${step(entry.skill, nested)}, then run npm run skills:record -- ${record.change} <base> --review.`,
        );
  }
  for (const skill of required)
    if (!record.review.skills.some(entry => entry.skill === skill))
      problems.push(
        `${path}: ${skill} is required, but the review section has no entry for it. To make one, the reviewer must ${step(skill)}, then run npm run skills:record -- ${record.change} <base> --review.`,
      );
  return problems;
}

// Keeps an entry's valid receipts. A needed receipt that the entry lacks gets
// the earliest valid candidate, so running skills:record again changes
// nothing. A `context.folder` hash limits both the kept receipts and the
// candidates to that folder, so a run in another folder replaces the receipts.
function pullReceipts(entry, candidates, context, excluded) {
  const needed = neededReceipts(entry, context.lock);
  const usable = receipt =>
    needed.includes(receipt.file) &&
    (context.folder === null || receipt.cwd === context.folder) &&
    !receiptFault(receipt, entry.skill, context);
  entry.receipts = entry.receipts.filter(usable);
  const missing = [];
  for (const nested of needed) {
    if (entry.receipts.some(receipt => receipt.file === nested)) continue;
    const found = candidates
      .filter(
        receipt =>
          receipt.file === nested &&
          !excluded.has(actor(receipt)) &&
          usable(receipt),
      )
      .sort((a, b) => (a.time < b.time ? -1 : 1))[0];
    if (found) entry.receipts.push(found);
    else missing.push(nested);
  }
  return { missing };
}

// The hook appends lines, so a crash can leave a torn last line. Skip it.
function parseReceipts(text, commonDir) {
  const receipts = [];
  for (const line of text.split('\n').filter(Boolean)) {
    let parsed;
    try {
      parsed = receiptSchema.safeParse(JSON.parse(line));
    } catch {
      continue;
    }
    if (parsed.success && parsed.data.commonDir === commonDir)
      receipts.push(parsed.data);
  }
  return receipts;
}

module.exports = {
  actor,
  canonical,
  missingKey,
  parseReceipts,
  publicKeyPath,
  pullReceipts,
  readPublicKey,
  receiptProblems,
  receiptSchema,
};
