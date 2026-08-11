import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import { registerRecoveryIPC, recoveryIpcInternals } from '../recovery';

const recoveryRow = {
  id: 'recovery-1',
  app_run_id: 'run',
  kind: 'workflow' as const,
  resource_id: 'workflow-1',
  project_id: 'project',
  session_id: 'session',
  task_id: 'task',
  last_state: 'executing',
  reason: 'unclean_shutdown',
  status: 'pending' as const,
  detected_at: '2026-08-01T00:00:00.000Z',
  resolved_at: null,
  resolution_json: null,
};

function harness(overrides: Record<string, unknown> = {}) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
    removeHandler: vi.fn(),
  };
  const manager = {
    appRunId: 'run',
    listRecoveryItems: vi.fn(() => [recoveryRow]),
    resume: vi.fn(async () => recoveryRow),
    abandon: vi.fn(async () => ({
      ...recoveryRow,
      status: 'abandoned' as const,
      resolved_at: '2026-08-01T00:01:00.000Z',
    })),
    ...overrides,
  };
  const openLogs = vi.fn();
  const dispose = registerRecoveryIPC(ipc as never, {
    manager: manager as never,
    abnormalExitDetected: true,
    openLogs,
  });
  return { handlers, ipc, manager, openLogs, dispose };
}

describe('recovery IPC', () => {
  it('validates renderer ids before invoking recovery authority', () => {
    expect(() => recoveryIpcInternals.validId('')).toThrow();
    expect(() => recoveryIpcInternals.validId('x\0y')).toThrow();
    expect(recoveryIpcInternals.validId('recovery-1')).toBe('recovery-1');
  });

  it('registers only bounded recovery operations and returns a disposer', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipc = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
      removeHandler: vi.fn(),
    };
    const manager = {
      appRunId: 'run',
      listRecoveryItems: vi.fn(() => []),
      resume: vi.fn(),
      abandon: vi.fn(),
    };
    const dispose = registerRecoveryIPC(ipc as never, {
      manager: manager as never,
      abnormalExitDetected: true,
      openLogs: vi.fn(),
    });
    expect(await handlers.get(IPC_CHANNELS.RECOVERY_GET)?.({})).toMatchObject({
      abnormalExitDetected: true, appRunId: 'run', items: [],
    });
    dispose();
    expect(ipc.removeHandler).toHaveBeenCalledTimes(4);
  });

  it('rejects non-string, blank, oversized, and NUL-containing ids', () => {
    for (const value of [undefined, null, 1, {}, '   ', 'x'.repeat(513), 'prefix\0suffix']) {
      expect(() => recoveryIpcInternals.validId(value)).toThrow('Recovery item id is invalid.');
    }
  });

  it('accepts the bounded renderer-id edge without rewriting its value', () => {
    const max = 'x'.repeat(512);
    expect(recoveryIpcInternals.validId(max)).toBe(max);
    expect(recoveryIpcInternals.validId(' recovery-id ')).toBe(' recovery-id ');
  });

  it('maps the database row to the renderer contract without leaking journal internals', () => {
    const view = recoveryIpcInternals.view({
      ...recoveryRow,
      resolution_json: JSON.stringify({ internal: 'must-not-leak' }),
    });

    expect(view).toEqual({
      id: 'recovery-1', kind: 'workflow', resourceId: 'workflow-1', projectId: 'project',
      sessionId: 'session', taskId: 'task', lastState: 'executing', reason: 'unclean_shutdown',
      status: 'pending', detectedAt: '2026-08-01T00:00:00.000Z', resolvedAt: null,
    });
    expect(view).not.toHaveProperty('app_run_id');
    expect(view).not.toHaveProperty('resolution_json');
  });

  it('delegates resume and abandon by validated id and maps each returned status', async () => {
    const { handlers, manager } = harness();

    const resumed = await handlers.get(IPC_CHANNELS.RECOVERY_RESUME)?.({}, 'recovery-1');
    const abandoned = await handlers.get(IPC_CHANNELS.RECOVERY_ABANDON)?.({}, 'recovery-1');

    expect(manager.resume).toHaveBeenCalledWith('recovery-1');
    expect(manager.abandon).toHaveBeenCalledWith('recovery-1');
    expect(resumed).toMatchObject({ id: 'recovery-1', status: 'pending' });
    expect(abandoned).toMatchObject({
      id: 'recovery-1', status: 'abandoned', resolvedAt: '2026-08-01T00:01:00.000Z',
    });
  });

  it('fails closed on an invalid renderer id before invoking recovery authority', async () => {
    const { handlers, manager } = harness();

    await expect(handlers.get(IPC_CHANNELS.RECOVERY_RESUME)?.({}, '../\0escape'))
      .rejects.toThrow('Recovery item id is invalid.');
    await expect(handlers.get(IPC_CHANNELS.RECOVERY_ABANDON)?.({}, ''))
      .rejects.toThrow('Recovery item id is invalid.');
    expect(manager.resume).not.toHaveBeenCalled();
    expect(manager.abandon).not.toHaveBeenCalled();
  });

  it('exposes log viewing separately and propagates recovery failures without a success view', async () => {
    const failure = new Error('fingerprint changed');
    const { handlers, manager, openLogs } = harness({
      resume: vi.fn().mockRejectedValue(failure),
    });

    await expect(handlers.get(IPC_CHANNELS.RECOVERY_RESUME)?.({}, 'recovery-1')).rejects.toBe(failure);
    await handlers.get(IPC_CHANNELS.RECOVERY_OPEN_LOGS)?.({});

    expect(manager.resume).toHaveBeenCalledOnce();
    expect(openLogs).toHaveBeenCalledOnce();
  });
});
