# Release Artifact Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fail-closed Windows release toolchain whose reports are schema-validated, hash-bound, secret-free, and incapable of claiming a closed-Beta pass before the final evidence exists.

**Architecture:** Small importable ESM modules expose pure functions while thin CLI entry points write only to ignored `release-validation/`. One release context binds branch, clean HEAD, version, metadata, toolchain, and artifact hashes. The evidence graph is acyclic: build/signing facts → SBOM/notices → immutable manifest → verification → inner artifact ledger/freeze → manual evidence/acceptance → final gate/report → outer delivery ledger.

**Tech Stack:** Node ESM, npm, Git, electron-builder, PowerShell Authenticode, CycloneDX JSON, Vitest.

## Global Constraints

- Execute only on clean branch `task15`, with package/lock version `1.0.1-rc.1` and channel `rc`; there is no override that can produce a releasable result.
- Every CLI exports its core functions and invokes `main()` only when executed directly; tests inject process, filesystem, Git, clock, and command runners.
- Write reports atomically beneath `release-validation/`; report paths are workspace-relative POSIX paths and report payloads contain no machine-absolute paths.
- Never serialize command environments, feed URL values, signing configuration values, credentials, source text, prompts, diffs, databases, or raw logs.
- `release:verify` must call signing verification and bind results to final artifact hashes. `NotSigned` is truthful for this candidate; never turn it into `Signed` or `Trusted`.
- The manifest contains neither its own hash nor acceptance/final-gate status. `ARTIFACT_SHA256SUMS.txt` closes immutable candidate inputs before freeze; the outer `SHA256SUMS.txt` is written after final reports, excludes itself, and is verified before the orchestrator returns PASS.
- No unresolved P0/P1 of any category may pass the closed-Beta gate.

---

### Task 1: Canonical release context and evidence schemas

**Files:**
- Create: `scripts/release/lib/common.mjs`
- Create: `scripts/release/lib/release-context.mjs`
- Create: `scripts/release/lib/report-schema.mjs`
- Create test: `tests/release/release-context.test.ts`
- Create test: `tests/release/release-report-schema.test.ts`

**Interfaces:**
- Produces: `createReleaseContext({ workspaceRoot, releaseFacts, preparedMetadata }): ReleaseContext`.
- Produces: `canonicalJson(value)`, `writeAtomicJson(root, relativePath, value)`, `sha256File(path)`, `safeRelativePath(root, path)`.
- Produces: `StageResultSchema`, `EvidenceReferenceSchema`, `FinalGateSchema`, `FINAL_REPORT_ITEM_IDS`.
- Consumes: Subplan 1 `release-metadata.json` and its public schema.

- [ ] **Step 1: Write failing context/report tests**

```ts
expect(() => createReleaseContext({
  ...valid,
  releaseFacts: { ...valid.releaseFacts, branch: 'main' },
})).toThrow('task15');
expect(() => createReleaseContext({
  ...valid,
  releaseFacts: { ...valid.releaseFacts, dirty: true },
})).toThrow('clean');
expect(() => safeRelativePath(root, 'C:\\Users\\person\\secret.txt')).toThrow('workspace-relative');
expect(() => FinalGateSchema.parse({
  ...gate,
  closedBetaReady: true,
  unresolved: [{ severity: 'P1' }],
})).toThrow();
```

The last assertion is intentionally expected to fail until `superRefine()` rejects every unresolved P0/P1 and every `closed_beta_required` `NEEDS_MANUAL_EVIDENCE` item. Add a positive fixture where the GA-only `MAN-DIAG-REVIEW` item is missing: `closedBetaReady=true` remains schema-valid while `publicGaReady=false` and the corresponding GA blocker are mandatory.

- [ ] **Step 2: Run the tests and observe missing modules**

Run: `npm exec vitest -- run tests/release/release-context.test.ts tests/release/release-report-schema.test.ts`

- [ ] **Step 3: Implement bounded canonical writers**

`safeRelativePath()` resolves both arguments, rejects escape, drive changes, UNC paths, `..`, and symlink traversal, then stores a forward-slash relative path. `writeAtomicJson()` writes a sibling random temporary name with mode `0o600`, fsyncs, renames, and deletes the temporary file on failure. `canonicalJson()` recursively sorts object keys and appends one LF.

- [ ] **Step 4: Implement exact status schemas**

```js
export const STAGE_STATUSES = [
  'PASS', 'FAIL', 'BLOCKED', 'NEEDS_MANUAL_EVIDENCE',
];

export const FINAL_REPORT_STATUSES = [
  'PASS', 'FAIL', 'BLOCKED', 'NOT_RUN', 'NEEDS_MANUAL_EVIDENCE', 'INFORMATIONAL',
];

export const SIGNATURE_STATUSES = [
  'Signed', 'NotSigned', 'UnknownError', 'HashMismatch', 'NotTrusted', 'Expired',
];
```

Each evidence reference has only `{ reportPath, reportSha256, itemId }`. Every final-report definition has a fixed scope of `closed_beta_required`, `ga_only`, or `informational`. Final gate output is `{ closedBetaReady, publicGaReady, statusLabels, blockers, evidence }`; the schema enforces `publicGaReady=false`, always includes `BLOCKED_FOR_PUBLIC_GA`, and permits `PASS_FOR_CLOSED_BETA` only when every `closed_beta_required` item is `PASS`. A `ga_only` `BLOCKED`/`NOT_RUN` row is reported but does not incorrectly fail closed Beta; an `informational` row cannot satisfy a required gate.

- [ ] **Step 5: Define the stable final-report IDs**

Export exactly these immutable Task 15 rows; `release-report-schema.test.ts` deep-equals the full `{ id, description, scope }[]`, asserts count 40, uniqueness/order, and requires each row to have hash-bound evidence or a blocker:

| ID | Exact final report row | Scope |
| ---: | --- | --- |
| 1 | release capability audit matrix | `closed_beta_required` |
| 2 | reused pre-existing release capabilities | `closed_beta_required` |
| 3 | capabilities added in Task 15 | `closed_beta_required` |
| 4 | target version and selection rationale | `closed_beta_required` |
| 5 | release channel | `closed_beta_required` |
| 6 | ReleaseMetadata architecture | `closed_beta_required` |
| 7 | Build ID and commit injection | `closed_beta_required` |
| 8 | release preflight | `closed_beta_required` |
| 9 | installer configuration | `closed_beta_required` |
| 10 | installer relative path, size, and SHA-256 | `closed_beta_required` |
| 11 | signature status | `closed_beta_required` |
| 12 | unsigned-user warning | `closed_beta_required` |
| 13 | updater architecture | `closed_beta_required` |
| 14 | local-update acceptance | `closed_beta_required` |
| 15 | upgrade data-retention result | `closed_beta_required` |
| 16 | database migration/backup result | `closed_beta_required` |
| 17 | Release Manifest and checksums | `closed_beta_required` |
| 18 | SBOM | `closed_beta_required` |
| 19 | third-party notices | `closed_beta_required` |
| 20 | project-license status | `closed_beta_required` |
| 21 | privacy-draft status | `closed_beta_required` |
| 22 | affiliation/brand/asset audit | `closed_beta_required` |
| 23 | diagnostics redaction/sentinel result | `closed_beta_required` |
| 24 | Beta Feedback experience | `closed_beta_required` |
| 25 | install, upgrade, and uninstall acceptance | `closed_beta_required` |
| 26 | performance and package-composition measurements | `closed_beta_required` |
| 27 | added/modified file inventory | `closed_beta_required` |
| 28 | added/expanded test counts | `closed_beta_required` |
| 29 | full test file/case/pass/fail/skip/todo counts | `closed_beta_required` |
| 30 | typecheck, lint, test, and build results | `closed_beta_required` |
| 31 | every release-command result | `closed_beta_required` |
| 32 | renderer error count | `closed_beta_required` |
| 33 | test-owned residual-process count | `closed_beta_required` |
| 34 | `closedBetaReady` and `PASS_FOR_CLOSED_BETA` decision | `informational` |
| 35 | `publicGaReady=false` and `BLOCKED_FOR_PUBLIC_GA` reasons | `ga_only` |
| 36 | final task15 commit SHA | `closed_beta_required` |
| 37 | stable-main SHA and clean tracked status | `closed_beta_required` |
| 38 | unresolved issues | `informational` |
| 39 | future post-merge tag recommendation, explicitly not created | `informational` |
| 40 | next-stage recommendations | `informational` |

Row 20 passes closed Beta only when it truthfully reports `decision_required`, proves `LICENSE-DECISION-REQUIRED.md` exists and matches the bundled-document catalog, and makes no license grant; the absence of a final project license remains a separate row-35 GA blocker. Rows 34, 35, and 38–40 report derived decisions or unresolved/next-step information and are never inputs to the decision they describe. The gate evaluates the independent finding registry, exact acceptance contracts, and hash-bound stage reports first; only afterward does the final-report renderer populate those rows. This prevents a final-report self-reference while preserving all fixed IDs.

- [ ] **Step 6: Re-run tests and amend the checkpoint**

Run: `npm exec vitest -- run tests/release/release-context.test.ts tests/release/release-report-schema.test.ts`

Run: `git add scripts/release/lib/common.mjs scripts/release/lib/release-context.mjs scripts/release/lib/report-schema.mjs tests/release/release-context.test.ts tests/release/release-report-schema.test.ts && git commit --amend --no-edit`

### Task 2A: Freeze static release policy and canonical builder output

**Files:**
- Modify: `electron-builder.yml`
- Modify: `src/shared/release-contract.json`
- Modify: `scripts/lib/release-metadata.mjs`
- Modify: `scripts/README-release-validation.md`
- Modify test: `src/main/release/__tests__/InstallerConfig.test.ts`
- Modify test: `tests/release/release-metadata-script.test.ts`

**Interfaces:**
- Produces: the exact static contract `{ metadataSchemaVersion, sqliteSchemaVersion, approvedPublisherSubjects, approvedPublisherThumbprints }`; both publisher arrays are empty in Task 2A and Task 3 consumes them without editing this contract.
- Produces: `projectReleaseMetadataContract(validatedContract): { metadataSchemaVersion, sqliteSchemaVersion }`; it accepts only the already strict-parsed four-field object and cannot parse or rescue a legacy shape.
- Produces: `BUILD_OUTPUT_ROOT='release-validation/staging/build-output'` through tracked electron-builder configuration; no CLI output/config override is permitted.
- Preserves: `ReleaseMetadata` bytes contain metadata facts only and do not include publisher policy.

- [ ] **Step 1: Write the failing four-field contract tests**

Require this exact object:

```ts
expect(contract).toEqual({
  metadataSchemaVersion: 1,
  sqliteSchemaVersion: 7,
  approvedPublisherSubjects: [],
  approvedPublisherThumbprints: [],
});
```

Prove the legacy two-field object, malformed/non-array/non-string/duplicate publisher entries, and every unknown fifth key all fail strict contract parsing. Generate candidate metadata only from the valid strict four-field fixture. Require its bytes to equal the already frozen pre-Task-2A expected metadata bytes, and separately deep-equal `projectReleaseMetadataContract(validatedContract)` to `{ metadataSchemaVersion: 1, sqliteSchemaVersion: 7 }`; policy projection must not weaken the four-field input schema.

- [ ] **Step 2: Write the failing canonical-output test**

Require `directories.output: release-validation/staging/build-output`, reject `directories.output: release`, and preserve the already-reviewed icon/resource/NSIS configuration. Assert there is no `publish` block and no machine-absolute or CLI-derived output path.

- [ ] **Step 3: Run the diagnostic RED**

Run: `node node_modules/vitest/vitest.mjs run src/main/release/__tests__/InstallerConfig.test.ts tests/release/release-metadata-script.test.ts`

Expected: FAIL only for the new four-field contract and staging-output expectations. Task 2A owns no official 60-case ID; do not invoke the evidence launcher.

- [ ] **Step 4: Implement the exact contract and output migration**

Strictly validate both publisher arrays as unique bounded non-empty strings, require all four fields, and reject every extra key; keep publisher policy out of `ReleaseMetadata` through the explicit post-validation projector. Never accept a two-field contract after this migration. Change only the tracked builder output:

```yaml
directories:
  output: release-validation/staging/build-output
  buildResources: build-resources
```

