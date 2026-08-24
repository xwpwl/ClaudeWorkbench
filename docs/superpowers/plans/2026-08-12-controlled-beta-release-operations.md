# Controlled Beta & Release Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a provenance-bound, unsigned Windows 1.0.1-rc.1 candidate that can truthfully pass the closed-Beta gate while remaining blocked for public GA.

**Architecture:** One build-time `ReleaseMetadata` snapshot is consumed by the existing installer, updater, diagnostics, About UI, and release scripts. Five ordered subplans extend existing components and finish with a fail-closed, two-phase `release:rc` evidence graph: freeze immutable candidate bytes, collect hash-bound manual evidence, then resume acceptance/finalization. Generated artifacts remain ignored.

**Tech Stack:** Electron 35.7.5, electron-builder 26.15.3/NSIS, electron-updater 6.8.9, resolved TypeScript 5.9.3, React 19, Zod 4.4.3, better-sqlite3 13.0.2, Vitest 3, supported Node 22/24 and npm 11 release scripts.

## Global Constraints

- Work only in the current `task15` worktree on branch `task15`; discover the stable `main` worktree through Git metadata and require it clean at `eb1a07bb950769cf24d0fe5c61c710fed4da0fba` without persisting its machine path.
- The target package version is exactly `1.0.1-rc.1`; the release channel is exactly `rc`.
- Reuse the existing electron-builder/NSIS installer, `UpdateManager`, `DiagnosticsExporter`, `StructuredLogger`, `CrashRecoveryManager`, `ProcessSupervisor`, `AppDatabase`, and `CredentialStore`.
- Do not copy, trace, transform, package, or reference the rejected legacy icon hashes `e1a4cd6d…46066`, `95c49caa…4ead`, or `047f755c…5047`.
- Do not include or imitate Anthropic, Claude/Claude Code, OpenAI, ChatGPT/Codex, Microsoft, GitHub, VS Code, or other vendor marks.
- Keep Renderer sandboxing, `contextIsolation: true`, `nodeIntegration: false`, strict Zod IPC tuples, trusted main-frame checks, BYOK, local-first storage, and explicit user authorization.
- Never auto-download, auto-install, force restart, enable downgrade, upload diagnostics, upload feedback, or hard-code a pretend production feed.
- Never print or package API keys, tokens, passwords, cookies, Authorization headers, `credential_ref`, vault paths, signing secrets, authenticated URLs, user source, prompts, Git diffs, databases, logs, or machine-absolute source paths.
- Do not choose a software license, publishing entity, contact identity, jurisdiction, final privacy policy, or final product-name legal conclusion.
- An unsigned candidate must be reported as `NotSigned`; do not create a self-signed certificate or claim trust.
- `closedBetaReady` and `publicGaReady` are orthogonal; Task 15 always has `publicGaReady=false` and `BLOCKED_FOR_PUBLIC_GA`.
- Any unresolved P0/P1 or closed-Beta-required `NEEDS_MANUAL_EVIDENCE` item sets `closedBetaReady=false`; GA-only manual blockers remain reported without changing that orthogonal Beta result.
- Do not create a tag, push, publish, or merge. Keep one final task15 commit named exactly `chore(release): prepare controlled beta candidate`; after each accepted task stage only intended files and run `git commit --amend --no-edit`.
- Never stage `node_modules`, `dist`, `release`, `release-validation`, installers, feeds, SBOM output, manifests, checksums, logs, databases, diagnostic ZIPs, signing material, test userData, or temporary conversion files.

---

### Task 0: Commit the reviewed plan set and bootstrap append-only TDD evidence

**Files:**
- Modify: `package.json`
- Create: `scripts/release/requirements-contract.mjs`
- Create: `scripts/release/lib/tdd-evidence.mjs`
- Create: `scripts/release/tdd-evidence.mjs`
- Create: `scripts/release/tdd-evidence-launcher.ps1`
- Create: `scripts/release/tdd-evidence-toolchain.json`
- Create test: `tests/release/release-tdd-evidence.test.ts`
- Modify: `docs/superpowers/specs/2026-08-12-controlled-beta-release-operations-design.md`
- Create/track: this orchestrator and all five linked subplan documents

