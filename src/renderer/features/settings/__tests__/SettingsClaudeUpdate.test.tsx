// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppSettings,
  ClaudeCodeUpdateReason,
  ClaudeCodeUpdateSnapshot,
  EnvironmentCheckResult,
} from '../../../../shared/types/ipc';
import { setLocale } from '../../../i18n';
import { SettingsDialog } from '../SettingsDialog';

const settings = {
  claudePath: 'claude', autoDetectClaude: true, claudeGitBashPath: '',
  defaultModel: '', detectedModel: '', modelSource: 'claude-default',
  defaultPermissionMode: 'standard', showDangerousPermissions: false,
  gitPath: 'git', vscodePath: 'code', terminalShell: 'powershell',
  theme: 'light', fontSize: 14, language: 'zh-CN', dataPath: '', autoCheckUpdates: false,
} satisfies AppSettings;

const installedEnvironment: EnvironmentCheckResult = {
  node: { ok: true, version: 'v24.1.0', path: null },
  claude: { ok: true, version: '2.1.218', path: 'C:\\safe\\claude.exe', installType: 'native' },
  git: { ok: true, version: '2.50.0', path: null },
  gitBash: { ok: true, path: null, configured: false },
  shell: { ok: true, name: 'PowerShell', path: null },
  projectDir: { ok: true, readable: true, writable: true },
  claudeConfiguration: { ok: true, source: 'claude_cli' },
  buildTools: { required: false, ok: null },
  providers: { runnable: 1 },
  dataDirectory: { ok: true, writable: true },
  sqlite: { ok: true, schemaVersion: 7 },
};

const idleSnapshot: ClaudeCodeUpdateSnapshot = {
  status: 'idle', reason: null, beforeVersion: null, afterVersion: null,
};

const originalApi = window.api;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function installApi(overrides: Record<string, unknown> = {}) {
  const api = {
    getSettings: vi.fn(async () => settings),
    setSettings: vi.fn(async () => undefined),
    checkEnvironment: vi.fn(async () => installedEnvironment),
    getConnectionStatus: vi.fn(async () => ({})),
    getClaudeCodeUpdateState: vi.fn(async () => idleSnapshot),
    updateClaudeCodeNow: vi.fn(async () => idleSnapshot),
    listModelProviders: vi.fn(async () => ({ items: [], total: 0, limit: 25, offset: 0 })),
    onModelProviderChanged: vi.fn(() => () => undefined),
    listAgentModelPolicies: vi.fn(async () => []),
    listAgentModelPolicyReferences: vi.fn(async () => []),
    listModelTierBindings: vi.fn(async () => []),
    listModelTierCandidates: vi.fn(async () => []),
    getAgentPresetStatus: vi.fn(async () => ({ kind: 'custom' })),
    ...overrides,
  };
  Object.defineProperty(window, 'api', { configurable: true, value: api });
  return api;
}

async function renderModels() {
  render(<SettingsDialog initialCategory="models" onClose={vi.fn()} />);
  return screen.findByTestId('claude-code-update-now');
}

beforeEach(() => {
  setLocale('zh-CN');
  installApi();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'api', { configurable: true, value: originalApi });
});

