import type { IpcMain } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import type {
  PermissionRequest as SharedPermissionRequest,
  PermissionSettlement,
} from '../../../shared/types/permissionBroker';
import type {
  PermissionBroker,
  PermissionRequestListener,
  PermissionSettlementListener,
} from '../../permissions/PermissionBroker';
import type { AppDatabase } from '../../database/Database';
import { canonicalizeProjectPath } from '../../projects/ProjectService';

const windowMocks = vi.hoisted(() => {
  const send = vi.fn();
  const isDestroyed = vi.fn(() => false);
  return {
    send,
    isDestroyed,
    getMainWindow: vi.fn(() => ({
      isDestroyed,
      webContents: { send },
    })),
  };
});

vi.mock('../../index', () => ({
  getMainWindow: windowMocks.getMainWindow,
}));

import { registerPermissionIPC } from '../permissions';

function requestFixture(): SharedPermissionRequest {
  return {
    requestId: 'request-1',
    runId: 'run-1',
    sessionKey: 'project::session',
    projectPath: 'C:\\projects\\fixture',
    toolName: 'Read',
    toolUseId: 'tool-1',
    input: { file_path: 'README.md' },
    risk: 'low',
    createdAt: 10,
  };
}

function settlementFixture(): PermissionSettlement {
  return {
    requestId: 'request-1',
    runId: 'run-1',
    sessionKey: 'project::session',
    projectPath: 'C:\\projects\\fixture',
    toolName: 'Read',
    toolUseId: 'tool-1',
    behavior: 'allow',
    cause: 'allow_once',
    decisionClassification: 'user_temporary',
    settledAt: 20,
  };
}

function createHarness(database?: AppDatabase) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let requestListener: PermissionRequestListener | undefined;
  let settlementListener: PermissionSettlementListener | undefined;
  const unsubscribeRequests = vi.fn();
  const unsubscribeSettlements = vi.fn();
  const decide = vi.fn(() => true);
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  } as unknown as IpcMain;
  const broker = {
    decide,
    subscribe: vi.fn((listener: PermissionRequestListener) => {
      requestListener = listener;
      return unsubscribeRequests;
    }),
    subscribeSettlements: vi.fn((listener: PermissionSettlementListener) => {
      settlementListener = listener;
      return unsubscribeSettlements;
    }),
  } as unknown as PermissionBroker;

  const cleanup = registerPermissionIPC(ipcMain, broker, database);
  return {
    cleanup,
    decide,
    handlers,
    request: (value: SharedPermissionRequest) => requestListener?.(value),
    settle: (value: PermissionSettlement) => settlementListener?.(value),
    unsubscribeRequests,
    unsubscribeSettlements,
  };
}

function createPermissionDatabase() {
  const canonicalProjectPath = canonicalizeProjectPath(process.cwd()).canonicalPath;
  const project = {
    id: 'project-a',
    name: 'Project A',
    path: process.cwd(),
    created_at: '2026-08-06T00:00:00.000Z',
    last_opened_at: '2026-08-06T00:00:00.000Z',
  };
  const rule = {
    id: 'rule-a',
    project_id: project.id,
    scope: 'project' as const,
    canonical_project_path: canonicalProjectPath,
    tool_name: 'bash',
    capability: 'shell.test' as const,
    command_pattern: null,
    risk_ceiling: 'medium' as const,
    enabled: true,
    source: 'user' as const,
    created_at: 100,
    updated_at: 100,
    last_hit_at: 200,
    hit_count: 3,
  };
  return {
    project,
    rule,
    database: {
      getProject: vi.fn((projectId: string) => projectId === project.id ? project : null),
      listProjectPermissionRules: vi.fn(() => ({
        items: [rule], total: 1, limit: 25, offset: 0,
      })),
      setProjectPermissionRuleEnabled: vi.fn((_projectId, _ruleId, enabled: boolean) => ({
        ...rule, enabled, updated_at: 300,
      })),
      deleteProjectPermissionRule: vi.fn(() => true),
      clearProjectPermissionRules: vi.fn(() => 1),
      listProjectPermissionAuditEvents: vi.fn(() => ({
        items: [{
          id: 'event-a',
          session_id: 'session-a',
          event_type: 'permission_auto_allowed',
          payload_json: JSON.stringify({
            projectId: project.id,
            projectPath: canonicalProjectPath,
            toolName: 'Bash',
            capability: 'shell.test',
            riskLevel: 'medium',
            scope: 'project',
            matchedRuleId: rule.id,
          }),
          created_at: '2026-08-06T00:00:00.000Z',
        }],
        total: 1,
        limit: 25,
        offset: 0,
      })),
    } as unknown as AppDatabase,
  };
}

