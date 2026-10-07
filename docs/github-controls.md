# GitHub acceptance controls

This page describes the repository settings, the bot, the checks, and the rules that decide whether a change can merge. It is the reviewed local definition. It is not evidence that a remote repository enforces it. Check the remote settings before you claim enforcement.

Keep these repository settings:

- The default Actions token is read-only.
- GitHub Actions cannot approve pull request reviews.
- Only rebase merges are allowed.

The read-only token is a default, not a ceiling. Any workflow can request `statuses: write` or `checks: write` in its `permissions` block, as `target-health.yml` does.

## Bot identity

Agent writes use a GitHub App installed only on this repository. Its webhook and user OAuth flow are off.

| Repository permission                                   | Access         | Purpose                              |
| ------------------------------------------------------- | -------------- | ------------------------------------ |
| Contents                                                | Read and write | Publish candidate branches           |
| Pull requests                                           | Read and write | Open and update PRs                  |
| Workflows                                               | None           | Keep workflow changes with the owner |
| Actions                                                 | Read-only      | Inspect CI results                   |
| Metadata                                                | Read-only      | Identify the repository              |
| Administration, checks, statuses, secrets, environments | None           | Remain outside the bot's authority   |

Use an **installation access token**, which identifies the bot. A user access token would act as a person. Do not give the app a ruleset bypass. The owner reviews changes to code-owned files. The bot merges a PR when the ruleset allows it.

Without Workflows write, GitHub rejects a bot push that adds or edits a workflow. It also returns HTTP 403 when the bot tries to create a status, a check run, or a workflow dispatch. CI runs with a read-only token, so the bot has no route to a required result. A workflow change needs a temporary owner grant for that one reviewed PR. With Workflows write, a bot workflow on an unreviewed `submission/**` branch could publish results as the GitHub Actions app, ID `15368`.

No permission removes one limit. CI runs the candidate's own code, so a candidate can weaken its own tests or check list. Those results are real, not forged. CODEOWNERS review of every checking file, check list, and dependency file is the control against them, with two known exceptions. The native iOS project file, `packages/app/ios/MargeloChat.xcodeproj/project.pbxproj`, has no code owner, and it can add a Swift package that `Podfile`, `Podfile.lock`, and the npm audit do not cover. The suppression policy allows a named inline lint disable with a reason in unowned source, except for `project/no-type-assertion` and `typescript/ban-ts-comment`. `tools/verify.cjs` pins the npm registry for every check, so a candidate's `.npmrc` cannot move the dependency audit. The `lint` script passes `--disable-nested-config`, so a nested `.oxlintrc.json` cannot replace the lint rules. Lint and format read the unowned `packages/app/ios/` folder, and format skips only its JSON files. Lint and format skip every path that `.gitignore` names, so the `ignored-files` check fails on any tracked file under such a path. The `security` check runs rnsec on `packages/app/` and `shared/`, the two folders that the app bundle imports source from today. rnsec always skips paths such as `dist/`, `e2e/`, and `test/`, so the `security` check fails on JavaScript or TypeScript source in those paths outside `packages/app/__tests__/`, `packages/server/tests/`, and `tools/__tests__/`. Lint rejects `@ts-nocheck` and `@ts-ignore`, and each `@ts-expect-error` needs a description. Apart from the two exceptions, a change to unowned files alone cannot hide source from lint, format, or the type check. The `security` check does not read unowned source in other folders, such as `packages/server/src/`, even when app code imports it. Tests outside `tools/` are not code-owned, so `AGENTS.md` forbids weakening them.

A local helper verifies the app and installation identities, requests a short-lived installation token, and checks that the token grants exactly the permissions above on this one repository. Do not put private keys or tokens in chat, tracked files, URLs, shell history, or build artifacts.

Sources: [GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app), [installation-token identity](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps), [credential guidance](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app).

## Checks and rules

`tools/github/integration-rules.json` defines the repository ruleset. It protects every branch except `submission/**`. Those refs are candidate uploads, not acceptance targets. Do not merge or promote work through them. The repository owner can still change the rules on purpose.

The ruleset requires `quality-gate` and `target-health` from the GitHub Actions app, ID `15368`. It requires a PR, current checks, code-owner review, dismissal of stale approvals, approval after the latest push, and resolved review conversations. It permits no bypass actors, force pushes, deletion, or merge commits on protected targets. Keep auto-merge off. The ruleset requires no other approval. CODEOWNERS gives the owner every file except app and server source, tests, harness, and native project files. The owner still owns every dotfile and config inside those folders. A PR that touches only unowned files merges on green checks. GitHub reads CODEOWNERS from the base branch, so a PR cannot remove its own code owner.

