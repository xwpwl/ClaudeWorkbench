# Controlled Updater and Database Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the one existing `UpdateManager` into an explicit-consent RC updater with strict feed/redirect policy, download integrity evidence, and a verified pre-install database backup; make future-schema startup recoverable without opening or mutating the database.

**Architecture:** Main owns feed configuration, redirects, downloads, hashing, signature inspection, backup, and installation. Renderer receives a bounded state projection through authenticated IPC. A database bootstrap inspector chooses either the existing full app or a recovery-only renderer path before `AppDatabase` opens the file.

**Tech Stack:** Electron session/net APIs, electron-updater, Zod, better-sqlite3, React, Vitest.

## Global Constraints

- Keep the existing single `UpdateManager`; do not introduce a second updater or update service.
- Defaults remain `autoDownload=false`, `autoInstallOnAppQuit=false`, `allowDowngrade=false`, and automatic checks disabled.
- Only explicit user actions may check, download, or install. Install requires a second confirmation and a verified backup immediately before `quitAndInstall()`.
- Feed URLs never cross preload/Renderer, appear in diagnostics, or enter logs/reports. Reject credentials, query strings, fragments, non-canonical paths, disallowed hosts, and unsafe redirects.
- Loopback HTTP exists only in the compile-time-isolated, non-releasable RC0 fixture build; it is always labeled `local-acceptance`, never production. The RC1 candidate contains no runtime acceptance switch.
- A download is not installable until expected SHA-512, actual SHA-512, version/channel, and Authenticode status are recorded.
- A newer database schema is never migrated, opened read-write, downgraded, renamed, deleted, or replaced.

---

### Task 1: Read-only database bootstrap and future-schema result

**Files:**
- Modify: `src/main/database/Database.ts`
- Create: `src/shared/types/databaseCompatibility.ts`
- Create: `src/main/database/DatabaseBootstrap.ts`
- Create test: `src/main/database/__tests__/DatabaseBootstrap.test.ts`
- Modify test: `src/main/database/__tests__/Database.test.ts`

**Interfaces:**
- Exports: `SUPPORTED_SCHEMA_VERSION` from the existing migration source.
- Produces: `inspectDatabaseCompatibility(path): DatabaseCompatibilityInspection`.
- Produces: `bootstrapDatabase(path): DatabaseStartupResult`.

```ts
export type DatabaseStartupResult =
  | { mode: 'ready'; database: AppDatabase }
  | {
      mode: 'future_schema';
      inspection: ReadonlyDatabaseInspection;
      foundSchemaVersion: number;
      supportedSchemaVersion: number;
      backupDirectoryLabel: string;
    }
  | { mode: 'unavailable'; category: 'corrupt' | 'locked' | 'inaccessible' | 'changed_during_inspection' };
```

- [ ] **Step 1: Write failing bootstrap tests**

Cover absent database, schema 0, every supported migration fixture, current schema, future schema, corrupt header, locked file, read-only filesystem, DB/WAL/SHM family, no new source sidecar, injected clock, source replacement between inspection and open, and a spy proving `AppDatabase` is not constructed for future-schema or unavailable results. Hash/stat the entire database family before and after inspection and require identical identity/bytes/mtime.

- [ ] **Step 2: Run focused tests and observe missing bootstrap symbols**

Run: `npm exec vitest -- run src/main/database/__tests__/DatabaseBootstrap.test.ts src/main/database/__tests__/Database.test.ts`

- [ ] **Step 3: Implement read-only inspection before normal open**

Classify the source family as `absent|compatible|future_schema|unavailable`. For an existing DB, bind db/wal/shm realpath, Windows file identity, lstat, size, and full SHA-256, copy the stable family without following reparse points into a private validated temporary inspection root, and open only that copy with `better-sqlite3(..., { readonly: true, fileMustExist: true })`; do not use `immutable=1`, which could ignore visible WAL state. Run `PRAGMA query_only=ON`, read `PRAGMA user_version`, `PRAGMA integrity_check(1)`, and only fixed metadata queries. Close/delete the validated copy in `finally`, then require the source family identity/hash/stat unchanged. Every schema/integrity fact comes from the private copy; the final source recheck never opens a SQLite connection on the source. Only `absent` and `compatible` may proceed to `AppDatabase`.