describe('registerPermissionIPC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    windowMocks.isDestroyed.mockReturnValue(false);
  });

  it('forwards permission requests and settlements on distinct channels', () => {
    const harness = createHarness();
    const request = requestFixture();
    const settlement = settlementFixture();

    harness.request(request);
    harness.settle(settlement);

    expect(windowMocks.send).toHaveBeenNthCalledWith(
      1,
      IPC_CHANNELS.PERMISSION_REQUEST,
      request,
    );
    expect(windowMocks.send).toHaveBeenNthCalledWith(
      2,
      IPC_CHANNELS.PERMISSION_SETTLED,
      settlement,
    );
  });

  it('unsubscribes both broker streams during cleanup', () => {
    const harness = createHarness();

    harness.cleanup();

    expect(harness.unsubscribeRequests).toHaveBeenCalledOnce();
    expect(harness.unsubscribeSettlements).toHaveBeenCalledOnce();
  });

  it('does not send either event to a destroyed window', () => {
    const harness = createHarness();
    windowMocks.isDestroyed.mockReturnValue(true);

    harness.request(requestFixture());
    harness.settle(settlementFixture());

    expect(windowMocks.send).not.toHaveBeenCalled();
  });

  it('keeps the existing decision receipt contract', async () => {
    const harness = createHarness();
    const handler = harness.handlers.get(IPC_CHANNELS.PERMISSION_DECIDE);
    expect(handler).toBeDefined();

    await expect(handler?.({}, 'request-1', 'allow_once')).resolves.toEqual({
      accepted: true,
    });
    expect(harness.decide).toHaveBeenCalledWith('request-1', 'allow_once');

    await expect(handler?.({}, 'request-2', 'allow_for_task')).resolves.toEqual({
      accepted: true,
    });
    await expect(handler?.({}, 'request-3', 'allow_for_project')).resolves.toEqual({
      accepted: true,
    });
    await expect(handler?.({}, 'request-4', 'deny')).resolves.toEqual({
      accepted: true,
    });

    await expect(handler?.({}, 'request-1', 'not-a-decision')).resolves.toMatchObject({
      accepted: false,
    });
    await expect(handler?.({}, 'request-1', 'allow_for_session')).resolves.toMatchObject({
      accepted: false,
    });
  });

  it('reports a rejected renderer allow without treating it as accepted', async () => {
    const harness = createHarness();
    const handler = harness.handlers.get(IPC_CHANNELS.PERMISSION_DECIDE);
    harness.decide.mockReturnValueOnce(false);

    await expect(handler?.({}, 'bypass-request', 'allow_once')).resolves.toMatchObject({
      accepted: false,
    });
    expect(harness.decide).toHaveBeenCalledWith('bypass-request', 'allow_once');
  });

  it('manages project rules through project-bound validated main-process IPC', async () => {
    const { database, rule } = createPermissionDatabase();
    const harness = createHarness(database);

    await expect(harness.handlers.get(IPC_CHANNELS.PERMISSION_RULES_LIST)?.(
      {}, 'project-a', { limit: 25, offset: 0 },
    )).resolves.toMatchObject({
      total: 1,
      items: [{ id: rule.id, projectId: 'project-a', capability: 'shell.test' }],
    });
    await expect(harness.handlers.get(IPC_CHANNELS.PERMISSION_RULE_SET_ENABLED)?.(
      {}, 'project-a', rule.id, false,
    )).resolves.toMatchObject({ id: rule.id, enabled: false });
    await expect(harness.handlers.get(IPC_CHANNELS.PERMISSION_RULE_DELETE)?.(
      {}, 'project-a', rule.id,
    )).resolves.toBe(true);
    await expect(harness.handlers.get(IPC_CHANNELS.PERMISSION_RULE_CLEAR)?.(
      {}, 'project-a', true,
    )).resolves.toBe(1);
  });

  it('does not let renderer paths or unconfirmed clear operations cross project identity', async () => {
    const { database, rule } = createPermissionDatabase();
    const harness = createHarness(database);

    await expect(harness.handlers.get(IPC_CHANNELS.PERMISSION_RULES_LIST)?.(
      {}, { projectId: 'project-a', projectPath: 'C:\\outside' },
    )).rejects.toThrow();
    await expect(harness.handlers.get(IPC_CHANNELS.PERMISSION_RULE_SET_ENABLED)?.(
      {}, 'project-a', rule.id, 'yes',
    )).rejects.toThrow();
    await expect(harness.handlers.get(IPC_CHANNELS.PERMISSION_RULE_CLEAR)?.(
      {}, 'project-a', false,
    )).rejects.toThrow(/confirmation/i);
    expect(database.clearProjectPermissionRules).not.toHaveBeenCalled();
  });

  it('returns redacted project-bound audit records without exposing payload JSON', async () => {
    const { database } = createPermissionDatabase();
    const harness = createHarness(database);

    const result = await harness.handlers.get(IPC_CHANNELS.PERMISSION_AUDIT_LIST)?.(
      {}, 'project-a', { limit: 25, offset: 0 },
    ) as { items: Array<Record<string, unknown>> };

    expect(result.items).toEqual([expect.objectContaining({
      id: 'event-a',
      sessionId: 'session-a',
      eventType: 'permission_auto_allowed',
      capability: 'shell.test',
      matchedRuleId: 'rule-a',
    })]);
    expect(result.items[0]).not.toHaveProperty('payload_json');
    expect(result.items[0]).not.toHaveProperty('projectPath');
  });

  it('fails closed when stored rules do not belong to the reloaded project path', async () => {
    const { database } = createPermissionDatabase();
    vi.mocked(database.listProjectPermissionRules).mockReturnValue({
      items: [{
        ...createPermissionDatabase().rule,
        canonical_project_path: canonicalizeProjectPath('C:\\outside').canonicalPath,
      }],
      total: 1,
      limit: 25,
      offset: 0,
    });
    const harness = createHarness(database);

    await expect(harness.handlers.get(IPC_CHANNELS.PERMISSION_RULES_LIST)?.(
      {}, 'project-a', { limit: 25, offset: 0 },
    )).rejects.toThrow(/project/i);
  });
});
