import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { ClaudeCodeUpdateSnapshot } from "../../../shared/types/ipc";
import {
  ManagedProcessCleanupUnconfirmedError,
  type ManagedProcessHandle,
  type ManagedProcessRequest,
  type ProcessExitRecord,
  type ProcessStartRecord,
  type ProcessSupervisor,
} from "../../processes/ProcessSupervisor";
import {
  ClaudeCodeUpdateManager,
  SupervisedClaudeUpdateCommandRunner,
  type ClaudeCodeUpdateManagerOptions,
  type ClaudeUpdateCommandRunnerPort,
} from "../ClaudeCodeUpdateManager";
import type {
  ClaudeInvocationResolution,
  ResolvedClaudeInvocation,
} from "../ClaudeInvocationResolver";
import { ClaudeRuntimeMutationGate } from "../ClaudeRuntimeMutationGate";

const BASE_INVOCATION: ResolvedClaudeInvocation = Object.freeze({
  executable: "node-test",
  prefixArgs: Object.freeze(["C:\\claude\\cli.js"]),
  environmentPatch: Object.freeze({ ELECTRON_RUN_AS_NODE: "1" }),
  displayPath: "C:\\npm\\claude.cmd",
  canonicalTargetPath: "C:\\claude\\cli.js",
  provenance: "npm",
});

const IDLE: ClaudeCodeUpdateSnapshot = Object.freeze({
  status: "idle",
  reason: null,
  beforeVersion: null,
  afterVersion: null,
});

function invocation(
  patch: Partial<ResolvedClaudeInvocation> = {},
): ResolvedClaudeInvocation {
  return Object.freeze({
    ...BASE_INVOCATION,
    ...patch,
    prefixArgs: Object.freeze([
      ...(patch.prefixArgs ?? BASE_INVOCATION.prefixArgs),
    ]),
    environmentPatch: Object.freeze({
      ...(patch.environmentPatch ?? BASE_INVOCATION.environmentPatch),
    }),
  });
}

