# Filtered VCPToolBox update candidate

## Revisions and scope

- Personal main / candidate parent: `39e0b035b3c7f42abe944ac6906af91fb54ca5f4`
- Official base: `afa5ee82bd2dd183e7900529919475d2dc739d06`
- Official target: `3b227adf8e183b58ea7bdf54af5b9362d6db7578`
- Applied the exact 54-path allowlist from the task out of 364 changed official paths; 310 excluded paths were not applied. The existing personal `update.bat`, `update_with_no_dependency.bat`, `AdminPanel-Vue/dist`, settings, data and credentials remain unchanged.
- Two allowlisted overlaps were merged: `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js` and `adminServer.js`. No blanket file replacement was used. The candidate remains on its original parent; no commit, reset, fetch, push or deployment was performed.

## Overlap resolution and safety adaptations

- `RAGDiaryPlugin.js` combines upstream green-lane/JEV modifier and rerank changes with personal group presentation ordering, per-carrier presentation context over shared request-cache Maps, cache-hit/miss ordering, Gravity vector handoff and detached embedding provenance, `Promise<vector>` compatibility, raw/River cache guards, and strict KNN fallback behavior.
- `adminServer.js` retains personal request diagnostics, CPU sampling and proxy instrumentation, while integrating the upstream AgentAssistant route correction and safe missing-asset response.
- `update.sh` no longer checks out `AdminPanel-Vue/dist`; its ineffective HUP trap was corrected. The Windows starter only performs the read-only ensure check and does not trigger installs/builds.
- `scripts/ensure_admin_panel.js` is read-only by default and in `--check-only`, rejects asset paths outside `dist`, and only builds on explicit `--build`. Explicit builds have a timeout and do not install dependencies. The build uses `build:no-type-check`, which is not full TypeScript validation.
- New `modules/adminPanelBootstrap.js` gates missing-asset auto-build behind `VCP_ADMIN_PANEL_AUTO_BUILD=1`, tracks a single bounded child, drains bounded output, and does not expose raw stderr. Failure is terminal for the process lifetime, so refreshes do not create a retry loop.
- Three existing regression fixtures were narrowly updated: two now provide the production `process.env` global to extracted VM code; the group-order handoff test now extracts the refactored `systemMessageTasks` block. Assertions remain intact.
- Added `tests/adminPanelStartupSafety.test.js` and `tests/helpers/prototypeOnlyLoader.cjs` for synthetic safety checks and singleton-free/offline test loading.

## Verification

All Node tests used a sanitized environment. The prototype loader disables network calls and exports plugin prototypes without constructing resident singletons.

| Command / check | Result |
|---|---|
| `node --require=./tests/helpers/prototypeOnlyLoader.cjs --test tests/textChunker.test.js tests/roleDividerToolResults.test.js tests/jevClient.test.js tests/nativeParallelRerank.test.js tests/nativeGreenLane.test.js tests/ragGreenLane.test.js tests/ragJevModifiers.test.js tests/memoSingleTrack.test.js tests/tdbNativeAcceptance.test.js tests/tdbRetrievalQuality.test.js` | Exit 0; 60 tests, 58 passed, 2 skipped. Windows native API smoke used a temporary database and local fixtures. |
| `node --require=./tests/helpers/prototypeOnlyLoader.cjs --test tests/ragGroupPresentationOrder.test.js tests/ragGroupPresentationOrderSwitch.test.js tests/gravityRagVectorHandoff.test.js tests/gravitySpaceContract.test.js tests/embeddingCachedProvenance.test.js tests/embeddingCacheMetadata.test.js tests/embeddingGenerationMetadata.test.js tests/embeddingResponseBinding.test.js tests/embeddingResultMetadata.test.js tests/diagnostics.test.js tests/serverGracefulShutdown.test.cjs tests/jevToolCallExp.test.js tests/agentAssistantFlowlockProtocol.test.js` | Exit 0; 140/140 passed. |
| `node --test tests/adminPanelStartupSafety.test.js` | Exit 0; 6/6 passed. |
| Targeted rerun of `ragGroupPresentationOrder.test.js`, `embeddingResponseBinding.test.js`, `embeddingResultMetadata.test.js` | Exit 0; 30/30 passed. |
| `node scripts/ensure_admin_panel.js --check-only` | Exit 1, correctly reported source newer than retained `dist`; read-only. No build or artifact regeneration. |
| JavaScript syntax check over 28 changed/new `.js`/`.cjs` files | Exit 0; 28/28 passed. |
| Vue SFC parse, script, template and style compile; TypeScript syntax transpile for `diarySyntaxParser.ts` and `diarySyntaxRetirement.test.ts` | Exit 0; zero syntax/compiler errors. This is not semantic type checking. |
| `node --require=./tests/helpers/prototypeOnlyLoader.cjs --test tests/usage-monitor.test.js` | Exit 1 before tests: shared Express dependency tree is missing `proxy-addr`. No dependency was installed. |
| `node --require=./tests/helpers/prototypeOnlyLoader.cjs --test tests/tdbNativeAcceptance.test.js tests/tdbRetrievalQuality.test.js` | Exit 0; both tests skipped because `rust-vexus-lite/target/tdb-validation/vexus-lite.win32-x64-msvc.node` is absent. |
| `git diff --check HEAD` | Exit 2 because Git treats preserved CRLF terminators in `TextChunker.js` and `package.json` as trailing whitespace. `git -c core.whitespace=cr-at-eol diff --check HEAD` exits 0; no repository config was changed. |

