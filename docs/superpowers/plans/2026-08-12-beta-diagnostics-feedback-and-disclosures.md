# Beta Diagnostics, Feedback, UI, and Disclosures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce useful but strictly bounded Beta diagnostics, local-first feedback entry points, truthful About/Help surfaces, and complete draft legal/Beta documentation without inventing a license, publisher, privacy approval, or vendor affiliation.

**Architecture:** Typed snapshot providers project already-existing runtime services into aggregate DTOs before the exporter sees them. Feedback is generated from the same bounded snapshot, saved or copied locally, and may open only an optional fixed build-configured page. One bundled-document service opens a filename allowlist; About and all Beta docs consume the same release/disclosure facts.

**Tech Stack:** TypeScript, Zod, Electron shell/dialog, React, existing ZIP exporter/logger, Vitest, Markdown.

## Global Constraints

- Diagnostics and feedback are opt-in and local until a user explicitly saves, copies, or opens a separately configured feedback page. There is no background upload, telemetry, analytics, or crash-report service.
- Never export task result text, prompts, responses, Git diff/content, source files, project/user paths, database contents, provider endpoints, keys/tokens/passwords/cookies/headers, `credential_ref`, vault paths, raw environment, raw process command lines, or raw stack traces.
- Every diagnostic member is on a fixed filename allowlist and is validated by a strict output schema before ZIP assembly.
- UI never renders an arbitrary external link or local path supplied by Renderer state. Main owns all dialogs, bundled paths, and external URL allowlists.
- Use the exact Chinese independence statement required by the user in About, README, Beta guide, and installer. Do not claim Anthropic/OpenAI authorization or endorsement.
- Documentation is explicitly draft where legal approval is missing. Do not add an OSS license or set `package.json.license` to a guessed value.

---

### Task 1: Strict diagnostic schemas and service snapshot provider

**Files:**
- Create: `src/main/diagnostics/DiagnosticsSchemas.ts`
- Create: `src/main/diagnostics/DiagnosticsSnapshotProvider.ts`
- Create: `src/main/files/SafeUserSelectedWriter.ts`
- Create test: `src/main/diagnostics/__tests__/DiagnosticsSchemas.test.ts`
- Create test: `src/main/diagnostics/__tests__/DiagnosticsSnapshotProvider.test.ts`
- Create test: `src/main/files/__tests__/SafeUserSelectedWriter.test.ts`
- Modify: `src/main/diagnostics/DiagnosticsExporter.ts`
- Modify: `src/main/ipc/diagnostics.ts`
- Modify: `src/main/index.ts`
- Modify test: `src/main/ipc/__tests__/diagnostics.test.ts`
- Modify test: `src/main/diagnostics/__tests__/DiagnosticsExporter.test.ts`
- Modify test: `src/main/diagnostics/__tests__/DiagnosticsExporter.release.test.ts`

**Interfaces:**
- Produces: `DiagnosticsSnapshotSchema` and `DiagnosticsSnapshot`.
- Produces: `DiagnosticsSnapshotProvider.snapshot(): Promise<DiagnosticsSnapshot>`.
- Produces: `writeNewUserSelectedFile(selection, writer): Promise<'saved' | 'destination_exists' | 'unsafe_destination'>`.
- Consumes safe getters from ReleaseMetadata, UpdateManager, AppDatabase or future-schema inspector, ProcessSupervisor, CrashRecoveryManager, provider registry, and feature flags.

```ts
export interface DiagnosticsSnapshot {
  release: ReleaseDiagnostics;
  update: UpdateDiagnostics;
  database: DatabaseDiagnostics;
  processes: ProcessDiagnostics;
  recovery: RecoveryDiagnostics;
  providers: ProviderDiagnostics;
  rendererErrors: RendererErrorDiagnostics;
  featureFlags: FeatureFlagDiagnostics;
}
```

- [ ] **Step 1: Write failing schema projection tests**

Create hostile service fixtures containing paths, URLs, query credentials, tokens, `credential_ref`, vault names, prompts, result text, diffs, SQL rows, command lines, and stack traces. Require strict schema rejection for unknown DTO keys and require serialized snapshots to exclude every sentinel. Test both ready and future-schema database modes.

- [ ] **Step 2: Run focused tests and observe missing modules**

Run (observed red): `& ([IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'WindowsPowerShell\v1.0\powershell.exe')) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\release\tdd-evidence-launcher.ps1 -Phase red -CaseIds DIA-37,DIA-38,DIA-39,DIA-40,DIA-41,DIA-42,DIA-43,DIA-44 -CommandId diagnostics-export -ChildArgumentsBase64 bm9kZQBub2RlX21vZHVsZXMvdml0ZXN0L3ZpdGVzdC5tanMAcnVuAHNyYy9tYWluL2RpYWdub3N0aWNzL19fdGVzdHNfXy9EaWFnbm9zdGljc1NjaGVtYXMudGVzdC50cwBzcmMvbWFpbi9kaWFnbm9zdGljcy9fX3Rlc3RzX18vRGlhZ25vc3RpY3NTbmFwc2hvdFByb3ZpZGVyLnRlc3QudHMAc3JjL21haW4vZGlhZ25vc3RpY3MvX190ZXN0c19fL0RpYWdub3N0aWNzRXhwb3J0ZXIudGVzdC50cwBzcmMvbWFpbi9kaWFnbm9zdGljcy9fX3Rlc3RzX18vRGlhZ25vc3RpY3NFeHBvcnRlci5yZWxlYXNlLnRlc3QudHM=; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`