Do not add `--config.*` or any publish setting. Update the release-validation guide: `dist`/`dist:win` are developer packaging commands that inherit this staging output, `release/` is ignored legacy/non-authoritative storage, and release tooling neither selects nor cleans bytes there.

- [ ] **Step 5: Run diagnostic GREEN and amend**

Run: `node node_modules/vitest/vitest.mjs run src/main/release/__tests__/InstallerConfig.test.ts tests/release/release-metadata-script.test.ts tests/release/app-update-config.test.ts src/main/release/__tests__/ReleaseMetadata.test.ts`

Run: `node scripts/generate-app-update-config.mjs --verify`

Run: `git add electron-builder.yml src/shared/release-contract.json scripts/lib/release-metadata.mjs scripts/README-release-validation.md src/main/release/__tests__/InstallerConfig.test.ts tests/release/release-metadata-script.test.ts && git commit --amend --no-edit`

### Task 2B: Strict preflight/build reports and importable security checklist

**Files:**
- Modify: `scripts/release/lib/report-schema.mjs`
- Create: `scripts/release/lib/security-checklist.mjs`
- Modify: `scripts/release-security-checklist.mjs`
- Modify test: `tests/release/release-report-schema.test.ts`
- Create test: `tests/release/release-security-checklist.test.ts`

**Interfaces:**
- Produces: strict `NativeAbiProbeResultSchema`, `PreflightReportSchema`, `BuildInventorySchema`, and `BuildReportSchema`.
- Produces: `runSecurityChecklist({ workspaceRoot, deps }): Promise<readonly SecurityChecklistResult[]>`, with no import-time filesystem/process effects, no test runner, and no report write.
- Produces: a zero-argument standalone diagnostic CLI; `process.argv.slice(2)` must be empty, and the `test:release-security` npm alias supplies no arguments.
- Preserves: `StageResultSchema`; detailed report objects never contain their own SHA-256 or an evidence reference to themselves.

- [ ] **Step 1: Write the failing strict-schema tests**

Freeze `PreflightReportSchema` as this strict bounded shape:

```js
{
  schemaVersion: 1,
  stage: 'preflight',
  contextId,
  status: 'PASS' | 'FAIL',
  blocker: string | null,
  releaseMetadata: {
    relativePath: 'release-validation/staging/release-metadata.json',
    sha256,
  },
  packageLockSha256,
  toolchain: {
    nodeVersion, npmVersion, electronVersion, electronBuilderVersion,
    platform: 'win32', arch: 'x64',
  },
  commands: [
    {
      id: 'npm-ci' | 'typecheck' | 'lint' | 'test' | 'build',
      status: 'PASS' | 'FAIL',
      category: null | 'child-nonzero' | 'timeout' | 'output-limit' | 'execution' | 'cleanup-unconfirmed' | 'invalid-output' | 'verification-failed',
      exitCode: uint32 | null,
      durationMs,
    },
  ],
  checks: [
    { id: 'security-static-checks' | 'icon-verify' | 'node-native-abi' | 'electron-native-abi' | 'release-invariants', status: 'PASS' | 'FAIL', durationMs },
  ],
  nativeAbi: { node: NativeAbiProbeResult | null, electron: NativeAbiProbeResult | null },
  tests: { files, tests, passed, failed, skipped, todo } | null,
}
```

`NativeAbiProbeResultSchema` freezes the exact Task 2C probe object shown there, so Task 2B does not depend on an undefined future type. All counts/durations are bounded nonnegative integers. The reusable test-count object permits honest zero `files`/`tests` and requires exact reconciliation; report PASS alone additionally requires `files>=1` and `tests>=1`. Command results form a strict discriminated union: PASS is exactly `category:null, exitCode:0`; `child-nonzero` alone carries its real unsigned 32-bit non-zero exit; timeout, output-limit, execution, cleanup-unconfirmed, invalid-output, and verification-failed carry `exitCode:null`. No infrastructure result invents exit code `1` or truncates a DWORD to eight bits. PASS requires `blocker=null`, all five commands and five checks exactly once in the listed order, nonzero file/test discovery, zero failed/skipped/todo tests, and two PASS probe results. FAIL requires a bounded non-null blocker, ordered executed prefixes, and the terminal executed result to be FAIL; later results/probes remain absent/null. `tests` is null before the test command or when that command has no trustworthy strict summary; it contains the reconciled summary when the test command structurally completes, including a genuine test failure/skip/todo/discovery-policy failure or an honest zero-count empty-discovery/collection failure, and is retained for every later-stage failure. The report contains no `reportSha256`, `evidence`, raw output, environment, URL, source text, or machine path.

Freeze `BuildInventorySchema` as:

```js
{
  version: '1.0.1-rc.1',
  outputRoot: 'release-validation/staging/build-output',
  installer: { artifactId, size, sha256 },
  unpackedTree: { rootId, fileCount, totalBytes, treeSha256 },
  metadata: {
    releaseMetadataSha256,
    embeddedMainReleaseMetadataSha256,
    resourceReleaseMetadataSha256,
  },
  appUpdate: { trackedSha256, packagedSha256 },
}
```

The schema requires all three metadata hashes to equal one another; Task 2D additionally compares them to `context.metadataSha256` and the bound preflight report's `releaseMetadata.sha256`. Define `treeSha256` as SHA-256 of canonical JSON plus one LF for entries sorted by ordinal POSIX `relativePath`, each exactly `{ relativePath, mode, size, fileSha256 }`; `mode` is the normalized nonnegative integer file-mode field, and every member is an ordinary non-reparse file.

`BuildReportSchema` is exactly `{ schemaVersion:1, stage:'build-win', contextId, preflightReference, builder, inventory }`. `builder` is exactly `{ nodeVersion, electronBuilderVersion, cliRelativePath:'node_modules/electron-builder/cli.js', cliSha256, arguments:['--win','--publish','never'] }`. Reject absolute/backslash/`release/` IDs, zero/two installers or unpacked roots, extra keys, and self-reference.

- [ ] **Step 2: Write the failing checklist boundary tests**

Prove importing the core performs no read/write/spawn. Its result is the exact ordered eight-item list `{ id, status }`, with IDs `permissions-default-standard`, `renderer-node-integration-disabled`, `renderer-context-isolation-enabled`, `renderer-sandbox-enabled`, `single-instance-lock-enabled`, `nsis-current-user`, `code-signing-hook-prepared`, and `dangerous-git-mutations-absent`, and status only `PASS`/`FAIL`; raw output/environment values and unknown/duplicate/missing IDs are rejected. The thin CLI accepts zero arguments, writes atomically only to `release-validation/reports/security-checklist-diagnostic.json`, and rejects every argv token, including `--report`, a path, or a mode override. The `test:release-security` npm alias is exactly the zero-argument CLI invocation. Neither the core nor CLI launches Vitest or another test suite.

- [ ] **Step 3: Run the diagnostic RED**

Run: `node node_modules/vitest/vitest.mjs run tests/release/release-report-schema.test.ts tests/release/release-security-checklist.test.ts`

Expected: FAIL for missing schemas/core. Task 2B writes no official evidence.

- [ ] **Step 4: Implement the schemas and core/thin-CLI split**

Use strict Zod schemas with fixed enums, bounded arrays/strings/counts/durations, workspace-relative POSIX identifiers, and exact object keys. Move static checklist logic into the pure core; guard CLI `main()` with direct-execution detection and fail before filesystem/process work unless `process.argv.slice(2)` is empty. The standalone diagnostic report is ignored and explicitly non-authoritative; it cannot emit a gate, and it never reruns focused/full tests.

- [ ] **Step 5: Run diagnostic GREEN and amend**

Run: `node node_modules/vitest/vitest.mjs run tests/release/release-report-schema.test.ts tests/release/release-security-checklist.test.ts tests/release/release-context.test.ts`

Run: `npm run test:release-security`

Run: `git add scripts/release/lib/report-schema.mjs scripts/release/lib/security-checklist.mjs scripts/release-security-checklist.mjs tests/release/release-report-schema.test.ts tests/release/release-security-checklist.test.ts && git commit --amend --no-edit`

### Task 2C-1: Reviewed Windows toolchain policy and owned child runner

This slice defines the process boundary used by Task 2C-2 and Task 2D. It is deliberately separate from Task 0's hash-anchored evidence launcher and must not edit, invoke, or derive trust from the four Task 0 anchor files.

**Files:**
- Create: `scripts/release/release-toolchain.json`
- Create: `scripts/release/lib/trusted-windows-runner.mjs`
- Create test: `tests/release/release-trusted-windows-runner.test.ts`

**Trust boundary:**

Release commands run as a non-elevated standard user on the reviewed Windows x64 workstation. Windows/System32 and the administrator-owned, standard-user-read-only Program Files Node/Git installations are OS-admin trust roots. The contract does not claim resistance to an administrator/kernel compromise, replacement before the parent Node process starts, arbitrary code already injected into that parent, or an adversarial same-user process that wins an otherwise acknowledged path race. Those limits are explicit residual risks; no report may call the closure cryptographic or universally tamper-proof. Within this boundary, every critical path is ordinary/non-reparse, the protected roots' owners/ACLs deny standard-user writes, file/tree hashes match the reviewed contract, executable identities are held and rechecked, and workspace inputs are checked before and after each use.

`release-toolchain.json` is strict, tracked, owner-reviewed, and has no discovery, self-update, environment override, or automatic rewrite path. It pins Windows/x64, the Node Program-Files-relative path/version/SHA-256, npm 11.12.1 package-root canonical tree digest, Git 2.44.0.windows.1 critical closure digest (`cmd/git.exe`, `mingw64/bin`, and `mingw64/libexec/git-core`), the required System32 Windows PowerShell host policy, and the workspace dependency-bootstrap policy described in Task 2C-2. Canonical tree digests sort ordinal POSIX relative paths and hash canonical JSON plus one LF over exact `{relativePath,size,fileSha256}` ordinary-file rows. A future tool update is a reviewed tracked change, never runtime discovery. Task 0's toolchain JSON remains untouched and is not used as this contract.


`trusted-windows-runner.mjs` imports only Node built-ins. Its only pre-native bootstrap is the reviewed-workstation literal candidate `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`: the parent opens that exact ordinary non-reparse file, hashes the held bytes, captures the Node-visible handle identity, then immediately before launch reopens the pathname and repeats the ordinary/non-reparse/hash/identity comparison while retaining the original handle through controller validation. It never consults `SystemRoot`, `WINDIR`, `ProgramFiles`, PATH, cwd, home, or a drive fallback. Node built-ins cannot prove the Windows effective DACL, deny-share semantics, native final path, or OS-known-folder origin before this first native host executes; that bootstrap loop is an explicit reviewed-workstation residual and must not be reported as a pre-launch ACL or known-folder guarantee. Because the complete reviewed supervisor exceeds Windows' command-line limit when UTF-16LE/Base64 encoded, the fixed `-EncodedCommand` is only a small in-module, compiler-free loader. After attaching stdin error/finish/close, both output EOF, error/exit/close, cap, and deadline handling, the parent writes one bounded LF-terminated strict envelope on stdin containing the exact UTF-8 controller bytes, their SHA-256, and the canonical request bytes; it honors backpressure, closes stdin exactly once, and routes synchronous write, callback, EPIPE, premature close, partial write, and missing finish, or close-before-finish through the same forced supervisor-kill/wait/pipe-close path; the fixed loader argument vector plus `ENCODED_LOADER` must remain below the Windows command-line limit; the loader performs one bounded read through EOF and rejects truncated/multiple/extra lines, duplicate/reordered/unknown keys, noncanonical Base64, invalid UTF-8, decoded or encoded size drift, request/controller length or hash mismatch, and controller-hash drift against its embedded reviewed value before creating a script block. It writes no file and executes no caller-selected path. The hash-bound controller then uses `GetSystemDirectoryW` and `SHGetKnownFolderPath` to prove that its host is the actual System32 Windows PowerShell executable and to derive and validate the Program Files Node/Git roots, including native handle/final-path containment, owner/DACL, non-reparse, identity, version, file, and tree checks. Those ACL/native-identity checks occur after the fixed-hash PowerShell host starts but before any target is created; any mismatch fails before target creation.
All controller Win32 calls use only PowerShell 5.1/.NET Framework 4.8 in-memory `Reflection.Emit` with `DefinePInvokeMethod`. The controller must not use `Add-Type`, `csc`, Roslyn, a downloaded/native helper, a temporary source/assembly, or any write beneath TEMP; no compiler, temp directory, or loose helper may enter the pre-validation trust chain.

