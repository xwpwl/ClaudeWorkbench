// @vitest-environment jsdom

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, ReleaseVersionInfo, UpdateSnapshot } from '../../../../shared/types/ipc';
import { setLocale } from '../../../i18n';
import { AboutSection, SettingsDialog } from '../SettingsDialog';

setLocale('en-US');

const settings = {
  claudePath: 'claude', autoDetectClaude: true, claudeGitBashPath: '',
  defaultModel: '', detectedModel: '', modelSource: 'claude-default',
  defaultPermissionMode: 'standard', showDangerousPermissions: false,
  gitPath: 'git', vscodePath: 'code', terminalShell: 'powershell',
  theme: 'light', fontSize: 14, language: 'en-US', dataPath: 'C:\\WorkbenchData',
  autoCheckUpdates: false,
} satisfies AppSettings;

const version: ReleaseVersionInfo = {
  version: '1.0.0', buildId: 'build-42', commit: '0123456789abcdef', channel: 'stable',
  electronVersion: '35.6.0', nodeVersion: '24.1.0', sqliteSchemaVersion: 7,
  agentRuntime: 'claude-code', packaged: true,
};

const originalApi = window.api;

function installApi(overrides: Record<string, unknown> = {}) {
  const api = {
    getSettings: vi.fn(async () => settings),
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
    getReleaseVersion: vi.fn(async () => version),
    getUpdateState: vi.fn(async () => update('idle')),
    exportDiagnostics: vi.fn(async () => null),
    ...overrides,
  };
  Object.defineProperty(window, 'api', { configurable: true, value: api });
  return api;
}

beforeEach(() => {
  setLocale('en-US');
  installApi();
});

afterEach(() => {
  cleanup();
  setLocale('zh-CN');
  Object.defineProperty(window, 'api', { configurable: true, value: originalApi });
});

function update(status: UpdateSnapshot['status'], nextVersion: string | null = null): UpdateSnapshot {
  return { status, version: nextVersion, reason: null, message: null };
}

function markup(state: UpdateSnapshot) {
  return renderToStaticMarkup(React.createElement(AboutSection, {
    settings,
    updateSetting: vi.fn(),
    releaseInfo: version,
    updateState: state,
    busy: false,
    error: '',
    onCheck: vi.fn(),
    onDownload: vi.fn(),
    onInstall: vi.fn(),
    claudeVersion: '2.1.0',
    onExportDiagnostics: vi.fn(),
    diagnosticsBusy: false,
  }));
}

