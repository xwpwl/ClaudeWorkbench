import type { IpcMain } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { WorkingTreeError } from '../../file-changes/WorkingTreeService';
import { FileMutationConflictError } from '../../file-mutations/FileMutationManager';
import { FirstRunProjectError } from '../../first-run/FirstRunService';
import { GitWorkspaceError } from '../../git/GitWorkspaceService';
import { CheckpointError } from '../../checkpoints/CheckpointManager';
import { AgentPresetServiceError } from '../../model-providers/AgentPresetService';
import {
  ModelSelectionFailure,
  ModelSwitchError,
} from '../../model-providers/ModelSelectionResolver';
import { TaskConflictError } from '../../tasks/TaskManager';
import { publicIpcFailureCodeForMessage } from '../../../shared/types/publicIpc';
import { publicIpcMainForTest } from './public-invoke-test-helper';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const UNKNOWN_ENVELOPE = {
  schemaVersion: 1,
  ok: false,
  error: { code: 'IPC_OPERATION_FAILED', message: 'The requested operation failed.' },
} as const;

function harness() {
  const handlers = new Map<string, Handler>();
  const raw = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  } as unknown as IpcMain;
  const ipcMain = publicIpcMainForTest(raw);
  const invoke = async (channel: string): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error('Test handler is unavailable.');
    return await handler({});
  };
  return { ipcMain, invoke };
}

function dirtyError() {
  const nativePath = 'C:\\Users\\PrivateProfile\\workspace\\entry.ts';
  const forwardPath = 'C:/Users/PrivateProfile/workspace/entry.ts';
  const upperPath = forwardPath.toUpperCase();
  const secret = 'private-boundary-secret';
  const error = new Error(`${nativePath} ${secret}`) as Error & {
    code?: string;
    cause?: unknown;
    privateField?: unknown;
  };
  error.stack = `Error: ${forwardPath}\n    at ${upperPath}:1:1`;
  error.cause = { path: nativePath, secret };
  error.privateField = { forwardPath, upperPath, secret };
  return { error, privateValues: [nativePath, forwardPath, upperPath, secret] };
}