The hash-bound in-memory controller is a supervisor and is never a member of the inner target Job. It first creates and self-assigns an outer kill-on-close supervisor Job, with no breakaway flags, so a parent-forced supervisor exit also contains the target-creation interval. It creates the inner target Job with `KILL_ON_JOB_CLOSE` and no breakaway flags, calls `CreateProcessW` with `CREATE_SUSPENDED` and no breakaway/detached flag, assigns the suspended target to the inner Job, and only then resumes its primary thread; the target also remains covered by the inherited outer Job. A pre-assignment failure directly terminates and waits for the still-suspended target without resuming it. It opens and holds the selected executable and declared critical inputs, rechecks final path/file identity immediately before `CreateProcessW`, uses the exact `CommandLineToArgvW` quoting algorithm, and streams stdout/stderr with independent caps. On target timeout or either output overflow, the supervisor calls `TerminateJobObject`, waits for the target and both pipes, requires a Job query with zero active target members, and only then emits a bounded cleanup receipt. Nominal success likewise requires target exit, both pipe EOFs, and zero active target members before the success receipt. Handles, timers, listeners, and retained inputs are released only after that receipt path completes.

The Node parent independently caps controller stdout/stderr and owns a separate deadline. If its deadline/cap fires, the controller response is malformed, or the controller exits before a valid receipt, it terminates the supervisor, waits for supervisor `error`/`exit`/`close`, a classified stdin terminal state (finish, or error/close failure), and both output pipe EOFs, releases retained inputs, and returns only the fixed fail-closed `cleanup-unconfirmed` category. Even a valid controller receipt remains provisional until the supervisor has closed and both controller pipes reached EOF; only then may the parent accept success or confirmed cleanup and release retained inputs. Closing the supervisor's outer/inner kill-on-close handles supplies OS-level recovery, but without the supervisor's zero-member receipt the parent must not claim confirmed cleanup, return a Stage PASS, or retain a prior PASS. Raw output, environment, URL, username, machine path, and target PIDs never enter the public result or a report.

The production module exports exactly `loadReleaseToolchainPolicy()` and `runTrustedWindowsCommand(descriptorId)`, where `descriptorId` is one primitive string from a deeply immutable internal production matrix; extra arguments and unknown IDs fail before policy, filesystem, or process work. The matrix fixes exactly 34 ordered rows with a production-owned raw-literal SHA-256, strict row schema/count/order, case-insensitive ID uniqueness, and closed executable/cwd/closure/parser classes. It fixes executable class, argv, cwd class, environment additions, timeout, both child-output caps, closure class, and result parser for the Node/npm/Git probes; candidate and privately parsed main-worktree Git facts; exact script-disabled npm install and three ordered lifecycle payloads; both TypeScript checks, ESLint, one full Vitest run, three Vite builds, icon verification, Node/Electron ABI probes, and the exact electron-builder invocation. Every Git row disables optional locks and replacement objects, suppresses system/global configuration, and applies the same fixed non-executing repository-config overrides. Candidate and private-main rows separately audit the complete local-config allowlist, index stages/modes/flags, and untracked files; a shared row requires no replacement refs. Status uses porcelain v2 with all untracked files and no ignored submodule, diff uses no external/textconv filters, and unsupported submodule/sparse/conflict/assume-unchanged/skip-worktree/intent-to-add state fails closed. These read-only gates snapshot and recheck candidate/main index identity, bytes, length, and nanosecond mtime in behavior tests; they do not claim resistance to a same-user post-check race. The matrix contains no `runner-fixture-*` descriptor and no CLI, Renderer, environment variable, or downstream caller may select an executable, argv, cwd, PowerShell body, path, timeout/cap, fixture, or cleanup mode. Bounded child output is available only to the descriptor-owned in-process parser; raw worktree paths and generic stdout never become public results.

The four build descriptors contain only module-owned placeholder tokens. `build-main` and `electron-builder-win` receive the fixed absolute `release-validation/staging/release-metadata.json` path plus `SOURCE_DATE_EPOCH`; the other two Vite builds receive only the epoch. Immediately before target creation the runner strictly reads that fixed ordinary candidate snapshot, rejects BOM/duplicate/unknown keys and non-canonical candidate metadata, derives the decimal epoch only from its canonical whole-second `buildTimeUtc`, binds the observed metadata SHA as a controller critical input, replaces every token, and rejects any token left unresolved. It never recaptures ambient `SOURCE_DATE_EPOCH` or a caller metadata path. Task 2C-2 remains the sole stage allowed to validate an explicit release-run epoch while preparing the snapshot, and Task 2D must prove context, metadata hash, and derived epoch parity before consuming these descriptors.

- [ ] **Step 1: Write and run the runner/policy RED**

Cover exact policy keys and reviewed versions/digests; no Task 0 contract reuse; non-elevated/ACL enforcement; the literal-host open/hash/identity/reopen bootstrap and its explicitly limited pre-native claim followed by controller `GetSystemDirectoryW`/`SHGetKnownFolderPath`/ACL agreement before target creation; pure in-memory `Reflection.Emit` P/Invoke with no `Add-Type`, compiler, helper, or TEMP write; fake PATH/cwd/root variables; wrong hash/tree/version; npm wrapper with changed package member; Git launcher with changed critical member; final/ancestor reparse or identity swap; mixed-case injection variables; exact 34-row immutable production descriptor deep equality, raw-literal hash and synchronized-hash schema mutations, and absence of `runner-fixture-*`; malicious local fsmonitor with zero sentinel execution, unknown local config, replacement refs, hidden index flags, and candidate/main index hash/identity/length/mtime no-write; fixed metadata-path/epoch tokens, strict snapshot parity, malformed/changed metadata, and zero ambient epoch/path influence; timeout/independent output caps; outer supervisor containment; suspended target creation, inner-Job assignment-before-resume, and absence of both Job breakaway limits and every child breakaway flag; child+grandchild cleanup; assignment/query/spawn/pipe/protocol exceptions; loader truncated/multiple/extra/duplicate/reordered envelope keys, noncanonical Base64, invalid UTF-8, size/hash drift, stdin backpressure, synchronous write/callback/EPIPE/premature-close failures; the parent's fixed `cleanup-unconfirmed` path for timeout/overflow/malformed or missing receipt; and zero residual Job members/handles/timers.

Private controller/protocol behavior is tested without adding a production export, dependency-injection seam, fixture descriptor, or runtime test hook. Three independently named marker pairs must each occur exactly once in the submitted production source. The controller pair surrounds the single controller constant; the test extracts those exact UTF-8 bytes, recomputes their SHA-256/Base64, deep-compares the production stdin envelope, independently extracts/recomputes the small UTF-16LE/Base64 loader, and proves the fixed production host call uses that loader. The same harness mutates every loader envelope boundary (truncation, multiple/extra lines, duplicate/reordered/unknown keys, noncanonical Base64, invalid UTF-8, decoded/encoded size, request/controller hash) and requires fail-closed zero target creation. It also asserts the fixed loader argv and encoded body remain below the Windows command-line limit. A test-only, non-exported harness then runs those exact extracted controller bytes with test-owned fixed programs for the real Windows argv round trip and child+grandchild timeout/stdout-overflow/stderr-overflow cases, recording only fresh fixture PIDs and proving them dead before resolution.

The descriptor pair surrounds one canonical strict-JSON literal containing the complete production matrix, including parser IDs; production strict-parses and deep-freezes that same literal, while the test extracts, strict-parses, deep-equals, and byte/hash-binds it to the fixed production construction call. The parent-engine pair surrounds the complete private Node controller-protocol/cleanup function, and the production call site invokes that exact function without a wrapper override. The test extracts those exact function bytes into a test-only module and supplies only a test-owned transport to drive parent deadline, controller-stdout cap, controller-stderr cap, malformed response, missing receipt, valid receipt, synchronous stdin write failure, callback failure, backpressure/drain, EPIPE, partial write, premature close, and missing finish. Each case discriminatingly proves supervisor termination where required; the `error`/`exit`/`close` plus both-pipe-EOF barrier; provisional-receipt rejection before close/EOF; retained-input release only after that barrier; listener/timer removal; and the fixed `cleanup-unconfirmed` result when no valid zero-member receipt exists. Marker absence/duplication, extracted/production byte mismatch, an unfixed production call site, or any attempt to expose a harness through the exports or production matrix fails the suite. These exact-source tests cover private quoting/schema/descriptor/parent-engine behavior but do not make any test fixture a production descriptor.

Run: `node node_modules/vitest/vitest.mjs run tests/release/release-trusted-windows-runner.test.ts`

Expected: FAIL because the strict policy and runner do not exist; no official 60-case record is written.

- [ ] **Step 2: Implement, run focused GREEN, independently review, and amend**

Run: `node node_modules/vitest/vitest.mjs run tests/release/release-trusted-windows-runner.test.ts`

Run: `node --check scripts/release/lib/trusted-windows-runner.mjs`

Run: `git add scripts/release/release-toolchain.json scripts/release/lib/trusted-windows-runner.mjs tests/release/release-trusted-windows-runner.test.ts && git commit --amend --no-edit`

### Task 2C-1A: Machine-readable trusted test and command outcomes

**Files:**
- Modify: `scripts/release/release-toolchain.json`
- Modify: `scripts/release/lib/trusted-windows-runner.mjs`
- Modify test: `tests/release/release-trusted-windows-runner.test.ts`
- Create: `scripts/release/vitest-preflight-reporter.mjs`
- Modify: `scripts/release/lib/report-schema.mjs`
- Modify test: `tests/release/release-report-schema.test.ts`

**Interfaces:**
- Keeps the Task 2C-1 production API exactly zero-argument `loadReleaseToolchainPolicy()` plus one-string `runTrustedWindowsCommand(descriptorId)`; no path, reporter, command, environment, parser, or fixture is caller-selectable.
- Changes the fixed `test-full` descriptor to exactly `node_modules/vitest/vitest.mjs run --config vitest.config.ts --no-cache --silent --reporter=./scripts/release/vitest-preflight-reporter.mjs`. The fixed `--no-cache` prevents the full-suite child from creating or rewriting Vitest result-cache bytes under the policy-bound `node_modules` tree. The runner binds and holds the Vitest entry, `vitest.config.ts`, tracked reporter, `package.json`, root `tsconfig.json`, and the four required-case test modules through the controller receipt. No default/alternate config, cache mode, or reporter is accepted; clean-HEAD/index/source drift gates still cover the rest of the discovered suite.
- Returns a strict machine result without raw Vitest JSON, names, or paths. A complete successful run is `{status:'PASS',category:null,exitCode:0,tests:{files,tests,passed,failed,skipped,todo},requiredCases:[...]}`. A structurally valid reporter summary with a real non-zero Vitest exit preserves its counts and ordered opaque discovery subset as `child-nonzero`; protocol/transport failures expose neither counts nor raw data.
- Preserves a real unsigned 32-bit child exit code for every descriptor child result. Infrastructure failures (`timeout`, `output-limit`, `execution`, `cleanup-unconfirmed`, or `invalid-output`) and later in-process `verification-failed` results carry no invented exit code.
- Changes `PreflightReportSchema.commands[*]` to the exact discriminated union described below, including nullable `category` and unsigned-32-bit-or-null `exitCode`. It also changes the shared strict test-count object to permit reconciled nonnegative zero discovery, adds the nonzero files/tests requirement only to report PASS, and proves that a trustworthy zero-count test FAIL remains serializable and retained through every later-stage FAIL.
- Extends the strict owner-reviewed toolchain policy with exactly this additional object (no discovery or auto-update):

```json
{
  "nativeAbi": {
    "hostNode": { "nodeVersion": "v24.15.0", "modulesAbi": "137", "napi": "10", "platform": "win32", "arch": "x64" },
    "electron": { "electronVersion": "35.7.5", "nodeVersion": "v22.16.0", "modulesAbi": "133", "napi": "10", "platform": "win32", "arch": "x64" },
    "sqlite": {
      "packageName": "better-sqlite3",
      "packageVersion": "13.0.2",
      "loaderRelativePath": "node_modules/better-sqlite3/lib/win32-x64.js",
      "nativeRelativePath": "node_modules/better-sqlite3/prebuilds/win32-x64.node",
      "nativeSha256": "ecfb86221a674a6cdba63b1ac162b99386a61d0e38934b6c3dfcd9da11b6ee26",
      "sqliteVersion": "3.53.4"
    }
  }
}
```

