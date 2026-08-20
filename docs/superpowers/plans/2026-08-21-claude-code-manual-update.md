# Manual Claude Code Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Settings-only **立即更新** action that safely runs the exact authoritative Claude Code CLI's fixed `update` command and verifies the same installation and version afterward.

**Architecture:** A shared `ClaudeInvocationResolver` selects one canonical structured invocation for environment checks, real tasks, and updates. A synchronous shared/exclusive `ClaudeRuntimeMutationGate` prevents probes or tasks from overlapping an update, while an opt-in close-only `ProcessSupervisor` mode keeps update-process ownership through `close` and cleanup. The Renderer receives only a bounded state DTO through trusted zero-argument IPC and can trigger mutation only from the explicit Settings button.

**Tech Stack:** TypeScript, Electron main/preload/renderer, Node child processes, React, Zod, Vitest, Testing Library, ESLint.

**Spec:** `docs/superpowers/specs/2026-08-21-claude-code-manual-update-design.md`

## Global Constraints

- The only update trigger is a user click on **立即更新**. No startup, timer, navigation, state-read, automatic-check, or background path may invoke the update.
- The only mutating command suffix is exactly `['update']`; version probes use exactly `['--version']`; every spawn uses `shell: false`.
- Renderer code never supplies an executable, path, argv, version, URL, environment, package manager, or raw command.
- Tests use injected local fakes and synthetic fixtures. No test runs the machine's real `claude update`, contacts an update service, or changes installed Claude Code.
- Environment checks, real `ClaudeCliAdapter` execution, and the updater use the same resolver instance and first-candidate algorithm.
- The runtime gate is synchronous and fail-fast: ordinary probes/tasks and the exclusive updater never queue, retry, or overlap.
- The update lease is released only after child `close` and cleanup confirmation. `cleanup_unconfirmed` keeps it latched until successful disposal.
- `FORCE_FAKE=1` produces `unavailable/unsupported_installation` with zero resolver and process calls.
- Raw paths, stdout, stderr, environment values, tokens, and exception messages never enter public snapshots, Renderer text, or public logs.
- Do not add dependencies or modify `package.json`, `package-lock.json`, release scripts/tests/contracts, release toolchain/policy, reviewed-input hashes, Vite/Vitest/TypeScript/ESLint configuration, or `src/main/release/**`.
- Do not add retry, `.skip`, `.only`, `.todo`, automatic behavior, generic IPC, package-manager fallback, or a real update smoke test.

---

### Task 1: Add opt-in close-only process ownership

**Files:**
- Modify: `src/main/processes/ProcessSupervisor.ts`
- Modify: `src/main/processes/__tests__/ProcessSupervisor.test.ts`
- Modify: `src/main/processes/__tests__/ProcessSupervisor.release.test.ts`

**Interfaces:**
- Consumes: existing `ManagedProcessRequest`, `ManagedProcessHandle`, Windows `taskkill` termination, and process journal.
- Produces: `ManagedProcessSettlement = 'error-or-close' | 'close-only'`, optional request fields `settlement` and `closeTimeoutMs`, plus a typed opaque `ManagedProcessCleanupUnconfirmedError` carrying one idempotent cleanup capability. Existing consumers retain `error-or-close` by default.

- [ ] **Step 1: Write failing ownership tests**

Add tests that preserve the default and distinguish close-only behavior:

~~~ts
it('keeps close-only ownership after error until close', async () => {
  const test = harness();
  const handle = await test.supervisor.spawn({
    id: 'update',
    kind: 'claude',
    command: 'claude-test',
    settlement: 'close-only',
    closeTimeoutMs: 50,
  });
  const child = test.children[0];
  child.emit('error', new Error('spawn-sentinel'));

  expect(test.supervisor.getActiveProcesses()).toHaveLength(1);
  let settled = false;
  void handle.waitForExit().finally(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);

  child.emit('close', null, null);
  await expect(handle.waitForExit()).resolves.toMatchObject({
    error: 'spawn-sentinel',
  });
  expect(test.supervisor.getActiveProcesses()).toEqual([]);
});
~~~

Add companion cases proving omitted `settlement` still settles on `error`, missing-PID close-only launch waits for bounded raw `close` before rejecting, journal failure does the same, timers/listeners are removed, and Windows forced termination still calls existing `taskkill(pid, true, forceMs)`. Also prove a returned close-only handle remains active and reusable after `terminate()` cannot confirm close, so a later close or second `terminate()` can complete ownership rather than losing the process.

Add deterministic ownership-transfer cases for both missing-PID and start-journal failure: the first bounded close wait expires, `spawn()` rejects with `ManagedProcessCleanupUnconfirmedError`, its opaque cleanup capability remains usable, a later child `close` lets `retryCleanup()` resolve exactly once, and repeated cleanup calls are idempotent. Assert the error/capability exposes no command, argv, environment, path, PID-targeting primitive, or raw child object.

- [ ] **Step 2: Run tests and verify RED**

~~~powershell
node node_modules/vitest/vitest.mjs run --no-cache src/main/processes/__tests__/ProcessSupervisor.test.ts src/main/processes/__tests__/ProcessSupervisor.release.test.ts
~~~

Expected: FAIL because the request has no close-only contract and current `error` handling removes ownership before `close`.

- [ ] **Step 3: Implement the opt-in mode**

~~~ts
export type ManagedProcessSettlement = 'error-or-close' | 'close-only';

export interface ManagedProcessRequest {
  // Retain every existing field.
  settlement?: ManagedProcessSettlement;
  closeTimeoutMs?: number;
}

interface ActiveProcess {
  // Retain every existing field.
  pendingError: unknown | undefined;
  settlement: ManagedProcessSettlement;
}