Vitest and `vue-tsc` are missing from the available frontend dependencies, so the diary Vitest, semantic Vue type check and full Vite build were not run. The Vite build was not run to preserve `AdminPanel-Vue/dist`. `cargo` and `rustc` are unavailable; Rust compilation and Linux native execution were not claimed. Upstream `.node`/`.exe` hashes matching Git blobs establish byte provenance, not a local reproducible build.

## SHA-256 and official blob comparison

Every file below was hashed from the candidate and compared byte-for-byte with the official target blob; all comparisons matched.

| File | SHA-256 |
|---|---|
| `rust-vexus-lite/index.d.ts` | `7b14f95cbf51558d480917d76e6cb4b3ce76cf0438dc658300b5a37e7c6c69e6` |
| `rust-vexus-lite/Cargo.toml` | `e0adb4748646b8a16429995a91f307b56bef93658fced52311f431edff9476e9` |
| `rust-vexus-lite/Cargo.lock` | `7b5659f8f42df5a7d4d3194c429043571a8518f539ae89d517aca2e187a9aef9` |
| `rust-vexus-lite/src/knowledge_runtime.rs` | `4cde577b9029b4894885f0c4a8f5cedfc7ce09a3b7c6eb7f73b7d0f77f9ba506` |
| `rust-vexus-lite/src/lib.rs` | `4ea584ca515a673b3fb4aa09d52a6c1f035426f2f34b22caea9871942095975b` |
| `rust-vexus-lite/src/memo_artifact_builder.rs` | `32b64316a22fa23fd8b9f724a0e72efc8de453b91201ff0ff4e0bdd248132c26` |
| `rust-vexus-lite/src/memo_geometry.rs` | `4395901874292f800f1c9d1a18dfe0c3725f57ba2d6732645e12b02358f1d694` |
| `rust-vexus-lite/src/memo_pipeline.rs` | `40ed426aafb3783930233167be9961c2602e9ab2cf05ad6473a6d86b0d8d2bbb` |
| `rust-vexus-lite/src/memo_sensing.rs` | `637ef3cf11f966052a083fe4aec6551a8f65b4b6cc29f9205a5abf6c1e4241cc` |
| `rust-vexus-lite/src/memo_workspace.rs` | `312ad2f81e98de76cbaf8367a12a25f40ae99fb55a6d9f6e0be345129b073284` |
| `rust-vexus-lite/src/memo_workspace_build_tests.rs` | `3d0fba38e2b0ee6ef0332fea7ee43a9596cd5386d751d6566b6774e7fe00e374` |
| `rust-vexus-lite/src/native_rerank.rs` | `ff111b22e1fff088968639379c15c69007b20c89c07ad7a458aaaa66f0f6d378` |
| `rust-vexus-lite/src/rivermemo_topology_v3.rs` | `67c44eb932c09fcedd964b06c31669a8e199f4621fe886de13865529572fcb65` |
| `rust-vexus-lite/src/schema.rs` | `1fbcd8aa392cc7656580279f311dc080c59bb79a49187cb3b4f9ef6e453be5aa` |
| `rust-vexus-lite/src/storage.rs` | `c7e78f8891afc8b85632f0009f14e49803604540acf616670dd5260745b7d6b1` |
| `rust-vexus-lite/src/task_lifecycle.rs` | `43ce80ee12d00ba73a377741cdf76c99d65a477bea9171737eb500df65f63605` |
| `rust-vexus-lite/vexus-lite.linux-x64-gnu.node` | `4e75da75de414a0f392d1f417bf629bdc8c4232e28556491ed925a07b59c6f13` |
| `rust-vexus-lite/vexus-lite.win32-x64-msvc.node` | `db5cdfbd655b79cac65956c5142faa1214a009c5cdc9bf1c017dd40936d03ada` |
| `Plugin/DailyNoteSearcher/DailyNoteSearcher-x86_64-pc-windows-msvc.exe` | `f53e8364f744571ca1f8ea8ef3dc9dac6c745d47b33b8f23a0ad0a31d0377393` |
| `Plugin/DailyNoteSearcher/DailyNoteSearcher.exe` | `f53e8364f744571ca1f8ea8ef3dc9dac6c745d47b33b8f23a0ad0a31d0377393` |