function resolved(
  value: ResolvedClaudeInvocation = BASE_INVOCATION,
): ClaudeInvocationResolution {
  return Object.freeze({ ok: true, invocation: value });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixedRunnerFailure(
  reason:
    "permission_denied" | "timed_out" | "cleanup_unconfirmed" | "update_failed",
  raw = "private-error-sentinel",
): Error {
  return Object.assign(new Error(raw), { reason });
}

interface ManagerHarnessOptions {
  fakeRuntime?: boolean;
  activeTasks?: boolean;
  resolutions?: readonly ClaudeInvocationResolution[];
  versions?: readonly string[];
  versionFailure?: unknown;
  updateFailure?: unknown;
  deferredUpdate?: boolean;
  disposeFailure?: unknown;
  log?: ClaudeCodeUpdateManagerOptions["log"];
  onResolve?(): void;
  onProbeVersion?(): void;
}

function managerHarness(options: ManagerHarnessOptions = {}) {
  const operations: string[] = [];
  const runtimeGate = new ClaudeRuntimeMutationGate();
  const resolutions = [...(options.resolutions ?? [resolved(), resolved()])];
  const versions = [...(options.versions ?? ["2.1.218", "2.1.219"])];
  const updateDeferred = deferred<void>();
  let resolutionIndex = 0;
  let versionIndex = 0;
  let activeTasks = options.activeTasks ?? false;
  let disposeFailure = options.disposeFailure;
  const isFakeRuntime = vi.fn(() => options.fakeRuntime ?? false);

  const resolver = {
    resolve: vi.fn(() => {
      operations.push("resolve");
      options.onResolve?.();
      const result =
        resolutions[Math.min(resolutionIndex, resolutions.length - 1)];
      resolutionIndex += 1;
      return result;
    }),
  };
  const runner: ClaudeUpdateCommandRunnerPort = {
    probeVersion: vi.fn(async () => {
      operations.push("version");
      options.onProbeVersion?.();
      if (options.versionFailure !== undefined) throw options.versionFailure;
      const value = versions[Math.min(versionIndex, versions.length - 1)];
      versionIndex += 1;
      return value;
    }),
    runUpdate: vi.fn(async () => {
      operations.push("update");
      if (options.deferredUpdate) await updateDeferred.promise;
      if (options.updateFailure !== undefined) throw options.updateFailure;
    }),
    dispose: vi.fn(async () => {
      operations.push("dispose");
      if (disposeFailure !== undefined) throw disposeFailure;
    }),
  };
  const manager = new ClaudeCodeUpdateManager({
    resolver,
    runtimeGate,
    runner,
    hasActiveTasks: () => activeTasks,
    isFakeRuntime,
    log: options.log,
  });

  return {
    manager,
    operations,
    resolver,
    runner,
    isFakeRuntime,
    runtimeGate,
    releaseUpdate: () => updateDeferred.resolve(),
    setActiveTasks: (value: boolean) => {
      activeTasks = value;
    },
    setDisposeFailure: (value: unknown) => {
      disposeFailure = value;
    },
  };
}

async function waitForOperation(
  operations: readonly string[],
  expected: string,
): Promise<void> {
  await vi.waitFor(() => {
    expect(operations).toContain(expected);
  });
}

describe("ClaudeCodeUpdateManager", () => {
  it("constructs and reads one frozen idle snapshot without resolving or running commands", () => {
    const test = managerHarness();

    expect(test.manager.getSnapshot()).toEqual(IDLE);
    expect(test.manager.getSnapshot()).toBe(test.manager.getSnapshot());
    expect(Object.isFrozen(test.manager.getSnapshot())).toBe(true);
    expect(test.manager.isUpdating()).toBe(false);
    expect(test.operations).toEqual([]);
    expect(test.isFakeRuntime).not.toHaveBeenCalled();
  });

  it("returns unavailable for a fake runtime before touching the gate or resolver", async () => {
    const test = managerHarness({ fakeRuntime: true });
    const ordinary = test.runtimeGate.tryAcquireOrdinary();

    expect(test.manager.getSnapshot()).toEqual(IDLE);
    expect(test.isFakeRuntime).not.toHaveBeenCalled();
    await expect(test.manager.updateNow()).resolves.toEqual(
      Object.freeze({
        status: "unavailable",
        reason: "unsupported_installation",
        beforeVersion: null,
        afterVersion: null,
      }),
    );
    expect(test.isFakeRuntime).toHaveBeenCalledOnce();
    expect(test.operations).toEqual([]);
    expect(test.runtimeGate.snapshot()).toEqual({
      ordinaryLeaseCount: 1,
      updateActive: false,
    });
    ordinary?.release();
  });

  it("blocks active tasks synchronously without acquiring, resolving, or queueing", async () => {
    const test = managerHarness({ activeTasks: true });
    const result = test.manager.updateNow();
    const ordinary = test.runtimeGate.tryAcquireOrdinary();

    expect(test.operations).toEqual([]);
    expect(test.runtimeGate.snapshot()).toEqual({
      ordinaryLeaseCount: 1,
      updateActive: false,
    });
    await expect(result).resolves.toEqual({
      status: "blocked",
      reason: "active_tasks",
      beforeVersion: null,
      afterVersion: null,
    });
    ordinary?.release();
  });

  it("blocks an ordinary-busy runtime synchronously without resolving or queueing", async () => {
    const test = managerHarness();
    const ordinary = test.runtimeGate.tryAcquireOrdinary();
    const result = test.manager.updateNow();

    expect(test.operations).toEqual([]);
    expect(test.runtimeGate.snapshot()).toEqual({
      ordinaryLeaseCount: 1,
      updateActive: false,
    });
    await expect(result).resolves.toEqual({
      status: "blocked",
      reason: "runtime_busy",
      beforeVersion: null,
      afterVersion: null,
    });
    ordinary?.release();
  });

  it("acquires the exclusive gate before its first asynchronous boundary", async () => {
    const test = managerHarness({ deferredUpdate: true });
    const updating = test.manager.updateNow();

    expect(test.runtimeGate.tryAcquireOrdinary()).toBeNull();
    expect(test.runtimeGate.snapshot().updateActive).toBe(true);
    expect(test.manager.isUpdating()).toBe(true);

    test.releaseUpdate();
    await updating;
    expect(test.runtimeGate.snapshot().updateActive).toBe(false);
  });

  it("runs version, update, version and verifies one identity", async () => {
    const test = managerHarness({ versions: ["2.1.218", "2.1.219"] });
    await expect(test.manager.updateNow()).resolves.toEqual({
      status: "updated",
      reason: null,
      beforeVersion: "2.1.218",
      afterVersion: "2.1.219",
    });
    expect(test.operations).toEqual([
      "resolve",
      "version",
      "update",
      "resolve",
      "version",
    ]);
  });

  it("returns one in-flight promise", async () => {
    const test = managerHarness({ deferredUpdate: true });
    const first = test.manager.updateNow();
    const second = test.manager.updateNow();
    expect(second).toBe(first);
    await waitForOperation(test.operations, "update");
    expect(test.operations.filter((entry) => entry === "update")).toHaveLength(
      1,
    );

    test.releaseUpdate();
    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        status: "updated",
        reason: null,
        beforeVersion: "2.1.218",
        afterVersion: "2.1.219",
      },
      {
        status: "updated",
        reason: null,
        beforeVersion: "2.1.218",
        afterVersion: "2.1.219",
      },
    ]);
  });

  it.each(["log", "resolver", "probe"] as const)(
    "publishes the exact in-flight promise before synchronous %s re-entry",
    async (source) => {
      let test!: ReturnType<typeof managerHarness>;
      let reentered: Promise<ClaudeCodeUpdateSnapshot> | null = null;
      let didReenter = false;
      const reenter = (): void => {
        if (didReenter) return;
        didReenter = true;
        reentered = test.manager.updateNow();
      };
      test = managerHarness({
        deferredUpdate: true,
        ...(source === "log"
          ? {
              log: (stage: string) => {
                if (stage === "resolve") reenter();
              },
            }
          : {}),
        ...(source === "resolver" ? { onResolve: reenter } : {}),
        ...(source === "probe" ? { onProbeVersion: reenter } : {}),
      });

      const first = test.manager.updateNow();
      const snapshotDuringReentry = test.manager.getSnapshot();
      await waitForOperation(test.operations, "update");
      test.releaseUpdate();
      const [firstResult, reenteredResult] = await Promise.all([
        first,
        reentered,
      ]);

      expect(reentered).toBe(first);
      expect(snapshotDuringReentry).toMatchObject({
        status: "updating",
        reason: null,
      });
      expect(reenteredResult).toEqual(firstResult);
      expect(test.operations.filter((entry) => entry === "update")).toHaveLength(
        1,
      );
    },
  );

  it("returns up_to_date for one unchanged bounded Claude Code version", async () => {
    const test = managerHarness({
      versions: ["2.1.218 (Claude Code)", "2.1.218 (Claude Code)"],
    });

    await expect(test.manager.updateNow()).resolves.toEqual({
      status: "up_to_date",
      reason: null,
      beforeVersion: "2.1.218",
      afterVersion: "2.1.218",
    });
  });

  it("accepts an increasing semantic prerelease", async () => {
    const test = managerHarness({
      versions: ["2.1.219-beta.1", "2.1.219-beta.2 (Claude Code)"],
    });

    await expect(test.manager.updateNow()).resolves.toMatchObject({
      status: "updated",
      beforeVersion: "2.1.219-beta.1",
      afterVersion: "2.1.219-beta.2",
    });
  });

  it("accepts an alphanumeric prerelease identifier beginning with a digit", async () => {
    const test = managerHarness({
      versions: ["2.1.219-1alpha", "2.1.219-1alpha (Claude Code)"],
    });

    await expect(test.manager.updateNow()).resolves.toEqual({
      status: "up_to_date",
      reason: null,
      beforeVersion: "2.1.219-1alpha",
      afterVersion: "2.1.219-1alpha",
    });
  });

  it.each([
    ["lower stable version", ["2.1.219", "2.1.218"]],
    ["lower prerelease version", ["2.1.219-beta.2", "2.1.219-beta.1"]],
    ["prerelease replacing stable", ["2.1.219", "2.1.219-beta.9"]],
  ] as const)("rejects a %s", async (_label, versions) => {
    const test = managerHarness({ versions });

    await expect(test.manager.updateNow()).resolves.toEqual({
      status: "error",
      reason: "invalid_version",
      beforeVersion: versions[0],
      afterVersion: null,
    });
    expect(test.runtimeGate.snapshot().updateActive).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["leading prose", "Claude Code 2.1.218"],
    ["missing patch", "2.1"],
    ["metadata", "2.1.218+private"],
    ["raw multiline", "2.1.218\nprivate-output-sentinel"],
    ["numeric prerelease with a leading zero", "2.1.218-01"],
    ["oversized", `2.1.218${"x".repeat(262_145)}`],
  ])(
    "rejects %s pre-version output before mutation",
    async (_label, output) => {
      const test = managerHarness({ versions: [output, "2.1.219"] });

      await expect(test.manager.updateNow()).resolves.toEqual({
        status: "error",
        reason: "invalid_version",
        beforeVersion: null,
        afterVersion: null,
      });
      expect(test.operations).toEqual(["resolve", "version"]);
    },
  );

  it("rejects malformed post-version output after the fixed transaction", async () => {
    const test = managerHarness({ versions: ["2.1.218", "not-a-version"] });

    await expect(test.manager.updateNow()).resolves.toEqual({
      status: "error",
      reason: "invalid_version",
      beforeVersion: "2.1.218",
      afterVersion: null,
    });
    expect(test.operations).toEqual([
      "resolve",
      "version",
      "update",
      "resolve",
      "version",
    ]);
  });

  it.each([
    [
      "canonical target",
      invocation({ canonicalTargetPath: "C:\\other\\cli.js" }),
    ],
    ["provenance", invocation({ provenance: "native" })],
    ["executable route", invocation({ executable: "other-node" })],
    [
      "prefix arguments",
      invocation({ prefixArgs: ["C:\\claude\\other-cli.js"] }),
    ],
    [
      "environment patch value",
      invocation({ environmentPatch: { ELECTRON_RUN_AS_NODE: "0" } }),
    ],
    [
      "environment patch key",
      invocation({
        environmentPatch: {
          ELECTRON_RUN_AS_NODE: "1",
          EXTRA_INVOCATION_MODE: "1",
        },
      }),
    ],
  ] as const)(
    "rejects %s identity drift before post-version",
    async (_label, post) => {
      const test = managerHarness({
        resolutions: [resolved(), resolved(post)],
      });

      await expect(test.manager.updateNow()).resolves.toEqual({
        status: "error",
        reason: "identity_changed",
        beforeVersion: "2.1.218",
        afterVersion: null,
      });
      expect(test.operations).toEqual([
        "resolve",
        "version",
        "update",
        "resolve",
      ]);
    },
  );

  it.each(["not_installed", "unsupported_installation"] as const)(
    "returns unavailable/%s before spawning for a failed initial resolution",
    async (reason) => {
      const test = managerHarness({
        resolutions: [Object.freeze({ ok: false, reason })],
      });

      await expect(test.manager.updateNow()).resolves.toEqual({
        status: "unavailable",
        reason,
        beforeVersion: null,
        afterVersion: null,
      });
      expect(test.operations).toEqual(["resolve"]);
      expect(test.runtimeGate.snapshot().updateActive).toBe(false);
    },
  );

  it("fails closed as identity_changed when post-update resolution disappears", async () => {
    const test = managerHarness({
      resolutions: [
        resolved(),
        Object.freeze({ ok: false, reason: "not_installed" }),
      ],
    });

    await expect(test.manager.updateNow()).resolves.toEqual({
      status: "error",
      reason: "identity_changed",
      beforeVersion: "2.1.218",
      afterVersion: null,
    });
  });

  it.each([
    ["permission failure", "permission_denied"],
    ["nonzero failure", "update_failed"],
    ["timeout", "timed_out"],
    ["output overflow", "update_failed"],
  ] as const)("maps a bounded %s reason", async (_label, reason) => {
    const test = managerHarness({ updateFailure: fixedRunnerFailure(reason) });

    await expect(test.manager.updateNow()).resolves.toEqual({
      status: "error",
      reason,
      beforeVersion: "2.1.218",
      afterVersion: null,
    });
    expect(test.runtimeGate.snapshot().updateActive).toBe(false);
  });

  it("maps an unknown private failure without exposing its error text", async () => {
    const test = managerHarness({
      updateFailure: new Error("raw-error-secret-path-output-sentinel"),
    });

    const result = await test.manager.updateNow();

    expect(result).toEqual({
      status: "error",
      reason: "update_failed",
      beforeVersion: "2.1.218",
      afterVersion: null,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /raw-error|secret|path|output-sentinel/iu,
    );
  });

  it("emits only fixed stage/reason pairs without raw resolver, output, or error data", async () => {
    const logs: unknown[][] = [];
    const test = managerHarness({
      updateFailure: new Error(
        "C:\\raw-path anthropic-secret stdout-sentinel stderr-sentinel",
      ),
      log: (...entry) => {
        logs.push(entry);
      },
    });

    const result = await test.manager.updateNow();
    await Promise.resolve();
    const serialized = JSON.stringify({ logs, result });

    expect(logs).toEqual([
      ["resolve", null],
      ["pre_version", null],
      ["update", null],
      ["terminal", "update_failed"],
    ]);
    expect(serialized).not.toMatch(
      /raw-path|anthropic-secret|stdout-sentinel|stderr-sentinel|cli\.js/iu,
    );
  });

  it("keeps cleanup_unconfirmed latched across retries and releases only after successful disposal", async () => {
    const test = managerHarness({
      updateFailure: fixedRunnerFailure("cleanup_unconfirmed"),
      disposeFailure: fixedRunnerFailure("cleanup_unconfirmed"),
    });

    await expect(test.manager.updateNow()).resolves.toEqual({
      status: "error",
      reason: "cleanup_unconfirmed",
      beforeVersion: "2.1.218",
      afterVersion: null,
    });
    expect(test.runtimeGate.snapshot().updateActive).toBe(true);
    const operationCount = test.operations.length;

    await expect(test.manager.updateNow()).resolves.toEqual(
      test.manager.getSnapshot(),
    );
    expect(test.operations).toHaveLength(operationCount);

    await expect(test.manager.dispose()).rejects.toMatchObject({
      reason: "cleanup_unconfirmed",
    });
    expect(test.runtimeGate.snapshot().updateActive).toBe(true);

    test.setDisposeFailure(undefined);
    await expect(test.manager.dispose()).resolves.toBeUndefined();
    expect(test.runtimeGate.snapshot().updateActive).toBe(false);
    expect(test.operations.filter((entry) => entry === "dispose")).toHaveLength(
      2,
    );
  });
});

class SyntheticChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly pid: number;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }
}

interface SyntheticHandleControl {
  readonly handle: ManagedProcessHandle;
  readonly child: SyntheticChild;
  readonly terminate: ReturnType<typeof vi.fn>;
  close(exitCode?: number | null, error?: string): void;
  rejectWait(error: unknown, closeConfirmed: boolean): void;
  isClosed(): boolean;
}

function processExit(
  id: string,
  pid: number,
  exitCode: number | null,
  signal: string | null,
  error?: string,
): ProcessExitRecord {
  return {
    id,
    pid,
    kind: "claude",
    startedAt: "2026-08-21T00:00:00.000Z",
    endedAt: "2026-08-21T00:00:01.000Z",
    exitCode,
    signal,
    durationMs: 1_000,
    ...(error === undefined ? {} : { error }),
  };
}

function syntheticHandle(
  options: {
    id?: string;
    pid?: number;
    terminationFailures?: readonly unknown[];
  } = {},
): SyntheticHandleControl {
  const id = options.id ?? "synthetic-update";
  const pid = options.pid ?? 4242;
  const child = new SyntheticChild(pid);
  const exited = deferred<ProcessExitRecord>();
  let closed = false;
  let terminationIndex = 0;

  const close = (exitCode: number | null = 0, error?: string): void => {
    if (closed) return;
    closed = true;
    const result = processExit(id, pid, exitCode, null, error);
    child.emit("close", exitCode, null);
    exited.resolve(result);
  };
  const rejectWait = (error: unknown, closeConfirmed: boolean): void => {
    if (closed) return;
    if (closeConfirmed) {
      closed = true;
      child.emit("close", null, null);
    }
    exited.reject(error);
  };
  const terminate = vi.fn(async () => {
    const failure = options.terminationFailures?.[terminationIndex];
    terminationIndex += 1;
    if (failure !== undefined) throw failure;
    close(null);
    return exited.promise;
  });
  const handle: ManagedProcessHandle = Object.freeze({
    id,
    pid,
    child: child as unknown as ChildProcess,
    startedAt: "2026-08-21T00:00:00.000Z",
    waitForExit: () => exited.promise,
    terminate,
  });
  return {
    handle,
    child,
    terminate,
    close,
    rejectWait,
    isClosed: () => closed,
  };
}

