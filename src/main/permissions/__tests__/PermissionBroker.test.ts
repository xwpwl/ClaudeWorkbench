import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import {
  PermissionBroker,
  classifyPermissionRisk,
  type PermissionMcpEnvironment,
  type PermissionRequest,
  type PermissionResult,
  type PermissionSettlement,
} from '../PermissionBroker';

interface HttpResult {
  status: number;
  body: PermissionResult | { error: string };
}

const brokers: PermissionBroker[] = [];

async function createBroker(requestTimeoutMs = 5_000): Promise<PermissionBroker> {
  const broker = new PermissionBroker({ requestTimeoutMs });
  brokers.push(broker);
  await broker.start();
  return broker;
}

function registerRun(broker: PermissionBroker, runId = 'run-1'): PermissionMcpEnvironment {
  broker.registerRun({
    runId,
    sessionKey: `session-${runId}`,
    projectPath: `C:\\projects\\${runId}`,
  });
  return broker.getMcpEnvironment(runId);
}

function captureRequests(
  broker: PermissionBroker,
  expectedCount = 1,
): { requests: PermissionRequest[]; ready: Promise<PermissionRequest[]>; unsubscribe: () => void } {
  const requests: PermissionRequest[] = [];
  let resolveReady: (requests: PermissionRequest[]) => void = () => undefined;
  const ready = new Promise<PermissionRequest[]>((resolve) => {
    resolveReady = resolve;
  });
  const unsubscribe = broker.subscribe((request) => {
    requests.push(request);
    if (requests.length === expectedCount) resolveReady(requests);
  });
  return { requests, ready, unsubscribe };
}

function captureSettlements(
  broker: PermissionBroker,
  expectedCount = 1,
): {
  settlements: PermissionSettlement[];
  ready: Promise<PermissionSettlement[]>;
  unsubscribe: () => void;
} {
  const settlements: PermissionSettlement[] = [];
  let resolveReady: (settlements: PermissionSettlement[]) => void = () => undefined;
  const ready = new Promise<PermissionSettlement[]>((resolve) => {
    resolveReady = resolve;
  });
  const unsubscribe = broker.subscribeSettlements((settlement) => {
    settlements.push(settlement);
    if (settlements.length === expectedCount) resolveReady(settlements);
  });
  return { settlements, ready, unsubscribe };
}

