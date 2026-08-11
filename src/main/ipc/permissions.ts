import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type {
  PermissionAuditRecord,
  PermissionCapability,
  PermissionDecision,
  PermissionRisk,
  PermissionRuleScope,
  ProjectPermissionRuleRecord,
} from '../../shared/types/permissionBroker';
import type { PageResult } from '../../shared/types/workbench';
import type {
  AppDatabase,
  EventRow,
  ProjectPermissionRuleRow,
  ProjectRow,
} from '../database/Database';
import type { PublicIpcRegistrar } from './public-invoke-boundary';
import type { PermissionBroker } from '../permissions/PermissionBroker';
import { canonicalizeProjectPath } from '../projects/ProjectService';
import { getMainWindow } from '../index';

const idInput = z.string().trim().min(1).max(256).refine((value) => !value.includes('\0'));
const pageInput = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
}).strict().optional().transform((value) => ({
  limit: value?.limit ?? 25,
  offset: value?.offset ?? 0,
}));

const capabilities = new Set<PermissionCapability>([
  'shell.read_only', 'shell.build', 'shell.test', 'shell.run_project',
  'shell.package_install', 'shell.file_copy', 'shell.file_write', 'shell.git_read',
  'shell.git_mutation', 'shell.network', 'shell.process_control', 'shell.outside_project',
  'shell.destructive', 'shell.unknown', 'tool.read', 'tool.write', 'tool.network',
  'tool.unknown',
]);

function resolveProject(database: AppDatabase, projectId: string): {
  project: ProjectRow;
  canonicalPath: string;
} {
  const project = database.getProject(idInput.parse(projectId));
  if (!project) throw new Error('Project not found.');
  return {
    project,
    canonicalPath: canonicalizeProjectPath(project.path).canonicalPath,
  };
}

function projectRuleRecord(
  row: ProjectPermissionRuleRow,
  project: ProjectRow,
  canonicalPath: string,
): ProjectPermissionRuleRecord {
  if (
    row.project_id !== project.id
    || row.scope !== 'project'
    || canonicalizeProjectPath(row.canonical_project_path).canonicalPath !== canonicalPath
    || row.canonical_project_path !== canonicalPath
    || row.source !== 'user'
  ) {
    throw new Error('Stored permission rule does not match the registered project.');
  }
  return {
    id: row.id,
    projectId: row.project_id,
    canonicalProjectPath: row.canonical_project_path,
    toolName: row.tool_name,
    capability: row.capability,
    commandPattern: row.command_pattern,
    riskCeiling: row.risk_ceiling,
    enabled: row.enabled,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastHitAt: row.last_hit_at,
    hitCount: row.hit_count,
  };
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 256 ? value : null;
}

function auditRecord(
  row: EventRow,
  project: ProjectRow,
  canonicalPath: string,
): PermissionAuditRecord {
  const parsed = JSON.parse(row.payload_json) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Stored permission audit payload is invalid.');
  }
  const payload = parsed as Record<string, unknown>;
  if (
    payload.projectId !== project.id
    || typeof payload.projectPath !== 'string'
    || canonicalizeProjectPath(payload.projectPath).canonicalPath !== canonicalPath
  ) {
    throw new Error('Stored permission audit does not match the registered project.');
  }
  const rawCapability = optionalString(payload.capability);
  const capability = rawCapability && capabilities.has(rawCapability as PermissionCapability)
    ? rawCapability as PermissionCapability
    : null;
  const rawRisk = optionalString(payload.riskLevel) ?? optionalString(payload.risk);
  const riskLevel = rawRisk && ['low', 'medium', 'high'].includes(rawRisk)
    ? rawRisk as PermissionRisk
    : null;
  const rawScope = optionalString(payload.scope);
  const scope = rawScope && ['task', 'project'].includes(rawScope)
    ? rawScope as PermissionRuleScope
    : null;
  const rawBehavior = optionalString(payload.behavior);
  const behavior = rawBehavior && ['allow', 'deny'].includes(rawBehavior)
    ? rawBehavior as 'allow' | 'deny'
    : null;
  const requestName = payload.request === 'bypassPermissions' ? 'bypassPermissions' : null;
  return {
    id: row.id,
    sessionId: row.session_id,
    eventType: row.event_type,
    toolName: optionalString(payload.toolName) ?? requestName,
    capability,
    riskLevel,
    scope,
    matchedRuleId: optionalString(payload.matchedRuleId),
    behavior,
    createdAt: row.created_at,
  };
}