- [ ] **Step 1: Write the failing trusted-result tests and run RED**

The reporter must count every completed module and test from Vitest's reporter objects, reconcile `tests = passed + failed + skipped + todo`, and emit exactly one LF-terminated compact JSON object with this exact shape and no other keys:

```js
{
  schemaVersion: 1,
  status: 'PASS' | 'FAIL',
  tests: { files, tests, passed, failed, skipped, todo },
  requiredCases: readonly RequiredCaseId[],
}
```

The nested test keys are exact nonnegative bounded integers with the reconciliation above. PASS additionally requires `files>=1` and `tests>=1`; a structurally valid FAIL summary may honestly contain zero files and/or zero tests after empty discovery or a collection failure and must never invent counts. `requiredCases` is the unique discovered subset in the fixed table order; PASS requires the complete six-ID array, while FAIL may contain a strict ordered subset and never duplicates. The six owner-reviewed private predicates are literal and exact; matching uses a normalized repository-relative POSIX module path plus the exact Vitest `TestCase.fullName`, including every literal ` > ` hierarchy separator, never a collapsed-space form, basename, substring, or glob matching:

| Opaque ID | Exact normalized module path | Exact full test name |
| --- | --- | --- |
| `migration` | `src/main/database/__tests__/Migration.test.ts` | `SQLite migration > backs up the legacy JSON before importing it` |
| `current-schema` | `src/main/database/__tests__/ReleaseMigration.test.ts` | `v0.9/v3 to v1.0/v4 release migration > advances the fixed v0.9 fixture to the current schema v7` |
| `future-schema` | `src/main/database/__tests__/ReleaseMigration.test.ts` | `v0.9/v3 to v1.0/v4 release migration > rejects a schema newer than the v1.0 client` |
| `legacy-safety` | `src/main/database/__tests__/DatabaseLegacySafety.test.ts` | `legacy database fail-closed safety > rejects a corrupt file with a SQLite header without moving or recreating it` |
| `sentinel-redaction` | `src/main/diagnostics/__tests__/DiagnosticsExporter.release.test.ts` | `DiagnosticsExporter release privacy boundary > re-sanitizes structured and unstructured log lines before ZIP serialization` |
| `diagnostics-bounds` | `src/main/diagnostics/__tests__/DiagnosticsExporter.release.test.ts` | `DiagnosticsExporter release privacy boundary > tails oversized logs so stale content cannot inflate the diagnostic archive` |

Each reviewed predicate must be in the completed module set and match exactly once. Failed/skipped/todo tests, unhandled errors, empty discovery, collection failure, or missing/duplicate reviewed cases make reporter status FAIL and force a non-zero Vitest exit; they are policy/test failures, not malformed protocol, and their honest zero-count summary remains structurally valid. Multiple/CRLF/non-LF JSON, wrong schemaVersion, duplicate/unknown/reordered top-level or nested keys, invalid UTF-8, non-integer/negative/inconsistent counts, a PASS with zero files/tests, an invalid required-case order/value/duplicate, an impossible reporter-status/child-exit combination, or any raw path/name field is `invalid-output`. Behavior tests run a copied production runner with a test-owned fixed descriptor body and prove that only the reviewed config/reporter launch, both handles remain bound through the receipt, and raw absolute paths never enter the public result. Predicate tests include the literal ` > ` hierarchy form plus collapsed-space and different-nesting collision negatives. Windows filename matching is case-insensitive: alternate-case spellings must resolve to the same expected held identity and can never select a second file; a casefold collision/ambiguity fails before launch.

For `zero-exit`, cover exit `0`, ordinary non-zero values, a value above 255, timeout, output overflow, malformed output, execution failure, and cleanup failure. For the report schema, cover the exact consistency table: PASS is `category:null,exitCode:0`; ordinary child failure is `category:'child-nonzero'` with the real value in `1..0xffffffff`; `timeout`, `output-limit`, `execution`, `cleanup-unconfirmed`, `invalid-output`, and `verification-failed` each require `exitCode:null`. Reject negative, fractional, overflow, unknown category, FAIL+0, PASS+null, category/code contradictions, or extra fields. A trustworthy failed-test summary—including `files:0,tests:0` empty discovery and `files:1,tests:0` collection failure—remains in `tests`; the same zero-count summary is rejected for report PASS, invalid-output/cleanup-unconfirmed before such a summary requires null, and every post-test failure retains the completed summary.

Classification is deterministic. Unconfirmed cleanup overrides every other observation. Otherwise the first confirmed controller cause is timeout, output-limit, or execution. For a descriptor-owned machine protocol, strict parsing and status/exit agreement happen before ordinary exit classification: malformed/contradictory payload is `invalid-output` even when the child exit is non-zero; valid `status:'FAIL'` plus a real non-zero exit is `child-nonzero` and retains its summary; valid `status:'PASS'` plus exit zero proceeds. For a non-machine `zero-exit` descriptor, a real non-zero exit is directly `child-nonzero`. A later in-process postcondition failure is `verification-failed`; only complete success is PASS.

Run: `node node_modules/vitest/vitest.mjs run tests/release/release-trusted-windows-runner.test.ts tests/release/release-report-schema.test.ts`

Expected: FAIL because `test-full` still uses `zero-exit`, the reporter/config/required modules are not bound, real child exit codes are discarded, ABI JSON accepts non-strict lines/duplicate keys, the native policy oracle is missing, and report command category/null semantics do not exist.

- [ ] **Step 2: Implement the fixed reporter and strict parsers**

The reporter imports Node built-ins only, has no output-file option, emits no absolute or workspace-relative path, and writes its one summary only from `onTestRunEnd`. The `test-full` row remains one full Vitest invocation and uses a bounded summary stdout cap rather than the built-in JSON reporter's path/error-rich payload. The runner validates exact UTF-8, duplicate keys, the literal top-level and nested key sets/order, counts, reporter status, ordered required-case subset, LF framing, child-exit agreement, and no extra bytes before returning the deeply frozen result.

The `native-abi-json` parser separately requires one LF-terminated JSON object, rejects CRLF/no-LF/multiple lines/BOM/invalid UTF-8/duplicate or trailing data before `JSON.parse`, and returns no raw bytes; Task 2C-2 still applies `NativeAbiProbeResultSchema` and exact policy equality for the runtime-specific shape. Generic `oneTrailingLine()` is not used for either machine protocol. Tests extract `Get-CanonicalTree` from the already existing controller marker—without adding a fourth marker pair—to fix an independent fixture byte/hash oracle used later by Task 2C-2. Production still has exactly the original three single-occurrence marker pairs and no caller-selected tree API.

- [ ] **Step 3: Run GREEN/regression, review, and amend**

Run: `node node_modules/vitest/vitest.mjs run tests/release/release-trusted-windows-runner.test.ts tests/release/release-report-schema.test.ts`

Run: `npm run typecheck`

Run: `node --check scripts/release/lib/trusted-windows-runner.mjs && node --check scripts/release/vitest-preflight-reporter.mjs`

Expected: PASS with one full-test descriptor, exact machine-summary behavior, honest exit-code/null semantics, and no official 60-case evidence write.

Run: `git add scripts/release/release-toolchain.json scripts/release/lib/trusted-windows-runner.mjs tests/release/release-trusted-windows-runner.test.ts scripts/release/vitest-preflight-reporter.mjs scripts/release/lib/report-schema.mjs tests/release/release-report-schema.test.ts && git commit --amend --no-edit`

### Task 2C-2: Fail-closed preflight and dual-runtime native ABI probe

**Files:**
- Modify: `package.json`
- Create: `scripts/release/preflight.mjs`
- Create: `scripts/release/native-abi-probe.mjs`
- Create test: `tests/release/release-preflight.test.ts`

**Interfaces:**
- Consumes: Task 2C-1 zero-argument `loadReleaseToolchainPolicy()` and one-string, production-descriptor-only `runTrustedWindowsCommand(descriptorId)`; no fixture/test descriptor or caller-built command is accepted.
- Consumes: the reviewed one-object call `createReleaseContext({ workspaceRoot, releaseFacts, preparedMetadata })` without modifying `release-context.mjs`.
- Consumes: Task 2B `PreflightReportSchema` and the production-default `runSecurityChecklist({ workspaceRoot })` path.
- Produces: `runEarlyGitPackageGate({ workspaceRoot }): Promise<EarlyReleaseFacts>`.
- Produces: `prepareDependencyBootstrap({ workspaceRoot, releaseFacts }): Promise<PendingDependencyBootstrap>`; it quarantines stale preflight evidence, runs the script-disabled clean install, validates the pre-lifecycle tree, and returns an opaque module-owned token that cannot be caller-constructed.
- Produces: `prepareReleaseMetadata({ workspaceRoot, releaseFacts, dependencyBootstrap }): Promise<PreparedMetadata>` exactly once per fresh bootstrap token.
- Produces: `runPreflight({ context, dependencyBootstrap }): Promise<StageResult>` whose sole evidence is `{ reportPath:'release-validation/reports/preflight.json', reportSha256, itemId:'ARTIFACT-PREFLIGHT' }`.
- Produces: `loadPostInstallBindings({ workspaceRoot, context }): Promise<PostInstallBindings>`; it performs a read-only final-tree/policy revalidation and accepts no caller paths or entries.
- Produces: `loadBoundPreflightReport({ workspaceRoot, context, preflightReference }): Promise<{ report, bindings }>`; it validates final bindings under a private lease, dynamically loads the report schema only inside that lease, and returns a strict report plus the plain binding projection for Task 2D. It accepts only the fixed preflight item/path and exact reference hash.
- Produces: `loadFrozenPreflightContext({ workspaceRoot }): Promise<{ context, preflightReference }>` for the diagnostic build CLI; it is read-only and never refreshes metadata or preflight bytes.

Every production function accepts one exact plain object and rejects missing/unknown keys before filesystem or process work. `workspaceRoot` must equal the module-derived canonical workspace identity. No production export accepts `deps`, a command, callback, path override, binding table, environment, parser, reporter, fixture, or mode. A deeply frozen module-private `PRODUCTION_DEPS` singleton supplies all production operations and is never merged with caller input. Test substitution exists only inside one exact single-occurrence marker-delimited `createPreflightCore(testDeps)` source block; production instantiates those bytes once with `PRODUCTION_DEPS`, while tests extract the same bytes into a test-owned copy. The core, test dependency object, state maps, and override points are not exported or reachable through argv/environment/global hooks/IPC. Tests bind marker count, extracted bytes, the production construction call, and the exact production export list.

- [ ] **Step 1: Write the failing gate/context/stage/probe tests and run RED**

Cover a fresh clean checkout without ignored metadata, wrong branch/detached HEAD, dirty tracked/untracked source, wrong/dirty/duplicate main worktree, package/lock/notes/contract/asset drift, dependency bootstrap/metadata preparation/context construction called zero/two times, and exact context object identity at every later stage. Independently reject an unknown/cloned/forged/reused/concurrently reused/wrong-phase/cross-workspace/cross-core token, token A with release facts/metadata/context B, a second metadata preparation, a test dependency identity changed between phases, and any lifecycle/report action before a valid single consumption. A script-disabled install failure produces only the fixed non-authoritative bootstrap diagnostic and no context/StageResult; after context exists, every controlled-lifecycle or later failure produces the matching strict preflight prefix. Freeze and stop on first failure in this exact order:

```js
[
  'npm-ci', 'typecheck', 'lint', 'test', 'build',
  'security-static-checks', 'icon-verify',
  'node-native-abi', 'electron-native-abi', 'release-invariants',
]
```

