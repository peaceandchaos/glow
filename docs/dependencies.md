# Dependency advisory triage — 29 September 2026

Read-only review of the dependency tree. No repository files, packages, settings, or deployments changed.

The policy is strict: every high/critical advisory blocks acceptance, regardless of exposure. Since 3 October 2026 one exception applies, to a high advisory that no release fixes yet ("Unpatched high advisories" below). The exposure analysis below explains the risk and testing needed; it does not waive that policy. Moderate/low findings have a disposition and review date in `tools/verification/dependency-dispositions.json`; serious application risk still blocks. Only iOS and shared tooling require platform verification. No automatic upgrades are authorized.

Follow-up inspection of the published image-size 2.0.3 archive found the default export consumed by Metro's Babel wrapper and its Uint8Array input API. A scoped override is a candidate, subject to real asset-path and bundling checks. Specific repairs for the eight high-severity families followed this review. Implementation and verification results will be recorded separately; this review does not claim they are resolved.

## Repair progress

The first repair group selects xmldom 0.8.15/0.9.12, brace-expansion 1.1.18/5.0.9, browserslist 4.28.7, js-yaml 3.15.2/4.3.2, and sharp 0.35.4. Parent-scoped overrides preserve the existing major/minor lines. The unchanged brace-expansion 2.1.7 path remains. Related browser data and sharp platform binaries changed with these packages; no framework upgrade was made.

A clean locked installation applied all four native patches. Local compatibility checks passed for both plist parser/builders, brace expansion through minimatch 3 and 10, both YAML round trips, browser-target selection, and sharp PNG generation/metadata. The installed macOS sharp binary reports libheif 1.23.2. Initial fixture assumptions about package exports and prototype identity were corrected after inspecting the actual caller APIs. These checks do not prove native compilation or Linux binary compatibility.

Workflow's scoped overrides now resolve nanoid 5.1.16 and both affected Undici copies to 7.29.1. The separate Undici 7.30.0 copy is unchanged. A fresh install passed. Local fixtures exercised Workflow's fixed-size customRandom API and streamed responses through world-local's Agent and world-vercel's actual events dispatcher. No provider credentials or hosted service were used.

The approved Metro image-size 2.0.3 override uses a small patch that reads bytes before `getAssetData` measures an image. Both actual Metro image paths pass with the repository PNG and reject empty/invalid PNG input; non-image assets remain supported. A clean install applies the Metro patch alongside the four existing native patches.

The release bundle then exposed a missing transform for Zod's export-namespace syntax. The app now enables and directly declares the already-locked `@babel/plugin-transform-export-namespace-from` 7.29.7; its installed version did not change. The iOS release JavaScript bundle passed after this configuration repair. `build:ios-js` now joins the committed checks because these two real failures were not caught by type checks or Jest. It is JavaScript bundling, not native compilation. [Babel transform documentation](https://babeljs.io/docs/babel-plugin-transform-export-namespace-from).