function runnerHarness(
  options: {
    environment?: Readonly<NodeJS.ProcessEnv>;
    spawn?: (
      request: ManagedProcessRequest,
    ) => ManagedProcessHandle | Promise<ManagedProcessHandle>;
    activeProcesses?: () => readonly ProcessStartRecord[];
  } = {},
) {
  const requests: ManagedProcessRequest[] = [];
  const controls: SyntheticHandleControl[] = [];
  const supervisor = {
    spawn: vi.fn(async (request: ManagedProcessRequest) => {
      requests.push(request);
      if (options.spawn) return options.spawn(request);
      const control = syntheticHandle({
        id: `synthetic-${controls.length + 1}`,
        pid: 4242 + controls.length,
      });
      controls.push(control);
      return control.handle;
    }),
    getActiveProcesses: vi.fn(() =>
      options.activeProcesses
        ? [...options.activeProcesses()]
        : controls
            .filter((control) => !control.isClosed())
            .map((control) => ({
              id: control.handle.id,
              pid: control.handle.pid,
              kind: "claude" as const,
              startedAt: control.handle.startedAt,
            })),
    ),
  } as unknown as Pick<ProcessSupervisor, "spawn" | "getActiveProcesses">;
  const runner = new SupervisedClaudeUpdateCommandRunner(
    supervisor,
    options.environment ?? {},
  );
  return { runner, supervisor, requests, controls };
}