export interface ManagedProcessCleanupCapability {
  retryCleanup(options?: ProcessTerminationOptions): Promise<void>;
}

export class ManagedProcessCleanupUnconfirmedError extends Error {
  readonly code = 'MANAGED_PROCESS_CLEANUP_UNCONFIRMED';
  readonly cleanup: ManagedProcessCleanupCapability;
}
~~~

For close-only, record `error` but finalize only from `close`. For missing PID or journal failure, kill the owned child and await a raw close promise bounded by `closeTimeoutMs`; throw `ManagedProcessCleanupUnconfirmedError` when close does not arrive. The error's capability closes over only supervisor-owned state, retries termination/close confirmation, and becomes a no-op after confirmed close. It must not expose a raw child, PID-based kill, command, argv, environment, or path. Do not change default semantics.

Use `5_000` milliseconds when `closeTimeoutMs` is omitted, clamp caller values to the same positive bounded-delay rules used by grace/force timeouts, and unref only the cleanup timer. The raw close promise is independent of the journal-backed `active.exit` promise so a rejected start journal cannot masquerade as process close.

- [ ] **Step 4: Run the Step 2 command and verify GREEN**

Expected: all ProcessSupervisor tests pass with zero warnings.

- [ ] **Step 5: Commit**

~~~powershell
git add src/main/processes/ProcessSupervisor.ts src/main/processes/__tests__/ProcessSupervisor.test.ts src/main/processes/__tests__/ProcessSupervisor.release.test.ts
git commit -m "feat(processes): support close-owned child settlement"
~~~

---

### Task 2: Implement the synchronous runtime mutation gate

**Files:**
- Create: `src/main/claude/ClaudeRuntimeMutationGate.ts`
- Create: `src/main/claude/__tests__/ClaudeRuntimeMutationGate.test.ts`

**Interfaces:**
- Consumes: no mutable external dependency.
- Produces: `ClaudeRuntimeMutationGate`, idempotent `ClaudeRuntimeLease`, and `ClaudeRuntimeBusyError`.

- [ ] **Step 1: Write failing gate tests**

~~~ts
it('mutually excludes ordinary and update leases without queueing', () => {
  const gate = new ClaudeRuntimeMutationGate();
  const first = gate.tryAcquireOrdinary();
  const second = gate.tryAcquireOrdinary();
  expect(first?.kind).toBe('ordinary');
  expect(second?.kind).toBe('ordinary');
  expect(gate.tryAcquireUpdate()).toBeNull();

  first?.release();
  second?.release();
  const update = gate.tryAcquireUpdate();
  expect(update?.kind).toBe('update');
  expect(gate.tryAcquireOrdinary()).toBeNull();
  expect(gate.tryAcquireUpdate()).toBeNull();

  update?.release();
  expect(gate.tryAcquireOrdinary()?.kind).toBe('ordinary');
});

it('makes release idempotent', () => {
  const gate = new ClaudeRuntimeMutationGate();
  const lease = gate.tryAcquireOrdinary()!;
  lease.release();
  lease.release();
  expect(gate.snapshot()).toEqual({
    ordinaryLeaseCount: 0,
    updateActive: false,
  });
});
~~~

- [ ] **Step 2: Run and verify RED**

~~~powershell
node node_modules/vitest/vitest.mjs run --no-cache src/main/claude/__tests__/ClaudeRuntimeMutationGate.test.ts
~~~

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the gate**

~~~ts
export type ClaudeRuntimeLeaseKind = 'ordinary' | 'update';

export interface ClaudeRuntimeLease {
  readonly kind: ClaudeRuntimeLeaseKind;
  release(): void;
}

export class ClaudeRuntimeBusyError extends Error {
  readonly code = 'CLAUDE_RUNTIME_BUSY';
}

export class ClaudeRuntimeMutationGate {
  tryAcquireOrdinary(): ClaudeRuntimeLease | null;
  tryAcquireUpdate(): ClaudeRuntimeLease | null;
  isUpdateActive(): boolean;
  snapshot(): Readonly<{
    ordinaryLeaseCount: number;
    updateActive: boolean;
  }>;
}
~~~

Return frozen lease objects with idempotent closures. Do not add promises, queues, timers, or retries.

- [ ] **Step 4: Run the Step 2 command and verify GREEN**

- [ ] **Step 5: Commit**

~~~powershell
git add src/main/claude/ClaudeRuntimeMutationGate.ts src/main/claude/__tests__/ClaudeRuntimeMutationGate.test.ts
git commit -m "feat(claude): add runtime mutation gate"
~~~

---

### Task 3: Extract the authoritative invocation resolver

**Files:**
- Create: `src/main/claude/ClaudeInvocationResolver.ts`
- Create: `src/main/claude/__tests__/ClaudeInvocationResolver.test.ts`

**Interfaces:**
- Consumes: injected locator/filesystem/platform/environment facts.
- Produces: `ClaudeInvocationResolverPort`, `ResolvedClaudeInvocation`, `ClaudeInvocationResolution`, `sameClaudeInvocationIdentity()`, and `mergeClaudeInvocationEnvironment()`.

- [ ] **Step 1: Write failing resolver tests**

Use an injected in-memory filesystem and locator. Cover native/npm targets, first-candidate order, duplicate canonical lines, later distinct installations, empty-locator fallbacks, ordinary-file checks, case collisions, reparse/realpath drift, package-root escape, forbidden roots, frozen DTOs, and minimal environment patches.