For `compatible`, immediately before constructing `AppDatabase`, recheck the whole source family against the bound realpath/file-ID/lstat/size/full-hash facts without opening SQLite. Pass those facts and the schema expectation into its constructor; after opening and before any write PRAGMA, legacy move, or migration, it rechecks the same identities and reads only `user_version`, then aborts if it differs from the already inspected value. Move the existing `journal_mode=WAL` call after those checks. For `absent`, recheck that db/wal/shm are all absent, create the DB path exclusively with `wx`, bind that empty file's identity, and require the constructor to open that exact file; if any family member appears or the reserved file is replaced, return `changed_during_inspection` with zero `AppDatabase` constructions/migrations. Tests instrument constructor count and prove future/corrupt/locked/raced inputs never create an AppDatabase or new source sidecar.

- [ ] **Step 4: Project only safe inspection data**

`ReadonlyDatabaseInspection` contains schema versions, integrity category, database byte size bucket, and a display-only backup directory label. It excludes the database path, table/column contents, project paths, user prompts, credentials, and SQL errors.

- [ ] **Step 5: Re-run tests and amend**

Run: `npm exec vitest -- run src/main/database/__tests__/DatabaseBootstrap.test.ts src/main/database/__tests__/Database.test.ts`

Run: `git add src/main/database/Database.ts src/shared/types/databaseCompatibility.ts src/main/database/DatabaseBootstrap.ts src/main/database/__tests__/DatabaseBootstrap.test.ts src/main/database/__tests__/Database.test.ts && git commit --amend --no-edit`

### Task 2: Verified backup service for update and recovery

**Files:**
- Modify: `src/main/database/Database.ts`
- Create: `src/main/database/DatabaseBackupService.ts`
- Create test: `src/main/database/__tests__/DatabaseBackupService.test.ts`

**Interfaces:**
- Produces: `AppDatabase.backupTo(destination): Promise<void>`.
- Produces: `createVerifiedBackup({ source: { kind: 'live'; database: AppDatabase }, destinationPolicy }): Promise<VerifiedDatabaseBackup>`.

```ts
export interface VerifiedDatabaseBackup {
  displayName: string;
  createdAtUtc: string;
  schemaVersion: number;
  sha256: string;
  byteSize: number;
  integrity: 'ok';
}
```

- [ ] **Step 1: Write failing backup tests**

Test WAL-backed live data, Unicode and spaces, collision-free UTC names, a destination beneath the fixed app-owned backup root, parent/root reparse-junction/symlink rejection, same-volume sibling partial, partial file identity/collision, source/backup schema parity, integrity-check failure, hash failure, disk-full/permission errors, exact incomplete-file cleanup, and no source mutation. Verify the returned object has no absolute path.

- [ ] **Step 2: Run the failing tests**

Run: `npm exec vitest -- run src/main/database/__tests__/DatabaseBackupService.test.ts`

- [ ] **Step 3: Implement SQLite-native backup and verification**

Use the open connection's `backup(destination)` API so WAL state is captured. Resolve and bind a regular non-reparse app-owned backup root, create a unique same-volume `.partial` sibling with exclusive creation, and retain its file identity. Reopen the completed partial read-only, require `PRAGMA integrity_check(1)='ok'` and exact `user_version`, then hash the bytes. Atomically rename only after verification; on failure delete only the still-identical bound partial.

- [ ] **Step 4: Re-run tests and amend**

Run: `npm exec vitest -- run src/main/database/__tests__/DatabaseBackupService.test.ts`

