# Release validation harnesses

These scripts are deliberately separated by proof boundary. Passing one must not be reported as passing another.

## 1. Real Claude Code CLI smoke

```powershell
node scripts/real-claude-smoke/run.mjs --report release-validation/real-cli.json
```

The script checks `claude auth status`, but retains only `loggedIn`, `authMethod`, and `apiProvider`; raw auth output is discarded. It creates a repository with `fs.mkdtempSync(path.join(os.tmpdir(), ...))`, makes one baseline commit, and sends the real request:

> 增加一个数学计算模块，并添加完整测试。

Claude runs in safe mode, without session persistence, with `manual` permission mode and an explicit tool allowlist. The harness rejects any CLI argument containing `bypassPermissions` or `dangerously-skip-permissions`. It then independently verifies:

- exactly `src/math.js` and `test/math.test.js` changed;
- the four exported operations behave correctly and division by zero throws `RangeError`;
- `npm test` passes;
- Git contains a real diff and Claude did not commit it.

This proves the real CLI transport, real writes, tests, and Git diff in a disposable project. It does **not** prove the Workbench renderer, `PermissionBroker`, Planner/Coder/Tester/Reviewer transitions, checkpoints, recovery, or commit preview. Those require the production Electron workflow acceptance.

Useful options:

```powershell
node scripts/real-claude-smoke/run.mjs --timeout-ms 900000 --keep-temp
node scripts/real-claude-smoke/run.mjs --claude-path C:\path\to\claude.exe
```

`--keep-temp` is diagnostic-only. Without it, cleanup validates that the target is a child of the operating-system temp directory before recursively removing it.

## 2. Electron stability soak

Build first, then run the default 30-minute soak:

```powershell
npm run build
node scripts/real-claude-smoke/stability.mjs --report release-validation/stability-30m.json
```

The production Electron build starts with isolated Workbench and Chromium data. By default it continuously creates real Workbench sessions and runs deterministic `FORCE_FAKE=1` Agent Tasks through the production preload/IPC, `TaskManager`, checkpoint, event, and SQLite paths. This produces sustained lifecycle load without spending model tokens; it is not real-model evidence. Use `--idle` only for an idle baseline. The script samples:

- aggregate main/renderer/utility-process RSS, process count, and OS handle count;
- renderer JavaScript heap, DOM nodes, documents, and JavaScript event listeners through CDP;
- SQLite database/WAL/SHM size, event count, and task count;
- log directory size;
- child process identities and post-shutdown orphans.

It closes the window, gives the process time to exit, then uses a forceful process-tree stop only if required. PID plus process creation time prevents PID reuse from being misreported as an orphan.

A short run validates harness mechanics only:

```powershell
node scripts/real-claude-smoke/stability.mjs --duration-ms 15000 --sample-ms 1000 --report release-validation/stability-mechanics.json
```

The workload cadence defaults to one task per second and can be changed with `--task-interval-ms`. Every task waits for its terminal event and for `TaskManager` to release the project lock before the next task begins.

Runs shorter than five minutes always report `insufficient-duration-for-leak-claim`. External sampling cannot enumerate JavaScript timers, so event-listener and OS-handle trends are documented proxies; a threshold pass is bounded evidence, not a proof that leaks are impossible.

## 3. Release-scale SQLite and first-paint benchmark

```powershell
npm run build
node scripts/release-benchmark.mjs --report release-validation/benchmark.json
```

The default dataset is exactly:

- 1,000 projects;
- 10,000 sessions;
- 10,000 tasks;
- 100,000 timeline events.

The script initializes the current production `AppDatabase` schema, bulk-loads synthetic records transactionally, checks row counts and SQLite integrity, and measures production-shaped project/session/task/timeline queries. It reports average, p50, p95, maximum latency, query plans, schema version, and database-family size. It also launches the production Electron build against that disposable database and measures process-spawn-to-populated-React-root against the 3-second target.

For a script mechanics check that is not release-scale evidence:

```powershell
node scripts/release-benchmark.mjs --quick --skip-first-paint --repetitions 10
```