## Independent recovery review — 2026-10-24

This snapshot is a preservation/review commit, NOT an approved deployment candidate.
The original Worker job failed at candidate creation with WORKTREE_CANDIDATE_STAGED_INPUT:
three-way application left two staged files, while its finalizer requires an empty index.
All 61 final working files were backed up and copied byte-for-byte to a separate Git root;
the original Worker HEAD, staged index, working files and lock were not modified.
Only this report was then supplemented. The original failed job is not reclassified as successful.

Independent rerun: personal regressions 140/140, official regressions 58 passed plus 2 TDB
skips, startup safety 6/6, all exit 0. The 20 source/artifact hash comparisons matched
the pinned official target. The usage-monitor dependency blocker subsequently cleared:
with real available dependencies and outbound network denied, usage tests passed 9/9,
exit 0. Thus 213 distinct tests passed across these groups, not counting repeat runs.
The earlier dependency failure remains historical evidence, not a current blocker.
TS syntax and Vue SFC compilation were independently repeated successfully. Vitest,
vue-tsc, complete Vite build, Cargo compilation and Linux native execution remain unverified.
The two TDB tests still require a suitable explicitly identified validation binding.

**New independently reproduced blockers, not covered by the six existing safety tests:**
1. verifyDistIntegrity accepts a dist/assets directory junction resolving outside dist.
   Each file is checked against realAssets, but realAssets itself is not checked against
   realDist. A synthetic Windows junction returned ok:true for this escaping case.
2. A build controller whose timeout fired and whose child.kill() returned false (no close
   event) changes from failed to ready when only index.html appears and startIfEnabled is
   called again. This is a false readiness report; an index file alone is not verified output.
3. Related implementation review concern (not a live-process reproduction): timing out the
   wrapper kills only its direct child, with no proven npm/shell/Vite descendant cleanup.
   Lifecycle completion must not be inferred from kill() or a timer alone.

The first two are confirmed synthetic counterexamples; no actual build, provider request,
service startup, production file change or application restart was involved. Preserve the
default-off automatic build and read-only --check-only contract while correcting these issues.
Do not clear them by weakening the assertions or calling this snapshot deployment-ready.

Evidence outside the repository:
- recovery-snapshot-1792813453851.json
- independent-review-bounded-1792812793202.json
- recovered-validation-T12xzT/result.json
- additional-safety-review-AWmzCd/result.json and frontend-syntax.json
under C:/VCP/ClaudeBridge/operations/toolbox-upstream-3b227adf-20261024.

## Admin startup-safety repair supplement — 2026-10-24

