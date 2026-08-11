# Real Electron acceptance

Run the complete 12-step desktop acceptance suite:

```powershell
npm run test:electron:acceptance
```

For a fast infrastructure check that still launches and restarts the real Electron app:

```powershell
npm run test:electron:smoke
```

The runner builds production bundles by default and then drives the actual Workbench window over Chromium DevTools Protocol. It does not launch a second helper Electron app.

The older `test-window.mjs` and `verify-ui.mjs` files are not acceptance runners: when launched directly they own a different Electron `app` instance and cannot inspect the Workbench window. Use the commands above for pass/fail evidence.

## Isolation guarantees

- A unique directory under the operating-system temp directory is used for every run.
- `WORKBENCH_DATA_DIR`, Chromium `--user-data-dir`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, and `TMP` all point inside that directory.
- `FORCE_FAKE=1` makes model execution deterministic; no external Claude process or network model request is made.
- Anthropic credentials and development-only Electron environment variables are removed from the child environment.
- MCP and Skill fixtures exist only in the two temporary projects and the isolated temporary home.
- Git identity is passed with `git -c` for fixture commits and never written globally.
- The exact spawned Electron PID/tree is stopped in `finally`, and the guarded temp directory is removed by default.

The complete suite verifies real main/preload/renderer IPC, two projects, task creation and execution, a human-readable Timeline, lazy Monaco Diff, result reporting, task switching, concurrent cross-project tasks, same-project write locking, project/user MCP and Skills discovery, the command palette shortcut, SQLite integrity, and persistence after restart.

## Phase 6 workflow acceptance

Run the dedicated 15-step Agent Workflow suite:

```powershell
npm run test:electron:workflow
```

It drives Plan confirmation, structured Planner output, Coder/Tester/Reviewer stages,
one automatic fix loop, Agent Timeline/Team UI, workflow checkpoints, Review UI,
Git changes, Commit Preview without committing, SQLite integrity, and restart recovery.
The same isolation guarantees apply; `FORCE_FAKE=1` is limited to deterministic model
transport while Electron, renderer, main IPC, SQLite, Checkpoint, and Git are real.

## Diagnostics

Useful options:

```powershell
node scripts/electron-acceptance.mjs --skip-build
node scripts/electron-acceptance.mjs --report .\artifacts\electron-acceptance.json
node scripts/electron-acceptance.mjs --keep-temp
```

`--report` writes a machine-readable report only to the explicitly supplied path. `--keep-temp` is opt-in and prints the retained fixture path. Without it, no test project, profile, process, or acceptance artifact remains.
