import type { PermissionRule, PermissionRisk } from '../../shared/types/permissionBroker';
import {
  AppDatabase,
  type ProjectPermissionRuleCapability,
  type ProjectPermissionRuleRow,
  type ProjectRow,
} from '../database/Database';
import { canonicalizeProjectPath } from '../projects/ProjectService';
import type { PermissionProjectRuleStore } from './PermissionBroker';
import {
  analyzePermissionRequest,
  canPersistProjectRule,
} from './PermissionRuleEngine';

const RULE_FIELDS = [
  'canonicalProjectPath',
  'capability',
  'commandPattern',
  'createdAt',
  'enabled',
  'externalRoot',
  'id',
  'riskCeiling',
  'scope',
  'toolName',
] as const;

const SHELL_TOOLS = new Set(['bash', 'shell', 'powershell', 'cmd']);
const READ_TOOLS = new Set(['read', 'glob', 'grep', 'ls']);
const CAPABILITY_RISK: Partial<Record<
  ProjectPermissionRuleCapability,
  Exclude<PermissionRisk, 'high'>
>> = {
  'shell.read_only': 'low',
  'shell.build': 'medium',
  'shell.test': 'medium',
  'shell.git_read': 'low',
  'tool.read': 'low',
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

function assertIdentifier(value: unknown, label: string, maxLength: number): asserts value is string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || value !== value.trim()
    || value.includes('\0')) {
    throw new Error(`${label} is invalid.`);
  }
}

function strictCanonicalProjectPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error('A canonical project path is required.');
  }
  const canonical = canonicalizeProjectPath(value).canonicalPath;
  if (canonical !== value) {
    throw new Error('A canonical project path is required.');
  }
  return canonical;
}

function ruleFromRow(row: ProjectPermissionRuleRow): PermissionRule {
  return {
    id: row.id,
    scope: 'project',
    toolName: row.tool_name,
    capability: row.capability,
    canonicalProjectPath: row.canonical_project_path,
    riskCeiling: row.risk_ceiling,
    commandPattern: row.command_pattern,
    externalRoot: null,
    createdAt: row.created_at,
    enabled: row.enabled,
  };
}

function validatePersistedMetadata(row: ProjectPermissionRuleRow): void {
  if (row.source !== 'user') throw new Error('Persisted permission rule source is invalid.');
  assertSafeInteger(row.created_at, 'Permission rule creation time');
  assertSafeInteger(row.updated_at, 'Permission rule update time');
  assertSafeInteger(row.hit_count, 'Permission rule hit count');
  if (row.updated_at < row.created_at) {
    throw new Error('Persisted permission rule timestamps are invalid.');
  }
  if (row.last_hit_at === null) {
    if (row.hit_count !== 0) throw new Error('Persisted permission rule hit metadata is invalid.');
  } else {
    assertSafeInteger(row.last_hit_at, 'Permission rule last-hit time');
    if (row.hit_count === 0) throw new Error('Persisted permission rule hit metadata is invalid.');
  }
}