The blockers above describe the earlier preservation snapshot. On clean parent
`3f4af2b368268fead7a25f011abc5bcd4e24a6fa`, this isolated candidate now retains the
canonical `dist/assets` containment check and completes the Admin readiness chain:

- The controller requires a complete output validator at initialization and after a
  controller-owned build. A build becomes ready only after child `close` code 0 and valid
  assets. Timeout, spawn/build error, invalid PID, missing/escaping output and late callbacks
  remain terminal; cleanup status is tracked separately from kill requests. Browser text is
  fixed and captured output remains bounded.
- The same readiness middleware gates both `/AdminPanel` and `/AdminPanelLegacy` static
  mounts. Placeholder redirects consult the controller instead of checking `index.html`.
  Startup/check-only remain read-only; automatic builds remain opt-in and package installation
  is not part of the explicit build command.
- The explicit helper now runs asynchronously and accepts cooperative controller cancellation.
  POSIX cleanup signals only the detached process group created for this operation, escalates
  within deadlines, and confirms absence only after child close plus an `ESRCH` group probe.
  `EPERM` and unexpected probe errors fail closed. Windows uses owned-PID `taskkill /T` as a
  termination request, but this implementation has no independent descendant-absence proof
  (such as a Job Object); cleanup is reported `unconfirmed` and cannot establish readiness.
  This limitation does not disable normal successful builds.

Verification for this candidate:

- `node --test --test-reporter=tap tests/adminPanelStartupSafety.test.js`: exit 0; 21 tests,
  20 passed, 1 skipped because this host disallows creating the individual file symlink. All
  process-tree and lifecycle cases use fake child processes; no OS process-tree cleanup probe
  or real build was run.
- `node --require=./tests/helpers/prototypeOnlyLoader.cjs --test tests/diagnostics.test.js tests/serverGracefulShutdown.test.cjs tests/ragGroupPresentationOrder.test.js tests/gravityRagVectorHandoff.test.js tests/jevToolCallExp.test.js`:
  exit 0; 65/65 passed with sanitized environment and the loopback-only network deny preload.
  The prototype loader avoids resident plugin/KB initialization; this is not full application
  initialization validation.
- `node --test --test-reporter=tap tests/usage-monitor.test.js`: blocked before test loading
  (0 tests) because `proxy-addr` under the available `NODE_PATH` dependency tree is not
  readable in this workspace. No dependency was installed.
- `node --check` on the six modified/new JavaScript files: 6/6 passed. `git -c
  core.whitespace=cr-at-eol diff --check`: passed.

This remains an unstaged candidate on the stated parent; no mainline or production update was
made. Earlier TDB binding, Cargo/Rust compilation, Linux native execution, full Vite build and
full frontend type/build validation gaps remain open. Process-tree behavior was verified with
mocks only; Linux OS behavior is not claimed.

## R3 continuation — nested process-group cleanup receipt — 2026-10-24

This section records the narrow continuation on clean parent `42dfe522480f8a75470c47405846a040256b016c`.
It supplements the preceding repair record; historical snapshot and validation facts above were
not rewritten. The canonical asset containment, terminal readiness and Admin HTTP gate changes
from this parent remain present.

- The controller now creates a per-invocation UUID and accepts only one fixed-schema v1 terminal
  receipt correlated to that UUID. The helper reports `work` (`started` / `not_started`), terminal
  `outcome`, and inner `cleanup` (`confirmed` / `unconfirmed` / `not_required`) over the existing
  private IPC channel. The receipt contains no logs, paths, credentials or arbitrary error text.
- Controller cleanup is confirmed only after the owned helper close/process-group evidence and
  a valid same-invocation inner receipt compose. Started work requires inner `confirmed`; explicit
  helper lifecycle evidence is required for a no-build case. Missing, malformed, stale, duplicate,
  late or contradictory receipts, IPC send/disconnect faults, premature helper exit, and inner
  cleanup failure stay unconfirmed. Failure remains terminal and cannot become ready later.
- A successful build still needs helper close code 0 and complete asset validation, plus a valid
  completed receipt. Cancellation and build errors stay failed. POSIX targets remain limited to
  each detached group created for the operation. Windows `taskkill /T` and parent close remain
  insufficient descendant evidence, so cleanup remains unconfirmed without an independent proof.