Run: `git add src/main/database/Database.ts src/main/database/DatabaseBackupService.ts src/main/database/__tests__/DatabaseBackupService.test.ts && git commit --amend --no-edit`

### Task 3: Strict RC feed and redirect policy

**Files:**
- Create: `src/main/release/UpdateSourcePolicy.ts`
- Create: `src/main/release/UpdateTransportGuard.ts`
- Create test: `src/main/release/__tests__/UpdateSourcePolicy.test.ts`
- Create test: `src/main/release/__tests__/UpdateTransportGuard.test.ts`
- Modify: `src/main/release/UpdateManager.ts`
- Modify test: `src/main/release/__tests__/UpdateManager.test.ts`
- Modify: `src/main/index.ts`
- Modify: `vite.main.config.ts`
- Modify: `vite.renderer.config.ts`
- Modify: `src/types.d.ts`

**Interfaces:**
- Produces: `parseUpdateSource(raw, mode): UpdateSource`.
- Produces: `installUpdateTransportGuard(session, source): Disposable`.
- Consumes: `UPDATE_FEED_URL` in main only, fixed release channel `rc`, and compile-time `__WORKBENCH_LOCAL_UPDATE_FIXTURE__`.

```ts
export type CandidateUpdateSource =
  { kind: 'production'; origin: string; pathnamePrefix: '/claude-workbench/rc/' };

export type FixtureUpdateSource =
  { kind: 'local-acceptance'; origin: string; pathnamePrefix: '/rc/' };
```

- [ ] **Step 1: Write an exhaustive policy table**

Candidate builds compile only `CandidateUpdateSource` and accept only HTTPS origins explicitly compiled into `APPROVED_UPDATE_ORIGINS` for production. The array remains empty for this RC, so it is unconfigured. The special RC0 source-copy build sets `__WORKBENCH_LOCAL_UPDATE_FIXTURE__=true` at compile time and instead includes the isolated `FixtureUpdateSource`, which accepts HTTP only for literal `127.0.0.1` or `[::1]` with a nonzero explicit port. There is no runtime `WORKBENCH_LOCAL_UPDATE_ACCEPTANCE` switch. Reject `localhost`, credentials, query, fragment, Unicode/IDN ambiguity, encoded separators/dot segments, backslashes, default-port drift, IP aliases, non-RC paths, trailing file names at source configuration, and URLs longer than 2048 characters.

Vite defines the fixture constant as `false` for every normal/development/candidate build; only the audited fixture build wrapper may set it true in its isolated copied source. Structure the local source, HTTP transport, label, and unsigned-admission modules behind that static branch so Rollup eliminates them from RC1. Package tests inspect final RC1 Main and Renderer bundles and require absence of `WORKBENCH_LOCAL_UPDATE_ACCEPTANCE`, the fixture compile-variable name, `local-acceptance`, loopback HTTP admission, and the NotSigned fixture-install branch. They inspect RC0 fixture bundles for the inverse expected marker and prove no dependency resolves through a parent worktree.

- [ ] **Step 2: Write redirect tests**

Test same-origin allowed RC paths, local-fixture redirect rejection, cross-origin redirects, HTTPS→HTTP downgrade, loopback→LAN/private IP, credentials introduced on redirect, encoded traversal, channel/version mismatch, redirect loops, electron-updater's fixed more-than-ten-hop rejection, repeated guard installation/disposal, and unrelated application traffic. Every updater request and redirected target is revalidated; unrelated traffic is not blocked.

- [ ] **Step 3: Run the failing tests**

