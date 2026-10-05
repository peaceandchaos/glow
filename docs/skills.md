# Skill routing

`tools/skills/routing.json` maps kinds of change to the skills an agent must apply. `npm run skills:required` reads a change, matches it against the rules, and prints each required skill with the rule and file that require it. The same change always prints the same sorted output.

## Set the skill roots

Skill files live outside this repository. `routing.json` names each skill's root, and each root names an environment variable. Set the two roots that have no default before you run the script:

```sh
export SKILL_ROOT_PSTACK=<pstack checkout>/plugins/pstack/skills
export SKILL_ROOT_GLOW_GUIDES=<glow-guides checkout>/skills
```

`SKILL_ROOT_REPO` defaults to `.agents/skills`, and `SKILL_ROOT_USER` defaults to `~/.claude/skills`. The script fails and names the variable when a root is unset or missing, when a skill has no `<root>/<skill>/SKILL.md`, or when that file declares a different `name:`. `npm run skills:catalog` resolves every catalogued skill. `npm run skills:catalog -- --lock` rewrites `tools/skills/catalog.lock.json` from the skill files. The lock holds each skill's SHA-256, headings, and numbered rules. For each file that `skillFiles` in `routing.json` lists under a skill, such as `review-animations/STANDARDS.md`, the lock holds the same three things under that skill's `files`. CI has no skill files and reads the lock instead. Review a lock change like a check change.

## Check the skill copies on disk

`npm run skills:doctor` compares every copy of every catalogued skill with the lock, together with each nested file that the lock pins for the skill. It reads `routing.json` and `catalog.lock.json` from the checkout's `HEAD`, so the checkout is its pin. Set the skill roots first. The doctor prints a `FAIL` line and exits 1 when:

- a catalogued skill is not in the lock
- a skill's routed root has no `<skill>/SKILL.md`
- a copy of the skill in any root has a SHA-256 that differs from the lock, and the copy is not an allowed shadow
- a copy of the skill in any root lacks a nested file that the lock pins, or holds one whose SHA-256 differs from the lock
- the repository's `.claude/skills` folder, a folder in the user root's `synced` folder, or the `.claude/skills` folder of a folder in `SKILL_DOCTOR_ADD_DIRS`, holds a copy of the skill

`SKILL_DOCTOR_ADD_DIRS` lists folders separated by `:`. Claude Code can also find skills in the `.claude/skills` folder of a folder that a session adds with `--add-dir`, so set it to the folders that your launcher passes to `claude --add-dir`.

An allowed shadow is a copy outside the skill's routed root, at one exact SHA-256 that `tools/skills/doctor.cjs` lists. The only one is `pstack:tdd`, pstack's own TDD skill. The bare name `tdd` finds the routed user copy first, so the shadow does not change what `tdd` loads. The doctor prints a `note` line for each allowed shadow.

When every copy passes, the doctor prints one line, where `<head>` is the first 12 characters of `HEAD`:

```text
skills doctor: 33 catalogued skills, 36 copies on disk, all match the lock at <head> except 1 allowed shadow.
```

The verify suite does not run the doctor, because snapshots and CI have no skill roots.

## List the skills for a change

For a branch, pass the base. The script diffs the merge base with `HEAD`, or with a head you name:

```sh
npm run skills:required -- origin/main
npm run skills:required -- origin/main my-branch
```

Before you write code, list the files you plan to touch. A bare path is a modified file. `A:`, `D:`, and `R:<old>:` mark added, deleted, and renamed files:

```sh
npm run skills:required -- --plan packages/server/src/models.ts A:packages/server/src/limits.ts
```

A plan has no file contents or commits, so the script lists the content rules it could not evaluate. Run the branch form again after you commit.

Under each skill, the output says how to make a receipt that counts. `load <reference> from <file>` names the reference to pass to the Skill tool, such as `glow-guides:react-native-best-practices-sm`. `read all of <file>` is for a skill that the Skill tool cannot load under its routed reference. That is a skill in the `repo` root, such as `test-prune`, or a skill with `disable-model-invocation: true`, such as `review-animations`. Read that whole file with the Read tool. When `skills:check` or `skills:record` finds a receipt missing, its hint names the same step. Without the skill roots, as in CI, the hint points at `skills:required` instead.

## How rules match