The full Vitest suite appears exactly once through Task 2C-1A's `test-full` descriptor; security is the importable core and never launches another suite. Require the strict returned counts, zero failed/skipped/todo, and the exact six reviewed discovery identifiers; never synthesize counts or parse terminal prose. Cover every terminal prefix, category/real-or-null exit-code mapping, timeout/oversize/cleanup failure, dependency or source mutation across install/lifecycle completion, stale prior PASS, report publication ambiguity, and frozen-load zero-write behavior. The bootstrap matrix must independently reject a workspace `.npmrc`, prove that an existing user `.npmrc` is unreachable rather than treating its mere existence as a blocker, reject mixed-case `NPM_CONFIG_*`, registry/token/proxy/cache/prefix/workspace overrides, and reject any root `.env`/`.env.*` input except a clean tracked `.env.example`. Root enumeration and every fixed config/input lookup compare Windows names case-insensitively, reject casefold ambiguity, and bind the one canonical expected identity; tests include mixed-case `.NPMRC`, `.ENV*`, Vitest/Vite/ESLint/TS/electron-builder config spellings. It also rejects any argv other than exact `ci --ignore-scripts --no-audit --no-fund`, a missing/extra/reordered lifecycle payload or changed entry hash/args, pre-/post-lifecycle whole-tree drift, and every `PostInstallBindings` package or entry version/integrity/tree/hash/identity drift. Recheck the dotenv absence immediately before and immediately after each of `build-main`, `build-preload`, and `build-renderer`. `loadPostInstallBindings()` repeats the final checks read-only and must fail with zero writes on each mutation.

The same tracked probe accepts no caller SQL/path/mode. It imports exactly `better-sqlite3/win32-x64`, opens exactly `:memory:`, executes exactly `select sqlite_version() as version`, validates the one row, closes in `finally`, and emits one LF-terminated strict `NativeAbiProbeResultSchema` object. The locked Node runtime must exactly report Node `v24.15.0`, modules ABI `137`, N-API `10`, no Electron version, SQLite `3.53.4`, win32/x64. Canonical Electron with only internally supplied `ELECTRON_RUN_AS_NODE=1` must exactly report embedded Node `v22.16.0`, Electron `35.7.5`, modules ABI `133`, N-API `10`, SQLite `3.53.4`, win32/x64. Both bind the policy-pinned better-sqlite3 `13.0.2` native SHA. Mutate each expected field independently and require the exact probe row to FAIL with all later stages uncalled. Bind/recheck Electron package/version/executable and the fixed better-sqlite3 Windows loader plus `prebuilds/win32-x64.node` after `npm ci`; reject generic/alternate native paths, fake output, GUI launch, caller injection, malformed/multiple JSON, or uncertain cleanup.

Run: `node node_modules/vitest/vitest.mjs run tests/release/release-preflight.test.ts`

Expected: FAIL because preflight/probe are missing; no official 60-case record is written.

- [ ] **Step 2: Implement the bootstrap trust-epoch and one-object flow**

Before the script-disabled clean install, imports are limited to Node built-ins, Task 2C-1's built-in-only runner/policy, and the reviewed local release bootstrap modules whose complete dependency closure is Node built-ins (`scripts/lib/release-metadata.mjs`, `scripts/release/lib/release-context.mjs`, and `scripts/release/lib/common.mjs`). No workspace `node_modules` package executes before its installed bytes have been validated. After the script-disabled install succeeds, package/lock/source bytes and candidate/main cleanliness are rechecked, the pre-lifecycle tree matches policy, and every pre-install identity is discarded. A private `withPreLifecycleReportLease` then binds the exact Zod package root/lock row/tree plus `node_modules/zod/index.js` and tracked `report-schema.mjs`, rechecks immediately before import, imports only Zod/report-schema, and closes all handles in `finally`. This preloaded strict schema exists solely so a controlled-lifecycle/final-tree failure can still publish a valid FAIL prefix. The security core, SemVer, node-abi, probe, and every other protected application/dependency module remain unimported until the controlled lifecycle completes and the final `withPostInstallBindingsLease` succeeds.

Use the Task 2C-1 runner for fixed Git/Node/npm/Electron commands. Require symbolic `refs/heads/task15`, clean committed HEAD, and exactly one clean non-bare/unlocked `refs/heads/main` worktree at `eb1a07bb950769cf24d0fe5c61c710fed4da0fba`; parse `git worktree list --porcelain -z` structurally and never serialize either worktree path. At fresh release-run entry capture one `now` instant. With no `SOURCE_DATE_EPOCH`, choose `floor(now/1000)`; with one case-insensitive exact variable, accept only canonical decimal seconds in `[946684800, floor(now/1000)]`. Reject duplicate case variants, signs, whitespace, fractions, leading zeroes, overflow, every future second (including `now+1`), or a Git commit epoch later than the chosen release epoch. This is the sole ambient release value read. Frozen loading never rereads ambient epoch or current wall clock; it derives the exact epoch from the existing canonical metadata and uses a private read-only gate bound to that epoch. Prepare metadata once, call the one-object context constructor once, and pass that exact object identity onward. Caller environment cannot choose a path, executable, report, mode, or bypass.

`prepareDependencyBootstrap(...)` runs the held policy-approved Node/npm closure with exact arguments `ci --ignore-scripts --no-audit --no-fund`; the minimal environment fixes user/global config to `NUL`, ignores lifecycle scripts, disables prompts/update notices, and rejects inherited registry/token/proxy/cache/prefix/workspace overrides. It rechecks Git/package/lock bytes and hashes and requires the canonical ordinary pre-lifecycle `node_modules` tree to match the reviewed policy before metadata is written. If this command or validation fails, it may atomically write only the strict fixed diagnostic `release-validation/reports/preflight-bootstrap-failure.json` with exact shape `{schemaVersion:1,stage:'preflight-bootstrap',status:'FAIL',blocker:'Dependency bootstrap failed'}`; this file is never evidence and its write failure does not mask the original failure. It returns no context or StageResult and leaves no canonical PASS report. Missing cache/network fails closed; the runner never substitutes a registry, proxy, token, alternate cache, or existing `node_modules` tree.

Each `createPreflightCore` instance owns a private `WeakMap<PendingDependencyBootstrap,BootstrapRecord>`. A token is a unique frozen object with no enumerable data and is minted only after quarantine, script-disabled install, Git/package/lock revalidation, and the exact pre-lifecycle tree validation succeed. Its private record binds the core/production-dependency identity, canonical workspace and held directory identity, the exact `EarlyReleaseFacts` object identity, HEAD/package/lock/policy/descriptor/pre-tree hashes, quarantine completion, and later metadata/context identities. The only transitions are `BOOTSTRAPPED -> METADATA_PREPARING -> METADATA_PREPARED -> CONSUMED`; entry changes phase before its first await/write, metadata failure becomes terminal `POISONED`, and `runPreflight` remains `CONSUMED` on success, failure, exception, publication ambiguity, or concurrent re-entry. No transition rolls back and no token retry is allowed.

`prepareReleaseMetadata(...)` requires the exact token/core/workspace/releaseFacts identities and records the exact `PreparedMetadata` object, path, bytes/hash, and epoch. `runPreflight(...)` requires that same token in `METADATA_PREPARED`, consumes it before any lifecycle/report side effect, verifies context values against the recorded release facts and PreparedMetadata, then records and admits only that exact context object identity. Unknown, cloned, forged, reused, cross-core, cross-workspace, cross-facts, cross-metadata, or cross-context tokens fail before lifecycle/report work. Every directory/file handle retained in a BootstrapRecord or pre-/post-lifecycle lease is closed by one terminal `finally` on success, poisoning, consumption, publication ambiguity, or exception; closing never rolls a phase back or makes a token retryable. Test-core results can support assertions only and are not evidence consumable by the production `release:rc`.

The policy freezes the pre-lifecycle whole-tree `{fileCount,totalBytes,treeSha256}`, the only allowed lifecycle payloads and their entry hashes/arguments in exact order (Electron install, esbuild verification/install, and electron-winstaller architecture selection), and the final whole-tree `{fileCount,totalBytes,treeSha256}` plus pinned Electron executable hash; `better-sqlite3` must use the lock-supplied `prebuilds/win32-x64.node` and must not run an implicit `node-gyp rebuild`. Tree bytes must exactly match Task 2C-1: ordinal-sort POSIX relative paths, serialize each compact row with key order `relativePath,size,fileSha256`, serialize the compact array, append one LF, then SHA-256. Task 1 `canonicalJson()` is not used for this digest because it sorts object keys differently. Task 2C-1A extracts the serializer from the existing controller marker; Task 2C-2 uses an independent fixed fixture byte/hash oracle and requires its implementation plus the extracted serializer to equal that oracle. No fourth marker or production tree-fixture API is added.

After the opaque bootstrap token and one metadata/context creation reach `runPreflight(...)`, its first `npm-ci` stage executes only those validated payloads through the owned runner, verifies the pinned Electron executable and final tree, and creates an immutable in-memory `PostInstallBindings` plain-data projection. It contains exactly `{schemaVersion:1,nodeModulesTree,packages,packageEntries,workspaceEntries}`; package rows are `{name,version,lockIntegrity,rootRelativePath,treeSha256}`, package-entry rows are `{id,packageName,relativePath,fileSha256}`, and project rows are `{id,relativePath,fileSha256}`. Every `rootRelativePath` and `relativePath` below is workspace-relative POSIX text, and the following literal order is part of the contract.

Package rows are: `electron@35.7.5 -> node_modules/electron`; `electron-builder@26.15.3 -> node_modules/electron-builder`; `vitest@3.2.7 -> node_modules/vitest`; `typescript@5.9.3 -> node_modules/typescript`; `eslint@9.39.5 -> node_modules/eslint`; `vite@7.3.6 -> node_modules/vite`; `better-sqlite3@13.0.2 -> node_modules/better-sqlite3`; `zod@4.4.3 -> node_modules/zod`; `semver@7.8.5 -> node_modules/semver`; `node-abi@4.33.0 -> node_modules/node-abi`. Every integrity string equals the exact lockfile package row.

Package-entry rows are: `electron-executable -> electron -> node_modules/electron/dist/electron.exe`; `electron-entry -> electron -> node_modules/electron/index.js`; `electron-builder-cli -> electron-builder -> node_modules/electron-builder/cli.js`; `vitest-cli -> vitest -> node_modules/vitest/vitest.mjs`; `typescript-cli -> typescript -> node_modules/typescript/bin/tsc`; `eslint-cli -> eslint -> node_modules/eslint/bin/eslint.js`; `vite-cli -> vite -> node_modules/vite/bin/vite.js`; `better-sqlite3-win32-loader -> better-sqlite3 -> node_modules/better-sqlite3/lib/win32-x64.js`; `better-sqlite3-prebuild -> better-sqlite3 -> node_modules/better-sqlite3/prebuilds/win32-x64.node`; `zod-entry -> zod -> node_modules/zod/index.js`; `semver-entry -> semver -> node_modules/semver/index.js`; `node-abi-entry -> node-abi -> node_modules/node-abi/index.js`. The probe imports only `better-sqlite3/win32-x64`; generic `better-sqlite3`, `lib/index.js`, binding search, and alternate native paths are rejected.

Workspace-entry rows are: `preflight -> scripts/release/preflight.mjs`; `native-abi-probe -> scripts/release/native-abi-probe.mjs`; `vitest-preflight-reporter -> scripts/release/vitest-preflight-reporter.mjs`; `trusted-windows-runner -> scripts/release/lib/trusted-windows-runner.mjs`; `release-toolchain-policy -> scripts/release/release-toolchain.json`; `release-metadata -> scripts/lib/release-metadata.mjs`; `release-context -> scripts/release/lib/release-context.mjs`; `release-common -> scripts/release/lib/common.mjs`; `report-schema -> scripts/release/lib/report-schema.mjs`; `security-checklist -> scripts/release/lib/security-checklist.mjs`; `icon-generator -> scripts/generate-app-icons.mjs`; `package-manifest -> package.json`; `vitest-config -> vitest.config.ts`; `vite-main-config -> vite.main.config.ts`; `vite-preload-config -> vite.preload.config.ts`; `vite-renderer-config -> vite.renderer.config.ts`; `electron-builder-config -> electron-builder.yml`; `eslint-config -> eslint.config.mjs`; `tsconfig -> tsconfig.json`; `tsconfig-node -> tsconfig.node.json`; `tsconfig-ipc -> tests/typecheck/tsconfig.json`; `migration-test -> src/main/database/__tests__/Migration.test.ts`; `release-migration-test -> src/main/database/__tests__/ReleaseMigration.test.ts`; `legacy-safety-test -> src/main/database/__tests__/DatabaseLegacySafety.test.ts`; `diagnostics-release-test -> src/main/diagnostics/__tests__/DiagnosticsExporter.release.test.ts`. The lockfile and fixed release/app-update/icon contracts remain separately hash-bound invariants rather than duplicate binding rows.