~~~ts
it('does not let a later native binary overtake the first npm shim', () => {
  const test = resolverHarness({
    located: ['C:\\npm\\claude.cmd', 'C:\\native\\claude.exe'],
    files: {
      'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js': ordinaryFile(),
      'C:\\native\\claude.exe': ordinaryFile(),
    },
  });

  expect(test.resolver.resolve()).toEqual({
    ok: true,
    invocation: expect.objectContaining({
      provenance: 'npm',
      canonicalTargetPath: 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
      prefixArgs: ['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'],
      environmentPatch: { ELECTRON_RUN_AS_NODE: '1' },
    }),
  });
});

it('compares the complete resolver-owned identity', () => {
  expect(sameClaudeInvocationIdentity(baseInvocation(), {
    ...baseInvocation(),
    environmentPatch: { ELECTRON_RUN_AS_NODE: '0' },
  })).toBe(false);
});
~~~

- [ ] **Step 2: Run and verify RED**

~~~powershell
node node_modules/vitest/vitest.mjs run --no-cache src/main/claude/__tests__/ClaudeInvocationResolver.test.ts
~~~

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the resolver**

~~~ts
export type ClaudeInvocationFailureReason =
  | 'not_installed'
  | 'unsupported_installation';

export interface ResolvedClaudeInvocation {
  readonly executable: string;
  readonly prefixArgs: readonly string[];
  readonly environmentPatch: Readonly<Record<string, string>>;
  readonly displayPath: string;
  readonly canonicalTargetPath: string;
  readonly provenance: 'native' | 'npm';
}

export type ClaudeInvocationResolution =
  | { readonly ok: true; readonly invocation: ResolvedClaudeInvocation }
  | { readonly ok: false; readonly reason: ClaudeInvocationFailureReason };

export interface ClaudeInvocationResolverPort {
  resolve(): ClaudeInvocationResolution;
}

export interface ClaudeInvocationResolverOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly electronExecutable?: string;
  readonly untrustedRoots?: readonly string[];
  readonly locate?: () => readonly string[];
  readonly filesystem?: {
    realpath(filePath: string): string;
    lstat(filePath: string): {
      readonly dev: number;
      readonly ino: number;
      readonly size: number;
      readonly mtimeMs: number;
      isFile(): boolean;
      isSymbolicLink(): boolean;
    };
    readdir(directory: string): readonly string[];
  };
}
~~~

Inspect only the first locator result. Accept it or fail closed; never scan a later extension class. Use fixed fallbacks only when the locator returns no entry. For npm, canonicalize the real `cli.js` and set only `ELECTRON_RUN_AS_NODE=1`. Perform two stable observations and reject symbolic links, non-files, case collisions, changing realpaths, forbidden-root descendants, and package-boundary escape. Freeze every returned array/object.

The production locator invokes `where claude` on Windows or `which claude` elsewhere with `shell: false` and a 5-second timeout. The default filesystem delegates to `lstatSync`, `realpathSync.native`, and `readdirSync`; test injection never touches the host installation.

- [ ] **Step 4: Run the Step 2 command and verify GREEN**

Expected: no real installed Claude CLI is accessed.

- [ ] **Step 5: Commit**

~~~powershell
git add src/main/claude/ClaudeInvocationResolver.ts src/main/claude/__tests__/ClaudeInvocationResolver.test.ts
git commit -m "feat(claude): resolve one canonical CLI invocation"
~~~

---

### Task 4: Share resolver leases across adapter and system probes

**Files:**
- Modify: `src/main/claude/ClaudeCliAdapter.ts`
- Modify: `src/main/claude/__tests__/ClaudeCliAdapter.test.ts`
- Modify: `src/main/claude/__tests__/StartupClaudeAdapter.test.ts`
- Modify: `src/main/ipc/system.ts`
- Modify: `src/main/ipc/__tests__/system.test.ts`

**Interfaces:**
- Consumes: Tasks 2-3 resolver and gate.
- Produces: one structured path for installation checks, real task runs, environment status, connection status, Claude test, and diagnostics.

- [ ] **Step 1: Write failing adapter tests**

~~~ts
it('holds an ordinary lease through task child close', async () => {
  const test = adapterHarness();
  await test.adapter.runPrompt(runOptions());
  expect(test.gate.snapshot().ordinaryLeaseCount).toBe(1);
  expect(test.calls[0]).toMatchObject({
    command: 'node-test',
    args: ['C:\\claude\\cli.js', '-p', 'hello'],
  });

  test.child.emit('close', 0, null);
  expect(test.gate.snapshot().ordinaryLeaseCount).toBe(0);
});

it('does not resolve or spawn while update ownership is active', async () => {
  const test = adapterHarness();
  const update = test.gate.tryAcquireUpdate()!;
  await expect(test.adapter.checkInstallation()).resolves.toEqual({
    installed: false,
    path: null,
    version: null,
  });
  expect(test.resolve).not.toHaveBeenCalled();
  expect(test.calls).toEqual([]);
  update.release();
});
~~~

Also assert prefix ordering, resolver patch precedence, spawn/validation failure release, and fake selection never probes the real adapter.

- [ ] **Step 2: Run adapter tests and verify RED**

~~~powershell
node node_modules/vitest/vitest.mjs run --no-cache src/main/claude/__tests__/ClaudeCliAdapter.test.ts src/main/claude/__tests__/StartupClaudeAdapter.test.ts
~~~

Expected: FAIL because the adapter owns a bare executable and no gate.

- [ ] **Step 3: Implement structured adapter invocation**

~~~ts
export interface AdapterOptions {
  invocationResolver: ClaudeInvocationResolverPort;
  runtimeGate: ClaudeRuntimeMutationGate;
  permissionBroker?: PermissionBrokerPort;
  permissionMcpPath?: string;
  spawnProcess?: typeof spawn;
  processSupervisor?: ProcessSupervisor;
  terminationGraceMs?: number;
  terminationForceMs?: number;
  providerEnvironment?: ProviderEnvironmentPort;
}
~~~

