# Repository instructions

This repository is a personal iOS chat app. Read `README.md` for the current implementation. Read `docs/providers.md` when changing provider behavior. Treat only checked behavior as verified.

## Scope and authority

- Work on iOS and shared app/server code. Android implementation and verification are outside the current scope.
- The owner directs the UI design and approves how the app looks and feels. Keep screens and visual behavior unchanged unless the task explicitly includes them. Show the owner screenshots of each visual change before it merges.
- Approved local edits, disposable fixtures, builds without paid services, and local commits do not need repeated confirmation. Preserve unrelated changes.
- Review specific dependency changes before applying them. Do not run automatic audit fixes. Scoped overrides require a documented compatibility argument.
- Make every agent write through the limited GitHub App bot. Do not merge, revert, deploy, publish, spend money, or call paid providers without task authorization.
- Keep personal details and planning notes out of the repository, commit messages, and PR text. Describe only the change.

## Commands

Use Node `22.23.3` from `.node-version`. Run commands from the repository root.

```sh
npm ci
cp packages/app/src/config.example.ts packages/app/src/config.ts
npm run lint
npm run format:check
npm run typecheck
npm test
npm run security
npm run audit:check
npm run build:server
npm run build:ios-js
npm run verify:commit -- HEAD
```

The example config has no live credentials. Never copy personal config or environment files into verification checkouts. `verify:staged` checks the index; `verify:commit` installs locked dependencies in a fresh checkout and records the tested commit/tree. `verify:current` is for a clean CI checkout. Working-tree checks are useful feedback, not proof about another commit. Read `tools/verification/checks.cjs` for the implemented suite.

## Skills

Before you edit, run `npm run skills:required -- --plan <path>...` for the files you plan to touch. Load every skill it lists as its output says, then apply it. Only a Skill tool load, or a full Read of a file in the skill folder, makes a signed receipt. A finding that cites a nested file, such as `STANDARDS.md: Easing`, needs a full Read of that file. On a branch, run `npm run skills:required -- origin/main`. Set the skill roots first, as `docs/skills.md` describes. `tools/skills/routing.json` decides what is required; changes to it need owner review. The same output lists the unenforced lessons from `tools/skills/ledger.json`. Apply them too. When a review finding recurs, add the sighting to its lesson, or add a lesson the first time.

Before you push, run `npm run skills:record -- <change-id> origin/main`. It copies your receipts into the record. Write each skill's findings, the heading or numbered rule each finding cites, and the fixing commit, the reason none was needed, or `open` with what is left. Then commit the record. A reviewer loads the same skills and runs the command again with `--review`. A pull request run of the check fails until each record has that review and no finding is open. `verify:commit` fails until each record that the range changes covers every skill its own range requires, with a valid receipt made in that range. A passing check shows a signed Skill tool call or full Read of each skill while the locked text was on disk. It does not show a fresh read, because a Skill call that answers "already loaded" also makes a receipt, and it does not show that the skill was applied well.

## Checks and repairs

Use the repository `test-prune` skill when reviewing test quality. Prefer meaningful integration checks for important flows. Keep small boundary checks when they provide clearer evidence. Do not optimize test count, coverage, or scores.

For bug fixes, show that the relevant check fails with the bug and passes with the fix where practical. Keep the first failure. After two unsuccessful repair attempts for the same failure, stop that repair and report the evidence and options. Continue independent authorized work.

Do not weaken assertions, reduce discovery, ignore exits, skip checks, expand exclusions, or relax lint/security policy to get green. Control changes require owner review before merge. `.github/CODEOWNERS` lists the control paths. Never edit or delete an existing test line to get green. Automated guards cannot prove every assertion's meaning.

Every high/critical dependency advisory blocks acceptance. The one exception is a high advisory that no release fixes yet, under a dated `track-unpatched` disposition (`docs/dependencies.md`, "Unpatched high advisories"). Moderate/low findings need a disposition and review date; serious application risk also blocks. An unavailable, skipped, cancelled, or stale required result is not a pass. The compiler report does not prove device compilation. Native-driver fakes do not prove iOS behavior.

## Completion evidence

Report the scope, commit, commands, results, and remaining limitations. Run proportionate checks after relevant changes; do not repeat passing checks without a reason. Acceptance requires the full implemented suite for the actual commit and protected GitHub checks. Changes to the control paths in `.github/CODEOWNERS` also require owner review, and other changes merge on green checks. Submission branches and local commits remain unaccepted candidates. Do not claim enforcement before remote rules and the separate actor are verified.
