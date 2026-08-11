import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PermissionBroker,
  type PermissionMcpEnvironment,
  type PermissionProjectRuleStore,
  type PermissionRequest,
  type PermissionSettlement,
} from '../PermissionBroker';
import type { PermissionRule } from '../../../shared/types/permissionBroker';

const brokers: PermissionBroker[] = [];
let projectRoot: string;
let secondProjectRoot: string;

async function createBroker(projectRuleStore?: PermissionProjectRuleStore): Promise<PermissionBroker> {
  const broker = new PermissionBroker({ requestTimeoutMs: 2_000, projectRuleStore });
  await broker.start();
  brokers.push(broker);
  return broker;
}

class MemoryProjectRuleStore implements PermissionProjectRuleStore {
  readonly rules: PermissionRule[] = [];
  readonly hits: string[] = [];

  listEnabled(canonicalProjectPath: string): PermissionRule[] {
    return this.rules.filter((rule) => (
      rule.enabled && rule.canonicalProjectPath === canonicalProjectPath
    ));
  }

  create(rule: PermissionRule): PermissionRule {
    this.rules.push(structuredClone(rule));
    return structuredClone(rule);
  }

  recordHit(ruleId: string): void {
    this.hits.push(ruleId);
  }
}

function register(
  broker: PermissionBroker,
  runId: string,
  options: {
    taskId?: string;
    workflowId?: string;
    projectPath?: string;
    processId?: number;
  } = {},
): PermissionMcpEnvironment {
  broker.registerRun({
    runId,
    taskId: options.taskId ?? 'task-1',
    workflowId: options.workflowId ?? 'workflow-1',
    sessionKey: 'project::session-1',
    projectPath: options.projectPath ?? projectRoot,
  });
  if (options.processId !== undefined) broker.bindProcess(runId, options.processId);
  return broker.getMcpEnvironment(runId);
}

function captureRequests(broker: PermissionBroker) {
  const requests: PermissionRequest[] = [];
  let resolveFirst: (request: PermissionRequest) => void = () => undefined;
  const first = new Promise<PermissionRequest>((resolve) => { resolveFirst = resolve; });
  const unsubscribe = broker.subscribe((request) => {
    requests.push(request);
    if (requests.length === 1) resolveFirst(request);
  });
  return { requests, first, unsubscribe };
}

function captureSettlements(broker: PermissionBroker, count: number) {
  const settlements: PermissionSettlement[] = [];
  let resolveReady: (settlements: PermissionSettlement[]) => void = () => undefined;
  const ready = new Promise<PermissionSettlement[]>((resolve) => { resolveReady = resolve; });
  const unsubscribe = broker.subscribeSettlements((settlement) => {
    settlements.push(settlement);
    if (settlements.length === count) resolveReady(settlements);
  });
  return { settlements, ready, unsubscribe };
}

async function post(
  environment: PermissionMcpEnvironment,
  command = 'npm test',
): Promise<Record<string, unknown>> {
  const response = await fetch(environment.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${environment.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      runId: environment.runId,
      tool_name: 'Bash',
      input: { command },
      tool_use_id: `${environment.runId}-tool`,
    }),
  });
  return await response.json() as Record<string, unknown>;
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-task-permission-'));
  secondProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-task-permission-other-'));
});

afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(secondProjectRoot, { recursive: true, force: true });
});