async function postPermission(
  environment: PermissionMcpEnvironment,
  options: {
    toolName?: string;
    input?: Record<string, unknown>;
    toolUseId?: string;
    token?: string;
    runId?: string;
  } = {},
): Promise<HttpResult> {
  const body = JSON.stringify({
      runId: options.runId ?? environment.runId,
      tool_name: options.toolName ?? 'Read',
      input: options.input ?? { file_path: 'README.md' },
      tool_use_id: options.toolUseId ?? 'tool-use-1',
  });
  return new Promise<HttpResult>((resolve, reject) => {
    const request = httpRequest(environment.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.token ?? environment.token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.once('error', reject);
      response.once('end', () => {
        try {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as HttpResult['body'],
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once('error', reject);
    request.end(body);
  });
}

afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
});

describe('PermissionBroker', () => {
  it('allows bypass only through the trusted one-shot decision path', async () => {
    const broker = await createBroker();
    const requests = captureRequests(broker);
    const settlements = captureSettlements(broker);
    const authorization = broker.requestExplicitHighRisk({
      requestId: 'bypass-request-1',
      runId: 'bypass-run',
      sessionKey: 'project::session-1',
      projectPath: 'C:\\projects\\fixture',
      createdAt: 100,
      kind: 'bypass_permissions',
    });
    const [request] = await requests.ready;

    expect(request).toMatchObject({
      requestId: 'bypass-request-1',
      runId: 'bypass-run',
      sessionKey: 'project::session-1',
      projectPath: 'C:\\projects\\fixture',
      toolName: 'BypassPermissions',
      input: { permissionMode: 'bypassPermissions' },
      risk: 'high',
      kind: 'bypass_permissions',
      createdAt: 100,
    });

    expect(broker.decide(request.requestId, 'allow_once')).toBe(false);
    expect(broker.decide(request.requestId, 'allow_for_task')).toBe(false);
    expect(settlements.settlements).toHaveLength(0);
    expect(broker.decideExplicitHighRisk(request.requestId, 'allow_once')).toBe(true);
    await expect(authorization).resolves.toMatchObject({
      behavior: 'allow',
      cause: 'allow_once',
      decisionClassification: 'user_temporary',
    });
    await settlements.ready;

    expect(() => broker.registerRun({
      runId: 'bypass-run',
      sessionKey: 'project::session-1',
      projectPath: 'C:\\projects\\fixture',
    })).not.toThrow();
  });

  it('lets the renderer deny bypass without granting it', async () => {
    const broker = await createBroker();
    const requests = captureRequests(broker);
    const authorization = broker.requestExplicitHighRisk({
      requestId: 'bypass-renderer-deny',
      runId: 'bypass-renderer-deny-run',
      sessionKey: 'project::session-1',
      projectPath: 'C:\\projects\\fixture',
      createdAt: 100,
      kind: 'bypass_permissions',
    });
    const [request] = await requests.ready;

    expect(broker.decide(request.requestId, 'deny')).toBe(true);
    await expect(authorization).resolves.toMatchObject({
      behavior: 'deny',
      cause: 'deny',
    });
  });

  it('refuses to use the trusted bypass decision path for ordinary tools', async () => {
    const broker = await createBroker();
    const environment = registerRun(broker);
    const requests = captureRequests(broker);
    const responsePromise = postPermission(environment);
    const [request] = await requests.ready;

    expect(broker.decideExplicitHighRisk(request.requestId, 'allow_once')).toBe(false);
    expect(broker.decide(request.requestId, 'deny')).toBe(true);
    await responsePromise;
  });

  it('fails an explicit bypass request closed on timeout and still releases the run id', async () => {
    const broker = await createBroker(20);
    const requests = captureRequests(broker);
    const authorization = broker.requestExplicitHighRisk({
      requestId: 'bypass-timeout',
      runId: 'bypass-timeout-run',
      sessionKey: 'project::session-timeout',
      projectPath: 'C:\\projects\\fixture',
      createdAt: 200,
      kind: 'bypass_permissions',
    });
    await requests.ready;

    await expect(authorization).resolves.toMatchObject({
      behavior: 'deny',
      cause: 'timeout',
      decisionClassification: 'user_reject',
    });
    expect(() => broker.registerRun({
      runId: 'bypass-timeout-run',
      sessionKey: 'project::session-timeout',
      projectPath: 'C:\\projects\\fixture',
    })).not.toThrow();
  });

  it('rejects duplicate or malformed explicit high-risk request identities before dispatch', async () => {
    const broker = await createBroker();
    registerRun(broker, 'occupied');
    let emitted = false;
    broker.subscribe(() => { emitted = true; });

    await expect(broker.requestExplicitHighRisk({
      requestId: '',
      runId: 'new-run',
      sessionKey: 'project::session',
      projectPath: 'C:\\projects\\fixture',
      createdAt: 1,
      kind: 'bypass_permissions',
    })).rejects.toThrow('requestId');
    await expect(broker.requestExplicitHighRisk({
      requestId: 'occupied-request',
      runId: 'occupied',
      sessionKey: 'project::session',
      projectPath: 'C:\\projects\\fixture',
      createdAt: 1,
      kind: 'bypass_permissions',
    })).rejects.toThrow('already registered');
    expect(emitted).toBe(false);
  });

  it('starts on a random loopback port and returns isolated run credentials', async () => {
    const broker = await createBroker();
    const first = registerRun(broker, 'first');
    const second = registerRun(broker, 'second');

    expect(first.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/permission$/);
    expect(first.runId).toBe('first');
    expect(first.token).toHaveLength(43);
    expect(second.token).not.toBe(first.token);
    expect(first).toMatchObject({
      CLAUDE_WORKBENCH_PERMISSION_ENDPOINT: first.endpoint,
      CLAUDE_WORKBENCH_PERMISSION_TOKEN: first.token,
      CLAUDE_WORKBENCH_PERMISSION_RUN_ID: first.runId,
    });
  });

  it('allows one request without caching it', async () => {
    const broker = await createBroker();
    const environment = registerRun(broker);
    const capture = captureRequests(broker);
    const settlementCapture = captureSettlements(broker);
    const responsePromise = postPermission(environment, { toolUseId: 'allow-once' });
    const [request] = await capture.ready;

    expect(broker.decide(request.requestId, 'allow_once')).toBe(true);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      behavior: 'allow',
      updatedInput: { file_path: 'README.md' },
      toolUseID: 'allow-once',
      decisionClassification: 'user_temporary',
    });
    expect((await settlementCapture.ready)[0]).toMatchObject({
      requestId: request.requestId,
      runId: environment.runId,
      sessionKey: 'session-run-1',
      toolName: 'Read',
      toolUseId: 'allow-once',
      behavior: 'allow',
      cause: 'allow_once',
      decisionClassification: 'user_temporary',
    });
  });

  it('returns a structured denial', async () => {
    const broker = await createBroker();
    const environment = registerRun(broker);
    const capture = captureRequests(broker);
    const settlementCapture = captureSettlements(broker);
    const responsePromise = postPermission(environment, { toolUseId: 'deny-me' });
    const [request] = await capture.ready;

    broker.decide(request.requestId, 'deny');
    const response = await responsePromise;

    expect(response.body).toMatchObject({
      behavior: 'deny',
      message: 'User denied this tool request.',
      toolUseID: 'deny-me',
      decisionClassification: 'user_reject',
    });
    expect((await settlementCapture.ready)[0]).toMatchObject({
      requestId: request.requestId,
      behavior: 'deny',
      cause: 'deny',
      message: 'User denied this tool request.',
      decisionClassification: 'user_reject',
    });
  });

  it('fails closed when an untrusted caller supplies an invalid decision', async () => {
    const broker = await createBroker();
    const environment = registerRun(broker);
    const capture = captureRequests(broker);
    const settlementCapture = captureSettlements(broker);
    const responsePromise = postPermission(environment, { toolUseId: 'invalid-decision' });
    const [request] = await capture.ready;

    expect(broker.decide(request.requestId, 'unexpected' as never)).toBe(false);
    expect((await responsePromise).body).toMatchObject({
      behavior: 'deny',
      message: 'Invalid permission decision.',
      toolUseID: 'invalid-decision',
    });
    expect(broker.decide(request.requestId, 'allow_once')).toBe(false);
    expect((await settlementCapture.ready)[0]).toMatchObject({
      requestId: request.requestId,
      behavior: 'deny',
      cause: 'invalid_decision',
    });
  });

  it('caches allow_for_task for the same task and safe capability', async () => {
    const broker = await createBroker();
    const environment = registerRun(broker);
    const capture = captureRequests(broker);
    const settlementCapture = captureSettlements(broker);
    const input = { path: 'src/a.ts', options: { encoding: 'utf8' } };
    const firstResponse = postPermission(environment, { toolName: 'Read', input });
    const [request] = await capture.ready;
    broker.decide(request.requestId, 'allow_for_task');

    expect((await firstResponse).body).toMatchObject({
      behavior: 'allow',
      decisionClassification: 'user_permanent',
    });
    expect((await settlementCapture.ready)[0]).toMatchObject({
      requestId: request.requestId,
      behavior: 'allow',
      cause: 'allow_for_task',
      decisionClassification: 'user_permanent',
    });

    let additionalRequests = 0;
    const unsubscribe = broker.subscribe(() => { additionalRequests += 1; });
    const secondResponse = await postPermission(environment, {
      toolName: 'Read',
      input,
      toolUseId: 'cached-use',
    });
    unsubscribe();

    expect(additionalRequests).toBe(0);
    expect(secondResponse.body).toMatchObject({
      behavior: 'allow',
      toolUseID: 'cached-use',
      decisionClassification: 'user_permanent',
    });
  });

  it('treats object key order as the same exact JSON input', async () => {
    const broker = await createBroker();
    const environment = registerRun(broker);
    const capture = captureRequests(broker);
    const first = postPermission(environment, {
      input: { alpha: 1, nested: { beta: 2, gamma: 3 } },
    });
    const [request] = await capture.ready;
    broker.decide(request.requestId, 'allow_for_task');
    await first;

    let emitted = false;
    const unsubscribe = broker.subscribe(() => { emitted = true; });
    const result = await postPermission(environment, {
      input: { nested: { gamma: 3, beta: 2 }, alpha: 1 },
    });
    unsubscribe();

    expect(emitted).toBe(false);
    expect(result.body).toMatchObject({ behavior: 'allow' });
  });

  it('reuses a task capability allowance for a different safe input', async () => {
    const broker = await createBroker();
    const environment = registerRun(broker);
    const firstCapture = captureRequests(broker);
    const first = postPermission(environment, { input: { file_path: 'a.ts' } });
    const [firstRequest] = await firstCapture.ready;
    firstCapture.unsubscribe();
    expect(broker.decide(firstRequest.requestId, 'allow_for_task')).toBe(true);
    await first;

    let emitted = false;
    const unsubscribe = broker.subscribe(() => { emitted = true; });
    const second = await postPermission(environment, { input: { file_path: 'b.ts' } });
    unsubscribe();

    expect(emitted).toBe(false);
    expect(second.body).toMatchObject({ behavior: 'allow' });
  });

  it('never caches high-risk commands even when allow_for_task is selected', async () => {
    const broker = await createBroker();
    const environment = registerRun(broker);
    const commandInput = { command: 'git reset --hard HEAD~1' };
    const firstCapture = captureRequests(broker);
    const settlementCapture = captureSettlements(broker);
    const first = postPermission(environment, { toolName: 'Bash', input: commandInput });
    const [firstRequest] = await firstCapture.ready;
    firstCapture.unsubscribe();

    expect(firstRequest.risk).toBe('high');
    expect(broker.decide(firstRequest.requestId, 'allow_for_task')).toBe(false);
    expect(broker.decide(firstRequest.requestId, 'allow_once')).toBe(true);
    expect((await first).body).toMatchObject({
      behavior: 'allow',
      decisionClassification: 'user_temporary',
    });
    expect((await settlementCapture.ready)[0]).toMatchObject({
      requestId: firstRequest.requestId,
      behavior: 'allow',
      cause: 'allow_once',
      decisionClassification: 'user_temporary',
    });

    const secondCapture = captureRequests(broker);
    const second = postPermission(environment, { toolName: 'Bash', input: commandInput });
    const [secondRequest] = await secondCapture.ready;
    broker.decide(secondRequest.requestId, 'deny');
    expect((await second).body).toMatchObject({ behavior: 'deny' });
  });

  it('does not let a subscriber mutation downgrade internal high-risk state', async () => {
    const broker = await createBroker();
    const environment = registerRun(broker);
    const input = { command: 'rm -rf ./build' };
    let firstRequestId = '';
    const unsubscribe = broker.subscribe((request) => {
      firstRequestId = request.requestId;
      request.risk = 'low';
      request.input.command = 'npm test';
    });
    const first = postPermission(environment, { toolName: 'Bash', input });
    while (!firstRequestId) await new Promise((resolve) => setTimeout(resolve, 1));
    unsubscribe();
    expect(broker.decide(firstRequestId, 'allow_for_task')).toBe(false);
    expect(broker.decide(firstRequestId, 'allow_once')).toBe(true);

    expect((await first).body).toMatchObject({
      behavior: 'allow',
      updatedInput: input,
      decisionClassification: 'user_temporary',
    });

    const secondCapture = captureRequests(broker);
    const second = postPermission(environment, { toolName: 'Bash', input });
    const [secondRequest] = await secondCapture.ready;
    broker.decide(secondRequest.requestId, 'deny');
    expect((await second).body).toMatchObject({ behavior: 'deny' });
  });

  it('does not share task allowances across different task identities', async () => {
    const broker = await createBroker();
    const firstEnvironment = registerRun(broker, 'first');
    const secondEnvironment = registerRun(broker, 'second');
    const firstCapture = captureRequests(broker);
    const first = postPermission(firstEnvironment);
    const [firstRequest] = await firstCapture.ready;
    firstCapture.unsubscribe();
    broker.decide(firstRequest.requestId, 'allow_for_task');
    await first;

    const secondCapture = captureRequests(broker);
    const second = postPermission(secondEnvironment);
    const [secondRequest] = await secondCapture.ready;
    broker.decide(secondRequest.requestId, 'deny');

    expect(secondRequest.runId).toBe('second');
    expect((await second).body).toMatchObject({ behavior: 'deny' });
  });

  it('classifies read, network/write, and destructive command risks', () => {
    expect(classifyPermissionRisk('Read', { file_path: 'a.ts' })).toBe('low');
    expect(classifyPermissionRisk('WebFetch', { url: 'https://example.com' })).toBe('medium');
    expect(classifyPermissionRisk('Edit', { file_path: 'a.ts' })).toBe('medium');
    expect(classifyPermissionRisk('Bash', { command: 'rm -rf ./build' })).toBe('high');
    expect(classifyPermissionRisk('Cmd', { command: 'rd /q /s build' })).toBe('high');
    expect(classifyPermissionRisk('Cmd', { command: 'del /q /s build\\*' })).toBe('high');
    expect(classifyPermissionRisk('PowerShell', {
      command: 'pwsh -EncodedCommand ZABhAG4AZwBlAHIAbwB1AHMA',
    })).toBe('high');
    expect(classifyPermissionRisk('Bash', { command: 'npm test' })).toBe('medium');
  });

  it('rejects an invalid bearer token without emitting a request', async () => {
    const broker = await createBroker();
    const environment = registerRun(broker);
    let emitted = false;
    broker.subscribe(() => { emitted = true; });

    const response = await postPermission(environment, { token: 'not-the-token' });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Invalid permission broker credentials.' });
    expect(emitted).toBe(false);
  });

  it('rejects a token from another registered run', async () => {
    const broker = await createBroker();
    const first = registerRun(broker, 'first');
    const second = registerRun(broker, 'second');

    const response = await postPermission(second, { token: first.token });

    expect(response.status).toBe(401);
  });

  it('rejects an unknown run', async () => {
    const broker = await createBroker();
    const environment = registerRun(broker);

    const response = await postPermission(environment, { runId: 'missing-run' });

    expect(response.status).toBe(404);
  });

  it('denies timed-out requests and removes them from the pending map', async () => {
    const broker = await createBroker(30);
    const environment = registerRun(broker);
    const capture = captureRequests(broker);
    const settlementCapture = captureSettlements(broker);
    const responsePromise = postPermission(environment, { toolUseId: 'timeout-use' });
    const [request] = await capture.ready;
    const response = await responsePromise;

    expect(response.body).toMatchObject({
      behavior: 'deny',
      message: 'Permission request timed out.',
      toolUseID: 'timeout-use',
    });
    expect(broker.decide(request.requestId, 'allow_once')).toBe(false);
    expect((await settlementCapture.ready)[0]).toMatchObject({
      requestId: request.requestId,
      behavior: 'deny',
      cause: 'timeout',
      message: 'Permission request timed out.',
    });
  });

  it('handles concurrent requests independently', async () => {
    const broker = await createBroker();
    const environment = registerRun(broker);
    const capture = captureRequests(broker, 2);
    const first = postPermission(environment, { input: { file_path: 'a.ts' }, toolUseId: 'a' });
    const second = postPermission(environment, { input: { file_path: 'b.ts' }, toolUseId: 'b' });
    const requests = await capture.ready;

    const requestA = requests.find((request) => request.toolUseId === 'a');
    const requestB = requests.find((request) => request.toolUseId === 'b');
    expect(requestA).toBeDefined();
    expect(requestB).toBeDefined();
    broker.decide(requestB!.requestId, 'deny');
    broker.decide(requestA!.requestId, 'allow_once');

    expect((await first).body).toMatchObject({ behavior: 'allow', toolUseID: 'a' });
    expect((await second).body).toMatchObject({ behavior: 'deny', toolUseID: 'b' });
  });

  it('cancelRun denies pending requests and invalidates run credentials', async () => {
    const broker = await createBroker();
    const environment = registerRun(broker);
    const capture = captureRequests(broker);
    const settlementCapture = captureSettlements(broker);
    const responsePromise = postPermission(environment);
    const [request] = await capture.ready;

    broker.cancelRun(environment.runId);
    const response = await responsePromise;

    expect(response.body).toMatchObject({
      behavior: 'deny',
      message: 'Permission request was cancelled because the run stopped.',
    });
    expect((await settlementCapture.ready)[0]).toMatchObject({
      requestId: request.requestId,
      runId: environment.runId,
      behavior: 'deny',
      cause: 'run_cancelled',
    });
    expect(() => broker.getMcpEnvironment(environment.runId)).toThrow('Unknown permission run');
  });

  it('completeRun settles every pending request with the completed cause', async () => {
    const broker = await createBroker();
    const environment = registerRun(broker);
    const requests = captureRequests(broker, 2);
    const settlements = captureSettlements(broker, 2);
    const first = postPermission(environment, { toolUseId: 'complete-a' });
    const second = postPermission(environment, { toolUseId: 'complete-b' });
    await requests.ready;

    broker.completeRun(environment.runId);

    expect((await settlements.ready).map((item) => item.cause))
      .toEqual(['run_completed', 'run_completed']);
    expect((await Promise.all([first, second])).map((item) => item.body))
      .toEqual([
        expect.objectContaining({ behavior: 'deny' }),
        expect.objectContaining({ behavior: 'deny' }),
      ]);
  });

  it('completeTask clears task rules before a task id is reused', async () => {
    const broker = await createBroker();
    const environment = registerRun(broker);
    const firstCapture = captureRequests(broker);
    const first = postPermission(environment);
    const [request] = await firstCapture.ready;
    firstCapture.unsubscribe();
    broker.decide(request.requestId, 'allow_for_task');
    await first;
    broker.completeRun(environment.runId);
    broker.completeTask({ taskId: environment.runId, projectPath: `C:\\projects\\${environment.runId}` });

    const replacement = registerRun(broker);
    const replacementCapture = captureRequests(broker);
    const replacementResponse = postPermission(replacement);
    const [replacementRequest] = await replacementCapture.ready;
    broker.decide(replacementRequest.requestId, 'deny');

    expect(replacement.token).not.toBe(environment.token);
    expect((await replacementResponse).body).toMatchObject({ behavior: 'deny' });
  });

  it('close denies pending requests and stops accepting HTTP connections', async () => {
    const broker = await createBroker();
    const environment = registerRun(broker);
    const capture = captureRequests(broker);
    const settlementCapture = captureSettlements(broker);
    const responsePromise = postPermission(environment);
    const [request] = await capture.ready;

    await broker.close();
    expect((await responsePromise).body).toMatchObject({
      behavior: 'deny',
      message: 'Permission broker was closed.',
    });
    expect((await settlementCapture.ready)[0]).toMatchObject({
      requestId: request.requestId,
      behavior: 'deny',
      cause: 'broker_closed',
    });
    await expect(postPermission(environment)).rejects.toThrow();
  });

  it('settles a request when its HTTP requester disconnects', async () => {
    const broker = await createBroker();
    const environment = registerRun(broker);
    const requestCapture = captureRequests(broker);
    const settlementCapture = captureSettlements(broker);
    const controller = new AbortController();
    const responsePromise = fetch(environment.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${environment.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        runId: environment.runId,
        tool_name: 'Read',
        input: { file_path: 'README.md' },
        tool_use_id: 'disconnect-use',
      }),
      signal: controller.signal,
    }).catch(() => null);
    const [request] = await requestCapture.ready;

    controller.abort();

    expect((await settlementCapture.ready)[0]).toMatchObject({
      requestId: request.requestId,
      behavior: 'deny',
      cause: 'requester_disconnected',
      toolUseId: 'disconnect-use',
    });
    await responsePromise;
  });

  it('delivers request notifications before a synchronous decision settlement', async () => {
    const broker = await createBroker();
    const environment = registerRun(broker);
    const order: string[] = [];
    broker.subscribe((request) => {
      order.push('request:first');
      broker.decide(request.requestId, 'allow_once');
    });
    broker.subscribe(() => {
      order.push('request:second');
    });
    broker.subscribeSettlements(() => {
      order.push('settlement');
    });

    const response = await postPermission(environment);

    expect(response.body).toMatchObject({ behavior: 'allow' });
    expect(order).toEqual(['request:first', 'request:second', 'settlement']);
  });

  it('emits an audit settlement for a task-rule auto allowance', async () => {
    const broker = await createBroker();
    const environment = registerRun(broker);
    const requestCapture = captureRequests(broker);
    const settlementCapture = captureSettlements(broker, 2);
    const input = { file_path: 'cached.ts' };
    const first = postPermission(environment, { input });
    const [request] = await requestCapture.ready;
    broker.decide(request.requestId, 'allow_for_task');
    await first;

    expect(broker.decide(request.requestId, 'deny')).toBe(false);
    expect((await postPermission(environment, { input })).body)
      .toMatchObject({ behavior: 'allow' });
    await settlementCapture.ready;

    expect(settlementCapture.settlements).toHaveLength(2);
    expect(settlementCapture.settlements[1]).toMatchObject({
      behavior: 'allow',
      cause: 'permission_auto_allowed',
      scope: 'task',
    });
  });

  it('returns false for stale or unknown decisions', async () => {
    const broker = await createBroker();
    registerRun(broker);

    expect(broker.decide('missing-request', 'allow_once')).toBe(false);
  });

  it('rejects malformed permission payloads before emitting them', async () => {
    const broker = await createBroker();
    const environment = registerRun(broker);
    let emitted = false;
    broker.subscribe(() => { emitted = true; });

    const response = await fetch(environment.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${environment.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ runId: environment.runId, tool_name: 'Read', input: [] }),
    });

    expect(response.status).toBe(400);
    expect(emitted).toBe(false);
  });

  it('rejects non-POST HTTP methods', async () => {
    const broker = await createBroker();
    const environment = registerRun(broker);

    const response = await fetch(environment.endpoint);

    expect(response.status).toBe(405);
  });
});
