import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  PermissionAuditRecord,
  ProjectPermissionRuleRecord,
} from '../../../../shared/types/permissionBroker';
import { ProjectPermissionRuleList } from '../ProjectPermissionRules';

const rule: ProjectPermissionRuleRecord = {
  id: 'rule-1',
  projectId: 'project-1',
  canonicalProjectPath: 'c:\\projects\\workbench',
  toolName: 'bash',
  capability: 'shell.test',
  commandPattern: 'npm test',
  riskCeiling: 'medium',
  enabled: true,
  source: 'user',
  createdAt: Date.parse('2026-08-06T00:00:00.000Z'),
  updatedAt: Date.parse('2026-08-06T00:00:00.000Z'),
  lastHitAt: Date.parse('2026-08-06T00:01:00.000Z'),
  hitCount: 4,
};

const audit: PermissionAuditRecord = {
  id: 'audit-1',
  sessionId: 'session-1',
  eventType: 'permission_auto_allowed',
  toolName: 'Bash',
  capability: 'shell.test',
  riskLevel: 'medium',
  scope: 'project',
  matchedRuleId: rule.id,
  behavior: 'allow',
  createdAt: '2026-08-06T00:01:00.000Z',
};

function render(rules = [rule], audits = [audit], showAudit = true): string {
  return renderToStaticMarkup(React.createElement(ProjectPermissionRuleList, {
    rules,
    audits,
    showAudit,
    busyRuleId: null,
    onToggleRule: vi.fn(),
    onDeleteRule: vi.fn(),
    onClearRules: vi.fn(),
    onToggleAudit: vi.fn(),
  }));
}

describe('ProjectPermissionRuleList', () => {
  it('shows scope, rule metadata, lifecycle controls, and redacted audit fields', () => {
    const html = render();

    expect(html).toContain('权限规则');
    expect(html).toContain('项目测试');
    expect(html).toContain('npm test');
    expect(html).toContain('风险上限：中');
    expect(html).toContain('命中次数：');
    expect(html).toContain('暂停规则');
    expect(html).toContain('删除');
    expect(html).toContain('清除所有规则');
    expect(html).toContain('权限审计记录');
    expect(html).toContain('项目规则');
    expect(html).toContain('rule-1');
    expect(html).not.toContain('payload_json');
    expect(html).not.toContain(rule.canonicalProjectPath);
  });

  it('explains that unsafe and cross-project rules are not persisted', () => {
    const html = render([], [], false);

    expect(html).toContain('高风险和跨项目访问不会持久化');
    expect(html).toContain('当前项目没有持久权限规则');
    expect(html).toContain('查看审计记录');
  });

  it('labels a paused rule with a resume control', () => {
    const html = render([{ ...rule, enabled: false }], [], false);

    expect(html).toContain('恢复规则');
    expect(html).not.toContain('暂停规则');
  });
});