The exact tables are constants in production and deep-equal fixtures in tests; no arbitrary workspace JS path is accepted. Ordinary/non-reparse containment, package/final-tree hashes, entry identities, and hashes are checked before and after use. The public `loadPostInstallBindings(...)` is implemented as the frozen projection of the same private `withPostInstallBindingsLease` core used by frozen loading. Its returned object never contains or serializes handles and is only a point-in-time prerequisite, not executable authorization. The private lease keeps opened directory/file identities alive while protected dynamic imports execute, rechecks immediately before each import, and closes them in one `finally`; callers that retain only the projection must rebind. Each later command is independently protected by the Task 2C-1 runner's held critical inputs/tree checks. The npm-ci row covers both the earlier script-disabled install and controlled completion; a lifecycle or final-tree failure is terminal. A standard-user concurrent replacement that Node cannot fully prevent remains an explicitly reported residual; pre/post identity and hashes detect drift but are not described as a cryptographic guarantee.

- [ ] **Step 3: Implement exact invariants, report publication, and frozen loading**

`release-invariants` remains one bounded report row but its in-process subchecks are frozen: (1) candidate/main Git plus package/lock/release-contract/release-notes equality; (2) context metadata and compiled-Main/resource byte parity; (3) full-test discovery includes the exact six Task 2C-1A predicates with zero failed/skipped/todo; (4) app-update and icon tracked/generated parity; (5) reviewed builder configuration/input contracts, fixed no-publish descriptor, Vite output/resource parity, icon inputs, and packaged-input source-map exclusion; and (6) locked Electron/Node/npm/native facts equal the context, policy oracle, and completed probes. Actual installer/unpacked builder-output identity belongs to Task 2D and is not required before Task 2D runs. Do not rerun Vitest inside the invariant.

`prepareDependencyBootstrap(...)` first requires the workspace and existing `release-validation`, `reports`, and `staging` components to be ordinary/non-reparse. On a fresh checkout it creates only those three fixed missing directories one component at a time, then reopens and identity-binds the complete directory chains before checking either canonical file; no caller path or recursive broad creation is accepted. If the canonical report is absent, two bound absence checks around the held-directory acquisition establish the fresh branch. If present, it opens the report by handle, binds its file identity/hash, rechecks parent/path identity, and renames that still-held identity to an exclusive random stale sibling in the same held directory. It then reopens and verifies the sibling and proves the canonical path absent; any collision, replacement, parent drift, rename ambiguity, or inability to establish absence aborts before `npm ci`. It never pathname-deletes either file. This is subject to the explicitly documented same-user race residual rather than described as atomic handle-relative rename.

`prepareReleaseMetadata(...)` reuses only the pure `createReleaseMetadata(...)` constructor. A private fixed-path writer in `preflight.mjs` serializes exactly `JSON.stringify(metadata, null, 2) + '\n'`, matching the existing Foundation snapshot contract, inside the already held `staging` directory. It opens an exclusive random sibling temp in that directory, writes and syncs through the held handle, rechecks the held parent/temp/target absence or prior identity, renames in the same directory, then stably reopens and verifies canonical bytes, schema, deep equality, file/parent identity, and SHA-256 before returning `PreparedMetadata`. It performs no recursive directory creation, pathname cleanup, caller path, or fallback to the Foundation CLI writer or generic key-sorting `writeAtomicJson(...)`; a failure may leave only the documented own random temp/final ambiguous bytes and returns no PreparedMetadata.

On PASS or first post-context failure, strictly parse, call the reviewed same-directory exclusive-temp report writer, then stably reopen the canonical path by handle and verify parent/file identity, hash, schema, and deep equality before returning the matching StageResult. A write/reopen/hash ambiguity returns no StageResult and never falls back to an older reference. Command rows preserve their first failing child/postcondition category and real-or-null exit code according to Task 2C-1A; exactly one FAIL terminates the ten-stage prefix. Raw output, exceptions, paths, and environment never enter the report.

`loadFrozenPreflightContext(...)` has one non-cyclic, zero-write order. It first loads only Node built-ins and reviewed local built-in-only bootstrap modules, then stably reads the existing fixed metadata snapshot and derives its exact epoch without consulting ambient `SOURCE_DATE_EPOCH` or wall clock. It runs a private read-only Git/package gate bound to that metadata epoch, verifies the snapshot against those facts, and calls built-in-only `createReleaseContext(...)` exactly once. With that context it enters private `withPostInstallBindingsLease`, validates the final tree and exact entry identities, and only while that lease is active dynamically imports Zod/report-schema or any other protected dependency. It then stably reads the canonical PASS report, strictly parses it, and requires full context/metadata/lock/toolchain/command/test/ABI equality; after final identity rechecks it computes the fixed `preflightReference`, closes every lease in `finally`, and returns only `{context,preflightReference}`. Import-sentinel and write-spy tests prove mutated pre-validation `node_modules` code never executes and success/failure both write nothing. It performs no bootstrap, lifecycle, metadata preparation, quarantine, or report publication.

The frozen-loader binding pass protects its dynamic imports. A diagnostic Task 2D build deliberately calls public `loadPostInstallBindings({workspaceRoot,context})` again immediately before its build runner; this second read-only point-in-time validation plus the runner's own held command inputs protects the later build boundary and is not token reuse. `release:preflight` is a zero-option standalone diagnostic. Its `npm run`/direct-Node entry is explicitly not pre-JavaScript preload protection and cannot emit a candidate freeze, final gate, Beta/GA label, or distribution state. The authoritative future `release:rc --freeze` invokes the imported functions in its reviewed release-controller process and retains the returned StageResult in memory; no fixed file's existence alone is authoritative.

The fresh orchestration order is exact and non-overridable: `runEarlyGitPackageGate({workspaceRoot})` once → `prepareDependencyBootstrap({workspaceRoot,releaseFacts})` once → `prepareReleaseMetadata({workspaceRoot,releaseFacts,dependencyBootstrap})` once → `createReleaseContext({workspaceRoot,releaseFacts,preparedMetadata})` once → `runPreflight({context,dependencyBootstrap})` once. The bootstrap token and context are frozen and module-owned; neither is serialized. A resume/diagnostic build calls `loadFrozenPreflightContext({workspaceRoot})` and then the just-in-time read-only `loadPostInstallBindings({workspaceRoot,context})`; it performs zero bootstrap, lifecycle, metadata, quarantine, or report write.

- [ ] **Step 4: Add the script, run diagnostic GREEN/regression, review, and amend**

Add `"release:preflight": "node scripts/release/preflight.mjs"`.

Run: `node node_modules/vitest/vitest.mjs run tests/release/release-preflight.test.ts tests/release/release-trusted-windows-runner.test.ts tests/release/release-context.test.ts tests/release/release-report-schema.test.ts tests/release/release-security-checklist.test.ts tests/release/release-metadata-script.test.ts src/main/release/__tests__/ReleaseMetadata.test.ts src/main/database/__tests__/Migration.test.ts src/main/database/__tests__/DatabaseLegacySafety.test.ts src/main/database/__tests__/ReleaseMigration.test.ts src/main/diagnostics/__tests__/DiagnosticsExporter.release.test.ts tests/release/app-update-config.test.ts src/main/release/__tests__/AppIcon.test.ts`

Run: `npm run typecheck`

Run: `node scripts/generate-app-update-config.mjs --verify`

Run (non-authoritative developer regression only): `& (Resolve-Path -LiteralPath 'node_modules/electron/dist/electron.exe').Path scripts/generate-app-icons.mjs --verify`

The authoritative preflight icon row already executes this verification through Task 2C-1 with fixed Electron identity, environment, and cleanup. This separate post-test developer command is not release evidence or a security-boundary claim; it must still use the locked workspace Electron resolved to an absolute path and never Node, `npm exec`, or PATH discovery.

Run: `git add package.json scripts/release/preflight.mjs scripts/release/native-abi-probe.mjs tests/release/release-preflight.test.ts && git commit --amend --no-edit`

### Task 2D: Bound Windows build, inventory, and legacy acceptance input migration

**Files:**
- Modify: `package.json`
- Create: `scripts/release/build-win.mjs`
- Modify: `scripts/windows-installer-acceptance.mjs`
- Create test: `tests/release/release-build-win.test.ts`

**Interfaces:**
- Consumes: Task 2C-1 zero-argument `loadReleaseToolchainPolicy()` and one-string, production-descriptor-only `runTrustedWindowsCommand(descriptorId)`, plus Task 2C-2 `loadBoundPreflightReport(...)` and `loadPostInstallBindings(...)`; Task 2D must not add a second process runner, fixture descriptor, or weaken the standard-user/OS-admin trust boundary. The bound report loader validates final bindings before importing/parsing the schema; the just-in-time binding loader runs again immediately before the build descriptor. Callers cannot inject a binding object.
- Produces: `runWindowsBuild({ context, preflightReference, deps }): Promise<StageResult>`, where `preflightReference` is exactly the sole `EvidenceReference` at `preflightStageResult.evidence[0]`, never the full Task 2C StageResult.
- Produces: `buildStageResult`, whose sole `buildReference = buildStageResult.evidence[0]` is `{ reportPath:'release-validation/reports/build-win.json', reportSha256, itemId:'ARTIFACT-BUILD-WIN' }`.
- Produces: `loadBoundBuildInventory({ workspaceRoot, contextId, buildReference }): BuildInventory` for signing, SBOM, Manifest, freeze, updater fixture, installer acceptance, and final gate.
- Migrates now: the legacy acceptance boundary uses the exact options object `{ context, buildReference, allowSystemMutation, deps }`; candidate selection resolves the workspace root internally from the tracked module location, derives `contextId` only from `context` when calling `loadBoundBuildInventory(...)`, and rejects any separate bare `contextId` or workspace-root option. Task 2D changes only candidate selection; Windows Subplan Task 2 later extracts/extends the real `runInstallerAcceptance(...)` flow behind this same interface, and Artifact Task 3 later replaces its Authenticode parser without changing it.

- [ ] **Step 1: Write the failing preflight-binding tests**

Reject missing/changed preflight bytes, path, item ID, context, metadata hash, lock hash, toolchain, non-PASS report, or extra report field before cleanup/spawn. The authoritative RC path retains the full `preflightStageResult` in memory, requires exactly one evidence entry, and passes only `preflightReference = preflightStageResult.evidence[0]` to `runWindowsBuild(...)`. `build-win.mjs` has a built-in-only top level: before any Zod/report-schema/electron-builder or other protected import it calls Task 2C `loadBoundPreflightReport({workspaceRoot,context,preflightReference})`, which creates the private final-binding lease, imports/parses under that lease, and returns strict report plus plain bindings. A standalone diagnostic `release:build:win` first calls `loadFrozenPreflightContext(...)`, which performs the same binding-before-schema rule while reconstructing its context/reference; it accepts no report/context/output argument and cannot emit freeze/final-gate status. Import-sentinel tests prove neither path loads protected dependencies before its Task 2C lease.

- [ ] **Step 2: Write the failing builder-boundary tests**

Inject Git-host/signing/provider tokens, CI/tag/publish hints, caller argv, and config/output overrides. Require the identity-bound Node executable to run the ordinary non-reparse locked `node_modules/electron-builder/cli.js` entry file with `shell:false` and a minimal environment; the builder argument portion after that fixed entry file deep-equals `['--win', '--publish', 'never']`, contains zero `--config.*` tokens, and exposes zero provider/network/upload adapter calls. Require internally set fixed metadata path/epoch and reject every caller-selected argument.

- [ ] **Step 3: Write the failing cleanup/inventory tests**

Validate the fixed output parent chain. If the output is absent, create only that fixed ordinary directory and revalidate it; if present, require an ordinary non-reparse directory. Remove only its children. Never remove `release-validation/`, staging metadata/catalog, reports, another worktree, or `release/`. A stale ignored `release/` directory may exist and is ignored, not selected and not treated as a failure.

Require exactly one ordinary installer and one ordinary unpacked root under staging. Recompute installer size/hash and the canonical sorted POSIX `{ relativePath, mode, size, fileSha256 }` tree digest. Reject zero/multiple candidates, reparse/non-ordinary members, containment drift, size/hash/tree mutation, wrong version, any of the three release-metadata hashes differing from `context.metadataSha256`, or tracked/packaged `app-update.yml` byte drift.