- [ ] **Step 3: Define exact aggregate DTOs**

Release: version/channel/build ID/commit short/signature category/feed configured and installation method (`nsis-user|development|unknown`). Update: state/feed class/channel/hash/signature/backup categories and bounded last-error code. Database: mode/schema/integrity/size bucket/entity counts only. Processes: managed counts by kind/state and zero-residual flag, never PID or command. Recovery: pending journal counts/last category/backup integrity. Providers: configured counts by provider kind and credential-status enum, never identifier or endpoint. Renderer errors: count/category/time bucket. Feature flags: fixed boolean keys only.

- [ ] **Step 4: Project then validate**

Each service adapter constructs a new plain object from named getters; it never spreads a service return object. Validate each section independently and the final object with `.strict()`. Provider/process/recovery/database sources are explicit optional dependencies with availability enums so future-schema mode never constructs missing services. Convert unexpected service exceptions into fixed availability categories while logging only the component/category.

- [ ] **Step 5: Make the exporter accept only the snapshot**

Replace open `Record<string, unknown>` version/system inputs with typed values. The ZIP allowlist is exactly:

```text
manifest.json
release.json
update.json
database-summary.json
process-summary.json
recovery-summary.json
provider-summary.json
renderer-errors.json
feature-flags.json
log-summary.json
error-summary.json
```

No raw or redacted log tail is ever exported. `log-summary.json` and `error-summary.json` contain only allowlisted logger category, level, event ID, count, and UTC time bucket. Unknown event IDs, ordinary message text, non-JSON lines, stack traces, and arbitrary fields are dropped. StructuredLogger redaction remains defense in depth for local logs, never the ZIP security boundary. No dynamically discovered file is added. Optional performance/system summaries belong only to the separate, explicit Beta Feedback template path with their own strict DTOs; the diagnostics ZIP has no performance member.

Wire `DiagnosticsSnapshotProvider` into the existing `src/main/ipc/diagnostics.ts` and `src/main/index.ts` factories for both normal and future-schema modes; remove the old open version/system/database getter inputs rather than maintaining parallel exporter paths.

Both diagnostics and later feedback saving reuse `SafeUserSelectedWriter`. Accept only a Main-owned Save dialog result with the exact expected extension and a currently nonexistent target. Bind/recheck the parent realpath and reject a reparse/symlink parent or target; open with `wx`/mode `0o600`, bind the new regular file identity, write only through that exclusive handle/stream, fsync, close, and recheck identity. Never overwrite. On failure, remove only the still-identical incomplete file; otherwise leave it and return a bounded cleanup failure. Tests cover existing target, reparse/junction parent, swap before/after open, short write, fsync/close failure, and identity-safe cleanup. No selected path or basename enters Renderer, logs, diagnostics, or retained reports.

- [ ] **Step 6: Re-run tests and amend**

Run: `git add -N -- src/main/diagnostics/DiagnosticsSchemas.ts src/main/diagnostics/DiagnosticsSnapshotProvider.ts src/main/files/SafeUserSelectedWriter.ts src/main/diagnostics/DiagnosticsExporter.ts src/main/ipc/diagnostics.ts src/main/diagnostics/__tests__/DiagnosticsSchemas.test.ts src/main/diagnostics/__tests__/DiagnosticsSnapshotProvider.test.ts src/main/files/__tests__/SafeUserSelectedWriter.test.ts src/main/diagnostics/__tests__/DiagnosticsExporter.test.ts src/main/diagnostics/__tests__/DiagnosticsExporter.release.test.ts src/main/ipc/__tests__/diagnostics.test.ts` (intent-to-add for diagnostics-export: makes new final-green inputs index-visible; it is not final staging or a commit).

Run (diagnostic green, not recorded): `node node_modules/vitest/vitest.mjs run src/main/diagnostics/__tests__/DiagnosticsSchemas.test.ts src/main/diagnostics/__tests__/DiagnosticsSnapshotProvider.test.ts src/main/files/__tests__/SafeUserSelectedWriter.test.ts src/main/diagnostics/__tests__/DiagnosticsExporter.test.ts src/main/diagnostics/__tests__/DiagnosticsExporter.release.test.ts src/main/ipc/__tests__/diagnostics.test.ts`

Expected: PASS. The single approved observed green for `diagnostics-export` is deferred to Subplan 5's final observation phase, after every planned modification to its owned paths.

