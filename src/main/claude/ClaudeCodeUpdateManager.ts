import type {
  ClaudeCodeUpdateReason,
  ClaudeCodeUpdateSnapshot,
} from "../../shared/types/ipc";
import {
  ManagedProcessCleanupUnconfirmedError,
  type ManagedProcessCleanupCapability,
  type ManagedProcessHandle,
  type ManagedProcessRequest,
  type ProcessSupervisor,
} from "../processes/ProcessSupervisor";
import {
  sameClaudeInvocationIdentity,
  type ClaudeInvocationResolverPort,
  type ResolvedClaudeInvocation,
} from "./ClaudeInvocationResolver";
import type {
  ClaudeRuntimeLease,
  ClaudeRuntimeMutationGate,
} from "./ClaudeRuntimeMutationGate";

export type ClaudeUpdateLogStage =
  | "blocked"
  | "resolve"
  | "pre_version"
  | "update"
  | "post_resolve"
  | "post_version"
  | "terminal";

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
  log?(
    stage: ClaudeUpdateLogStage,
    reason: ClaudeCodeUpdateReason,
  ): void | Promise<void>;
}

type RunnerFailureReason =
  "permission_denied" | "timed_out" | "cleanup_unconfirmed" | "update_failed";

const RUNNER_FAILURE_REASONS = new Set<RunnerFailureReason>([
  "permission_denied",
  "timed_out",
  "cleanup_unconfirmed",
  "update_failed",
]);
const FORBIDDEN_INHERITED_ENVIRONMENT = new Set([
  "anthropic_api_key",
  "anthropic_auth_token",
  "anthropic_base_url",
  "claude_workbench_permission_endpoint",
  "claude_workbench_permission_token",
  "claude_workbench_permission_run_id",
]);
const PROBE_TIMEOUT_MS = 10_000;
const UPDATE_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_CAP_BYTES = 256 * 1024;
const CLOSE_TIMEOUT_MS = 5_000;
const MAX_VERSION_OUTPUT_BYTES = OUTPUT_CAP_BYTES;

const IDLE_SNAPSHOT = frozenSnapshot("idle", null, null, null);
const FAKE_RUNTIME_SNAPSHOT = frozenSnapshot(
  "unavailable",
  "unsupported_installation",
  null,
  null,
);

class ClaudeUpdateRunnerFailure extends Error {
  readonly reason: RunnerFailureReason;

  constructor(reason: RunnerFailureReason) {
    super("Claude update command failed.");
    this.name = "ClaudeUpdateRunnerFailure";
    this.reason = reason;
  }
}

interface ParsedVersion {
  readonly text: string;
  readonly core: readonly [bigint, bigint, bigint];
  readonly prerelease: readonly string[] | null;
}

interface PendingCleanup {
  retry(): Promise<void>;
}

function frozenSnapshot(
  status: ClaudeCodeUpdateSnapshot["status"],
  reason: ClaudeCodeUpdateReason,
  beforeVersion: string | null,
  afterVersion: string | null,
): ClaudeCodeUpdateSnapshot {
  return Object.freeze({ status, reason, beforeVersion, afterVersion });
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
}

function runnerFailureReason(error: unknown): RunnerFailureReason {
  if (typeof error === "object" && error !== null && "reason" in error) {
    const reason = (error as { readonly reason?: unknown }).reason;
    if (
      typeof reason === "string" &&
      RUNNER_FAILURE_REASONS.has(reason as RunnerFailureReason)
    ) {
      return reason as RunnerFailureReason;
    }
  }
  const code = errorCode(error);
  return code === "EACCES" || code === "EPERM"
    ? "permission_denied"
    : "update_failed";
}