**Interfaces:**
- Produces: exact immutable 60-ID `TDD_REQUIREMENT_CASES`, each with description, planned focused test references, and related source/test paths.
- Produces: `runObservedTddCommand({ phase, caseIds, commandId, runner })` and append-only ignored `release-validation/tdd/requirements-tdd-evidence.json`.
- Produces: Windows-only official pre-JavaScript launcher whose already-loaded reviewed code and literal four-entry project-input table form the scoped project trust anchor, plus the approved Node version/SHA-256 contract.

- [ ] **Step 1: Run `npm ci` from the clean lockfile, without changing package/lock bytes**
- [ ] **Step 2: Write and run the focused Vitest test, observing failures for green-without-red, overwrite, raw-output, secret/path, and chronology rejection**
- [ ] **Step 3: Implement the Node-built-in atomic recorder library plus thin CLI; it stores only case IDs, phase, allowlisted command ID, exit/result category, UTC/monotonic sequence, planned test refs, and relative tracked-file hashes**
- [ ] **Step 4: Require nonzero for an observed red and zero for its later green; allow a missing planned implementation source only on red, require it and its hash on green, and never store argv/cwd/stdout/stderr/environment/raw error**
- [ ] **Step 5: Deep-equal all 60 IDs/descriptions and map implementation slices as follows: Foundation VER-01–META-12 and INS-13–20; Artifact SIG-21–25/SBM-45–49/SEC-58–60; Updater UPD-26–36 and SEC-56; Diagnostics/Feedback DIA-37–44/FDB-50–54 and SEC-57; Foundation release IPC SEC-55. A case may cite more than one slice, but no ID may be omitted or reassigned.**
- [ ] **Step 6: Add the checked-in trusted PowerShell launcher/toolchain contract and a fail-closed `release:tdd-evidence` compatibility alias; re-run the focused recorder test green**
- [ ] **Step 7: Confirm the reviewed design and all six plan documents are already tracked in the planning checkpoint; stage the recorder library/CLI/test (and only any review-driven plan corrections), run `git commit --amend --no-edit`, and require a clean tracked/untracked source status before Subplan 1**

Every numbered slice records one behavioral red at its implementation task and one green in Subplan 5 Task 7's frozen final observation phase, after every planned tracked-source modification. Both commands use this recorder with the exact IDs from the contract. The later Windows evidence collector validates the append-only history; it does not manufacture historical entries after implementation.

The executable observation slices are frozen here so no implementer has to infer case ownership. Each named implementation task contains its full copyable red command and exact intent-to-add prerequisite; all twelve full copyable green commands appear together in the final observation phase. Every official recorder command invokes the checked-in launcher from an OS-known-folder-derived absolute System32 Windows PowerShell and supplies the exact child argument vector as UTF-8 Base64 of NUL-separated values so the nested Windows PowerShell native boundary cannot reinterpret quotes or separators. The scoped project trust anchor is the already-loaded, reviewed launcher code and its literal table of exactly four approved project-input SHA-256 values. Its self-lock stabilizes only the loaded launcher's pathname; it does not authenticate launcher bytes, so pre-load launcher replacement is outside this closure. Those hashes never come from the project toolchain manifest and are never accepted or updated automatically at runtime. The launcher decodes and validates the argument array; canonical/non-reparse checks, opens, identity-binds, and retains all four project inputs before reading any of their bytes; hashes only the held streams; strict-UTF-8 parses the toolchain from its held stream; validates the identity-bound installed Node; and repeats the four pathname/short-handle identity and final-path comparisons immediately before `Process.Start()`. It contains Node and descendants in a Windows job and confirms exit before releasing held handles on success or exception, creates a minimal environment with no caller Node/runtime injection variables or PATH, fixes cwd, and starts Node without a shell. Only that official launcher route provides pre-JavaScript preload protection. The package alias deliberately exits without invoking the recorder, and direct `node scripts/release/tdd-evidence.mjs` is unsupported; neither may be used for evidence or cited as preload-safe because npm/direct Node can consume caller preload state before recorder JavaScript. The launcher gives the recorder a fresh per-process environment-plus-pipe challenge, so a plain direct invocation or caller-set environment alone cannot enable recording; the challenge is defense in depth, not a general authorization secret. Schema/harness/unit tests not listed here may run normally but cannot satisfy a numbered requirement.

