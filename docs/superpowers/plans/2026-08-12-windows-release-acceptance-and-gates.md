# Windows Release Acceptance and Final Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exercise the final unsigned RC through real Windows build/install/update/backup/reinstall/uninstall flows, collect complete automated and manual evidence, and emit a truthful 40-item closed-Beta/public-GA gate report.

**Architecture:** Existing production Electron acceptance scripts remain the behavioral source. New importable harness libraries isolate Windows installation and loopback update state, bind every report to the immutable manifest/context, and track only processes owned by the run. The final gate consumes report hashes; it cannot infer success from command exit alone.

**Tech Stack:** Windows/NSIS, Electron/CDP, Node ESM, PowerShell argument-vector helpers, electron-updater generic feed metadata, SQLite, Vitest.

## Global Constraints

- Run acceptance only after all implementation is amended into the one required clean `task15` commit.
- Real install/update/uninstall operations require explicit `--allow-system-mutation`, refuse pre-existing Claude Workbench shortcuts/install targets, and operate under a validated disposable root. Never recursively remove a computed or broad path.
- Never use the historical 1.0.0 installer as proof of a successful updater origin. Record its known hash/status/provenance problem as a separate historical-chain blocker.
- The loopback feed is a disposable acceptance fixture labeled `local-acceptance`; never call it production, upload it, or add it to electron-builder `publish`.
- Manual visual evidence is mandatory for wizard disclosure, all icon surfaces, UAC observation, small-size recognition, and known-forbidden-logo review. Missing evidence is `NEEDS_MANUAL_EVIDENCE` and sets `closedBetaReady=false`.
- Acceptance owns every Electron/Node/Claude/MCP process through a run ID plus PID/creation-time/executable identity. Cleanup touches only identities captured by this run; final residual count must be zero.
- An unsigned but otherwise accepted candidate reports `NotSigned`. Production feed, formal project license, approved privacy notice, signing certificate, publisher identity, security contact, and final name/brand review remain GA blockers.

---

### Task 1: Complete 60-case evidence matrix and automated test collector

