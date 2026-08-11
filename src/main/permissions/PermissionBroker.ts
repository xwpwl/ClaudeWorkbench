import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import * as http from 'http';
import type {
  ExplicitHighRiskPermissionRequest,
  PermissionAnalysis,
  PermissionDecision,
  PermissionRequestKind,
  PermissionRisk,
  PermissionRule,
  PermissionSettlement,
  PermissionSettlementCause,
} from '../../shared/types/permissionBroker';
import { canonicalizeProjectPath } from '../projects/ProjectService';
import {
  analyzePermissionRequest,
  canPersistProjectRule,
  createPermissionRule,
  permissionRuleCacheKey,
  permissionRuleMatches,
} from './PermissionRuleEngine';

export type { PermissionSettlement, PermissionSettlementCause };

export type { PermissionDecision, PermissionRisk };

export interface PermissionRunRegistration {
  runId: string;
  sessionKey: string;
  projectPath: string;
  projectId?: string;
  taskId?: string;
  workflowId?: string;
}

export interface PermissionMcpEnvironment {
  [key: string]: string;
  endpoint: string;
  token: string;
  runId: string;
}

export interface PermissionRequest {
  requestId: string;
  runId: string;
  sessionKey: string;
  projectPath: string;
  toolName: string;
  toolUseId?: string;
  input: Record<string, unknown>;
  risk: PermissionRisk;
  taskId: string;
  workflowId?: string;
  processId?: number;
  capability: PermissionAnalysis['capability'];
  canonicalProjectPath: string;
  effectiveCwd: string;
  targetPaths: string[];
  outsideProject: boolean;
  normalizedRule: string;
  cacheKey: string;
  cacheStatus: 'miss' | 'not_cacheable';
  cacheMissReason: string;
  projectRulePersistable: boolean;
  projectRuleDisabledReason?: string;
  kind?: PermissionRequestKind;
  createdAt: number;
}

export interface PermissionAllowResult {
  behavior: 'allow';
  updatedInput: Record<string, unknown>;
  toolUseID?: string;
  decisionClassification: 'user_temporary' | 'user_permanent';
}

export interface PermissionDenyResult {
  behavior: 'deny';
  message: string;
  interrupt?: boolean;
  toolUseID?: string;
  decisionClassification: 'user_reject';
}

export type PermissionResult = PermissionAllowResult | PermissionDenyResult;
export type PermissionRequestListener = (request: PermissionRequest) => void;
export type PermissionSettlementListener = (settlement: PermissionSettlement) => void;
export type ExplicitHighRiskDecision = 'allow_once' | 'deny';

export interface PermissionBrokerOptions {
  requestTimeoutMs?: number;
  now?: () => number;
  projectRuleStore?: PermissionProjectRuleStore;
}

interface RegisteredRun extends PermissionRunRegistration {
  token: string;
  taskId: string;
  projectPath: string;
  canonicalProjectPath: string;
  processId?: number;
}

export interface TaskPermissionIdentity {
  taskId: string;
  workflowId?: string;
  projectPath: string;
}

export interface TaskPermissionContext extends TaskPermissionIdentity {
  canonicalProjectPath: string;
  allowedRules: PermissionRule[];
  externalRoots: string[];
  createdAt: number;
}

export interface PermissionProjectRuleStore {
  listEnabled(canonicalProjectPath: string): PermissionRule[];
  create(rule: PermissionRule): PermissionRule;
  recordHit?(ruleId: string, hitAt: number): void;
}

interface PermissionToolPayload {
  runId: string;
  toolName: string;
  toolUseId?: string;
  input: Record<string, unknown>;
}

interface PendingPermission {
  request: PermissionRequest;
  fingerprint: string;
  analysis: PermissionAnalysis;
  resolve: (result: PermissionResult) => void;
  resolveSettlement: (settlement: PermissionSettlement) => void;
  timeout: NodeJS.Timeout;
}

interface PendingRequestOptions {
  requestId?: string;
  risk?: PermissionRisk;
  analysis?: PermissionAnalysis;
  kind?: PermissionRequestKind;
  createdAt?: number;
}

class HttpRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpRequestError';
    this.status = status;
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const PERMISSION_ENDPOINT_ENV = 'CLAUDE_WORKBENCH_PERMISSION_ENDPOINT';
const PERMISSION_TOKEN_ENV = 'CLAUDE_WORKBENCH_PERMISSION_TOKEN';
const PERMISSION_RUN_ID_ENV = 'CLAUDE_WORKBENCH_PERMISSION_RUN_ID';

const HIGH_RISK_COMMAND_PATTERNS: RegExp[] = [
  /(?:^|[;&|]\s*)(?:sudo\s+)?rm\s+(?=[^;&|\r\n]*(?:-[^\s]*r|--recursive\b))/i,
  /(?:^|[;&|]\s*)(?:rmdir|rd)\b[^\r\n;&|]*\/s\b/i,
  /(?:^|[;&|]\s*)del\b[^\r\n;&|]*\/s\b/i,
  /(?:^|[;&|]\s*)(?:remove-item|ri)\b[^\r\n]*(?:-recurse|-r\b)/i,
  /(?:powershell|pwsh)\b[^\r\n]*(?:-encodedcommand\b|-enc\b)/i,
  /(?:^|[;&|]\s*)(?:format|diskpart|shutdown|reboot|restart-computer)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+(?:-[^\s]*f|--force)\b/i,
  /\bgit\s+push\b[^\r\n]*(?:--force(?:-with-lease)?|-f\b)/i,
  /\b(?:npm|pnpm|yarn)\s+publish\b/i,
];