| Command ID | Exact case IDs | Subplan task |
| --- | --- | --- |
| `foundation-version-metadata` | `VER-01`–`VER-07`, `META-08`–`META-12` | Foundation Task 1 |
| `foundation-installer` | `INS-13`–`INS-20` | Foundation Task 3 |
| `foundation-release-ipc` | `SEC-55` | Foundation Task 4 |
| `artifact-signing` | `SIG-21`–`SIG-25` | Artifact Task 3 |
| `artifact-sbom` | `SBM-45`–`SBM-49` | Artifact Task 4 |
| `artifact-package-scans` | `SEC-58`–`SEC-60` | Artifact Task 5 |
| `updater-source-policy` | `UPD-26`, `UPD-28`, `UPD-29` | Updater Task 3 |
| `updater-install-safety` | `UPD-30`–`UPD-36` | Updater Task 4 |
| `updater-ipc` | `UPD-27`, `SEC-56` | Updater Task 5 |
| `diagnostics-export` | `DIA-37`–`DIA-44` | Diagnostics Task 1 |
| `diagnostics-ipc` | `SEC-57` | Diagnostics Task 2 |
| `beta-feedback` | `FDB-50`–`FDB-54` | Diagnostics Task 3 |

`requirements-contract.mjs` deep-equals this expanded 60-ID assignment, requires each ID exactly once, allowlists only these command IDs/test references, exports the frozen final green order, and exports one unambiguous path→last-slice mapping for the collector. Red and green for a slice use the same case list and command ID. A plain Vitest rerun can aid diagnosis but never creates requirement evidence.

---

## Ordered Subplans

| Order | Plan | Independently testable output | Consumes |
| ---: | --- | --- | --- |
| 1 | [Release foundation and original assets](2026-08-12-release-foundation-and-assets.md) | Versioned app, embedded metadata, tracked original icon, consistent installer/window identity | Approved design |
| 2 | [Artifact integrity and release tooling](2026-08-12-release-artifact-integrity.md) | Preflight, canonical staging build plus hash-bound inventory, signing truth, SBOM/notices, manifest, scans, command skeleton | Subplan 1 metadata/assets |
| 3 | [Controlled updater and database safety](2026-08-12-controlled-updater-and-data-safety.md) | Main-only RC feed policy, verified download, pre-install backup, future-schema recovery | Subplans 1–2 contracts |
| 4 | [Diagnostics, feedback, UI, and disclosures](2026-08-12-beta-diagnostics-feedback-and-disclosures.md) | Strict diagnostic projection, local feedback, truthful About/Help, legal/Beta docs | Subplans 1–3 runtime facts |
| 5 | [Windows acceptance and final gates](2026-08-12-windows-release-acceptance-and-gates.md) | Installer/update/uninstall evidence, performance/package reports, final 40-item gate | All prior subplans |

### Task 1: Execute and review release foundation

**Files:**
- Plan: `docs/superpowers/plans/2026-08-12-release-foundation-and-assets.md`
- Review: all files listed by that plan

**Interfaces:**
- Produces: `ReleaseMetadata`, `ReleaseVersionInfo`, tracked `build-resources/app-icon.{svg,png,ico}`, `resolveAppIconPath()`.
- Consumes: approved design and existing `VersionInfo`/electron-builder paths.

- [ ] **Step 1: Execute every checkbox in the subplan, recording the numbered behavioral reds and running diagnostic green reruns**
- [ ] **Step 2: Run the subplan's focused verification command**
- [ ] **Step 3: Review the diff for legacy-icon bytes, absolute paths, duplicate version sources, and installer identity drift**
- [ ] **Step 4: Stage only reviewed source/tests/assets/docs and run `git commit --amend --no-edit`**
- [ ] **Step 5: Confirm `git status --short` is empty before continuing**

### Task 2: Execute and review artifact integrity

**Files:**
- Plan: `docs/superpowers/plans/2026-08-12-release-artifact-integrity.md`
- Review: all files listed by that plan

