import { describe, expect, it, vi } from 'vitest';
import type { PermissionSettlement } from '../../../shared/types/permissionBroker';
import { PermissionAudit } from '../PermissionAudit';

function settlement(
  patch: Partial<PermissionSettlement> = {},
): PermissionSettlement {
  return {
    requestId: 'audit-1',
    runId: 'run-1',
    sessionKey: 'registered::session-1',
    projectPath: 'C:\\registered-project',
    toolName: 'BypassPermissions',
    behavior: 'allow',
    cause: 'allow_once',
    decisionClassification: 'user_temporary',
    settledAt: 2_000,
    ...patch,
  };
}

function harness(options: {
  failAtWrite?: number;
  outcome?: PermissionSettlement;
  confirmed?: boolean;
  confirmationError?: Error;
  trustedDecisionAccepted?: boolean;
} = {}) {
  const events: Array<{
    id: string;
    sessionId: string;
    eventType: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }> = [];
  let writes = 0;
  const database = {
    getSession: vi.fn((id: string) => id === 'session-1'
      ? { id, project_id: 'project-1' }
      : null),
    getProject: vi.fn((id: string) => id === 'project-1'
      ? { id, path: 'C:\\registered-project' }
      : null),
    getTask: vi.fn((id: string) => id === 'session-1'
      ? { id: 'task-1', session_id: id, project_id: 'project-1' }
      : null),
    createEventIfAbsent: vi.fn((
      id: string,
      sessionId: string,
      eventType: string,
      payloadJson: string,
      createdAt: string,
    ) => {
      writes += 1;
      if (options.failAtWrite === writes) throw new Error(`audit write ${writes} failed`);
      events.push({
        id,
        sessionId,
        eventType,
        payload: JSON.parse(payloadJson) as Record<string, unknown>,
        createdAt,
      });
      return true;
    }),
  };
  const broker = {
    requestExplicitHighRisk: vi.fn(async () => options.outcome ?? settlement()),
    decideExplicitHighRisk: vi.fn(() => options.trustedDecisionAccepted ?? true),
  };
  const confirmExplicitHighRisk = vi.fn(async () => {
    if (options.confirmationError) throw options.confirmationError;
    return options.confirmed ?? true;
  });
  const audit = new PermissionAudit(database, broker, {
    now: () => 1_000,
    randomId: () => 'audit-1',
    confirmExplicitHighRisk,
  });
  return { audit, broker, confirmExplicitHighRisk, database, events };
}

