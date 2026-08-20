import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { StringDecoder } from 'node:string_decoder';
import { ClaudeEventParser } from './ClaudeEventParser';
import {
  ProcessSupervisor,
  type ManagedProcessHandle,
} from '../processes/ProcessSupervisor';
import {
  mergeClaudeInvocationEnvironment,
  type ClaudeInvocationResolution,
  type ClaudeInvocationResolverPort,
} from './ClaudeInvocationResolver';
import {
  ClaudeRuntimeBusyError,
  type ClaudeRuntimeLease,
  ClaudeRuntimeMutationGate,
} from './ClaudeRuntimeMutationGate';
import type {
  ClaudeAdapter,
  ClaudeEvent,
  ClaudeEventEnvelope,
  ClaudeInstallationInfo,
  ClaudeRunDescriptor,
  ClaudeRunOptions,
  CliPermissionMode,
} from '../../shared/types/claude';

export interface PermissionBrokerPort {
  registerRun(meta: {
    runId: string;
    sessionKey: string;
    projectPath: string;
    projectId?: string;
    taskId?: string;
    workflowId?: string;
  }): void;
  bindProcess(runId: string, processId: number | null): void;
  getMcpEnvironment(runId: string): { endpoint: string; token: string; runId: string };
  cancelRun(runId: string, reason?: string): void;
  completeRun(runId: string): void;
}

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

export interface ProviderEnvironmentPort {
  resolveChildEnvironment(
    options: Readonly<ClaudeRunOptions>,
    inherited: Readonly<NodeJS.ProcessEnv>,
  ): NodeJS.ProcessEnv;
}

interface ActiveRun {
  options: ClaudeRunOptions;
  process: ChildProcess;
  parser: ClaudeEventParser;
  startedAt: number;
  claudeSessionId: string;
  terminalEmitted: boolean;
  stopped: boolean;
  stderrTail: string;
  stderrBuffer: string;
  stderrDecoder: StringDecoder;
  managedProcess: ManagedProcessHandle;
  runtimeLease: ClaudeRuntimeLease;
}

function stableTaskId(options: ClaudeRunOptions): string {
  if (options.taskId?.trim()) return options.taskId.trim();
  const separator = options.sessionKey.lastIndexOf('::');
  return separator >= 0 ? options.sessionKey.slice(separator + 2) : options.sessionKey;
}

function trustedPermissionIdentity(options: ClaudeRunOptions): {
  projectId: string;
  taskId: string;
  workflowId?: string;
} {
  const projectId = options.projectId?.trim();
  const taskId = options.taskId?.trim();
  if (!projectId || !taskId) {
    throw new Error('Trusted task and project identity is required for permission registration.');
  }
  const workflowId = options.workflowContext?.workflowId.trim();
  return {
    projectId,
    taskId,
    ...(workflowId ? { workflowId } : {}),
  };
}

interface PermissionLaunch {
  mcpConfigJson: string;
  promptToolName: string;
}

const VALID_PERMISSION_MODES = new Set<CliPermissionMode>([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
]);
const MAX_STRUCTURED_OUTPUT_SCHEMA_BYTES = 64 * 1024;
const MAX_STDERR_BUFFER_CHARS = 64 * 1024;
const REDACTED_PROVIDER_SECRET = '[REDACTED]';
const CHILD_SECRET_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_WORKBENCH_PERMISSION_TOKEN',
] as const;

function childSecretPatterns(environment: Readonly<NodeJS.ProcessEnv>): string[] {
  const patterns = new Set<string>();
  for (const key of CHILD_SECRET_ENV_KEYS) {
    const secret = environment[key];
    if (!secret) continue;
    patterns.add(secret);
    const jsonEncoded = JSON.stringify(secret).slice(1, -1);
    if (jsonEncoded) patterns.add(jsonEncoded);
  }
  return [...patterns].sort((left, right) => right.length - left.length);
}

function redactSecretText(value: string, patterns: readonly string[]): string {
  let safe = value;
  for (const pattern of patterns) {
    if (pattern) safe = safe.split(pattern).join(REDACTED_PROVIDER_SECRET);
  }
  return safe;
}