Run: `git add src/main/diagnostics/DiagnosticsSchemas.ts src/main/diagnostics/DiagnosticsSnapshotProvider.ts src/main/files/SafeUserSelectedWriter.ts src/main/diagnostics/DiagnosticsExporter.ts src/main/ipc/diagnostics.ts src/main/index.ts src/main/diagnostics/__tests__/DiagnosticsSchemas.test.ts src/main/diagnostics/__tests__/DiagnosticsSnapshotProvider.test.ts src/main/files/__tests__/SafeUserSelectedWriter.test.ts src/main/diagnostics/__tests__/DiagnosticsExporter.test.ts src/main/diagnostics/__tests__/DiagnosticsExporter.release.test.ts src/main/ipc/__tests__/diagnostics.test.ts && git commit --amend --no-edit`

### Task 2: Renderer-error aggregation and strengthened redaction

**Files:**
- Modify: `src/main/logging/StructuredLogger.ts`
- Modify test: `src/main/logging/__tests__/StructuredLogger.test.ts`
- Modify test: `src/main/logging/__tests__/StructuredLogger.release.test.ts`
- Create: `src/main/diagnostics/RendererErrorCollector.ts`
- Create test: `src/main/diagnostics/__tests__/RendererErrorCollector.test.ts`
- Modify: `src/main/ipc/diagnostics.ts`
- Modify: `src/shared/types/ipc.ts`
- Modify test: `src/main/ipc/__tests__/diagnostics.test.ts`
- Modify: `src/preload/index.ts`
- Modify test: `src/preload/__tests__/index.test.ts`
- Modify test: `src/preload/__tests__/transport-surface.test.ts`
- Modify test: `src/preload/__tests__/public-ipc-transport.test.ts`
- Modify: `tests/typecheck/public-ipc-main.ts`
- Modify test: `src/renderer/__tests__/public-api-facade.test.ts`
- Modify: `src/renderer/renderer-bootstrap.ts`
- Modify test: `src/renderer/__tests__/renderer-bootstrap.test.ts`

**Interfaces:**
- Produces: `RendererErrorCollector.record(input): void` and `.summary(): RendererErrorDiagnostics`.
- Adds an authenticated invoke returning `Promise<void>` and carrying only `{ category }`; Main owns time/rate limits.

- [ ] **Step 1: Write failing redaction/error tests**

Cover camel/snake/kebab/case variants of API key, secret, token, password, cookie, authorization, credential ref, vault, feed URL, database path, prompt, completion, diff, stack, and command. Add cyclic/proxy/throwing-getter values. Put secrets in unknown keys, ordinary `message`, and non-JSON local log lines and prove none enters the ZIP summary. Renderer tests dispatch `error` and `unhandledrejection` containing sentinels and assert only a fixed category crosses IPC.

- [ ] **Step 2: Run the failing tests**

Run (observed red): `& ([IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'WindowsPowerShell\v1.0\powershell.exe')) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\release\tdd-evidence-launcher.ps1 -Phase red -CaseIds SEC-57 -CommandId diagnostics-ipc -ChildArgumentsBase64 bm9kZQBub2RlX21vZHVsZXMvdml0ZXN0L3ZpdGVzdC5tanMAcnVuAHNyYy9tYWluL2xvZ2dpbmcvX190ZXN0c19fL1N0cnVjdHVyZWRMb2dnZXIudGVzdC50cwBzcmMvbWFpbi9sb2dnaW5nL19fdGVzdHNfXy9TdHJ1Y3R1cmVkTG9nZ2VyLnJlbGVhc2UudGVzdC50cwBzcmMvbWFpbi9kaWFnbm9zdGljcy9fX3Rlc3RzX18vUmVuZGVyZXJFcnJvckNvbGxlY3Rvci50ZXN0LnRzAHNyYy9tYWluL2lwYy9fX3Rlc3RzX18vZGlhZ25vc3RpY3MudGVzdC50cwBzcmMvcHJlbG9hZC9fX3Rlc3RzX18vaW5kZXgudGVzdC50cwBzcmMvcHJlbG9hZC9fX3Rlc3RzX18vdHJhbnNwb3J0LXN1cmZhY2UudGVzdC50cwBzcmMvcHJlbG9hZC9fX3Rlc3RzX18vcHVibGljLWlwYy10cmFuc3BvcnQudGVzdC50cwBzcmMvcmVuZGVyZXIvX190ZXN0c19fL3B1YmxpYy1hcGktZmFjYWRlLnRlc3QudHMAc3JjL3JlbmRlcmVyL19fdGVzdHNfXy9yZW5kZXJlci1ib290c3RyYXAudGVzdC50cw==; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`


- [ ] **Step 3: Harden recursive redaction**

Use an explicit sensitive-key normalizer, depth/member/string limits, `WeakSet` cycle detection, safe primitive coercion, and URL sanitizer that removes userinfo/query/fragment and then returns only an allowlisted origin label. Unknown objects become `[unavailable]`; redaction itself never throws.

- [ ] **Step 4: Add bounded Renderer error reporting**

Renderer maps exceptions locally to `render|event_handler|promise|resource|unknown`; it sends neither time, message, name, stack, component props, URL, nor user data. Main authenticates the main frame through the existing fulfilled invoke boundary, parses a strict tuple, injects its clock, rate-limits, creates five-minute UTC buckets, and aggregates in memory.

- [ ] **Step 5: Re-run tests and amend**