describe('PermissionAudit', () => {
  it('persists a redacted audit event for an automatic task-rule hit', () => {
    const test = harness();

    test.audit.recordAutoAllowed(settlement({
      requestId: 'auto-hit-1',
      cause: 'permission_auto_allowed',
      decisionClassification: 'rule_auto_allow',
      taskId: 'task-1',
      workflowId: 'workflow-1',
      processId: 321,
      capability: 'shell.test',
      risk: 'medium',
      canonicalProjectPath: 'c:\\registered-project',
      effectiveCwd: 'C:\\registered-project',
      targetPaths: ['C:\\registered-project\\test'],
      outsideProject: false,
      normalizedRule: 'tool=bash;capability=shell.test',
      cacheKey: 'task:rule-hash',
      scope: 'task',
      matchedRuleId: 'rule-1',
      toolName: 'Bash',
    }));

    expect(test.events).toHaveLength(1);
    expect(test.events[0]).toMatchObject({
      id: 'permission-audit:auto:auto-hit-1',
      sessionId: 'session-1',
      eventType: 'permission_auto_allowed',
      payload: {
        requestId: 'auto-hit-1',
        projectId: 'project-1',
        taskId: 'task-1',
        workflowId: 'workflow-1',
        runId: 'run-1',
        processId: 321,
        toolName: 'Bash',
        capability: 'shell.test',
        riskLevel: 'medium',
        scope: 'task',
        matchedRuleId: 'rule-1',
      },
    });
    const persisted = JSON.stringify(test.events);
    expect(persisted).not.toContain('targetPaths');
    expect(persisted).not.toContain('normalizedRule');
    expect(persisted).not.toContain('cacheKey');
    expect(persisted).not.toContain('input');
  });

  it('persists a redacted request before broker dispatch and a complete decision before allowing', async () => {
    const test = harness();
    test.broker.requestExplicitHighRisk.mockImplementationOnce(async (request) => {
      expect(test.events).toHaveLength(1);
      expect(test.events[0].eventType).toBe('permission_audit_requested');
      return settlement({ requestId: request.requestId, settledAt: 2_000 });
    });

    await expect(test.audit.authorizeBypass({
      runId: 'run-1',
      sessionKey: 'forged-prefix::session-1',
      projectPath: 'C:\\renderer-claimed-project',
    })).resolves.toBeUndefined();

    expect(test.broker.requestExplicitHighRisk).toHaveBeenCalledWith({
      requestId: 'audit-1',
      runId: 'run-1',
      sessionKey: 'c:/registered-project::session-1',
      projectPath: 'C:\\registered-project',
      createdAt: 1_000,
      kind: 'bypass_permissions',
    });
    expect(test.confirmExplicitHighRisk).toHaveBeenCalledWith({
      auditId: 'audit-1',
      projectId: 'project-1',
      projectPath: 'C:\\registered-project',
      sessionId: 'session-1',
      taskId: 'task-1',
      runId: 'run-1',
      risk: 'high',
    });
    expect(test.broker.decideExplicitHighRisk).toHaveBeenCalledWith(
      'audit-1',
      'allow_once',
    );
    expect(test.events.map((event) => event.eventType)).toEqual([
      'permission_audit_requested',
      'permission_audit_decided',
    ]);
    expect(test.events[0].payload).toMatchObject({
      auditId: 'audit-1',
      request: 'bypassPermissions',
      risk: 'high',
      projectId: 'project-1',
      projectPath: 'C:\\registered-project',
      sessionId: 'session-1',
      taskId: 'task-1',
      runId: 'run-1',
      requestedAt: 1_000,
    });
    expect(test.events[1].payload).toMatchObject({
      decision: 'allow_once',
      behavior: 'allow',
      decidedAt: 2_000,
    });
    const persisted = JSON.stringify(test.events);
    expect(persisted).not.toContain('renderer-claimed-project');
    expect(persisted).not.toContain('prompt');
    expect(persisted).not.toContain('token');
  });

  it('does not dispatch a bypass request when request auditing fails', async () => {
    const test = harness({ failAtWrite: 1 });
    await expect(test.audit.authorizeBypass({
      runId: 'run-1',
      sessionKey: 'registered::session-1',
      projectPath: 'C:\\registered-project',
    })).rejects.toThrow('audit write 1 failed');
    expect(test.broker.requestExplicitHighRisk).not.toHaveBeenCalled();
  });

  it('does not grant an allowed bypass when decision auditing fails', async () => {
    const test = harness({ failAtWrite: 2 });
    await expect(test.audit.authorizeBypass({
      runId: 'run-1',
      sessionKey: 'registered::session-1',
      projectPath: 'C:\\registered-project',
    })).rejects.toThrow('audit write 2 failed');
    expect(test.broker.requestExplicitHighRisk).toHaveBeenCalledOnce();
  });

  it('persists denials and refuses authorization', async () => {
    const test = harness({
      confirmed: false,
      outcome: settlement({
        behavior: 'deny',
        cause: 'deny',
        decisionClassification: 'user_reject',
        message: 'User denied this tool request.',
      }),
    });
    await expect(test.audit.authorizeBypass({
      runId: 'run-1',
      sessionKey: 'registered::session-1',
      projectPath: 'C:\\registered-project',
    })).rejects.toThrow('not explicitly authorized');
    expect(test.events[1].payload).toMatchObject({ decision: 'deny', behavior: 'deny' });
    expect(test.broker.decideExplicitHighRisk).toHaveBeenCalledWith('audit-1', 'deny');
  });

  it('fails closed and audits the decision when native confirmation throws', async () => {
    const test = harness({
      confirmationError: new Error('native dialog failed'),
      outcome: settlement({
        behavior: 'deny',
        cause: 'deny',
        decisionClassification: 'user_reject',
      }),
    });

    await expect(test.audit.authorizeBypass({
      runId: 'run-1',
      sessionKey: 'registered::session-1',
      projectPath: 'C:\\registered-project',
    })).rejects.toThrow('Native bypass confirmation failed');
    expect(test.broker.decideExplicitHighRisk).toHaveBeenCalledWith('audit-1', 'deny');
    expect(test.events.map((event) => event.eventType)).toEqual([
      'permission_audit_requested',
      'permission_audit_decided',
    ]);
    expect(test.events[1].payload).toMatchObject({
      behavior: 'deny',
      decision: 'native_confirmation_error',
    });
  });

  it('fails closed when the broker rejects the trusted decision', async () => {
    const test = harness({ trustedDecisionAccepted: false });
    await expect(test.audit.authorizeBypass({
      runId: 'run-1',
      sessionKey: 'registered::session-1',
      projectPath: 'C:\\registered-project',
    })).rejects.toThrow('trusted bypass decision was rejected');
    expect(test.events[1].payload).toMatchObject({
      decision: 'trusted_decision_rejected',
    });
  });

  it('fails closed before auditing when the registered task identity is missing', async () => {
    const test = harness();
    await expect(test.audit.authorizeBypass({
      runId: 'run-1',
      sessionKey: 'registered::missing',
      projectPath: 'C:\\registered-project',
    })).rejects.toThrow('registered session, task, and project');
    expect(test.database.createEventIfAbsent).not.toHaveBeenCalled();
    expect(test.broker.requestExplicitHighRisk).not.toHaveBeenCalled();
  });
});
