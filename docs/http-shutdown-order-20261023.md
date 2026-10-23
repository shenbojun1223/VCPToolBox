# HTTP shutdown ordering repair — 2026-10-23

## Defect and repair
The previous Phase 2 awaited server.close() completion before reaching the request-drain
and abort phases. A hanging HTTP connection could prevent plugin shutdown and final
Forge checkpoints until the global shutdown timer forced process exit.

Initiate listener closure without awaiting connection completion. Drain both chat and
HTTP request tracking with existing bounded waits; abort remaining chat requests.
After WebSocket shutdown, register socket close listeners before destroying residual
connections, wait for socket closure and HTTP server closure, then tear down plugins.
The global shutdown timeout remains in place.

## Validation scope
tests/serverGracefulShutdown.test.cjs extracts the actual shutdown functions and uses
real loopback HTTP, mocked plugin teardown and accelerated lifecycle timers.
Five cases cover natural chat/non-chat completion, hanging chat/non-chat streams,
and repeated shutdown requests. This is not a full-server test suite.

The deployed server.js SHA256 is
f3fd8c274d7f82a2842f76fc7e3d9725ac6843ad9457e747e1c37e12e2d664dd.
Production validation used two restart stages: load the new implementation, then
execute its shutdown path. HTTP-close, plugin-shutdown and final exit markers were
observed without the global forced-exit timeout; application exit code was not
captured by a parent process and must not be called application exit 0.

## Forge pilot verification
The initial server-to-company attempt forced exit and did NOT perform normal handoff.
Keep that failure evidence. Company recovered the last published revision 47 and
automatically published 48, with normalized metadata, file bytes and snapshots intact.
Ordinary company Forge editing published 49; normal company exit published final 50.
Server resumed its original project/directory and published 51 with fence 20.
After this repair, normal server shutdown published final 52 and company resumed its
original project/directory with fence 21 and published 53. The final handoff task
exited 0, verified plugin cleanup and observed no global forced-exit timeout.
Six historical nodes, three Todos, six snapshots (209 bytes), original local IDs
and directory identity were preserved. No manual lease or publication operations.

At verification end, company holds the pilot; server auto-resume is intentionally
paused. Do not restart old maintenance jobs or assume arbitrary projects are enabled.
Credentials, databases, machine configuration and maintenance runners are excluded.

## Evidence (machine-local, not repository deliverables)
- C:/VCP/ClaudeBridge/operations/shutdown-close-events-pdVWok
- C:/VCP/ClaudeBridge/operations/shutdown-order-deploy-20261023
- C:/VCP/ForgeHub/private/company-takeover-20261023/normal-return-to-company
- D:/VCP/Private/ForgeTakeover-company-20261023/company-return
- D:/VCP/Private/ForgeTakeover-company-20261023/normal-return-company-verified.json

This three-file delivery is based on personal/main 5b1e1eff98867c97bb72305197345d56b26e7ec8.
It does not include unrelated staged Forge files or other production worktree changes.
