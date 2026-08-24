// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../../../shared/types/ipc';
import type { GitStatus } from '../../../../shared/types/git';
import type { Project } from '../../../../shared/types/project';
import { setLocale } from '../../../i18n';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { SettingsDialog } from '../SettingsDialog';

const settings = {
  claudePath: 'claude', autoDetectClaude: true, claudeGitBashPath: '',
  defaultModel: '', detectedModel: '', modelSource: 'claude-default',
  defaultPermissionMode: 'standard', showDangerousPermissions: false,
  gitPath: 'git', vscodePath: 'code', terminalShell: 'powershell',
  theme: 'light', fontSize: 14, language: 'zh-CN', dataPath: '', autoCheckUpdates: false,
} satisfies AppSettings;

const currentProject: Project = {
  id: 'project-1', name: 'Fixture', path: 'C:\\Projects\\Fixture',
  createdAt: '2026-08-09T00:00:00.000Z', lastOpenedAt: '2026-08-09T00:00:00.000Z',
};

const originalApi = window.api;

function gitStatus(patch: Partial<GitStatus> = {}): GitStatus {
  return {
    projectPath: currentProject.path,
    branch: 'main',
    detached: false,
    head: '0123456789abcdef',
    upstream: null,
    ahead: 0,
    behind: 0,
    clean: true,
    files: [],
    stagedFiles: [],
    unstagedFiles: [],
    untrackedFiles: [],
    additions: 0,
    deletions: 0,
    ...patch,
  };
}

function installApi(overrides: Record<string, unknown> = {}) {
  const api = {
    getSettings: vi.fn(async () => settings),
    setSettings: vi.fn(async () => undefined),
    checkEnvironment: vi.fn(async () => ({
      node: { ok: true, version: 'v24', path: null },
      claude: { ok: true, version: '2.1.0', path: null, installType: 'local' },
      git: { ok: true, version: '2.50', path: null },
      gitBash: { ok: true, path: null, configured: false },
      shell: { ok: true, name: 'PowerShell', path: null },
      projectDir: { ok: true, readable: true, writable: true },
      claudeConfiguration: { ok: true, source: 'claude_cli' },
      buildTools: { required: false, ok: null },
      providers: { runnable: 1 },
      dataDirectory: { ok: true, writable: true },
      sqlite: { ok: true, schemaVersion: 7 },
    })),
    getConnectionStatus: vi.fn(async () => ({})),
    listModelProviders: vi.fn(async () => ({ items: [], total: 0, limit: 25, offset: 0 })),
    onModelProviderChanged: vi.fn(() => () => undefined),
    listAgentModelPolicies: vi.fn(async () => []),
    listAgentModelPolicyReferences: vi.fn(async () => []),
    listModelTierBindings: vi.fn(async () => []),
    listModelTierCandidates: vi.fn(async () => []),
    getAgentPresetStatus: vi.fn(async () => ({ kind: 'custom' })),
    getReleaseVersion: vi.fn(async () => ({
      version: '1.0.0', buildId: 'build-1', commit: '0123456', channel: 'stable',
      electronVersion: '35.6.0', nodeVersion: '24.1.0', sqliteSchemaVersion: 7,
      agentRuntime: 'claude-code', packaged: true,
    })),
    getUpdateState: vi.fn(async () => ({ status: 'idle', version: null, reason: null, message: null })),
    getClaudeCodeUpdateState: vi.fn(async () => ({
      status: 'idle', reason: null, beforeVersion: null, afterVersion: null,
    })),
    updateClaudeCodeNow: vi.fn(async () => ({
      status: 'idle', reason: null, beforeVersion: null, afterVersion: null,
    })),
    setFirstRunResumeStep: vi.fn(async () => undefined),
    exportDiagnostics: vi.fn(async () => null),
    getGitWorkspaceStatus: vi.fn(async () => gitStatus()),
    ...overrides,
  };
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: api,
  });
  return api;
}