async function waitForRequest(
  requests: readonly ManagedProcessRequest[],
  count = 1,
): Promise<void> {
  await vi.waitFor(() => {
    expect(requests).toHaveLength(count);
  });
}

function failureReason(error: unknown): unknown {
  return (error as { reason?: unknown } | null)?.reason;
}

describe("SupervisedClaudeUpdateCommandRunner", () => {
  it("spawns only the exact resolver-owned update request with close-only ownership", async () => {
    const test = runnerHarness();
    const running = test.runner.runUpdate(BASE_INVOCATION);
    await waitForRequest(test.requests);
    const spawnRequest = test.requests[0];

    expect(spawnRequest).toMatchObject({
      kind: "claude",
      command: "node-test",
      args: ["C:\\claude\\cli.js", "update"],
      settlement: "close-only",
      options: expect.objectContaining({
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    });
    test.controls[0].close(0);
    await expect(running).resolves.toBeUndefined();
  });

  it("uses only --version and returns captured stdout for a probe", async () => {
    const test = runnerHarness();
    const probing = test.runner.probeVersion(BASE_INVOCATION);
    await waitForRequest(test.requests);

    expect(test.requests[0]).toMatchObject({
      command: "node-test",
      args: ["C:\\claude\\cli.js", "--version"],
      settlement: "close-only",
    });
    test.controls[0].child.stdout.emit(
      "data",
      Buffer.from("2.1.219 (Claude Code)"),
    );
    test.controls[0].close(0);
    await expect(probing).resolves.toBe("2.1.219 (Claude Code)");
  });

  it("sanitizes inherited credentials case-insensitively before applying the resolver patch", async () => {
    const environment = {
      PATH: "safe-path",
      ANTHROPIC_API_KEY: "api-secret",
      anthropic_auth_token: "auth-secret",
      Anthropic_Base_Url: "base-secret",
      CLAUDE_WORKBENCH_PERMISSION_ENDPOINT: "endpoint-secret",
      claude_workbench_permission_token: "permission-secret",
      Claude_Workbench_Permission_Run_Id: "run-secret",
    };
    const patchedInvocation = invocation({
      environmentPatch: {
        ELECTRON_RUN_AS_NODE: "1",
        anthropic_api_key: "resolver-owned-value",
      },
    });
    const test = runnerHarness({ environment });
    const running = test.runner.runUpdate(patchedInvocation);
    await waitForRequest(test.requests);
    const spawnedEnvironment = test.requests[0].options?.env ?? {};

    expect(spawnedEnvironment).toMatchObject({
      PATH: "safe-path",
      ELECTRON_RUN_AS_NODE: "1",
      anthropic_api_key: "resolver-owned-value",
    });
    const inheritedForbidden = Object.entries(spawnedEnvironment).filter(
      ([key, value]) =>
        value !== "resolver-owned-value" &&
        [
          "anthropic_api_key",
          "anthropic_auth_token",
          "anthropic_base_url",
          "claude_workbench_permission_endpoint",
          "claude_workbench_permission_token",
          "claude_workbench_permission_run_id",
        ].includes(key.toLocaleLowerCase("en-US")),
    );
    expect(inheritedForbidden).toEqual([]);

    test.controls[0].close(0);
    await running;
  });

  it.each([
    ["probe", "probeVersion", 10_000],
    ["update", "runUpdate", 300_000],
  ] as const)(
    "enforces the fixed %s deadline and terminates the owned handle",
    async (_label, method, deadline) => {
      vi.useFakeTimers();
      try {
        const test = runnerHarness();
        const operation = test.runner[method](BASE_INVOCATION).catch(
          (error: unknown) => error,
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(test.requests).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(deadline - 1);
        expect(test.controls[0].terminate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        const error = await operation;
        expect(failureReason(error)).toBe("timed_out");
        expect(test.controls[0].terminate).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["stdout", "stderr"] as const)(
    "enforces an independent 256 KiB %s cap and terminates the owned handle",
    async (stream) => {
      vi.useFakeTimers();
      try {
        const test = runnerHarness();
        const running = test.runner
          .runUpdate(BASE_INVOCATION)
          .catch((error: unknown) => error);
        await Promise.resolve();
        await Promise.resolve();
        const otherStream = stream === "stdout" ? "stderr" : "stdout";
        test.controls[0].child[otherStream].emit(
          "data",
          Buffer.alloc(256 * 1024),
        );
        test.controls[0].child[stream].emit("data", Buffer.alloc(256 * 1024));
        expect(test.controls[0].terminate).not.toHaveBeenCalled();

        test.controls[0].child[stream].emit("data", Buffer.from("x"));
        const error = await running;

        expect(failureReason(error)).toBe("update_failed");
        expect(test.controls[0].terminate).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("maps EACCES and EPERM child errors to permission_denied after close", async () => {
    for (const code of ["EACCES", "EPERM"]) {
      const test = runnerHarness();
      const running = test.runner
        .runUpdate(BASE_INVOCATION)
        .catch((error: unknown) => error);
      await waitForRequest(test.requests);
      test.controls[0].child.emit(
        "error",
        Object.assign(new Error("private-permission-sentinel"), { code }),
      );
      test.controls[0].close(null, "private-permission-sentinel");

      const error = await running;
      expect(failureReason(error)).toBe("permission_denied");
      expect(String(error)).not.toContain("private-permission-sentinel");
    }
  });

  it("maps nonzero close and private launch failures to update_failed", async () => {
    const nonzero = runnerHarness();
    const running = nonzero.runner
      .runUpdate(BASE_INVOCATION)
      .catch((error: unknown) => error);
    await waitForRequest(nonzero.requests);
    nonzero.controls[0].close(7);
    expect(failureReason(await running)).toBe("update_failed");

    const launch = runnerHarness({
      spawn: async () => {
        throw new Error("private-launch-path-secret");
      },
    });
    const launchError = await launch.runner
      .runUpdate(BASE_INVOCATION)
      .catch((error: unknown) => error);
    expect(failureReason(launchError)).toBe("update_failed");
    expect(String(launchError)).not.toContain("private-launch-path-secret");
  });

  it("clears timers and only its stream/error listeners after confirmed close", async () => {
    vi.useFakeTimers();
    try {
      const test = runnerHarness();
      const probing = test.runner.probeVersion(BASE_INVOCATION);
      await Promise.resolve();
      await Promise.resolve();
      const control = test.controls[0];

      expect(control.child.stdout.listenerCount("data")).toBe(1);
      expect(control.child.stderr.listenerCount("data")).toBe(1);
      expect(control.child.listenerCount("error")).toBe(1);
      control.child.stdout.emit("data", Buffer.from("2.1.219"));
      control.close(0);

      await expect(probing).resolves.toBe("2.1.219");
      expect(control.child.stdout.listenerCount("data")).toBe(0);
      expect(control.child.stderr.listenerCount("data")).toBe(0);
      expect(control.child.listenerCount("error")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("performs a final cleanup sweep for a normal handle returned after the first disposal sweep", async () => {
    const spawnAttempt = deferred<ManagedProcessHandle>();
    const unconfirmed = fixedRunnerFailure("cleanup_unconfirmed");
    const lateHandle = syntheticHandle({
      id: "late-normal-handle",
      terminationFailures: [unconfirmed],
    });
    const test = runnerHarness({ spawn: () => spawnAttempt.promise });
    const gate = new ClaudeRuntimeMutationGate();
    const manager = new ClaudeCodeUpdateManager({
      resolver: { resolve: () => resolved() },
      runtimeGate: gate,
      runner: test.runner,
      hasActiveTasks: () => false,
      isFakeRuntime: () => false,
    });

    const updating = manager.updateNow();
    await waitForRequest(test.requests);
    const disposing = manager.dispose();
    expect(gate.snapshot().updateActive).toBe(true);

    spawnAttempt.resolve(lateHandle.handle);
    await expect(updating).resolves.toMatchObject({
      status: "error",
      reason: "cleanup_unconfirmed",
    });
    await expect(disposing).resolves.toBeUndefined();

    expect(lateHandle.terminate).toHaveBeenCalledTimes(2);
    expect(gate.snapshot().updateActive).toBe(false);
  });

  it("performs a final cleanup sweep for a typed spawn failure retained after the first disposal sweep", async () => {
    const spawnAttempt = deferred<ManagedProcessHandle>();
    const cleanupConfirmation = deferred<void>();
    const retryCleanup = vi.fn(() => cleanupConfirmation.promise);
    const typedError = new ManagedProcessCleanupUnconfirmedError(
      Object.freeze({ retryCleanup }),
    );
    const test = runnerHarness({ spawn: () => spawnAttempt.promise });
    const gate = new ClaudeRuntimeMutationGate();
    const manager = new ClaudeCodeUpdateManager({
      resolver: { resolve: () => resolved() },
      runtimeGate: gate,
      runner: test.runner,
      hasActiveTasks: () => false,
      isFakeRuntime: () => false,
    });

    const updating = manager.updateNow();
    await waitForRequest(test.requests);
    let disposeSettled = false;
    const disposing = manager.dispose().finally(() => {
      disposeSettled = true;
    });
    spawnAttempt.reject(typedError);
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    const retryCountBeforeConfirmation = retryCleanup.mock.calls.length;
    const gateBeforeConfirmation = gate.snapshot().updateActive;
    const settledBeforeConfirmation = disposeSettled;

    cleanupConfirmation.resolve();
    await expect(updating).resolves.toMatchObject({
      status: "error",
      reason: "cleanup_unconfirmed",
    });
    await expect(disposing).resolves.toBeUndefined();

    expect(retryCountBeforeConfirmation).toBe(1);
    expect(gateBeforeConfirmation).toBe(true);
    expect(settledBeforeConfirmation).toBe(false);
    expect(gate.snapshot().updateActive).toBe(false);
  });

  it("maps an exit-journal rejection after confirmed close to update_failed without latching the gate", async () => {
    const control = syntheticHandle({ id: "closed-journal-failure" });
    let active: readonly ProcessStartRecord[] = [
      {
        id: control.handle.id,
        pid: control.handle.pid,
        kind: "claude",
        startedAt: control.handle.startedAt,
      },
    ];
    const test = runnerHarness({
      spawn: () => control.handle,
      activeProcesses: () => active,
    });
    const gate = new ClaudeRuntimeMutationGate();
    const manager = new ClaudeCodeUpdateManager({
      resolver: { resolve: () => resolved() },
      runtimeGate: gate,
      runner: test.runner,
      hasActiveTasks: () => false,
      isFakeRuntime: () => false,
    });

    const updating = manager.updateNow();
    await waitForRequest(test.requests);
    control.child.stdout.emit("data", Buffer.from("2.1.218"));
    active = [];
    control.rejectWait(new Error("private-exit-journal-sentinel"), true);

    await expect(updating).resolves.toEqual({
      status: "error",
      reason: "update_failed",
      beforeVersion: null,
      afterVersion: null,
    });
    expect(control.terminate).not.toHaveBeenCalled();
    expect(gate.snapshot().updateActive).toBe(false);
  });

  it("retains a handle when wait rejection occurs while the supervisor still owns it", async () => {
    const control = syntheticHandle({ id: "still-active-wait-failure" });
    const active: readonly ProcessStartRecord[] = [
      {
        id: control.handle.id,
        pid: control.handle.pid,
        kind: "claude",
        startedAt: control.handle.startedAt,
      },
    ];
    const test = runnerHarness({
      spawn: () => control.handle,
      activeProcesses: () => active,
    });
    const gate = new ClaudeRuntimeMutationGate();
    const manager = new ClaudeCodeUpdateManager({
      resolver: { resolve: () => resolved() },
      runtimeGate: gate,
      runner: test.runner,
      hasActiveTasks: () => false,
      isFakeRuntime: () => false,
    });

    const updating = manager.updateNow();
    await waitForRequest(test.requests);
    control.rejectWait(new Error("private-active-wait-sentinel"), false);

    await expect(updating).resolves.toMatchObject({
      status: "error",
      reason: "cleanup_unconfirmed",
    });
    expect(gate.snapshot().updateActive).toBe(true);
  });

  it("retains a typed pre-handle cleanup capability and releases the manager gate only after dispose confirms it", async () => {
    const retry = deferred<void>();
    const retryCleanup = vi.fn(() => retry.promise);
    const typedError = new ManagedProcessCleanupUnconfirmedError(
      Object.freeze({ retryCleanup }),
    );
    const test = runnerHarness({
      spawn: async () => {
        throw typedError;
      },
    });
    const gate = new ClaudeRuntimeMutationGate();
    const manager = new ClaudeCodeUpdateManager({
      resolver: { resolve: () => resolved() },
      runtimeGate: gate,
      runner: test.runner,
      hasActiveTasks: () => false,
      isFakeRuntime: () => false,
    });

    await expect(manager.updateNow()).resolves.toMatchObject({
      status: "error",
      reason: "cleanup_unconfirmed",
    });
    expect(gate.snapshot().updateActive).toBe(true);
    expect(test.requests).toHaveLength(1);
    await manager.updateNow();
    expect(test.requests).toHaveLength(1);

    const disposing = manager.dispose();
    await vi.waitFor(() => expect(retryCleanup).toHaveBeenCalledOnce());
    expect(gate.snapshot().updateActive).toBe(true);
    retry.resolve();
    await expect(disposing).resolves.toBeUndefined();
    expect(gate.snapshot().updateActive).toBe(false);
  });

  it("retains the exact returned handle after unconfirmed termination and retries until close is confirmed", async () => {
    vi.useFakeTimers();
    try {
      const terminationFailure = fixedRunnerFailure("cleanup_unconfirmed");
      const updateControl = syntheticHandle({
        id: "retained-update-handle",
        terminationFailures: [terminationFailure, terminationFailure],
      });
      const controls: SyntheticHandleControl[] = [];
      const test = runnerHarness({
        spawn: async (request) => {
          if (request.args?.at(-1) === "--version") {
            const control = syntheticHandle({ id: "pre-version" });
            controls.push(control);
            return control.handle;
          }
          return updateControl.handle;
        },
      });
      const gate = new ClaudeRuntimeMutationGate();
      const manager = new ClaudeCodeUpdateManager({
        resolver: { resolve: () => resolved() },
        runtimeGate: gate,
        runner: test.runner,
        hasActiveTasks: () => false,
        isFakeRuntime: () => false,
      });

      const updating = manager.updateNow();
      for (
        let turn = 0;
        controls[0]?.child.stdout.listenerCount("data") !== 1 && turn < 10;
        turn += 1
      ) {
        await Promise.resolve();
      }
      expect(controls[0].child.stdout.listenerCount("data")).toBe(1);
      controls[0].child.stdout.emit("data", Buffer.from("2.1.218"));
      controls[0].close(0);
      for (let turn = 0; test.requests.length !== 2 && turn < 10; turn += 1) {
        await Promise.resolve();
      }
      expect(test.requests).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(300_000);
      await expect(updating).resolves.toMatchObject({
        status: "error",
        reason: "cleanup_unconfirmed",
      });
      expect(updateControl.terminate).toHaveBeenCalledTimes(1);
      expect(gate.snapshot().updateActive).toBe(true);
      const requestCount = test.requests.length;
      await manager.updateNow();
      expect(test.requests).toHaveLength(requestCount);

      await expect(manager.dispose()).rejects.toMatchObject({
        reason: "cleanup_unconfirmed",
      });
      expect(updateControl.terminate).toHaveBeenCalledTimes(2);
      expect(gate.snapshot().updateActive).toBe(true);

      await expect(manager.dispose()).resolves.toBeUndefined();
      expect(updateControl.terminate).toHaveBeenCalledTimes(3);
      expect(gate.snapshot().updateActive).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposes an active returned handle and waits for its confirmed close", async () => {
    const test = runnerHarness();
    const running = test.runner
      .runUpdate(BASE_INVOCATION)
      .catch((error: unknown) => error);
    await waitForRequest(test.requests);

    await expect(test.runner.dispose()).resolves.toBeUndefined();
    expect(test.controls[0].terminate).toHaveBeenCalledOnce();
    expect(failureReason(await running)).toBe("update_failed");
  });
});