**Interfaces:**
- Produces: report schemas; a separately reviewed release-toolchain policy and owned Windows supervisor/target-Job runner with a two-function production API, no fixture descriptors, and exact-source test-only coverage for its controller, canonical descriptor literal, and private parent protocol/cleanup engine; diagnostic `release:preflight`; canonical `release-validation/staging/build-output`; distinct preflight/build StageResults whose sole evidence references are frozen externally with the canonical inventory hash; `loadBoundBuildInventory(...)`; signing checks, SBOM/notices, manifest/checksums, and artifact scanners.
- Consumes: Subplan 1 metadata and asset hashes.

- [ ] **Step 1: Execute every checkbox in the subplan with injected tests instead of weakening release gates**
- [ ] **Step 2: Run the subplan's focused verification command**
- [ ] **Step 3: Review report ordering for cycles and scan outputs for secrets or absolute paths**
- [ ] **Step 4: Stage only reviewed files and run `git commit --amend --no-edit`**
- [ ] **Step 5: Confirm no generated release evidence is staged**

### Task 3: Execute and review updater/data safety

**Files:**
- Plan: `docs/superpowers/plans/2026-08-12-controlled-updater-and-data-safety.md`
- Review: all files listed by that plan

**Interfaces:**
- Produces: `UpdateSourcePolicy`, richer `UpdateSnapshot`, verified download/install guard, `createVerifiedBackup(...)`, and `DatabaseStartupResult` recovery mode.
- Consumes: Subplan 1 metadata/channel and Subplan 2 signature/hash result vocabulary.

- [ ] **Step 1: Execute every checkbox in the subplan, recording the numbered behavioral reds and running focused diagnostic green reruns**
- [ ] **Step 2: Run update, database, IPC, preload, renderer, and migration focused suites**
- [ ] **Step 3: Review redirect/query/credential handling, backup failure semantics, and degraded-mode handler allowlist**
- [ ] **Step 4: Stage only reviewed files and run `git commit --amend --no-edit`**
- [ ] **Step 5: Confirm the app still refuses downgrade and never auto-downloads/installs**

### Task 4: Execute and review diagnostics/feedback/disclosures

**Files:**
- Plan: `docs/superpowers/plans/2026-08-12-beta-diagnostics-feedback-and-disclosures.md`
- Review: all files listed by that plan

**Interfaces:**
- Produces: strict diagnostics projections, local-only feedback API, bundled-document allowlist, release/About UI, legal/Beta docs.
- Consumes: Subplans 1–3 public metadata, update, backup, signing, and runtime summaries.

- [ ] **Step 1: Execute every checkbox in the subplan, recording the numbered behavioral reds and running focused diagnostic green reruns**
- [ ] **Step 2: Run diagnostic sentinel, IPC/preload transport, About/feedback, and i18n suites**
- [ ] **Step 3: Review every DTO and generated Markdown/ZIP member for prohibited values**
- [ ] **Step 4: Stage only reviewed files and run `git commit --amend --no-edit`**
- [ ] **Step 5: Confirm the exact independent-third-party statement is present in all four required surfaces**

### Task 5: Execute Windows acceptance and final gate

**Files:**
- Plan: `docs/superpowers/plans/2026-08-12-windows-release-acceptance-and-gates.md`
- Review: all files listed by that plan

**Interfaces:**
- Produces: hash-bound test/installer/update/uninstall/performance/package evidence and `final-report.json`.
- Consumes: every prior subplan, including the frozen `ARTIFACT-BUILD-WIN` reference and its bound installer/unpacked-tree inventory; acceptance never discovers candidates in `release/`.

- [ ] **Step 1: Execute the acceptance-harness TDD tasks without using the untrusted 1.0.0 package as a successful updater origin**
- [ ] **Step 2: Amend all accepted implementation into the single required commit**
- [ ] **Step 3: From the clean commit record all twelve final greens in frozen order, then run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run release:rc -- --freeze`, the hash-bound `release:manual-evidence` collector, and finally `npm run release:rc -- --resume ...`**
- [ ] **Step 4: Review ignored evidence and independently verify every final-gate input hash**
- [ ] **Step 5: Recheck task15/main SHAs and tracked cleanliness; do not tag, push, publish, or merge**