Run: `git add -N -- src/main/diagnostics/RendererErrorCollector.ts src/main/diagnostics/__tests__/RendererErrorCollector.test.ts src/main/logging/__tests__/StructuredLogger.release.test.ts src/preload/__tests__/public-ipc-transport.test.ts src/renderer/__tests__/public-api-facade.test.ts src/renderer/__tests__/renderer-bootstrap.test.ts` (intent-to-add for diagnostics-ipc: makes new final-green inputs index-visible; it is not final staging or a commit).

Run (diagnostic green, not recorded): `node node_modules/vitest/vitest.mjs run src/main/logging/__tests__/StructuredLogger.test.ts src/main/logging/__tests__/StructuredLogger.release.test.ts src/main/diagnostics/__tests__/RendererErrorCollector.test.ts src/main/ipc/__tests__/diagnostics.test.ts src/preload/__tests__/index.test.ts src/preload/__tests__/transport-surface.test.ts src/preload/__tests__/public-ipc-transport.test.ts src/renderer/__tests__/public-api-facade.test.ts src/renderer/__tests__/renderer-bootstrap.test.ts`

Expected: PASS. The single approved observed green for `diagnostics-ipc` is deferred to Subplan 5's final observation phase, after every planned modification to its owned paths.

Run (supporting, not numbered evidence): `npm run typecheck`

Run: `git add src/main/logging/StructuredLogger.ts src/main/logging/__tests__/StructuredLogger.test.ts src/main/logging/__tests__/StructuredLogger.release.test.ts src/main/diagnostics/RendererErrorCollector.ts src/main/diagnostics/__tests__/RendererErrorCollector.test.ts src/main/ipc/diagnostics.ts src/shared/types/ipc.ts src/main/ipc/__tests__/diagnostics.test.ts src/preload/index.ts src/preload/__tests__/index.test.ts src/preload/__tests__/transport-surface.test.ts src/preload/__tests__/public-ipc-transport.test.ts tests/typecheck/public-ipc-main.ts src/renderer/__tests__/public-api-facade.test.ts src/renderer/renderer-bootstrap.ts src/renderer/__tests__/renderer-bootstrap.test.ts && git commit --amend --no-edit`

### Task 3: Local-first Beta feedback service and authenticated IPC

**Files:**
- Create: `src/shared/types/feedback.ts`
- Create: `src/main/feedback/BetaFeedbackService.ts`
- Create test: `src/main/feedback/__tests__/BetaFeedbackService.test.ts`
- Create: `src/main/ipc/feedback.ts`
- Create: `src/main/ipc/__tests__/feedback.test.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/files/SafeUserSelectedWriter.ts`
- Create: `src/shared/feedback-config.json`
- Modify: `vite.main.config.ts`
- Modify: `src/types.d.ts`
- Modify: `electron-builder.yml`
- Modify: `src/preload/index.ts`
- Modify: `src/shared/types/ipc.ts`
- Modify: `tests/typecheck/public-ipc-main.ts`
- Modify test: `src/preload/__tests__/index.test.ts`
- Modify test: `src/preload/__tests__/transport-surface.test.ts`

**Interfaces:**
- Produces: `getBetaFeedbackTemplate(input): Promise<string>`.
- Produces: `saveBetaFeedbackReport(input): Promise<boolean | null>`.
- Produces: `openBetaFeedbackPage(): Promise<'opened' | 'unconfigured'>`.

- [ ] **Step 1: Write failing service/IPC tests**

Test local template content, cancel/save, safe default filename, UTF-8 LF output, existing/reparse/raced destination rejection through the shared exclusive writer, missing external URL, allowed fixed HTTPS feedback origin/path, query/userinfo/fragment rejection, build-config/runtime-config mismatch, forged frames, extra args, arbitrary destination rejection, task-result sentinel exclusion, hostile existing system-diagnostics paths, and service exceptions mapped to bounded errors. The app proves only that it launches the exact compiled URL without data; subsequent system-browser navigation/redirects are outside app control and are not falsely asserted impossible.

- [ ] **Step 2: Run the failing tests**

Run (observed red): `& ([IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'WindowsPowerShell\v1.0\powershell.exe')) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\release\tdd-evidence-launcher.ps1 -Phase red -CaseIds FDB-50,FDB-51,FDB-52,FDB-53,FDB-54 -CommandId beta-feedback -ChildArgumentsBase64 bm9kZQBub2RlX21vZHVsZXMvdml0ZXN0L3ZpdGVzdC5tanMAcnVuAHNyYy9tYWluL2ZlZWRiYWNrL19fdGVzdHNfXy9CZXRhRmVlZGJhY2tTZXJ2aWNlLnRlc3QudHMAc3JjL21haW4vaXBjL19fdGVzdHNfXy9mZWVkYmFjay50ZXN0LnRzAHNyYy9wcmVsb2FkL19fdGVzdHNfXy9pbmRleC50ZXN0LnRzAHNyYy9wcmVsb2FkL19fdGVzdHNfXy90cmFuc3BvcnQtc3VyZmFjZS50ZXN0LnRz; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`


- [ ] **Step 3: Define the safe feedback input**