describe('release settings UI', () => {
  it('renders version, build, commit, Electron, and channel metadata', () => {
    const html = markup(update('idle'));
    for (const value of ['1.0.0', 'build-42', '0123456789abcdef', '35.6.0', 'stable', 'C:\\WorkbenchData']) {
      expect(html).toContain(value);
    }
  });

  it('truthfully renders Claude Code, diagnostics privacy, packaged state, and no bundled license', () => {
    const html = markup(update('idle'));
    expect(html).toContain('2.1.0');
    expect(html).toContain('Packaged');
    expect(html).toContain('Export ZIP');
    expect(html).toContain('Diagnostic data stays local until you explicitly export it.');
    expect(html).toContain('Optional, local, anonymous, and never uploaded.');
    expect(html).toContain('Include anonymous performance data');
    expect(html).toContain('data-testid="about-anonymous-performance"');
    expect(html).not.toContain('data-testid="about-anonymous-performance" checked=""');
    expect(html).toContain('No bundled license information');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="open-license"/);
  });

  it('forwards false by default and true only after an explicit per-export opt-in', async () => {
    const exportDiagnostics = vi.fn(async () => true);
    installApi({ exportDiagnostics });
    render(React.createElement(SettingsDialog, { initialCategory: 'about', onClose: vi.fn() }));
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('about-export-diagnostics'));
    expect(exportDiagnostics).toHaveBeenLastCalledWith({ includeAnonymousPerformanceData: false });

    await user.click(screen.getByTestId('about-anonymous-performance'));
    await user.click(screen.getByTestId('about-export-diagnostics'));
    expect(exportDiagnostics).toHaveBeenLastCalledWith({ includeAnonymousPerformanceData: true });
  });

  it('resets anonymous performance opt-in whenever the diagnostics panel reopens', async () => {
    const exportDiagnostics = vi.fn(async () => true);
    installApi({ exportDiagnostics });
    render(React.createElement(SettingsDialog, { initialCategory: 'about', onClose: vi.fn() }));
    const user = userEvent.setup();
    const checkbox = await screen.findByTestId('about-anonymous-performance') as HTMLInputElement;

    await user.click(checkbox);
    expect(checkbox.checked).toBe(true);
    await user.click(screen.getByRole('button', { name: 'General' }));
    await user.click(screen.getByRole('button', { name: 'About' }));

    const reopened = screen.getByTestId('about-anonymous-performance') as HTMLInputElement;
    expect(reopened.checked).toBe(false);
    await user.click(screen.getByTestId('about-export-diagnostics'));
    expect(exportDiagnostics).toHaveBeenLastCalledWith({ includeAnonymousPerformanceData: false });
  });

  it('keeps the Data export entry consistent and default-off', async () => {
    const exportDiagnostics = vi.fn(async () => true);
    installApi({ exportDiagnostics });
    render(React.createElement(SettingsDialog, { initialCategory: 'data', onClose: vi.fn() }));
    const user = userEvent.setup();

    expect(await screen.findByText('Optional, local, anonymous, and never uploaded.')).not.toBeNull();
    const checkbox = screen.getByTestId('data-anonymous-performance') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    await user.click(screen.getByTestId('data-export-diagnostics'));
    expect(exportDiagnostics).toHaveBeenLastCalledWith({ includeAnonymousPerformanceData: false });
  });

  it('keeps automatic update checks disabled by default', () => {
    const html = markup(update('idle'));
    expect(html).toContain('data-testid="auto-check-updates"');
    expect(html).not.toContain('data-testid="auto-check-updates" checked=""');
  });

  it('always exposes only an explicit check action when idle', () => {
    const html = markup(update('idle'));
    expect(html).toContain('data-testid="check-for-updates"');
    expect(html).not.toContain('data-testid="download-update"');
    expect(html).not.toContain('data-testid="install-update"');
  });

  it('exposes download only after an available update', () => {
    const html = markup(update('available', '1.1.0'));
    expect(html).toContain('data-testid="download-update"');
    expect(html).not.toContain('data-testid="install-update"');
  });

  it('exposes installation only after download completion', () => {
    const html = markup(update('downloaded', '1.1.0'));
    expect(html).toContain('data-testid="install-update"');
    expect(html).not.toContain('data-testid="download-update"');
  });

  it('preserves valid release facts when the independent update-state read fails', async () => {
    installApi({
      getUpdateState: vi.fn(async () => {
        throw new Error('updater-owner-path-sentinel');
      }),
    });
    render(React.createElement(SettingsDialog, { initialCategory: 'about', onClose: vi.fn() }));

    expect(await screen.findByText('build-42')).not.toBeNull();
    expect(await screen.findByText('Update status could not be loaded.')).not.toBeNull();
    expect(document.body.textContent).not.toContain('updater-owner-path-sentinel');
  });

  it('preserves valid update state when the independent release read fails', async () => {
    installApi({
      getReleaseVersion: vi.fn(async () => {
        throw new Error('C:\\private\\release-owner-sentinel');
      }),
      getUpdateState: vi.fn(async () => update('available', '1.1.0')),
    });
    render(React.createElement(SettingsDialog, { initialCategory: 'about', onClose: vi.fn() }));

    expect(await screen.findByTestId('download-update')).not.toBeNull();
    expect(await screen.findByText('Release information could not be loaded.')).not.toBeNull();
    expect(document.body.textContent).not.toContain('release-owner-sentinel');
  });

  it('shows a closed localized diagnostics error when native export fails', async () => {
    installApi({
      exportDiagnostics: vi.fn(async () => {
        throw new Error('C:\\private\\diagnostic-owner-sentinel');
      }),
    });
    render(React.createElement(SettingsDialog, { initialCategory: 'about', onClose: vi.fn() }));
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('about-export-diagnostics'));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'The diagnostics archive could not be exported. Try again.',
      );
    });
    expect(document.body.textContent).not.toContain('diagnostic-owner-sentinel');
  });
});