**Files:**
- Create: `scripts/release/lib/test-evidence.mjs`
- Modify: `scripts/release/lib/tdd-evidence.mjs`
- Create: `scripts/release/test-evidence.mjs`
- Modify: `scripts/release/tdd-evidence.mjs`
- Create test: `tests/release/release-test-evidence.test.ts`
- Modify test: `tests/release/release-tdd-evidence.test.ts`
- Modify: `scripts/release/requirements-contract.mjs`
- Modify: `scripts/release/lib/report-schema.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `ACCEPTANCE_CASES` (exactly 60 immutable case definitions).
- Produces: `PRODUCTION_SCENARIOS` (exactly 44 immutable A1–F7 scenario assertions).
- Produces: `collectVitestEvidence(deps)` and `reconcileLoadedTestFiles(discovered, report)`.
- Produces: `test-evidence.json` with counts, case references, report hash inputs, and no raw stdout.
- Produces append-only ignored `requirements-tdd-evidence.json` with observed red→green history for all 60 IDs.

- [ ] **Step 1: Define the exact 60 cases**

Use these stable groups; tests assert every ID/description and exactly 60 total:

| IDs | Exact required assertions from Task 15 |
| --- | --- |
| `VER-01`–`VER-07` | single version source; higher than known installed version; RC channel; invalid version blocks; dirty blocks; unknown commit blocks; Build ID parses as version + short SHA + UTC |
| `META-08`–`META-12` | complete metadata; no absolute path; no secret; About equals Manifest public facts; Diagnostics equals Metadata public facts |
| `INS-13`–`INS-20` | filename has real version; stable App ID; install-directory policy; shortcuts; uninstall retains project; default retains userData; any optional local-data cleanup requires explicit confirmation; package excludes forbidden directories |
| `SIG-21`–`SIG-25` | no certificate → NotSigned; never forge Signed; signing password absent from logs; signature result in Manifest; invalid certificate blocks signing |
| `UPD-26`–`UPD-36` | no feed UI; Renderer cannot set URL; loopback only in test; RC channel; explicit download; explicit install; no forced restart; hash mismatch rejects; future schema not overwritten; pre-update backup; Provider/history retained |
| `DIA-37`–`DIA-44` | Release Metadata exported; no API key; no credential ref; no vault path; no source; update logs redacted; crash metadata redacted; all sentinel secrets filtered |
| `SBM-45`–`SBM-49` | SBOM generated; production closure complete; third-party notice generated; unknown license flagged; project license not auto-selected |
| `FDB-50`–`FDB-54` | template has no user code; diagnostics off by default; only explicit inclusion; absent URL stays local; feedback result/path does not leak username |
| `SEC-55`–`SEC-60` | release IPC sender check; updater IPC sender check; diagnostics IPC sender check; release-artifact secret scan; installer inventory scan; Manifest path scan |

Real Windows scenarios, performance, Git state, asset review, P0/P1 status, and the 40-item report are additional mandatory evidence; they do not replace or duplicate the exact 60 assertions above.

Also export this frozen A–F contract; `release-test-evidence.test.ts` deep-equals every `{ id, description }`, requires exactly 44 unique ordered items, and final gate requires every item `PASS`:

| ID | Exact Production acceptance assertion |
| --- | --- |
| `A1` | 使用全新隔离 Windows 用户数据目录 |
| `A2` | 安装 RC |
| `A3` | 验证快捷方式 |
| `A4` | 启动应用 |
| `A5` | First Run 正常 |
| `A6` | About 显示正确版本、Commit 和签名状态 |
| `A7` | Renderer errors = 0 |
| `B1` | 创建测试 Provider |
| `B2` | 使用安全测试 Credential |
| `B3` | 创建项目和任务历史 |
| `B4` | 创建模型档位和 Agent 模板 |
| `B5` | 关闭并重启 |
| `B6` | 数据保留 |
| `C1` | 安装旧版本（仅使用明确标记、不可发布的 RC0 本地更新 fixture；不把历史 1.0.0 当可信来源） |
| `C2` | 创建旧版本数据 |
| `C3` | 通过 Local RC Feed 检查更新 |
| `C4` | 下载 |
| `C5` | 用户确认安装 |
| `C6` | 重启 |
| `C7` | 数据库迁移 |
| `C8` | Provider、Credential、历史、模板和设置保留 |
| `C9` | First Run 不重复 |
| `C10` | 无残留旧进程 |
| `D1` | 导出诊断包 |
| `D2` | 扫描所有文件 |
| `D3` | Sentinel Secret 不存在 |
| `D4` | 用户源码不存在 |
| `D5` | API Key 不存在 |
| `D6` | `credential_ref` 不存在 |
| `D7` | vault 路径不存在 |
| `D8` | Release Metadata 正确 |
| `E1` | 卸载应用 |
| `E2` | 程序文件删除 |
| `E3` | 用户项目保持 |
| `E4` | 默认 userData 保留 |
| `E5` | 快捷方式删除 |
| `E6` | 无残留进程 |
| `F1` | Update Feed 不可用 |
| `F2` | UI 显示安全错误 |
| `F3` | 应用仍可使用 |
| `F4` | Hash 不匹配 |
| `F5` | 更新被拒绝 |
| `F6` | 数据库不损坏 |
| `F7` | Diagnostics 可导出 |

Each item stores `{ id, status, evidence: { reportPath, reportSha256, itemId }, blocker }`; one aggregate script status never substitutes for its child items. Each of the 60 definitions also freezes its focused test reference and related tracked source/test paths so TDD evidence cannot be reassigned after implementation.

- [ ] **Step 2: Write failing evidence reconciliation tests**

Test a missing discovered test file, unknown loaded file, failed test, skipped/todo test, empty suite, malformed JSON, duplicate 60-case or A–F item, missing A1/A6/B4/C9/D2–D8/E5/F1/F7 evidence, case without evidence, stale context/hash, raw path/secret sentinels, and a fully passing fixture. A historical updater-chain blocker cannot satisfy any `UPD-*` or C item.

For TDD history, test green-without-red, a red command that unexpectedly exits zero, a green command that exits nonzero, wrong/duplicate/unknown ID, green before red by injected monotonic sequence, non-allowlisted command ID, missing focused test/source mapping, changed test/source hash, raw stdout/error/environment/path/secret fields, attempts to overwrite history, and all 60 exact IDs with valid observed red→green transitions. A GA-only missing manual diagnostic review remains allowed in the all-pass closed-Beta fixture.

- [ ] **Step 3: Run the failing tests**

Run: `npm exec vitest -- run tests/release/release-test-evidence.test.ts tests/release/release-tdd-evidence.test.ts`

- [ ] **Step 4: Implement full Vitest collection**

Discover tracked `*.test.ts`/`*.test.tsx` using `git ls-files`, invoke Vitest JSON output through an injected argument-vector runner, and require every discovered file in the report. Record total files/suites/tests/passed/failed/skipped/todo and duration. Fail if failed/skipped/todo is nonzero or any tracked test is absent. Do not statically claim the earlier audit count; report the observed final count.

Reuse the Task 0 official PowerShell launcher and exact requirements contract; do not backfill them from timestamps or Git history. This route relies on the already-loaded, reviewed launcher code plus its literal four-entry project-input hash table as the scoped project trust anchor: launcher self-locking only stabilizes the pathname after load, pre-load replacement is outside this closure, and the hashes never come from a replaceable project manifest or an automatic update path. All official recorder invocations use the OS-known-folder-derived absolute System32 PowerShell command shown in the implementation/final-observation steps. Never use the fail-closed npm compatibility alias or direct Node entry for evidence: npm/direct Node can consume caller preload state before recorder JavaScript. Each slice keeps its earlier behavioral red, while all twelve single approved greens run in the frozen final observation phase at Task 7 Step 2, after the last planned tracked-source modification in all five subplans and before any generated release work. For `-Phase red`, the wrapper requires a nonzero child exit; for `-Phase green`, it requires zero exit and the earlier red. It never stores argv text, cwd, stdout/stderr, environment, errors, machine paths, or user data. Records are append-only atomic writes beneath `release-validation/tdd/`. Supporting diagnostic reruns may run plainly but cannot satisfy a numbered case. The final collector imports only `TDD_FINAL_GREEN_ORDER` and `TDD_FINAL_PATH_OBSERVATION_SLICE`: it requires the exact 12-red then 12-green chronology and compares every final tracked test/source byte with the hash from that path's exported last slice. No later tracked modification is permitted, and any missing/tampered observation or any of the 60 IDs without its red→green evidence fails closed.

- [ ] **Step 5: Bind non-Vitest commands**

Reference the context-bound preflight evidence for typecheck, lint, build, release security, migrations, and icon parity rather than rerunning hidden subsets. Each case maps to one or more `{reportPath, reportSha256, itemId}` references.

- [ ] **Step 6: Add script, re-run, and amend**

Add `release:test-evidence` to `package.json`; retain the Task 0 official launcher, reviewed literal-anchor/toolchain contract, and fail-closed `release:tdd-evidence` compatibility alias unchanged except for reviewed schema compatibility adjustments.

Run: `npm exec vitest -- run tests/release/release-test-evidence.test.ts tests/release/release-tdd-evidence.test.ts`

Run: `git add package.json scripts/release/requirements-contract.mjs scripts/release/lib/test-evidence.mjs scripts/release/lib/tdd-evidence.mjs scripts/release/test-evidence.mjs scripts/release/tdd-evidence.mjs scripts/release/lib/report-schema.mjs tests/release/release-test-evidence.test.ts tests/release/release-tdd-evidence.test.ts && git commit --amend --no-edit`

### Task 2: Safe Windows installer/overlay/uninstall harness

**Files:**
- Create: `scripts/release/lib/windows-process-ownership.mjs`
- Create: `scripts/release/lib/windows-shortcut.mjs`
- Create: `scripts/release/lib/windows-installer.mjs`
- Create: `scripts/release/powershell/Get-WorkbenchProcessIdentity.ps1`
- Create: `scripts/release/powershell/Get-WorkbenchShortcut.ps1`
- Create: `scripts/release/powershell/Get-WorkbenchShellIcon.ps1`
- Modify: `scripts/windows-installer-acceptance.mjs`
- Create test: `tests/release/windows-installer-harness.test.ts`
- Create test: `tests/release/windows-process-ownership.test.ts`

**Interfaces:**
- Consumes: Artifact Task 2D `loadBoundBuildInventory({ workspaceRoot, contextId, buildReference })`; `runInstallerAcceptance(...)` resolves `workspaceRoot` internally from the tracked module location, derives `contextId` only from its `context`, and receives `buildReference` as exactly the sole hash-bound `ARTIFACT-BUILD-WIN` evidence frozen into the candidate.
- Produces: `validateDisposableWindowsRoot(path, expectedPrefix)`.
- Produces: `captureOwnedProcess(child, runId)` and `assertNoOwnedProcesses(snapshot)`.
- Produces: `runInstallerAcceptance({ context, buildReference, allowSystemMutation, deps }): Promise<InstallerAcceptanceReport>`; it rejects a separate bare `contextId`, workspace-root option, or any caller-selected installer/path option.

- [ ] **Step 1: Write failing safety/identity tests**

Reject empty/root/home/workspace/install-parent paths, wrong prefix, symlink/reparse escape, pre-existing target/shortcuts, missing mutation flag, PID reuse with different creation time, unrelated matching process names, unexpected elevated token, arbitrary PowerShell path interpolation, cleanup outside the disposable root, and evidence containing absolute paths. Also reject a missing/mutated build report, wrong context/path/item ID, any attempted reference to a stale `release/` candidate, multiple installer entries, installer bytes whose size/hash drift from `BuildInventory`, and any caller-selected installer path. Merely finding ignored bytes under `release/` is not a failure; the harness must ignore and never select them.

- [ ] **Step 2: Run failing harness tests**

Run: `npm exec vitest -- run tests/release/windows-installer-harness.test.ts tests/release/windows-process-ownership.test.ts`

- [ ] **Step 3: Extract existing real installer flow into an importable library**

Replace the current `package.json` plus `release/ClaudeWorkbench Setup <version>.exe` reconstruction with `loadBoundBuildInventory(...)`. Use only its one contained ordinary installer `artifactId`, recompute size/SHA-256, then preserve the current MZ check, silent `/D=<Unicode path with spaces>` installation, CDP production launch, shortcut assertions, and uninstall. All spawned programs receive `WORKBENCH_ACCEPTANCE_RUN_ID`; capture process-tree identities at spawn and before cleanup. Pass file paths as distinct arguments to tracked PowerShell scripts using `-LiteralPath`.

- [ ] **Step 4: Inspect shortcuts and icon surfaces**

Read desktop/Start `.lnk` target, arguments, working directory, and icon location through `WScript.Shell`; require both target the installed EXE and resolve to the tracked icon identity. Extract associated icons for the installed EXE, desktop shortcut, Start shortcut, and uninstaller at 16/32/48/256 where Windows supplies them; compare nontransparent bounds and perceptual hash to the tracked PNG/ICO within tested tolerances.

- [ ] **Step 5: Prove overlay and retained data**

Launch the installed app with isolated `WORKBENCH_DATA_DIR`, complete First Run, create a Unicode/space project outside the install directory, and create Provider metadata, an opaque credential, task/history data, a model tier, an Agent template, settings, Checkpoint, and recovery fixtures through public production APIs. Record only opaque counts/hashes. Run the fixture RC0 installer and then RC1 installer over the same custom directory. Relaunch and require all data usable without secret exposure and First Run not repeated.

- [ ] **Step 6: Prove uninstall boundaries**

Verify installed EXE/uninstaller Authenticode and hashes before uninstall. Run the real uninstaller, require program files plus desktop/Start shortcuts removed, and require isolated userData, verified backup, encrypted credential vault, and project bytes retained and usable after reinstall. Cleanup removes only the validated disposable install/data/project roots and this run's shortcuts; reports record retention hashes before cleanup.

- [ ] **Step 7: Re-run tests and amend**

Run: `npm exec vitest -- run tests/release/windows-installer-harness.test.ts tests/release/windows-process-ownership.test.ts`

Run: `git add scripts/release/lib/windows-process-ownership.mjs scripts/release/lib/windows-shortcut.mjs scripts/release/lib/windows-installer.mjs scripts/release/powershell/Get-WorkbenchProcessIdentity.ps1 scripts/release/powershell/Get-WorkbenchShortcut.ps1 scripts/release/powershell/Get-WorkbenchShellIcon.ps1 scripts/windows-installer-acceptance.mjs tests/release/windows-installer-harness.test.ts tests/release/windows-process-ownership.test.ts && git commit --amend --no-edit`

### Task 3: Loopback RC feed and real RC0→RC1 updater acceptance

**Files:**
- Create: `scripts/release/lib/loopback-update-feed.mjs`
- Create: `scripts/release/lib/update-fixture-build.mjs`
- Create: `scripts/release/lib/windows-native-diagnostics.mjs`
- Create: `scripts/windows-update-acceptance.mjs`
- Modify: `scripts/electron-beta-readiness-acceptance.mjs`
- Create test: `tests/release/loopback-update-feed.test.ts`
- Create test: `tests/release/windows-update-harness.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: the exact RC1 installer ID/size/hash from Artifact Task 2D `loadBoundBuildInventory(...)`; loopback feed construction rehashes those bytes and never discovers an installer under `release/` or staging.
- Produces: `createRcYml({ version, installer, sha512, size, releaseNotes }): Buffer`.
- Produces: `buildRc0Fixture(context): Promise<FixtureArtifact>` without modifying tracked files.
- Produces: `runWindowsUpdateAcceptance(options): Promise<UpdateAcceptanceReport>`.