Run (observed red): `& ([IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'WindowsPowerShell\v1.0\powershell.exe')) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\release\tdd-evidence-launcher.ps1 -Phase red -CaseIds UPD-26,UPD-28,UPD-29 -CommandId updater-source-policy -ChildArgumentsBase64 bm9kZQBub2RlX21vZHVsZXMvdml0ZXN0L3ZpdGVzdC5tanMAcnVuAHNyYy9tYWluL3JlbGVhc2UvX190ZXN0c19fL1VwZGF0ZVNvdXJjZVBvbGljeS50ZXN0LnRzAHNyYy9tYWluL3JlbGVhc2UvX190ZXN0c19fL1VwZGF0ZVRyYW5zcG9ydEd1YXJkLnRlc3QudHMAc3JjL21haW4vcmVsZWFzZS9fX3Rlc3RzX18vVXBkYXRlTWFuYWdlci50ZXN0LnRz; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`


- [ ] **Step 4: Implement main-only source configuration**

Read `UPDATE_FEED_URL` once during main startup. If absent, leave the updater unconfigured and checks fail closed with `feed_unconfigured`; the reserved `.invalid` URL in `app-update.yml` is cache bootstrap metadata and is never selected. If present, parse with the build-specific policy, set `client.logger=null`, and install guards on electron-updater's dedicated `client.netSession` partition (`electron-updater`, never `defaultSession`) before `setFeedURL()`.

Use cancellable `onBeforeRequest` to validate every initial and redirected target. Use cancellable `onHeadersReceived` to reject all 3xx responses in the fixture build and, for a production source, to parse/validate the single `Location` target before permitting it; the subsequent `onBeforeRequest` revalidates it. `onBeforeRedirect` is observation/assertion only because Electron provides no cancellation callback there. Rely on electron-updater 6.8.9's fixed ten-hop maximum. The guard owns the dedicated session listeners; disposal calls each registration with `null`, and reconfiguration must dispose the prior set first. Pass the canonical URL only to electron-updater and return/log only `{ kind, configured: true, originId }`, where `originId` is a fixed non-secret label.

Extend the existing injectable `UpdateClient` precisely with `setFeedURL(string)`, `channel`, `allowPrerelease`, `autoRunAppAfterInstall`, `logger`, `netSession.webRequest`, typed `on/removeListener` for `update-downloaded`/`error`, `checkForUpdates(): Promise<UpdateCheckResult | null>`, `downloadUpdate(): Promise<string[]>`, and `quitAndInstall()`. Normalize a null check result to bounded `no_result`, never dereference it. `src/main/index.ts` adapts the one real `autoUpdater`, fixes `channel='rc'`, `allowPrerelease=true`, and injects the source, transport, signature reader, database backup service, and cache-root resolver from the verified update-bootstrap contract into the existing `UpdateManager`.

- [ ] **Step 5: Preserve safe updater defaults**

In the constructor assert and set `autoDownload=false`, `autoInstallOnAppQuit=false`, `allowDowngrade=false`, and `autoRunAppAfterInstall=false`. The persisted `autoCheckUpdates` setting defaults to false; only an earlier explicit user opt-in may schedule a delayed check, and it still cannot download or install. Opening About never checks. The running process supplies fixed `win32/x64` facts; `UpdateInfo` itself has no platform/arch fields. Reject metadata unless version is greater than current, SemVer prerelease channel is `rc`, `files.length===1`, the file name is exactly `ClaudeWorkbench Setup <version>.exe`, SHA-512 is canonical base64, size is a positive safe integer, and release notes are a bounded string (arrays are rejected).

- [ ] **Step 6: Re-run tests and amend**

Run: `git add -N -- src/main/release/UpdateSourcePolicy.ts src/main/release/UpdateTransportGuard.ts src/main/release/UpdateManager.ts src/main/release/__tests__/UpdateSourcePolicy.test.ts src/main/release/__tests__/UpdateTransportGuard.test.ts src/main/release/__tests__/UpdateManager.test.ts` (intent-to-add for updater-source-policy: makes new final-green inputs index-visible; it is not final staging or a commit).