describe('public invoke transport boundary', () => {
  it('does not choose one code when a fixed public message is ambiguous', () => {
    expect(publicIpcFailureCodeForMessage('Provider was not found.')).toBe('PROVIDER_NOT_FOUND');
    expect(publicIpcFailureCodeForMessage('Provider validation has expired or is invalid.'))
      .toBeNull();
    expect(publicIpcFailureCodeForMessage('C:\\Users\\PrivateProfile\\dynamic message'))
      .toBeNull();
  });

  it('returns exact success envelopes for values and undefined', async () => {
    const test = harness();
    test.ipcMain.handle('test:value', () => ({ accepted: true }));
    test.ipcMain.handle('test:undefined', () => undefined);

    const valueResult = await test.invoke('test:value');
    const undefinedResult = await test.invoke('test:undefined');
    expect(valueResult).toStrictEqual({
      schemaVersion: 1, ok: true, value: { accepted: true },
    });
    expect(undefinedResult).toStrictEqual({
      schemaVersion: 1, ok: true, value: undefined,
    });
    expect(Reflect.ownKeys(valueResult as object)).toStrictEqual([
      'schemaVersion', 'ok', 'value',
    ]);
    expect(Reflect.ownKeys(undefinedResult as object)).toStrictEqual([
      'schemaVersion', 'ok', 'value',
    ]);
    expect(Object.getPrototypeOf(valueResult)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(undefinedResult)).toBe(Object.prototype);
  });

  it('projects sync Error fields to one fixed fallback without private values', async () => {
    const test = harness();
    const dirty = dirtyError();
    test.ipcMain.handle('test:sync-error', () => { throw dirty.error; });

    const result = await test.invoke('test:sync-error').catch(() => ({ transportRejected: true }));
    expect(result).toEqual(UNKNOWN_ENVELOPE);
    const serialized = JSON.stringify(result);
    for (const value of dirty.privateValues) expect(serialized).not.toContain(value);
    expect(Object.keys(result as object)).toEqual(['schemaVersion', 'ok', 'error']);
  });

  it('projects async non-Error and authorization throws to the same fixed fallback', async () => {
    const test = harness();
    test.ipcMain.handle('test:async-error', async () => { throw 'private-async-value'; });
    test.ipcMain.handle('test:authorization-error', () => {
      const error = dirtyError().error;
      error.code = 'DYNAMIC_AUTHORIZATION_CODE';
      throw error;
    });

    const asyncResult = await test.invoke('test:async-error').catch(() => ({ transportRejected: true }));
    const authorizationResult = await test.invoke('test:authorization-error')
      .catch(() => ({ transportRejected: true }));
    expect(asyncResult).toEqual(UNKNOWN_ENVELOPE);
    expect(authorizationResult).toEqual(UNKNOWN_ENVELOPE);
    expect(JSON.stringify([asyncResult, authorizationResult])).not.toMatch(
      /private-async-value|PrivateProfile|DYNAMIC_AUTHORIZATION_CODE/iu,
    );
  });

  it('does not trust a known public code forged onto an arbitrary Error', async () => {
    const test = harness();
    const forged = dirtyError().error;
    forged.code = 'NOT_A_REPOSITORY';
    const forgedSelection = dirtyError().error;
    forgedSelection.code = 'WORKFLOW_CAPABILITY_MISSING';
    test.ipcMain.handle('test:forged-code', () => { throw forged; });
    test.ipcMain.handle('test:forged-selection-code', () => { throw forgedSelection; });

    await expect(test.invoke('test:forged-code')).resolves.toStrictEqual(UNKNOWN_ENVELOPE);
    await expect(test.invoke('test:forged-selection-code')).resolves.toStrictEqual(UNKNOWN_ENVELOPE);
  });

  it('fails closed for throwing error getters, hostile thenables, and uncloneable successes', async () => {
    const test = harness();
    const getterError = Object.create(null) as { code?: unknown };
    Object.defineProperty(getterError, 'code', {
      get: () => { throw new Error('private-getter-value'); },
    });
    const hostileThenable = Object.create(null) as { then?: unknown };
    Object.defineProperty(hostileThenable, 'then', {
      get: () => { throw new Error('private-then-value'); },
    });
    test.ipcMain.handle('test:getter-error', () => { throw getterError; });
    test.ipcMain.handle('test:hostile-thenable', () => hostileThenable);
    test.ipcMain.handle('test:uncloneable-success', () => ({ callback: () => 'private' }));

    const results = await Promise.all([
      test.invoke('test:getter-error'),
      test.invoke('test:hostile-thenable'),
      test.invoke('test:uncloneable-success'),
    ]);
    expect(results).toStrictEqual([UNKNOWN_ENVELOPE, UNKNOWN_ENVELOPE, UNKNOWN_ENVELOPE]);
    expect(JSON.stringify(results)).not.toMatch(/private-getter|private-then|callback/iu);
  });

  it('maps a runtime-invalid typed Checkpoint code to the fixed fallback envelope', async () => {
    const test = harness();
    const invalid = new CheckpointError(
      'C:\\Users\\PrivateProfile\\invalid-checkpoint-code',
      'RUNTIME_INVALID' as never,
    );
    test.ipcMain.handle('test:invalid-checkpoint-code', () => { throw invalid; });

    await expect(test.invoke('test:invalid-checkpoint-code')).resolves.toStrictEqual(
      UNKNOWN_ENVELOPE,
    );
  });

  it('returns the preflight clone so getters and later mutations cannot change the envelope', async () => {
    const test = harness();
    let getterReads = 0;
    const getterValue = {} as { payload?: unknown };
    Object.defineProperty(getterValue, 'payload', {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return getterReads === 1 ? 'safe-value' : () => 'private-getter-value';
      },
    });
    const mutableValue = { label: 'safe-label' };
    test.ipcMain.handle('test:getter-success', () => getterValue);
    test.ipcMain.handle('test:mutable-success', () => mutableValue);

    const getterResult = await test.invoke('test:getter-success') as {
      value: { payload: unknown };
    };
    const mutableResult = await test.invoke('test:mutable-success') as {
      value: { label: string };
    };
    mutableValue.label = 'private-mutated-label';

    expect(Object.getOwnPropertyDescriptor(getterResult.value, 'payload')).toStrictEqual({
      configurable: true,
      enumerable: true,
      value: 'safe-value',
      writable: true,
    });
    expect(getterReads).toBe(1);
    expect(mutableResult.value.label).toBe('safe-label');
    expect(() => structuredClone([getterResult, mutableResult])).not.toThrow();
    expect(JSON.stringify([getterResult, mutableResult]))
      .not.toMatch(/private-getter-value|private-mutated-label/iu);
  });

  it.each([
    [
      'file-changes:list',
      new WorkingTreeError('private dynamic working-tree path', 'NOT_A_REPOSITORY'),
      'NOT_A_REPOSITORY',
      'Selected project is not a Git working tree.',
    ],
    [
      'git-workspace:status',
      new GitWorkspaceError('private dynamic Git path', 'NOT_A_REPOSITORY'),
      'NOT_A_REPOSITORY',
      'Selected project is not a Git working tree.',
    ],
    [
      'model-selection:set-task-override',
      new ModelSwitchError('TASK_ACTIVE', 'private dynamic task value'),
      'TASK_ACTIVE',
      '正在运行任务时禁止切换模型。',
    ],
    [
      'agent-preset:apply',
      new AgentPresetServiceError('PRESET_ROLE_UNAVAILABLE', 'private dynamic preset value'),
      'PRESET_ROLE_UNAVAILABLE',
      'One or more Agent roles need a valid model tier binding.',
    ],
    [
      'workflow:create',
      new ModelSelectionFailure('PROVIDER_DISABLED', 'private dynamic workflow value'),
      'PROVIDER_DISABLED',
      'Provider is disabled.',
    ],
  ])('projects the allowlisted %s failure to exact code and message', async (
    channel,
    error,
    code,
    message,
  ) => {
    const test = harness();
    test.ipcMain.handle(channel, async () => { throw error; });

    const result = await test.invoke(channel).catch(() => ({ transportRejected: true }));
    expect(result).toEqual({ schemaVersion: 1, ok: false, error: { code, message } });
  });

  it.each([
    [
      new FirstRunProjectError('FIRST_RUN_PROJECT_BUSY'),
      'FIRST_RUN_PROJECT_BUSY',
      'First-run test project creation is already in progress.',
    ],
    [
      new FirstRunProjectError('FIRST_RUN_PROJECT_UNSAFE'),
      'FIRST_RUN_PROJECT_UNSAFE',
      'The first-run test project location is unsafe.',
    ],
    [
      new TaskConflictError('TASK_SESSION_BUSY', 'private-run', 'private task detail'),
      'TASK_SESSION_BUSY',
      'This task already has a running operation.',
    ],
    [
      new FileMutationConflictError('private-mutation', 'private mutation detail'),
      'TASK_PROJECT_BUSY',
      'This project already has a running task or file mutation.',
    ],
    [
      new CheckpointError('C:\\Users\\PrivateProfile\\checkpoint', 'NOT_FOUND'),
      'CHECKPOINT_NOT_FOUND',
      'Checkpoint was not found.',
    ],
    [
      new CheckpointError('C:\\Users\\PrivateProfile\\checkpoint', 'TASK_ACTIVE'),
      'CHECKPOINT_TASK_ACTIVE',
      'An active task blocks this checkpoint action.',
    ],
  ])('projects adjacent typed public failures without their dynamic message: %#', async (
    error,
    code,
    message,
  ) => {
    const test = harness();
    test.ipcMain.handle('test:adjacent-domain-error', () => { throw error; });

    const result = await test.invoke('test:adjacent-domain-error');
    expect(result).toStrictEqual({ schemaVersion: 1, ok: false, error: { code, message } });
    expect(JSON.stringify(result)).not.toMatch(/PrivateProfile|private-run|private-mutation/iu);
  });

  it.each([
    ['TIER_UNBOUND', 'The selected model tier is not bound.'],
    ['PROVIDER_DELETED', 'The selected Provider is no longer available.'],
    ['PROVIDER_DISABLED', 'Provider is disabled.'],
    ['PROVIDER_UNCONFIGURED', 'The selected Provider is not configured.'],
    ['CONNECTION_UNAVAILABLE', 'The selected Provider connection is unavailable.'],
    ['MODEL_MISSING', 'The selected model is no longer available.'],
    ['RUNTIME_INCOMPATIBLE', 'The selected model is incompatible with this Agent runtime.'],
    [
      'WORKFLOW_CAPABILITY_MISSING',
      'The selected model does not support the required workflow capability.',
    ],
    ['SOURCE_CHANGED', 'The selected model source changed and must be selected again.'],
    ['CLAUDE_CLI_UNAVAILABLE', 'Claude Code is unavailable for the selected model.'],
    ['SELECTION_UNAVAILABLE', 'The selected model is unavailable.'],
  ] as const)('projects typed model selection failure %s to one fixed message', async (
    code,
    message,
  ) => {
    const test = harness();
    test.ipcMain.handle('test:model-selection-error', () => {
      throw new ModelSelectionFailure(code, 'C:\\Users\\PrivateProfile\\dynamic selection');
    });

    const result = await test.invoke('test:model-selection-error');
    expect(result).toStrictEqual({ schemaVersion: 1, ok: false, error: { code, message } });
    expect(JSON.stringify(result)).not.toContain('PrivateProfile');
  });
});
