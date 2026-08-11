import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import { resolve } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionBroker, type PermissionRequest } from '../PermissionBroker';
import {
  PERMISSION_MCP_TOOL_NAME,
  handlePermissionMcpMessage,
  type JsonRpcResponse,
  type PermissionMcpHelperConfig,
} from '../PermissionMcpHelper';

const config: PermissionMcpHelperConfig = {
  endpoint: 'http://127.0.0.1:43210/permission',
  token: 'test-token',
  runId: 'test-run',
};

const brokers: PermissionBroker[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

function toolCall(id = 1, args: Record<string, unknown> = {
  tool_name: 'Read',
  input: { file_path: 'README.md' },
  tool_use_id: 'tool-1',
}): unknown {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: PERMISSION_MCP_TOOL_NAME, arguments: args },
  };
}

function parseToolText(response: JsonRpcResponse | null): Record<string, unknown> {
  expect(response).not.toBeNull();
  expect(response).not.toHaveProperty('error');
  const result = (response as { result: { content: Array<{ type: string; text: string }> } }).result;
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe('text');
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function waitForPermission(broker: PermissionBroker): Promise<PermissionRequest> {
  return new Promise((resolveRequest) => {
    const unsubscribe = broker.subscribe((request) => {
      unsubscribe();
      resolveRequest(request);
    });
  });
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (!child.killed) child.kill();
  }
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
});