function redactEventSecrets<T>(value: T, patterns: readonly string[]): T {
  if (typeof value === 'string') return redactSecretText(value, patterns) as T;
  if (Array.isArray(value)) {
    return value.map((entry) => redactEventSecrets(entry, patterns)) as T;
  }
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => (
    [key, redactEventSecrets(entry, patterns)]
  ))) as T;
}

function appendVariadic(args: string[], flag: string, values?: string[]): void {
  const safe = values?.map((value) => value.trim()).filter(Boolean) ?? [];
  if (safe.length > 0) args.push(flag, ...safe);
}

export function buildClaudeArgs(
  options: ClaudeRunOptions,
  permission?: PermissionLaunch,
): string[] {
  if (!options.prompt.trim()) throw new Error('Prompt must not be empty');
  const mode = options.permissionMode ?? 'default';
  if (!VALID_PERMISSION_MODES.has(mode)) throw new Error('Invalid permission mode');

  const args = [
    '-p',
    options.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
  ];
  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
  if (options.model?.trim()) args.push('--model', options.model.trim());
  args.push('--permission-mode', mode);
  if (mode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
  appendVariadic(args, '--allowedTools', options.allowedTools);
  appendVariadic(args, '--disallowedTools', options.disallowedTools);
  if (options.systemPrompt?.trim()) args.push('--system-prompt', options.systemPrompt);
  if (options.structuredOutputSchema) {
    const schema = JSON.stringify(options.structuredOutputSchema);
    if (Buffer.byteLength(schema, 'utf8') > MAX_STRUCTURED_OUTPUT_SCHEMA_BYTES) {
      throw new Error('Structured output schema exceeds the 64 KiB safety limit.');
    }
    args.push('--json-schema', schema);
  }
  if (options.maxTurns && options.maxTurns > 0) {
    args.push('--max-turns', String(Math.floor(options.maxTurns)));
  }
  if (permission && mode !== 'bypassPermissions') {
    args.push('--mcp-config', permission.mcpConfigJson);
    args.push('--permission-prompt-tool', permission.promptToolName);
  }
  return args;
}

export function sanitizedClaudeArgs(args: string[]): string[] {
  const redacted: string[] = [];
  const valueFlags = new Set([
    '-p',
    '--system-prompt',
    '--mcp-config',
    '--json-schema',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    redacted.push(arg);
    if (valueFlags.has(arg) && index + 1 < args.length) {
      const value = args[index + 1];
      redacted.push(arg === '-p' ? `[PROMPT_REDACTED:${value.length}]` : '[REDACTED]');
      index += 1;
    }
  }
  return redacted;
}

export interface StartupClaudeAdapterSelection {
  /** Explicit deterministic test-harness override. Never inferred from installation status. */
  forceFake: boolean;
  realAdapter: ClaudeAdapter;
  createFakeAdapter(): ClaudeAdapter;
}

/**
 * Keeps production execution truthful: an unavailable Claude CLI is reported by
 * the real adapter instead of silently returning deterministic fake results.
 */
export async function selectStartupClaudeAdapter(
  input: StartupClaudeAdapterSelection,
): Promise<ClaudeAdapter> {
  return input.forceFake ? input.createFakeAdapter() : input.realAdapter;
}

export class ClaudeCliAdapter extends EventEmitter implements ClaudeAdapter {
  private readonly invocationResolver: ClaudeInvocationResolverPort;
  private readonly runtimeGate: ClaudeRuntimeMutationGate;
  private readonly spawnProcess: typeof spawn;
  private readonly permissionBroker?: PermissionBrokerPort;
  private readonly permissionMcpPath?: string;
  private readonly processSupervisor: ProcessSupervisor;
  private readonly terminationGraceMs: number;
  private readonly terminationForceMs: number;
  private readonly providerEnvironment?: ProviderEnvironmentPort;
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(options: AdapterOptions) {
    super();
    this.invocationResolver = options.invocationResolver;
    this.runtimeGate = options.runtimeGate;
    this.spawnProcess = options.spawnProcess || spawn;
    this.permissionBroker = options.permissionBroker;
    this.permissionMcpPath = options.permissionMcpPath;
    this.terminationGraceMs = options.terminationGraceMs ?? 1_500;
    this.terminationForceMs = options.terminationForceMs ?? 5_000;
    this.providerEnvironment = options.providerEnvironment;
    this.processSupervisor = options.processSupervisor ?? new ProcessSupervisor({
      spawnProcess: this.spawnProcess,
      defaultGraceMs: this.terminationGraceMs,
      defaultForceMs: this.terminationForceMs,
    });
  }

  async checkInstallation(): Promise<ClaudeInstallationInfo> {
    const runtimeLease = this.runtimeGate.tryAcquireOrdinary();
    if (!runtimeLease) {
      return { installed: false, path: null, version: null };
    }

    let resolution: ClaudeInvocationResolution;
    try {
      resolution = this.invocationResolver.resolve();
    } catch {
      runtimeLease.release();
      return { installed: false, path: null, version: null };
    }
    if (!resolution.ok) {
      runtimeLease.release();
      return { installed: false, path: null, version: null };
    }
    const { invocation } = resolution;
    let child: ChildProcess;
    try {
      child = this.spawnProcess(invocation.executable, [
        ...invocation.prefixArgs,
        '--version',
      ], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: mergeClaudeInvocationEnvironment(process.env, invocation),
      });
    } catch {
      runtimeLease.release();
      return { installed: false, path: null, version: null };
    }

    return new Promise((resolve) => {
      let stdout = '';
      let settled = false;
      const finish = (result: ClaudeInstallationInfo) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
      child.once('error', () => finish({ installed: false, path: null, version: null }));
      child.once('close', (code) => {
        try {
          finish({
            installed: code === 0,
            path: code === 0 ? invocation.displayPath : null,
            version: code === 0 ? stdout.trim() || null : null,
          });
        } finally {
          runtimeLease.release();
        }
      });
    });
  }

  async runPrompt(options: ClaudeRunOptions): Promise<ClaudeRunDescriptor> {
    const runtimeLease = this.runtimeGate.tryAcquireOrdinary();
    if (!runtimeLease) throw new ClaudeRuntimeBusyError();

    let cwd: string;
    let secretPatterns: string[];
    let args: string[];
    let parser: ClaudeEventParser;
    let managedProcess: ManagedProcessHandle;
    try {
      if (this.activeRuns.has(options.runId)) throw new Error('Duplicate run id');
      cwd = path.resolve(options.projectPath);
      let projectDirectoryAvailable = false;
      try {
        projectDirectoryAvailable = fs.statSync(cwd).isDirectory();
      } catch {
        projectDirectoryAvailable = false;
      }
      if (!projectDirectoryAvailable) {
        throw new Error('Project directory is not available.');
      }

      let permission: PermissionLaunch | undefined;
      let childEnv: NodeJS.ProcessEnv = { ...process.env };
      if (options.modelProviderId) {
        if (!this.providerEnvironment) {
          throw new Error('Provider environment resolver is unavailable.');
        }
        childEnv = {
          ...this.providerEnvironment.resolveChildEnvironment(options, childEnv),
        };
      }
      if (this.permissionBroker && this.permissionMcpPath) {
        const identity = trustedPermissionIdentity(options);
        this.permissionBroker.registerRun({
          runId: options.runId,
          sessionKey: options.sessionKey,
          projectPath: cwd,
          ...identity,
        });
        const brokerEnvironment = this.permissionBroker.getMcpEnvironment(options.runId);
        childEnv = {
          ...childEnv,
          CLAUDE_WORKBENCH_PERMISSION_ENDPOINT: brokerEnvironment.endpoint,
          CLAUDE_WORKBENCH_PERMISSION_TOKEN: brokerEnvironment.token,
          CLAUDE_WORKBENCH_PERMISSION_RUN_ID: brokerEnvironment.runId,
        };
        permission = {
          mcpConfigJson: JSON.stringify({
            mcpServers: {
              workbench_permissions: {
                type: 'stdio',
                command: process.execPath,
                args: [this.permissionMcpPath],
                env: { ELECTRON_RUN_AS_NODE: '1' },
              },
            },
          }),
          promptToolName: 'mcp__workbench_permissions__request_permission',
        };
      }

      const resolution = this.invocationResolver.resolve();
      if (!resolution.ok) throw new Error('Claude Code is unavailable.');
      childEnv = {
        ...mergeClaudeInvocationEnvironment(childEnv, resolution.invocation),
      };
      secretPatterns = childSecretPatterns(childEnv);
      args = [
        ...resolution.invocation.prefixArgs,
        ...buildClaudeArgs(options, permission),
      ];
      console.info('[ClaudeCliAdapter] starting', {
        runId: options.runId,
        permissionMode: options.permissionMode ?? 'default',
      });

      parser = new ClaudeEventParser();
      managedProcess = await this.processSupervisor.spawn({
        id: options.runId,
        kind: 'claude',
        command: resolution.invocation.executable,
        args,
        sessionId: stableTaskId(options),
        taskId: stableTaskId(options),
        runId: options.runId,
        options: {
          cwd,
          env: childEnv,
          windowsHide: true,
          // -p is a one-shot text invocation. There is deliberately no writable
          // stdin, so Claude cannot wait three seconds for data that will never arrive.
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      });
    } catch (error) {
      try {
        this.permissionBroker?.cancelRun(options.runId, 'spawn failed');
      } catch {
        // Preserve the original launch failure.
      } finally {
        runtimeLease.release();
      }
      throw error;
    }
    const child: ChildProcess = managedProcess.child;

    const active: ActiveRun = {
      options,
      process: child,
      parser,
      startedAt: Date.now(),
      claudeSessionId: options.resumeSessionId || '',
      terminalEmitted: false,
      stopped: false,
      stderrTail: '',
      stderrBuffer: '',
      stderrDecoder: new StringDecoder('utf8'),
      managedProcess,
      runtimeLease,
    };
    this.activeRuns.set(options.runId, active);

    const emitSafe = (event: ClaudeEvent): void => {
      this.emitEnvelope(options, redactEventSecrets(event, secretPatterns));
    };
    const emitStderrLine = (rawLine: string): void => {
      if (!rawLine) return;
      const text = redactSecretText(rawLine, secretPatterns);
      active.stderrTail = `${active.stderrTail}${text}\n`.slice(-4000);
      if (/no stdin data received/i.test(text)) {
        console.warn('[ClaudeCliAdapter] stdin protocol warning', { runId: options.runId });
      }
      emitSafe({
        type: 'stderr',
        text,
        level: /error|fatal/i.test(text)
          ? 'error'
          : /warn|no stdin/i.test(text) ? 'warning' : 'info',
        timestamp: Date.now(),
      });
    };
    const appendStderr = (text: string): void => {
      active.stderrBuffer += text;
      if (active.stderrBuffer.length > MAX_STDERR_BUFFER_CHARS) {
        active.stderrBuffer = '';
        emitStderrLine('[stderr output omitted: line exceeded safety limit]');
        return;
      }
      const lines = active.stderrBuffer.split(/\r?\n/u);
      active.stderrBuffer = lines.pop() ?? '';
      for (const line of lines) emitStderrLine(line);
    };
    const flushStderr = (): void => {
      appendStderr(active.stderrDecoder.end());
      const remaining = active.stderrBuffer;
      active.stderrBuffer = '';
      if (remaining) emitStderrLine(remaining);
    };

    parser.on('event', (event: ClaudeEvent) => {
      if (event.type === 'system_init') active.claudeSessionId = event.sessionId;
      if (event.type === 'session_completed' || event.type === 'session_failed') {
        active.terminalEmitted = true;
      }
      emitSafe(event);
    });
    child.stdout?.on('data', (chunk) => parser.append(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      appendStderr(active.stderrDecoder.write(buffer));
    });
    child.once('error', (error) => {
      if (!active.stopped && !active.terminalEmitted) {
        active.terminalEmitted = true;
        emitSafe({
          type: 'session_failed',
          sessionId: active.claudeSessionId || undefined,
          error: `无法启动 Claude Code：${error.message}`,
          duration: Date.now() - active.startedAt,
          timestamp: Date.now(),
        });
      }
    });
    let finalized = false;
    const finalizeRun = (
      code: number | null,
      signal: string | null,
      processError?: string,
    ): void => {
      if (finalized) return;
      finalized = true;
      try {
        parser.flush();
        flushStderr();
        if (!active.stopped && !active.terminalEmitted) {
          active.terminalEmitted = true;
          if (processError) {
            emitSafe({
              type: 'session_failed',
              sessionId: active.claudeSessionId || undefined,
              error: `无法启动 Claude Code：${processError}`,
              duration: Date.now() - active.startedAt,
              timestamp: Date.now(),
            });
          } else if (code === 0) {
            emitSafe({
              type: 'session_completed',
              sessionId: active.claudeSessionId,
              duration: Date.now() - active.startedAt,
              timestamp: Date.now(),
            });
          } else {
            const detail = active.stderrTail.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 500);
            emitSafe({
              type: 'session_failed',
              sessionId: active.claudeSessionId || undefined,
              error: detail || `Claude Code 退出（code=${code ?? 'null'}, signal=${signal ?? 'none'}）`,
              duration: Date.now() - active.startedAt,
              timestamp: Date.now(),
            });
          }
        }
      } finally {
        this.activeRuns.delete(options.runId);
        try {
          this.permissionBroker?.completeRun(options.runId);
        } finally {
          active.runtimeLease.release();
        }
      }
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      void managedProcess.waitForExit().then(
        (exit) => finalizeRun(exit.exitCode, exit.signal, exit.error),
        () => finalizeRun(null, null, 'process supervision failed'),
      ).catch(() => undefined);
    } else {
      child.once('close', (code, signal) => finalizeRun(code, signal));
    }

    try {
      this.permissionBroker?.bindProcess(options.runId, child.pid ?? null);
    } catch (bindError) {
      active.stopped = true;
      try {
        this.permissionBroker?.cancelRun(options.runId, 'process bind failed');
      } catch {
        // Process ownership and lease cleanup still take priority.
      }
      try {
        const exit = await managedProcess.terminate({
          graceMs: this.terminationGraceMs,
          forceMs: this.terminationForceMs,
        });
        finalizeRun(exit.exitCode, exit.signal, exit.error);
      } catch (cleanupError) {
        throw new AggregateError(
          [bindError, cleanupError],
          'Claude process binding failed and cleanup could not be confirmed.',
        );
      }
      throw bindError;
    }

    emitSafe({
      type: 'session_started',
      sessionId: options.resumeSessionId || '',
      timestamp: Date.now(),
    });
    return { runId: options.runId, pid: child.pid ?? null };
  }

  async stopRun(runId: string): Promise<boolean> {
    const active = this.activeRuns.get(runId);
    if (!active) return false;
    active.stopped = true;
    this.permissionBroker?.cancelRun(runId, '用户停止了任务');
    try {
      await active.managedProcess.terminate({
        graceMs: this.terminationGraceMs,
        forceMs: this.terminationForceMs,
      });
    } catch (error) {
      // Keep a later child close observable so TaskManager can still release
      // its session and mutation locks after a termination failure.
      active.stopped = false;
      throw error;
    }
    return true;
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.activeRuns.keys()].map((runId) => this.stopRun(runId)),
    );
  }

  subscribe(listener: (envelope: ClaudeEventEnvelope) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }

  private emitEnvelope(options: ClaudeRunOptions, event: ClaudeEvent): void {
    this.emit('event', {
      runId: options.runId,
      projectKey: options.projectKey,
      sessionKey: options.sessionKey,
      ...(options.projectId?.trim() ? { projectId: options.projectId.trim() } : {}),
      projectPath: options.projectPath,
      taskId: stableTaskId(options),
      ...(options.workflowContext?.workflowId
        ? { workflowId: options.workflowContext.workflowId }
        : {}),
      event,
    } satisfies ClaudeEventEnvelope);
  }
}
