import * as http from 'http';
import { createInterface } from 'readline';

export const PERMISSION_MCP_TOOL_NAME = 'request_permission';
export const PERMISSION_ENDPOINT_ENV = 'CLAUDE_WORKBENCH_PERMISSION_ENDPOINT';
export const PERMISSION_TOKEN_ENV = 'CLAUDE_WORKBENCH_PERMISSION_TOKEN';
export const PERMISSION_RUN_ID_ENV = 'CLAUDE_WORKBENCH_PERMISSION_RUN_ID';

export interface PermissionMcpHelperConfig {
  endpoint: string;
  token: string;
  runId: string;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface PermissionMcpToolArguments {
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id?: string;
}

export type BrokerRequester = (
  config: PermissionMcpHelperConfig,
  args: PermissionMcpToolArguments,
) => Promise<unknown>;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: string | number | null;
  error: {
    code: number;
    message: string;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

interface SafePermissionAllowResult {
  behavior: 'allow';
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: unknown[];
  toolUseID?: string;
  decisionClassification?: 'user_temporary' | 'user_permanent';
}

interface SafePermissionDenyResult {
  behavior: 'deny';
  message: string;
  interrupt?: boolean;
  toolUseID?: string;
  decisionClassification?: 'user_reject';
}

type SafePermissionResult = SafePermissionAllowResult | SafePermissionDenyResult;

const DEFAULT_HELPER_TIMEOUT_MS = 5 * 60 * 1000 + 10_000;
const MAX_BROKER_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

const PERMISSION_TOOL_DEFINITION = {
  name: PERMISSION_MCP_TOOL_NAME,
  description: 'Ask the Claude Workbench user whether a Claude Code tool may run.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: {
        type: 'string',
        description: 'The Claude Code tool requesting permission.',
      },
      input: {
        type: 'object',
        description: 'The exact input that Claude Code intends to pass to the tool.',
        additionalProperties: true,
      },
      tool_use_id: {
        type: 'string',
        description: 'The tool use identifier, when supplied by Claude Code.',
      },
    },
    required: ['tool_name', 'input'],
    additionalProperties: false,
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function success(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

function failure(id: string | number | null, code: number, message: string): JsonRpcFailure {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function safeDeny(toolUseId: string | undefined, message: string): SafePermissionDenyResult {
  return {
    behavior: 'deny',
    message,
    ...(toolUseId ? { toolUseID: toolUseId } : {}),
    decisionClassification: 'user_reject',
  };
}

function normalizePermissionResult(
  value: unknown,
  fallbackToolUseId: string | undefined,
): SafePermissionResult | null {
  if (!isRecord(value)) return null;

  if (value.behavior === 'allow') {
    if (value.updatedInput !== undefined && !isRecord(value.updatedInput)) return null;
    if (value.updatedPermissions !== undefined && !Array.isArray(value.updatedPermissions)) return null;
    if (value.toolUseID !== undefined && typeof value.toolUseID !== 'string') return null;
    if (
      value.decisionClassification !== undefined
      && value.decisionClassification !== 'user_temporary'
      && value.decisionClassification !== 'user_permanent'
    ) {
      return null;
    }

    return {
      behavior: 'allow',
      ...(value.updatedInput ? { updatedInput: value.updatedInput } : {}),
      ...(value.updatedPermissions ? { updatedPermissions: value.updatedPermissions } : {}),
      ...(
        typeof value.toolUseID === 'string'
          ? { toolUseID: value.toolUseID }
          : fallbackToolUseId
            ? { toolUseID: fallbackToolUseId }
            : {}
      ),
      ...(
        value.decisionClassification === 'user_temporary'
        || value.decisionClassification === 'user_permanent'
          ? { decisionClassification: value.decisionClassification }
          : {}
      ),
    };
  }

  if (value.behavior === 'deny') {
    if (typeof value.message !== 'string') return null;
    if (value.interrupt !== undefined && typeof value.interrupt !== 'boolean') return null;
    if (value.toolUseID !== undefined && typeof value.toolUseID !== 'string') return null;
    if (
      value.decisionClassification !== undefined
      && value.decisionClassification !== 'user_reject'
    ) {
      return null;
    }

    return {
      behavior: 'deny',
      message: value.message,
      ...(typeof value.interrupt === 'boolean' ? { interrupt: value.interrupt } : {}),
      ...(
        typeof value.toolUseID === 'string'
          ? { toolUseID: value.toolUseID }
          : fallbackToolUseId
            ? { toolUseID: fallbackToolUseId }
            : {}
      ),
      ...(value.decisionClassification === 'user_reject'
        ? { decisionClassification: 'user_reject' as const }
        : {}),
    };
  }

  return null;
}

function parseToolArguments(params: unknown): PermissionMcpToolArguments | null {
  if (!isRecord(params) || params.name !== PERMISSION_MCP_TOOL_NAME || !isRecord(params.arguments)) {
    return null;
  }

  const args = params.arguments;
  if (typeof args.tool_name !== 'string' || args.tool_name.trim().length === 0) return null;
  if (!isRecord(args.input)) return null;
  if (args.tool_use_id !== undefined && typeof args.tool_use_id !== 'string') return null;

  return {
    tool_name: args.tool_name,
    input: args.input,
    ...(typeof args.tool_use_id === 'string' ? { tool_use_id: args.tool_use_id } : {}),
  };
}

function permissionToolResult(result: SafePermissionResult): unknown {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    isError: false,
  };
}

function parseJsonRpcRequest(message: unknown): JsonRpcRequest | null {
  if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return null;
  }
  if (
    message.id !== undefined
    && message.id !== null
    && typeof message.id !== 'string'
    && typeof message.id !== 'number'
  ) {
    return null;
  }
  return message as unknown as JsonRpcRequest;
}

function isLoopbackBrokerUrl(endpoint: string): URL | null {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return null;
    return url;
  } catch {
    return null;
  }
}