- [ ] **Step 1: Write failing feed/fixture tests**

Test canonical YAML field order/line endings, version `1.0.1-rc.1`, the locked electron-updater 6.8.9 request for `rc.yml`, channel/path parity, base64 SHA-512, size, notes hash, no URL/secret, content types, HEAD/range requests, 404s, one-shot tampered metadata/binary, loopback-only bind, redirect rejection, disposal, RC0 fixture-purpose/metadata/package/lock/release-notes parity, candidate-schema rejection of fixture metadata, source-worktree hash unchanged, and output beneath ignored staging.

- [ ] **Step 2: Write failing update-harness state tests**

Require: automatic check remains off; an unavailable feed produces a safe bounded error while the app remains usable; explicit check discovers RC1; explicit download succeeds; wrong SHA-512 fails while DB hash stays unchanged, app stays usable, and a real diagnostics ZIP is exported through the native Save dialog; valid redownload reports `NotSigned`; cancel install does nothing; confirmed install creates a verified backup; app exits without forced auto-restart; manual relaunch reports RC1; schema, Provider metadata, opaque credential, history, model tier, Agent template, settings, First Run completion, Checkpoint, and recovery state remain usable; no downgrade to RC0; zero owned processes. Historical 1.0.0 evidence is a blocker field only and never substitutes for feed discovery/download/integrity/failure acceptance.

- [ ] **Step 3: Run the failing tests**

Run: `npm exec vitest -- run tests/release/loopback-update-feed.test.ts tests/release/windows-update-harness.test.ts`

- [ ] **Step 4: Build an isolated RC0 fixture from the same clean commit**

Copy only tracked files into `release-validation/fixtures/rc0-source`, then in that ignored copy update `package.json.version`, the lock root/package-root versions, the fixture release-notes bytes/hash, app version, and embedded/resource metadata to `1.0.1-rc.0`. Generate the strict `purpose:'local-update-fixture'` union member tied to the source commit and an explicit patch inventory; the copied build alone compiles the fixture constant true, while `assertReleasableMetadata()`, Manifest creation, the RC1 bundle scanner, and the closed-Beta candidate context reject it unconditionally.

Inside that copied root, clear `NODE_PATH` and other parent-resolution overrides, run the same locked npm through `npm ci`, and prove every build-tool/runtime `require.resolve()` path is contained by the fixture root. Set the fixed fixture metadata path/epoch, run `npm run build`, verify the compiled Main bundle and copied resource carry rc.0 fixture metadata, then invoke the fixture-root electron-builder with a fixture-only output directory. The tracked-only copy never reuses `dist/` or `node_modules/` from task15 or stable main. Do not edit package/lock/source files in the task15 worktree. Record the original source commit/inventory hash, fixture patch inventory/hash, exact lock/toolchain, dependency-root containment, compiled metadata parity, artifact SHA-256, and truthful `NotSigned` status.

- [ ] **Step 5: Serve a disposable generic feed**

Bind an ephemeral port on literal `127.0.0.1`, capture the real updater request and require it to be `/rc/rc.yml`, serve that file plus only the Task 2D bound RC1 installer after size/hash revalidation, enforce method/path/range limits, and log only request method plus fixed route label. Launch the installed RC0 fixture app, whose audited copied-source build has the local-update fixture branch compiled in, with only `UPDATE_FEED_URL=<loopback>/rc/`; reports store only `feedClass=local-acceptance` and a server instance hash, never the URL. The RC1 candidate has no runtime acceptance switch and its bundle scan rejects the fixture branch and marker strings.

- [ ] **Step 6: Drive the public updater UI through production Electron**

Use CDP only through visible About/update controls. Confirm state text and buttons for unconfigured, available, downloading, downloaded, integrity failure, backup failure, and installation. Extract the existing native-dialog `exportDiagnosticsExact()` flow from `scripts/electron-beta-readiness-acceptance.mjs` into `windows-native-diagnostics.mjs` and reuse it after tamper failure; it selects and verifies a caller-owned disposable destination through the real Save dialog, with no production IPC bypass or hidden acceptance destination. After valid confirmed install, wait for owned RC0 processes to exit, relaunch the installed EXE, and verify RC1 metadata and retained database/credential facts.