const MEDIUM_RISK_TOOLS = new Set([
  'bash',
  'shell',
  'powershell',
  'cmd',
  'write',
  'edit',
  'multiedit',
  'notebookedit',
  'websearch',
  'webfetch',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(',')}}`;
}

function permissionFingerprint(toolName: string, input: Record<string, unknown>): string {
  return createHash('sha256')
    .update(toolName)
    .update('\0')
    .update(canonicalJson(input))
    .digest('hex');
}

function commandFromInput(input: Record<string, unknown>): string | null {
  for (const key of ['command', 'cmd', 'script']) {
    if (typeof input[key] === 'string') {
      return input[key];
    }
  }
  return null;
}

export function classifyPermissionRisk(
  toolName: string,
  input: Record<string, unknown>,
): PermissionRisk {
  const normalizedTool = toolName.trim().toLowerCase();
  const command = commandFromInput(input);

  if (command && HIGH_RISK_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
    return 'high';
  }

  return MEDIUM_RISK_TOOLS.has(normalizedTool) ? 'medium' : 'low';
}

function secureTokenEquals(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function allowResult(
  input: Record<string, unknown>,
  toolUseId: string | undefined,
  permanent: boolean,
): PermissionAllowResult {
  return {
    behavior: 'allow',
    updatedInput: input,
    ...(toolUseId ? { toolUseID: toolUseId } : {}),
    decisionClassification: permanent ? 'user_permanent' : 'user_temporary',
  };
}

function denyResult(toolUseId: string | undefined, message: string): PermissionDenyResult {
  return {
    behavior: 'deny',
    message,
    ...(toolUseId ? { toolUseID: toolUseId } : {}),
    decisionClassification: 'user_reject',
  };
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      throw new HttpRequestError(413, 'Request body is too large.');
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    throw new HttpRequestError(400, 'A JSON request body is required.');
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpRequestError(400, 'The request body must be valid JSON.');
  }
}

function parseToolPayload(value: unknown): PermissionToolPayload {
  if (!isRecord(value)) {
    throw new HttpRequestError(400, 'The request body must be a JSON object.');
  }

  const runId = value.runId;
  const toolName = value.tool_name;
  const toolUseId = value.tool_use_id;
  const input = value.input;

  if (typeof runId !== 'string' || runId.length === 0 || runId.length > 256) {
    throw new HttpRequestError(400, 'runId is required.');
  }
  if (
    typeof toolName !== 'string'
    || toolName.trim().length === 0
    || toolName.length > 256
    || /[\u0000-\u001f]/.test(toolName)
  ) {
    throw new HttpRequestError(400, 'tool_name is required.');
  }
  if (toolUseId !== undefined && (typeof toolUseId !== 'string' || toolUseId.length > 512)) {
    throw new HttpRequestError(400, 'tool_use_id must be a string.');
  }
  if (!isRecord(input)) {
    throw new HttpRequestError(400, 'input must be a JSON object.');
  }

  return {
    runId,
    toolName,
    ...(toolUseId ? { toolUseId } : {}),
    input,
  };
}

function bearerToken(request: http.IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length);
  return token.length > 0 ? token : null;
}

function sendJson(response: http.ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function validateExplicitHighRiskRequest(request: ExplicitHighRiskPermissionRequest): void {
  for (const [label, value, maxLength] of [
    ['requestId', request.requestId, 512],
    ['runId', request.runId, 256],
    ['sessionKey', request.sessionKey, 32_768],
    ['projectPath', request.projectPath, 32_768],
  ] as const) {
    if (
      typeof value !== 'string'
      || value.trim().length === 0
      || value.length > maxLength
      || value.includes('\0')
    ) {
      throw new Error(`${label} is invalid.`);
    }
  }
  if (
    request.kind !== 'bypass_permissions'
    || !Number.isFinite(request.createdAt)
    || request.createdAt < 0
  ) {
    throw new Error('Explicit high-risk request metadata is invalid.');
  }
}

function taskPermissionKey(identity: {
  taskId: string;
  workflowId?: string;
  canonicalProjectPath: string;
}): string {
  return [identity.taskId, identity.workflowId ?? '', identity.canonicalProjectPath].join('\0');
}

function analysisCacheKey(analysis: PermissionAnalysis): string {
  return createHash('sha256').update(analysis.normalizedRule).digest('hex');
}

/**
 * Main-process permission broker for a single Workbench application instance.
 *
 * The HTTP listener is loopback-only. Every run receives an independent bearer
 * token, and decisions are held in memory for the lifetime of that run only.
 */
export class PermissionBroker {
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;
  private readonly projectRuleStore?: PermissionProjectRuleStore;
  private readonly runs = new Map<string, RegisteredRun>();
  private readonly taskContexts = new Map<string, TaskPermissionContext>();
  private readonly pending = new Map<string, PendingPermission>();
  private readonly listeners = new Set<PermissionRequestListener>();
  private readonly settlementListeners = new Set<PermissionSettlementListener>();
  private readonly deferredSettlements: Array<{
    settlement: PermissionSettlement;
    listeners: PermissionSettlementListener[];
  }> = [];
  private requestDispatchDepth = 0;
  private server: http.Server | null = null;
  private endpoint: string | null = null;
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(options: PermissionBrokerOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.projectRuleStore = options.projectRuleStore;

    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error('requestTimeoutMs must be a positive finite number.');
    }
  }

  async start(): Promise<void> {
    if (this.server?.listening) return;
    if (this.startPromise) return this.startPromise;
    if (this.closePromise) {
      throw new Error('PermissionBroker is closing.');
    }

    this.startPromise = new Promise<void>((resolve, reject) => {
      const server = http.createServer((request, response) => {
        void this.handleHttpRequest(request, response);
      });

      const onError = (error: Error): void => {
        server.removeListener('listening', onListening);
        this.server = null;
        reject(error);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          this.server = null;
          reject(new Error('PermissionBroker did not receive a TCP address.'));
          return;
        }
        this.server = server;
        this.endpoint = `http://127.0.0.1:${address.port}/permission`;
        resolve();
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    }).finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  registerRun(registration: PermissionRunRegistration): void {
    const { runId, sessionKey, projectPath } = registration;
    if (this.closePromise) {
      throw new Error('PermissionBroker is closing.');
    }
    if (!runId || !sessionKey || !projectPath) {
      throw new Error('runId, sessionKey, and projectPath are required.');
    }
    if (this.runs.has(runId)) {
      throw new Error(`Permission run is already registered: ${runId}`);
    }

    const canonicalProject = canonicalizeProjectPath(projectPath);
    const taskId = registration.taskId?.trim() || runId;
    this.runs.set(runId, {
      ...registration,
      runId,
      sessionKey,
      taskId,
      projectPath: canonicalProject.displayPath,
      canonicalProjectPath: canonicalProject.canonicalPath,
      token: randomBytes(32).toString('base64url'),
    });
  }

  bindProcess(runId: string, processId: number | null): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown permission run: ${runId}`);
    if (processId === null) {
      delete run.processId;
      return;
    }
    if (!Number.isSafeInteger(processId) || processId <= 0) {
      throw new Error('processId must be a positive integer.');
    }
    run.processId = processId;
  }

  completeTask(identity: TaskPermissionIdentity): void {
    const canonicalProjectPath = canonicalizeProjectPath(identity.projectPath).canonicalPath;
    this.taskContexts.delete(taskPermissionKey({
      taskId: identity.taskId,
      workflowId: identity.workflowId,
      canonicalProjectPath,
    }));
  }

  getMcpEnvironment(runId: string): PermissionMcpEnvironment {
    if (!this.endpoint || !this.server?.listening) {
      throw new Error('PermissionBroker has not been started.');
    }
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Unknown permission run: ${runId}`);
    }
    return {
      endpoint: this.endpoint,
      token: run.token,
      runId,
      // ClaudeCliAdapter spreads this object directly into the child process
      // environment. Keep the descriptive fields for callers and expose the
      // exact variables consumed by the independent MCP helper.
      [PERMISSION_ENDPOINT_ENV]: this.endpoint,
      [PERMISSION_TOKEN_ENV]: run.token,
      [PERMISSION_RUN_ID_ENV]: runId,
    };
  }

  subscribe(listener: PermissionRequestListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeSettlements(listener: PermissionSettlementListener): () => void {
    this.settlementListeners.add(listener);
    return () => {
      this.settlementListeners.delete(listener);
    };
  }

  /**
   * Requests explicit, one-shot approval before a bypassPermissions run starts.
   *
   * This deliberately reuses the ordinary request/decision/settlement streams,
   * while forcing the request to high risk so reusable scopes can never be
   * cached. The temporary registration is removed before this promise settles
   * to the caller, allowing ClaudeCliAdapter to register the same run id later.
   */
  async requestExplicitHighRisk(
    request: ExplicitHighRiskPermissionRequest,
  ): Promise<PermissionSettlement> {
    validateExplicitHighRiskRequest(request);
    this.registerRun({
      runId: request.runId,
      sessionKey: request.sessionKey,
      projectPath: request.projectPath,
    });
    const registeredRun = this.runs.get(request.runId);
    if (!registeredRun) throw new Error('Explicit high-risk run registration failed.');

    try {
      const pending = this.createPendingRequest(
        registeredRun,
        {
          runId: request.runId,
          toolName: 'BypassPermissions',
          input: { permissionMode: 'bypassPermissions' },
        },
        permissionFingerprint('BypassPermissions', { permissionMode: 'bypassPermissions' }),
        {
          requestId: request.requestId,
          risk: 'high',
          kind: request.kind,
          createdAt: request.createdAt,
        },
      );
      return await pending.settlement;
    } finally {
      const pending = this.pending.get(request.requestId);
      if (pending) {
        this.settlePending(
          request.requestId,
          denyResult(undefined, 'Explicit high-risk permission request was cancelled.'),
          'run_cancelled',
        );
      }
      if (this.runs.get(request.runId) === registeredRun) {
        this.runs.delete(request.runId);
      }
    }
  }

  decide(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;

    if (
      decision !== 'allow_once'
      && decision !== 'allow_for_task'
      && decision !== 'allow_for_project'
      && decision !== 'deny'
    ) {
      this.settlePending(
        requestId,
        denyResult(pending.request.toolUseId, 'Invalid permission decision.'),
        'invalid_decision',
      );
      return false;
    }

    // Renderer IPC is an untrusted decision source. A renderer may always
    // reject a dangerous-mode request, but it can never grant one. Keep the
    // request pending when it attempts an allow so the main-process native
    // confirmation remains the sole authority.
    if (pending.request.kind === 'bypass_permissions' && decision !== 'deny') {
      return false;
    }

    return this.applyDecision(requestId, pending, decision);
  }

  /**
   * Main-process-only, one-shot decision path for bypassPermissions.
   *
   * This method is deliberately not exposed by preload or IPC. It refuses
   * ordinary tool requests and does not support session-wide authorization.
   */
  decideExplicitHighRisk(requestId: string, decision: ExplicitHighRiskDecision): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.request.kind !== 'bypass_permissions') return false;
    if (decision !== 'allow_once' && decision !== 'deny') return false;
    return this.applyDecision(requestId, pending, decision);
  }

  private applyDecision(
    requestId: string,
    pending: PendingPermission,
    decision: PermissionDecision,
  ): boolean {

    const run = this.runs.get(pending.request.runId);
    if (!run) {
      this.settlePending(
        requestId,
        denyResult(pending.request.toolUseId, 'Permission run is no longer active.'),
        'run_inactive',
      );
      return false;
    }

    if (decision === 'deny') {
      this.settlePending(
        requestId,
        denyResult(pending.request.toolUseId, 'User denied this tool request.'),
        'deny',
      );
      return true;
    }

    let appliedScope: 'task' | 'project' | null = null;
    let appliedRule: PermissionRule | null = null;
    if (decision === 'allow_for_task') {
      try {
        appliedRule = createPermissionRule(pending.analysis, 'task', {
          ...(pending.analysis.outsideProject && pending.analysis.externalRoot
            ? { externalRoot: pending.analysis.externalRoot }
            : {}),
          now: this.now(),
        });
        const context = this.taskContextForRun(run, true);
        context.allowedRules.push(appliedRule);
        if (appliedRule.externalRoot && !context.externalRoots.includes(appliedRule.externalRoot)) {
          context.externalRoots.push(appliedRule.externalRoot);
        }
        appliedScope = 'task';
      } catch {
        // Do not silently reinterpret a reusable decision as a one-shot
        // authorization. The renderer can explicitly submit allow_once.
        return false;
      }
    } else if (decision === 'allow_for_project') {
      if (!this.projectRuleStore || !canPersistProjectRule(pending.analysis)) return false;
      try {
        appliedRule = this.projectRuleStore.create(createPermissionRule(
          pending.analysis,
          'project',
          { now: this.now() },
        ));
        appliedScope = 'project';
      } catch {
        // Persistence failures must remain visible and must never silently
        // broaden or downgrade the user's selected scope.
        return false;
      }
    }
    const settled = this.settlePending(
      requestId,
      allowResult(pending.request.input, pending.request.toolUseId, appliedScope !== null),
      appliedScope === 'task'
        ? 'allow_for_task'
        : appliedScope === 'project'
          ? 'allow_for_project'
          : 'allow_once',
      appliedRule ?? undefined,
    );
    if (settled && appliedRule) {
      this.autoSettleMatchingPending(run, appliedRule);
    }
    return settled;
  }

  cancelRun(runId: string): void {
    this.cleanupRun(
      runId,
      'Permission request was cancelled because the run stopped.',
      'run_cancelled',
    );
  }

  completeRun(runId: string): void {
    this.cleanupRun(
      runId,
      'Permission request was cancelled because the run completed.',
      'run_completed',
    );
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;

    this.closePromise = (async () => {
      if (this.startPromise) {
        try {
          await this.startPromise;
        } catch {
          // A failed start has no listener left to close.
        }
      }

      for (const runId of [...this.runs.keys()]) {
        this.cleanupRun(runId, 'Permission broker was closed.', 'broker_closed');
      }
      this.taskContexts.clear();
      this.listeners.clear();
      this.settlementListeners.clear();

      const server = this.server;
      this.server = null;
      this.endpoint = null;
      if (!server) return;

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeIdleConnections?.();
      });
    })().finally(() => {
      this.closePromise = null;
    });

    return this.closePromise;
  }

  private async handleHttpRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    try {
      if (request.method !== 'POST' || request.url !== '/permission') {
        throw new HttpRequestError(405, 'Only POST /permission is supported.');
      }

      const payload = parseToolPayload(await readJsonBody(request));
      const run = this.runs.get(payload.runId);
      if (!run) {
        throw new HttpRequestError(404, 'Permission run was not found.');
      }

      const token = bearerToken(request);
      if (!token || !secureTokenEquals(token, run.token)) {
        throw new HttpRequestError(401, 'Invalid permission broker credentials.');
      }

      const fingerprint = permissionFingerprint(payload.toolName, payload.input);
      const analysis = analyzePermissionRequest(payload.toolName, payload.input, run.projectPath);
      const matchedRule = this.matchingRule(run, analysis);
      if (matchedRule) {
        sendJson(response, 200, allowResult(payload.input, payload.toolUseId, true));
        this.emitAutoAllowedSettlement(run, payload, fingerprint, analysis, matchedRule);
        return;
      }

      const { requestId, result } = this.createPendingRequest(
        run,
        payload,
        fingerprint,
        { analysis },
      );
      const onConnectionClosed = (): void => {
        if (!response.writableEnded) {
          const pending = this.pending.get(requestId);
          if (pending) {
            this.settlePending(
              requestId,
              denyResult(pending.request.toolUseId, 'Permission requester disconnected.'),
              'requester_disconnected',
            );
          }
        }
      };
      response.once('close', onConnectionClosed);

      try {
        sendJson(response, 200, await result);
      } finally {
        response.removeListener('close', onConnectionClosed);
      }
    } catch (error) {
      if (error instanceof HttpRequestError) {
        sendJson(response, error.status, { error: error.message });
      } else {
        sendJson(response, 500, { error: 'Permission broker request failed.' });
      }
    }
  }

  private taskContextForRun(
    run: RegisteredRun,
    create: boolean,
  ): TaskPermissionContext {
    const key = taskPermissionKey(run);
    const existing = this.taskContexts.get(key);
    if (existing) return existing;
    const context: TaskPermissionContext = {
      taskId: run.taskId,
      ...(run.workflowId ? { workflowId: run.workflowId } : {}),
      projectPath: run.projectPath,
      canonicalProjectPath: run.canonicalProjectPath,
      allowedRules: [],
      externalRoots: [],
      createdAt: this.now(),
    };
    if (create) this.taskContexts.set(key, context);
    return context;
  }

  private matchingRule(
    run: RegisteredRun,
    analysis: PermissionAnalysis,
  ): PermissionRule | null {
    if (analysis.risk === 'high') return null;
    const taskContext = this.taskContexts.get(taskPermissionKey(run));
    const taskRule = taskContext?.allowedRules.find((rule) => permissionRuleMatches(rule, analysis));
    if (taskRule) return taskRule;

    for (const rule of this.projectRuleStore?.listEnabled(run.canonicalProjectPath) ?? []) {
      if (rule.scope === 'project' && permissionRuleMatches(rule, analysis)) return rule;
    }
    return null;
  }

  /**
   * Re-evaluates requests that arrived concurrently before a reusable grant.
   *
   * A rule may settle only requests in the exact task context that created a
   * task rule, or in the exact canonical project for a persisted project rule.
   * permissionRuleMatches still enforces capability, risk, cwd, target paths,
   * and scoped external-root containment. Escalations remain pending.
   */
  private autoSettleMatchingPending(
    grantingRun: RegisteredRun,
    rule: PermissionRule,
  ): void {
    const grantingTaskKey = taskPermissionKey(grantingRun);
    for (const [requestId, pending] of [...this.pending]) {
      const candidateRun = this.runs.get(pending.request.runId);
      if (!candidateRun) continue;
      const sameScope = rule.scope === 'task'
        ? taskPermissionKey(candidateRun) === grantingTaskKey
        : candidateRun.canonicalProjectPath === grantingRun.canonicalProjectPath;
      if (!sameScope || !permissionRuleMatches(rule, pending.analysis)) continue;
      if (rule.scope === 'project') {
        this.projectRuleStore?.recordHit?.(rule.id, this.now());
      }
      this.settlePending(
        requestId,
        allowResult(pending.request.input, pending.request.toolUseId, true),
        'permission_auto_allowed',
        rule,
      );
    }
  }

  private emitAutoAllowedSettlement(
    run: RegisteredRun,
    payload: PermissionToolPayload,
    fingerprint: string,
    analysis: PermissionAnalysis,
    rule: PermissionRule,
  ): void {
    const settledAt = this.now();
    this.projectRuleStore?.recordHit?.(rule.id, settledAt);
    this.emitSettlement({
      requestId: randomUUID(),
      runId: run.runId,
      sessionKey: run.sessionKey,
      projectPath: run.projectPath,
      toolName: payload.toolName,
      ...(payload.toolUseId ? { toolUseId: payload.toolUseId } : {}),
      behavior: 'allow',
      cause: 'permission_auto_allowed',
      decisionClassification: 'rule_auto_allow',
      taskId: run.taskId,
      ...(run.workflowId ? { workflowId: run.workflowId } : {}),
      ...(run.processId ? { processId: run.processId } : {}),
      capability: analysis.capability,
      risk: analysis.risk,
      canonicalProjectPath: analysis.canonicalProjectPath,
      effectiveCwd: analysis.effectiveCwd,
      targetPaths: [...analysis.targetPaths],
      outsideProject: analysis.outsideProject,
      normalizedRule: analysis.normalizedRule,
      cacheKey: `${rule.scope}:${permissionRuleCacheKey(rule)}:${fingerprint.slice(0, 12)}`,
      scope: rule.scope,
      matchedRuleId: rule.id,
      settledAt,
    });
  }

  private createPendingRequest(
    run: RegisteredRun,
    payload: PermissionToolPayload,
    fingerprint: string,
    options: PendingRequestOptions = {},
  ): {
    requestId: string;
    result: Promise<PermissionResult>;
    settlement: Promise<PermissionSettlement>;
  } {
    const requestId = options.requestId ?? randomUUID();
    if (this.pending.has(requestId)) {
      throw new Error(`Permission request is already pending: ${requestId}`);
    }
    const baseAnalysis = options.analysis
      ?? analyzePermissionRequest(payload.toolName, payload.input, run.projectPath);
    const analysis: PermissionAnalysis = options.risk && options.risk !== baseAnalysis.risk
      ? {
        ...baseAnalysis,
        risk: options.risk,
        cacheableForTask: options.risk === 'high' ? false : baseAnalysis.cacheableForTask,
        persistableForProject: options.risk === 'high' ? false : baseAnalysis.persistableForProject,
      }
      : baseAnalysis;
    const cacheKey = analysisCacheKey(analysis);
    const cacheMissReason = analysis.risk === 'high'
      ? analysis.nonReusableReason ?? 'High-risk operations are never auto-allowed.'
      : analysis.outsideProject
        ? 'The request targets a path outside the canonical project root.'
        : 'No matching task or project permission rule was found.';
    const permissionRequest: PermissionRequest = {
      requestId,
      runId: run.runId,
      sessionKey: run.sessionKey,
      projectPath: run.projectPath,
      toolName: payload.toolName,
      ...(payload.toolUseId ? { toolUseId: payload.toolUseId } : {}),
      input: payload.input,
      risk: analysis.risk,
      taskId: run.taskId,
      ...(run.workflowId ? { workflowId: run.workflowId } : {}),
      ...(run.processId ? { processId: run.processId } : {}),
      capability: analysis.capability,
      canonicalProjectPath: analysis.canonicalProjectPath,
      effectiveCwd: analysis.effectiveCwd,
      targetPaths: [...analysis.targetPaths],
      outsideProject: analysis.outsideProject,
      normalizedRule: analysis.normalizedRule,
      cacheKey,
      cacheStatus: analysis.cacheableForTask ? 'miss' : 'not_cacheable',
      cacheMissReason,
      projectRulePersistable: canPersistProjectRule(analysis),
      ...(!canPersistProjectRule(analysis)
        ? { projectRuleDisabledReason: analysis.nonReusableReason ?? (analysis.outsideProject
          ? '跨项目目录授权不能持久化为普通项目规则。'
          : '该能力的风险范围不允许项目级持久授权。') }
        : {}),
      ...(options.kind ? { kind: options.kind } : {}),
      createdAt: options.createdAt ?? this.now(),
    };

    let resolveResult: (result: PermissionResult) => void = () => undefined;
    const result = new Promise<PermissionResult>((resolve) => {
      resolveResult = resolve;
    });
    let resolveSettlement: (settlement: PermissionSettlement) => void = () => undefined;
    const settlement = new Promise<PermissionSettlement>((resolve) => {
      resolveSettlement = resolve;
    });
    const timeout = setTimeout(() => {
      this.settlePending(
        requestId,
        denyResult(payload.toolUseId, 'Permission request timed out.'),
        'timeout',
      );
    }, this.requestTimeoutMs);
    timeout.unref?.();

    this.pending.set(requestId, {
      request: permissionRequest,
      fingerprint,
      analysis,
      resolve: resolveResult,
      resolveSettlement,
      timeout,
    });

    this.requestDispatchDepth += 1;
    try {
      for (const listener of this.listeners) {
        try {
          listener({
            ...permissionRequest,
            input: structuredClone(permissionRequest.input),
            targetPaths: [...permissionRequest.targetPaths],
          });
        } catch {
          // A renderer/listener failure must not crash the broker or auto-allow.
        }
      }
    } finally {
      this.requestDispatchDepth -= 1;
      if (this.requestDispatchDepth === 0) this.flushDeferredSettlements();
    }

    return { requestId, result, settlement };
  }

  private settlePending(
    requestId: string,
    result: PermissionResult,
    cause: PermissionSettlementCause,
    appliedRule?: PermissionRule,
  ): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    clearTimeout(pending.timeout);
    pending.resolve(result);

    const settlement: PermissionSettlement = {
      requestId,
      runId: pending.request.runId,
      sessionKey: pending.request.sessionKey,
      projectPath: pending.request.projectPath,
      toolName: pending.request.toolName,
      ...(pending.request.toolUseId ? { toolUseId: pending.request.toolUseId } : {}),
      behavior: result.behavior,
      cause,
      decisionClassification: cause === 'permission_auto_allowed'
        ? 'rule_auto_allow'
        : result.decisionClassification,
      taskId: pending.request.taskId,
      ...(pending.request.workflowId ? { workflowId: pending.request.workflowId } : {}),
      ...(pending.request.processId ? { processId: pending.request.processId } : {}),
      capability: pending.request.capability,
      risk: pending.request.risk,
      canonicalProjectPath: pending.request.canonicalProjectPath,
      effectiveCwd: pending.request.effectiveCwd,
      targetPaths: [...pending.request.targetPaths],
      outsideProject: pending.request.outsideProject,
      normalizedRule: pending.request.normalizedRule,
      cacheKey: appliedRule
        ? `${appliedRule.scope}:${permissionRuleCacheKey(appliedRule)}:${pending.fingerprint.slice(0, 12)}`
        : pending.request.cacheKey,
      ...(appliedRule ? { scope: appliedRule.scope, matchedRuleId: appliedRule.id } : {}),
      ...(result.behavior === 'deny' ? { message: result.message } : {}),
      settledAt: this.now(),
    };
    pending.resolveSettlement(settlement);
    this.emitSettlement(settlement);
    return true;
  }

  private emitSettlement(settlement: PermissionSettlement): void {
    if (this.requestDispatchDepth > 0) {
      this.deferredSettlements.push({
        settlement,
        listeners: [...this.settlementListeners],
      });
      return;
    }
    this.notifySettlement(settlement, [...this.settlementListeners]);
  }

  private notifySettlement(
    settlement: PermissionSettlement,
    listeners: PermissionSettlementListener[],
  ): void {
    for (const listener of listeners) {
      try {
        listener({ ...settlement });
      } catch {
        // Settlement delivery is advisory and must not break the HTTP result.
      }
    }
  }

  private flushDeferredSettlements(): void {
    for (const { settlement, listeners } of this.deferredSettlements.splice(0)) {
      this.notifySettlement(settlement, listeners);
    }
  }

  private cleanupRun(
    runId: string,
    message: string,
    cause: Extract<PermissionSettlementCause, 'run_cancelled' | 'run_completed' | 'broker_closed'>,
  ): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.request.runId === runId) {
        this.settlePending(
          requestId,
          denyResult(pending.request.toolUseId, message),
          cause,
        );
      }
    }
    this.runs.delete(runId);
  }
}