- Default POSIX inner cleanup is derived as 1,200 ms TERM grace + 3,000 ms force wait = 4,200 ms.
  The cooperative controller wait adds 250 ms cancel-send completion, 250 ms receipt delivery,
  and 500 ms helper reap allowance = 5,200 ms; bounded outer fallback adds at most 4,200 ms,
  for 9,400 ms total after cancellation. Windows process-tree allowance is 11,200 ms per tree
  (two 2,500 ms taskkill attempts with two 500 ms helper-close waits each, plus 1,200 ms TERM and
  3,000 ms force waits); cooperative wait is 12,200 ms and outer fallback 11,200 ms. Windows
  remains unconfirmed without independent descendant evidence.

Verification on this controlled workspace used synthetic fixtures, a sanitized test environment,
`NODE_PATH=C:/VCP/VCPToolBox/node_modules` for dependencies only, and outbound-network denial:

| Command / check | Result |
|---|---|
| `node --require=./tests/helpers/outboundNetworkDeny.cjs --test --test-reporter=tap tests/adminPanelStartupSafety.test.js` | Exit 0; 37 passed, 1 skipped, 0 failed. The skip is the existing symlink fixture because this host disallows creating a file symlink. Linked fake IPC endpoints run the actual exported helper and controller together. The exact two-group negative case observes group A force-terminated while group B is still alive, with no receipt; status stays failed/unconfirmed and never ready. The positive case delays inner cleanup within budget, sends a valid same-invocation receipt, then closes/reaps the helper; cleanup confirms while the timed-out request remains failed. No OS child-process tree was created. |
| `node --require=./tests/helpers/outboundNetworkDeny.cjs --test --test-reporter=tap tests/usage-monitor.test.js` | Exit 1 before test loading; 0 tests. The available Express dependency cannot resolve `proxy-addr` from the permitted dependency path. No package was installed. This differs from the earlier independent run's 9/9 result and remains a current validation blocker for this workspace. |
| `node --require=./tests/helpers/outboundNetworkDeny.cjs --require=./tests/helpers/prototypeOnlyLoader.cjs --test tests/diagnostics.test.js tests/serverGracefulShutdown.test.cjs tests/ragGroupPresentationOrder.test.js tests/gravityRagVectorHandoff.test.js tests/jevToolCallExp.test.js` | Exit 0; 65/65 passed. Prototype loading avoids resident KB/plugin singleton initialization; this is not full application initialization. |
| `node --check` for `modules/adminPanelBootstrap.js`, `modules/adminPanelProcessTree.js`, `modules/adminPanelBuildProtocol.js`, `scripts/ensure_admin_panel.js` and `tests/adminPanelStartupSafety.test.js` | Exit 0 for all five files. |
| `git -c core.whitespace=cr-at-eol diff --check` | Exit 0. |

The process-group protocol and timeout behavior were tested with linked mocks only; Linux OS cleanup
is not claimed. The current working tree remains unstaged on the stated parent with an empty index;
no mainline commit, push, merge or deployment was made. TDB binding, Cargo/Rust compilation, Linux
native execution, full Vite build and full frontend type/build validation remain open. Because the
required usage-monitor command could not load its dependency in this workspace, this candidate is
not deployment-ready pending that validation environment blocker being resolved.

## Final independent source-integration acceptance — 2026-10-24

This section supersedes historical validation-status statements above, not their recorded results.
The reviewed candidate is `cc846186f7c8957b476e49ac18e2b10d8740940e`, based on personal main
`39e0b035b3c7f42abe944ac6906af91fb54ca5f4`. The official target remains pinned to
`3b227adf8e183b58ea7bdf54af5b9362d6db7578`; this is not a claim that later upstream commits
were fetched or integrated.

Disposition: approved for a single-parent, filtered local-mainline source integration with the
known limitations below. This is NOT all-green validation or production deployment acceptance.
The delivery tree reproduces all 64 candidate path changes; only this final report is added to
the candidate content. Worker intermediate commits are preserved separately, not merged as
the mainline delivery history. The 310 excluded official paths remain excluded. Agent prompts,
operator configuration, credentials, runtime data, existing production dist, and newer personal
Forge/shutdown deliveries are not replaced.