```ts
export interface BetaFeedbackContext {
  entryPoint: 'about' | 'help' | 'recovery' | 'task_failure';
  includeDiagnosticsSummary: boolean;
  includeSystemSummary: boolean;
  includePerformanceSummary: boolean;
}
```

All three include flags default to false in the UI. Define separate strict `FeedbackSystemSummary` and `FeedbackPerformanceSummary` DTOs; never reuse the existing system diagnostics object because it carries executable paths. The Markdown template contains empty user-editable fields for version, Build ID, Windows version, new install versus upgrade, task type, summary, reproduction steps, expected/actual behavior, repeatability, impact, and willingness to provide a separately exported diagnostic package. It adds only user-selected bounded summaries, explicitly tells users not to paste credentials or private source, and never accepts task text or a failure message as input. “Export diagnostics” is the separate explicit path for a reviewed package containing aggregate log summaries; screenshots are attached manually after review. Diagnostic/log package, system summary, performance summary, and screenshots all default off.

- [ ] **Step 4: Implement local save and optional external page**

Main owns `showSaveDialog`; `saveBetaFeedbackReport()` writes only the generated template through `SafeUserSelectedWriter`, never overwrites an existing selection, and returns only a bounded result. `src/shared/feedback-config.json` is the only tracked build contract and initially stores `{ "id": "unconfigured", "url": null }`; a future URL change requires source review. Vite embeds its exact bytes and builder copies the same file. Main validates both copies, and `openBetaFeedbackPage()` accepts only a fixed HTTPS origin/path with no userinfo/query/fragment/nonstandard port or returns `unconfigured`. Runtime environment and Renderer cannot replace it. It never appends diagnostics, IDs, query parameters, or user content.

- [ ] **Step 5: Add strict handlers and minimal preload methods**

Authenticate trusted main frame first, parse strict tuples, and expose only the three named methods. Copying the generated template uses the Renderer clipboard only after the user's click; no background clipboard read/write occurs.

- [ ] **Step 6: Re-run tests/typecheck and amend**

Run: `git add -N -- src/shared/types/feedback.ts src/shared/feedback-config.json src/main/feedback/BetaFeedbackService.ts src/main/ipc/feedback.ts src/main/feedback/__tests__/BetaFeedbackService.test.ts src/main/ipc/__tests__/feedback.test.ts src/preload/__tests__/public-ipc-transport.test.ts src/renderer/__tests__/public-api-facade.test.ts` (intent-to-add for beta-feedback: makes new final-green inputs index-visible; it is not final staging or a commit).

Run (diagnostic green, not recorded): `node node_modules/vitest/vitest.mjs run src/main/feedback/__tests__/BetaFeedbackService.test.ts src/main/ipc/__tests__/feedback.test.ts src/preload/__tests__/index.test.ts src/preload/__tests__/transport-surface.test.ts src/preload/__tests__/public-ipc-transport.test.ts src/renderer/__tests__/public-api-facade.test.ts`

Expected: PASS. The single approved observed green for `beta-feedback` is deferred to Subplan 5's final observation phase, after every planned modification to its owned paths.

Run (supporting, not numbered evidence): `npm run typecheck`

Run: `git add src/shared/types/feedback.ts src/shared/feedback-config.json src/main/files/SafeUserSelectedWriter.ts src/main/feedback/BetaFeedbackService.ts src/main/feedback/__tests__/BetaFeedbackService.test.ts src/main/ipc/feedback.ts src/main/ipc/__tests__/feedback.test.ts src/main/index.ts vite.main.config.ts src/types.d.ts electron-builder.yml src/preload/index.ts src/shared/types/ipc.ts tests/typecheck/public-ipc-main.ts src/preload/__tests__/index.test.ts src/preload/__tests__/transport-surface.test.ts src/preload/__tests__/public-ipc-transport.test.ts src/renderer/__tests__/public-api-facade.test.ts && git commit --amend --no-edit`

### Task 4: Feedback entry points and truthful About/Help UI

**Files:**
- Create: `src/renderer/features/feedback/BetaFeedbackActions.tsx`
- Create test: `src/renderer/features/feedback/__tests__/BetaFeedbackActions.test.tsx`
- Modify: `src/renderer/features/settings/SettingsDialog.tsx`
- Modify test: `src/renderer/features/settings/__tests__/SettingsRelease.test.ts`
- Modify: `src/renderer/features/recovery/RecoveryCenter.tsx`
- Modify test: `src/renderer/features/recovery/__tests__/RecoveryCenter.test.ts`
- Modify: `src/renderer/features/chat/TaskResultCard.tsx`
- Create test: `src/renderer/features/chat/__tests__/TaskResultCard.test.tsx`
- Modify: `src/renderer/components/TopToolbar.tsx`
- Create test: `src/renderer/components/__tests__/TopToolbarHelp.test.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/i18n/en-US.ts`
- Modify: `src/renderer/i18n/zh-CN.ts`
- Modify test: `src/renderer/i18n/__tests__/i18n.test.ts`

**Interfaces:**
- Produces reusable `<BetaFeedbackActions entryPoint />`.
- Extends About with release/signing/feed/license/privacy/independence status.

- [ ] **Step 1: Write failing interaction/accessibility tests**

