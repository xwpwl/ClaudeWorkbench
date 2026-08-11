import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalizeProjectPath } from '../../projects/ProjectService';
import {
  AppDatabase,
  type ProjectPermissionRuleRow,
} from '../Database';

const TEMP_PREFIX = 'claude-workbench-permission-rule-db-test-';
const PROJECT_ID = 'project-1';
const OTHER_PROJECT_ID = 'project-2';

function removeTestDirectory(directory: string): void {
  const target = path.resolve(directory);
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith(TEMP_PREFIX)) {
    throw new Error(`Refusing to remove unexpected test directory: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

describe('project permission rule persistence', () => {
  let directory: string;
  let databasePath: string;
  let projectPath: string;
  let otherProjectPath: string;
  let canonicalProjectPath: string;
  let canonicalOtherProjectPath: string;
  let database: AppDatabase;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    databasePath = path.join(directory, 'workbench.sqlite');
    projectPath = path.join(directory, 'project');
    otherProjectPath = path.join(directory, 'other-project');
    fs.mkdirSync(projectPath);
    fs.mkdirSync(otherProjectPath);
    canonicalProjectPath = canonicalizeProjectPath(projectPath).canonicalPath;
    canonicalOtherProjectPath = canonicalizeProjectPath(otherProjectPath).canonicalPath;
    database = new AppDatabase(databasePath);
    database.createProject(PROJECT_ID, 'Permission rule project', projectPath);
    database.createProject(OTHER_PROJECT_ID, 'Other permission project', otherProjectPath);
  });

  afterEach(() => {
    database.close();
    removeTestDirectory(directory);
  });

  function rule(
    id: string,
    overrides: Partial<ProjectPermissionRuleRow> = {},
  ): ProjectPermissionRuleRow {
    return {
      id,
      project_id: PROJECT_ID,
      scope: 'project',
      canonical_project_path: canonicalProjectPath,
      tool_name: 'bash',
      capability: 'shell.test',
      command_pattern: null,
      risk_ceiling: 'medium',
      enabled: true,
      source: 'user',
      created_at: 100,
      updated_at: 100,
      last_hit_at: null,
      hit_count: 0,
      ...overrides,
    };
  }

  it('returns deterministic project-scoped pages with an exact total', () => {
    database.createProjectPermissionRule(rule('rule-old', { created_at: 100, updated_at: 100 }));
    database.createProjectPermissionRule(rule('rule-new', { created_at: 200, updated_at: 200 }));
    database.createProjectPermissionRule(rule('other-rule', {
      project_id: OTHER_PROJECT_ID,
      canonical_project_path: canonicalOtherProjectPath,
      created_at: 300,
      updated_at: 300,
    }));

    expect(database.listProjectPermissionRules(PROJECT_ID, { limit: 1, offset: 0 }))
      .toEqual({ items: [rule('rule-new', { created_at: 200, updated_at: 200 })], total: 2, limit: 1, offset: 0 });
    expect(database.listProjectPermissionRules(PROJECT_ID, { limit: 1, offset: 1 }))
      .toEqual({ items: [rule('rule-old')], total: 2, limit: 1, offset: 1 });
  });

  it('lists only enabled rows for broker matching', () => {
    database.createProjectPermissionRule(rule('enabled-rule'));
    database.createProjectPermissionRule(rule('disabled-rule', {
      enabled: false,
      created_at: 200,
      updated_at: 200,
    }));

    expect(database.listEnabledProjectPermissionRules(PROJECT_ID)).toEqual([
      rule('enabled-rule'),
    ]);
  });

  it('updates enabled state only through the owning project', () => {
    database.createProjectPermissionRule(rule('rule-1'));

    expect(database.setProjectPermissionRuleEnabled(
      OTHER_PROJECT_ID,
      'rule-1',
      false,
      200,
    )).toBeNull();
    expect(database.getProjectPermissionRule('rule-1')).toEqual(rule('rule-1'));

    expect(database.setProjectPermissionRuleEnabled(
      PROJECT_ID,
      'rule-1',
      false,
      200,
    )).toEqual(rule('rule-1', { enabled: false, updated_at: 200 }));
  });

  it('records last-hit time and a monotonic hit count', () => {
    database.createProjectPermissionRule(rule('rule-1'));

    expect(database.recordProjectPermissionRuleHit('rule-1', 300))
      .toEqual(rule('rule-1', { last_hit_at: 300, hit_count: 1 }));
    expect(database.recordProjectPermissionRuleHit('rule-1', 400))
      .toEqual(rule('rule-1', { last_hit_at: 400, hit_count: 2 }));
    expect(database.recordProjectPermissionRuleHit('missing-rule', 500)).toBeNull();
  });

  it('deletes and clears rules without crossing project boundaries', () => {
    database.createProjectPermissionRule(rule('rule-1'));
    database.createProjectPermissionRule(rule('rule-2', { created_at: 200, updated_at: 200 }));
    database.createProjectPermissionRule(rule('other-rule', {
      project_id: OTHER_PROJECT_ID,
      canonical_project_path: canonicalOtherProjectPath,
    }));

    expect(database.deleteProjectPermissionRule(OTHER_PROJECT_ID, 'rule-1')).toBe(false);
    expect(database.deleteProjectPermissionRule(PROJECT_ID, 'rule-1')).toBe(true);
    expect(database.clearProjectPermissionRules(PROJECT_ID)).toBe(1);
    expect(database.listProjectPermissionRules(PROJECT_ID).items).toEqual([]);
    expect(database.listProjectPermissionRules(OTHER_PROJECT_ID).items).toHaveLength(1);
  });

  it('restores project rules after reopening the database', () => {
    database.createProjectPermissionRule(rule('rule-1'));
    database.close();

    database = new AppDatabase(databasePath);
    expect(database.listProjectPermissionRules(PROJECT_ID).items).toEqual([rule('rule-1')]);
  });

  it('paginates permission audit events without crossing project sessions', () => {
    database.createSession('session-a', PROJECT_ID, 'A');
    database.createSession('session-b', OTHER_PROJECT_ID, 'B');
    database.createEvent(
      'audit-old',
      'session-a',
      'permission_audit_requested',
      '{}',
      '2026-08-06T00:00:00.000Z',
    );
    database.createEvent(
      'audit-new',
      'session-a',
      'permission_auto_allowed',
      '{}',
      '2026-08-06T00:00:01.000Z',
    );
    database.createEvent(
      'ordinary-event',
      'session-a',
      'tool_started',
      '{}',
      '2026-08-06T00:00:02.000Z',
    );
    database.createEvent(
      'other-project-audit',
      'session-b',
      'permission_auto_allowed',
      '{}',
      '2026-08-06T00:00:03.000Z',
    );

    expect(database.listProjectPermissionAuditEvents(PROJECT_ID, { limit: 1, offset: 0 }))
      .toMatchObject({ items: [{ id: 'audit-new' }], total: 2, limit: 1, offset: 0 });
    expect(database.listProjectPermissionAuditEvents(PROJECT_ID, { limit: 1, offset: 1 }))
      .toMatchObject({ items: [{ id: 'audit-old' }], total: 2, limit: 1, offset: 1 });
  });
});
