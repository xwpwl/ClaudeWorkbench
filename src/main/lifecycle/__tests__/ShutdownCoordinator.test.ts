import { describe, expect, it, vi } from 'vitest';
import { ShutdownCoordinator, type ShutdownDependencies } from '../ShutdownCoordinator';

function dependencies(overrides: Partial<ShutdownDependencies> = {}) {
  const order: string[] = [];
  const step = (name: string) => vi.fn(async () => { order.push(name); });
  const value: ShutdownDependencies = {
    stopAcceptingWork: step('stop_accepting_work'),
    closePermissions: step('close_permissions'),
    stopTasks: step('stop_tasks'),
    stopTerminals: step('stop_terminals'),
    stopProcesses: step('stop_processes'),
    waitForMutations: step('wait_for_mutations'),
    markCleanShutdown: step('mark_clean_shutdown'),
    closeDatabase: step('close_database'),
    ...overrides,
  };
  return { order, value };
}

describe('ShutdownCoordinator', () => {
  it('awaits security-sensitive shutdown stages in order before database close', async () => {
    const test = dependencies();
    const result = await new ShutdownCoordinator(test.value).shutdown('user');

    expect(result.clean).toBe(true);
    expect(test.order).toEqual([
      'stop_accepting_work', 'close_permissions', 'stop_tasks', 'stop_terminals',
      'stop_processes', 'wait_for_mutations', 'mark_clean_shutdown', 'close_database',
    ]);
  });

  it('coalesces repeated quit requests into one shutdown execution', async () => {
    let release = () => undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const test = dependencies({ stopAcceptingWork: () => blocked });
    const coordinator = new ShutdownCoordinator(test.value);

    const first = coordinator.shutdown('window_closed');
    const second = coordinator.shutdown('system');
    expect(second).toBe(first);
    release();
    const [left, right] = await Promise.all([first, second]);
    expect(right).toBe(left);
    expect(test.value.closeDatabase).toHaveBeenCalledOnce();
  });

  it('skips the clean marker after a failed critical stage but still closes the database', async () => {
    const test = dependencies({
      stopTasks: async () => { throw new Error('task stop failed'); },
    });
    const result = await new ShutdownCoordinator(test.value).shutdown('system');

    expect(result.clean).toBe(false);
    expect(result.steps.find((step) => step.name === 'stop_tasks')).toMatchObject({ status: 'failed' });
    expect(result.steps.find((step) => step.name === 'mark_clean_shutdown')).toMatchObject({ status: 'skipped' });
    expect(test.value.markCleanShutdown).not.toHaveBeenCalled();
    expect(test.value.closeDatabase).toHaveBeenCalledOnce();
  });

  it('marks a hanging stage timed out and continues fail-closed cleanup', async () => {
    const test = dependencies({ stopTerminals: () => new Promise(() => undefined) });
    const result = await new ShutdownCoordinator(test.value, { stepTimeoutMs: 5 }).shutdown('test');

    expect(result.clean).toBe(false);
    expect(result.steps.find((step) => step.name === 'stop_terminals')).toMatchObject({ status: 'timed_out' });
    expect(test.value.markCleanShutdown).not.toHaveBeenCalled();
    expect(test.value.closeDatabase).not.toHaveBeenCalled();
    expect(result.steps.find((step) => step.name === 'close_database')).toMatchObject({ status: 'skipped' });
  });
});