describe('TaskPermissionContext', () => {
  it('reuses a shell.test grant across run IDs, process IDs, and Agent stages', async () => {
    const broker = await createBroker();
    const requests = captureRequests(broker);
    const settlements = captureSettlements(broker, 2);
    const coder = register(broker, 'coder-run', { processId: 101 });
    const coderResult = post(coder, 'npm test');
    const firstRequest = await requests.first;

    expect(firstRequest).toMatchObject({
      taskId: 'task-1',
      workflowId: 'workflow-1',
      processId: 101,
      capability: 'shell.test',
      outsideProject: false,
    });
    expect(broker.decide(firstRequest.requestId, 'allow_for_task')).toBe(true);
    expect(await coderResult).toMatchObject({ behavior: 'allow' });
    broker.completeRun('coder-run');

    const tester = register(broker, 'tester-run', { processId: 202 });
    const testerResult = await post(tester, 'npx vitest run');

    expect(testerResult).toMatchObject({ behavior: 'allow' });
    expect(requests.requests).toHaveLength(1);
    const allSettlements = await settlements.ready;
    expect(allSettlements[1]).toMatchObject({
      runId: 'tester-run',
      taskId: 'task-1',
      workflowId: 'workflow-1',
      processId: 202,
      behavior: 'allow',
      cause: 'permission_auto_allowed',
      scope: 'task',
      capability: 'shell.test',
    });
  });

  it('auto-settles an already pending duplicate after the first task grant', async () => {
    const broker = await createBroker();
    const requests = captureRequests(broker);
    const settlements = captureSettlements(broker, 2);
    const run = register(broker, 'concurrent-test-run', { processId: 303 });

    const firstResult = post(run, 'npm test');
    const secondResult = post(run, 'npm run test');
    await requests.first;
    while (requests.requests.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));

    expect(broker.decide(requests.requests[0].requestId, 'allow_for_task')).toBe(true);
    await expect(Promise.all([firstResult, secondResult])).resolves.toEqual([
      expect.objectContaining({ behavior: 'allow' }),
      expect.objectContaining({ behavior: 'allow' }),
    ]);
    const results = await settlements.ready;
    expect(results).toEqual([
      expect.objectContaining({ cause: 'allow_for_task', scope: 'task' }),
      expect.objectContaining({
        cause: 'permission_auto_allowed',
        decisionClassification: 'rule_auto_allow',
        scope: 'task',
        capability: 'shell.test',
      }),
    ]);
    expect(results[1].matchedRuleId).toBe(results[0].matchedRuleId);
  });

  it('does not auto-settle a pending capability escalation when granting shell.test', async () => {
    const broker = await createBroker();
    const requests = captureRequests(broker);
    const run = register(broker, 'concurrent-escalation-run');

    const testResult = post(run, 'npm test');
    const installResult = post(run, 'npm install lodash');
    await requests.first;
    while (requests.requests.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    const testRequest = requests.requests.find((request) => request.capability === 'shell.test');
    const installRequest = requests.requests.find((request) => request.capability === 'shell.package_install');
    expect(testRequest).toBeDefined();
    expect(installRequest).toBeDefined();

    expect(broker.decide(testRequest!.requestId, 'allow_for_task')).toBe(true);
    await expect(testResult).resolves.toMatchObject({ behavior: 'allow' });
    expect(broker.decide(installRequest!.requestId, 'deny')).toBe(true);
    await expect(installResult).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('does not leak a task rule into a new task', async () => {
    const broker = await createBroker();
    const firstCapture = captureRequests(broker);
    const firstRun = register(broker, 'task-a-run', { taskId: 'task-a' });
    const firstResult = post(firstRun);
    const first = await firstCapture.first;
    broker.decide(first.requestId, 'allow_for_task');
    await firstResult;
    firstCapture.unsubscribe();

    const secondCapture = captureRequests(broker);
    const secondRun = register(broker, 'task-b-run', { taskId: 'task-b' });
    const secondResult = post(secondRun);
    const second = await secondCapture.first;
    broker.decide(second.requestId, 'deny');

    expect(second.taskId).toBe('task-b');
    expect(await secondResult).toMatchObject({ behavior: 'deny' });
  });

  it('clears task rules only at task terminal state, not stage completion', async () => {
    const broker = await createBroker();
    const firstCapture = captureRequests(broker);
    const coder = register(broker, 'terminal-coder');
    const firstResult = post(coder);
    const first = await firstCapture.first;
    broker.decide(first.requestId, 'allow_for_task');
    await firstResult;
    broker.completeRun('terminal-coder');
    firstCapture.unsubscribe();

    broker.completeTask({ taskId: 'task-1', workflowId: 'workflow-1', projectPath: projectRoot });
    const secondCapture = captureRequests(broker);
    const reviewer = register(broker, 'terminal-reviewer');
    const secondResult = post(reviewer);
    const second = await secondCapture.first;
    broker.decide(second.requestId, 'deny');

    expect(await secondResult).toMatchObject({ behavior: 'deny' });
  });

  it('does not let shell.test authorize package installation or destructive commands', async () => {
    const broker = await createBroker();
    const capture = captureRequests(broker);
    const run = register(broker, 'risk-run');
    const firstResult = post(run, 'npm test');
    const first = await capture.first;
    broker.decide(first.requestId, 'allow_for_task');
    await firstResult;
    capture.unsubscribe();

    const escalationCapture = captureRequests(broker);
    const installResult = post(run, 'npm install lodash');
    const install = await escalationCapture.first;
    expect(install.capability).toBe('shell.package_install');
    broker.decide(install.requestId, 'deny');
    await installResult;
    escalationCapture.unsubscribe();

    const destructiveCapture = captureRequests(broker);
    const destructiveResult = post(run, 'git reset --hard HEAD~1');
    const destructive = await destructiveCapture.first;
    expect(destructive).toMatchObject({ capability: 'shell.destructive', risk: 'high' });
    expect(broker.decide(destructive.requestId, 'allow_for_task')).toBe(false);
    expect(broker.decide(destructive.requestId, 'allow_once')).toBe(true);
    expect(await destructiveResult).toMatchObject({ behavior: 'allow' });
    expect(destructiveCapture.requests).toHaveLength(1);
  });

  it('isolates task rules by canonical project root', async () => {
    const broker = await createBroker();
    const firstCapture = captureRequests(broker);
    const projectA = register(broker, 'project-a-run');
    const firstResult = post(projectA);
    const first = await firstCapture.first;
    broker.decide(first.requestId, 'allow_for_task');
    await firstResult;
    firstCapture.unsubscribe();

    const secondCapture = captureRequests(broker);
    const projectB = register(broker, 'project-b-run', { projectPath: secondProjectRoot });
    const secondResult = post(projectB);
    const second = await secondCapture.first;
    broker.decide(second.requestId, 'deny');

    expect(second.projectPath).toBe(secondProjectRoot);
    expect(await secondResult).toMatchObject({ behavior: 'deny' });
  });

  it('scopes an external-root grant to only the explicitly requested root', async () => {
    const broker = await createBroker();
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-external-grant-'));
    const third = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-external-third-'));
    try {
      const requests = captureRequests(broker);
      const run = register(broker, 'external-run');
      const firstResult = post(run, `cd "${external}" && npm test`);
      const first = await requests.first;
      expect(first.outsideProject).toBe(true);
      broker.decide(first.requestId, 'allow_for_task');
      await firstResult;
      requests.unsubscribe();

      const sameRoot = await post(run, `cd "${external}" && npm run test`);
      expect(sameRoot).toMatchObject({ behavior: 'allow' });

      const thirdCapture = captureRequests(broker);
      const thirdResult = post(run, `cd "${third}" && npm test`);
      const thirdRequest = await thirdCapture.first;
      broker.decide(thirdRequest.requestId, 'deny');
      expect(await thirdResult).toMatchObject({ behavior: 'deny' });
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
      fs.rmSync(third, { recursive: true, force: true });
    }
  });

  it('does not restore temporary task rules after broker restart', async () => {
    const firstBroker = await createBroker();
    const firstCapture = captureRequests(firstBroker);
    const firstRun = register(firstBroker, 'before-restart');
    const firstResult = post(firstRun);
    const first = await firstCapture.first;
    firstBroker.decide(first.requestId, 'allow_for_task');
    await firstResult;
    await firstBroker.close();
    brokers.splice(brokers.indexOf(firstBroker), 1);

    const secondBroker = await createBroker();
    const secondCapture = captureRequests(secondBroker);
    const secondRun = register(secondBroker, 'after-restart');
    const secondResult = post(secondRun);
    const second = await secondCapture.first;
    secondBroker.decide(second.requestId, 'deny');

    expect(await secondResult).toMatchObject({ behavior: 'deny' });
  });

  it('persists an explicitly safe project rule across broker restart and audits hits', async () => {
    const store = new MemoryProjectRuleStore();
    const firstBroker = await createBroker(store);
    const firstCapture = captureRequests(firstBroker);
    const firstRun = register(firstBroker, 'project-rule-before', { taskId: 'project-task-a' });
    const firstResult = post(firstRun, 'npm test');
    const first = await firstCapture.first;
    expect(first.projectRulePersistable).toBe(true);
    firstBroker.decide(first.requestId, 'allow_for_project');
    expect(await firstResult).toMatchObject({ behavior: 'allow' });
    expect(store.rules).toHaveLength(1);
    await firstBroker.close();
    brokers.splice(brokers.indexOf(firstBroker), 1);

    const secondBroker = await createBroker(store);
    const requests = captureRequests(secondBroker);
    const settlements = captureSettlements(secondBroker, 1);
    const secondRun = register(secondBroker, 'project-rule-after', { taskId: 'project-task-b' });
    expect(await post(secondRun, 'npx vitest run')).toMatchObject({ behavior: 'allow' });
    expect(requests.requests).toHaveLength(0);
    expect((await settlements.ready)[0]).toMatchObject({
      cause: 'permission_auto_allowed',
      scope: 'project',
      matchedRuleId: store.rules[0].id,
    });
    expect(store.hits).toEqual([store.rules[0].id]);
  });

  it('refuses to persist a high-risk project rule and asks again', async () => {
    const store = new MemoryProjectRuleStore();
    const broker = await createBroker(store);
    const firstCapture = captureRequests(broker);
    const run = register(broker, 'unsafe-project-rule');
    const firstResult = post(run, 'git reset --hard HEAD~1');
    const first = await firstCapture.first;
    expect(first.projectRulePersistable).toBe(false);
    expect(broker.decide(first.requestId, 'allow_for_project')).toBe(false);
    expect(broker.decide(first.requestId, 'allow_once')).toBe(true);
    expect(await firstResult).toMatchObject({ behavior: 'allow' });
    expect(store.rules).toHaveLength(0);
    firstCapture.unsubscribe();

    const secondCapture = captureRequests(broker);
    const secondResult = post(run, 'git reset --hard HEAD~1');
    const second = await secondCapture.first;
    broker.decide(second.requestId, 'deny');
    expect(await secondResult).toMatchObject({ behavior: 'deny' });
  });
});