Acquire ordinary ownership before resolution. Prepend `prefixArgs` and merge `environmentPatch` after provider/task environment. Store the lease on `ActiveRun` and release it in the child-close finalizer; release it in every pre-child failure path.

- [ ] **Step 4: Write failing system injection tests**

Pass mandatory dependencies:

~~~ts
claudeRuntime: {
  resolver: resolverDouble,
  gate: runtimeGate,
}
~~~

Assert all four Claude-probing handlers use this resolver and one ordinary lease for their full version/help sequence. With update ownership active, assert bounded unavailable results and zero resolver/locator/Claude calls.

- [ ] **Step 5: Run system tests and verify RED**

~~~powershell
node node_modules/vitest/vitest.mjs run --no-cache src/main/ipc/__tests__/system.test.ts
~~~

Expected: FAIL because `system.ts` still constructs its private resolver.

- [ ] **Step 6: Remove private resolver and wire dependencies**

~~~ts
export interface SystemIPCOptions {
  claudeRuntime: {
    resolver: ClaudeInvocationResolverPort;
    gate: ClaudeRuntimeMutationGate;
  };
  allowedPaths?: readonly string[] | (() => readonly string[]);
  environmentFacts?: () => SystemEnvironmentFacts | Promise<SystemEnvironmentFacts>;
}
~~~

Keep Node, Git, VS Code, shell, and path authorization unchanged. Each Claude handler acquires one ordinary lease before resolution and releases it in `finally` after its synchronous children complete.

- [ ] **Step 7: Run combined tests and verify GREEN**

~~~powershell
node node_modules/vitest/vitest.mjs run --no-cache src/main/claude/__tests__/ClaudeCliAdapter.test.ts src/main/claude/__tests__/StartupClaudeAdapter.test.ts src/main/ipc/__tests__/system.test.ts
~~~

- [ ] **Step 8: Commit**

~~~powershell
git add src/main/claude/ClaudeCliAdapter.ts src/main/claude/__tests__/ClaudeCliAdapter.test.ts src/main/claude/__tests__/StartupClaudeAdapter.test.ts src/main/ipc/system.ts src/main/ipc/__tests__/system.test.ts
git commit -m "refactor(claude): share resolved runtime invocation"
~~~

---

### Task 5: Implement the manual update manager and bounded runner

**Files:**
- Create: `src/main/claude/ClaudeCodeUpdateManager.ts`
- Create: `src/main/claude/__tests__/ClaudeCodeUpdateManager.test.ts`
- Modify: `src/shared/types/ipc.ts` (DTO types only)

**Interfaces:**
- Consumes: Tasks 1-3 process ownership, resolver identity, and update gate.
- Produces: `ClaudeCodeUpdateSnapshot`, `ClaudeUpdateCommandRunnerPort`, `SupervisedClaudeUpdateCommandRunner`, and `ClaudeCodeUpdateManager`.

- [ ] **Step 1: Write the failing manager and supervised-runner tests**

Write the manager tests below before adding the DTO or manager module. Also write the supervised-runner tests from former Step 5 before production code. The initial test command must fail because the imported manager/DTO and their behavior do not yet exist.

- [ ] **Step 2: Run and verify RED**

~~~powershell
node node_modules/vitest/vitest.mjs run --no-cache src/main/claude/__tests__/ClaudeCodeUpdateManager.test.ts
~~~

Expected: FAIL because manager, runner, and DTO do not exist.

- [ ] **Step 3: Add the exact shared DTO**

~~~ts
export type ClaudeCodeUpdateStatus =
  | 'idle' | 'blocked' | 'updating' | 'updated'
  | 'up_to_date' | 'unavailable' | 'error';

export type ClaudeCodeUpdateReason =
  | 'active_tasks' | 'runtime_busy' | 'not_installed'
  | 'unsupported_installation' | 'identity_changed' | 'invalid_version'
  | 'permission_denied' | 'timed_out' | 'cleanup_unconfirmed'
  | 'update_failed' | null;

export type ClaudeCodeUpdateSnapshot = Readonly<{
  status: ClaudeCodeUpdateStatus;
  reason: ClaudeCodeUpdateReason;
  beforeVersion: string | null;
  afterVersion: string | null;
}>;
~~~

Define the manager's fixed public-log vocabulary in the main-only module:

~~~ts
export type ClaudeUpdateLogStage =
  | 'blocked'
  | 'resolve'
  | 'pre_version'
  | 'update'
  | 'post_resolve'
  | 'post_version'
  | 'terminal';
~~~

The manager has no clock dependency because the public snapshot contains no time and the approved transaction is fully ordered by the fixed stage vocabulary.

The previously written tests include:

~~~ts
it('runs version, update, version and verifies one identity', async () => {
  const test = managerHarness({ versions: ['2.1.218', '2.1.219'] });
  await expect(test.manager.updateNow()).resolves.toEqual({
    status: 'updated',
    reason: null,
    beforeVersion: '2.1.218',
    afterVersion: '2.1.219',
  });
  expect(test.operations).toEqual([
    'resolve', 'version', 'update', 'resolve', 'version',
  ]);
});

it('returns one in-flight promise', () => {
  const test = managerHarness({ deferredUpdate: true });
  const first = test.manager.updateNow();
  const second = test.manager.updateNow();
  expect(second).toBe(first);
  expect(test.operations.filter((entry) => entry === 'update')).toHaveLength(1);
});
~~~