Every filter in a rule must match. A `change` rule matches the whole change once, as the subject `<change>`, when a changed file falls outside its `excludePaths`. It can also require a minimum number of changed lines in those files (`minChangedLines`) or a matching commit subject (`commitSubject`). A `file` rule matches each changed file that passes all of its filters: `paths`, `excludePaths`, `status`, `addedLines` (a case-insensitive pattern tested against added lines), and `removedExports` (an ES or CommonJS export that the change deletes or renames). A renamed file matches by its old or new path.

Globs match whole repository paths. `**` matches any number of directories, including dot directories. `*` and `?` stay within one directory. `{a,b}` matches either choice. Other characters, including `[`, match literally.

Before the rules, the `tiers` list in `routing.json` is checked in order. A tier matches a small change, such as one that touches only docs (`docs-only`) or a few lines in at most two modified files (`tiny`), after ignoring skill records. A matching tier replaces only the `every-change` rule, with its own shorter skill list. The file rules still apply, and so do the other change rules, `large-change` and `fix-commits`.

`large-change` requires `thermo-nuclear-code-quality-review` above 400 changed lines. That is a judgment of what one reviewer reads in one sitting. Lockfile and skill-record lines do not count.

## Record the skills a change applied

Each change carries a record at `tools/skills/records/<change-id>.json`. Write or update it from the branch:

```sh
npm run skills:record -- skill-routing origin/main
```