- [ ] **Step 7: Add script, re-run, and amend**

Add `test:update:win` to `package.json`.

Run: `npm exec vitest -- run tests/release/loopback-update-feed.test.ts tests/release/windows-update-harness.test.ts`

Run: `git add package.json scripts/release/lib/loopback-update-feed.mjs scripts/release/lib/update-fixture-build.mjs scripts/release/lib/windows-native-diagnostics.mjs scripts/windows-update-acceptance.mjs scripts/electron-beta-readiness-acceptance.mjs tests/release/loopback-update-feed.test.ts tests/release/windows-update-harness.test.ts && git commit --amend --no-edit`

### Task 4: Production Electron, credential, diagnostics, and manual visual evidence

**Files:**
- Modify: `scripts/electron-beta-readiness-acceptance.mjs`
- Modify: `scripts/electron-crash-recovery-acceptance.mjs`
- Modify: `scripts/electron-model-provider-acceptance.mjs`
- Create: `scripts/windows-manual-release-evidence.mjs`
- Create: `scripts/merge-manual-release-evidence.mjs`
- Create test: `tests/release/manual-release-evidence.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces hash-bound reports at caller-supplied `--report` paths.
- Produces per-workstation canonical evidence fragments and merges them only on the release workstation.
- Produces: `validateManualReleaseEvidence(evidence, frozenCandidate): StageResult`.
- Produces separate `closed_beta_required` and `ga_only` manual item results.

- [ ] **Step 1: Write failing report/manual-evidence tests**

Reject reports outside validation root, wrong freeze/challenge/context/manifest/installer/icon hash, missing 15 steps, screenshot outside evidence root, missing screenshot hash, stale timestamp, unknown reviewer role, absent explicit reviewer attestation, unchecked closed-Beta item, source path, credential sentinel, any closed-Beta-required `NEEDS_MANUAL_EVIDENCE` item, duplicate environment/item, conflicting fragment, non-canonical or internally inconsistent fragment receipt, fragment from another freeze, or a fragment whose collector-script hash is not the tracked expected hash. Accept only exact checklist IDs and hashes bound to the frozen installer/icon/manifest bytes. A missing or incomplete `ga_only` item remains a GA blocker but does not masquerade as a closed-Beta failure. Receipt hashes prove canonical-byte integrity only; tests and UI must not describe them as cryptographic author identity or tamper-proof provenance.

- [ ] **Step 2: Run the failing test**

Run: `npm exec vitest -- run tests/release/manual-release-evidence.test.ts`

- [ ] **Step 3: Bind existing production acceptance reports**

Add required `--report`, context ID, manifest SHA-256, app artifact SHA-256, owned-process cleanup summary, and retained-output sentinel scan to the existing 15-step Beta readiness, crash recovery, and model-provider scripts. Preserve their substantive flows; do not replace them with mocks or a new parallel acceptance suite.

- [ ] **Step 4: Prove credential continuity without disclosure**

Model-provider acceptance creates a unique secret through the UI, verifies it is immediately cleared from Renderer inputs, runs a real loopback provider request, restarts/overlays/updates/reinstalls, and repeats a successful request without re-entry. Evidence stores only `credentialUsable=true`, request count, provider-kind enum, and sentinel-scan result; never hash or prefix the secret.

- [ ] **Step 5: Define mandatory manual visual review**

`candidate-freeze.json` contains a fresh public evidence challenge so an accidentally reused fragment from another freeze is rejected. On each test workstation, `windows-manual-release-evidence.mjs --fragment` verifies the local copies of the frozen installer/manifest/icon/inner-ledger hashes, then records an explicitly selected subset of required item IDs, actual OS edition/build/architecture, 100%/125%/150% DPI, and hashes for screenshots of: NSIS welcome independence/unsigned disclosure, custom Unicode path page, installed window icon, desktop icon at small/large view, Start menu icon, Apps list/uninstaller icon, About disclosure/status, update local-acceptance label, future-schema recovery screen, and post-uninstall retained-data/reinstall state. The reviewer must actively attest that they personally performed the selected checks on those displayed hashes, provide an allowed reviewer role and UTC review time, and acknowledge that the attestation is manual rather than cryptographically authenticated. The script emits canonical JSON plus an integrity receipt over the fragment bytes, challenge, and tracked collector-script hash. That receipt detects accidental byte drift and binds the selected evidence, but without an independently configured signing identity it does not prove who authored the fragment. It stores no hostname, username, machine ID, or absolute path.

`merge-manual-release-evidence.mjs` runs only on the release workstation, accepts individually selected fragment paths beneath `release-validation/manual-fragments/`, validates each integrity receipt/screenshot/frozen hash and explicit reviewer attestation, rejects duplicate/conflicting item ownership, and writes the one canonical merged report atomically. `WIN10_X64`, `WIN11_X64`, `DPI_125`, and `DPI_150` are all closed-Beta-required and must appear exactly once across the fragments; each records actual OS build/architecture, per-user/asInvoker observation, DPI, and screenshot hash. The reviewer records yes/no for no UAC prompt, correct layout at 125%/150%, 16px recognition, no known Anthropic/Claude/OpenAI/ChatGPT/Codex/Microsoft/GitHub/VS Code/vendor logo, and asset-notice parity. Any required item not actually executed is `NEEDS_MANUAL_EVIDENCE` and sets `closedBetaReady=false`; the report never claims support for an untested platform. The scripts cannot default answers to yes. Unless a future independent fragment-signing key is configured and verified, the final report truthfully labels source assurance `MANUAL_REVIEWER_ATTESTATION`, not `AUTHENTICATED_PROVENANCE`.

The same schema defines `MAN-DIAG-REVIEW` as `ga_only`: a named reviewer and UTC review time must be bound to the final diagnostic ZIP hash and record that no secret, private source, raw absolute path, or unexpected member was observed. Until supplied, it remains an explicit public-GA blocker only. It does not replace the automated closed-Beta diagnostic allowlist/sentinel scan.

- [ ] **Step 6: Re-run tests and amend**

Add `release:manual-evidence` and `release:manual-evidence:merge` to `package.json`.

Run: `npm exec vitest -- run tests/release/manual-release-evidence.test.ts`

Run: `git add package.json scripts/electron-beta-readiness-acceptance.mjs scripts/electron-crash-recovery-acceptance.mjs scripts/electron-model-provider-acceptance.mjs scripts/windows-manual-release-evidence.mjs scripts/merge-manual-release-evidence.mjs tests/release/manual-release-evidence.test.ts && git commit --amend --no-edit`

### Task 5: Release-scale performance and package-size attribution

**Files:**
- Modify: `scripts/release-benchmark.mjs`
- Create: `scripts/release/package-analysis.mjs`
- Modify: `vite.main.config.ts`
- Modify: `vite.preload.config.ts`
- Modify: `vite.renderer.config.ts`
- Create test: `tests/release/release-performance.test.ts`
- Create test: `tests/release/release-package-analysis.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `runReleaseBenchmark({ frozenCandidate, installedRc1Evidence, installedRc0FixtureEvidence, loopbackFeedHarness, nativeDiagnosticsHarness, disposableProfileRoot, datasetScale })` and a threshold-validated report at full `1,000/10,000/10,000/100,000` scale.
- Produces: `analyzePackageSize(unpackedRoot, installer): PackageAnalysisReport`, with a compressed-installer total and a separate canonical unpacked-tree classification.
- Produces a sanitized Vite/Rollup build-analysis report with bundle-category membership and no resolved module paths.

