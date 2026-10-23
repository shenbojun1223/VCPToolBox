# Filtered mainline integration — 2026-10-23

## Source and policy
- Parent: 46f243108971b5fd1650660de34d606ca0a8ec7e.
- Reviewed integration source: c0bcdc6d94e3c9b091a518142c5bdc050fabac5b; common base 3207a427f027f2fcaa1760e967664173c2878ffa.
- This is a **single-parent filtered projection**, not a merge of the complete source history.
- 297 path-level changes were admitted. Git rename detection may report fewer file entries.
- Agent/TVStxt/AGENTS prompts, ToolConfigs, operator/config/example files, rag_params.json,
  ecosystem.config.js, ignore/attribute changes and AdminPanel-Vue generated assets are excluded.
- Dependency manifests/lockfiles, plugin API manifests, Rust toolchain declarations and paired native
  bindings are retained as source/build contracts, not personal operational configuration.
- Newer ServerProjectForge files/tests and HTTP graceful-shutdown delivery remain identical to parent.
- modules/jevToolCallExp.js combines the reviewed integration with the existing mainline handoff feature.
- Existing parent history is not rewritten. This commit does not delete prompt/config changes already
  committed by other authors.

## Verification
Selected offline node:test regressions: 216 tests passed after one test-fixture correction, with no
skipped/cancelled tests in those runs. A separate native runtime registration script also passed.
The original first pass was 208/216: eight desktop planner tests depended on deployment-local
configuration that was intentionally excluded. Those eight now use a fresh synthetic planner
declaration; original behavior assertions are unchanged and the rerun is 8/8.
This verifies planner code, NOT that a fresh checkout has the private desktop tool declaration.
Existing deployed tool declarations must be retained separately.

The selected set covers native lifecycle/drain/backpressure, offline write safety, legacy dimensions,
OpenCode session behavior, protocol bridges, Tavern completion, upstream errors, distributed routing,
JEV planning, HTTP shutdown, roll-keeper and native runtime registration.
It is not a full repository suite or production migration acceptance.
Admin frontend build was NOT completed: cached dependency installation lacked packages, and the
subsequent isolated installation timed out/failed. No generated dist is included.

Credential-pattern scan of admitted text sources had zero findings. Ten inherited whitespace
warnings were checked against the prior integration Git blobs; affected staged files are byte-identical
to that source, except the independently documented JEV merge/test-fixture work in other files.
No mass formatting was performed.

## Safety and follow-up
The live worktree remains on work/forge-multiend-20261018; its HEAD/index and protected files were
verified unchanged before this commit. No production service restart, knowledge-base migration,
Git push, history rewrite, stash cleanup or worktree removal is part of this delivery.
FileOperator's user-approved one-directory allowlist addition is operational configuration and is
NOT in this commit.
The old integration handoff remains historical context; its full-input/deployment claims do not
override this filtered commit's scope.
Audit receipts are outside the repository under:
C:/VCP/ClaudeBridge/operations/zanni-mainline-20261023.
