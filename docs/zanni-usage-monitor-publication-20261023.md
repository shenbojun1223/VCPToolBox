# Usage monitor source publication — 2026-10-23

This commit publishes the reviewed backend and Admin dashboard implementation from the live source
snapshot. Runtime source content is equivalent to that snapshot modulo the isolated tree's existing
line endings; only documentation was corrected to describe the actual CPAMP live-query and optional
Claude Bridge quota behavior. No live runtime file was edited by this publication.

## Included
- modules/usageMonitor/index.js; routes/admin/newapiMonitor.js
- tests/usage-monitor.test.js; docs/usage-monitor.md
- AdminPanel-Vue/src/api/newapi-monitor.ts
- AdminPanel-Vue/src/components/dashboard/NewApiMonitorCard.vue
- AdminPanel-Vue/src/components/dashboard/contrib/_sdk.ts
- AdminPanel-Vue/src/composables/useDashboardState.ts
- AdminPanel-Vue/src/dashboard/core/builtinCards.ts

## Verification
- node --test --test-concurrency=1 --test-reporter=tap tests/usage-monitor.test.js:
  exit 0, 9/9 passed, no skips or cancellations. HTTP providers are synthetic transports.
- node --check for the monitor module and admin route: exit 0.
- Four changed TypeScript files: transpilation syntax checks passed.
- NewApiMonitorCard.vue: Vue SFC parse, compileScript, script transpilation and template compilation
  passed using the locally available TypeScript 5.9.3 / Vue compiler 3.5.41.
- These frontend checks are NOT full vue-tsc type checking, Vitest, or a Vite production build.
  Full frontend validation remains blocked by the incomplete isolated dependency installation.
  No dist or partial node_modules files are committed.
- No production HTTP requests, provider refresh, service restart, deployment or push occurred.

## Exclusions and dependencies
Agent prompts, TVStxt/ToolConfigs, .env files, operator configuration, account mapping, encrypted
credentials, configuration templates and temporary index(1).js copies are excluded.
The current runtime configuration must be retained separately.
The optional Claude quota provider needs the independently deployed Bridge /v1/quota endpoint.
The VCPChat sidebar lives in a separate client repository and is not part of this backend commit;
do not report this commit as a completed client publication.

Review evidence and frozen source hashes:
C:/VCP/ClaudeBridge/operations/zanni-mainline-20261023.