Test About, Help, Recovery Center, and failed-task entry points; copy/save/open-page success/cancel/unconfigured/error; busy/disabled states; keyboard activation; focus return; live-region status; Chinese/English parity; and the absence of task error text in feedback API calls.

- [ ] **Step 2: Run the failing UI tests**

Run: `npm exec vitest -- run src/renderer/features/feedback/__tests__/BetaFeedbackActions.test.tsx src/renderer/features/settings/__tests__/SettingsRelease.test.ts src/renderer/features/recovery/__tests__/RecoveryCenter.test.ts src/renderer/features/chat/__tests__/TaskResultCard.test.tsx src/renderer/components/__tests__/TopToolbarHelp.test.tsx src/renderer/i18n/__tests__/i18n.test.ts`

- [ ] **Step 3: Build the reusable feedback actions**

Buttons are “Copy feedback template”, “Save feedback report…”, and “Open feedback page” only when configured. Each click independently requests a fresh bounded template. Display fixed success/failure status, never the returned template or selected path.

- [ ] **Step 4: Complete About status disclosure**

Show version/channel/build ID/commit short, packaged state, signature status, production-feed configured yes/no, automatic check setting, project-license status `Decision required`, privacy status `Draft`, and a visible closed-Beta/public-GA distinction. Opening About remains offline; only the explicit update-check button touches the configured feed.

- [ ] **Step 5: Add the exact independence statement**

Display verbatim in About and Help:

> Claude Workbench 是独立第三方软件，与 Anthropic、OpenAI 及其关联公司不存在官方隶属、授权或背书关系。

Do not prepend “official”, use vendor logos, or imply compatibility certification.

- [ ] **Step 6: Re-run tests and amend**

Run: `npm exec vitest -- run src/renderer/features/feedback/__tests__/BetaFeedbackActions.test.tsx src/renderer/features/settings/__tests__/SettingsRelease.test.ts src/renderer/features/recovery/__tests__/RecoveryCenter.test.ts src/renderer/features/chat/__tests__/TaskResultCard.test.tsx src/renderer/components/__tests__/TopToolbarHelp.test.tsx src/renderer/i18n/__tests__/i18n.test.ts`

Run: `git add src/renderer/features/feedback/BetaFeedbackActions.tsx src/renderer/features/feedback/__tests__/BetaFeedbackActions.test.tsx src/renderer/features/settings/SettingsDialog.tsx src/renderer/features/settings/__tests__/SettingsRelease.test.ts src/renderer/features/recovery/RecoveryCenter.tsx src/renderer/features/recovery/__tests__/RecoveryCenter.test.ts src/renderer/features/chat/TaskResultCard.tsx src/renderer/features/chat/__tests__/TaskResultCard.test.tsx src/renderer/components/TopToolbar.tsx src/renderer/components/__tests__/TopToolbarHelp.test.tsx src/renderer/App.tsx src/renderer/i18n/en-US.ts src/renderer/i18n/zh-CN.ts src/renderer/i18n/__tests__/i18n.test.ts && git commit --amend --no-edit`

### Task 5: Bundled document allowlist and disclosures

**Files:**
- Create: `src/main/release/BundledDocumentService.ts`
- Create test: `src/main/release/__tests__/BundledDocumentService.test.ts`
- Create: `scripts/generate-bundled-document-catalog.mjs`
- Create generated/tracked: `build-resources/bundled-documents.json`
- Modify: `vite.main.config.ts`
- Modify: `src/types.d.ts`
- Create: `src/main/ipc/documents.ts`
- Modify: `src/main/index.ts`
- Create test: `src/main/ipc/__tests__/documents.test.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/shared/types/ipc.ts`
- Modify test: `src/preload/__tests__/index.test.ts`
- Modify test: `src/preload/__tests__/transport-surface.test.ts`
- Modify test: `src/preload/__tests__/public-ipc-transport.test.ts`
- Modify: `tests/typecheck/public-ipc-main.ts`
- Modify test: `src/renderer/__tests__/public-api-facade.test.ts`
- Modify: `electron-builder.yml`
- Modify: `README.md`
- Create: `SECURITY.md`
- Create: `docs/legal/LICENSE-DECISION-REQUIRED.md`
- Create: `docs/legal/THIRD-PARTY-NOTICES.md`
- Create: `docs/legal/PRIVACY-DRAFT.md`
- Create: `docs/legal/BETA-TERMS-DRAFT.md`
- Create: `docs/legal/DATA-FLOW.md`
- Create: `docs/beta/BETA-TESTING-GUIDE.md`
- Create: `docs/beta/KNOWN-LIMITATIONS.md`
- Create: `docs/beta/RELEASE-CHECKLIST.md`
- Create: `docs/beta/FEEDBACK-TEMPLATE.md`
- Create: `docs/beta/ROLLBACK-AND-RECOVERY.md`
- Modify: `docs/releases/1.0.1-rc.1.md`
- Create test: `tests/release/release-documents.test.ts`

**Interfaces:**
- Produces: exhaustive `BUNDLED_DOCUMENTS` catalog and `openBundledDocument(id)`.
- Produces: one canonical release-notes source hashed by ReleaseMetadata/feed/manifest.

