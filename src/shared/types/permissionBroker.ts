export type PermissionDecision = 'allow_once' | 'allow_for_task' | 'allow_for_project' | 'deny';

export type PermissionRisk = 'low' | 'medium' | 'high';

export type PermissionCapability =
  | 'shell.read_only'
  | 'shell.build'
  | 'shell.test'
  | 'shell.run_project'
  | 'shell.package_install'
  | 'shell.file_copy'
  | 'shell.file_write'
  | 'shell.git_read'
  | 'shell.git_mutation'
  | 'shell.network'
  | 'shell.process_control'
  | 'shell.outside_project'
  | 'shell.destructive'
  | 'shell.unknown'
  | 'tool.read'
  | 'tool.write'
  | 'tool.network'
  | 'tool.unknown';

export type PermissionRuleScope = 'task' | 'project';

export interface PermissionAnalysis {
  toolName: string;
  capability: PermissionCapability;
  risk: PermissionRisk;
  canonicalProjectPath: string;
  effectiveCwd: string;
  targetPaths: string[];
  externalRoot: string | null;
  outsideProject: boolean;
  cacheableForTask: boolean;
  persistableForProject: boolean;
  normalizedRule: string;
  commandPattern: string | null;
  nonReusableReason?: string;
}

export interface PermissionRule {
  id: string;
  scope: PermissionRuleScope;
  toolName: string;
  capability: PermissionCapability;
  canonicalProjectPath: string;
  riskCeiling: PermissionRisk;
  commandPattern: string | null;
  externalRoot: string | null;
  createdAt: number;
  enabled: boolean;
}

export interface ProjectPermissionRuleRecord {
  id: string;
  projectId: string;
  canonicalProjectPath: string;
  toolName: string;
  capability: PermissionCapability;
  commandPattern: string | null;
  riskCeiling: PermissionRisk;
  enabled: boolean;
  source: 'user';
  createdAt: number;
  updatedAt: number;
  lastHitAt: number | null;
  hitCount: number;
}

export interface PermissionAuditRecord {
  id: string;
  sessionId: string;
  eventType: string;
  toolName: string | null;
  capability: PermissionCapability | null;
  riskLevel: PermissionRisk | null;
  scope: PermissionRuleScope | null;
  matchedRuleId: string | null;
  behavior: 'allow' | 'deny' | null;
  createdAt: string;
}

export type PermissionRequestKind = 'tool' | 'bypass_permissions';

/**
 * Main-process request for a one-shot dangerous-mode confirmation.
 *
 * The renderer never supplies an authorization flag or reusable capability.
 * It may reject the emitted request, but an allow decision is accepted only
 * from the main-process native confirmation path. The fixed kind lets the
 * broker force high-risk, non-cacheable behavior independently of UI input.
 */
export interface ExplicitHighRiskPermissionRequest {
  requestId: string;
  runId: string;
  sessionKey: string;
  projectPath: string;
  createdAt: number;
  kind: 'bypass_permissions';
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
  taskId?: string;
  workflowId?: string;
  processId?: number;
  capability?: PermissionCapability;
  canonicalProjectPath?: string;
  effectiveCwd?: string;
  targetPaths?: string[];
  outsideProject?: boolean;
  normalizedRule?: string;
  cacheKey?: string;
  cacheStatus?: 'miss' | 'not_cacheable';
  cacheMissReason?: string;
  projectRulePersistable?: boolean;
  projectRuleDisabledReason?: string;
  kind?: PermissionRequestKind;
  createdAt: number;
}

export interface PermissionDecisionReceipt {
  accepted: boolean;
  reason?: string;
}

export type PermissionSettlementCause =
  | 'allow_once'
  | 'allow_for_task'
  | 'allow_for_project'
  | 'permission_auto_allowed'
  | 'deny'
  | 'invalid_decision'
  | 'run_inactive'
  | 'timeout'
  | 'run_cancelled'
  | 'run_completed'
  | 'requester_disconnected'
  | 'broker_closed';

/**
 * Non-sensitive notification that a previously emitted permission request is
 * no longer actionable. It intentionally excludes the tool input and broker
 * credentials.
 */
export interface PermissionSettlement {
  requestId: string;
  runId: string;
  sessionKey: string;
  projectPath: string;
  toolName: string;
  toolUseId?: string;
  behavior: 'allow' | 'deny';
  cause: PermissionSettlementCause;
  decisionClassification: 'user_temporary' | 'user_permanent' | 'user_reject' | 'rule_auto_allow';
  taskId?: string;
  workflowId?: string;
  processId?: number;
  capability?: PermissionCapability;
  risk?: PermissionRisk;
  canonicalProjectPath?: string;
  effectiveCwd?: string;
  targetPaths?: string[];
  outsideProject?: boolean;
  normalizedRule?: string;
  cacheKey?: string;
  scope?: PermissionRuleScope;
  matchedRuleId?: string;
  message?: string;
  settledAt: number;
}
