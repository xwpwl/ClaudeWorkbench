import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PermissionRule } from '../../../shared/types/permissionBroker';
import { AppDatabase } from '../../database/Database';
import { canonicalizeProjectPath } from '../../projects/ProjectService';
import { DatabasePermissionRuleStore } from '../DatabasePermissionRuleStore';
import {
  analyzePermissionRequest,
  createPermissionRule,
} from '../PermissionRuleEngine';

const TEMP_PREFIX = 'claude-workbench-permission-rule-store-test-';
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

describe('DatabasePermissionRuleStore', () => {
  let directory: string;
  let databasePath: string;
  let projectPath: string;
  let otherProjectPath: string;
  let canonicalProjectPath: string;
  let canonicalOtherProjectPath: string;
  let database: AppDatabase;
  let store: DatabasePermissionRuleStore;

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
    store = new DatabasePermissionRuleStore(database);
  });

  afterEach(() => {
    database.close();
    removeTestDirectory(directory);
  });

  function testRule(
    id = 'rule-1',
    root = projectPath,
    now = 100,
  ): PermissionRule {
    return createPermissionRule(
      analyzePermissionRequest('Bash', { command: 'npm test' }, root),
      'project',
      { id, now },
    );
  }

  it('persists enabled user rules and restores them after restart', () => {
    const rule = testRule();

    expect(store.create(rule)).toEqual(rule);
    expect(database.listProjectPermissionRules(PROJECT_ID).items).toEqual([
      {
        id: 'rule-1',
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
      },
    ]);

    database.close();
    database = new AppDatabase(databasePath);
    store = new DatabasePermissionRuleStore(database);
    expect(store.listEnabled(canonicalProjectPath)).toEqual([rule]);
  });

  it('keeps enabled rules isolated by canonical registered project', () => {
    const first = testRule('rule-1');
    const second = testRule('rule-2', otherProjectPath, 200);
    store.create(first);
    store.create(second);

    expect(store.listEnabled(canonicalProjectPath)).toEqual([first]);
    expect(store.listEnabled(canonicalOtherProjectPath)).toEqual([second]);

    const unregisteredPath = path.join(directory, 'unregistered');
    fs.mkdirSync(unregisteredPath);
    const canonicalUnregistered = canonicalizeProjectPath(unregisteredPath).canonicalPath;
    expect(() => store.listEnabled(canonicalUnregistered)).toThrow(/registered project/i);
    expect(() => store.listEnabled(`${canonicalProjectPath}${path.sep}`)).toThrow(/canonical project path/i);
  });

  it('fails closed when a persisted row is rebound to another canonical root', () => {
    store.create(testRule());
    const raw = new BetterSqlite3(databasePath);
    try {
      raw.prepare(`
        UPDATE project_permission_rules SET canonical_project_path = ? WHERE id = ?
      `).run(canonicalOtherProjectPath, 'rule-1');
    } finally {
      raw.close();
    }

    expect(() => store.listEnabled(canonicalProjectPath)).toThrow(/canonical project mismatch/i);
  });

  it.each([
    ['task scope', { scope: 'task' }],
    ['high risk', { riskCeiling: 'high' }],
    ['outside root', { externalRoot: canonicalOtherProjectPath }],
    ['destructive capability', { capability: 'shell.destructive' }],
    ['unknown capability', { capability: 'shell.unknown' }],
    ['package install capability', { capability: 'shell.package_install' }],
    ['project process capability', { capability: 'shell.run_project' }],
    ['unknown tool', { toolName: 'unknown-tool' }],
    ['tool capability mismatch', { toolName: 'read' }],
    ['non-normalized tool', { toolName: 'Bash' }],
    ['destructive command pattern', { commandPattern: 'rm -rf ./build' }],
    ['invalid creation time', { createdAt: Number.NaN }],
  ])('rejects unsafe rule input at the store boundary: %s', (_label, overrides) => {
    const forged = { ...testRule(), ...overrides } as PermissionRule;
    expect(() => store.create(forged)).toThrow();
    expect(database.listProjectPermissionRules(PROJECT_ID).items).toEqual([]);
  });

  it('rejects unexpected fields instead of accepting an expanded rule contract', () => {
    const forged = { ...testRule(), projectId: OTHER_PROJECT_ID } as PermissionRule;
    expect(() => store.create(forged)).toThrow(/unexpected field/i);
  });

  it('fails closed when a legacy persisted rule authorizes project processes', () => {
    store.create(testRule());
    const raw = new BetterSqlite3(databasePath);
    try {
      raw.prepare(`
        UPDATE project_permission_rules
        SET capability = 'shell.run_project', command_pattern = NULL
        WHERE id = 'rule-1'
      `).run();
    } finally {
      raw.close();
    }

    expect(() => store.listEnabled(canonicalProjectPath)).toThrow(/not persistable/i);
  });

  it('records hits on validated persisted rules', () => {
    store.create(testRule());

    store.recordHit('rule-1', 250);
    store.recordHit('rule-1', 300);
    expect(database.getProjectPermissionRule('rule-1')).toMatchObject({
      last_hit_at: 300,
      hit_count: 2,
    });
    expect(() => store.recordHit('rule-1', Number.NaN)).toThrow(/hit time/i);
    expect(() => store.recordHit('missing-rule', 400)).not.toThrow();
  });
});