beforeEach(() => {
  setLocale('zh-CN');
  installApi();
  useWorkspaceStore.setState({ currentProject: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'api', { configurable: true, value: originalApi });
});

describe('Settings information architecture', () => {
  it('reopens the resumable first-run wizard from About', async () => {
    const api = installApi();
    const onClose = vi.fn();
    const onRerunFirstRun = vi.fn();
    render(<SettingsDialog initialCategory="about" onClose={onClose} onRerunFirstRun={onRerunFirstRun} />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '重新运行首次配置向导' }));

    await waitFor(() => expect(api.setFirstRunResumeStep).toHaveBeenCalledWith('welcome'));
    expect(onRerunFirstRun).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows exactly the eleven desktop product categories and no duplicate legacy owners', async () => {
    render(<SettingsDialog onClose={vi.fn()} />);
    await screen.findByRole('dialog', { name: '设置' });
    const expected = ['常规', '模型与连接', 'Agent', '项目', '权限', 'Git 与 Checkpoint', 'MCP', 'Skills', '终端与工具', '数据与诊断', '关于'];
    for (const name of expected) expect(screen.getByRole('button', { name })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Claude Code' })).toBeNull();
    expect(screen.queryByRole('button', { name: '外观' })).toBeNull();
  });

  it('routes the Project category to the current project AI settings', async () => {
    useWorkspaceStore.setState({ currentProject });
    const onClose = vi.fn();
    const onOpenProjectSettings = vi.fn();
    render(<SettingsDialog onClose={onClose} onOpenProjectSettings={onOpenProjectSettings} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: '项目' }));
    await user.click(screen.getByRole('button', { name: '打开项目 AI 设置' }));

    expect(onOpenProjectSettings).toHaveBeenCalledWith(currentProject);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('opens Models & Connections directly for first-run Provider configuration', async () => {
    const api = installApi();
    render(<SettingsDialog initialCategory="models" onClose={vi.fn()} />);
    expect(await screen.findByTestId('model-provider-center')).not.toBeNull();
    expect(screen.getByRole('button', { name: '模型与连接' }).getAttribute('aria-current')).toBe('page');
    await waitFor(() => expect(api.getClaudeCodeUpdateState).toHaveBeenCalledOnce());
    expect(api.updateClaudeCodeNow).not.toHaveBeenCalled();
  });

  it('uses a bounded, narrow-safe Settings shell without a fixed sidebar/content overflow', async () => {
    render(<SettingsDialog onClose={vi.fn()} />);
    const dialog = await screen.findByRole('dialog', { name: '设置' });
    expect(dialog.style.maxWidth).toBe('92vw');
    expect(screen.getByTestId('settings-body').className).toContain('max-sm:flex-col');
    expect(screen.getByTestId('settings-sidebar').className).toContain('max-sm:w-full');
    expect(screen.getByTestId('settings-content').className).toContain('min-w-0');
  });

  it('uses an actionable no-project state for MCP instead of a fake global setting', async () => {
    const onOpenProject = vi.fn();
    render(<SettingsDialog onClose={vi.fn()} onOpenProject={onOpenProject} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'MCP' }));
    await user.click(screen.getByRole('button', { name: '打开项目' }));
    expect(onOpenProject).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain('启用全局 MCP');
  });

  it('routes project-scoped Skills to the existing integration dialog tab', async () => {
    useWorkspaceStore.setState({ currentProject });
    const onClose = vi.fn();
    const onOpenIntegrations = vi.fn();
    render(<SettingsDialog onClose={onClose} onOpenIntegrations={onOpenIntegrations} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Skills' }));
    await user.click(screen.getByRole('button', { name: '打开 Skills 管理' }));
    await waitFor(() => expect(onOpenIntegrations).toHaveBeenCalledWith(currentProject, 'skills'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not inspect a repository when no project is open', async () => {
    const api = installApi();
    render(<SettingsDialog onClose={vi.fn()} onOpenProject={vi.fn()} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Git 与 Checkpoint' }));

    expect(screen.getByText('打开项目以检查 Git')).not.toBeNull();
    expect(api.getGitWorkspaceStatus).not.toHaveBeenCalled();
  });

  it('shows the trusted current-project repository branch and working-tree count', async () => {
    useWorkspaceStore.setState({ currentProject });
    const api = installApi({
      getGitWorkspaceStatus: vi.fn(async () => gitStatus({
        clean: false,
        files: [
          { filePath: 'src/a.ts', changeType: 'modified', statusCode: ' M', staged: false, unstaged: true, untracked: false, additions: 1, deletions: 0, statsAvailable: true, isBinary: false },
          { filePath: 'src/b.ts', changeType: 'untracked', statusCode: '??', staged: false, unstaged: true, untracked: true, additions: 2, deletions: 0, statsAvailable: true, isBinary: false },
        ],
      })),
    });
    render(<SettingsDialog onClose={vi.fn()} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Git 与 Checkpoint' }));

    expect(await screen.findByText('当前项目仓库')).not.toBeNull();
    expect(screen.getByText('main')).not.toBeNull();
    expect(screen.getByText('2 个文件有改动')).not.toBeNull();
    expect(api.getGitWorkspaceStatus).toHaveBeenCalledWith(currentProject.id, currentProject.path);
  });

  it('distinguishes a non-repository project without surfacing the IPC error', async () => {
    useWorkspaceStore.setState({ currentProject });
    installApi({
      getGitWorkspaceStatus: vi.fn(async () => {
        throw new Error("Error invoking remote method 'git-workspace:status': Selected project is not a Git repository.");
      }),
    });
    render(<SettingsDialog onClose={vi.fn()} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Git 与 Checkpoint' }));

    expect(await screen.findByText('当前项目不是 Git 仓库')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Error invoking remote method');
  });

  it('fails closed when the trusted Git status read rejects unexpectedly', async () => {
    useWorkspaceStore.setState({ currentProject });
    installApi({
      getGitWorkspaceStatus: vi.fn(async () => {
        throw new Error('C:\\private\\repository\\owner-sentinel');
      }),
    });
    render(<SettingsDialog onClose={vi.fn()} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Git 与 Checkpoint' }));

    expect((await screen.findByRole('alert')).textContent).toContain('无法读取当前项目的 Git 状态。请重试。');
    expect(document.body.textContent).not.toContain('owner-sentinel');
    expect(document.body.textContent).not.toContain('C:\\private');
  });

  it('keeps Settings open and does not route when unsaved-change confirmation is cancelled', async () => {
    useWorkspaceStore.setState({ currentProject });
    const onClose = vi.fn();
    const onOpenIntegrations = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SettingsDialog onClose={onClose} onOpenIntegrations={onOpenIntegrations} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'English' }));
    await user.click(screen.getByRole('button', { name: 'Skills' }));
    await user.click(screen.getByRole('button', { name: '打开 Skills 管理' }));

    expect(confirm).toHaveBeenCalledWith('有未保存的更改，确定要关闭吗？');
    expect(onClose).not.toHaveBeenCalled();
    expect(onOpenIntegrations).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '设置' })).not.toBeNull();
  });

  it('routes only after unsaved-change confirmation is accepted', async () => {
    useWorkspaceStore.setState({ currentProject });
    const onClose = vi.fn();
    const onOpenIntegrations = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SettingsDialog onClose={onClose} onOpenIntegrations={onOpenIntegrations} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'English' }));
    await user.click(screen.getByRole('button', { name: 'MCP' }));
    await user.click(screen.getByRole('button', { name: '打开 MCP 管理' }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onOpenIntegrations).toHaveBeenCalledWith(currentProject, 'mcp');
  });
});