describe('Settings manual Claude Code update', () => {
  it('loads bounded state only in Models and never updates on open, navigation, or state read', async () => {
    const api = installApi();
    render(<SettingsDialog onClose={vi.fn()} />);

    await screen.findByRole('dialog', { name: '设置' });
    expect(api.getClaudeCodeUpdateState).not.toHaveBeenCalled();
    expect(api.updateClaudeCodeNow).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: '模型与连接' }));
    await screen.findByTestId('claude-code-update-now');
    expect(api.getClaudeCodeUpdateState).toHaveBeenCalledOnce();
    expect(api.updateClaudeCodeNow).not.toHaveBeenCalled();
  });

  it('announces bounded update status changes politely', async () => {
    await renderModels();

    const status = await screen.findByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toContain('不会自动更新');
  });

  it('starts exactly one update from an explicit click and stays single-flight on a double click', async () => {
    const update = deferred<ClaudeCodeUpdateSnapshot>();
    const api = installApi({ updateClaudeCodeNow: vi.fn(() => update.promise) });
    const button = await renderModels();

    expect(api.updateClaudeCodeNow).not.toHaveBeenCalled();
    fireEvent.click(button);
    fireEvent.click(button);

    expect(api.updateClaudeCodeNow).toHaveBeenCalledOnce();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent).toContain('正在更新…');
    expect(api.setSettings).not.toHaveBeenCalled();
  });

  it('keeps unavailable and fake-runtime state disabled even when the host environment reports Claude installed', async () => {
    installApi({
      getClaudeCodeUpdateState: vi.fn(async () => ({
        status: 'unavailable', reason: 'unsupported_installation', beforeVersion: null, afterVersion: null,
      } satisfies ClaudeCodeUpdateSnapshot)),
    });

    const button = await renderModels();
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText('当前安装不支持安全的自更新。')).not.toBeNull();
  });

  it('disables the action when the environment has no installed Claude CLI', async () => {
    installApi({
      checkEnvironment: vi.fn(async () => ({
        ...installedEnvironment,
        claude: { ok: false, version: null, path: null, installType: null },
      } satisfies EnvironmentCheckResult)),
    });

    const button = await renderModels();
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
  });

  it('fails closed with localized text when bounded state cannot be loaded', async () => {
    const api = installApi({
      getClaudeCodeUpdateState: vi.fn(async () => {
        throw new Error('C:\\private\\state-load-sentinel');
      }),
    });

    const button = await renderModels();

    expect(await screen.findByText('无法读取 Claude Code 更新状态。')).not.toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(api.updateClaudeCodeNow).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('state-load-sentinel');
  });

  it('maps an update transport rejection to a fixed error and releases the UI single-flight state', async () => {
    installApi({
      updateClaudeCodeNow: vi.fn(async () => {
        throw new Error('token-owner-transport-sentinel');
      }),
    });
    const button = await renderModels();

    await userEvent.click(button);

    expect(await screen.findByText('Claude Code 更新失败。')).not.toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(document.body.textContent).not.toContain('token-owner-transport-sentinel');
  });

  it.each([
    ['updated', '2.1.219', '更新完成。 2.1.218 → 2.1.219'],
    ['up_to_date', '2.1.218', '已是最新版本。'],
  ] as const)('refreshes environment exactly once after %s', async (status, afterVersion, message) => {
    const refreshedEnvironment = {
      ...installedEnvironment,
      claude: { ...installedEnvironment.claude, version: afterVersion },
    } satisfies EnvironmentCheckResult;
    const checkEnvironment = vi.fn()
      .mockResolvedValueOnce(installedEnvironment)
      .mockResolvedValueOnce(refreshedEnvironment);
    installApi({
      checkEnvironment,
      updateClaudeCodeNow: vi.fn(async () => ({
        status, reason: null, beforeVersion: '2.1.218', afterVersion,
      } satisfies ClaudeCodeUpdateSnapshot)),
    });
    const button = await renderModels();

    await userEvent.click(button);

    expect(await screen.findByText(message)).not.toBeNull();
    await waitFor(() => expect(checkEnvironment).toHaveBeenCalledTimes(2));
    expect(screen.getByText(afterVersion)).not.toBeNull();
  });

  it('preserves a verified update result when the one environment refresh fails', async () => {
    const checkEnvironment = vi.fn()
      .mockResolvedValueOnce(installedEnvironment)
      .mockRejectedValueOnce(new Error('C:\\private\\refresh-error-sentinel'));
    installApi({
      checkEnvironment,
      updateClaudeCodeNow: vi.fn(async () => ({
        status: 'up_to_date', reason: null, beforeVersion: '2.1.218', afterVersion: '2.1.218',
      } satisfies ClaudeCodeUpdateSnapshot)),
    });
    const button = await renderModels();

    await userEvent.click(button);

    expect(await screen.findByText('已是最新版本。')).not.toBeNull();
    expect(checkEnvironment).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain('refresh-error-sentinel');
    expect(document.body.textContent).not.toContain('C:\\private');
  });

  it.each([
    ['active_tasks', 'Claude Code 正在执行任务，请在任务结束后重试。'],
    ['runtime_busy', 'Claude Code 正在完成本地检查，请稍后重试。'],
    ['not_installed', '未检测到 Claude Code。'],
    ['unsupported_installation', '当前安装不支持安全的自更新。'],
    ['identity_changed', '更新后安装身份发生变化，结果未被接受。'],
    ['invalid_version', '无法验证更新后的 Claude Code 版本。'],
    ['permission_denied', '没有权限更新 Claude Code。'],
    ['timed_out', 'Claude Code 更新超时。'],
    ['cleanup_unconfirmed', '无法确认更新进程已完全退出；本次会话已禁用更新。'],
    ['update_failed', 'Claude Code 更新失败。'],
  ] satisfies ReadonlyArray<readonly [Exclude<ClaudeCodeUpdateReason, null>, string]>)
  ('renders fixed localized text for %s without refreshing the environment', async (reason, expected) => {
    const checkEnvironment = vi.fn(async () => installedEnvironment);
    installApi({
      checkEnvironment,
      updateClaudeCodeNow: vi.fn(async () => ({
        status: reason === 'active_tasks' || reason === 'runtime_busy' ? 'blocked' : reason === 'not_installed' || reason === 'unsupported_installation' ? 'unavailable' : 'error',
        reason,
        beforeVersion: null,
        afterVersion: null,
      } satisfies ClaudeCodeUpdateSnapshot)),
    });
    const button = await renderModels();

    if (!button.hasAttribute('disabled')) await userEvent.click(button);

    expect(await screen.findByText(expected)).not.toBeNull();
    expect(checkEnvironment).toHaveBeenCalledOnce();
  });

  it('never renders raw updater fields, paths, stderr, or tokens', async () => {
    const rawSnapshot = {
      status: 'error', reason: 'update_failed', beforeVersion: null, afterVersion: null,
      executable: 'C:\\private\\claude.exe',
      stderr: 'stderr-owner-sentinel',
      token: 'token-owner-sentinel',
      message: 'arbitrary-main-message-sentinel',
    } as ClaudeCodeUpdateSnapshot;
    installApi({ updateClaudeCodeNow: vi.fn(async () => rawSnapshot) });
    const button = await renderModels();

    await userEvent.click(button);
    expect(await screen.findByText('Claude Code 更新失败。')).not.toBeNull();
    expect(document.body.textContent).not.toContain('C:\\private');
    expect(document.body.textContent).not.toContain('stderr-owner-sentinel');
    expect(document.body.textContent).not.toContain('token-owner-sentinel');
    expect(document.body.textContent).not.toContain('arbitrary-main-message-sentinel');
  });

  it('keeps cleanup-unconfirmed disabled for the rest of the mounted session', async () => {
    installApi({
      getClaudeCodeUpdateState: vi.fn(async () => ({
        status: 'error', reason: 'cleanup_unconfirmed', beforeVersion: null, afterVersion: null,
      } satisfies ClaudeCodeUpdateSnapshot)),
    });
    const button = await renderModels();

    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(button);
    expect(window.api.updateClaudeCodeNow).not.toHaveBeenCalled();
  });

  it('ignores a late successful update after unmount and does not refresh the environment', async () => {
    const update = deferred<ClaudeCodeUpdateSnapshot>();
    const checkEnvironment = vi.fn(async () => installedEnvironment);
    installApi({ checkEnvironment, updateClaudeCodeNow: vi.fn(() => update.promise) });
    const view = render(<SettingsDialog initialCategory="models" onClose={vi.fn()} />);
    const button = await screen.findByTestId('claude-code-update-now');
    await userEvent.click(button);
    view.unmount();

    await act(async () => {
      update.resolve({ status: 'updated', reason: null, beforeVersion: '2.1.218', afterVersion: '2.1.219' });
      await update.promise;
    });

    expect(checkEnvironment).toHaveBeenCalledOnce();
  });

  it('does not let an older Models state request overwrite a newer category visit', async () => {
    const first = deferred<ClaudeCodeUpdateSnapshot>();
    const unavailable: ClaudeCodeUpdateSnapshot = {
      status: 'unavailable', reason: 'unsupported_installation', beforeVersion: null, afterVersion: null,
    };
    const getState = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(unavailable);
    installApi({ getClaudeCodeUpdateState: getState });
    render(<SettingsDialog initialCategory="models" onClose={vi.fn()} />);

    await screen.findByRole('button', { name: '模型与连接' });
    await userEvent.click(screen.getByRole('button', { name: '常规' }));
    await userEvent.click(screen.getByRole('button', { name: '模型与连接' }));
    const button = await screen.findByTestId('claude-code-update-now');
    await waitFor(() => expect(screen.getByText('当前安装不支持安全的自更新。')).not.toBeNull());

    await act(async () => {
      first.resolve(idleSnapshot);
      await first.promise;
    });

    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('当前安装不支持安全的自更新。')).not.toBeNull();
  });

  it('reconciles an in-flight update across category navigation without a stale state read', async () => {
    const update = deferred<ClaudeCodeUpdateSnapshot>();
    const checkEnvironment = vi.fn(async () => installedEnvironment);
    const getState = vi.fn(async () => idleSnapshot);
    const api = installApi({
      checkEnvironment,
      getClaudeCodeUpdateState: getState,
      updateClaudeCodeNow: vi.fn(() => update.promise),
    });
    render(<SettingsDialog initialCategory="models" onClose={vi.fn()} />);
    const user = userEvent.setup();
    const initialButton = await screen.findByTestId('claude-code-update-now');
    await waitFor(() => expect((initialButton as HTMLButtonElement).disabled).toBe(false));

    await user.click(initialButton);
    await user.click(screen.getByRole('button', { name: '常规' }));
    await user.click(screen.getByRole('button', { name: '模型与连接' }));

    const returnedButton = await screen.findByTestId('claude-code-update-now');
    expect((returnedButton as HTMLButtonElement).disabled).toBe(true);
    expect(returnedButton.textContent).toContain('正在更新…');
    expect(getState).toHaveBeenCalledOnce();

    await act(async () => {
      update.resolve({ status: 'updated', reason: null, beforeVersion: '2.1.218', afterVersion: '2.1.219' });
      await update.promise;
    });

    expect(await screen.findByText('更新完成。 2.1.218 → 2.1.219')).not.toBeNull();
    await waitFor(() => expect(checkEnvironment).toHaveBeenCalledTimes(2));
    expect((returnedButton as HTMLButtonElement).disabled).toBe(false);
    expect(api.updateClaudeCodeNow).toHaveBeenCalledOnce();
    expect(getState).toHaveBeenCalledOnce();
  });

  it('revokes an old actionable snapshot when a later Models state read fails', async () => {
    const getState = vi.fn()
      .mockResolvedValueOnce(idleSnapshot)
      .mockRejectedValueOnce(new Error('C:\\private\\reentry-state-sentinel'));
    const api = installApi({ getClaudeCodeUpdateState: getState });
    render(<SettingsDialog initialCategory="models" onClose={vi.fn()} />);
    const user = userEvent.setup();
    const initialButton = await screen.findByTestId('claude-code-update-now');
    await waitFor(() => expect((initialButton as HTMLButtonElement).disabled).toBe(false));

    await user.click(screen.getByRole('button', { name: '常规' }));
    await user.click(screen.getByRole('button', { name: '模型与连接' }));

    const returnedButton = await screen.findByTestId('claude-code-update-now');
    expect(await screen.findByText('无法读取 Claude Code 更新状态。')).not.toBeNull();
    expect((returnedButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(returnedButton);
    expect(api.updateClaudeCodeNow).not.toHaveBeenCalled();
    expect(getState).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain('reentry-state-sentinel');
  });
});
