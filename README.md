# Personal iOS chat

This repository extends the [Margelo chat demo](https://blog.margelo.com/building-native-llm-chat-app-with-rag). The inherited demo screens now run on the saved-chat session and reach providers only through the chat server. The demo's direct provider connection, document search, and key settings are removed from the source. Recents lists the saved chats.

Builds made before that removal embedded any real keys from `config.ts` in their bundle, and the native socket prewarmer stored the OpenAI socket request, key included, on the device. An install upgraded from such a build sends that stored request once on its first launch, before JavaScript runs and clears the queue. Rotate any key that was ever in a built app.

The user owns the UI. Engineering scope is iOS and the shared app and server code. The Android sources are inherited and not maintained.

Read [AGENTS.md](AGENTS.md) for task boundaries. [Provider contracts](docs/providers.md) describe the approved provider behavior. [Dependency review](docs/dependencies.md) records all findings from the dated scan.

## Setup and commands

Use Node `22.23.3` from `.node-version`. Install from the repository root:

```sh
npm ci
cp packages/app/src/config.example.ts packages/app/src/config.ts
```

Set `PROXY_BASE_URL` in `config.ts` to your chat server's origin, and keep the example value for static checks. The app source holds no provider credentials; they stay on the server. Metro refuses to start or bundle when `config.ts` holds anything but the names `config.example.ts` exports. The check runs in `packages/app/metro.config.js`, so it covers the Xcode bundle phase, `npm run ios`, `npm start`, and `npm run build:ios-js`. Native builds require Xcode, CocoaPods, and `pod install` in `packages/app/ios`. For a signed build, put `DEVELOPMENT_TEAM = <team ID>` in `packages/app/ios/DevelopmentTeam.xcconfig`, which git ignores. Local checks do not establish device behavior.

```sh
npm start                    # Metro
npm run ios                  # native build and launch
npm run lint                 # selected Oxlint rules; warnings fail
npm run format               # format without import/package-field sorting
npm run format:check
npm run typecheck
npm run typecheck:range -- origin/main # each commit before HEAD
npm run exports:check        # every export is imported or a listed entry
npm test                     # ordinary local test feedback
npm run test:verified        # also reject empty/skipped/unfinished suites
npm run secrets
npm run security             # iOS/shared scan; HIGH or undisposed findings block, except dependency entries
npm run audit:check          # high/critical findings block, except dated track-unpatched highs
npm run build:server
npm run build:ios-js          # release JS bundle; not native compilation
npm run react-compiler-check # report; not proof of native compilation
npm run skills:required -- origin/main # skills this branch must apply
npm run skills:check -- origin/main # the branch's skill record covers them
npm run skills:ledger         # repeated guidance is enforced or linked to a decision
npm run verify:commit -- HEAD
```

## Verification and review

The pre-commit hook checks lint, formatting, and credentials in a snapshot of the Git index. It performs a fresh locked install there. It cannot use unstaged fixes or your local `node_modules`. The pre-push hook runs the full implemented suite on the tip commit of each pushed branch. Hosted CI checks each PR head, its proposed merge result, and each push.

`verify:commit` runs the selected commit's own checking code in a fresh checkout. It records the commit, tree, commands, results, and source integrity in ignored `.quality-results/`. A commit that tracks files under `.quality-results/` fails, so a candidate cannot supply its own result records. Only committed example configuration enters that checkout. Checks cannot silently change source while running. Logs and results remain available after the temporary checkout is removed. It also runs range checks, such as the skill-record check, from the merge base with `origin/main` or with `--base <ref>`. Hosted CI checks out one commit without history, so it skips range checks and says so until its workflow passes `--base`. `typecheck:range` typechecks each commit before the head, because a cherry-pick or bisect can land on any of them. Commits whose `npm ci` inputs match an earlier install reuse it, so the cost is about 3 seconds per commit plus one `npm ci` for each new set of install inputs. Five commits took 13 seconds in one measurement.

Local hooks are feedback controls and remain bypassable by the machine owner. Git runs the hooks only after `npm ci` has installed them in that checkout. A new worktree without an install skips them without warning. Acceptance also requires protected GitHub checks and owner review. CI checks both the PR head and proposed merge result, then checks the exact resulting commit after a push. Only PR runs publish the required `quality-gate` check; push runs publish `post-push-gate`. Every implemented check must finish successfully. The compiler report fails only if the tool crashes, so it is a report, not a gate. Dependency and scanner failures remain failures.

The GitHub target-health workflow reads trusted code and API metadata. It checks the current target's latest post-push result. Missing, pending, failed, cancelled, or incomplete verification holds unrelated merges. An owner-authorized repair exception requires a completed push run that failed verification. It binds one PR, head SHA, target SHA, and target run attempt, and it counts only from a fresh successful approval dispatch. A target rerun invalidates that approval; candidate checks and reviews still apply. Event delivery is asynchronous. Remote rules and controller behavior require hosted verification before we can claim enforcement. See [GitHub setup](docs/github-controls.md).

Agent writes use a GitHub App bot with a repository-scoped installation token, and the owner approves PRs. The bot has no Workflows, Statuses, Checks, or Actions write permission, so it cannot publish a required result. See [GitHub setup](docs/github-controls.md).

The 13 selected anti-slop rules remain errors. Their source and license are in `tools/vendor/anti-slop/UPSTREAM.md`. Exact legacy-file overrides preserve inherited demo files until their feature logic is replaced. A raw-input decoder may suppress `anti-slop/no-unknown-parameters` on the parameter declaration with a named rule and reason after `--`. Existing fixtures verify that exception and reject undocumented suppressions. `project/no-type-assertion` rejects `as`, angle-bracket, non-null, and definite-assignment assertions, and allows `as const`. A reviewed boundary file goes in the rule's `allow` option in `.oxlintrc.json` with a reason. The list is empty, and it defaults to empty when the option is missing. That list is the only exemption, because `project/require-disable-reason` rejects an `eslint-disable` or `oxlint-disable` comment that names `project/no-type-assertion`. The six assertions left are in legacy override files. The Effect plugin remains unregistered.

`exports:check` lists the exports of every tracked TypeScript file in the projects named in `tools/verification/export-entries.json`, which are the app and the server. It fails on an export that no file in those projects imports and no tracked `.js`, `.mjs`, or `.cjs` file imports by relative path. It does not read untracked files, package `exports` maps, or imports built from strings at run time. `tools/verification/export-entries.json` lists framework entry points and exports that an open branch still needs, each with a reason. An entry fails once its export is imported or gone.

Every high/critical dependency advisory blocks acceptance, regardless of exposure. The one exception is a high advisory that no release fixes yet. It can pass under a `track-unpatched` disposition whose `reviewBy` date is at most 14 days after its review. The check fails again once npm shows a new `latest` release or any release outside the advisory's range ([dependency review](docs/dependencies.md), "Unpatched high advisories"). Moderate/low findings have dated dispositions in `tools/verification/dependency-dispositions.json`; new or expired findings need review. No update or override is automatic.

The scanner excludes Android-specific files and scans the remaining app. Stream and tool arguments receive schema validation; raw network errors are not logged. Reply links require HTTP/HTTPS, structural validation, and OS support. Checks exercise React Native's actual JavaScript URL implementation. The fresh scanner run reports no shared-code findings. It leaves its dependency entries, at any severity, to the separate dependency gate, which checks their advisory dispositions. Any other scanner finding fails unless `tools/verification/security-dispositions.json` records a current, reasoned disposition for it. Neither check proves native networking safety. All seven native patches and the Metro patch must apply during `npm ci`.

## Skill routing

`tools/skills/routing.json` maps paths, file statuses, removed exports, added lines, commit subjects, and change size to required skills. `npm run skills:required` prints each required skill with the rule and file that require it. Each change commits a skill record under `tools/skills/records/`. The record stores its base, and its own range runs from that base to the next record's base, or to the head. `verify:commit` fails when a record that the range changes misses a skill its own range requires, has an author entry without a valid signed receipt from that range, or has a finding without a status. A pull request run also fails each record without an independent review, and each record with an open finding. Hosted CI does not run that check until its workflow passes `--base`. A local Claude Code hook signs one receipt for each skill an agent loads. `tools/skills/catalog.lock.json` holds each skill's hash, headings, and numbered rules, so CI checks receipts and finding citations without the skill files. `tools/skills/ledger.json` lists recurring findings and what enforces each. The required-skills output includes the lessons that only guidance covers, and `verify:commit` fails when a guidance lesson recurs without enforcement or a linked decision. [Skill routing](docs/skills.md) describes the rules, the skill roots, the record format, the receipts, and the ledger.

## Test review

The reusable `test-prune` skill lives in `.agents/skills/test-prune/SKILL.md`. This is the maintained source. Copy reviewed changes explicitly to any global copy of the skill and compare hashes. Do not link the two directories or update them during package installation.

The test review removed an empty shell smoke check and strengthened two existing event-order/replay assertions. Deliberately missing model events and empty replay results now fail those checks. SQL, local-socket, archive, protocol, and parser checks retain their distinct behavioral protection. The repository has no full app end-to-end test yet.

## Workspace

`packages/app` contains the native app, archive, and client protocol. `packages/server` contains provider adapters, durable job logic, and authenticated routes. `shared` contains validated wire contracts. Install dependencies and run checks at the root. Native projects remain inside the app package; Metro and CocoaPods resolve workspace dependencies.

### Connection foundation checkpoint

`packages/app/src/network/client.ts` implements the server protocol behind injected
HTTP, WebSocket, and text-decoder drivers. Manual Gateway submissions use HTTP;
GPT and Auto use a shared socket. Recovery reads an existing attempt. Reader abort
and explicit Stop use separate operations. Runtime schemas validate delivery, and
large inputs upload acknowledged parts before one commit. This layer never retries
a submission automatically. Its consumer must persist acceptance, results, and
cursors before acknowledging them to the server.

`packages/app/src/state/chatView.ts` connects this layer, the native binding, and the
session controller below to the existing screens. The user owns the UI work, and the
screens keep their UI. Recents lists saved chats with a sent message, newest first,
and its search matches titles loosely. A chat opens at its newest 50 messages, and
scrolling to the top loads the 50 before them.

`packages/app/src/network/nativeDrivers.ts` is the iOS binding for these drivers. It
uses the Nitro request builder and WebSocket objects directly, so nothing reaches the
nitro-fetch network inspector. The `react-native-nitro-fetch` patch holds a redirect
until JavaScript follows or cancels it, releases each request's URL session, and keeps
requests carrying an `Authorization` header out of the React Native DevTools network reporter.
The `react-native-nitro-websockets` patch makes a WebSocket handshake refuse redirects.

`node tools/native-transport/run.mjs` runs the binding on an iOS simulator against a
localhost server and judges the evidence. On an iPhone 16 Pro (iOS 18.5) simulator it
showed the following:

- Abort before headers and during a stream closes the native request, and the call
  settles once. Detaching a reader never calls Stop.
- Credentialed HTTP redirects and WebSocket handshake redirects fail, and the redirect
  target receives nothing. A socket submission completes on the intended host.
- Admission errors keep their status and message. Split UTF-8 reconstructs exactly.
  Truncated and malformed SSE fail.
- After lost acceptance, the client recovers the same attempt with one dispatch.
- The inspector and device log hold neither the credential nor bodies. Instrumented
  builds (`NITROFETCH_HARNESS`) show no DevTools reports and no retained request objects.

Two checks still fail, and they stay visible:

- iOS reports an HTTP/1.1 chunked body cut at a record boundary as success. A lost
  connection after acceptance can therefore end `submit()` without a terminal record.
  The protocol needs an explicit end record; the binding cannot detect the cut.
- CFNetwork reads a fast response ahead of JavaScript. A 314 MB stream raised memory by
  about its full size. Suspending the task did not limit it.

Backgrounding on the simulator kept the stream open and delivered the backlog on return.
Readers therefore rely on the detach that `nativeSession.ts` performs on background. Lock, suspension, process
termination, and network changes need a physical iPhone. Fake-driver tests remain
contract evidence. Hosted CI requires a push; local checks are reported separately.

### Session controller checkpoint

`packages/app/src/state/session.ts` connects the saved-chat archive to the
transport. `attempt.ts` reads each
saved reply into one phase: unsent, accepted, Stop pending, final but not yet
confirmed to the server, or settled. Each phase has one next operation. Every
reply has its own runner, so one chat's failure, refusal, or reconnect does not
pause another. Token updates stay in memory and reach storage on a bounded
checkpoint. Acceptance, final results, and Stop are saved before the session
continues. The phone acknowledges a reply only after its final result is saved.
Recovery resends the same attempt or receipt and never creates a new version.
A refusal that names the attempt marks it failed; a socket error that names no
attempt counts as a lost connection. Chat deletions finish on 404 or 410, retry
network and server errors, and stop on other refusals until the app reopens.
`nativeSession.ts` forwards React Native `AppState` to the session;
backgrounding detaches readers without cancelling server work.

Each chat's unsent composer text is saved with the chats, under that chat's
id, 500 ms after typing pauses, and at once when the app leaves the
foreground. It comes back when the chat opens after a relaunch. Sending or
clearing the text deletes it. A draft that cannot be read or saved is dropped
without blocking typing or sending. Limitation: photos added to a draft are
kept in memory only and are lost when the app is killed.

Integration tests in `packages/server/tests/session-*.test.ts` run the real
archive, `ServerTransport`, and session against `handleRequest` and the socket
route's `SocketConnection` over PGlite, with the real worker and scripted fake
providers. They live in the server suite because PGlite does not load under the
React Native jest preset. They do not prove native networking, device lifecycle
behavior, or the hosted Workflow runtime.

### Open-source libraries

This app stands on the shoulders of these projects (thank you to their authors):

- [react-native](https://github.com/facebook/react-native) & [react](https://github.com/facebook/react) - Meta
- [react-native-nitro-modules](https://github.com/mrousavy/nitro) - Marc Rousavy / Margelo
- [react-native-nitro-websockets](https://github.com/mrousavy/nitro) - Marc Rousavy / Margelo
- [react-native-nitro-image](https://github.com/mrousavy/react-native-nitro-image) - Marc Rousavy / Margelo
- [react-native-nitro-fetch](https://github.com/margelo/react-native-nitro-fetch) & [react-native-nitro-text-decoder](https://github.com/margelo/react-native-nitro-fetch) - Szymon Kapała / Margelo
- [react-native-nitro-symbols](https://github.com/DaveyEke/react-native-nitro-symbols) - Dave Mkpa Eke / Margelo
- [react-native-reanimated](https://github.com/software-mansion/react-native-reanimated) & [react-native-worklets](https://github.com/software-mansion/react-native-reanimated) - Software Mansion
- [react-native-keyboard-controller](https://github.com/kirillzyusko/react-native-keyboard-controller) - Kiryl Ziusko / Margelo
- [@legendapp/list](https://github.com/LegendApp/legend-list) - LegendApp
- [react-native-enriched-markdown](https://github.com/software-mansion-labs/react-native-enriched-markdown) - Software Mansion
- [react-native-true-sheet](https://github.com/lodev09/react-native-true-sheet) - Jovanni Lo
- [@shopify/react-native-skia](https://github.com/Shopify/react-native-skia) - Shopify
- [@callstack/liquid-glass](https://github.com/callstack/liquid-glass) - Callstack
- [react-native-pager-view](https://github.com/callstack/react-native-pager-view) - Callstack
- [zeego](https://github.com/nandorojo/zeego) - Fernando Rojo
- [@react-native-menu/menu](https://github.com/react-native-menu/menu) - Jesse Katsumata
- [@react-native-vector-icons/material-design-icons](https://github.com/oblador/react-native-vector-icons) - Joel Arvidsson
- [react-native-image-picker](https://github.com/react-native-image-picker/react-native-image-picker) - community
- [react-native-safe-area-context](https://github.com/AppAndFlow/react-native-safe-area-context) - Janic Duplessis
- [react-native-bootsplash](https://github.com/zoontek/react-native-bootsplash) & [react-native-edge-to-edge](https://github.com/zoontek/react-native-edge-to-edge) - Mathieu Acthernoene
- Model API: [OpenAI](https://openai.com/)