- [ ] **Step 4: Write the failing legacy-acceptance migration tests**

Prove `scripts/windows-installer-acceptance.mjs` no longer reconstructs `release/ClaudeWorkbench Setup <version>.exe`, scans a directory, or accepts a caller installer path. Its acceptance boundary takes exactly `{ context, buildReference, allowSystemMutation, deps }`, rejects a separate bare `contextId` or workspace-root option, resolves the workspace root internally from the tracked module location, calls `loadBoundBuildInventory({ workspaceRoot, contextId: context.contextId, buildReference })`, uses only the returned installer ID, and rechecks size/hash before MZ/install work. A stale `release/` installer is ignored even when present.

- [ ] **Step 5: Run the diagnostic RED**

Run: `node node_modules/vitest/vitest.mjs run tests/release/release-build-win.test.ts`

Expected: FAIL for missing build wrapper/inventory binding; no official 60-case record is written.

- [ ] **Step 6: Implement the bound build and acyclic report write**

Use only the strict report and plain binding projection returned by `loadBoundPreflightReport(...)`; do not import or parse `PreflightReportSchema` first. Deep-compare context/metadata/lock/toolchain, then immediately before cleanup/build call `loadPostInstallBindings({workspaceRoot,context})` again and require exact equality with that projection. Use the policy-bound Node plus its fixed electron-builder CLI entry and exact arguments `['--win', '--publish', 'never']` to package only into Task 2A's fixed staging output; the runner independently holds/rechecks the final tree, CLI/config/metadata inputs at target creation. Do not regenerate metadata/icons during packaging.

After packaging, build/validate the exact `BuildInventorySchema`, canonically and atomically write `release-validation/reports/build-win.json`, hash final bytes, and return `buildStageResult` with exactly one external `buildReference`. The build report contains `preflightReference`, but neither report contains its own hash and neither evidence reference names `candidate-freeze.json`.

- [ ] **Step 7: Implement the bound inventory loader and acceptance migration**

`loadBoundBuildInventory(...)` accepts only the fixed build path/item ID, binds report bytes/hash/context, parses `BuildReportSchema`, and rehashes installer/tree/metadata/bootstrap bytes before returning a frozen inventory. Update only candidate selection in the legacy acceptance script now, but make its options object exactly `{ context, buildReference, allowSystemMutation, deps }`; retain its current behavior for later Windows extraction and retain its current Authenticode implementation until Artifact Task 3 replaces it.

- [ ] **Step 8: Add the script, run diagnostic GREEN/regression, and amend**

Add `"release:build:win": "node scripts/release/build-win.mjs"`.

Run: `node node_modules/vitest/vitest.mjs run tests/release/release-build-win.test.ts tests/release/release-preflight.test.ts tests/release/release-report-schema.test.ts src/main/release/__tests__/InstallerConfig.test.ts tests/release/app-update-config.test.ts tests/release/release-metadata-script.test.ts`

Run: `npm run typecheck`

Before staging, verify the diff contains no CLI config override, caller-selected report/output/artifact path, provider/publish configuration, raw output/environment, machine-absolute path, generated release evidence, or change to the four trusted TDD anchors.

Run: `git add package.json scripts/release/build-win.mjs scripts/windows-installer-acceptance.mjs tests/release/release-build-win.test.ts && git commit --amend --no-edit`

### Task 3: Signing input inspection and post-build signature truth

**Files:**
- Create: `scripts/release/lib/authenticode.mjs`
- Create: `scripts/release/signing.mjs`
- Create: `src/shared/authenticode-command.json`
- Create: `src/main/release/AuthenticodeStatusReader.ts`
- Create: `src/main/release/RuntimeReleaseStatus.ts`
- Create test: `src/main/release/__tests__/AuthenticodeStatusReader.test.ts`
- Create test: `src/main/release/__tests__/RuntimeReleaseStatus.test.ts`
- Modify: `src/main/index.ts`
- Modify: `scripts/windows-installer-acceptance.mjs`
- Create test: `tests/release/release-signing.test.ts`

**Interfaces:**
- Consumes: Task 2A's strict four-field `src/shared/release-contract.json`; Task 3 reads its empty owner-approved publisher subject/thumbprint arrays and does not modify that contract or metadata bytes.
- Consumes: Task 2D `BuildInventory` through `loadBoundBuildInventory(...)`; no signing or acceptance path reconstructs an installer path.
- Produces: `inspectSigningInputs(env): SigningInputStatus` without returning values.
- Produces: `getAuthenticodeSignature(path, runner): Promise<SignatureEvidence>`.
- Produces: `verifyArtifactSignatures(inventory, policy): Promise<StageResult>`.
- Produces: runtime `inspectAuthenticode(path)` and `getRuntimeReleaseStatus({ packaged, updateSource, expectedPublisherPolicy })` for About/diagnostics/updater.

- [ ] **Step 1: Write failing signing tests**

Test Windows Certificate Store versus `CSC_LINK` source detection without values, `CSC_KEY_PASSWORD` presence without value, CI/cloud-signing template status, inspectable versus `configured_uninspected` credentials, missing/expired inspectable certificate, missing Code Signing EKU, timestamp configuration, Signed/NotSigned/UnknownError/HashMismatch/NotTrusted/Expired normalization, expected publisher subject/thumbprint mismatch, installer hash mutation, exact shared-command hash/parity, no packaged `.ps1`, development Electron never reported as the Workbench signer, production-feed status derived only from validated UpdateSourcePolicy, an explicit non-gate `DEFERRED_TO_INSTALL_ACCEPTANCE` uninstaller fact, PowerShell errors, redaction of passwords/tokens/authenticated URLs, and fake `powershell.exe` files placed in cwd/PATH that must never execute.

- [ ] **Step 2: Run the failing tests**

Run (observed red): `& ([IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'WindowsPowerShell\v1.0\powershell.exe')) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\release\tdd-evidence-launcher.ps1 -Phase red -CaseIds SIG-21,SIG-22,SIG-23,SIG-24,SIG-25 -CommandId artifact-signing -ChildArgumentsBase64 bm9kZQBub2RlX21vZHVsZXMvdml0ZXN0L3ZpdGVzdC5tanMAcnVuAHRlc3RzL3JlbGVhc2UvcmVsZWFzZS1zaWduaW5nLnRlc3QudHM=; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`


- [ ] **Step 3: Implement safe Authenticode inspection**

Store one fixed PowerShell command body and schema version in `src/shared/authenticode-command.json`. Release ESM and runtime TypeScript consume the same JSON; parity tests and the Manifest record its SHA-256. Read the owner-approved publisher subject/thumbprint arrays from Task 2A's already frozen strict release contract; they remain empty unless the owner later approves exact policy, and Task 3 must not rewrite the contract or metadata snapshot. Resolve the trusted Windows system directory without PATH/cwd search, form the absolute Windows PowerShell executable path, and require it to be a regular non-reparse file; otherwise return `UnknownError`. Spawn that absolute executable with `shell:false`, a fixed safe cwd, a minimal allowlisted child environment, and `-NoProfile -NonInteractive -EncodedCommand <fixed-body>`. Pass the target only through one scoped child environment entry read by the fixed command and opened with `-LiteralPath`. Never interpolate the target into code, serialize the child environment, or return the target path. Return only normalized status, signer subject/thumbprint when present, validity/EKU/timestamp categories, byte size, and SHA-256; callers attach an already approved workspace-relative artifact ID from `BuildInventory`. No `.ps1` or other loose script is copied into the app, avoiding a second runtime integrity/source surface.

- [ ] **Step 4: Implement the two explicit modes**

`node scripts/release/signing.mjs check` runs before electron-builder so it observes inputs before a build can consume them. It reports only the configured source class, inspectability category, inspectable public certificate validity/EKU category, timestamp-service configured/policy boolean, expected publisher policy configured boolean, expected executable inventory, and secret presence booleans. Windows Certificate Store public certificates may be inspected; `CSC_LINK`/cloud credentials that cannot be inspected without opening a PFX/private signing operation are truthfully `configured_uninspected`, not falsely PASS/invalid. It never opens or prints a PFX/password/private key. Post-build `verify` is the authoritative effective-certificate check: it checks installer and unpacked main EXE/every packaged helper hash, validity, Code Signing EKU, timestamp result, and approved publisher subject/thumbprint; it records `NotSigned` honestly when no inputs exist. No pre-install uninstaller gate item exists: inventory records `DEFERRED_TO_INSTALL_ACCEPTANCE`, and the isolated installation harness later creates the one final hash/status gate item.

- [ ] **Step 5: Reuse the shared inspector in installer acceptance**

Remove the private duplicate Authenticode parser from `windows-installer-acceptance.mjs`; import `getAuthenticodeSignature()`, keep its Task 2D `loadBoundBuildInventory(...)` input, and bind the installed EXE and uninstaller results to hashes. Main calls `getRuntimeReleaseStatus({ packaged, updateSource, expectedPublisherPolicy })`: development never inspects/displays Electron's vendor signature, `productionFeedConfigured=true` only when the already validated UpdateSourcePolicy result is production, and `Signed` requires an approved subject/thumbprint from the same tracked release contract. It supplies only bounded signature/feed/license/privacy facts used by `ReleaseVersionInfo`. `UpdateSignatureInspector` in Subplan 3 consumes `AuthenticodeStatusReader` rather than spawning a second implementation.

- [ ] **Step 6: Add scripts, re-run, and amend**

Add `release:signing-check` and `release:verify-signature` to `package.json`.

Run: `git add -N -- src/shared/authenticode-command.json src/main/release/AuthenticodeStatusReader.ts src/main/release/RuntimeReleaseStatus.ts src/main/release/__tests__/AuthenticodeStatusReader.test.ts src/main/release/__tests__/RuntimeReleaseStatus.test.ts scripts/release/lib/authenticode.mjs scripts/release/signing.mjs tests/release/release-signing.test.ts` (intent-to-add for artifact-signing: makes new final-green inputs index-visible; it is not final staging or a commit).

Run (diagnostic green, not recorded): `node node_modules/vitest/vitest.mjs run tests/release/release-signing.test.ts src/main/release/__tests__/AuthenticodeStatusReader.test.ts src/main/release/__tests__/RuntimeReleaseStatus.test.ts`

Expected: PASS. The single approved observed green for `artifact-signing` is deferred to Subplan 5's final observation phase, after every planned modification to its owned paths.

Run: `git add package.json src/shared/authenticode-command.json src/main/release/AuthenticodeStatusReader.ts src/main/release/RuntimeReleaseStatus.ts src/main/release/__tests__/AuthenticodeStatusReader.test.ts src/main/release/__tests__/RuntimeReleaseStatus.test.ts src/main/index.ts scripts/release/lib/authenticode.mjs scripts/release/signing.mjs scripts/windows-installer-acceptance.mjs tests/release/release-signing.test.ts && git commit --amend --no-edit`

### Task 4: SBOM, third-party notices, and packaged-runtime parity

**Files:**
- Create: `scripts/release/lib/artifact-inventory.mjs`
- Create: `scripts/release/sbom.mjs`
- Create test: `tests/release/release-sbom.test.ts`

**Interfaces:**
- Consumes: Task 2D `loadBoundBuildInventory(...)`; the SBOM stage starts from the revalidated unpacked-tree ID/digest and never accepts a caller-selected unpacked root.
- Produces: `generateCycloneDxSbom(context, runner)`.
- Produces: `collectPackagedRuntimeInventory({ contextId, buildReference })`.
- Produces: `reconcileSbomComponents(sbom, packageLock, inventory)`.
- Produces: `generateThirdPartyNotices(components)`.

- [ ] **Step 1: Write failing closure/parity tests**

Fixtures cover production-only direct/transitive packages, Electron/Chromium/Node runtime facts, `better-sqlite3.node`, Claude Agent SDK runtime, duplicate package versions, missing packaged components, extra packaged components, malformed SPDX expressions, unknown licenses, and notice byte changes after review.

- [ ] **Step 2: Run the failing tests**

Run (observed red): `& ([IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'WindowsPowerShell\v1.0\powershell.exe')) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\release\tdd-evidence-launcher.ps1 -Phase red -CaseIds SBM-45,SBM-46,SBM-47,SBM-48,SBM-49 -CommandId artifact-sbom -ChildArgumentsBase64 bm9kZQBub2RlX21vZHVsZXMvdml0ZXN0L3ZpdGVzdC5tanMAcnVuAHRlc3RzL3JlbGVhc2UvcmVsZWFzZS1zYm9tLnRlc3QudHM=; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`