Cover construction/getSnapshot zero execution; fake runtime; active tasks; ordinary busy; unchanged/higher/lower/malformed versions; identity/environment drift; missing/unsupported installation; permission/nonzero/timeout/overflow; secret/path/output redaction; and disposal. For `cleanup_unconfirmed` assert the exclusive gate remains latched, retries perform zero operations, and only successful `dispose()` releases it.

- [ ] **Step 4: Implement capability-based manager interfaces**

~~~ts
export interface ClaudeUpdateCommandRunnerPort {
  probeVersion(invocation: ResolvedClaudeInvocation): Promise<string>;
  runUpdate(invocation: ResolvedClaudeInvocation): Promise<void>;
  dispose(): Promise<void>;
}

export interface ClaudeCodeUpdateManagerOptions {
  resolver: ClaudeInvocationResolverPort;
  runtimeGate: ClaudeRuntimeMutationGate;
  runner: ClaudeUpdateCommandRunnerPort;
  hasActiveTasks(): boolean;
  isFakeRuntime(): boolean;
  log?(stage: ClaudeUpdateLogStage, reason: ClaudeCodeUpdateReason): void | Promise<void>;
}

export class ClaudeCodeUpdateManager {
  getSnapshot(): ClaudeCodeUpdateSnapshot;
  updateNow(): Promise<ClaudeCodeUpdateSnapshot>;
  isUpdating(): boolean;
  dispose(): Promise<void>;
}
~~~

Do not declare `updateNow()` as `async`; synchronously reject fake/active/busy states, assign one promise, and return that exact promise. Accept bounded `major.minor.patch[-prerelease] (Claude Code)` output and reject a lower post-version.

- [ ] **Step 5: Implement the already-RED supervised runner contract**

The failing test written in Step 1 contains this exact request assertion:

~~~ts
expect(spawnRequest).toMatchObject({
  kind: 'claude',
  command: 'node-test',
  args: ['C:\\claude\\cli.js', 'update'],
  settlement: 'close-only',
  options: expect.objectContaining({
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
});
~~~

It also asserts the update environment removes case variants of `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, and all three `CLAUDE_WORKBENCH_PERMISSION_*` values before applying resolver patch; a 10-second probe timeout; a 5-minute update timeout; 256 KiB independent output caps; timeout/overflow termination; close-only settlement; timer/listener cleanup; and `cleanup_unconfirmed` when close cannot be confirmed. One cleanup-unconfirmed case uses the real typed supervisor error from Task 1, proves the runner retains its opaque capability, then proves `dispose()` retries that capability and releases the manager's latched exclusive gate only after retry success. A second case starts from a normally returned handle whose timeout/overflow termination cannot confirm close; it proves the runner retains that exact handle, `dispose()` retries `terminate()`, and the gate remains latched unless the retry confirms close.

- [ ] **Step 6: Implement `SupervisedClaudeUpdateCommandRunner` in the manager module**

Use `ProcessSupervisor.spawn()` with `settlement: 'close-only'`. Expose only `probeVersion()` and `runUpdate()`. When spawn rejects with `ManagedProcessCleanupUnconfirmedError`, retain its opaque cleanup capability; `dispose()` retries every retained capability and removes it only after confirmed cleanup. After spawn returns, retain each `ManagedProcessHandle` until close; if timeout, overflow, or shutdown termination cannot confirm close, keep that handle in the same pending-cleanup set and have `dispose()` retry its `terminate()` method. Map `EACCES`/`EPERM` to `permission_denied`, confirmed timeout to `timed_out`, unconfirmed close/tree termination to `cleanup_unconfirmed`, and other private failures to `update_failed`. Never parse stderr for trust decisions.

- [ ] **Step 7: Run the Step 3 command and verify GREEN**

Expected: all tests use fake processes, restore timers, emit no warning, and never invoke installed Claude Code.

- [ ] **Step 8: Commit**

~~~powershell
git add src/main/claude/ClaudeCodeUpdateManager.ts src/main/claude/__tests__/ClaudeCodeUpdateManager.test.ts src/shared/types/ipc.ts
git commit -m "feat(claude): manage explicit CLI updates"
~~~

---

### Task 6: Add trusted zero-argument update IPC

**Files:**
- Create: `src/main/ipc/claude-updates.ts`
- Create: `src/main/ipc/__tests__/claude-updates.test.ts`
- Modify: `src/shared/types/ipc.ts`
- Modify: `tests/typecheck/public-ipc-main.ts`

**Interfaces:**
- Consumes: Task 5 snapshot methods and trusted-frame/public registrar contracts.
- Produces: two exact channels and `registerClaudeUpdatesIPC()`.

- [ ] **Step 1: Write failing registrar tests**

~~~ts
it('authenticates before parsing or manager access', async () => {
  const test = ipcHarness({ trusted: false });
  await expect(test.invoke(
    IPC_CHANNELS.CLAUDE_CODE_UPDATE_NOW,
    { executable: 'evil', args: ['update'], env: { TOKEN: 'secret' } },
  )).rejects.toThrow('trusted main frame');
  expect(test.updates.updateNow).not.toHaveBeenCalled();
});

it('maps one zero-argument update request', async () => {
  const test = ipcHarness();
  await expect(test.invoke(IPC_CHANNELS.CLAUDE_CODE_UPDATE_NOW))
    .resolves.toEqual(UPDATED);
  expect(test.updates.updateNow).toHaveBeenCalledOnce();
});
~~~

Cover both handlers, every extra argument, subframe/foreign/destroyed sender, bounded snapshot projection, and disposer removal of exactly two handlers.

- [ ] **Step 2: Run and verify RED**

~~~powershell
node node_modules/vitest/vitest.mjs run --no-cache src/main/ipc/__tests__/claude-updates.test.ts
~~~

- [ ] **Step 3: Add channels and public methods**

~~~ts
CLAUDE_CODE_UPDATE_GET_STATE: 'claude-code-update:get-state',
CLAUDE_CODE_UPDATE_NOW: 'claude-code-update:update-now',

getClaudeCodeUpdateState(): Promise<ClaudeCodeUpdateSnapshot>;
updateClaudeCodeNow(): Promise<ClaudeCodeUpdateSnapshot>;
~~~

Add both as `'promise'` in `CLAUDE_WORKBENCH_API_METHOD_KINDS`.

- [ ] **Step 4: Implement trusted registrar**

~~~ts
export interface ClaudeUpdatesIPCDependencies
  extends TrustedRendererIPCDependencies {
  updates: Pick<ClaudeCodeUpdateManager, 'getSnapshot' | 'updateNow'>;
}

export function registerClaudeUpdatesIPC(
  ipcMain: PublicIpcRegistrar,
  dependencies: ClaudeUpdatesIPCDependencies,
): () => void;
~~~

Use one `z.tuple([])`. Authenticate trusted main frame before tuple parsing and manager access. Dispose exactly two channels.

- [ ] **Step 5: Add type-level gates**

Update `tests/typecheck/public-ipc-main.ts` to require exact trusted dependencies and exact `ClaudeCodeUpdateSnapshot` results.

- [ ] **Step 6: Run and verify GREEN**

~~~powershell
node node_modules/vitest/vitest.mjs run --no-cache src/main/ipc/__tests__/claude-updates.test.ts
npm run typecheck:ipc
~~~

- [ ] **Step 7: Commit**

~~~powershell
git add src/main/ipc/claude-updates.ts src/main/ipc/__tests__/claude-updates.test.ts src/shared/types/ipc.ts tests/typecheck/public-ipc-main.ts
git commit -m "feat(ipc): expose manual Claude update action"
~~~

---

### Task 7: Expose the exact preload transport

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/preload/__tests__/index.test.ts`
- Modify: `src/preload/__tests__/transport-surface.test.ts`
- Modify: `src/renderer/__tests__/public-api-facade.test.ts`

**Interfaces:**
- Consumes: Task 6 channels/API.
- Produces: two zero-argument preload methods; 136 Promise methods and 9 subscriptions.

- [ ] **Step 1: Write failing exact-call tests**

~~~ts
it('exposes only zero-argument Claude update calls', async () => {
  await windowApi.getClaudeCodeUpdateState();
  await windowApi.updateClaudeCodeNow();
  expect(invoke).toHaveBeenNthCalledWith(
    1, IPC_CHANNELS.CLAUDE_CODE_UPDATE_GET_STATE,
  );
  expect(invoke).toHaveBeenNthCalledWith(
    2, IPC_CHANNELS.CLAUDE_CODE_UPDATE_NOW,
  );
});
~~~

Cast `updateClaudeCodeNow` to accept an unknown forged object and prove preload ignores it and invokes only the channel. Assert no generic update method.

- [ ] **Step 2: Run and verify RED**

~~~powershell
node node_modules/vitest/vitest.mjs run --no-cache src/preload/__tests__/index.test.ts src/preload/__tests__/transport-surface.test.ts src/renderer/__tests__/public-api-facade.test.ts
~~~

Expected: methods absent and exhaustive counts remain 134 Promise / 143 total.

- [ ] **Step 3: Implement methods and counts**

~~~ts
getClaudeCodeUpdateState: (): Promise<ClaudeCodeUpdateSnapshot> =>
  ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_CODE_UPDATE_GET_STATE),
updateClaudeCodeNow: (): Promise<ClaudeCodeUpdateSnapshot> =>
  ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_CODE_UPDATE_NOW),
