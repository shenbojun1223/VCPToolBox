# AICodeWorker stop lifecycle repair

## Scope
- Fatal Codex connection errors close admission and coordinate instance-wide stopping.
- Task ownership is released only after the owned stop operation is confirmed; unresolved validation resources retain their slot.
- Ordinary model capacity/turn failures remain single-task failures.
- Stop failures reject with safe codes and preserve ownership for explicit retry; authenticated shutdown is available for the same verified degraded instance.
- Version-probe completion and main-process tree confirmation are distinct. The Windows fallback force command has a timeout.

## Reproducible verification
Run from the repository root:
    node Plugin/AICodeWorker/test/stop-lifecycle/run.cjs
The tests read the adjacent repository appserver files. OS calls, child processes, IPC, and job metadata writes are mocked.
The 89 Node test results include one wrapper containing 12 recovered Worker scenarios; do not add those counts together.

## Deployment and limitations
These files do not hot-replace modules inside an existing sidecar. Verify a controlled restart and a harmless live job separately before claiming runtime acceptance.
An accepted shutdown request is not evidence that all processes have exited.
Strict tree confirmation is supplied by the existing Windows helper. A previously exited main root, missing identity, or unsupported platform retains ownership and rejects; this change does not supply a universal process-tree tracker.
The existing helper confirmation is not an independent census of every descendant. Validation children and uncertain finalization can keep shutdown unresolved; preserve evidence and do not free those slots by force.
The JSONL frame limit remains 1 MiB. This repair does not increase model capacity or guarantee completion within any reasoning time budget.
The source configuration, authentication files and plugin manifest are not changed by this repair.

## Recovery
Original files, candidate hashes, verification logs and application records are retained in the task-specific review directory recorded in the delivery receipt.
Compare hashes and subsequent edits before restoring an original file. Never delete the only copy of a candidate or an unrelated task change.
