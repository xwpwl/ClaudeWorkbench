import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PermissionRequest } from '../../../../shared/types/permissionBroker';
import { PermissionDialog } from '../PermissionDialog';

function request(patch: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: 'request-1',
    runId: 'run-1',
    sessionKey: 'project::session-1',
    projectPath: 'C:\\projects\\fixture',
    toolName: 'Read',
    input: { file_path: 'README.md' },
    risk: 'low',
    createdAt: 1,
    ...patch,
  };
}

function markup(value: PermissionRequest): string {
  return renderToStaticMarkup(React.createElement(PermissionDialog, {
    request: value,
    onResolved: () => undefined,
    onStop: async () => undefined,
  }));
}

describe('PermissionDialog bypass confirmation', () => {
  it('shows only deny and an explicit one-shot enable action for bypass mode', () => {
    const html = markup(request({
      kind: 'bypass_permissions',
      toolName: 'BypassPermissions',
      input: { permissionMode: 'bypassPermissions' },
      risk: 'high',
    }));

    expect(html).toContain('data-testid="bypass-permission-warning"');
    expect(html).toContain('data-testid="permission-deny"');
    expect(html).toContain('data-testid="bypass-permission-allow-once"');
    expect(html).not.toContain('data-testid="permission-allow-session"');
    expect(html).not.toContain('data-testid="permission-stop"');
  });

  it('keeps the ordinary permission controls for non-bypass tool requests', () => {
    const html = markup(request({
      taskId: 'task-1',
      capability: 'tool.read',
      effectiveCwd: 'C:\\projects\\fixture',
      canonicalProjectPath: 'c:\\projects\\fixture',
      targetPaths: ['C:\\projects\\fixture\\README.md'],
      outsideProject: false,
      normalizedRule: 'tool=read;capability=tool.read',
      projectRulePersistable: true,
    }));
    expect(html).toContain('data-testid="permission-stop"');
    expect(html).toContain('data-testid="permission-allow-once"');
    expect(html).toContain('data-testid="permission-allow-task"');
    expect(html).toContain('data-testid="permission-allow-project"');
    expect(html).toContain('本任务允许此类操作');
    expect(html).toContain('此项目始终允许此规则');
    expect(html).not.toContain('本次运行始终允许');
    expect(html).not.toContain('data-testid="bypass-permission-warning"');
  });

  it('explains why an unsafe project rule cannot be persisted', () => {
    const html = markup(request({
      toolName: 'Bash',
      input: { command: 'npm install lodash' },
      risk: 'medium',
      capability: 'shell.package_install',
      projectRulePersistable: false,
      projectRuleDisabledReason: '依赖安装不能持久化为项目规则。',
    }));

    expect(html).not.toContain('data-testid="permission-allow-project"');
    expect(html).toContain('依赖安装不能持久化为项目规则。');
  });

  it('shows canonical cross-project scope instead of implying a normal Bash grant', () => {
    const html = markup(request({
      taskId: 'task-1',
      toolName: 'Bash',
      input: { command: 'cd "C:\\projects\\other" &amp;&amp; npm test' },
      risk: 'medium',
      capability: 'shell.test',
      canonicalProjectPath: 'c:\\projects\\fixture',
      effectiveCwd: 'C:\\projects\\other',
      targetPaths: ['C:\\projects\\other\\package.json'],
      outsideProject: true,
      normalizedRule: 'tool=bash;capability=shell.test;external=other',
      projectRulePersistable: false,
      projectRuleDisabledReason: '跨项目目录授权不能持久化为普通项目规则。',
    }));

    expect(html).toContain('跨项目访问');
    expect(html).toContain('当前项目');
    expect(html).toContain('实际工作目录');
    expect(html).toContain('目标路径');
    expect(html).toContain('package.json');
    expect(html).toContain('本任务允许访问该外部目录');
    expect(html).toContain('data-testid="permission-switch-project"');
    expect(html).toContain('切换到目标项目并停止当前任务');
    expect(html).not.toContain('data-testid="permission-allow-project"');
  });
});