The fresh audit added [GHSA-6h2x-m376-mqjq](https://github.com/advisories/GHSA-6h2x-m376-mqjq), a high-severity Joi ISO-date validation issue absent from the first snapshot. The approved 17.13.7 patch fits both CLI parents' `^17.2.1` ranges. A fresh install and actual CLI configuration loading passed, including iOS project and native dependency discovery. The final lockfile audit reports zero high/critical and 15 moderate package entries. Existing dated dispositions satisfy the lower-severity policy. Hosted and native acceptance remain pending.

On 30 September 2026, a new audit added three brace-expansion advisories published on 29 September: [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7) (high, nested-group recursion), [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) (high, `parseCommaParts` recursion), and [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr) (moderate, quadratic `{a},b}` rewrite). The candidate raises the existing scoped overrides to 1.1.21 for the glob and test-exclude minimatch 3.1.5 copies (`^1.1.7`) and to 5.0.12 for minimatch 10.2.5 (`^5.0.5`). Both are the first versions that fix all three advisories. The filelist → minimatch 5.1.9 copy stays at 2.1.7, which is already patched for all three. Neither npm 10.9.9 nor npm 11.20.0 rewrote the stale nested 5.0.9 lock entry. The only lockfile edit that avoided unrelated tree changes set that entry's version, URL and integrity from registry metadata. Its dependencies and engines match 5.0.9. `npm ci` verified the tarballs and applied all five patches. The lock-only audit went from 2 high and 15 moderate entries to 0 high and 15 moderate, and no remaining finding involves brace-expansion. Tests, coverage filtering through test-exclude, and the server build passed. Normal patterns produced the same output as 1.1.18/5.0.9. Hostile shapes stayed bounded through both minimatch lines: 50,000 trailing braces took 22–56 ms, compared with about 5.9 s on the old versions. Nesting 5,000 or 20,000 levels deep, and a 20,000-group comma chain, returned results where the old versions overflowed the stack.

On 1 October 2026, a new audit reported six devalue advisories published that day. All affect `<=5.9.2` and are fixed in 5.9.3. Three are high: [GHSA-j22f-vq7h-c4qm](https://github.com/advisories/GHSA-j22f-vq7h-c4qm) (shared Buffer memory serialized), [GHSA-mcm9-63f2-9j32](https://github.com/advisories/GHSA-mcm9-63f2-9j32) (quadratic `uneval` strings), and [GHSA-x5rw-q4pp-hg5g](https://github.com/advisories/GHSA-x5rw-q4pp-hg5g) (`stringifyAsync` unhandled rejection). Two are moderate: [GHSA-hx4r-w6wj-j8fg](https://github.com/advisories/GHSA-hx4r-w6wj-j8fg) (sparse-array `uneval` CPU) and [GHSA-4q55-j62x-fr9h](https://github.com/advisories/GHSA-4q55-j62x-fr9h) (non-string null-prototype keys bypass the `__proto__` check). [GHSA-wf3x-273g-mvxv](https://github.com/advisories/GHSA-wf3x-273g-mvxv) is low (eager sparse-array allocation). The only path is server workflow 4.8.9 → @workflow/core 4.8.9 → devalue 5.9.2, an exact pin. Core 4.8.10 keeps that pin and the next release is 5.0.0; npm's suggested `workflow@2.0.6` is a major downgrade. The candidate adds `devalue: 5.9.4` to the existing `@workflow/core` override block. 5.9.4 is the current 5.x patch; it differs from 5.9.3 only by `/* @__PURE__ */` annotations. Its registry tarball matches the locked SHA-512, and `npm audit signatures` verified its signature and its SLSA provenance from `sveltejs/devalue`. Compared with 5.9.2 it adds no dependencies, install scripts, engines, exports, or I/O. npm 10.9.9 did not rewrite the lock entry, so the edit sets its version, URL and integrity from registry metadata. `npm ci` applied all seven patches. Workflow calls only `stringify`, `parse` and `unflatten`, never `uneval` or `stringifyAsync`. Its own reducers encode typed arrays and Buffers before devalue's default `viewInfo`. A local fixture drove Workflow's exported serializers under each installed version. It covered workflow and step arguments, return values, the `getWritable` frame stream, and encrypted and legacy-`unflatten` reads. Payloads were the app's `[owner, attemptId]` arguments, an `undefined` step return, all three `JobEvent` kinds with a nested snapshot and checkpoint, and 300,000-character text with escapes. Dates, Maps, Sets, BigInt, typed arrays, pooled Buffers, sparse arrays, cycles and repeated references were also included. All 20 boundary cases and both streams produced byte-identical output. Bytes written under 5.9.2 hydrated to identical values under 5.9.4 (22 of 22). The advisory's array-key payload, sent through `hydrateStepArguments`, was accepted by 5.9.2 and rejected by 5.9.4. The lock-only audit went from 13 high and 15 moderate entries to 0 high and 15 moderate. No remaining finding involves devalue or Workflow, so no new dispositions were needed. Server tests and the server build passed, and the server bundle contains the patched parser.

On 3 October 2026 the audit failed on [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) (high, stack exhaustion from deeply nested braces patterns). It affects braces `<=3.0.3`, and 3.0.3 is the latest release, so no upgrade fixes it. GitHub updated the advisory at 22:36 UTC on 2 October, and from then on every push failed `security` and `dependencies`, on `main` as well. braces enters the tree only through micromatch, which Jest, metro-file-map, fast-glob and find-yarn-workspace-root use. fast-glob comes from the React Native CLI, react-compiler-healthcheck, react-native-bootsplash and rnsec. A release iOS bundle built on 3 October lists 1,521 source files in its source map, and none comes from braces, micromatch, fast-glob or picomatch. The server build output holds no copy of them either. It is tracked under the rule below until 17 October. The dependency re-review is due by 20 October, but it must upgrade braces or renew this disposition by 17 October. From 18 October, `audit:check` fails until one of them happens.

On 3 October 2026 the scheduled dependency review moved the React Native CLI from 20.1.0 to 20.2.0, updated qs from 6.15.3 to 6.16.0, and gave `xcode` uuid 11.1.1 through a scoped override. The CLI move replaces body-parser 1.20.5 with 2.3.0 and fast-xml-parser 4.5.6 with 5.11.2, and it brings the 20.1.1 fix for remote code execution in `openURLMiddleware`. xcode 3.0.1 is the latest release and calls only `uuid.v4()`. npm 10.9.9 kept the stale uuid lock entry after the override was added, so the entry was set from registry metadata, the same method as for brace-expansion above. The lock-only audit went from 6 advisories to 1. The 11 dispositions that matched no advisory and the 5 that these changes fix were deleted. braces stays under its `track-unpatched` disposition. `audit:check`, the type checks, 475 tests, both builds, `security`, lint and format passed. The CLI's `config` output and the release iOS bundle were byte-identical to those of the previous commit.

On 6 October 2026 GitHub published two advisories that failed `audit:check` on `main`. [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) (high) covers sharp `<0.35.5`, whose prebuilt librsvg can allow remote code execution on glibc Linux. [GHSA-pqg4-j6r4-53mv](https://github.com/advisories/GHSA-pqg4-j6r4-53mv) (critical) covers shell-quote `>=1.8.4 <1.11.0`, where `quote()` lets a line terminator after a `{ comment }` token run shell input. Neither needed an override, because each parent's range already admits the fixed release. `npm update sharp shell-quote --package-lock-only` changed only sharp and its platform packages and shell-quote:

- sharp moved from 0.35.4 to 0.35.5, inside the `^0.35.2` range of react-native-bootsplash 7.3.2. Every `@img/sharp-*` platform package moved to 0.35.5 and every `@img/sharp-libvips-*` package to 1.3.4, Linux included. The installed macOS binary reports librsvg 2.63.2, the version the advisory names, libvips 8.18.7 and libheif 1.23.5. A fixture that repeats bootsplash's `toAsset` steps on `logo@4x.png` and on an SVG gave the same height and the same PNG bytes under 0.35.4 and 0.35.5.
- shell-quote moved from 1.9.0 to 1.12.0, the latest release. It fits launch-editor 2.14.1 (`^1.8.4`) and react-devtools-core 6.1.5 (`^1.6.1`). launch-editor calls only `parse()`, on the `REACT_EDITOR` value that `@react-native-community/cli-tools` passes it. react-devtools-core bundles its own copy into `dist` and does not load the installed one. 1.11.0 is the first fixed release. 1.12.0 adds only more shell operators to `parse()` and `quote()`. Six typical editor commands parsed to the same tokens under 1.9.0 and 1.12.0. The advisory's `quote()` example returns the injected line under 1.9.0 and throws a `TypeError` under 1.12.0.

The same change raised both root joi overrides from 17.13.7 to 17.13.8, the first release outside [GHSA-wr44-6hxh-3jwq](https://github.com/advisories/GHSA-wr44-6hxh-3jwq) (moderate, `__proto__` as a message code replaces the compiled messages' prototype). 17.13.8 fits the `^17.2.1` range of `@react-native-community/cli-config` and `@react-native-community/cli-types` 20.2.0. Its only code change adds an assertion that rejects `__proto__` in `lib/messages.js`, and its dependencies match 17.13.7. The CLI packages pass no custom messages to joi. npm 10.9.9 kept the stale lock entry after the override change, so the entry was set from registry metadata, the same method as for brace-expansion above. With 17.13.7 a `__proto__` code replaced the compiled object's prototype, and 17.13.8 rejects it. `react-native config` still loaded the iOS project and 29 native dependencies. The change deletes the joi `track` disposition.

The lock-only audit went from 5 advisories (1 critical, 2 high, 2 moderate) to 2: braces under its `track-unpatched` disposition and sprintf-js under its `track` disposition.

## Unpatched high advisories

Since 3 October 2026, a high advisory that no release of its package fixes yet may pass `audit:check` under a `track-unpatched` disposition in `tools/verification/dependency-dispositions.json`. The check accepts the disposition only when it:

- names the advisory's package, exact range and `high` severity;
- gives a reason that is not blank;
- has a `reviewedAt` date no later than today, and a `reviewBy` date from today to 14 days after `reviewedAt`;
- records as `latest` the version that `npm view <package> version` returns, while every published release of the package is still inside the advisory's range. A new `latest` release, or any release outside the range, fails the check until someone reviews it. `npm view` leaves prereleases out of a range unless the range names one, so a package that has published a prerelease inside the range fails this test even when no fix exists. Tracking such an advisory needs a reviewed change to `audit-check.cjs`.

A disposition covers only the package it names, so another package listed under the same advisory stays blocked. A package that reaches the advisory through its dependencies passes only when every high or critical advisory it reaches is covered. A critical advisory never passes, and neither does a package that npm rates critical. A `track-unpatched` disposition that matches no current high advisory fails. When npm lists one advisory twice for one package with two ranges, both must match the disposition, so such an advisory always fails until the format allows a list of ranges. Dates are compared in UTC, so a disposition stops passing at 20:00 EDT on its `reviewBy` date. `security-check.cjs` leaves every dependency advisory, at any severity, to `audit:check`, and every other HIGH scanner finding still fails.

## Coverage and limits

A fresh lock-only npm audit reports **39 affected package entries: 20 high, 18 moderate, 1 low, 0 critical**. Those entries include propagated parent packages. They resolve to **14 advisory-bearing package families and 42 unique GHSA records**. The count is not 39 confirmed exploitable defects. Every listed advisory has a disposition below. Two upstream libheif advisories referenced by the sharp record were also read.

The review used the current lockfile, installed source call sites, official advisory records, and read-only npm registry metadata. It did not run malicious payloads, install candidate fixes, prove absence of a reachable path, or test the deployed Vercel/native environment. “Not observed” means the stated API precondition was not found in the inspected caller chain. It is not a permanent waiver. Build and development tooling remains security-relevant, particularly on untrusted pull requests.

The evidence files `dependency-audit-2026-09-29.json`, `dependency-triage-2026-09-29.json`, `dependency-candidates-2026-09-29.json`, and `dependency-advisories/*.json` are not in the repository. The JSON includes each installed affected node, each immediate lockfile parent and requested range, and a shortest resolved path from each explicit root. Installed peer edges are included; a peer relationship is dependency provenance, not proof that a native library executes a vulnerable tool at runtime.

## Dependency families

Versions below are the minimum published versions that cover the listed snapshot advisories. They are remediation candidates, not an instruction to auto-upgrade. A fresh audit and regression checks are required when a change is proposed.

| Package family             | Installed affected version(s) | Current area                                             | Candidate and constraint                                                                                                                                                                                                                                                              |
| -------------------------- | ----------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@xmldom/xmldom`           | 0.8.13, 0.9.10                | Native configuration/build tools                         | 0.8.15 and 0.9.12, preserving each installed minor line. Both fit the current parent ranges.                                                                                                                                                                                          |
| `baseline-browser-mapping` | 2.10.38                       | Babel/browser-target build tooling                       | 2.11.0 minimum; fits browserslist ^2.10.38.                                                                                                                                                                                                                                           |
| `body-parser`              | 1.20.5                        | React Native development server                          | 1.20.6 minimum fits CLI server API ^1.20.3. It still requires qs ~6.15.1; body-parser 1.20.7 was not published when checked.                                                                                                                                                          |
| `brace-expansion`          | 1.1.15, 5.0.6                 | Glob matching in build/test/Workflow tooling             | 1.1.18 and 5.0.9 minimum; each fits its minimatch parent range.                                                                                                                                                                                                                       |
| `browserslist`             | 4.28.4                        | Babel/browser-target build tooling                       | 4.28.7 minimum; fits ^4.24.0 and ^4.28.1 parents.                                                                                                                                                                                                                                     |
| `fast-xml-parser`          | 4.5.6                         | iOS and Android CLI configuration                        | 5.7.0 minimum is outside current ^4.4.1. CLI 20.2.0 changes both platform parents to ^5.3.6, which admits fixed versions. Updating the CLI family together is a candidate, not verified compatibility.                                                                                |
| `image-size`               | 1.2.1                         | Metro build-time asset inspection                        | 2.0.3 minimum is outside Metro ^1.0.2. Requires a compatible Metro/RN migration, a reviewed API adapter, or a maintained backport. A blind override is unsuitable.                                                                                                                    |
| `joi`                      | 17.13.4                       | React Native CLI configuration validation                | 17.13.6 minimum; fits both CLI parents ^17.2.1.                                                                                                                                                                                                                                       |
| `js-yaml`                  | 3.14.2, 4.2.0                 | Build and test configuration parsing                     | 3.15.2 and 4.3.2 minimum; fit ^3.13.1 and ^4.1.0 parents.                                                                                                                                                                                                                             |
| `nanoid`                   | 5.1.6                         | Production Workflow runtime                              | 5.1.16 minimum. @workflow/core 4.8.9 pins 5.1.6 exactly, including the latest published core. Requires an approved scoped override or upstream release. The high-severity findings cannot receive a reachability exception.                                                           |
| `qs`                       | 6.15.3                        | Development server and Workflow inspection web server    | 6.16.0 minimum. Fits Express ^6.14.0 and its body-parser ^6.15.2, but does not fit CLI body-parser ~6.15.1. The latter needs a reviewed scoped override or upstream parent change.                                                                                                    |
| `sharp`                    | 0.35.3                        | Bootsplash image generation on build machines            | 0.35.4 minimum fits existing bootsplash ^0.35.2. Bootsplash 7.3.3 is a current patch release that raises its minimum to ^0.35.4. Prefer the smallest reviewed change.                                                                                                                 |
| `undici`                   | 7.28.0                        | Production Workflow networking and local queue transport | 7.29.1 minimum covers all six listed advisories. Workflow world-local 4.4.1 and world-vercel 4.7.4 pin 7.28.0 exactly; these are still current latest. Requires an approved scoped override or upstream fix. The separate Gateway-related 7.30.0 copy does not fix Workflow’s copies. |
| `uuid`                     | 7.0.3                         | Xcode project editing during native configuration        | 11.1.1 minimum is outside xcode ^7.0.3. xcode 3.0.1 remains latest. Requires a reviewed migration/backport or a narrowly documented temporary exception.                                                                                                                              |

The npm fix suggestions include `workflow@2.0.6` and `react-native-bootsplash@5.3.0`. These are major downgrades from the installed versions. They are unsuitable automatic fixes. Current registry metadata still gives Workflow 4.8.9 as latest, with the vulnerable exact nanoid and undici pins.

## Caller evidence and validation needed

### 1. @xmldom/xmldom

**Path:** react-native-bootsplash → @expo/config-plugins → @expo/plist → xmldom 0.8.13; material-design-icons → common → plist → xmldom 0.9.10. Expo config plugins are also an installed peer path for enriched-markdown. xcode → simple-plist → plist is another parent chain.

**Observed:** @expo/plist/build/parse.js:69 and plist/lib/parse.js:67 use DOMParser for plist XML. Their build modules use xmlbuilder, not xmldom XMLSerializer. Inputs are build/configuration files. Crafted repository or dependency files can still attack a build runner. No app chat XML input route was found. HTML parsing and direct DOM serialization are not observed in these callers.

**Disposition:** Parser flaws have a build-input path. Serializer-only flaws have no matching call observed. Fix compatible leaf versions; do not waive the family wholesale.

**Change validation:** Run plist parse/build fixtures and native config/autolinking checks. Preserve XML parsing behavior. Some serializer fixes require requireWellFormed; a package update alone does not make every serialization call safe.

### 2. baseline-browser-mapping

**Path:** Babel helper-compilation-targets / core-js-compat → browserslist → baseline-browser-mapping.

**Observed:** The installed parent is browserslist 4.28.4. It is used through Babel compilation targets and core-js compatibility. This advisory requires invalid or conflicting API parameters. No user-chat-to-browser-query path was found.

**Disposition:** Build tooling exposure. The advisory precondition is not demonstrated in this app.

**Change validation:** Run Babel/Metro bundle and existing compiler checks after the leaf update.

### 3. body-parser

**Path:** @react-native-community/cli → cli-server-api 20.1.0 → body-parser 1.20.5.

**Observed:** CLI openStackFrameMiddleware.js:54 and openURLMiddleware.js:67 call bodyParser.json() without a computed limit. The advisory needs an invalid configured limit. The separate Express copy is already body-parser 2.3.0.

**Disposition:** Affected version installed. Its specific invalid-limit precondition is absent in the inspected callers.

**Change validation:** Check development-server JSON body rejection and normal open-stack-frame/open-URL actions. Do not expose the development server publicly.

### 4. brace-expansion

**Path:** minimatch → brace-expansion 5.0.6; glob / test-exclude → nested minimatch → brace-expansion 1.1.15. Roots include Jest, app tooling, and Workflow tooling.

**Observed:** minimatch 10.2.5 uses ^5.0.5; nested minimatch 3.1.5 copies in glob and test-exclude use ^1.1.7. Hostile brace patterns can exhaust CPU or memory. No chat-request-derived glob pattern was found. Build configurations and untrusted repository inputs remain a relevant boundary.

**Disposition:** Build/tooling input risk; update all installed copies, including nested 1.x copies.

**Change validation:** Run test discovery, coverage filtering, and server build with normal configured patterns.

### 5. browserslist

**Path:** @babel/helper-compilation-targets 7.29.7 → browserslist 4.28.4; core-js-compat 3.49.0 → same. update-browserslist-db also has a peer edge.

**Observed:** Babel helper-compilation-targets and core-js-compat are direct parents. A malicious browserslist-stats.json can affect an ordinary build call. The separate cache-growth flaw requires many distinct externally influenced queries in one long-lived process; this was not observed in the app.

**Disposition:** The custom-stats advisory has a build-input path. The long-lived query-flood precondition is unproven.

**Change validation:** Run existing Babel/Metro build and compiler checks. Keep untrusted PR builds isolated from credentials.

### 6. fast-xml-parser

**Path:** CLI platform Android → cli-config-android 20.1.0 → parser 4.5.6; CLI platform iOS → cli-platform-apple 20.1.0 → same.

**Observed:** cli-config-android/build/config/getMainActivity.js:30, cli-platform-apple/build/tools/getInfo.js:65, and getBuildConfigurationFromXcScheme.js:43 use XMLParser. The advisory concerns XMLBuilder comment/CDATA serialization. No XMLBuilder caller was found in these parents.

**Disposition:** Affected package version; the vulnerable builder API is not observed. Do not force a major parser override without parent compatibility work.

**Change validation:** Inspect the CLI release diff, run native configuration/autolinking checks, then the iOS build. Android verification is outside this project's scope. The official compatibility table currently lists CLI 20 for RN through 0.85; this app uses 0.86, so the table alone does not prove the update.

### 7. image-size

**Path:** @react-native/metro-config / React Native → metro 0.84.4 → image-size 1.2.1.

**Observed:** metro/src/Assets.js:17 imports the package as a callable default; line 71 calls it on asset bytes. The vulnerable formats are detected from content. Metro’s extension allowlist alone does not prove a renamed hostile image is safe.

**Disposition:** A build asset byte-parsing path exists. Remediation needs compatibility work; exploitability was not reproduced.

**Change validation:** Check v2 module/export and buffer API compatibility, normal image dimensions, and bounded malformed-image fixtures. Run Metro release bundling. Latest Metro is 0.87.1, and its manifest no longer lists image-size. This review has not established a compatible Metro/RN release or replacement parser that closes this exact issue. That route remains unresolved; do not adopt latest Metro just to clear the audit.

### 8. joi

**Path:** cli-config 20.1.0 / cli-types 20.1.0 → joi 17.13.4.

**Observed:** cli-config/build/schema.js:38 uses a static rename from command to name. The reported rename issue needs regex captures, a template target, and multiple:true. The custom-message language-key path was not found in inspected CLI call sites.

**Disposition:** Affected version installed. Both reported special API preconditions are not observed in current callers.

**Change validation:** Run CLI config validation for valid and invalid fixture projects.

### 9. js-yaml

**Path:** load-nyc-config 1.1.0 → yaml 3.14.2; cosmiconfig 9.0.2 → yaml 4.2.0.

**Observed:** @istanbuljs/load-nyc-config/index.js:80 parses YAML files with load(); cosmiconfig/dist/loaders.js:64 also calls load(content). Malformed aliases, merge chains, and ordered maps can consume CPU in these configuration readers. No chat input YAML parsing route was found.

**Disposition:** Build/configuration parse paths exist. Fix both installed major lines; 4.2.0 already fixes only the oldest listed merge-alias issue.

**Change validation:** Run configuration discovery and tests. Include bounded malformed configuration fixtures when applying the fixes.

### 10. nanoid

**Path:** server workflow 4.8.9 → @workflow/core 4.8.9 → nanoid 5.1.6.

**Observed:** @workflow/core/dist/workflow.js:86 uses customRandom(urlAlphabet, 21, callback). workflow/hook.js:27 calls the generator with no size argument. The two advisories require hostile huge or negative sizes. No user-controlled size path was observed. Workflow’s seeded generator is for deterministic hook tokens; this is not evidence about app authentication.

**Disposition:** Production dependency with no matching hostile-size path observed. Its high-severity findings still block acceptance until resolved.

**Change validation:** Use an isolated install, run Workflow hook/replay tests and existing server tests/build after any override. Recheck determinism and persisted-run compatibility.

### 11. qs

**Path:** CLI server API → body-parser 1.20.5 → qs 6.15.3; workflow → CLI/web → express 5.2.1 / body-parser 2.3.0 → same qs.

**Observed:** CLI handlers use JSON parsing. Workflow web/server.js and compiled app create Express handlers; Express defaults to simple query parsing. The inspected parents did not enable comma:true or stringify hostile parsed objects. Current app production routes use Nitro and validated JSON. Workflow’s inspection web server is installed; deployment of that UI was not verified.

**Disposition:** Affected version installed. Both listed option/API combinations are not observed; runtime packaging and deployed inspection surface remain unverified.

**Change validation:** Test query/form limits and confirm the deployed server does not expose an unintended Workflow inspector. A lock refresh for Express alone leaves the CLI copy constrained.

### 12. sharp

**Path:** app react-native-bootsplash 7.3.2 → sharp 0.35.3 → platform libvips/libheif binary.

**Observed:** react-native-bootsplash/dist/module/extras/utils.js:135 opens an image with sharp(filePath). Untrusted image processing can reach libheif. This is generator tooling, not proof that phone-selected chat images reach sharp. Sharp’s advisory reports possible RCE on glibc Linux under stated conditions.

**Disposition:** High-priority untrusted build-image boundary. Both upstream libheif advisories were read; no malicious image was executed.

**Change validation:** After updating, check sharp.versions.heif is at least 1.23.2 for each build platform and run a normal splash-generation fixture. A custom system libheif needs its own verification.

### 13. undici

**Path:** server workflow → @workflow/core → world-local / world-vercel → each nested undici 7.28.0.

**Observed:** world-vercel/dist/http-client.js:3 imports Agent, DecoratorHandler, RetryAgent and creates RetryAgents. RetryAgent and interceptors.retry share RetryHandler, so a name mismatch does not exclude the retry issue. Inspected Workflow code uses fetch for bodies and did not enable cache interceptors, setCookie, or undici WebSocket. App OpenAI sockets use ws (responses.ts:1), not undici WebSocket. Current client delivery is an app-created SSE response (delivery.ts:78), not a direct forwarding of upstream Content-Length.

**Disposition:** Production dependency priority. Four special APIs and the blob-like body path are not observed; the retry handler is used, but the full downstream framing attack chain is unproven.

**Change validation:** Test Workflow request retry/partial-body handling and stream delivery in isolation after an override. Verify no stale upstream framing is forwarded. This review did not exercise the Vercel-managed runtime or platform’s own Node bundled undici.

### 14. uuid

**Path:** Expo config plugins / icons → xcode 3.0.1 → uuid 7.0.3.

**Observed:** xcode/lib/pbxProject.js:90 calls uuid.v4() without an output buffer. The advisory concerns v3/v5/v6 with a supplied undersized buffer. That API path was not found in the inspected parent.

**Disposition:** Affected version installed; reported v3/v5/v6 buffer path is not observed. This is a strong candidate for a precise exception if migration is deferred.

**Change validation:** If migrating, check CommonJS exports and Xcode project generation. Do not override 7→11 merely to silence npm.

## Every advisory in the saved audit

Each source link is the advisory record. Fixed ranges and affected package nodes are retained in the companion JSON. The family table gives the combined minimum fix version.

| #   | Advisory                                                                 | Family                     | Reported severity | Current disposition                                                                                 |
| --- | ------------------------------------------------------------------------ | -------------------------- | ----------------- | --------------------------------------------------------------------------------------------------- |
| 1   | [GHSA-27p8-2357-5qqv](https://github.com/advisories/GHSA-27p8-2357-5qqv) | `@xmldom/xmldom`           | high              | DocType name serialization; no xmldom serializer caller observed.                                   |
| 2   | [GHSA-3px3-54cx-rmw9](https://github.com/advisories/GHSA-3px3-54cx-rmw9) | `@xmldom/xmldom`           | high              | Name/QName creation and serialization; no matching direct DOM construction/serialization observed.  |
| 3   | [GHSA-4w3w-2rp5-g8jm](https://github.com/advisories/GHSA-4w3w-2rp5-g8jm) | `@xmldom/xmldom`           | high              | Attribute-name serialization; no matching serializer caller observed.                               |
| 4   | [GHSA-6gmq-8vp8-gcm6](https://github.com/advisories/GHSA-6gmq-8vp8-gcm6) | `@xmldom/xmldom`           | medium            | EntityReference creation/serialization; no matching caller observed.                                |
| 5   | [GHSA-6h8r-xr42-gp59](https://github.com/advisories/GHSA-6h8r-xr42-gp59) | `@xmldom/xmldom`           | medium            | Malformed XML end-tag parsing; plist parser path exists for build inputs.                           |
| 6   | [GHSA-6mj3-qw4j-hgrw](https://github.com/advisories/GHSA-6mj3-qw4j-hgrw) | `@xmldom/xmldom`           | high              | HTML raw-text parsing; inspected plist callers parse XML, not HTML.                                 |
| 7   | [GHSA-8344-3jmq-59r6](https://github.com/advisories/GHSA-8344-3jmq-59r6) | `@xmldom/xmldom`           | high              | XML attribute deduplication CPU cost; plist parser path exists for build inputs.                    |
| 8   | [GHSA-93r5-fhx6-vmg9](https://github.com/advisories/GHSA-93r5-fhx6-vmg9) | `@xmldom/xmldom`           | high              | Malformed XML recovery CPU cost; plist parser path exists for build inputs.                         |
| 9   | [GHSA-965w-775f-mr7g](https://github.com/advisories/GHSA-965w-775f-mr7g) | `@xmldom/xmldom`           | high              | XML parser memory amplification; plist parser path exists for build inputs.                         |
| 10  | [GHSA-c7q8-3ch8-vqpv](https://github.com/advisories/GHSA-c7q8-3ch8-vqpv) | `@xmldom/xmldom`           | high              | Processing-instruction target serialization; no serializer caller observed.                         |
| 11  | [GHSA-g53g-w8rj-fmg7](https://github.com/advisories/GHSA-g53g-w8rj-fmg7) | `@xmldom/xmldom`           | high              | Processing-instruction regex CPU cost; applies to installed 0.9.10 parser, not 0.8.13.              |
| 12  | [GHSA-vr34-hp96-76pp](https://github.com/advisories/GHSA-vr34-hp96-76pp) | `@xmldom/xmldom`           | high              | DocType ID serializer validation bypass; no serializer caller observed.                             |
| 13  | [GHSA-w2rr-34g9-rvrj](https://github.com/advisories/GHSA-w2rr-34g9-rvrj) | `@xmldom/xmldom`           | high              | Element-name serialization; no matching serializer caller observed.                                 |
| 14  | [GHSA-x4fp-j954-r2f4](https://github.com/advisories/GHSA-x4fp-j954-r2f4) | `@xmldom/xmldom`           | high              | End-tag regex CPU cost; applies to installed 0.8.13 parser, not 0.9.10.                             |
| 15  | [GHSA-w5vr-8v7q-w6rv](https://github.com/advisories/GHSA-w5vr-8v7q-w6rv) | `baseline-browser-mapping` | medium            | Invalid/conflicting API options terminate process; build API path exists, hostile options unproven. |
| 16  | [GHSA-v422-hmwv-36x6](https://github.com/advisories/GHSA-v422-hmwv-36x6) | `body-parser`              | low               | Invalid configured body limit; inspected CLI calls use default options.                             |
| 17  | [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp) | `brace-expansion`          | high              | Exponential brace pattern CPU cost; build/test glob path exists.                                    |
| 18  | [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) | `brace-expansion`          | high              | Unbounded brace expansion output; build/test glob path exists.                                      |
| 19  | [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895) | `brace-expansion`          | high              | Intermediate brace expansion memory; build/test glob path exists; earlier fixes are insufficient.   |
| 20  | [GHSA-73wf-gq98-2v4g](https://github.com/advisories/GHSA-73wf-gq98-2v4g) | `browserslist`             | high              | Poisoned custom-stats file can reach ordinary Babel/Browserslist build call.                        |
| 21  | [GHSA-c83g-rgw3-j3cx](https://github.com/advisories/GHSA-c83g-rgw3-j3cx) | `browserslist`             | high              | Many distinct attacker-influenced queries in a long-lived process; full precondition not observed.  |
| 22  | [GHSA-gh4j-gqv2-49f6](https://github.com/advisories/GHSA-gh4j-gqv2-49f6) | `fast-xml-parser`          | medium            | XMLBuilder CDATA/comment injection; current CLI parents use XMLParser.                              |
| 23  | [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq) | `image-size`               | high              | JXL/HEIF parser loop; Metro calls byte-based image parser on build assets.                          |
| 24  | [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) | `image-size`               | high              | ICNS parser loop; Metro calls byte-based image parser on build assets.                              |
| 25  | [GHSA-6w3j-5fw6-r9vr](https://github.com/advisories/GHSA-6w3j-5fw6-r9vr) | `joi`                      | low               | Hostile custom-message language key; no such CLI schema configuration found.                        |
| 26  | [GHSA-gg4h-3hg2-grpc](https://github.com/advisories/GHSA-gg4h-3hg2-grpc) | `joi`                      | low               | Regex/template rename with multiple:true; inspected CLI rename is static.                           |
| 27  | [GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh) | `js-yaml`                  | high              | Empty YAML merge-source CPU exhaustion; configuration load path exists.                             |
| 28  | [GHSA-52cp-r559-cp3m](https://github.com/advisories/GHSA-52cp-r559-cp3m) | `js-yaml`                  | high              | YAML merge-chain CPU exhaustion; configuration load path exists.                                    |
| 29  | [GHSA-5p4m-2wfm-xmqj](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj) | `js-yaml`                  | high              | YAML ordered-map CPU exhaustion; default-schema configuration load path exists.                     |
| 30  | [GHSA-h67p-54hq-rp68](https://github.com/advisories/GHSA-h67p-54hq-rp68) | `js-yaml`                  | medium            | Repeated YAML merge aliases; installed 3.14.2 affected, 4.2.0 already includes this fix.            |
| 31  | [GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv) | `nanoid`                   | high              | Negative-size non-secure generator; Workflow uses fixed size 21 customRandom.                       |
| 32  | [GHSA-xwg4-73v4-xw9w](https://github.com/advisories/GHSA-xwg4-73v4-xw9w) | `nanoid`                   | high              | Huge-size integer overflow; Workflow supplies fixed 21, not caller size.                            |
| 33  | [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g) | `qs`                       | medium            | Hostile parse-to-stringify object path; not observed in inspected parents.                          |
| 34  | [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx) | `qs`                       | medium            | comma:true bracket-array limit bypass; this option not observed in inspected parents.               |
| 35  | [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c) | `sharp`                    | high              | libheif corruption via crafted image; Bootsplash image-generation byte path exists.                 |
| 36  | [GHSA-3wwx-pv8p-q78v](https://github.com/advisories/GHSA-3wwx-pv8p-q78v) | `undici`                   | medium            | Undici WebSocket decompression; Workflow use not observed; app sockets use ws.                      |
| 37  | [GHSA-4cwx-7wf7-3272](https://github.com/advisories/GHSA-4cwx-7wf7-3272) | `undici`                   | high              | Shared cache/private directive disclosure or crash; cache interceptor use not observed.             |
| 38  | [GHSA-8xcm-r25x-g524](https://github.com/advisories/GHSA-8xcm-r25x-g524) | `undici`                   | medium            | RetryHandler is used. Full stale Content-Length forwarding chain remains unproven.                  |
| 39  | [GHSA-jr45-8vmc-qm54](https://github.com/advisories/GHSA-jr45-8vmc-qm54) | `undici`                   | medium            | Shared cache whitespace directive bypass; cache interceptor use not observed.                       |
| 40  | [GHSA-m8rv-5g2x-5cg5](https://github.com/advisories/GHSA-m8rv-5g2x-5cg5) | `undici`                   | medium            | Duck-typed blob body.type injection; inspected calls use fetch, which advisory excludes.            |
| 41  | [GHSA-v3r7-h72x-cjcm](https://github.com/advisories/GHSA-v3r7-h72x-cjcm) | `undici`                   | medium            | setCookie attribute injection; matching cookie-helper use not observed.                             |
| 42  | [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | `uuid`                     | medium            | v3/v5/v6 undersized output buffer; xcode uses v4() without a buffer.                                |

The sharp record points to [libheif Alpha-plane overflow](https://github.com/strukturag/libheif/security/advisories/GHSA-g89c-p67h-r497) and [derived-item/pixel-plane corruption](https://github.com/strukturag/libheif/security/advisories/GHSA-2jg2-4ch7-h545). Both upstream records were accessible at their repository advisory pages, although the global advisory API returned 404 for those IDs. They are additional upstream records, not two extra npm audit entries.

## All 39 npm package entries

“Direct advisory” names the 14 families above. Other rows inherit a dependency finding. Full exact installed paths and advisory propagation remain in the JSON.

| npm entry                                          | npm severity | Basis                                                                                                                                                                                    |
| -------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@expo/config-plugins`                             | moderate     | Propagated from `xcode`                                                                                                                                                                  |
| `@react-native-community/cli`                      | moderate     | Propagated from `@react-native-community/cli-doctor`                                                                                                                                     |
| `@react-native-community/cli-config-android`       | moderate     | Propagated from `fast-xml-parser`                                                                                                                                                        |
| `@react-native-community/cli-doctor`               | moderate     | Propagated from `@react-native-community/cli-platform-android`, `@react-native-community/cli-platform-apple`, `@react-native-community/cli-platform-ios`                                 |
| `@react-native-community/cli-platform-android`     | moderate     | Propagated from `@react-native-community/cli-config-android`                                                                                                                             |
| `@react-native-community/cli-platform-apple`       | moderate     | Propagated from `fast-xml-parser`                                                                                                                                                        |
| `@react-native-community/cli-platform-ios`         | moderate     | Propagated from `@react-native-community/cli-platform-apple`                                                                                                                             |
| `@react-native-vector-icons/material-design-icons` | moderate     | Propagated from `@expo/config-plugins`                                                                                                                                                   |
| `@workflow/astro`                                  | high         | Propagated from `@workflow/builders`, `@workflow/rollup`, `@workflow/vite`                                                                                                               |
| `@workflow/builders`                               | high         | Propagated from `@workflow/core`                                                                                                                                                         |
| `@workflow/cli`                                    | high         | Propagated from `@workflow/builders`, `@workflow/core`, `@workflow/world-local`, `@workflow/world-vercel`                                                                                |
| `@workflow/core`                                   | high         | Propagated from `@workflow/world-local`, `@workflow/world-vercel`, `nanoid`                                                                                                              |
| `@workflow/nest`                                   | high         | Propagated from `@workflow/builders`                                                                                                                                                     |
| `@workflow/next`                                   | high         | Propagated from `@workflow/builders`, `@workflow/core`                                                                                                                                   |
| `@workflow/nitro`                                  | high         | Propagated from `@workflow/builders`, `@workflow/core`, `@workflow/rollup`, `@workflow/vite`                                                                                             |
| `@workflow/nuxt`                                   | high         | Propagated from `@workflow/nitro`                                                                                                                                                        |
| `@workflow/rollup`                                 | high         | Propagated from `@workflow/builders`                                                                                                                                                     |
| `@workflow/sveltekit`                              | high         | Propagated from `@workflow/builders`, `@workflow/rollup`, `@workflow/vite`                                                                                                               |
| `@workflow/vite`                                   | high         | Propagated from `@workflow/builders`                                                                                                                                                     |
| `@workflow/world-local`                            | moderate     | Propagated from `undici`                                                                                                                                                                 |
| `@workflow/world-vercel`                           | moderate     | Propagated from `undici`                                                                                                                                                                 |
| `@xmldom/xmldom`                                   | high         | Direct advisory                                                                                                                                                                          |
| `baseline-browser-mapping`                         | moderate     | Direct advisory                                                                                                                                                                          |
| `body-parser`                                      | moderate     | Direct advisory; via `qs`                                                                                                                                                                |
| `brace-expansion`                                  | high         | Direct advisory                                                                                                                                                                          |
| `browserslist`                                     | high         | Direct advisory                                                                                                                                                                          |
| `fast-xml-parser`                                  | moderate     | Direct advisory                                                                                                                                                                          |
| `image-size`                                       | high         | Direct advisory                                                                                                                                                                          |
| `joi`                                              | low          | Direct advisory                                                                                                                                                                          |
| `js-yaml`                                          | high         | Direct advisory                                                                                                                                                                          |
| `nanoid`                                           | high         | Direct advisory                                                                                                                                                                          |
| `qs`                                               | moderate     | Direct advisory                                                                                                                                                                          |
| `react-native-bootsplash`                          | moderate     | Propagated from `@expo/config-plugins`                                                                                                                                                   |
| `react-native-enriched-markdown`                   | moderate     | Propagated from `@expo/config-plugins`                                                                                                                                                   |
| `sharp`                                            | high         | Direct advisory                                                                                                                                                                          |
| `undici`                                           | high         | Direct advisory                                                                                                                                                                          |
| `uuid`                                             | moderate     | Direct advisory                                                                                                                                                                          |
| `workflow`                                         | high         | Propagated from `@workflow/astro`, `@workflow/cli`, `@workflow/core`, `@workflow/nest`, `@workflow/next`, `@workflow/nitro`, `@workflow/nuxt`, `@workflow/rollup`, `@workflow/sveltekit` |
| `xcode`                                            | moderate     | Propagated from `uuid`                                                                                                                                                                   |

## Proposed small remediation units

1. **Compatible leaf updates.** Review exact lockfile changes for xmldom, baseline-browser-mapping, body-parser, brace-expansion, browserslist, joi, both js-yaml lines, and sharp. Updating body-parser alone does not fix its constrained qs copy. Keep package families separated enough for review and rollback. Run install/patch integrity, targeted config/asset checks, normal verification, and the relevant builds.

2. **Workflow exact pins.** Propose scoped undici 7.29.1+ and nanoid 5.1.16+ overrides, or use a future upstream release after checking its manifests. These are overrides of upstream tested pins. Require explicit review and Workflow replay/network regression evidence. Do not downgrade Workflow.

3. **qs constrained copy.** Update allowed Express paths normally. Review a narrow override for body-parser 1.x, because even current 1.20.6 retains `~6.15.1`. Confirm parser behavior and normal development-server operations.

4. **CLI/XML parser migration.** CLI 20.2.0 is a candidate parent update that admits fast-xml-parser 5.x. Assess the CLI family as a unit. The [official compatibility guidance](https://github.com/react-native-community/cli#compatibility) warns against independent CLI changes and does not currently list this app’s RN 0.86. Keep the missing native-build evidence visible.

5. **Metro/image-size boundary.** Select an API-compatible parent update or a reviewed minimal backport/adapter. The [v2 release](https://github.com/image-size/image-size/releases/tag/v2.0.0) changes module and file-reading behavior; the installed Metro caller expects a callable default. Do not assume a major override works. This package repository was marked archived on 24 September 2026 when checked.

6. **xcode/uuid.** Prefer a parent-supported migration or small maintained backport. If that is deferred, a narrowly scoped exception can record the actual `v4()` call, absence of the vulnerable buffered v3/v5/v6 path, owner, expiry, and recheck trigger. This report does not grant the exception.

The remaining choices are engineering policy: whether reviewed scoped overrides are allowed, and how to handle a parent without a compatible fixed dependency. A source patch that leaves the high-severity advisory active does not satisfy the gate. Since 3 October 2026 one exception applies ("Unpatched high advisories" above). None of these dependency remedies requires changing product screens. Native builds remain necessary when CLI/native configuration dependencies change.

A complete green audit may require more than lockfile refreshes. Do not disable the audit, lower severities, or classify all build dependencies as harmless to make the gate pass. Advisory data can change after this snapshot.
