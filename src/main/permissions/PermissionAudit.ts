import { randomUUID } from 'node:crypto';
import { canonicalProjectKey } from '../../shared/sessionIdentity';
import type {
  ExplicitHighRiskPermissionRequest,
  PermissionSettlement,
} from '../../shared/types/permissionBroker';
import type { ExplicitHighRiskDecision } from './PermissionBroker';

interface PermissionAuditSession {
  id: string;
  project_id: string;
}

interface PermissionAuditProject {
  id: string;
  path: string;
}

interface PermissionAuditTask {
  id: string;
  session_id: string;
  project_id: string;
}

export interface PermissionAuditDatabase {
  getSession(sessionId: string): PermissionAuditSession | null;
  getProject(projectId: string): PermissionAuditProject | null;
  getTask(sessionId: string): PermissionAuditTask | null;
  createEventIfAbsent(
    id: string,
    sessionId: string,
    eventType: string,
    payloadJson: string,
    createdAt?: string,
  ): boolean;
}

export interface PermissionAuditBroker {
  requestExplicitHighRisk(
    request: ExplicitHighRiskPermissionRequest,
  ): Promise<PermissionSettlement>;
  decideExplicitHighRisk(requestId: string, decision: ExplicitHighRiskDecision): boolean;
}

export interface PermissionAuditOptions {
  now?: () => number;
  randomId?: () => string;
  confirmExplicitHighRisk?: (
    request: BypassNativeConfirmationRequest,
  ) => Promise<boolean>;
}

export interface BypassAuthorizationRequest {
  runId: string;
  sessionKey: string;
  projectPath: string;
}

interface PermissionAuditIdentity {
  projectId: string;
  projectPath: string;
  sessionId: string;
  taskId: string;
}

export interface BypassNativeConfirmationRequest extends PermissionAuditIdentity {
  auditId: string;
  runId: string;
  risk: 'high';
}