CI uses pinned actions and Ubuntu 24.04. For a PR, it verifies the candidate head and the proposed merge result in separate clean checkouts. Push CI verifies the resulting commit. The full suite covers lint, formatting, types, tests, credentials, the iOS and shared scanner, dependency policy, the server build, the iOS release JavaScript bundle, and the compiler report. The compiler report fails only when the tool crashes, so it is a report, not a gate. The overall check fails when a verification job fails, skips, or is cancelled.

Only PR runs publish the required `quality-gate` check. Push runs name their gate `post-push-gate`. A push run on a PR's head branch therefore cannot replace a failed merge-result check with a later success on the same commit. Each candidate also defines its own check list in `tools/verification/checks.cjs`, so owner review of that file keeps the list complete.

The target-health controller checks the latest push run for the target's exact current SHA, then checks that run's required jobs and steps. A test ties those job and step names to `ci.yml`. The controller sets status on the PR head, not on its own workflow SHA. When several PRs share a head, all their targets must pass. The controller rechecks PR and target identities before it publishes success. It reads metadata and trusted default-branch code only. It never runs PR code or downloads candidate artifacts or caches.

GitHub events and status updates are asynchronous, so this is not an atomic merge lock. If the controller fails before it marks a PR head `pending`, an earlier `success` on that head stays until the next complete run. Required-check provenance still depends on owner review of workflows and checking code. A deployment mechanism must require a healthy target.

Nobody can create a protected branch while the ruleset is active. The `creation` rule applies to every branch except `submission/**`, and the ruleset has no bypass actors. Every open PR head carries both required results before review, so without this rule the bot could create an undeletable protected branch from unreviewed code. Creation at the `main` tip fails, because that commit carries `post-push-gate`, not `quality-gate` or `target-health`. To add an integration target, the owner edits the ruleset, creates the branch from a reviewed `main` commit, and restores the rule.

Sources: [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs), [latest-attempt jobs](https://docs.github.com/en/rest/actions/workflow-jobs), [rulesets](https://docs.github.com/en/rest/repos/rules).

## What the rules block

A test on a disposable target branch confirmed this behavior on GitHub:

- A candidate whose `quality-gate` failed, was missing, was skipped, or was cancelled stays blocked, even with a fresh owner approval and a passing `target-health`.
- A skipped gate job reports under its unevaluated name expression, so the required check stays missing.
- A content change after approval dismisses the approval, and an outdated base blocks the merge.
- After a bot rebase, the displayed approval stays, but the last-push rule still requires a fresh one.
- Rerunning `main`'s push run holds open PRs until that run passes.
- An owner-approved repair releases only its bound PR, an unrelated PR stays held, and a target rerun revokes the approval.

## Repair a failed target

When an accepted target fails, hold unrelated merges and releases. The owner may dispatch `Target health` on the default branch with `operation=approve-repair`, the PR number, the exact candidate SHA, and the exact failing target SHA. The controller requires a completed push run for that target that failed verification. A failed, timed-out, or startup-failed run qualifies, and so does a successful run whose required jobs or steps did not pass. A missing, pending, or cancelled run does not qualify. Rerun a cancelled run instead. If the target has no push run at all, only an owner ruleset change can release the hold.

The approval binds the PR, the candidate SHA, the target SHA, the target run ID, and the target run attempt. The controller chooses the run and the attempt, and the owner does not supply them. The approval counts only while its dispatch is a first attempt that succeeded, and while the run name records the same PR, candidate, and target. Dispatch again instead of rerunning an old approval. A new push, a new target commit, or a target rerun invalidates the approval. The approval grants only a target-health exception. Full candidate checks still apply, and owner review applies when the PR changes a code-owned file. A revert needs its own approval.

With one human reviewer, `require_last_push_approval` means the owner cannot approve their own push. Let the bot update a stale candidate branch. Pressing **Update branch** as the owner creates an owner push that the owner cannot approve.

## Apply the rules to a new repository

`pull_request_target`, `workflow_run`, and `workflow_dispatch` read their workflow file from the default branch. Apply the ruleset only after `main` holds the trusted workflows.

1. Confirm that push CI and `post-push-gate` pass for the `main` commit.
2. Apply the full ruleset from the owner account.

   ```sh
   node tools/github/ruleset.cjs full | gh api -X POST repos/<owner>/<repo>/rulesets --input -
   ```

3. Test the rules before you accept a change. A bot push to `main` must fail, and a PR without `quality-gate` must stay blocked.
4. Confirm that the app has no Workflows write permission and cannot push a workflow.