- [ ] **Step 1: Write failing document/package tests**

Deep-equal the exhaustive `{id, sourcePath, packagedPath}` catalog below, regenerate and compare catalog bytes/hashes, and test development/packaged roots, regular-file requirement, realpath containment, missing file, symlink/reparse escape, arbitrary ID/path, file mutation after catalog, nonempty `shell.openPath()` error, exact disclaimer presence, draft labels, release-notes version/channel parity, README license correction, and electron-builder mappings exactly equal to the catalog (plus the catalog resource itself). README tests require links plus installation, controlled local upgrade, default-preserving uninstall, separate explicit local-data cleanup, feedback, release commands, unsigned/feed/license/privacy/legal status, and no GA claim.

- [ ] **Step 2: Run the failing tests**

Run: `npm exec vitest -- run src/main/release/__tests__/BundledDocumentService.test.ts src/main/ipc/__tests__/documents.test.ts src/preload/__tests__/index.test.ts src/preload/__tests__/transport-surface.test.ts src/preload/__tests__/public-ipc-transport.test.ts src/renderer/__tests__/public-api-facade.test.ts tests/release/release-documents.test.ts`

- [ ] **Step 3: Implement a fixed bundled-document service**

The exhaustive mapping is:

| ID | Source path | Packaged path |
| --- | --- | --- |
| `privacy-draft` | `docs/legal/PRIVACY-DRAFT.md` | `docs/legal/PRIVACY-DRAFT.md` |
| `beta-terms-draft` | `docs/legal/BETA-TERMS-DRAFT.md` | `docs/legal/BETA-TERMS-DRAFT.md` |
| `data-flow` | `docs/legal/DATA-FLOW.md` | `docs/legal/DATA-FLOW.md` |
| `testing-guide` | `docs/beta/BETA-TESTING-GUIDE.md` | `docs/beta/BETA-TESTING-GUIDE.md` |
| `known-limitations` | `docs/beta/KNOWN-LIMITATIONS.md` | `docs/beta/KNOWN-LIMITATIONS.md` |
| `release-checklist` | `docs/beta/RELEASE-CHECKLIST.md` | `docs/beta/RELEASE-CHECKLIST.md` |
| `feedback-template` | `docs/beta/FEEDBACK-TEMPLATE.md` | `docs/beta/FEEDBACK-TEMPLATE.md` |
| `rollback-recovery` | `docs/beta/ROLLBACK-AND-RECOVERY.md` | `docs/beta/ROLLBACK-AND-RECOVERY.md` |
| `asset-notices` | `docs/legal/ASSET-NOTICES.md` | `docs/legal/ASSET-NOTICES.md` |
| `license-decision` | `docs/legal/LICENSE-DECISION-REQUIRED.md` | `docs/legal/LICENSE-DECISION-REQUIRED.md` |
| `third-party-notices-status` | `docs/legal/THIRD-PARTY-NOTICES.md` | `docs/legal/THIRD-PARTY-NOTICES.md` |
| `release-notes` | `docs/releases/1.0.1-rc.1.md` | `docs/releases/1.0.1-rc.1.md` |
| `security` | `SECURITY.md` | `docs/SECURITY.md` |

`scripts/generate-bundled-document-catalog.mjs --write` hashes those tracked files into canonical tracked `build-resources/bundled-documents.json`; `--verify` must match. Vite compiles that catalog into Main and electron-builder copies the exact catalog plus exactly the named source→packaged mappings. Main requires embedded/resource catalog equality, a Zod enum ID, a regular non-symlink Markdown file, realpath containment, and file-hash parity before `shell.openPath()`; it returns only `opened|unavailable` and never exposes the path or raw `shell.openPath()` error to Renderer. It never depends on the post-build external release manifest and exposes no generic filesystem/open API.

- [ ] **Step 4: Write truthful legal and Beta documents**

Privacy draft describes local data categories, userData/project/backup/log locations by display label, retention controls, diagnostics/feedback consent, update-network behavior, and unanswered controller/contact/jurisdiction fields. Beta terms cover risk, backups, support, expiry, redistribution restrictions pending legal review, and no GA claim. Data flow maps Renderer↔Main↔local Claude Code subprocess/SQLite, the direct connection to the user-selected Provider, and optional user-triggered feed/feedback page; it distinguishes Workbench policy from Provider retention, states that no Workbench hosted compute/cloud-sync/telemetry backend is implemented, and states `默认不上传遥测或诊断信息`. License decision doc states no project license has been selected and removes the false README MIT statement.

- [ ] **Step 5: Write operational Beta docs and release notes**

Testing guide covers SmartScreen, first run, Provider setup, project open, read-only/edit tasks, allow/deny permissions, Diff, Checkpoint restore, history/crash recovery, diagnostics, update, uninstall, and feedback. Known limitations names the unsigned package, Claude-Code-only runtime, OpenAI-compatible execution boundary, missing production feed/certificate/final legal review, model WebSearch/WebFetch variability, non-Git Checkpoint limits, Windows native-module dependency, and untrusted historical 1.0.0 chain. `RELEASE-CHECKLIST.md` mirrors automated versus manual closed-Beta/GA gates; `FEEDBACK-TEMPLATE.md` is the version-controlled human-readable source matched by the generated local template. Recovery guidance never instructs deletion of user projects. `docs/releases/1.0.1-rc.1.md` is the only release-note source; updater metadata, About, metadata snapshot, and manifest store its SHA-256.