Run (diagnostic green, not recorded): `node node_modules/vitest/vitest.mjs run src/main/release/__tests__/UpdateSourcePolicy.test.ts src/main/release/__tests__/UpdateTransportGuard.test.ts src/main/release/__tests__/UpdateManager.test.ts`

Expected: PASS. The single approved observed green for `updater-source-policy` is deferred to Subplan 5's final observation phase, after every planned modification to its owned paths.

Run: `git add src/main/release/UpdateSourcePolicy.ts src/main/release/UpdateTransportGuard.ts src/main/release/UpdateManager.ts src/main/release/__tests__/UpdateSourcePolicy.test.ts src/main/release/__tests__/UpdateTransportGuard.test.ts src/main/release/__tests__/UpdateManager.test.ts src/main/index.ts vite.main.config.ts vite.renderer.config.ts src/types.d.ts && git commit --amend --no-edit`

### Task 4: Download hash/signature verification and guarded install

**Files:**
- Create: `src/main/release/UpdateSignatureInspector.ts`
- Create: `src/main/release/UpdateInstallGuard.ts`
- Create test: `src/main/release/__tests__/UpdateSignatureInspector.test.ts`
- Create test: `src/main/release/__tests__/UpdateInstallGuard.test.ts`
- Modify: `src/main/release/UpdateManager.ts`
- Modify: `src/shared/types/ipc.ts`
- Modify test: `src/main/release/__tests__/UpdateManager.test.ts`

**Interfaces:**
- Produces: `inspectDownloadedSignature(path): Promise<UpdateSignatureStatus>` by consuming `AuthenticodeStatusReader` from Subplan 2.
- Produces: `prepareForInstall(): Promise<PreparedUpdateInstall>`.
- Extends: `UpdateSnapshot` with bounded release facts.

```ts
export interface PreparedUpdateInstall {
  backupDisplayName: string;
  schemaVersion: number;
  backupIntegrity: 'ok';
  downloadedSha512: string;
  signatureStatus: 'Signed' | 'NotSigned' | 'NotTrusted' | 'Expired' | 'UnknownError';
}
```

- [ ] **Step 1: Write failing download/install state-machine tests**

Cover check-before-config, concurrent actions, wrong event order, disagreement between `downloadUpdate()`'s one returned path and `update-downloaded.downloadedFile`, metadata SHA-512 mismatch, mutated downloaded path, path outside the injected `updaterCacheDirName` root, symlink/reparse/hardlink, identity change during hash, wrong extension, every signature/feed-class combination, backup failure, database unavailable, repeated install, user cancels confirmation, updater error, and successful explicit check→download→confirm→backup→final stat/hash/signature→immediate install ordering. Assert DB hash is unchanged after every failure.

- [ ] **Step 2: Run the failing tests**

Run (observed red): `& ([IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'WindowsPowerShell\v1.0\powershell.exe')) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\release\tdd-evidence-launcher.ps1 -Phase red -CaseIds UPD-30,UPD-31,UPD-32,UPD-33,UPD-34,UPD-35,UPD-36 -CommandId updater-install-safety -ChildArgumentsBase64 bm9kZQBub2RlX21vZHVsZXMvdml0ZXN0L3ZpdGVzdC5tanMAcnVuAHNyYy9tYWluL3JlbGVhc2UvX190ZXN0c19fL1VwZGF0ZVNpZ25hdHVyZUluc3BlY3Rvci50ZXN0LnRzAHNyYy9tYWluL3JlbGVhc2UvX190ZXN0c19fL1VwZGF0ZUluc3RhbGxHdWFyZC50ZXN0LnRzAHNyYy9tYWluL3JlbGVhc2UvX190ZXN0c19fL1VwZGF0ZU1hbmFnZXIudGVzdC50cw==; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`


- [ ] **Step 3: Verify the exact downloaded installer**

