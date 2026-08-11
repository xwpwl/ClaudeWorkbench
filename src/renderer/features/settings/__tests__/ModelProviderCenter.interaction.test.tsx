// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderModel, PublicModelProvider } from '../../../../shared/types/modelProviders';
import { setLocale } from '../../../i18n';
import { ModelProviderCenter, ProviderEditor } from '../ModelProviderCenter';

const originalApi = window.api;

afterEach(() => {
  cleanup();
  setLocale('zh-CN');
  Object.defineProperty(window, 'api', { configurable: true, value: originalApi });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const capabilities = {
  supportsClaudeCode: true,
  supportsAgentWorkflow: true,
  supportsTools: true,
  supportsMCP: true,
  supportsStreaming: true,
  supportsVision: false,
};

function provider(id: 'a' | 'b'): PublicModelProvider {
  return {
    id: `provider-${id}`,
    name: `Provider ${id.toUpperCase()}`,
    type: 'anthropic-compatible',
    apiFormat: 'anthropic-messages',
    runtimeType: 'claude-code',
    baseUrl: `https://${id}.example.test`,
    baseUrlPathRedacted: false,
    enabled: true,
    isDefault: id === 'a',
    configured: true,
    credentialSource: 'credential_store',
    capabilities,
    supportedUses: ['chat', 'agent_task', 'claude_code', 'mcp_tools'],
    health: {
      state: 'connected',
      lastTestedAt: Date.UTC(2026, 7, 9),
      lastErrorType: null,
      latencyMs: id === 'a' ? 30 : 40,
    },
    defaultModelId: `model-${id}`,
    createdAt: 1,
    updatedAt: 2,
  };
}

function models(id: 'a' | 'b'): ProviderModel[] {
  return [{
    providerId: `provider-${id}`,
    modelId: `model-${id}`,
    displayName: `Only ${id.toUpperCase()} Detail`,
    source: 'manual',
    createdAt: 1,
    updatedAt: 1,
  }];
}

function providerPage(ids: Array<'a' | 'b'> = ['a', 'b']) {
  return {
    items: ids.map(provider),
    total: ids.length,
    limit: 25,
    offset: 0,
  };
}

function installApi(overrides: Record<string, unknown> = {}) {
  const port = {
    listModelProviders: vi.fn(async () => providerPage()),
    getModelProvider: vi.fn(async (providerId: string) => provider(providerId === 'provider-a' ? 'a' : 'b')),
    listModelProviderModels: vi.fn(async (providerId: string) => models(providerId === 'provider-a' ? 'a' : 'b')),
    onModelProviderChanged: vi.fn(() => () => undefined),
    testModelProviderConnection: vi.fn(async () => ({
      ok: true, testedAt: 1, latencyMs: 1, discoveredModelIds: [],
    })),
    setModelProviderEnabled: vi.fn(async () => provider('a')),
    setDefaultModelProvider: vi.fn(async () => provider('a')),
    deleteModelProvider: vi.fn(async () => undefined),
    ...overrides,
  };
  Object.defineProperty(window, 'api', { configurable: true, value: port });
  return port;
}

describe('ModelProviderCenter async selection identity', () => {
  it('keeps an explicit Provider B selection when an older Provider A subscription page settles', async () => {
    const stalePage = deferred<ReturnType<typeof providerPage>>();
    let emitProviderChange: () => void = () => undefined;
    const port = installApi({
      listModelProviders: vi.fn()
        .mockResolvedValueOnce(providerPage())
        .mockReturnValueOnce(stalePage.promise)
        .mockResolvedValue(providerPage()),
      onModelProviderChanged: vi.fn((listener: () => void) => {
        emitProviderChange = listener;
        return () => undefined;
      }),
    });
    render(<ModelProviderCenter />);
    const providerBButton = await screen.findByRole('button', { name: /Provider B/iu });
    await waitFor(() => expect(screen.getByText(/Only A Detail/iu)).not.toBeNull());

    act(() => {
      emitProviderChange();
      providerBButton.click();
    });
    await waitFor(() => expect(port.listModelProviders).toHaveBeenCalledTimes(2));
    await act(async () => stalePage.resolve(providerPage()));

    const currentBButton = await screen.findByRole('button', { name: /Provider B/iu });
    expect(currentBButton.getAttribute('aria-current')).toBe('true');
    const providerBCard = currentBButton.closest('article')!;
    expect(await within(providerBCard).findByText(/Only B Detail/iu)).not.toBeNull();
    await userEvent.setup().click(within(providerBCard).getByTestId('test-provider'));
    await waitFor(() => expect(port.testModelProviderConnection).toHaveBeenCalledWith('provider-b'));
    expect(port.testModelProviderConnection).not.toHaveBeenCalledWith('provider-a');
  });

  it('keeps the new Provider A incarnation across an A-to-B-to-A stale page settlement', async () => {
    const stalePage = deferred<ReturnType<typeof providerPage>>();
    let emitProviderChange: () => void = () => undefined;
    const port = installApi({
      listModelProviders: vi.fn()
        .mockResolvedValueOnce(providerPage())
        .mockReturnValueOnce(stalePage.promise)
        .mockResolvedValue(providerPage()),
      onModelProviderChanged: vi.fn((listener: () => void) => {
        emitProviderChange = listener;
        return () => undefined;
      }),
    });
    render(<ModelProviderCenter />);
    const providerAButton = await screen.findByRole('button', { name: /Provider A/iu });
    const providerBButton = screen.getByRole('button', { name: /Provider B/iu });
    await waitFor(() => expect(screen.getByText(/Only A Detail/iu)).not.toBeNull());

    act(() => {
      emitProviderChange();
      providerBButton.click();
      providerAButton.click();
    });
    await waitFor(() => expect(port.listModelProviders).toHaveBeenCalledTimes(2));
    await act(async () => stalePage.resolve(providerPage(['b'])));
    await waitFor(() => expect(port.listModelProviders).toHaveBeenCalledTimes(2));

    act(() => emitProviderChange());
    await waitFor(() => expect(port.listModelProviders).toHaveBeenCalledTimes(3));
    const currentAButton = await screen.findByRole('button', { name: /Provider A/iu });
    expect(currentAButton.getAttribute('aria-current')).toBe('true');
    const providerACard = currentAButton.closest('article')!;
    expect(await within(providerACard).findByText(/Only A Detail/iu)).not.toBeNull();
  });

  it('keeps Provider B details and actions bound to B when A details settle last', async () => {
    const user = userEvent.setup();
    const providerA = deferred<PublicModelProvider>();
    const port = installApi({
      getModelProvider: vi.fn((providerId: string) => (
        providerId === 'provider-a' ? providerA.promise : Promise.resolve(provider('b'))
      )),
    });
    render(<ModelProviderCenter />);
    await waitFor(() => expect(port.getModelProvider).toHaveBeenCalledWith('provider-a'));

    await user.click(await screen.findByRole('button', { name: /Provider B/iu }));
    const providerBCard = screen.getByRole('button', { name: /Provider B/iu }).closest('article')!;
    expect(await within(providerBCard).findByText(/Only B Detail/iu)).not.toBeNull();
    await act(async () => providerA.resolve(provider('a')));

    expect(within(providerBCard).queryByText(/Only A Detail/iu)).toBeNull();
    expect(within(providerBCard).getByText(/Only B Detail/iu)).not.toBeNull();
    await user.click(within(providerBCard).getByTestId('test-provider'));
    await waitFor(() => expect(port.testModelProviderConnection).toHaveBeenCalledWith('provider-b'));
    expect(port.testModelProviderConnection).not.toHaveBeenCalledWith('provider-a');
  });

  it('does not clear Provider B details when a stale Provider A detail request rejects', async () => {
    const user = userEvent.setup();
    const providerA = deferred<PublicModelProvider>();
    const port = installApi({
      getModelProvider: vi.fn((providerId: string) => (
        providerId === 'provider-a' ? providerA.promise : Promise.resolve(provider('b'))
      )),
    });
    render(<ModelProviderCenter />);
    await waitFor(() => expect(port.getModelProvider).toHaveBeenCalledWith('provider-a'));
    await user.click(await screen.findByRole('button', { name: /Provider B/iu }));
    const providerBCard = screen.getByRole('button', { name: /Provider B/iu }).closest('article')!;
    expect(await within(providerBCard).findByText(/Only B Detail/iu)).not.toBeNull();

    await act(async () => providerA.reject(new Error('stale A detail failure')));

    expect(within(providerBCard).getByText(/Only B Detail/iu)).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not let a stale Provider A action completion reselect A after B is current', async () => {
    const user = userEvent.setup();
    const staleAction = deferred<{ ok: true; testedAt: number; latencyMs: number; discoveredModelIds: string[] }>();
    const port = installApi({
      testModelProviderConnection: vi.fn((providerId: string) => (
        providerId === 'provider-a'
          ? staleAction.promise
          : Promise.resolve({ ok: true as const, testedAt: 1, latencyMs: 1, discoveredModelIds: [] })
      )),
    });
    render(<ModelProviderCenter />);
    const providerAButton = await screen.findByRole('button', { name: /Provider A/iu });
    const providerACard = providerAButton.closest('article')!;
    expect(await within(providerACard).findByText(/Only A Detail/iu)).not.toBeNull();
    await user.click(within(providerACard).getByTestId('test-provider'));
    expect(port.testModelProviderConnection).toHaveBeenCalledWith('provider-a');

    await user.click(screen.getByRole('button', { name: /Provider B/iu }));
    const providerBButton = screen.getByRole('button', { name: /Provider B/iu });
    const providerBCard = providerBButton.closest('article')!;
    expect(await within(providerBCard).findByText(/Only B Detail/iu)).not.toBeNull();
    await act(async () => {
      staleAction.resolve({ ok: true, testedAt: 2, latencyMs: 2, discoveredModelIds: [] });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(port.listModelProviders).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(
      screen.getByRole('button', { name: /Provider B/iu }).getAttribute('aria-current'),
    ).toBe('true'));
    const currentBCard = screen.getByRole('button', { name: /Provider B/iu }).closest('article')!;
    expect(within(currentBCard).getByText(/Only B Detail/iu)).not.toBeNull();
  });
});

describe('ProviderEditor localized failures', () => {
  it('renders both redacted-path states in Chinese while preserving Provider terminology', async () => {
    setLocale('zh-CN');
    const redactedProvider: PublicModelProvider = {
      ...provider('a'),
      baseUrl: 'https://gateway.example',
      baseUrlPathRedacted: true,
    };
    render(<ProviderEditor mode="edit" initialProvider={redactedProvider} busy={false} onCancel={vi.fn()} onSaved={vi.fn()} />);
    const user = userEvent.setup();
    const editor = screen.getByTestId('provider-editor');

    expect(editor.textContent).toContain('端点路径已隐藏；在你编辑 Base URL 前，它将保持不变。');
    expect(editor.textContent).not.toContain('Endpoint path is hidden and will remain unchanged until you edit Base URL.');
    expect(editor.textContent).toContain('Provider');
    expect(editor.textContent).toContain('Base URL');

    const baseUrlInput = screen.getByRole('textbox', { name: /Base URL/u });
    await user.clear(baseUrlInput);
    await user.type(baseUrlInput, 'https://replacement.example');

    expect(editor.textContent).toContain('此 Base URL 将在验证后替换已隐藏的端点。');
    expect(editor.textContent).not.toContain('This Base URL will replace the hidden endpoint after validation.');
  });

  it('maps a typed connection failure into the active locale instead of rendering its message', async () => {
    setLocale('en-US');
    installApi({
      validateModelProviderDraft: vi.fn(async () => ({
        validationToken: 'invalid-validation-token',
        connection: {
          ok: false,
          testedAt: 1,
          latencyMs: 12,
          discoveredModelIds: [],
          error: { type: 'invalid_key', statusCode: 401, message: '密钥错误：凭证路径' },
        },
      })),
    });
    render(<ProviderEditor mode="create" initialProvider={null} busy={false} onCancel={vi.fn()} onSaved={vi.fn()} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Name'), 'MiMo');
    await user.type(screen.getByLabelText('API Key'), 'transient-secret');
    await user.click(screen.getByTestId('validate-provider'));

    expect(await screen.findByText('Invalid API Key')).not.toBeNull();
    expect(screen.getByTestId('provider-editor').textContent).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it('renders a closed English connection-test error without leaking Han text', async () => {
    setLocale('en-US');
    installApi({
      validateModelProviderDraft: vi.fn(async () => {
        throw new Error('连接测试失败：C:\\私密路径');
      }),
    });
    render(<ProviderEditor mode="create" initialProvider={null} busy={false} onCancel={vi.fn()} onSaved={vi.fn()} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Name'), 'MiMo');
    await user.type(screen.getByLabelText('API Key'), 'transient-secret');
    await user.click(screen.getByTestId('validate-provider'));

    expect(await screen.findByText('Connection test failed.')).not.toBeNull();
    expect(screen.getByTestId('provider-editor').textContent).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it('renders a closed English edit-save error without leaking Han text', async () => {
    setLocale('en-US');
    installApi({
      validateModelProviderDraft: vi.fn(async () => ({
        validationToken: 'validation-token',
        connection: { ok: true, testedAt: 1, latencyMs: 12, discoveredModelIds: [] },
      })),
      updateModelProvider: vi.fn(async () => {
        throw new Error('保存失败：C:\\凭证路径');
      }),
    });
    render(<ProviderEditor mode="edit" initialProvider={provider('a')} busy={false} onCancel={vi.fn()} onSaved={vi.fn()} />);
    const user = userEvent.setup();

    await user.click(screen.getByTestId('validate-provider'));
    expect(await screen.findByText(/Connection succeeded/iu)).not.toBeNull();
    await user.click(screen.getByTestId('save-provider'));

    expect(await screen.findByText('Provider could not be saved.')).not.toBeNull();
    expect(screen.getByTestId('provider-editor').textContent).not.toMatch(/[\u3400-\u9fff]/u);
  });
});