### Independent results

- Four regression groups, each exit 0: usage-monitor 9/9; startup safety 38/38;
  official features 58 passed and 2 skipped; personal features 140/140.
  Total: 247 registered tests, 245 passed, 2 skipped, 0 failed/cancelled.
  The former proxy-addr loading blocker did not recur in this independent environment.
- An isolated copy of tracked AdminPanel-Vue inputs used the unchanged dependency lock.
  `npm ci --ignore-scripts --no-audit --no-fund --prefer-offline` completed with exit 0.
  No global tools, production dependencies or configuration were changed.
- Complete `vue-tsc --noEmit` exited 0. `vite build` exited 0, and the built dist passed the
  candidate's `verifyDistIntegrity`. These generated assets remain outside the delivery tree.
  Bundle warnings remain informational; this is not a browser/UI acceptance run.
- Vitest is NOT green: the candidate reported 47 passed / 16 failed and three collection
  failures. A same-dependency, same-network-policy comparison against personal main reported
  37 passed / the same 16 failed and the same three collection failures. The exact failed-test
  and failed-collection sets match. The candidate adds ten passing tests; its changed diary
  syntax suite passed 18/18. This supports no additional failures in the executed comparison,
  not absence of all possible runtime regressions.
- The first Vitest run also reported an unhandled rejection from the existing missing
  copyToClipboard mock. The JSON comparison reporter did not expose unhandled-error counts,
  so equality of unhandled-error behavior is NOT claimed. Existing missing pointerDomTestUtils,
  stale mocks/contracts and other assertion failures remain follow-up work, not skipped tests.
- The official Windows prebuilt binding was explicitly capability-checked and exposes
  index.tdb-vec.v1 and index.cosine-score.v1. With TDB_NATIVE_BINDING set to that immutable
  candidate file, `tests/tdbNativeAcceptance.test.js` exited 0; all eight delegated acceptance
  entry points passed using temporary databases. Nested TAP counts are not added to the
  four-group total above.
- TDB retrieval-quality migration comparison was NOT run: the preserved 39e0b035 binding
  already exposes TDB, not USearch. It cannot serve as a valid USearch comparison baseline.
  No fake baseline, capability override, assertion relaxation or production DB was used.
- All 19 changed rust-vexus-lite source/artifact paths matched the pinned official Git blobs
  byte-for-byte. This establishes upstream provenance, not a reproducible local Rust build.
  Candidate HEAD and tracked/untracked status remained unchanged through the validation.

### Outstanding deployment boundaries

Cargo/rustc are absent, so local Rust recompilation was not performed. Linux native execution and
real OS process-tree cleanup were not performed; the available remote Linux account has no Node
runtime. Startup cancellation behavior is backed by linked IPC/process mocks, not OS-level proof.
Windows taskkill remains insufficient for descendant verification and therefore reports
unconfirmed where independent evidence is absent. Automatic Admin building remains default-off.

No new claim of production readiness follows from source integration. Before any runtime rollout:
preserve real settings and data, resolve or explicitly disposition the existing frontend failures,
choose the verified build artifacts, and execute platform-specific process/functional acceptance.
No service restart, live database migration, runtime worktree switch or Git push is authorized by
this source-integration closeout.

### Evidence retained outside Git

Under `C:/VCP/ClaudeBridge/operations/toolbox-upstream-3b227adf-20261024/`:
- `independent-closeout-WzzW4s/result.json`: four regression groups and counts.
- `final-acceptance-ZPgMTw/result.json`: dependency installation, full type check, build and
  native acceptance; adjacent stdout/stderr preserve individual results.
- `frontend-ab-JUO2gk/result.json`: baseline/candidate failure-set comparison.
- `publication-preparation.json`: exact scope, source projection and runtime protection hashes.

The local-mainline commit/ref-update outcome is recorded separately after Git readback; preparing
this report does not by itself establish that the branch was advanced.