Capture the expected file name/size/SHA-512 from validated metadata. Require the one path returned by `downloadUpdate()` to be identical to the `update-downloaded.downloadedFile` event. Resolve the allowed cache root from the generated `updaterCacheDirName` via an injected main-owned resolver, never a protected updater field. Bind candidate `lstat`, realpath, reparse status, link count, size, and Windows file identity; require a regular non-reparse single-link `.exe` beneath the bound root. Stream SHA-512, compare in constant time, then recheck the same identity/stat. A mismatch deletes only the still-identical bound cache file, resets state to `error`, and never touches the database.

- [ ] **Step 4: Guard installation with a fresh backup**

Signature admission is build/source-sensitive: the RC1 candidate contains only the production branch, which requires `Signed` with an owner-approved publisher subject/thumbprint. The RC0 fixture-only build contains the local source branch and may admit truthful `NotSigned` solely for its loopback candidate; `NotTrusted`, `Expired`, `UnknownError`, and hash failure always block. `prepareForInstall()` first records confirmation, creates a `pre-update` verified backup, then immediately rebinds and rechecks downloaded file identity/size/SHA-512/signature and calls `quitAndInstall(false, false)` without an intervening await. If any step fails, keep the running app usable, preserve the downloaded file for non-integrity failures, and expose a retryable safe category.

- [ ] **Step 5: Extend the Renderer projection**

The candidate `UpdateSnapshot` exposes only state, channel, version, notes, expected size, feed class (`unconfigured|production`), hash status, signature status, backup status, auto-check setting, and a bounded error category. The fixture compilation adds only the visible `local-acceptance` feed label needed by the harness. Both exclude URL, path, raw updater error, publisher details, headers, and environment.

- [ ] **Step 6: Re-run tests and amend**

Run: `git add -N -- src/main/release/UpdateSignatureInspector.ts src/main/release/UpdateInstallGuard.ts src/main/release/__tests__/UpdateSignatureInspector.test.ts src/main/release/__tests__/UpdateInstallGuard.test.ts` (intent-to-add for updater-install-safety: makes new final-green inputs index-visible; it is not final staging or a commit).

Run (diagnostic green, not recorded): `node node_modules/vitest/vitest.mjs run src/main/release/__tests__/UpdateSignatureInspector.test.ts src/main/release/__tests__/UpdateInstallGuard.test.ts src/main/release/__tests__/UpdateManager.test.ts`

Expected: PASS. The single approved observed green for `updater-install-safety` is deferred to Subplan 5's final observation phase, after every planned modification to its owned paths.

Run: `git add src/main/release/UpdateSignatureInspector.ts src/main/release/UpdateInstallGuard.ts src/main/release/UpdateManager.ts src/shared/types/ipc.ts src/main/release/__tests__/UpdateSignatureInspector.test.ts src/main/release/__tests__/UpdateInstallGuard.test.ts src/main/release/__tests__/UpdateManager.test.ts && git commit --amend --no-edit`

### Task 5: Authenticated update/database IPC and preload surface

**Files:**
- Modify: `src/main/ipc/release.ts`
- Create: `src/main/ipc/database-compatibility.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/shared/types/ipc.ts`
- Modify: `tests/typecheck/public-ipc-main.ts`
- Modify test: `src/main/ipc/__tests__/release.test.ts`
- Create test: `src/main/ipc/__tests__/database-compatibility.test.ts`
- Modify test: `src/preload/__tests__/index.test.ts`
- Modify test: `src/preload/__tests__/transport-surface.test.ts`

**Interfaces:**
- Produces: `registerReleaseVersionIPC()` separate from `registerUpdateIPC()`.
- Produces: `getDatabaseCompatibility()`, `exportDatabaseCompatibilityDiagnostics()`, `openApplicationBackupsFolder()`, and `exitRecoveryMode()`.
- Preserves: release methods from Subplan 1 with exact tuple schemas.

- [ ] **Step 1: Write failing trust/schema tests**