function parseVersion(output: string): ParsedVersion | null {
  if (Buffer.byteLength(output, "utf8") > MAX_VERSION_OUTPUT_BYTES) return null;
  const trimmed = output.trim();
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|(?=[0-9A-Za-z-]*[A-Za-z-])[0-9A-Za-z-]+)(?:\.(?:0|[1-9]\d*|(?=[0-9A-Za-z-]*[A-Za-z-])[0-9A-Za-z-]+))*))?(?: \(Claude Code\))?$/u.exec(
      trimmed,
    );
  if (!match) return null;
  const prerelease = match[4] ? Object.freeze(match[4].split(".")) : null;
  return Object.freeze({
    text: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ""}`,
    core: Object.freeze([
      BigInt(match[1]),
      BigInt(match[2]),
      BigInt(match[3]),
    ]) as readonly [bigint, bigint, bigint],
    prerelease,
  });
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] < right.core[index]) return -1;
    if (left.core[index] > right.core[index]) return 1;
  }
  if (left.prerelease === null && right.prerelease === null) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/u.test(leftIdentifier);
    const rightNumeric = /^\d+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftIdentifier) < BigInt(rightIdentifier) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

function sanitizedEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
  patch: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!FORBIDDEN_INHERITED_ENVIRONMENT.has(key.toLocaleLowerCase("en-US"))) {
      sanitized[key] = value;
    }
  }
  for (const [key, value] of Object.entries(patch)) sanitized[key] = value;
  return sanitized;
}

function bufferFromChunk(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(typeof chunk === "string" ? chunk : String(chunk));
}

export class SupervisedClaudeUpdateCommandRunner implements ClaudeUpdateCommandRunnerPort {
  private readonly pendingCleanups = new Set<PendingCleanup>();
  private disposeInFlight: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly supervisor: Pick<
      ProcessSupervisor,
      "spawn" | "getActiveProcesses"
    >,
    private readonly environment: Readonly<NodeJS.ProcessEnv> = process.env,
  ) {}

  probeVersion(invocation: ResolvedClaudeInvocation): Promise<string> {
    return this.execute(invocation, "--version", PROBE_TIMEOUT_MS, true);
  }

  runUpdate(invocation: ResolvedClaudeInvocation): Promise<void> {
    return this.execute(invocation, "update", UPDATE_TIMEOUT_MS, false).then(
      () => undefined,
    );
  }

  dispose(): Promise<void> {
    if (this.disposeInFlight) return this.disposeInFlight;
    this.disposed = true;
    const attempt = this.disposePending();
    this.disposeInFlight = attempt;
    void attempt.then(
      () => {
        if (this.disposeInFlight === attempt) this.disposeInFlight = null;
      },
      () => {
        if (this.disposeInFlight === attempt) this.disposeInFlight = null;
      },
    );
    return attempt;
  }

  private async disposePending(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.pendingCleanups].map(async (pending) => {
        await pending.retry();
        this.pendingCleanups.delete(pending);
      }),
    );
    if (results.some((result) => result.status === "rejected")) {
      throw new ClaudeUpdateRunnerFailure("cleanup_unconfirmed");
    }
  }

  private async execute(
    invocation: ResolvedClaudeInvocation,
    suffix: "--version" | "update",
    timeoutMs: number,
    captureStdout: boolean,
  ): Promise<string> {
    if (this.disposed) throw new ClaudeUpdateRunnerFailure("update_failed");
    const request: ManagedProcessRequest = {
      kind: "claude",
      command: invocation.executable,
      args: [...invocation.prefixArgs, suffix],
      settlement: "close-only",
      closeTimeoutMs: CLOSE_TIMEOUT_MS,
      journalError: "redacted",
      options: {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: sanitizedEnvironment(
          this.environment,
          invocation.environmentPatch,
        ),
      },
    };

    let handle: ManagedProcessHandle;
    try {
      handle = await this.supervisor.spawn(request);
    } catch (error) {
      if (error instanceof ManagedProcessCleanupUnconfirmedError) {
        this.retainCapability(error.cleanup);
        throw new ClaudeUpdateRunnerFailure("cleanup_unconfirmed");
      }
      throw new ClaudeUpdateRunnerFailure(runnerFailureReason(error));
    }

    const pendingHandle = this.retainHandle(handle);
    if (this.disposed) {
      try {
        await pendingHandle.retry();
        this.pendingCleanups.delete(pendingHandle);
      } catch {
        throw new ClaudeUpdateRunnerFailure("cleanup_unconfirmed");
      }
      throw new ClaudeUpdateRunnerFailure("update_failed");
    }

    const stdout = handle.child.stdout;
    const stderr = handle.child.stderr;
    if (!stdout || !stderr) {
      try {
        await pendingHandle.retry();
      } catch {
        throw new ClaudeUpdateRunnerFailure("cleanup_unconfirmed");
      }
      throw new ClaudeUpdateRunnerFailure("update_failed");
    }

    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    let permissionDenied = false;
    let boundaryReason: RunnerFailureReason | null = null;
    let boundaryTermination: Promise<void> | null = null;
    let wakeBoundary!: () => void;
    const boundaryWake = new Promise<void>((resolve) => {
      wakeBoundary = resolve;
    });
    const requestBoundaryTermination = (reason: RunnerFailureReason): void => {
      if (boundaryReason !== null) return;
      boundaryReason = reason;
      try {
        boundaryTermination = pendingHandle.retry().then(() => {
          this.pendingCleanups.delete(pendingHandle);
        });
      } catch {
        boundaryTermination = Promise.reject(
          new ClaudeUpdateRunnerFailure("cleanup_unconfirmed"),
        );
      }
      void boundaryTermination.catch(() => undefined);
      wakeBoundary();
    };
    const onStdout = (chunk: unknown): void => {
      const bytes = bufferFromChunk(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > OUTPUT_CAP_BYTES) {
        requestBoundaryTermination("update_failed");
        return;
      }
      if (captureStdout) stdoutChunks.push(bytes);
    };
    const onStderr = (chunk: unknown): void => {
      stderrBytes += bufferFromChunk(chunk).length;
      if (stderrBytes > OUTPUT_CAP_BYTES) {
        requestBoundaryTermination("update_failed");
      }
    };
    const onError = (error: unknown): void => {
      const code = errorCode(error);
      if (code === "EACCES" || code === "EPERM") permissionDenied = true;
    };

    stdout.on("data", onStdout);
    stderr.on("data", onStderr);
    handle.child.on("error", onError);
    const timer = setTimeout(
      () => requestBoundaryTermination("timed_out"),
      timeoutMs,
    );
    timer.unref?.();

    try {
      const result = await Promise.race([
        handle.waitForExit().then(
          (exit) => ({ kind: "exit" as const, exit }),
          () => ({ kind: "wait_error" as const }),
        ),
        boundaryWake.then(() => ({ kind: "boundary" as const })),
      ]);
      if (result.kind === "boundary") {
        const reason = boundaryReason ?? "update_failed";
        await boundaryTermination;
        throw new ClaudeUpdateRunnerFailure(reason);
      }
      if (boundaryReason !== null) {
        await boundaryTermination;
        throw new ClaudeUpdateRunnerFailure(boundaryReason);
      }
      if (result.kind === "wait_error") {
        throw new ClaudeUpdateRunnerFailure(
          this.isHandleActive(handle)
            ? "cleanup_unconfirmed"
            : "update_failed",
        );
      }
      if (permissionDenied) {
        throw new ClaudeUpdateRunnerFailure("permission_denied");
      }
      if (result.exit.exitCode !== 0 || result.exit.error !== undefined) {
        throw new ClaudeUpdateRunnerFailure("update_failed");
      }
      return captureStdout ? Buffer.concat(stdoutChunks).toString("utf8") : "";
    } finally {
      clearTimeout(timer);
      stdout.removeListener("data", onStdout);
      stderr.removeListener("data", onStderr);
      handle.child.removeListener("error", onError);
    }
  }

  private retainCapability(capability: ManagedProcessCleanupCapability): void {
    this.pendingCleanups.add({
      retry: () => capability.retryCleanup(),
    });
  }

  private retainHandle(handle: ManagedProcessHandle): PendingCleanup {
    const pending: PendingCleanup = {
      retry: async () => {
        try {
          await handle.terminate();
        } catch {
          if (this.isHandleActive(handle)) {
            throw new ClaudeUpdateRunnerFailure("cleanup_unconfirmed");
          }
        }
      },
    };
    this.pendingCleanups.add(pending);
    void handle.waitForExit().then(
      () => this.pendingCleanups.delete(pending),
      () => {
        if (!this.isHandleActive(handle)) this.pendingCleanups.delete(pending);
      },
    );
    return pending;
  }

  private isHandleActive(handle: ManagedProcessHandle): boolean {
    try {
      return this.supervisor
        .getActiveProcesses()
        .some(
          (process) =>
            process.id === handle.id && process.pid === handle.pid,
        );
    } catch {
      return true;
    }
  }
}

export class ClaudeCodeUpdateManager {
  private snapshot: ClaudeCodeUpdateSnapshot;
  private inFlight: Promise<ClaudeCodeUpdateSnapshot> | null = null;
  private retainedLease: ClaudeRuntimeLease | null = null;
  private disposeInFlight: Promise<void> | null = null;

  constructor(private readonly options: ClaudeCodeUpdateManagerOptions) {
    this.snapshot = IDLE_SNAPSHOT;
  }

  getSnapshot(): ClaudeCodeUpdateSnapshot {
    return this.snapshot;
  }

  updateNow(): Promise<ClaudeCodeUpdateSnapshot> {
    if (this.inFlight) return this.inFlight;
    if (this.retainedLease) return Promise.resolve(this.snapshot);
    if (this.fakeRuntimeSelected()) {
      this.snapshot = FAKE_RUNTIME_SNAPSHOT;
      this.emitLog("blocked", "unsupported_installation");
      return Promise.resolve(this.snapshot);
    }
    if (this.activeTasksPresent()) {
      this.snapshot = frozenSnapshot("blocked", "active_tasks", null, null);
      this.emitLog("blocked", "active_tasks");
      return Promise.resolve(this.snapshot);
    }

    const lease = this.options.runtimeGate.tryAcquireUpdate();
    if (!lease) {
      this.snapshot = frozenSnapshot("blocked", "runtime_busy", null, null);
      this.emitLog("blocked", "runtime_busy");
      return Promise.resolve(this.snapshot);
    }

    this.snapshot = frozenSnapshot("updating", null, null, null);
    let resolvePublished!: (snapshot: ClaudeCodeUpdateSnapshot) => void;
    const published = new Promise<ClaudeCodeUpdateSnapshot>((resolve) => {
      resolvePublished = resolve;
    });
    this.inFlight = published;
    void published.then(() => {
      if (this.inFlight === published) this.inFlight = null;
    });
    const transaction = this.runTransaction(lease);
    void transaction.then(
      resolvePublished,
      () => {
        resolvePublished(this.finish("error", "update_failed", null, null));
      },
    );
    return published;
  }

  isUpdating(): boolean {
    return this.inFlight !== null;
  }

  dispose(): Promise<void> {
    if (this.disposeInFlight) return this.disposeInFlight;
    const attempt = this.performDispose();
    this.disposeInFlight = attempt;
    void attempt.then(
      () => {
        if (this.disposeInFlight === attempt) this.disposeInFlight = null;
      },
      () => {
        if (this.disposeInFlight === attempt) this.disposeInFlight = null;
      },
    );
    return attempt;
  }

  private async runTransaction(
    lease: ClaudeRuntimeLease,
  ): Promise<ClaudeCodeUpdateSnapshot> {
    let beforeVersion: ParsedVersion | null = null;
    let retainLease = false;
    try {
      this.emitLog("resolve", null);
      const initialResolution = this.options.resolver.resolve();
      if (!initialResolution.ok) {
        return this.finish("unavailable", initialResolution.reason, null, null);
      }
      const initialInvocation = initialResolution.invocation;

      this.emitLog("pre_version", null);
      beforeVersion = parseVersion(
        await this.options.runner.probeVersion(initialInvocation),
      );
      if (!beforeVersion) {
        return this.finish("error", "invalid_version", null, null);
      }
      this.snapshot = frozenSnapshot(
        "updating",
        null,
        beforeVersion.text,
        null,
      );

      this.emitLog("update", null);
      await this.options.runner.runUpdate(initialInvocation);

      this.emitLog("post_resolve", null);
      const postResolution = this.options.resolver.resolve();
      if (
        !postResolution.ok ||
        !sameClaudeInvocationIdentity(
          initialInvocation,
          postResolution.invocation,
        )
      ) {
        return this.finish(
          "error",
          "identity_changed",
          beforeVersion.text,
          null,
        );
      }

      this.emitLog("post_version", null);
      const afterVersion = parseVersion(
        await this.options.runner.probeVersion(postResolution.invocation),
      );
      if (!afterVersion || compareVersions(afterVersion, beforeVersion) < 0) {
        return this.finish(
          "error",
          "invalid_version",
          beforeVersion.text,
          null,
        );
      }
      const status =
        compareVersions(afterVersion, beforeVersion) === 0
          ? "up_to_date"
          : "updated";
      return this.finish(status, null, beforeVersion.text, afterVersion.text);
    } catch (error) {
      const reason = runnerFailureReason(error);
      retainLease = reason === "cleanup_unconfirmed";
      if (retainLease) this.retainedLease = lease;
      return this.finish("error", reason, beforeVersion?.text ?? null, null);
    } finally {
      if (!retainLease) lease.release();
    }
  }

  private async performDispose(): Promise<void> {
    const transaction = this.inFlight;
    let initialCleanupFailed = false;
    try {
      await this.options.runner.dispose();
    } catch {
      initialCleanupFailed = true;
    }
    if (transaction) {
      await transaction;
      try {
        await this.options.runner.dispose();
      } catch {
        throw new ClaudeUpdateRunnerFailure("cleanup_unconfirmed");
      }
    } else if (initialCleanupFailed) {
      throw new ClaudeUpdateRunnerFailure("cleanup_unconfirmed");
    }
    if (this.retainedLease) {
      this.retainedLease.release();
      this.retainedLease = null;
    }
  }

  private finish(
    status: ClaudeCodeUpdateSnapshot["status"],
    reason: ClaudeCodeUpdateReason,
    beforeVersion: string | null,
    afterVersion: string | null,
  ): ClaudeCodeUpdateSnapshot {
    this.snapshot = frozenSnapshot(status, reason, beforeVersion, afterVersion);
    this.emitLog("terminal", reason);
    return this.snapshot;
  }

  private fakeRuntimeSelected(): boolean {
    try {
      return this.options.isFakeRuntime();
    } catch {
      return true;
    }
  }

  private activeTasksPresent(): boolean {
    try {
      return this.options.hasActiveTasks();
    } catch {
      return true;
    }
  }

  private emitLog(
    stage: ClaudeUpdateLogStage,
    reason: ClaudeCodeUpdateReason,
  ): void {
    if (!this.options.log) return;
    try {
      const logged = this.options.log(stage, reason);
      if (logged && typeof logged.then === "function") {
        void logged.catch(() => undefined);
      }
    } catch {
      // Public logging is observational and cannot change update ownership.
    }
  }
}