export function registerPermissionIPC(
  ipcMain: PublicIpcRegistrar,
  broker: PermissionBroker,
  database?: AppDatabase,
): () => void {
  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_DECIDE,
    async (_event, requestId: string, decision: PermissionDecision) => {
      if (!['allow_once', 'allow_for_task', 'allow_for_project', 'deny'].includes(decision)) {
        return { accepted: false, reason: '无效的权限决定' };
      }
      const accepted = broker.decide(requestId, decision);
      return accepted
        ? { accepted: true }
        : { accepted: false, reason: '权限请求已处理、超时或不属于当前运行' };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_RULES_LIST,
    async (_event, rawProjectId: unknown, rawPage?: unknown): Promise<PageResult<ProjectPermissionRuleRecord>> => {
      if (!database) throw new Error('Permission rule storage is unavailable.');
      const projectId = idInput.parse(rawProjectId);
      const requestedPage = pageInput.parse(rawPage);
      const { project, canonicalPath } = resolveProject(database, projectId);
      const result = database.listProjectPermissionRules(project.id, requestedPage);
      return {
        ...result,
        items: result.items.map((row) => projectRuleRecord(row, project, canonicalPath)),
      };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_RULE_SET_ENABLED,
    async (_event, rawProjectId: unknown, rawRuleId: unknown, rawEnabled: unknown) => {
      if (!database) throw new Error('Permission rule storage is unavailable.');
      const projectId = idInput.parse(rawProjectId);
      const ruleId = idInput.parse(rawRuleId);
      const enabled = z.boolean().parse(rawEnabled);
      const { project, canonicalPath } = resolveProject(database, projectId);
      const row = database.setProjectPermissionRuleEnabled(
        project.id,
        ruleId,
        enabled,
        Date.now(),
      );
      if (!row) throw new Error('Project permission rule not found.');
      return projectRuleRecord(row, project, canonicalPath);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_RULE_DELETE,
    async (_event, rawProjectId: unknown, rawRuleId: unknown): Promise<boolean> => {
      if (!database) throw new Error('Permission rule storage is unavailable.');
      const { project } = resolveProject(database, idInput.parse(rawProjectId));
      return database.deleteProjectPermissionRule(project.id, idInput.parse(rawRuleId));
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_RULE_CLEAR,
    async (_event, rawProjectId: unknown, rawConfirmed: unknown): Promise<number> => {
      if (!database) throw new Error('Permission rule storage is unavailable.');
      const { project } = resolveProject(database, idInput.parse(rawProjectId));
      if (z.boolean().parse(rawConfirmed) !== true) {
        throw new Error('Explicit confirmation is required to clear project permission rules.');
      }
      return database.clearProjectPermissionRules(project.id);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_AUDIT_LIST,
    async (_event, rawProjectId: unknown, rawPage?: unknown): Promise<PageResult<PermissionAuditRecord>> => {
      if (!database) throw new Error('Permission audit storage is unavailable.');
      const requestedPage = pageInput.parse(rawPage);
      const { project, canonicalPath } = resolveProject(database, idInput.parse(rawProjectId));
      const result = database.listProjectPermissionAuditEvents(project.id, requestedPage);
      return {
        ...result,
        items: result.items.map((row) => auditRecord(row, project, canonicalPath)),
      };
    },
  );

  const unsubscribeRequests = broker.subscribe((request) => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.PERMISSION_REQUEST, request);
    }
  });

  const unsubscribeSettlements = broker.subscribeSettlements((settlement) => {
    console.info('[PermissionBroker] settled', {
      requestId: settlement.requestId,
      runId: settlement.runId,
      behavior: settlement.behavior,
      cause: settlement.cause,
    });
    const window = getMainWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.PERMISSION_SETTLED, settlement);
    }
  });

  return () => {
    unsubscribeRequests();
    unsubscribeSettlements();
  };
}
