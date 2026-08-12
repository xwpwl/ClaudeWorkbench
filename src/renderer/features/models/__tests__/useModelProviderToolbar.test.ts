import { describe, expect, it, vi } from 'vitest';
import type { ResolvedModelSelection } from '../../../../shared/types/modelProviders';
import type { TaskModelSwitchOptionPublic } from '../../../../shared/types/projectAi';
import {
  clearTaskModel,
  createLatestTaskModelToolbarLoader,
  loadTaskModelToolbar,
  switchTaskModel,
} from '../useModelProviderToolbar';
import * as toolbarModule from '../useModelProviderToolbar';

type MutationController<T> = {
  run(taskId: string, operation: () => Promise<T>): Promise<T>;
  deactivate(): void;
};

type MutationControllerFactory = <T>(
  getCurrentTaskId: () => string | null,
  apply: (value: T) => void,
) => MutationController<T>;

function mutationController<T>(
  getCurrentTaskId: () => string | null,
  apply: (value: T) => void,
): MutationController<T> {
  const factory = (toolbarModule as unknown as {
    createLatestTaskModelMutationController?: MutationControllerFactory;
  }).createLatestTaskModelMutationController;
  expect(factory).toBeTypeOf('function');
  return factory!(getCurrentTaskId, apply);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const capabilities = {
  supportsClaudeCode: true, supportsAgentWorkflow: true, supportsTools: true,
  supportsMCP: true, supportsStreaming: true, supportsVision: false,
};
const selection: ResolvedModelSelection = {
  providerId: 'mimo', providerName: 'MiMo', modelId: 'mimo-v2.5-pro', runtimeType: 'claude-code',
  capabilities, source: 'global_default',
};
const option: TaskModelSwitchOptionPublic = {
  providerId: 'mimo', providerName: 'MiMo', modelId: 'mimo-v2.5-pro',
  modelDisplayName: 'MiMo Pro', runtimeType: 'claude-code',
  purpose: 'task_agent_override', source: 'configured_provider',
};

function api() {
  return {
    getEffectiveModelSelection: vi.fn(async () => selection),
    listTaskModelSwitchOptions: vi.fn(async () => [option]),
    setTaskModelOverride: vi.fn(async () => ({ selection: { ...selection, source: 'task_override' as const }, warning: '模型改变只影响后续 Agent 调用。' })),
    clearTaskModelOverride: vi.fn(async () => ({ selection, warning: '模型改变只影响后续 Agent 调用。' })),
  };
}

describe('task model toolbar loader', () => {
  it('ignores an older task refresh that settles after the current request', async () => {
    let resolveFirst!: (value: string) => void;
    let resolveSecond!: (value: string) => void;
    const first = new Promise<string>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<string>((resolve) => { resolveSecond = resolve; });
    const load = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const apply = vi.fn();
    const clear = vi.fn();
    const loader = createLatestTaskModelToolbarLoader(load, apply, clear);

    const older = loader.refresh();
    const current = loader.refresh();
    resolveSecond('current-task');
    await current;
    resolveFirst('stale-task');
    await older;

    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith('current-task');
    expect(clear).not.toHaveBeenCalled();
  });

  it('loads the effective selection and main-projected task options only', async () => {
    const service = api();
    const result = await loadTaskModelToolbar(service, 'task-1');
    expect(service.getEffectiveModelSelection).toHaveBeenCalledWith({ taskId: 'task-1' });
    expect(service.listTaskModelSwitchOptions).toHaveBeenCalledWith({ taskId: 'task-1' });
    expect(result.selection).toEqual(selection);
    expect(result.options).toEqual([option]);
    expect(service).not.toHaveProperty('listModelProviders');
    expect(service).not.toHaveProperty('listModelProviderModels');
  });

  it('keeps switch options visible and marks an invalid effective override for reconfiguration', async () => {
    const service = api();
    service.getEffectiveModelSelection.mockRejectedValue(
      Object.assign(new Error('private runtime detail'), { code: 'RUNTIME_INCOMPATIBLE' }),
    );

    await expect(loadTaskModelToolbar(service, 'task-1')).resolves.toEqual({
      selection: null,
      options: [option],
      error: '该模型当前不能用于 Agent，请重新选择。',
    });
  });

  it('projects options to the closed safe display fields', async () => {
    const service = api();
    service.listTaskModelSwitchOptions.mockResolvedValue([{
      ...option,
      credentialRef: 'secret-ref',
      baseUrl: 'https://example.test/private-path',
      capabilities,
    } as never]);
    const result = await loadTaskModelToolbar(service, 'task-1');
    expect(result.options).toEqual([option]);
    expect(JSON.stringify(result.options)).not.toMatch(/credential|baseUrl|capabilities|private-path/iu);
  });

  it.each([
    ['environment' as const, `synthetic:v1:${'a'.repeat(64)}`, '环境变量'],
    ['claude_code' as const, 'claude-code:default', 'Claude Code'],
  ])('keeps a %s current selection visible without adding it to switch options', async (source, providerId, providerName) => {
    const service = api();
    service.getEffectiveModelSelection.mockResolvedValue({ ...selection, source, providerId, providerName });
    service.listTaskModelSwitchOptions.mockResolvedValue([]);
    const result = await loadTaskModelToolbar(service, 'task-1');
    expect(result.selection).toMatchObject({ providerId, providerName });
    expect(result.options).toEqual([]);
  });

  it('switches through the task-only override API and returns the trusted selection', async () => {
    const service = api();
    const result = await switchTaskModel(service, 'task-1', { providerId: 'mimo', modelId: 'mimo-v2.5-pro' });
    expect(service.setTaskModelOverride).toHaveBeenCalledWith({ taskId: 'task-1', providerId: 'mimo', modelId: 'mimo-v2.5-pro' });
    expect(result.source).toBe('task_override');
  });

  it('projects display-only option fields out before strict task override IPC', async () => {
    const service = api();
    await switchTaskModel(service, 'task-1', {
      providerId: 'mimo', modelId: 'mimo-v2.5-pro', providerName: 'MiMo',
    });
    expect(service.setTaskModelOverride).toHaveBeenCalledWith({
      taskId: 'task-1', providerId: 'mimo', modelId: 'mimo-v2.5-pro',
    });
    expect(service.setTaskModelOverride.mock.calls[0][0]).not.toHaveProperty('providerName');
  });

  it('clears a task override through its dedicated API', async () => {
    const service = api();
    const result = await clearTaskModel(service, 'task-1');
    expect(service.clearTaskModelOverride).toHaveBeenCalledWith({ taskId: 'task-1' });
    expect(result.source).toBe('global_default');
  });
});

describe('task model toolbar mutations', () => {
  it('ignores a task A switch result after task B becomes current', async () => {
    let currentTaskId: string | null = 'task-a';
    const visible: string[] = [];
    const controller = mutationController(() => currentTaskId, (value: string) => {
      visible.push(value);
    });
    const taskA = deferred<string>();
    const taskB = deferred<string>();

    const switchA = controller.run('task-a', () => taskA.promise);
    currentTaskId = 'task-b';
    const switchB = controller.run('task-b', () => taskB.promise);
    taskB.resolve('task-b-selection');
    await switchB;
    taskA.resolve('task-a-selection');
    await switchA;

    expect(visible).toEqual(['task-b-selection']);
  });

  it('keeps the newer same-task switch when two results settle in reverse order', async () => {
    const visible: string[] = [];
    const controller = mutationController(() => 'task-a', (value: string) => {
      visible.push(value);
    });
    const older = deferred<string>();
    const newer = deferred<string>();

    const firstSwitch = controller.run('task-a', () => older.promise);
    const secondSwitch = controller.run('task-a', () => newer.promise);
    newer.resolve('newer-selection');
    await secondSwitch;
    older.resolve('older-selection');
    await firstSwitch;

    expect(visible).toEqual(['newer-selection']);
  });

  it('keeps a newer clear result when an older switch settles last', async () => {
    const visible: string[] = [];
    const controller = mutationController(() => 'task-a', (value: string) => {
      visible.push(value);
    });
    const switchResult = deferred<string>();
    const clearResult = deferred<string>();

    const switchModel = controller.run('task-a', () => switchResult.promise);
    const clearModel = controller.run('task-a', () => clearResult.promise);
    clearResult.resolve('policy-selection');
    await clearModel;
    switchResult.resolve('stale-task-override');
    await switchModel;

    expect(visible).toEqual(['policy-selection']);
  });

  it('applies an older success when the newer mutation fails first', async () => {
    const visible: string[] = [];
    const controller = mutationController(() => 'task-a', (value: string) => {
      visible.push(value);
    });
    const older = deferred<string>();
    const newer = deferred<string>();

    const olderSwitch = controller.run('task-a', () => older.promise);
    const newerSwitch = controller.run('task-a', () => newer.promise);
    newer.reject(new Error('newer failed'));
    await expect(newerSwitch).rejects.toThrow('newer failed');
    older.resolve('persisted-older-selection');
    await olderSwitch;

    expect(visible).toEqual(['persisted-older-selection']);
  });

  it('defers an older success until the pending newer mutation fails', async () => {
    const visible: string[] = [];
    const controller = mutationController(() => 'task-a', (value: string) => {
      visible.push(value);
    });
    const older = deferred<string>();
    const newer = deferred<string>();

    const olderSwitch = controller.run('task-a', () => older.promise);
    const newerSwitch = controller.run('task-a', () => newer.promise);
    older.resolve('persisted-older-selection');
    await olderSwitch;
    expect(visible).toEqual([]);

    newer.reject(new Error('newer failed'));
    await expect(newerSwitch).rejects.toThrow('newer failed');
    expect(visible).toEqual(['persisted-older-selection']);
  });
});