- [ ] **Step 1: Write failing performance/package tests**

Test quick mode cannot satisfy release evidence, missing first paint/About/RC1-unconfigured-update/RC0-loopback-update/diagnostics timings, an update timing attributed to the wrong executable, absent RC0 and target-RC1 artifact hashes, each target miss, wrong scale, insufficient repetitions, DB integrity failure, context/hash drift, installer/unpacked budget exceedance, unattributed bytes, source maps/tests/temp files, missing Electron/Monaco/SQLite/SDK attribution, second-build byte match/mismatch classification, and historical baseline represented as informational/untrusted.

- [ ] **Step 2: Run the failing tests**

Run: `npm exec vitest -- run tests/release/release-performance.test.ts tests/release/release-package-analysis.test.ts`

- [ ] **Step 3: Make performance thresholds explicit**

`runReleaseBenchmark()` accepts only the frozen candidate/Manifest, installed RC1 path/hash evidence, installed non-releasable RC0 fixture path/hash/purpose evidence, the target RC1 installer hash, the fixed loopback-feed harness, the shared native diagnostics-export harness, owned disposable profile roots, and the exact dataset scale. It rejects source Electron, `dist/main`, a different installed EXE, a candidate mislabeled as fixture, or an unbound profile. Measure startup, About, the fail-closed unconfigured update control, diagnostics, and database queries from the final installed RC1 EXE and bind those samples to its artifact hash. Measure the local-feed update check only from the installed RC0 fixture with its compile-time fixture branch, binding that sample set to both RC0 and target-RC1 hashes and labeling it `fixture_local_acceptance`; never attribute it to RC1 capability. Startup uses three fresh-profile launches plus five warm restarts. About, RC1 unconfigured check, and RC0 loopback update check use one warm-up plus five recorded samples each. Diagnostics export uses three recorded samples. Store every sample and median/min/max; call a launch `fresh-profile`, never `cold`, unless filesystem cache is independently controlled. Require SQLite integrity `ok`, production React root first paint median `<3000 ms`, About median `<1000 ms`, each update-control median `<5000 ms`, diagnostic-export median `<5000 ms`, full project-list p95 `<250 ms`, paginated session/task/timeline query p95 `<100 ms`, and seed duration `<60,000 ms`. A target miss is a blocker, not a silently ignored warning.

- [ ] **Step 4: Attribute package bytes**

Report the compressed installer only as its exact total size and SHA-256; do not pretend compressed bytes map one-for-one to unpacked categories. The canonical unpacked-tree total is the sum of every top-level installed regular file exactly once. Files outside `app.asar` are classified by fixed relative-path rules. For `app.asar`, use the locked local ASAR reader: classify every entry payload byte once, add `asar-header-overhead = app.asar file size - sum(entry payload sizes)`, and replace the single top-level `app.asar` amount with those payload categories plus overhead—never count both. Built JS/CSS chunks are assigned wholly to `app-bundle-shared`; the release-only Vite plugins record sanitized per-chunk category membership/estimated rendered lengths for Monaco, Agent SDK, app code, and other dependencies, but those estimates are explicitly non-additive supporting attribution and never enter the 100% sum. External Monaco/SQLite/native/SDK files may use their dedicated byte categories. Require top-level tree total = external-file categories + ASAR payload categories + ASAR overhead exactly, with unknown bytes failing into a named `unclassified` blocker rather than disappearing.

Require installer ≤220 MiB, unpacked ≤850 MiB, no maps/tests/source/temp, and an explanation for any ≥5% change from the historical 164,484,149/669,278,072-byte package. The Manifest records the sanitized build-analysis hash; reports contain no resolved module/source path. Label the historical baseline `UNTRUSTED_PROVENANCE`, not a reproducibility result. Build a second isolated candidate from the same commit, metadata snapshot, lockfile, toolchain, and `SOURCE_DATE_EPOCH`; compare installer hashes and canonical unpacked inventories. Report `BYTE_FOR_BYTE_REPRODUCIBLE` only on exact equality, otherwise report `PROVENANCE_REBUILDABLE_ONLY` with differing-file categories and no reproducibility claim.

- [ ] **Step 5: Add script, re-run, and amend**

Add `release:package-analysis` to `package.json`.

Run: `npm exec vitest -- run tests/release/release-performance.test.ts tests/release/release-package-analysis.test.ts`

Run: `git add package.json scripts/release-benchmark.mjs scripts/release/package-analysis.mjs vite.main.config.ts vite.preload.config.ts vite.renderer.config.ts tests/release/release-performance.test.ts tests/release/release-package-analysis.test.ts && git commit --amend --no-edit`

### Task 6: Acceptance aggregation and orthogonal final gate