~~~

Update expectations to 136 Promise methods, 9 subscriptions, and 145 total public methods. Add no subscription or generic transport.

- [ ] **Step 4: Run Step 2 and verify GREEN**

- [ ] **Step 5: Commit**

~~~powershell
git add src/preload/index.ts src/preload/__tests__/index.test.ts src/preload/__tests__/transport-surface.test.ts src/renderer/__tests__/public-api-facade.test.ts
git commit -m "feat(preload): expose manual Claude update transport"
~~~

---

### Task 8: Compose one resolver, gate, manager, and shutdown path

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/tasks/__tests__/TaskManager.test.ts`
- Create: `src/main/claude/ClaudeRuntimeTaskGuard.ts`
- Create: `src/main/claude/__tests__/ClaudeRuntimeTaskGuard.test.ts`
- Create: `src/main/claude/__tests__/MainClaudeRuntimeComposition.test.ts`
- Modify: `src/main/lifecycle/__tests__/ShutdownCoordinator.test.ts` only when its existing harness needs an ordering assertion.

**Interfaces:**
- Consumes: Tasks 1-7.
- Produces: one production composition with stored update IPC and before-run disposers.

- [ ] **Step 1: Write a failing production guard-registrar test**

~~~ts
it('rejects before adapter execution while update is active', async () => {
  const gate = new ClaudeRuntimeMutationGate();
  const lease = gate.tryAcquireUpdate()!;
  const test = taskManagerHarness();
  const unsubscribe = registerClaudeRuntimeTaskGuard(test.tasks, gate);

  await expect(test.tasks.runPrompt(runOptions())).rejects.toMatchObject({
    code: 'CLAUDE_RUNTIME_BUSY',
  });
  expect(test.adapter.runPrompt).not.toHaveBeenCalled();
  unsubscribe();
  lease.release();
});
~~~

The test imports the real production registrar. It must be RED because `ClaudeRuntimeTaskGuard.ts` does not exist; it must not reimplement the guard callback in the test.

- [ ] **Step 2: Write failing composition source tests**

Read `src/main/index.ts` and assert exactly one resolver and gate; the same identifiers enter adapter/system/manager; update guard precedes checkpoint listener; fake mode reaches manager; trusted update IPC is registered; update IPC disposal precedes generic removal; manager disposal precedes guard unsubscribe; and legacy `EnvironmentChecker` is neither imported nor instantiated.

- [ ] **Step 3: Run and verify RED**

~~~powershell
node node_modules/vitest/vitest.mjs run --no-cache src/main/tasks/__tests__/TaskManager.test.ts src/main/claude/__tests__/ClaudeRuntimeTaskGuard.test.ts src/main/claude/__tests__/MainClaudeRuntimeComposition.test.ts src/main/lifecycle/__tests__/ShutdownCoordinator.test.ts
~~~

- [ ] **Step 4: Implement the registrar and wire production composition**

~~~ts
export function registerClaudeRuntimeTaskGuard(
  tasks: Pick<TaskManager, 'subscribeBeforeRuns'>,
  gate: ClaudeRuntimeMutationGate,
): () => void {
  return tasks.subscribeBeforeRuns(async () => {
    if (gate.isUpdateActive()) throw new ClaudeRuntimeBusyError();
  });
}
~~~

~~~ts
const forceFake = process.env.FORCE_FAKE === '1';
const claudeRuntimeGate = new ClaudeRuntimeMutationGate();
const claudeInvocationResolver = new ClaudeInvocationResolver({
  untrustedRoots: [app.getAppPath()],
});
~~~

Pass both to the real adapter and `registerSystemIPC`. After `TaskManager` construction, register its gate listener before the checkpoint listener, then construct `SupervisedClaudeUpdateCommandRunner` and `ClaudeCodeUpdateManager`. Register `registerClaudeUpdatesIPC` only after trusted renderer facts exist.

Shutdown order:

~~~text
stopAcceptingWork: remove Claude update IPC, then other IPC
stopTasks: stop tasks, await manager.dispose(), then unsubscribe update guard
stopProcesses: retain processSupervisor.terminateAll()
~~~

Do not call `updateNow()` from initialization or the existing app-update auto-check block.

- [ ] **Step 5: Run Step 3 and verify GREEN**

- [ ] **Step 6: Commit**

~~~powershell
git add src/main/index.ts src/main/tasks/__tests__/TaskManager.test.ts src/main/claude/ClaudeRuntimeTaskGuard.ts src/main/claude/__tests__/ClaudeRuntimeTaskGuard.test.ts src/main/claude/__tests__/MainClaudeRuntimeComposition.test.ts
git add -u -- src/main/lifecycle/__tests__/ShutdownCoordinator.test.ts
git commit -m "feat(main): compose manual Claude updates"
~~~

---

### Task 9: Add Settings action and localized bounded states

**Files:**
- Modify: `src/renderer/features/settings/SettingsDialog.tsx`
- Create: `src/renderer/features/settings/__tests__/SettingsClaudeUpdate.test.tsx`
- Modify: `src/renderer/features/settings/__tests__/SettingsNavigation.test.tsx`
- Modify when required by its harness: `src/renderer/features/settings/__tests__/SettingsRelease.test.ts`
- Modify when required by its harness: `src/renderer/features/settings/__tests__/SettingsDialogAgent.test.tsx`
- Modify: `src/renderer/i18n/zh-CN.ts`
- Modify: `src/renderer/i18n/en-US.ts`
- Modify: `src/renderer/i18n/__tests__/i18n.test.ts`

**Interfaces:**
- Consumes: Task 7 preload methods and snapshot.
- Produces: explicit **立即更新** button, busy/terminal rendering, one post-success environment refresh, exhaustive localized reason mapping.

- [ ] **Step 1: Write failing Settings tests**

~~~tsx
it('updates only after one explicit click', async () => {
  const deferred = createDeferred<ClaudeCodeUpdateSnapshot>();
  const api = installApi({
    updateClaudeCodeNow: vi.fn(() => deferred.promise),
  });
  render(<SettingsDialog initialCategory="models" onClose={vi.fn()} />);

  expect(api.updateClaudeCodeNow).not.toHaveBeenCalled();
  await user.click(screen.getByTestId('claude-code-update-now'));
  expect(api.updateClaudeCodeNow).toHaveBeenCalledOnce();
  expect(screen.getByTestId('claude-code-update-now')).toBeDisabled();
  expect(screen.getByText('正在更新…')).toBeInTheDocument();
});
~~~

Cover: opening/navigation/get-state never mutates; fake/unavailable disables despite a real host CLI; double click remains one call; updated/up-to-date refresh environment once; active/runtime-busy do not refresh; each reason renders fixed localized text; raw path/stderr/token sentinels never render; cleanup-unconfirmed remains disabled; unmount before settlement does not refresh or set state.

- [ ] **Step 2: Run and verify RED**

~~~powershell
node node_modules/vitest/vitest.mjs run --no-cache src/renderer/features/settings/__tests__/SettingsClaudeUpdate.test.tsx src/renderer/features/settings/__tests__/SettingsNavigation.test.tsx src/renderer/features/settings/__tests__/SettingsRelease.test.ts src/renderer/features/settings/__tests__/SettingsDialogAgent.test.tsx src/renderer/i18n/__tests__/i18n.test.ts
~~~

- [ ] **Step 3: Add exhaustive translations**

~~~ts
const CLAUDE_UPDATE_REASON_KEYS = {
  active_tasks: 'claudeUpdate.reason.activeTasks',
  runtime_busy: 'claudeUpdate.reason.runtimeBusy',
  not_installed: 'claudeUpdate.reason.notInstalled',
  unsupported_installation: 'claudeUpdate.reason.unsupportedInstallation',
  identity_changed: 'claudeUpdate.reason.identityChanged',
  invalid_version: 'claudeUpdate.reason.invalidVersion',
  permission_denied: 'claudeUpdate.reason.permissionDenied',
  timed_out: 'claudeUpdate.reason.timedOut',
  cleanup_unconfirmed: 'claudeUpdate.reason.cleanupUnconfirmed',
  update_failed: 'claudeUpdate.reason.updateFailed',
} satisfies Record<Exclude<ClaudeCodeUpdateReason, null>, LocaleKey>;
~~~

Add matching Chinese and English action, busy, manual-only, updated, up-to-date, load, generic, and reason keys.

- [ ] **Step 4: Implement the Settings-only handler**

~~~ts
const updateClaudeCodeNow = useCallback(async () => {
  if (claudeUpdateBusy) return;
  setClaudeUpdateBusy(true);
  try {
    const next = await window.api.updateClaudeCodeNow();
    if (!mountedRef.current) return;
    setClaudeUpdateState(next);
    if (next.status === 'updated' || next.status === 'up_to_date') {
      const refreshed = await window.api.checkEnvironment();
      if (mountedRef.current) setEnvCheck(refreshed);
    }
  } finally {
    if (mountedRef.current) setClaudeUpdateBusy(false);
  }
}, [claudeUpdateBusy]);
~~~

Load state only while Models is active. Render `data-testid="claude-code-update-now"` inside `ClaudeCodeSection`. Disable during load, missing CLI, busy/updating/unavailable, or cleanup-unconfirmed. Do not add a setting or startup mutation effect.

- [ ] **Step 5: Run Step 2 and verify GREEN**

- [ ] **Step 6: Commit**

~~~powershell
git add src/renderer/features/settings/SettingsDialog.tsx src/renderer/features/settings/__tests__/SettingsClaudeUpdate.test.tsx src/renderer/features/settings/__tests__/SettingsNavigation.test.tsx src/renderer/i18n/zh-CN.ts src/renderer/i18n/en-US.ts src/renderer/i18n/__tests__/i18n.test.ts
git add -u -- src/renderer/features/settings/__tests__/SettingsRelease.test.ts src/renderer/features/settings/__tests__/SettingsDialogAgent.test.tsx
git commit -m "feat(settings): add manual Claude Code update"
~~~

---

### Task 10: Verify the whole feature and forbidden boundaries

**Files:**
- Verify only. A discovered defect starts a fresh RED→GREEN fix before any production edit.

**Interfaces:**
- Consumes: Tasks 1-9.
- Produces: fresh local completion evidence without a real update.

- [ ] **Step 1: Run all affected tests with warning tracing**

~~~powershell
node --trace-warnings node_modules/vitest/vitest.mjs run --no-cache src/main/processes/__tests__/ProcessSupervisor.test.ts src/main/processes/__tests__/ProcessSupervisor.release.test.ts src/main/claude/__tests__/ClaudeRuntimeMutationGate.test.ts src/main/claude/__tests__/ClaudeRuntimeTaskGuard.test.ts src/main/claude/__tests__/ClaudeInvocationResolver.test.ts src/main/claude/__tests__/ClaudeCliAdapter.test.ts src/main/claude/__tests__/StartupClaudeAdapter.test.ts src/main/claude/__tests__/ClaudeCodeUpdateManager.test.ts src/main/claude/__tests__/MainClaudeRuntimeComposition.test.ts src/main/ipc/__tests__/system.test.ts src/main/ipc/__tests__/claude-updates.test.ts src/main/tasks/__tests__/TaskManager.test.ts src/main/lifecycle/__tests__/ShutdownCoordinator.test.ts src/preload/__tests__/index.test.ts src/preload/__tests__/transport-surface.test.ts src/renderer/__tests__/public-api-facade.test.ts src/renderer/features/settings/__tests__/SettingsClaudeUpdate.test.tsx src/renderer/features/settings/__tests__/SettingsNavigation.test.tsx src/renderer/features/settings/__tests__/SettingsRelease.test.ts src/renderer/features/settings/__tests__/SettingsDialogAgent.test.tsx src/renderer/i18n/__tests__/i18n.test.ts
~~~

Record passed/failed/skipped counts and confirm no DEP0137, FileHandle, stream, worker, timer, child-process, or unhandled-rejection warning.

- [ ] **Step 2: Run repository gates**

~~~powershell
npm run lint
npm run typecheck
npm run build
npm test
git diff --check
~~~

Record every exit code and test count. Do not use retries, filters, timeout increases, skips, or global serialization to hide a failure.

- [ ] **Step 3: Audit the branch**

~~~powershell
git diff --name-status 616eaa872a4ab251b727557ea21337e080fc7844...HEAD
git diff --check 616eaa872a4ab251b727557ea21337e080fc7844...HEAD
rg -n "updateClaudeCodeNow|claude update|auto.*Claude|setInterval|\\.only|\\.skip|\\.todo|npm install|npm update|winget" src tests/typecheck docs/superpowers
git status --short
~~~

Confirm no forbidden release/package/config file, automatic trigger, package-manager fallback, generic IPC, real updater fixture, skipped test, or uncommitted change exists. Confirm no test can execute installed `claude update`.

- [ ] **Step 4: Run final whole-branch review**

Generate a review package for base `616eaa872a4ab251b727557ea21337e080fc7844` through HEAD. Request broad code review against the spec and this plan. Every Critical/Important finding requires a fresh RED→GREEN fix and one scoped re-review.

- [ ] **Step 5: Present without merge or publication**

Use `superpowers:finishing-a-development-branch` to report the verified branch and local commit series. Do not push, merge, publish, or invoke a real Claude update.