Test forged window, subframe, destroyed frame, extra tuple arguments, wrong confirmation literal, arbitrary destination path, oversized values, duplicate registration, exact future-schema handler allowlist, fixed backups-folder opening, and exit. No Renderer argument may carry a feed URL, file path, version, or hash.

- [ ] **Step 2: Run the failing transport tests**

Run (observed red): `& ([IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'WindowsPowerShell\v1.0\powershell.exe')) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\release\tdd-evidence-launcher.ps1 -Phase red -CaseIds UPD-27,SEC-56 -CommandId updater-ipc -ChildArgumentsBase64 bm9kZQBub2RlX21vZHVsZXMvdml0ZXN0L3ZpdGVzdC5tanMAcnVuAHNyYy9tYWluL2lwYy9fX3Rlc3RzX18vcmVsZWFzZS50ZXN0LnRzAHNyYy9tYWluL2lwYy9fX3Rlc3RzX18vZGF0YWJhc2UtY29tcGF0aWJpbGl0eS50ZXN0LnRzAHNyYy9wcmVsb2FkL19fdGVzdHNfXy9pbmRleC50ZXN0LnRzAHNyYy9wcmVsb2FkL19fdGVzdHNfXy90cmFuc3BvcnQtc3VyZmFjZS50ZXN0LnRz; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`


- [ ] **Step 3: Implement strict main-frame handlers**

Every handler first calls `assertTrustedMainFrame`, then parses a strict tuple. Compatibility reads, fixed backups-folder opening, and exit use `z.tuple([])`; diagnostic export accepts only a literal user confirmation and opens a main-owned save dialog. Split the existing release registrar so recovery mode registers version information without updater actions. `src/main/index.ts` registers the exact recovery-only set separately from the full application IPC set.

- [ ] **Step 4: Expose the minimal preload contract**

Add only the named methods and update the API key/method/channel parity tests plus public typecheck. Do not expose `ipcRenderer`, listeners, filesystem paths, updater client, source configuration, or generic invoke/send helpers.

- [ ] **Step 5: Re-run tests/typecheck and amend**

Run: `git add -N -- src/main/ipc/database-compatibility.ts src/main/ipc/__tests__/database-compatibility.test.ts src/preload/__tests__/public-ipc-transport.test.ts src/renderer/__tests__/public-api-facade.test.ts` (intent-to-add for updater-ipc: makes new final-green inputs index-visible; it is not final staging or a commit).

Run (diagnostic green, not recorded): `node node_modules/vitest/vitest.mjs run src/main/ipc/__tests__/release.test.ts src/main/ipc/__tests__/database-compatibility.test.ts src/preload/__tests__/index.test.ts src/preload/__tests__/transport-surface.test.ts src/preload/__tests__/public-ipc-transport.test.ts src/renderer/__tests__/public-api-facade.test.ts`

Expected: PASS. The single approved observed green for `updater-ipc` is deferred to Subplan 5's final observation phase, after every planned modification to its owned paths.

Run (supporting, not numbered evidence): `npm run typecheck`

Run: `git add src/main/ipc/release.ts src/main/ipc/database-compatibility.ts src/main/index.ts src/preload/index.ts src/shared/types/ipc.ts tests/typecheck/public-ipc-main.ts src/main/ipc/__tests__/release.test.ts src/main/ipc/__tests__/database-compatibility.test.ts src/preload/__tests__/index.test.ts src/preload/__tests__/transport-surface.test.ts src/preload/__tests__/public-ipc-transport.test.ts src/renderer/__tests__/public-api-facade.test.ts && git commit --amend --no-edit`

### Task 6: Recovery-only startup and actionable future-schema UI

