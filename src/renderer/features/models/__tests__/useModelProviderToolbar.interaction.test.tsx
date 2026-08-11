// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModelSelection } from '../../../../shared/types/modelProviders';
import { useModelProviderToolbar } from '../useModelProviderToolbar';

const originalApi = window.api;

afterEach(() => {
  cleanup();
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

function selection(taskId: string): ResolvedModelSelection {
  return {
    providerId: `provider-${taskId}`,
    providerName: `Provider ${taskId}`,
    modelId: `model-${taskId}`,
    runtimeType: 'claude-code',
    capabilities: {
      supportsClaudeCode: true,
      supportsAgentWorkflow: true,
      supportsTools: true,
      supportsMCP: true,
      supportsStreaming: true,
      supportsVision: false,
    },
    source: 'global_default',
    executionSource: 'database_provider',
  };
}

function installApi(overrides: Record<string, unknown> = {}) {
  const port = {
    getEffectiveModelSelection: vi.fn(async ({ taskId }: { taskId: string }) => selection(taskId)),
    listTaskModelSwitchOptions: vi.fn(async () => []),
    setTaskModelOverride: vi.fn(async ({ taskId }: { taskId: string }) => ({
      selection: selection(taskId), warning: 'future calls only',
    })),
    clearTaskModelOverride: vi.fn(async ({ taskId }: { taskId: string }) => ({
      selection: selection(taskId), warning: 'future calls only',
    })),
    onModelProviderChanged: vi.fn(() => () => undefined),
    ...overrides,
  };
  Object.defineProperty(window, 'api', { configurable: true, value: port });
  return port;
}

describe('useModelProviderToolbar task identity', () => {
  it('does not expose task A data through task B callbacks while B is loading', async () => {
    const taskB = deferred<ResolvedModelSelection>();
    installApi({
      getEffectiveModelSelection: vi.fn(({ taskId }: { taskId: string }) => (
        taskId === 'task-a' ? Promise.resolve(selection('task-a')) : taskB.promise
      )),
    });
    const rendered = renderHook(
      ({ taskId }) => useModelProviderToolbar(taskId),
      { initialProps: { taskId: 'task-a' as string | null } },
    );
    await waitFor(() => expect(rendered.result.current?.selection.providerName).toBe('Provider task-a'));

    rendered.rerender({ taskId: 'task-b' });

    expect(rendered.result.current).toBeNull();
  });

  it('keeps task B data when a superseded task A load settles last', async () => {
    const taskA = deferred<ResolvedModelSelection>();
    const taskB = deferred<ResolvedModelSelection>();
    installApi({
      getEffectiveModelSelection: vi.fn(({ taskId }: { taskId: string }) => (
        taskId === 'task-a' ? taskA.promise : taskB.promise
      )),
    });
    const rendered = renderHook(
      ({ taskId }) => useModelProviderToolbar(taskId),
      { initialProps: { taskId: 'task-a' as string | null } },
    );
    rendered.rerender({ taskId: 'task-b' });

    await act(async () => taskB.resolve(selection('task-b')));
    await waitFor(() => expect(rendered.result.current?.selection.providerName).toBe('Provider task-b'));
    await act(async () => taskA.resolve(selection('task-a')));

    expect(rendered.result.current?.selection.providerName).toBe('Provider task-b');
  });

  it('does not show a task A mutation error after moving to task B', async () => {
    const staleMutation = deferred<never>();
    installApi({ setTaskModelOverride: vi.fn(() => staleMutation.promise) });
    const rendered = renderHook(
      ({ taskId }) => useModelProviderToolbar(taskId),
      { initialProps: { taskId: 'task-a' as string | null } },
    );
    await waitFor(() => expect(rendered.result.current?.selection.providerName).toBe('Provider task-a'));
    let mutation!: Promise<unknown>;
    act(() => {
      mutation = rendered.result.current!.onSwitch({ providerId: 'next', modelId: 'next' })
        .catch((error: unknown) => error);
    });

    rendered.rerender({ taskId: 'task-b' });
    await waitFor(() => expect(rendered.result.current?.selection.providerName).toBe('Provider task-b'));
    await act(async () => staleMutation.reject(new Error('stale task A failure')));
    await mutation;

    expect(rendered.result.current?.selection.providerName).toBe('Provider task-b');
    expect(rendered.result.current?.error).toBeNull();
  });

  it('uses a task-incarnation epoch so A1 mutation errors cannot contaminate re-entered A2', async () => {
    const staleA1Mutation = deferred<never>();
    installApi({ setTaskModelOverride: vi.fn(() => staleA1Mutation.promise) });
    const rendered = renderHook(
      ({ taskId }) => useModelProviderToolbar(taskId),
      { initialProps: { taskId: 'task-a' as string | null } },
    );
    await waitFor(() => expect(rendered.result.current?.selection.providerName).toBe('Provider task-a'));
    let mutation!: Promise<unknown>;
    act(() => {
      mutation = rendered.result.current!.onSwitch({ providerId: 'next', modelId: 'next' })
        .catch((error: unknown) => error);
    });

    rendered.rerender({ taskId: 'task-b' });
    await waitFor(() => expect(rendered.result.current?.selection.providerName).toBe('Provider task-b'));
    rendered.rerender({ taskId: 'task-a' });
    await waitFor(() => expect(rendered.result.current?.selection.providerName).toBe('Provider task-a'));
    await act(async () => staleA1Mutation.reject(new Error('stale A1 failure')));
    await mutation;

    expect(rendered.result.current?.selection.providerName).toBe('Provider task-a');
    expect(rendered.result.current?.error).toBeNull();
  });
});