- [ ] **Step 6: Add the exact statement to required documents**

README and `BETA-TESTING-GUIDE.md` contain verbatim:

> Claude Workbench 是独立第三方软件，与 Anthropic、OpenAI 及其关联公司不存在官方隶属、授权或背书关系。

The installer source from Subplan 1 and About from Task 4 contain the same bytes after UTF-8 normalization.

- [ ] **Step 7: Add SECURITY.md without inventing a contact**

Document supported closed-Beta scope, local reporting route through the feedback template, secret-handling expectations, coordinated remediation process, and a clearly labeled `SECURITY_CONTACT=DECISION_REQUIRED` blocker. Do not publish an email address or SLA.

- [ ] **Step 8: Package only the allowlisted documents**

Add individual `extraResources` mappings exactly matching the table plus the tracked catalog; do not package all repository docs, specs, plans, tests, or source. The About/UI action is labeled “Third-party notices status”, not “Third Party Notices”. The packaged static `docs/legal/THIRD-PARTY-NOTICES.md` explicitly says it is a status/explanation page and names the separately delivered `THIRD_PARTY_NOTICES.txt` plus `sbom.cdx.json`; it is never overwritten by generated content. The external generated TXT/SBOM are release artifacts only, not installer resources, and the delivery gate proves their relative names/hashes travel with the installer. Unknown-license status in that generated TXT remains a closed-Beta gate unless an exact owner/legal acceptance record exists.

- [ ] **Step 9: Generate and verify the final tracked catalog**

After every source document and builder mapping has its final bytes, run `node scripts/generate-bundled-document-catalog.mjs --write`, stage the resulting catalog, then run `node scripts/generate-bundled-document-catalog.mjs --verify`. A later document mutation must fail verification and require an intentional catalog regeneration/review.

- [ ] **Step 10: Run the complete subplan verification**

Run: `npm exec vitest -- run src/main/diagnostics/__tests__/DiagnosticsSchemas.test.ts src/main/diagnostics/__tests__/DiagnosticsSnapshotProvider.test.ts src/main/diagnostics/__tests__/DiagnosticsExporter.test.ts src/main/diagnostics/__tests__/DiagnosticsExporter.release.test.ts src/main/logging/__tests__/StructuredLogger.release.test.ts src/main/diagnostics/__tests__/RendererErrorCollector.test.ts src/main/feedback/__tests__/BetaFeedbackService.test.ts src/main/ipc/__tests__/feedback.test.ts src/main/release/__tests__/BundledDocumentService.test.ts src/main/ipc/__tests__/documents.test.ts src/preload/__tests__/index.test.ts src/preload/__tests__/transport-surface.test.ts src/preload/__tests__/public-ipc-transport.test.ts src/renderer/__tests__/public-api-facade.test.ts src/renderer/features/feedback/__tests__/BetaFeedbackActions.test.tsx src/renderer/features/settings/__tests__/SettingsRelease.test.ts src/renderer/features/recovery/__tests__/RecoveryCenter.test.ts src/renderer/features/chat/__tests__/TaskResultCard.test.tsx src/renderer/components/__tests__/TopToolbarHelp.test.tsx src/renderer/i18n/__tests__/i18n.test.ts tests/release/release-documents.test.ts && npm run typecheck && node scripts/generate-bundled-document-catalog.mjs --verify`

- [ ] **Step 11: Amend the reviewed subplan checkpoint**

Run: `git add src/main/release/BundledDocumentService.ts src/main/release/__tests__/BundledDocumentService.test.ts scripts/generate-bundled-document-catalog.mjs build-resources/bundled-documents.json vite.main.config.ts src/types.d.ts src/main/ipc/documents.ts src/main/index.ts src/main/ipc/__tests__/documents.test.ts src/preload/index.ts src/shared/types/ipc.ts src/preload/__tests__/index.test.ts src/preload/__tests__/transport-surface.test.ts src/preload/__tests__/public-ipc-transport.test.ts tests/typecheck/public-ipc-main.ts src/renderer/__tests__/public-api-facade.test.ts electron-builder.yml README.md SECURITY.md docs/legal/LICENSE-DECISION-REQUIRED.md docs/legal/THIRD-PARTY-NOTICES.md docs/legal/PRIVACY-DRAFT.md docs/legal/BETA-TERMS-DRAFT.md docs/legal/DATA-FLOW.md docs/beta/BETA-TESTING-GUIDE.md docs/beta/KNOWN-LIMITATIONS.md docs/beta/RELEASE-CHECKLIST.md docs/beta/FEEDBACK-TEMPLATE.md docs/beta/ROLLBACK-AND-RECOVERY.md docs/releases/1.0.1-rc.1.md tests/release/release-documents.test.ts && git commit --amend --no-edit`