**Files:**
- Modify: `src/main/index.ts`
- Create: `src/renderer/DatabaseStartupRouter.tsx`
- Create: `src/renderer/features/recovery/DatabaseCompatibilityGate.tsx`
- Modify: `src/renderer/render-app.tsx`
- Modify: `src/renderer/i18n/en-US.ts`
- Modify: `src/renderer/i18n/zh-CN.ts`
- Create test: `src/renderer/__tests__/DatabaseStartupRouter.test.tsx`
- Create test: `src/renderer/features/recovery/__tests__/DatabaseCompatibilityGate.test.tsx`
- Create test: `src/main/__tests__/startup.test.ts`

**Interfaces:**
- Consumes: `DatabaseStartupResult` before normal IPC/services are constructed.
- Produces: full-app mode or recovery-only mode with diagnostics/backup/exit actions.

- [ ] **Step 1: Write failing main/Renderer mode tests**

Test normal startup, future-schema startup without constructing providers/updater/process runtime, only recovery IPC registered, no normal App mount, exact found/supported versions displayed, safe backup directory label, opening the fixed application backups folder, diagnostics export, and exit. Test English and Simplified Chinese strings.

- [ ] **Step 2: Run the failing tests**

Run: `npm exec vitest -- run src/main/__tests__/startup.test.ts src/renderer/__tests__/DatabaseStartupRouter.test.tsx src/renderer/features/recovery/__tests__/DatabaseCompatibilityGate.test.tsx`

- [ ] **Step 3: Route before service construction**

`src/main/index.ts` calls `bootstrapDatabase()` before constructing database-dependent services. For `future_schema`, register only release version, compatibility, bounded diagnostics export with explicitly unavailable provider/process/recovery sections, fixed backups-folder open, and exit IPC; create the secure BrowserWindow and load the same Renderer with no path/query payload. Normal handlers and runtime are never registered. An `unavailable` result follows the existing bounded fatal-startup flow without constructing services or creating a replacement database.

- [ ] **Step 4: Gate Renderer mounting**

`DatabaseStartupRouter` awaits `getDatabaseCompatibility()` before rendering. It mounts `<App />` only for `ready`; otherwise it mounts `<DatabaseCompatibilityGate />`. The recovery view offers only “Open backups folder”, “Export diagnostics”, and “Exit”, with progress/disabled states and no “continue anyway”.

- [ ] **Step 5: Tighten navigation while touching startup**

Development navigation accepts only the exact configured dev origin; packaged navigation accepts only the resolved renderer entry file. `will-navigate`, `setWindowOpenHandler`, and external-link handling deny everything else unless a later feedback/document action passes a fixed allowlist.

- [ ] **Step 6: Re-run focused and complete subplan tests**

Run: `npm exec vitest -- run src/main/database/__tests__/DatabaseBootstrap.test.ts src/main/database/__tests__/DatabaseBackupService.test.ts src/main/release/__tests__/UpdateSourcePolicy.test.ts src/main/release/__tests__/UpdateTransportGuard.test.ts src/main/release/__tests__/UpdateSignatureInspector.test.ts src/main/release/__tests__/UpdateInstallGuard.test.ts src/main/release/__tests__/UpdateManager.test.ts src/main/ipc/__tests__/release.test.ts src/main/ipc/__tests__/database-compatibility.test.ts src/preload/__tests__/index.test.ts src/preload/__tests__/transport-surface.test.ts src/main/__tests__/startup.test.ts src/renderer/__tests__/DatabaseStartupRouter.test.tsx src/renderer/features/recovery/__tests__/DatabaseCompatibilityGate.test.tsx`

- [ ] **Step 7: Amend the reviewed subplan checkpoint**

Run: `git add src/main/index.ts src/renderer/DatabaseStartupRouter.tsx src/renderer/features/recovery/DatabaseCompatibilityGate.tsx src/renderer/render-app.tsx src/renderer/i18n/en-US.ts src/renderer/i18n/zh-CN.ts src/renderer/__tests__/DatabaseStartupRouter.test.tsx src/renderer/features/recovery/__tests__/DatabaseCompatibilityGate.test.tsx src/main/__tests__/startup.test.ts && git commit --amend --no-edit`