function sessionIdFromKey(sessionKey: string): string | null {
  const separator = sessionKey.lastIndexOf('::');
  if (separator < 0 || separator === sessionKey.length - 2) return null;
  const sessionId = sessionKey.slice(separator + 2).trim();
  return sessionId || null;
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

/**
 * Durable audit boundary for bypassPermissions authorization.
 *
 * Request and decision records are append-only task events. They intentionally
 * contain only identity and decision metadata: prompts, tool inputs, bearer
 * tokens, and other model transport data are never persisted here.
 */
export class PermissionAudit {
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly confirmExplicitHighRisk: (
    request: BypassNativeConfirmationRequest,
  ) => Promise<boolean>;

  constructor(
    private readonly database: PermissionAuditDatabase,
    private readonly broker: PermissionAuditBroker,
    options: PermissionAuditOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? randomUUID;
    // Missing native confirmation wiring must never degrade into an allow.
    this.confirmExplicitHighRisk = options.confirmExplicitHighRisk ?? (async () => false);
  }

  async authorizeBypass(request: BypassAuthorizationRequest): Promise<void> {
    const identity = this.registeredIdentity(request.sessionKey);
    const auditId = this.randomId();
    const requestedAt = this.now();
    const basePayload = {
      auditId,
      request: 'bypassPermissions',
      risk: 'high',
      projectId: identity.projectId,
      projectPath: identity.projectPath,
      sessionId: identity.sessionId,
      taskId: identity.taskId,
      runId: request.runId,
      requestedAt,
    } as const;

    this.persist(
      `permission-audit:${auditId}:requested`,
      identity.sessionId,
      'permission_audit_requested',
      basePayload,
      requestedAt,
    );

    const settlementPromise = this.broker.requestExplicitHighRisk({
      requestId: auditId,
      runId: request.runId,
      sessionKey: `${canonicalProjectKey(identity.projectPath)}::${identity.sessionId}`,
      projectPath: identity.projectPath,
      createdAt: requestedAt,
      kind: 'bypass_permissions',
    });

    let confirmed = false;
    let confirmationError: unknown;
    try {
      confirmed = await this.confirmExplicitHighRisk({
        auditId,
        runId: request.runId,
        risk: 'high',
        ...identity,
      });
    } catch (error) {
      confirmationError = error;
    }

    const trustedDecision = confirmed && !confirmationError ? 'allow_once' : 'deny';
    const decisionAccepted = this.broker.decideExplicitHighRisk(auditId, trustedDecision);

    let settlement: PermissionSettlement;
    try {
      settlement = await settlementPromise;
    } catch (error) {
      const decidedAt = this.now();
      this.persist(
        `permission-audit:${auditId}:decided`,
        identity.sessionId,
        'permission_audit_decided',
        {
          ...basePayload,
          behavior: 'deny',
          decision: confirmationError ? 'native_confirmation_error' : 'broker_error',
          decidedAt,
        },
        decidedAt,
      );
      throw error;
    }

    const auditedDecision = confirmationError
      ? 'native_confirmation_error'
      : decisionAccepted
        ? settlement.cause
        : 'trusted_decision_rejected';

    this.persist(
      `permission-audit:${auditId}:decided`,
      identity.sessionId,
      'permission_audit_decided',
      {
        ...basePayload,
        behavior: settlement.behavior,
        decision: auditedDecision,
        decidedAt: settlement.settledAt,
      },
      settlement.settledAt,
    );

    if (confirmationError) {
      throw new Error('Native bypass confirmation failed; authorization was denied.', {
        cause: confirmationError,
      });
    }

    if (!decisionAccepted) {
      throw new Error('The trusted bypass decision was rejected by PermissionBroker.');
    }

    if (settlement.behavior !== 'allow' || settlement.cause !== 'allow_once') {
      throw new Error('Bypass permissions was not explicitly authorized for this run.');
    }
  }

  recordAutoAllowed(settlement: PermissionSettlement): void {
    if (
      settlement.cause !== 'permission_auto_allowed'
      || settlement.behavior !== 'allow'
      || !settlement.matchedRuleId
      || !settlement.scope
      || !settlement.capability
    ) {
      throw new Error('Automatic permission audit requires a matched reusable rule.');
    }
    const identity = this.registeredIdentity(settlement.sessionKey);
    if (settlement.taskId && settlement.taskId !== identity.taskId) {
      throw new Error('Automatic permission audit task identity does not match the registered task.');
    }
    this.persist(
      `permission-audit:auto:${settlement.requestId}`,
      identity.sessionId,
      'permission_auto_allowed',
      {
        requestId: settlement.requestId,
        projectId: identity.projectId,
        projectPath: identity.projectPath,
        sessionId: identity.sessionId,
        taskId: identity.taskId,
        ...(settlement.workflowId ? { workflowId: settlement.workflowId } : {}),
        runId: settlement.runId,
        ...(settlement.processId ? { processId: settlement.processId } : {}),
        toolName: settlement.toolName,
        capability: settlement.capability,
        riskLevel: settlement.risk ?? 'high',
        scope: settlement.scope,
        matchedRuleId: settlement.matchedRuleId,
        settledAt: settlement.settledAt,
      },
      settlement.settledAt,
    );
  }

  private registeredIdentity(sessionKey: string): PermissionAuditIdentity {
    const sessionId = sessionIdFromKey(sessionKey);
    const session = sessionId ? this.database.getSession(sessionId) : null;
    const task = sessionId ? this.database.getTask(sessionId) : null;
    const project = session ? this.database.getProject(session.project_id) : null;
    if (
      !sessionId
      || !session
      || !task
      || !project
      || task.session_id !== session.id
      || task.project_id !== session.project_id
      || !project.path.trim()
    ) {
      throw new Error('Bypass authorization requires a registered session, task, and project.');
    }
    return {
      projectId: project.id,
      projectPath: project.path,
      sessionId: session.id,
      taskId: task.id,
    };
  }

  private persist(
    id: string,
    sessionId: string,
    eventType: string,
    payload: Record<string, unknown>,
    createdAt: number,
  ): void {
    const inserted = this.database.createEventIfAbsent(
      id,
      sessionId,
      eventType,
      JSON.stringify(payload),
      iso(createdAt),
    );
    if (!inserted) {
      throw new Error(`Permission audit event was not persisted: ${eventType}`);
    }
  }
}

export const permissionAuditInternals = { sessionIdFromKey };