**Files:**
- Create: `scripts/release/acceptance.mjs`
- Create: `scripts/release/final-gate.mjs`
- Modify: `scripts/release/rc.mjs`
- Modify: `scripts/release/verify.mjs`
- Modify: `scripts/release/lib/report-schema.mjs`
- Create test: `tests/release/release-acceptance.test.ts`
- Create test: `tests/release/release-final-gate.test.ts`
- Modify test: `tests/release/release-verify.test.ts`
- Modify test: `tests/release/release-rc.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: the frozen Task 2D build reference/inventory through acceptance reports; exact installer/tree hashes must match the manifest and inner ledger before aggregation.
- Produces: `runAcceptance(deps): Promise<AcceptanceReport>`.
- Produces: `evaluateFinalGate(inputs): FinalGateReport`.
- Produces: `verifyDeliveryLedger(delivery, receipt, { noWrite: true }): DeliveryVerification`.
- Completes: `runReleaseCandidate()` and final checksum stage.

- [ ] **Step 1: Write failing aggregation/gate tests**

Cover stale/mutated/missing reports, wrong commit/manifest/artifact hash, nonzero skip/todo, failed local feed case, historical blocker incorrectly substituted, incomplete real install/launch/overlay/update/uninstall, any missing A1–F7 scenario, credential unusable, diagnostics sentinel leak, residual owned process, package/performance failure, unchecked closed-Beta manual item, missing Win10/Win11/DPI evidence, any unresolved P0/P1, stale/replayed resume evidence, pending/canonical delivery mutation, outer-ledger missing/extra entries, atomic-publish failure, post-rename verification failure, receipt-write failure, a check-only verifier that rewrites the authoritative receipt, a same-byte rewrite of outer `SHA256SUMS.txt` detected through mtime drift, a canonical delivery file added/deleted during check-only, and an all-pass closed-Beta fixture. Every delivery failure test asserts there is no canonical PASS report or completion receipt. Assert GA always false and unsigned/production-feed/license/privacy/name/external-testing/manual-diagnostic-review/publisher-contact blockers remain.

- [ ] **Step 2: Run the failing tests**

Run: `npm exec vitest -- run tests/release/release-acceptance.test.ts tests/release/release-final-gate.test.ts`

- [ ] **Step 3: Implement stop-on-failure acceptance aggregation**

Run/import, in order: test evidence; release security; 15-step production Electron; crash recovery; model-provider credential lifecycle; installer/overlay/uninstall; local update tamper and RC0→RC1; full performance; package analysis; manual evidence validation; retained-report secret/path scan; zero owned processes. Each child gets an explicit report path and context/manifest hash. Acceptance writes no final status.

- [ ] **Step 4: Implement the exact final gate**

`closedBetaReady=true` only when all exact 60 automated cases, all exact 44 `PRODUCTION_SCENARIOS` A1–F7 items, every `closed_beta_required` report/manual item (including Win10 x64, Win11 x64, DPI 125%, and DPI 150%), local-feed schema/discovery/download/SHA-512-failure/continued-usability cases, inner artifact ledger, and every other mandatory report are `PASS`; no closed-Beta `NEEDS_MANUAL_EVIDENCE`, unresolved P0/P1 of any category, hash mismatch, renderer error, or test-owned residual process may remain. The untrusted historical 1.0.0 chain stays a separately reported blocker and cannot replace the local-feed cases. Only then include `PASS_FOR_CLOSED_BETA`.

Always set `publicGaReady=false`, `distributionExecuted=false`, include `BLOCKED_FOR_PUBLIC_GA`, and enumerate the original GA blockers independently: final project license; legally approved Privacy/Terms and publishing entity/address/jurisdiction; production feed; approved signing certificate/publisher subject; security and release contact; final name/trademark review; external closed-Beta testing completion; trusted historical upgrade-chain evidence; manual `MAN-DIAG-REVIEW`; and any unresolved P0/P1 data-loss, credential, privacy, authorization, or permission issue. A GA-only `INFORMATIONAL`, `BLOCKED`, or `NEEDS_MANUAL_EVIDENCE` row never turns closed-Beta evidence into PASS and never permits GA. `PASS_FOR_CLOSED_BETA` means the owner-requested candidate-readiness gate only; neither the pipeline nor this Task performs distribution or treats the icon attestation as distribution/legal authorization.

- [ ] **Step 5: Emit the fixed 40-item report**

Render `final-report.json` and `final-report.md` first beneath the exclusive pending-delivery directory, with IDs 1–40 from `FINAL_REPORT_ITEM_IDS`; their eventual canonical location is `release-validation/delivery/<context-id>/`. Every row has status, concise observed result, evidence path/hash/item, and blocker when applicable. Include installer artifact name and unpacked-tree ID (never a machine-absolute path), sizes, hashes, signature status, Renderer errors, test counts, residual process count, task15 SHA, main SHA/cleanliness, asset hashes, manifest hash, and orthogonal Beta/GA booleans. Paths in retained reports are workspace-relative only.

- [ ] **Step 6: Complete orchestrator/checksum order**

`release:rc` requires clean committed HEAD and the frozen/resumed context from Subplan 2. Before manual evidence it verifies `ARTIFACT_SHA256SUMS.txt`, which covers immutable candidate inputs and is the checksum evidence referenced by final-report item 17. After acceptance, `evaluateFinalGate()` returns an in-memory decision; report rendering and `writeDeliveryChecksums()` occur only in an exclusive pending-delivery directory. The outer ledger uses eventual canonical relative names, covers the inner ledger plus all final evidence/reports, and excludes itself. Verify pending bytes, atomically rename the directory to `release-validation/delivery/<context-id>/`, re-verify canonical bytes, then atomically write `release-validation/release-complete.json` as the sole authoritative completion/PASS marker. If writing or verifying the ledger, publishing, re-verifying, or writing the receipt fails, quarantine/remove the canonical directory and receipt before returning nonzero. No independently consumable PASS report may remain. A final `release:verify --check-only --no-write` must require the receipt, snapshot its hash/mtime, the outer `SHA256SUMS.txt` file's own hash/mtime, all inner/outer-covered files, and the sorted canonical-delivery file set, recompute only in memory, and prove all hashes/mtimes and the set are unchanged.

- [ ] **Step 7: Add scripts and run the complete harness unit suite**

Add `release:acceptance` and `release:final-gate` to `package.json`; keep `release:manual-evidence` as the only manual-evidence collector.

Run: `npm exec vitest -- run tests/release/release-test-evidence.test.ts tests/release/windows-installer-harness.test.ts tests/release/windows-process-ownership.test.ts tests/release/loopback-update-feed.test.ts tests/release/windows-update-harness.test.ts tests/release/manual-release-evidence.test.ts tests/release/release-performance.test.ts tests/release/release-package-analysis.test.ts tests/release/release-acceptance.test.ts tests/release/release-final-gate.test.ts tests/release/release-rc.test.ts`

- [ ] **Step 8: Amend the final implementation checkpoint**

Run: `git add package.json scripts/release/acceptance.mjs scripts/release/final-gate.mjs scripts/release/rc.mjs scripts/release/verify.mjs scripts/release/lib/report-schema.mjs tests/release/release-acceptance.test.ts tests/release/release-final-gate.test.ts tests/release/release-verify.test.ts tests/release/release-rc.test.ts && git commit --amend --no-edit`

### Task 7: Execute final build, real acceptance, and audit

**Files:**
- Generated/ignored only: `release-validation/`
- No tracked source changes are permitted during this task.

- [ ] **Step 1: Confirm the single final commit and immutable inputs**

Run: `git status --short`

Expected: no output.

Run: `git log -1 --format=%s`

Expected: `chore(release): prepare controlled beta candidate`

Run: `git rev-parse HEAD`

Run: `git worktree list --porcelain`

Expected: task15 committed SHA and a `refs/heads/main` worktree at `eb1a07bb950769cf24d0fe5c61c710fed4da0fba`. The subsequent non-overridable preflight independently requires that main worktree's tracked status clean and stores no machine path.

- [ ] **Step 2: Record the frozen final green observation phase**

No tracked file is modified after this point. Run these exact commands in order; each direct Vitest vector must exit 0:

Run (observed green): `& ([IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'WindowsPowerShell\v1.0\powershell.exe')) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\release\tdd-evidence-launcher.ps1 -Phase green -CaseIds VER-01,VER-02,VER-03,VER-04,VER-05,VER-06,VER-07,META-08,META-09,META-10,META-11,META-12 -CommandId foundation-version-metadata -ChildArgumentsBase64 bm9kZQBub2RlX21vZHVsZXMvdml0ZXN0L3ZpdGVzdC5tanMAcnVuAHNyYy9tYWluL3JlbGVhc2UvX190ZXN0c19fL1JlbGVhc2VNZXRhZGF0YS50ZXN0LnRzAHRlc3RzL3JlbGVhc2UvcmVsZWFzZS1tZXRhZGF0YS1zY3JpcHQudGVzdC50cwBzcmMvbWFpbi9yZWxlYXNlL19fdGVzdHNfXy9WZXJzaW9uSW5mby50ZXN0LnRz; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`

Run (observed green): `& ([IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'WindowsPowerShell\v1.0\powershell.exe')) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\release\tdd-evidence-launcher.ps1 -Phase green -CaseIds INS-13,INS-14,INS-15,INS-16,INS-17,INS-18,INS-19,INS-20 -CommandId foundation-installer -ChildArgumentsBase64 bm9kZQBub2RlX21vZHVsZXMvdml0ZXN0L3ZpdGVzdC5tanMAcnVuAHNyYy9tYWluL3JlbGVhc2UvX190ZXN0c19fL0luc3RhbGxlckNvbmZpZy50ZXN0LnRzAHNyYy9tYWluL3JlbGVhc2UvX190ZXN0c19fL0FwcEljb25QYXRoLnRlc3QudHMAdGVzdHMvcmVsZWFzZS9hcHAtdXBkYXRlLWNvbmZpZy50ZXN0LnRz; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`

Run (observed green): `& ([IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'WindowsPowerShell\v1.0\powershell.exe')) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\release\tdd-evidence-launcher.ps1 -Phase green -CaseIds SEC-55 -CommandId foundation-release-ipc -ChildArgumentsBase64 bm9kZQBub2RlX21vZHVsZXMvdml0ZXN0L3ZpdGVzdC5tanMAcnVuAHNyYy9tYWluL2lwYy9fX3Rlc3RzX18vcmVsZWFzZS50ZXN0LnRzAHNyYy9wcmVsb2FkL19fdGVzdHNfXy9pbmRleC50ZXN0LnRzAHNyYy9wcmVsb2FkL19fdGVzdHNfXy90cmFuc3BvcnQtc3VyZmFjZS50ZXN0LnRz; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`

Run (observed green): `& ([IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'WindowsPowerShell\v1.0\powershell.exe')) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\release\tdd-evidence-launcher.ps1 -Phase green -CaseIds SIG-21,SIG-22,SIG-23,SIG-24,SIG-25 -CommandId artifact-signing -ChildArgumentsBase64 bm9kZQBub2RlX21vZHVsZXMvdml0ZXN0L3ZpdGVzdC5tanMAcnVuAHRlc3RzL3JlbGVhc2UvcmVsZWFzZS1zaWduaW5nLnRlc3QudHMAc3JjL21haW4vcmVsZWFzZS9fX3Rlc3RzX18vQXV0aGVudGljb2RlU3RhdHVzUmVhZGVyLnRlc3QudHMAc3JjL21haW4vcmVsZWFzZS9fX3Rlc3RzX18vUnVudGltZVJlbGVhc2VTdGF0dXMudGVzdC50cw==; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`

Run (observed green): `& ([IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'WindowsPowerShell\v1.0\powershell.exe')) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\release\tdd-evidence-launcher.ps1 -Phase green -CaseIds SBM-45,SBM-46,SBM-47,SBM-48,SBM-49 -CommandId artifact-sbom -ChildArgumentsBase64 bm9kZQBub2RlX21vZHVsZXMvdml0ZXN0L3ZpdGVzdC5tanMAcnVuAHRlc3RzL3JlbGVhc2UvcmVsZWFzZS1zYm9tLnRlc3QudHM=; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`

Run (observed green): `& ([IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'WindowsPowerShell\v1.0\powershell.exe')) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\release\tdd-evidence-launcher.ps1 -Phase green -CaseIds SEC-58,SEC-59,SEC-60 -CommandId artifact-package-scans -ChildArgumentsBase64 bm9kZQBub2RlX21vZHVsZXMvdml0ZXN0L3ZpdGVzdC5tanMAcnVuAHRlc3RzL3JlbGVhc2UvcmVsZWFzZS1tYW5pZmVzdC50ZXN0LnRzAHRlc3RzL3JlbGVhc2UvcmVsZWFzZS12ZXJpZnkudGVzdC50cw==; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`

Run (observed green): `& ([IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'WindowsPowerShell\v1.0\powershell.exe')) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\release\tdd-evidence-launcher.ps1 -Phase green -CaseIds UPD-26,UPD-28,UPD-29 -CommandId updater-source-policy -ChildArgumentsBase64 bm9kZQBub2RlX21vZHVsZXMvdml0ZXN0L3ZpdGVzdC5tanMAcnVuAHNyYy9tYWluL3JlbGVhc2UvX190ZXN0c19fL1VwZGF0ZVNvdXJjZVBvbGljeS50ZXN0LnRzAHNyYy9tYWluL3JlbGVhc2UvX190ZXN0c19fL1VwZGF0ZVRyYW5zcG9ydEd1YXJkLnRlc3QudHMAc3JjL21haW4vcmVsZWFzZS9fX3Rlc3RzX18vVXBkYXRlTWFuYWdlci50ZXN0LnRz; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`

Run (observed green): `& ([IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'WindowsPowerShell\v1.0\powershell.exe')) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\release\tdd-evidence-launcher.ps1 -Phase green -CaseIds UPD-30,UPD-31,UPD-32,UPD-33,UPD-34,UPD-35,UPD-36 -CommandId updater-install-safety -ChildArgumentsBase64 bm9kZQBub2RlX21vZHVsZXMvdml0ZXN0L3ZpdGVzdC5tanMAcnVuAHNyYy9tYWluL3JlbGVhc2UvX190ZXN0c19fL1VwZGF0ZVNpZ25hdHVyZUluc3BlY3Rvci50ZXN0LnRzAHNyYy9tYWluL3JlbGVhc2UvX190ZXN0c19fL1VwZGF0ZUluc3RhbGxHdWFyZC50ZXN0LnRzAHNyYy9tYWluL3JlbGVhc2UvX190ZXN0c19fL1VwZGF0ZU1hbmFnZXIudGVzdC50cw==; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`

Run (observed green): `& ([IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'WindowsPowerShell\v1.0\powershell.exe')) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\release\tdd-evidence-launcher.ps1 -Phase green -CaseIds UPD-27,SEC-56 -CommandId updater-ipc -ChildArgumentsBase64 bm9kZQBub2RlX21vZHVsZXMvdml0ZXN0L3ZpdGVzdC5tanMAcnVuAHNyYy9tYWluL2lwYy9fX3Rlc3RzX18vcmVsZWFzZS50ZXN0LnRzAHNyYy9tYWluL2lwYy9fX3Rlc3RzX18vZGF0YWJhc2UtY29tcGF0aWJpbGl0eS50ZXN0LnRzAHNyYy9wcmVsb2FkL19fdGVzdHNfXy9pbmRleC50ZXN0LnRzAHNyYy9wcmVsb2FkL19fdGVzdHNfXy90cmFuc3BvcnQtc3VyZmFjZS50ZXN0LnRzAHNyYy9wcmVsb2FkL19fdGVzdHNfXy9wdWJsaWMtaXBjLXRyYW5zcG9ydC50ZXN0LnRzAHNyYy9yZW5kZXJlci9fX3Rlc3RzX18vcHVibGljLWFwaS1mYWNhZGUudGVzdC50cw==; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`

Run (observed green): `& ([IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'WindowsPowerShell\v1.0\powershell.exe')) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\release\tdd-evidence-launcher.ps1 -Phase green -CaseIds DIA-37,DIA-38,DIA-39,DIA-40,DIA-41,DIA-42,DIA-43,DIA-44 -CommandId diagnostics-export -ChildArgumentsBase64 bm9kZQBub2RlX21vZHVsZXMvdml0ZXN0L3ZpdGVzdC5tanMAcnVuAHNyYy9tYWluL2RpYWdub3N0aWNzL19fdGVzdHNfXy9EaWFnbm9zdGljc1NjaGVtYXMudGVzdC50cwBzcmMvbWFpbi9kaWFnbm9zdGljcy9fX3Rlc3RzX18vRGlhZ25vc3RpY3NTbmFwc2hvdFByb3ZpZGVyLnRlc3QudHMAc3JjL21haW4vZmlsZXMvX190ZXN0c19fL1NhZmVVc2VyU2VsZWN0ZWRXcml0ZXIudGVzdC50cwBzcmMvbWFpbi9kaWFnbm9zdGljcy9fX3Rlc3RzX18vRGlhZ25vc3RpY3NFeHBvcnRlci50ZXN0LnRzAHNyYy9tYWluL2RpYWdub3N0aWNzL19fdGVzdHNfXy9EaWFnbm9zdGljc0V4cG9ydGVyLnJlbGVhc2UudGVzdC50cwBzcmMvbWFpbi9pcGMvX190ZXN0c19fL2RpYWdub3N0aWNzLnRlc3QudHM=; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`

Run (observed green): `& ([IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'WindowsPowerShell\v1.0\powershell.exe')) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\release\tdd-evidence-launcher.ps1 -Phase green -CaseIds SEC-57 -CommandId diagnostics-ipc -ChildArgumentsBase64 bm9kZQBub2RlX21vZHVsZXMvdml0ZXN0L3ZpdGVzdC5tanMAcnVuAHNyYy9tYWluL2xvZ2dpbmcvX190ZXN0c19fL1N0cnVjdHVyZWRMb2dnZXIudGVzdC50cwBzcmMvbWFpbi9sb2dnaW5nL19fdGVzdHNfXy9TdHJ1Y3R1cmVkTG9nZ2VyLnJlbGVhc2UudGVzdC50cwBzcmMvbWFpbi9kaWFnbm9zdGljcy9fX3Rlc3RzX18vUmVuZGVyZXJFcnJvckNvbGxlY3Rvci50ZXN0LnRzAHNyYy9tYWluL2lwYy9fX3Rlc3RzX18vZGlhZ25vc3RpY3MudGVzdC50cwBzcmMvcHJlbG9hZC9fX3Rlc3RzX18vaW5kZXgudGVzdC50cwBzcmMvcHJlbG9hZC9fX3Rlc3RzX18vdHJhbnNwb3J0LXN1cmZhY2UudGVzdC50cwBzcmMvcHJlbG9hZC9fX3Rlc3RzX18vcHVibGljLWlwYy10cmFuc3BvcnQudGVzdC50cwBzcmMvcmVuZGVyZXIvX190ZXN0c19fL3B1YmxpYy1hcGktZmFjYWRlLnRlc3QudHMAc3JjL3JlbmRlcmVyL19fdGVzdHNfXy9yZW5kZXJlci1ib290c3RyYXAudGVzdC50cw==; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`

Run (observed green): `& ([IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'WindowsPowerShell\v1.0\powershell.exe')) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\release\tdd-evidence-launcher.ps1 -Phase green -CaseIds FDB-50,FDB-51,FDB-52,FDB-53,FDB-54 -CommandId beta-feedback -ChildArgumentsBase64 bm9kZQBub2RlX21vZHVsZXMvdml0ZXN0L3ZpdGVzdC5tanMAcnVuAHNyYy9tYWluL2ZlZWRiYWNrL19fdGVzdHNfXy9CZXRhRmVlZGJhY2tTZXJ2aWNlLnRlc3QudHMAc3JjL21haW4vaXBjL19fdGVzdHNfXy9mZWVkYmFjay50ZXN0LnRzAHNyYy9wcmVsb2FkL19fdGVzdHNfXy9pbmRleC50ZXN0LnRzAHNyYy9wcmVsb2FkL19fdGVzdHNfXy90cmFuc3BvcnQtc3VyZmFjZS50ZXN0LnRzAHNyYy9wcmVsb2FkL19fdGVzdHNfXy9wdWJsaWMtaXBjLXRyYW5zcG9ydC50ZXN0LnRzAHNyYy9yZW5kZXJlci9fX3Rlc3RzX18vcHVibGljLWFwaS1mYWNhZGUudGVzdC50cw==; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`

- [ ] **Step 3: Run independent top-level verification**

Run: `npm run typecheck`

Run: `npm run lint`

Run: `npm test`

Run: `npm run build`

Every command must exit 0; do not summarize a failure as passed.

- [ ] **Step 4: Run the controlled RC pipeline**

Run phase A to create and freeze the immutable candidate without emitting a final gate:

`npm run release:rc -- --freeze`

Run phase B on each required Windows test workstation to install/inspect copies of the exact frozen bytes and collect its assigned GUI/manual fragment, for example:

`npm run release:manual-evidence -- --freeze release-validation/candidate-freeze.json --fragment release-validation/manual-fragments/win11.json --items WIN11_X64,DPI_125,DPI_150 --allow-system-mutation`

Transfer only the resulting canonical fragment and referenced screenshots back beneath the release workstation's ignored `release-validation/manual-fragments/`, then merge all required environments:

`npm run release:manual-evidence:merge -- --freeze release-validation/candidate-freeze.json --fragments release-validation/manual-fragments --report release-validation/manual-release-evidence.json`

Run phase C to validate the same hashes, execute automated acceptance, and finish the gate:

`npm run release:rc -- --resume --manual-evidence release-validation/manual-release-evidence.json --allow-system-mutation`

Allow real Windows GUI time for installer/update/uninstaller actions. Each workstation first verifies the frozen inner ledger and never receives signing secrets, source working changes, credentials, or user data. `--resume` rejects a changed commit, context, metadata, installer, icon, manifest, inner ledger, evidence challenge, stale/duplicate/conflicting fragment, missing Win10/Win11/DPI item, or already-consumed completion token. Tests cover missing evidence, mutation between phases, restart after interrupted evidence collection, cross-freeze replay, and duplicate resume. Store screenshot hashes under the ignored evidence root; do not bypass the requirement.

- [ ] **Step 5: Independently re-hash final evidence**

Snapshot the authoritative receipt hash/mtime, the outer `SHA256SUMS.txt` file's own hash/mtime, every inner/outer-ledger entry hash/mtime, and the complete sorted canonical-delivery relative-name set; then run `npm run release:verify -- --check-only --no-write`. Recompute the immutable manifest and final-report hashes, verify every `ARTIFACT_SHA256SUMS.txt` and outer `SHA256SUMS.txt` entry, scan retained reports/artifacts for credentials and absolute paths, confirm no owned Electron/Node/Claude/MCP process remains, and prove the receipt, ledger file, every covered hash/mtime, and the file set are unchanged with no addition or deletion.

- [ ] **Step 6: Recheck Git boundaries**

Require task15 and stable main tracked status clean, task15 on branch `task15`, stable main unchanged, no tags created, no remote push/publish, and no tracked generated artifacts.

- [ ] **Step 7: Report truthfully**

If all Beta requirements pass, report `PASS_FOR_CLOSED_BETA` and simultaneously `BLOCKED_FOR_PUBLIC_GA`. Otherwise report `closedBetaReady=false` with exact failed/blocked/needs-manual items. Never report either `PUBLIC_GA_READY` or `PUBLIC_GA READY`.