export const requestPermissionFromBroker: BrokerRequester = async (config, args) => {
  const url = isLoopbackBrokerUrl(config.endpoint);
  if (!url) {
    throw new Error('Permission broker endpoint must use loopback HTTP.');
  }

  const body = JSON.stringify({
    runId: config.runId,
    tool_name: args.tool_name,
    input: args.input,
    ...(args.tool_use_id ? { tool_use_id: args.tool_use_id } : {}),
  });

  return new Promise<unknown>((resolve, reject) => {
    let responseBytes = 0;
    const responseChunks: Buffer[] = [];
    let settled = false;

    const finishReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const request = http.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (response) => {
      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        responseBytes += buffer.length;
        if (responseBytes > MAX_BROKER_RESPONSE_BYTES) {
          response.destroy(new Error('Permission broker response is too large.'));
          return;
        }
        responseChunks.push(buffer);
      });
      response.once('error', finishReject);
      response.once('end', () => {
        if (settled) return;
        if (response.statusCode !== 200) {
          finishReject(new Error('Permission broker rejected the request.'));
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(responseChunks).toString('utf8')) as unknown;
          settled = true;
          resolve(parsed);
        } catch {
          finishReject(new Error('Permission broker returned invalid JSON.'));
        }
      });
    });

    const timeout = config.requestTimeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS;
    request.setTimeout(timeout, () => {
      request.destroy(new Error('Permission broker request timed out.'));
    });
    request.once('error', finishReject);

    const onAbort = (): void => {
      request.destroy(new Error('Permission MCP helper stopped.'));
    };
    if (config.signal?.aborted) {
      onAbort();
      return;
    }
    config.signal?.addEventListener('abort', onAbort, { once: true });
    request.once('close', () => {
      config.signal?.removeEventListener('abort', onAbort);
    });

    request.end(body);
  });
};

export async function handlePermissionMcpMessage(
  message: unknown,
  config: PermissionMcpHelperConfig,
  requestBroker: BrokerRequester = requestPermissionFromBroker,
): Promise<JsonRpcResponse | null> {
  const request = parseJsonRpcRequest(message);
  if (!request) return failure(null, -32600, 'Invalid Request');

  const hasId = hasOwn(request, 'id');
  const id = request.id ?? null;

  if (request.method === 'notifications/initialized') {
    return null;
  }

  if (!hasId) {
    return null;
  }

  switch (request.method) {
    case 'initialize': {
      const params = isRecord(request.params) ? request.params : {};
      const protocolVersion = typeof params.protocolVersion === 'string'
        ? params.protocolVersion
        : DEFAULT_PROTOCOL_VERSION;
      return success(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: {
          name: 'claude-workbench-permission',
          version: '1.0.0',
        },
      });
    }

    case 'ping':
      return success(id, {});

    case 'tools/list':
      return success(id, { tools: [PERMISSION_TOOL_DEFINITION] });

    case 'tools/call': {
      const args = parseToolArguments(request.params);
      if (!args) return failure(id, -32602, 'Invalid permission tool arguments');

      let permissionResult: SafePermissionResult;
      try {
        const brokerResult = await requestBroker(config, args);
        permissionResult = normalizePermissionResult(brokerResult, args.tool_use_id)
          ?? safeDeny(args.tool_use_id, 'Permission broker returned an invalid result.');
      } catch {
        permissionResult = safeDeny(args.tool_use_id, 'Permission broker is unavailable.');
      }
      return success(id, permissionToolResult(permissionResult));
    }

    default:
      return failure(id, -32601, 'Method not found');
  }
}

function configFromEnvironment(): PermissionMcpHelperConfig | null {
  const endpoint = process.env[PERMISSION_ENDPOINT_ENV];
  const token = process.env[PERMISSION_TOKEN_ENV];
  const runId = process.env[PERMISSION_RUN_ID_ENV];
  if (!endpoint || !token || !runId) return null;
  return { endpoint, token, runId };
}

export async function runPermissionMcpHelper(
  config: PermissionMcpHelperConfig,
): Promise<void> {
  const controller = new AbortController();
  const effectiveConfig = { ...config, signal: config.signal ?? controller.signal };
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const inFlight = new Set<Promise<void>>();

  const writeResponse = (response: JsonRpcResponse): void => {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  };

  for await (const line of lines) {
    if (!line.trim()) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      writeResponse(failure(null, -32700, 'Parse error'));
      continue;
    }

    const task = handlePermissionMcpMessage(parsed, effectiveConfig)
      .then((response) => {
        if (response) writeResponse(response);
      })
      .catch(() => {
        const request = parseJsonRpcRequest(parsed);
        if (request && hasOwn(request, 'id')) {
          writeResponse(failure(request.id ?? null, -32603, 'Internal error'));
        }
      })
      .finally(() => {
        inFlight.delete(task);
      });
    inFlight.add(task);
  }

  controller.abort();
  await Promise.allSettled([...inFlight]);
}

function isDirectExecution(): boolean {
  const scriptPath = process.argv[1];
  return Boolean(scriptPath && /(?:PermissionMcpHelper|permission-mcp)\.(?:ts|js|cjs|mjs)$/i.test(scriptPath));
}

if (isDirectExecution()) {
  const config = configFromEnvironment();
  if (!config) {
    process.stderr.write('Permission MCP helper configuration is incomplete.\n');
    process.exitCode = 1;
  } else {
    void runPermissionMcpHelper(config).catch(() => {
      process.stderr.write('Permission MCP helper stopped unexpectedly.\n');
      process.exitCode = 1;
    });
  }
}