describe('PermissionMcpHelper protocol', () => {
  it('implements initialize with MCP tool capability metadata', async () => {
    const response = await handlePermissionMcpMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    }, config);

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'claude-workbench-permission',
          version: '1.0.0',
        },
      },
    });
  });

  it('does not respond to initialized notifications', async () => {
    const response = await handlePermissionMcpMessage({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }, config);

    expect(response).toBeNull();
  });

  it('lists only the request_permission tool with the required schema', async () => {
    const response = await handlePermissionMcpMessage({
      jsonrpc: '2.0',
      id: 'list',
      method: 'tools/list',
      params: {},
    }, config);

    const tools = (response as {
      result: { tools: Array<{ name: string; inputSchema: { required: string[] } }> };
    }).result.tools;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('request_permission');
    expect(tools[0].inputSchema.required).toEqual(['tool_name', 'input']);
  });

  it('responds to MCP ping', async () => {
    const response = await handlePermissionMcpMessage({
      jsonrpc: '2.0',
      id: 9,
      method: 'ping',
    }, config);

    expect(response).toEqual({ jsonrpc: '2.0', id: 9, result: {} });
  });

  it('calls the broker with exact arguments and returns one JSON text block', async () => {
    const requester = vi.fn().mockResolvedValue({
      behavior: 'allow',
      updatedInput: { file_path: 'README.md' },
      toolUseID: 'tool-1',
      decisionClassification: 'user_temporary',
    });

    const response = await handlePermissionMcpMessage(toolCall(), config, requester);

    expect(requester).toHaveBeenCalledWith(config, {
      tool_name: 'Read',
      input: { file_path: 'README.md' },
      tool_use_id: 'tool-1',
    });
    expect(parseToolText(response)).toEqual({
      behavior: 'allow',
      updatedInput: { file_path: 'README.md' },
      toolUseID: 'tool-1',
      decisionClassification: 'user_temporary',
    });
  });

  it('returns broker denials as a successful MCP call with one text block', async () => {
    const response = await handlePermissionMcpMessage(
      toolCall(2),
      config,
      async () => ({
        behavior: 'deny',
        message: 'User denied this tool request.',
        toolUseID: 'tool-1',
        decisionClassification: 'user_reject',
      }),
    );

    expect(parseToolText(response)).toEqual({
      behavior: 'deny',
      message: 'User denied this tool request.',
      toolUseID: 'tool-1',
      decisionClassification: 'user_reject',
    });
  });

  it('fails closed when the broker returns an invalid permission schema', async () => {
    const response = await handlePermissionMcpMessage(
      toolCall(3),
      config,
      async () => ({ behavior: 'allow', updatedInput: [] }),
    );

    expect(parseToolText(response)).toEqual({
      behavior: 'deny',
      message: 'Permission broker returned an invalid result.',
      toolUseID: 'tool-1',
      decisionClassification: 'user_reject',
    });
  });

  it('fails closed when the broker is unavailable', async () => {
    const response = await handlePermissionMcpMessage(
      toolCall(4),
      config,
      async () => { throw new Error('connection failed'); },
    );

    expect(parseToolText(response)).toMatchObject({
      behavior: 'deny',
      message: 'Permission broker is unavailable.',
      toolUseID: 'tool-1',
    });
  });

  it('rejects the wrong MCP tool name', async () => {
    const response = await handlePermissionMcpMessage({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'some_other_tool', arguments: {} },
    }, config);

    expect(response).toMatchObject({
      id: 5,
      error: { code: -32602 },
    });
  });

  it('rejects malformed permission tool arguments without calling the broker', async () => {
    const requester = vi.fn();
    const response = await handlePermissionMcpMessage(
      toolCall(6, { tool_name: 'Read', input: [] }),
      config,
      requester,
    );

    expect(response).toMatchObject({ id: 6, error: { code: -32602 } });
    expect(requester).not.toHaveBeenCalled();
  });

  it('returns Method not found for unknown request methods', async () => {
    const response = await handlePermissionMcpMessage({
      jsonrpc: '2.0',
      id: 7,
      method: 'unknown/method',
    }, config);

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32601, message: 'Method not found' },
    });
  });

  it('returns Invalid Request for malformed JSON-RPC envelopes', async () => {
    const response = await handlePermissionMcpMessage({ id: 8, method: 'tools/list' }, config);

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request' },
    });
  });

  it('runs as an independent stdio process against the real HTTP broker', async () => {
    const broker = new PermissionBroker({ requestTimeoutMs: 2_000 });
    brokers.push(broker);
    await broker.start();
    broker.registerRun({
      runId: 'stdio-run',
      sessionKey: 'stdio-session',
      projectPath: 'C:\\projects\\stdio',
    });
    const environment = broker.getMcpEnvironment('stdio-run');
    const helperPath = resolve(
      process.cwd(),
      'src/main/permissions/PermissionMcpHelper.ts',
    );
    const child = spawn(process.execPath, ['--no-warnings', '--experimental-strip-types', helperPath], {
      env: {
        ...process.env,
        ...environment,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);

    const responses = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const responseById = new Map<string | number, (response: unknown) => void>();
    responses.on('line', (line) => {
      const response = JSON.parse(line) as { id?: string | number };
      if (response.id !== undefined) {
        responseById.get(response.id)?.(response);
        responseById.delete(response.id);
      }
    });
    const send = (message: Record<string, unknown>): Promise<unknown> => {
      const id = message.id as string | number;
      const result = new Promise<unknown>((resolveResponse) => {
        responseById.set(id, resolveResponse);
      });
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return result;
    };

    const initialized = await send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });
    expect(initialized).toMatchObject({ id: 1, result: { capabilities: { tools: {} } } });

    const permissionPromise = waitForPermission(broker);
    const toolResponsePromise = send(toolCall(2) as Record<string, unknown>);
    const permission = await permissionPromise;
    expect(permission).toMatchObject({
      runId: 'stdio-run',
      sessionKey: 'stdio-session',
      toolName: 'Read',
      toolUseId: 'tool-1',
      input: { file_path: 'README.md' },
    });
    broker.decide(permission.requestId, 'allow_once');

    const toolResponse = await toolResponsePromise as JsonRpcResponse;
    expect(parseToolText(toolResponse)).toMatchObject({
      behavior: 'allow',
      toolUseID: 'tool-1',
      decisionClassification: 'user_temporary',
    });

    child.stdin.end();
  });
});