The command adds every required skill with the files that require it and keeps any findings already in the file. It also copies receipts for those skills from the receipts file, as [Prove each load with a signed receipt](#prove-each-load-with-a-signed-receipt) describes. Running it again changes nothing.

The command stores the base as the record's `base`, with the commit and its patch-id:

```json
"base": { "commit": "<base commit SHA>", "patch": "<base patch-id>" }
```

The base starts the record's own range. The range ends at the nearest later base of any record at the head commit, or at the head. A stack of changes therefore splits into one range per record, and each record answers only for its own commits. After a rebase, the check finds the base by its patch-id in the checked range. Fill in what each skill found:

```json
{
  "skill": "principle-boundary-discipline",
  "files": ["packages/server/src/**"],
  "findings": [
    {
      "finding": "The handler trusted a parsed header.",
      "cites": "Boundary Discipline",
      "commit": "<fixing commit SHA>",
      "patch": "<fixing patch-id>"
    },
    {
      "finding": "Checked the new route.",
      "cites": "Boundary Discipline",
      "none": "It already parses its input."
    }
  ],
  "receipts": [
    { "v": 1, "skill": "principle-boundary-discipline", "sig": "..." }
  ]
}
```

Each finding cites the heading or numbered rule of the skill that produced it. A numbered rule is its heading and number, such as `Steps 2`. To cite a file that the lock nests under the skill, write the file's path inside the skill folder, then `: `, then the heading or rule, such as `STANDARDS.md: Easing`. The check reads the allowed citations from the lock, and `catalog.lock.json` lists them for each skill and each nested file. A finding that cites a nested file needs a receipt for a full Read of that file. Read the file in full, write the finding, then run `skills:record` again so that it pulls the receipt. Never type a receipt. `skills:record` writes them.

A finding has exactly one status. It names the commit that fixes it under `commit`, gives the reason no fix was needed under `none`, or says what is left to do under `open`. Write only `commit`. `skills:record` adds `patch`, the commit's `git patch-id --stable`. A cherry-picked or rebased copy of the commit keeps that patch-id when its diff applies unchanged, so the citation still resolves on a new branch. Run `skills:record` again on the new branch, and it rewrites `commit` to the copy in the range. A copy whose conflict you resolved by hand gets a new patch-id, and so does a squash of several commits, so a citation of the original no longer resolves. Cite the new commit instead. A skill that found nothing still records one `none` finding. A skill the routing did not require needs a `reason` field.

`npm run skills:check -- origin/main` reads only the records that the range adds or changes, from the head commit. It fails when:

- a record's `base` is not an ancestor of the head, and no commit in the range has its patch-id
- a commit in the range falls in no changed record's own range
- a skill that a record's own range requires has no entry in that record whose `files` globs cover each file that requires it
- an author entry has no valid receipt for its `SKILL.md`, or for a nested file that one of its findings cites
- a record has a `review` section, and a review entry has no valid receipt from a session and agent pair that made none of the record's author receipts, for its `SKILL.md` and for each nested file that its findings cite, or a review receipt was made in the folder of one of the record's author receipts, or the review receipts come from more than one pair or folder, or a skill that the record's range requires has no review entry
- a pull request run finds a record in the range without a `review` section
- a record holds an invalid receipt
- a finding cites a heading or rule that the lock does not list for its skill, or for the nested file that the citation names
- the head commit has no `tools/skills/catalog.lock.json` or no `tools/skills/receipt-public-key.pem`
- a finding has no status, or more than one
- a pull request run finds an `open` finding
- a cited commit has no `patch`, or no commit in the range has that SHA or patch-id
- a cited commit is in the range but its patch-id differs from `patch`
- an entry names a skill outside the catalog, appears twice in one record, has no findings, or is not required and has no `reason`
- the range changes no record

A run is a pull request run when `GITHUB_EVENT_NAME` is `pull_request`. GitHub Actions sets that value for the `pull_request` event. The pre-push hook, `verify:commit`, and an author's own runs do not set it, so they pass before a reviewer adds the `review` sections. A passing pull request run ends its summary with `with independent review`.

`verify:commit` and the pre-push hook run this check against the merge base with `origin/main`. Pass `--base <ref>` to use another base. They fail when the range from the base to the commit has no commits, because the range checks would check nothing. `verify:current` runs the range checks only when it gets `--base` and the range has commits, because CI checks out one commit without history. Otherwise it lists them under `notRun` in `result.json` and ends its summary with `PASS (range checks not run: <names>)`.

For each skill that a record's own range requires, a passing check proves that the record holds a signed receipt for a Skill tool call or a full Read made on a commit of that range while the locked `SKILL.md` text was on disk. For each nested file that a finding cites, it proves a signed full Read of that file while its locked text was on disk. It also proves that every recorded finding has a status, and in a pull request run that none is open. It does not prove a fresh read, because the hook signs every Skill tool call, including one that answers that the skill is already loaded. It does not prove the skill was applied well, or that the findings are complete. Review judges that.

## Prove each load with a signed receipt

A Claude Code `PostToolUse` hook signs a receipt each time an agent loads a skill. The hook lives in user settings, never on a branch. `tools/skills/receipt-hook.mjs` is its reviewed source.

### Install the hook

The owner installs the hook once per machine. Set the plugin roots first, so the installer can write the roots the hook resolves skills from:

```sh
export SKILL_ROOT_PSTACK=<pstack checkout>/plugins/pstack/skills
export SKILL_ROOT_GLOW_GUIDES=<glow-guides checkout>/skills
node tools/skills/install-receipt-hook.mjs
node tools/skills/install-receipt-hook.mjs --apply
```

The first command prints every planned change, including each hook entry and deny rule it adds to or removes from the settings, and writes nothing. `--apply` makes the changes:

1. It copies the hook to `~/.claude/hooks/skill-receipt-hook.mjs` and writes `~/.claude/hooks/skill-receipt-roots.json`.
2. It generates an Ed25519 keypair and writes the private key to `~/.claude/skill-receipts/private-key.pem` with mode 0600. It never replaces an existing key.
3. It backs up `~/.claude/settings.json`, then adds the `PostToolUse` entry for `Skill|Read` and the deny rules.
4. It prints the public key.

Commit the printed public key as `tools/skills/receipt-public-key.pem`. Until that file exists, `skills:check` fails every change that needs a skill. Running the installer again changes nothing. It leaves other `Skill|Read` hook entries, such as a logging spike, in place. Pass `--remove-spike` to remove them. The hook command runs the `node` that ran the installer.

The deny rules use the user-settings notation, where a path that starts with `/` is rooted at `~/.claude`. They stop the agent from reading or editing the hook and the key, from editing the receipts, and from running a shell command that names those paths.

### What a receipt holds

The hook appends one line to `~/.claude/skill-receipts/receipts.jsonl` for each Skill tool load and for each Read of a file in a skill folder. A receipt holds its version `v`, the client (`claude-code` or `cursor`), the skill, the source tool, the SHA-256 of the file that the hook hashed, whether the read was partial, the session, the agent and its type, the tool use id, and the time. It also holds the SHA-256 of the working directory and of the git common dir, and the branch, `HEAD`, and patch-id of `HEAD`. The two paths are hashed, so committed records hold no machine paths. The hook signs the receipt with Ed25519 over JSON with sorted keys.

The hook signs `v: 2` receipts. A `v: 2` receipt also holds `skillRef`, the qualified reference of the copy that the hook hashed, such as `pstack:unslop`. The `skill` field stays the bare name, as `routing.json` keys it. The hook installed before qualified references signs `v: 1` receipts, which have no `skillRef`. The check accepts both versions.

A receipt for a nested file, such as `review-animations/STANDARDS.md`, also holds `file`, the path of the file inside the skill folder. Its SHA-256 is the hash of that file. A receipt for a `SKILL.md` has no `file`. Only a `v: 2` receipt can hold `file`, and the version did not change, so a checkout from before nested-file receipts drops the receipts that hold it.

The Skill tool reports only the name that the agent loaded. The hook finds the `SKILL.md` through the roots file and hashes it, as [Where the hook finds a skill](#where-the-hook-finds-a-skill) describes. A Read counts only when it has no `offset` or `limit` and returned the whole file. Any other Read of a file in a skill folder gets `partial: true`, and the check rejects it. A Read of any other file makes no receipt. The hook checks the path before it runs git, so a Read outside every skill root runs no git. The hook always exits 0 and prints nothing. It writes its errors to `~/.claude/skill-receipts/errors.log`. `SKILL_RECEIPTS_DIR` and `SKILL_RECEIPTS_KEY` move the state and the key, for tests only.

### Where the hook finds a skill

The installer writes the roots file from the roots in `routing.json`. A skill in the `user` root or the `repo` root has its bare name as its reference. Every other root is a plugin, named for its root, and a skill in it has the reference `<plugin>:<skill>`.

A qualified name such as `pstack:tdd` resolves only in that plugin's root. A bare name resolves in one order:

1. The user root.
2. The repository roots, under the git top level of the session's folder.
3. Each plugin root, in the order of the roots file.

The hook uses the first root that holds `<skill>/SKILL.md`. Its `skillRef` is `<plugin>:<skill>` for a plugin root, and the bare name for the user root or a repository root. A full Read of a file in a skill folder names the skill after the first folder under the root that holds the file. A Read of `references/animations/SKILL.md` in the `react-native-best-practices-sm` folder makes a receipt for `react-native-best-practices-sm`, with `file` set to `references/animations/SKILL.md`. The receipt gets its `skillRef` the same way, from the root that holds the file. A file directly in a root gets no receipt.

A stray copy, a `SKILL.md` outside every root, gets the name of its own folder as a bare reference. A bare Skill load that the hook resolves in a repository root, such as `test-prune`, also gets the bare reference. Claude Code may have loaded another copy, because it does not read the repository roots. For a skill routed to the `user` or `repo` root, the bare reference is the one the check expects, so such a receipt counts. The hash check still guards the content, because the receipt counts only when its SHA-256 equals the lock's, and `skills:doctor` keeps the copies in the roots identical. Another file outside every root gets no receipt.

A Read is the only way to make a receipt for a skill that the Skill tool cannot load, such as one with `disable-model-invocation: true`.

The check derives the expected reference from `routing.json` with the same rule. A `v: 2` receipt counts only when its `skillRef` matches, so load each skill from its routed root:

- Load a plugin skill by its qualified name, such as `pstack:unslop`.
- Load `tdd` by its bare name. It is routed to the user root. `pstack:tdd` is pstack's own skill with different text.
- Load `glow-guides:react-native-best-practices-sm`. The user root holds a copy with the same text, and a bare load finds that copy first.

The repository skill `test-prune` reaches Claude Code through a plugin copy. `.agents/skills/test-prune/SKILL.md` is the maintained source, and `routing.json` routes `test-prune` to the `repo` root. The Skill tool lists the skill as `glow-guides:test-prune`, because the glow-guides plugin carries a copy. That load makes a `v: 2` receipt with `skillRef` `glow-guides:test-prune`, and the check rejects it. To make a receipt that counts, read the whole repository copy with the Read tool, in a session whose folder is the worktree. That receipt's `skillRef` is `test-prune`.

### Pull receipts into the record

`npm run skills:record -- <change-id> <base>` copies receipts into the record's `skills` entries. A reviewer loads the required skills as another session or another agent and runs the same command with `--review`, which fills a `review` section. A pull request run needs one in every record that the range changes:

```json
"review": {
  "skills": [{ "skill": "unslop", "findings": [], "receipts": [] }]
}
```

The command reads only receipts made in this clone, matched by the hash of the git common dir. It keeps each entry's valid receipts for its `SKILL.md` and for each nested file that one of its findings cites. For each of those files that has no receipt, it adds the earliest valid one. It drops a nested-file receipt that no finding cites. The author side skips the reviewer's receipts, and the review side skips the author's. A `--review` run keeps and pulls only receipts made in the folder it runs in, by the hash of `git rev-parse --show-toplevel`, so a rerun in the same folder changes nothing and a run in another folder replaces the review receipts. It names each required skill and each cited nested file that still has no receipt, with the step that makes one.

A `--review` run needs the author's record, and its `<base>` must be the record's `base` or a commit with the same patch-id. It writes only the `review` section. It never changes `base`, the author entries, or their findings.

### Which receipts count

The check verifies each receipt with the committed public key. A receipt is valid when:

- the signature verifies
- the skill is in the catalog, and the receipt sits in that skill's entry
- on a `v: 2` receipt, `skillRef` is the reference of the root that `routing.json` names for the skill
- its SHA-256 equals the lock's hash for the skill, or for the nested file that `file` names
- it is not partial
- it belongs to this change

Each entry needs a valid receipt for its `SKILL.md`. A receipt for a nested file does not count as one. An entry also needs a valid receipt for each nested file that one of its findings cites, in the author section and in the review section.

An author receipt belongs to the record when its `head` is the record's base or a commit in the record's own range, or when its `headPatch` equals the patch-id of one of them. A review receipt and a finding's cited commit may also come from a later commit up to the head, because review and fixes follow the change. Review receipts count only when their session and agent pair appears in none of the record's author receipts, their folder holds none of the author receipts, and one pair in one folder made all of them.

This rule survives a cherry-pick and a rebase that keep the patches, because a copied commit keeps its patch-id. A time bound was the other candidate. It would reject every receipt after a rebase onto a newer `main`, and it would still accept a receipt from another change made after the same base. A receipt's `head` is always older than the commit that records it, so a receipt copied from a merged record can match this range only through a re-landed patch. The rule treats that patch as the same work.

### Limits

- A receipt made while `HEAD` was the base stops counting when the change moves to a newer base. Load the skill again on the branch.
- Merged commits can overtake a record's base. When commits merge into `origin/main` after the base, and the branch moves onto the new `origin/main`, the old base is still an ancestor of the head. The record's own range then starts at the old base and includes the merged commits, so the record must cover the skills that those commits require. Move the base: run `npm run skills:record -- <change-id> origin/main` again. The command rewrites `base` and keeps the findings.
- The lock pins each skill's `SKILL.md`, and the nested files that `skillFiles` in `routing.json` lists, such as `review-animations/STANDARDS.md`. A nested file needs a receipt only when a finding cites it, so an agent can apply a nested file without reading it in full, as long as no finding cites it. Other files in a skill folder have no hash. A change to them passes the lock and `skills:doctor`, and a finding cannot cite them.
- The check judges every record in its range with the `routing.json` at the checked head. When a rule gains a path, a landed record that touched that path fails any range that includes the record. For example, after `AGENTS.md` joins `controls`, a range that includes an earlier record that touched `AGENTS.md` fails that record. A push range starts at the merge base with `origin/main`, so it never includes a landed record. To check landed records, check from a base above them, or with the routing at their own head.
- Squashing commits makes a new patch-id. Receipts made on the squashed commits stop counting. Load the skills again after a squash.
- A receipt made on the base by another change in the same clone also counts for this change. `skills:record` reads only this clone's receipts, but CI cannot check the clone, because the common-dir hash differs in CI.
- The deny rules stop an agent that names the key, the hook, or the receipts. A program that opens those files without naming them can still read the key and sign a receipt. The receipts stop lazy and mistaken claims. They do not stop deliberate forgery by a process running as the same user.
- A subagent that the author's session starts has its own agent id, so its receipts count as a reviewer's. The check cannot tell an independent reviewer from the author's helper. Review policy decides who may review.
- `skills:record --review` cannot tell which agent runs it, because a command gets the session id but no agent id. It binds the review to a folder instead: it keeps and pulls only receipts whose `cwd` hash is the folder it runs in. So run each review from a worktree that only the reviewer uses. Two pairs that load skills in one folder mix their receipts, and the check then fails the one-reviewer rule.
- The pull request rule applies only where the skill-record check runs. Hosted CI runs `verify:current` without `--base`, so it skips the range checks, and the rule has no effect there yet. It takes effect when the workflow fetches history and passes the pull request's base as `--base`.
- The rule reads `GITHUB_EVENT_NAME`. A run without that value applies the author rule, so only the protected CI check can enforce review.
- A push run on `main` checks no range. After a merge, the merge base of `main` and `origin/main` is the pushed commit, so the range is empty. `verify:current` lists the range checks under `notRun`, and `verify:commit` fails until it gets an earlier `--base`.
- A receipt proves a signed Skill tool call, or a full Read, while the locked text of that `SKILL.md` or nested file was on disk. It does not prove a fresh read. The hook never reads the Skill tool's reply, so a call that answers that the skill is already loaded also makes a receipt. It does not prove the agent followed the skill. Review judges that.
- Many principle skills have one heading and no numbered rules, so a citation of one names only the skill.

### Where records live

Records live in the repository, so `verify:commit` checks the same commit offline in a fresh clone, and review sees the record in the diff next to the code. Each change has its own file, and a range that spans two stacked changes reads both records. Each record answers for its own range, so one record's receipts and entries never cover another record's commits. A range that edits an earlier change's record checks that record against its own range, even when that range starts below the checked base. After a rebase, the check finds a moved base only by its patch-id in the checked range, so check such a range from below the earlier record's base.

Records stay in the tree after merge, and git history keeps every version. The check ignores records that a range does not change, so old records cost one small file per change and never affect later checks. Only the owner removes old records.

## Quality ledger

`tools/skills/ledger.json` records each finding that should not recur. Each lesson has:

- `id` and `lesson`: a name and the rule to follow.
- `seen`: one line per sighting, naming the commit, branch, or PR. The count is the number of lines.
- `enforcement`: what stops the finding now. `guidance` means nothing does. `test` names a test `file` and its exact title in `name`. `type` names a test the same way, but `npm run typecheck` enforces it through a `@ts-expect-error` fixture, and Jest only runs it. `lint` names a `rule`. `check` names a `check` from `tools/verification/checks.cjs`.
- `paths` (optional): globs for guidance that applies only to some files. Without paths, a lesson applies to every change.
- `link` (optional): an https issue URL or a tracked decision file.

`npm run skills:required` prints the guidance lessons that match the change after the required skills, and names the enforced lessons it leaves out. Apply each listed lesson the same way you apply a skill.

When a finding recurs, add a line to its `seen` list, or add a lesson the first time. `npm run skills:ledger` runs in the verify suite as `quality-ledger`. It fails when:

- a guidance lesson has been seen twice or more and has no `link`.
- an enforcement names a check the suite does not run, a lint rule that `.oxlintrc.json` does not turn on, or a test title that its file does not pass as a string to a plain `test()` or `it()` call. A title in a comment, a `test.skip()`, a `test.each()` table, or a `describe.skip()` or `xdescribe()` block does not count.
- a test enforcement names a file that no tracked `jest.config.js`, `.cjs`, or `.mjs` discovers. The check runs `jest --listTests` once for each of those configs.
- a `link` is neither an https URL nor a tracked file.
- two lessons share an id.

To promote a lesson, add the type, test, lint rule, or check in its own commit, with a fixture that fails without it. Then change the lesson's `enforcement` to name it. The routing script stops listing the lesson, and the ledger check fails if that check, rule, or test is later removed or renamed. To keep a repeated lesson as guidance, link the issue or decision that explains why.

The check confirms that the named enforcement exists. It does not prove that the enforcement catches the finding. The failing fixture in the promotion commit shows that. A title match is textual, and the counts are only as complete as the sightings people add.

## Limits

The routing lists skills. Receipts show that an agent loaded one. Nothing shows that it applied the skill well. `security-review` is a Claude Code command with no skill file, so the catalog leaves it out.
