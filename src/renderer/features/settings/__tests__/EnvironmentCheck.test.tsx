// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentCheckResult } from '../../../../shared/types/ipc';
import { setLocale } from '../../../i18n';
import { EnvironmentCheck, EnvironmentStatusList } from '../EnvironmentCheck';

const environment: EnvironmentCheckResult = {
  node: { ok: true, version: 'v24.1.0', path: null },
  claude: { ok: true, version: '2.1.0', path: null, installType: 'local' },
  git: { ok: true, version: '2.50.0', path: null },
  gitBash: { ok: true, path: 'C:\\Program Files\\Git\\bin\\bash.exe', configured: false },
  shell: { ok: true, name: 'PowerShell', path: null },
  projectDir: { ok: true, readable: true, writable: true },
  claudeConfiguration: { ok: true, source: 'claude_cli' },
  buildTools: { required: false, ok: null },
  providers: { runnable: 2 },
  dataDirectory: { ok: true, writable: true },
  sqlite: { ok: true, schemaVersion: 7 },
};

const originalApi = window.api;

afterEach(() => {
  cleanup();
  setLocale('zh-CN');
  Object.defineProperty(window, 'api', { configurable: true, value: originalApi });
});

describe('EnvironmentStatusList', () => {
  it('labels a trusted auto-detected Git Bash as detected rather than not found', () => {
    setLocale('en-US');
    const html = renderToStaticMarkup(
      React.createElement(EnvironmentStatusList, { result: environment }),
    );

    expect(html).toContain('Git Bash');
    expect(html).toContain('Auto-detected');
    expect(html).not.toContain('Not found');
  });

  it('shows runtime, storage, and source-only build-tool readiness', () => {
    setLocale('en-US');
    const html = renderToStaticMarkup(
      React.createElement(EnvironmentStatusList, { result: environment }),
    );

    expect(html).toContain('Runnable Providers');
    expect(html).toContain('2 available');
    expect(html).toContain('Data directory');
    expect(html).toContain('SQLite schema');
    expect(html).toContain('Visual Studio Build Tools');
    expect(html).toContain('Not required');
  });

  it('does not claim every check passed when trusted Git Bash availability failed', async () => {
    setLocale('en-US');
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        checkEnvironment: vi.fn(async () => ({
          ...environment,
          gitBash: { ok: false, path: null, configured: false },
        })),
      },
    });

    render(React.createElement(EnvironmentCheck, { onClose: vi.fn() }));

    expect(await screen.findByText('Some environment checks failed. Claude Workbench may not work correctly.')).not.toBeNull();
    expect(screen.queryByText('All environment checks passed')).toBeNull();
  });
});