- [ ] **Step 3: Generate a fixed CycloneDX base**

Run exactly `npm sbom --package-lock-only --omit=dev --sbom-format=cyclonedx` through the injected runner, parse JSON, canonicalize ordering, and write `release-validation/artifacts/sbom.cdx.json`. Do not silently include dev dependencies.

- [ ] **Step 4: Reconcile the actual packaged closure**

Inspect `app.asar` with the already locked local `@electron/asar` module (missing local module is a preflight failure; never invoke `npx` or download a tool), unpacked native modules, Electron version, Chromium/Node versions, and fixed resources. Every production lock component must be accounted for as packaged or intentionally bundled; every discovered runtime component must map to an SBOM component or an explicit runtime entry. Unknown or review-required licenses produce a named blocker; they cannot be waived by the script.

- [ ] **Step 5: Generate notices from the reconciled set**

Write canonical `release-validation/artifacts/THIRD_PARTY_NOTICES.txt` with package name/version, resolved license expression, license-file source/hash, homepage/repository, copyright/notice source, copyleft-review flag, dual-license flag, unknown-license flag, and evidence hash. It contains no project-license assertion and never replaces `LICENSE-DECISION-REQUIRED.md`.

- [ ] **Step 6: Add script, re-run, and amend**

Add `release:sbom` to `package.json`.

Run: `git add -N -- scripts/release/lib/artifact-inventory.mjs scripts/release/sbom.mjs tests/release/release-sbom.test.ts` (intent-to-add for artifact-sbom: makes new final-green inputs index-visible; it is not final staging or a commit).

Run (diagnostic green, not recorded): `node node_modules/vitest/vitest.mjs run tests/release/release-sbom.test.ts`

Expected: PASS. The single approved observed green for `artifact-sbom` is deferred to Subplan 5's final observation phase, after every planned modification to its owned paths.

Run: `git add package.json scripts/release/lib/artifact-inventory.mjs scripts/release/sbom.mjs tests/release/release-sbom.test.ts && git commit --amend --no-edit`

### Task 5: Immutable manifest, packaged scans, and checksum ordering

**Files:**
- Create: `scripts/release/manifest.mjs`
- Create: `scripts/release/verify.mjs`
- Create test: `tests/release/release-manifest.test.ts`
- Create test: `tests/release/release-verify.test.ts`

**Interfaces:**
- Consumes: Task 2D's revalidated `BuildInventory` plus Task 3 signature and Task 4 SBOM/notices references; it never rediscovers an installer or unpacked directory.
- Produces: `createImmutableManifest(context, inventory, referencedReports)`.
- Produces: `verifyManifest(manifest, root)`, `writeArtifactChecksums(files)`, and `writeDeliveryChecksums(files)`.
- Produces: `verifyPackagedAllowlist()`, `verifyEmbeddedMetadataParity()`, `verifyAssetAllowlist()`.

- [ ] **Step 1: Write failing manifest and mutation tests**

Test relative paths, deterministic ordering, final-byte hashes, missing/extra files, post-manifest mutation, bundle/resource metadata mismatch, unexpected native executables, source maps/tests/source files, forbidden legacy hashes, malformed ICO frames, asset-notice mismatch, embedded SVG/raster inventory, canonical unpacked-tree digest mutation, pre-manifest signature-report binding, and manifest self/gate/acceptance cycles.

- [ ] **Step 2: Run the failing tests**

Run (observed red): `& ([IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'WindowsPowerShell\v1.0\powershell.exe')) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\release\tdd-evidence-launcher.ps1 -Phase red -CaseIds SEC-58,SEC-59,SEC-60 -CommandId artifact-package-scans -ChildArgumentsBase64 bm9kZQBub2RlX21vZHVsZXMvdml0ZXN0L3ZpdGVzdC5tanMAcnVuAHRlc3RzL3JlbGVhc2UvcmVsZWFzZS1tYW5pZmVzdC50ZXN0LnRzAHRlc3RzL3JlbGVhc2UvcmVsZWFzZS12ZXJpZnkudGVzdC50cw==; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`


- [ ] **Step 3: Implement the immutable artifact manifest**

Write the manifest to `release-validation/artifacts/release-manifest.json`. It records release context ID, version/channel/build ID/commit, toolchain, installer/SBOM/notices/release-notes/asset paths, sizes, SHA-256, the sanitized Vite build-analysis report hash, the pre-manifest `verify-signature` report path/hash, packaged dependency inventory, and the already completed preflight test summary `{ files, tests, passed, failed, skipped, reportSha256 }`. The build-analysis schema contains only relative chunk names, fixed dependency-category enums, rendered-length estimates, and totals—never resolved module/source paths. The unpacked application uses a canonical tree digest over sorted `{relativePath, mode, size, fileSha256}` entries, not a directory-path pseudo-hash. The manifest explicitly excludes itself, real acceptance, final gate, and both checksum ledgers.

- [ ] **Step 4: Implement package and asset scans**

Unpack ASAR into ignored validation storage. Enforce an extension/path allowlist, known native helpers, no `.map`, tests, fixtures, databases, logs, credentials, temp files, release reports, or absolute source paths. Scan filenames, manifest/resource text, SVG markup, raster/ICO dimensions, and the rejected legacy byte hashes. Do not download, extract, or commit third-party logo reference images merely for scanning. Automated output is only `NO_KNOWN_FORBIDDEN_MATCH`; the mandatory human visual review remains separate and neither result claims legal trademark clearance.

- [ ] **Step 5: Verify final bytes and call signing verification**

`release:verify` loads and hashes the manifest, verifies every entry, verifies the bundle/resource metadata snapshot, asset notice hashes, SBOM parity, release-notes hash, installer/unpacked allowlist, and invokes `verifyArtifactSignatures()` again on the same file hashes to prove the pre-manifest report has not gone stale. `release:verify --check-only --no-write` performs the same checks entirely in memory and never writes a report or changes hash/mtime.

- [ ] **Step 6: Implement the two acyclic checksum ledgers**

Before candidate freeze, `writeArtifactChecksums()` writes `release-validation/artifacts/ARTIFACT_SHA256SUMS.txt` over immutable installer/unpacked-tree manifest/metadata/SBOM/notices/assets/release notes/signature/verify inputs and excludes itself. Final gate requires this verified inner ledger. After acceptance, evaluate the gate in memory and render final JSON/Markdown only beneath a new exclusive `release-validation/.delivery-<context>.partial/` directory; a partial report is never a success marker. `writeDeliveryChecksums()` creates the outer `SHA256SUMS.txt` in that directory using the eventual canonical `release-validation/delivery/<context>/...` relative names, covers the inner ledger plus every final evidence/report, and excludes itself. Verify all mapped pending bytes, atomically rename the whole directory to its canonical delivery path, then verify it again. Any failure quarantines/removes the canonical directory before returning and leaves no canonical PASS report or completion receipt. Only after successful post-rename verification write an atomic, non-ledger `release-validation/release-complete.json` receipt containing the context ID plus outer-ledger/final-report hashes and terminal status. Consumers and `release:rc` treat that receipt as the sole authoritative success marker; the final report may cite the inner ledger but not its own outer-ledger/receipt result. `verifyDeliveryLedger({ noWrite:true })` snapshots and later rechecks the receipt hash/mtime, the outer `SHA256SUMS.txt` file's own hash/mtime, every inner/outer entry hash/mtime, and the sorted canonical-delivery relative-name set so a no-write check also detects a same-byte ledger rewrite, receipt rewrite, or added/deleted file.

- [ ] **Step 7: Add scripts, re-run, and amend**

Add `release:manifest` and `release:verify` to `package.json`.

Run: `git add -N -- scripts/release/manifest.mjs scripts/release/verify.mjs tests/release/release-manifest.test.ts tests/release/release-verify.test.ts` (intent-to-add for artifact-package-scans: makes new final-green inputs index-visible; it is not final staging or a commit).

Run (diagnostic green, not recorded): `node node_modules/vitest/vitest.mjs run tests/release/release-manifest.test.ts tests/release/release-verify.test.ts`

Expected: PASS. The single approved observed green for `artifact-package-scans` is deferred to Subplan 5's final observation phase, after every planned modification to its owned paths.

Run: `git add package.json scripts/release/manifest.mjs scripts/release/verify.mjs tests/release/release-manifest.test.ts tests/release/release-verify.test.ts && git commit --amend --no-edit`

### Task 6: Stop-on-failure release orchestrator skeleton

**Files:**
- Create: `scripts/release/rc.mjs`
- Create test: `tests/release/release-rc.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `preflightStageResult` from Task 2C and `buildStageResult` from Task 2D during `--freeze`; after requiring exactly one evidence entry in each, it stores `preflightReference = preflightStageResult.evidence[0]`, `buildReference = buildStageResult.evidence[0]`, and the canonical inventory hash.
- Produces: `RELEASE_FREEZE_STAGE_ORDER`, `RELEASE_RESUME_STAGE_ORDER`, and `runReleaseCandidate(deps)`.
- Defers: real acceptance and final gate emission to Subplan 5.

- [ ] **Step 1: Write failing stage-order tests**

```ts
expect(RELEASE_FREEZE_STAGE_ORDER).toEqual([
  'preflight', 'signing-check', 'build-win', 'verify-signature', 'sbom',
  'manifest', 'verify', 'artifact-checksums', 'freeze-candidate',
]);
expect(RELEASE_RESUME_STAGE_ORDER).toEqual([
  'validate-manual-evidence', 'acceptance', 'evaluate-final-gate',
  'prepare-delivery', 'publish-delivery', 'completion-receipt',
]);
```

Assert stop-on-first-failure, context/hash parity at every boundary, no final gate from any child CLI, the inner artifact ledger before freeze, no canonical final report before pending delivery verifies, no receipt before canonical delivery re-verifies, cleanup/quarantine on every publish/receipt failure, and a skeleton result of `closedBetaReady=false` while acceptance is unavailable.

- [ ] **Step 2: Run the failing test**

Run: `npm exec vitest -- run tests/release/release-rc.test.ts`

- [ ] **Step 3: Implement the skeleton orchestration**

Use direct imports and structured return values, not `npm run` recursion. `--freeze` performs the single early-Git/package gate → script-disabled dependency bootstrap and pre-lifecycle verification → metadata preparation → release-context sequence, then passes that exact context plus the opaque bootstrap token only into preflight. Later stages receive the same context and reconstruct the fixed read-only post-install bindings rather than receiving or serializing the token. It writes `candidate-freeze.json` with exactly the frozen context, normalized epoch, metadata path/hash/mtime, `preflightReference`, `buildReference`, `buildInventorySha256`, installer, icon, manifest, verify report, and inner-ledger hashes plus state `AWAITING_MANUAL_EVIDENCE`. `buildInventorySha256` is SHA-256 of canonical JSON plus one LF for the strict inventory returned by `loadBoundBuildInventory(...)`. Both references are external hash-bound `{ reportPath, reportSha256, itemId }` values; neither report nor reference contains the freeze path/hash, so the graph is acyclic. The freeze is not a final report and contains no Beta/GA pass label. `--resume` reruns the read-only early gate, then loads and validates those frozen bytes; it never calls `prepareDependencyBootstrap()` or `prepareReleaseMetadata()` and never writes metadata/context. It must match every frozen hash/mtime and the manual-evidence hash. Tests freeze and resume under different wall clocks and prove the snapshot/context hash and mtime remain unchanged, while any deliberate mutation fails. Until Subplan 5 supplies acceptance/final-gate functions, resume fails closed; never create `PASS_FOR_CLOSED_BETA`.

- [ ] **Step 4: Add script and run the complete subplan verification**

Add `release:rc` to `package.json`.

Run: `npm exec vitest -- run tests/release/release-context.test.ts tests/release/release-report-schema.test.ts tests/release/release-preflight.test.ts tests/release/release-build-win.test.ts tests/release/release-signing.test.ts tests/release/release-sbom.test.ts tests/release/release-manifest.test.ts tests/release/release-verify.test.ts tests/release/release-rc.test.ts`

- [ ] **Step 5: Amend the reviewed subplan checkpoint**

Run: `git add package.json scripts/release/rc.mjs tests/release/release-rc.test.ts && git commit --amend --no-edit`