function validateProjectRule(
  value: PermissionRule,
  expectedCanonicalPath?: string,
): PermissionRule {
  if (!isPlainRecord(value)) throw new Error('Permission rule must be a plain object.');
  const keys = Object.keys(value).sort();
  const expectedKeys = [...RULE_FIELDS].sort();
  const unexpected = keys.filter((key) => !expectedKeys.includes(key as typeof RULE_FIELDS[number]));
  const missing = expectedKeys.filter((key) => !keys.includes(key));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(`Permission rule has an unexpected field or missing field: ${[...unexpected, ...missing].join(', ')}`);
  }

  assertIdentifier(value.id, 'Permission rule id', 256);
  if (value.scope !== 'project') throw new Error('Only project-scoped rules can be persisted.');
  assertIdentifier(value.toolName, 'Permission rule tool name', 128);
  if (value.toolName !== value.toolName.toLocaleLowerCase('en-US')) {
    throw new Error('Permission rule tool name must be normalized.');
  }

  if (!(value.capability in CAPABILITY_RISK)) {
    throw new Error('Permission rule capability is not persistable.');
  }
  const capability = value.capability as ProjectPermissionRuleCapability;
  const expectedRisk = CAPABILITY_RISK[capability];
  if (!expectedRisk) {
    throw new Error('Permission rule capability is not persistable.');
  }
  if (value.riskCeiling !== expectedRisk) {
    throw new Error('Permission rule risk ceiling is unsafe for its capability.');
  }
  const toolMatchesCapability = capability === 'tool.read'
    ? READ_TOOLS.has(value.toolName)
    : SHELL_TOOLS.has(value.toolName);
  if (!toolMatchesCapability) {
    throw new Error('Permission rule tool and capability do not match.');
  }

  const canonicalPath = strictCanonicalProjectPath(value.canonicalProjectPath);
  if (expectedCanonicalPath && canonicalPath !== expectedCanonicalPath) {
    throw new Error('Persisted permission rule canonical project mismatch.');
  }
  if (value.externalRoot !== null) {
    throw new Error('Project permission rules cannot authorize an external root.');
  }
  if (typeof value.enabled !== 'boolean') throw new Error('Permission rule enabled state is invalid.');
  assertSafeInteger(value.createdAt, 'Permission rule creation time');

  if (value.commandPattern !== null) {
    if (typeof value.commandPattern !== 'string'
      || value.commandPattern.trim().length === 0
      || value.commandPattern.length > 4096
      || value.commandPattern.includes('\0')) {
      throw new Error('Permission rule command pattern is invalid.');
    }
    if (!SHELL_TOOLS.has(value.toolName)) {
      throw new Error('Only shell rules can carry a command pattern.');
    }
    const analysis = analyzePermissionRequest(
      value.toolName,
      { command: value.commandPattern, cwd: canonicalPath },
      canonicalPath,
    );
    if (!canPersistProjectRule(analysis)
      || analysis.capability !== capability
      || analysis.risk !== expectedRisk) {
      throw new Error('Permission rule command pattern is unsafe or mismatched.');
    }
  }

  return { ...value };
}

export class DatabasePermissionRuleStore implements PermissionProjectRuleStore {
  constructor(private readonly database: AppDatabase) {}

  listEnabled(canonicalProjectPath: string): PermissionRule[] {
    const { project, canonicalPath } = this.resolveRegisteredProject(canonicalProjectPath);
    return this.database.listEnabledProjectPermissionRules(project.id).map((row) => {
      validatePersistedMetadata(row);
      return validateProjectRule(ruleFromRow(row), canonicalPath);
    });
  }

  create(rule: PermissionRule): PermissionRule {
    const validated = validateProjectRule(rule);
    const { project, canonicalPath } = this.resolveRegisteredProject(
      validated.canonicalProjectPath,
    );
    if (validated.canonicalProjectPath !== canonicalPath) {
      throw new Error('Permission rule canonical project mismatch.');
    }
    const created = this.database.createProjectPermissionRule({
      id: validated.id,
      project_id: project.id,
      scope: 'project',
      canonical_project_path: canonicalPath,
      tool_name: validated.toolName,
      capability: validated.capability as ProjectPermissionRuleCapability,
      command_pattern: validated.commandPattern,
      risk_ceiling: validated.riskCeiling as Exclude<PermissionRisk, 'high'>,
      enabled: validated.enabled,
      source: 'user',
      created_at: validated.createdAt,
      updated_at: validated.createdAt,
      last_hit_at: null,
      hit_count: 0,
    });
    return ruleFromRow(created);
  }

  recordHit(ruleId: string, hitAt: number): void {
    assertIdentifier(ruleId, 'Permission rule id', 256);
    assertSafeInteger(hitAt, 'Permission rule hit time');
    const existing = this.database.getProjectPermissionRule(ruleId);
    if (!existing) return;
    validatePersistedMetadata(existing);
    const { project, canonicalPath } = this.resolveRegisteredProject(
      existing.canonical_project_path,
    );
    if (project.id !== existing.project_id) {
      throw new Error('Persisted permission rule canonical project mismatch.');
    }
    validateProjectRule(ruleFromRow(existing), canonicalPath);
    this.database.recordProjectPermissionRuleHit(ruleId, hitAt);
  }

  private resolveRegisteredProject(canonicalProjectPath: string): {
    project: ProjectRow;
    canonicalPath: string;
  } {
    const canonicalPath = strictCanonicalProjectPath(canonicalProjectPath);
    const matches = this.database.listProjects().filter((project) => (
      canonicalizeProjectPath(project.path).canonicalPath === canonicalPath
    ));
    if (matches.length === 0) {
      throw new Error('Permission rule path does not identify a registered project.');
    }
    if (matches.length > 1) {
      throw new Error('Permission rule path ambiguously identifies multiple registered projects.');
    }
    return { project: matches[0], canonicalPath };
  }
}