The report explicitly calls out the current non-paginated `listProjects` query and measures both the current full-list shape and a paginated candidate.

## 4. Production Electron workflow boundary

The deterministic workflow acceptance uses `FORCE_FAKE=1`, so it remains valuable for state-machine/UI regression but is not real-model evidence:

```powershell
npm run test:electron:workflow
```

The real production-Electron workflow uses the actual `ClaudeCliAdapter`, explicitly confirms ordinary PermissionBroker prompts, and validates durable Planner → confirmation → Coder → Tester → Reviewer → Checkpoint → Commit Preview evidence:

```powershell
npm run test:electron:workflow:real -- --skip-build --report release-validation/electron-real-workflow.json
```

Release sign-off should contain all three artifacts:

1. the deterministic Electron workflow acceptance report;
2. the real CLI smoke report above;
3. the production Electron real-workflow report covering Planner → confirmation → Coder → Permission → Checkpoint → Git Diff → Tester → Reviewer → Commit Preview.

## 5. Production Electron crash recovery

```powershell
npm run test:electron:recovery -- --skip-build --report release-validation/crash-recovery.json
```

This harness starts the production main/preload/renderer build against an isolated
profile, journals an active task, workflow stage, managed process, permission,
and file mutation, then terminates the first Electron process tree with
`taskkill /T /F` on Windows (`SIGKILL` elsewhere). On restart it verifies the
Recovery Center through the real preload/IPC and rendered dialog, confirms every
active resource is fail-closed as interrupted/paused, waits for evidence of an
accidental autonomous continuation, and hashes a project sentinel before and
after startup. It then clicks the Recovery Center's explicit abandon action and
checks that rollback cancels the task/workflow without changing the project.

The report also records v1.0 release/update state, SQLite integrity, clean second
shutdown, renderer errors, and a real JSONL-log sentinel scan. Diagnostic ZIP
export is intentionally not automated here because its production IPC requires
a native user-selected destination; exporter/IPC tests cover that boundary
without adding a test-only bypass.

## 6. Release security checklist

```powershell
npm run test:release-security
```

This runs focused permission, IPC, path, mutation, logging, diagnostics, and
installer-contract tests plus static production checks. Runtime Electron and
Authenticode evidence stay separate, so a static pass cannot be mistaken for a
signed or GUI-tested build.

## 7. Windows installer acceptance

`npm run dist` and `npm run dist:win` are developer diagnostic packaging
commands. Both inherit the tracked electron-builder output directory,
`release-validation/staging/build-output`; neither command creates
authoritative release evidence merely by succeeding.

The later Artifact Integrity Task 2D build report and its bound inventory are
the only authoritative source of release-candidate installer bytes. The
ignored `release/` directory is legacy, non-authoritative storage: release
tooling does not select artifacts from it and does not clean it.

The current installer-acceptance harness has not yet been migrated away from
its legacy reconstructed path. Until a later task binds it to authoritative
build inventory, do not run the harness as release evidence for staged output.
Its current standalone diagnostic entry point is:

```powershell
npm run test:installer:win -- --report release-validation/windows-installer.json
```

The harness refuses to overwrite an existing Claude Workbench shortcut. It
installs into an exact disposable directory, checks both shortcuts, launches
the packaged application with isolated data, verifies v1.0/update/renderer
state, then runs the real NSIS uninstaller and verifies shortcut removal. The
report records SHA-256 and Authenticode status.

## Package scripts

```json
{
  "test:real-cli": "node scripts/real-claude-smoke/run.mjs",
  "test:stability": "node scripts/real-claude-smoke/stability.mjs",
  "test:release-benchmark": "node scripts/release-benchmark.mjs",
  "test:release-security": "node scripts/release-security-checklist.mjs",
  "test:installer:win": "node scripts/windows-installer-acceptance.mjs",
  "test:electron:workflow:real": "node scripts/electron-workflow-acceptance.mjs --real",
  "test:electron:recovery": "node scripts/electron-crash-recovery-acceptance.mjs"
}
```
