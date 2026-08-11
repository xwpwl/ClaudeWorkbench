import type { IpcMain } from 'electron';
import { CheckpointError } from '../checkpoints/CheckpointManager';
import { WorkingTreeError } from '../file-changes/WorkingTreeService';
import { FileMutationConflictError } from '../file-mutations/FileMutationManager';
import { FirstRunProjectError } from '../first-run/FirstRunService';
import { GitWorkspaceError } from '../git/GitWorkspaceService';
import { AgentPresetServiceError } from '../model-providers/AgentPresetService';
import { ModelProviderServiceError } from '../model-providers/ModelProviderService';
import {
  ModelSelectionFailure,
  ModelSwitchError,
} from '../model-providers/ModelSelectionResolver';
import { TaskConflictError } from '../tasks/TaskManager';
import {
  PUBLIC_IPC_FAILURE_MESSAGES,
  PUBLIC_IPC_SCHEMA_VERSION,
  PublicIpcError,
  publicIpcFailureMessage,
  type PublicIpcEnvelope,
  type PublicIpcFailureCode,
} from '../../shared/types/publicIpc';

const publicIpcRegistrarBrand: unique symbol = Symbol('PublicIpcRegistrar');

export interface PublicIpcRegistrar extends Pick<IpcMain, 'handle' | 'removeHandler'> {
  readonly [publicIpcRegistrarBrand]: true;
}

type TypedPublicError =
  | PublicIpcError
  | CheckpointError
  | WorkingTreeError
  | FileMutationConflictError
  | FirstRunProjectError
  | GitWorkspaceError
  | AgentPresetServiceError
  | ModelProviderServiceError
  | ModelSelectionFailure
  | ModelSwitchError
  | TaskConflictError;

function isTypedPublicError(error: unknown): error is TypedPublicError {
  return error instanceof PublicIpcError
    || error instanceof CheckpointError
    || error instanceof WorkingTreeError
    || error instanceof FileMutationConflictError
    || error instanceof FirstRunProjectError
    || error instanceof GitWorkspaceError
    || error instanceof AgentPresetServiceError
    || error instanceof ModelProviderServiceError
    || error instanceof ModelSelectionFailure
    || error instanceof ModelSwitchError
    || error instanceof TaskConflictError;
}

function failureEnvelope(
  code: PublicIpcFailureCode,
): PublicIpcEnvelope<never> {
  return {
    schemaVersion: PUBLIC_IPC_SCHEMA_VERSION,
    ok: false,
    error: { code, message: PUBLIC_IPC_FAILURE_MESSAGES[code] },
  } as PublicIpcEnvelope<never>;
}

function projectFailure(error: unknown): PublicIpcEnvelope<never> {
  try {
    if (error instanceof CheckpointError) {
      const publicCodes: Readonly<Record<CheckpointError['code'], PublicIpcFailureCode>> = {
        NOT_FOUND: 'CHECKPOINT_NOT_FOUND',
        PROJECT_MISMATCH: 'CHECKPOINT_PROJECT_MISMATCH',
        SNAPSHOT_LIMIT: 'CHECKPOINT_SNAPSHOT_LIMIT',
        UNSAFE_FILE: 'CHECKPOINT_UNSAFE_FILE',
        RESTORE_BLOCKED: 'CHECKPOINT_RESTORE_BLOCKED',
        CONFIRMATION_REQUIRED: 'CHECKPOINT_CONFIRMATION_REQUIRED',
        STALE_CONFIRMATION: 'CHECKPOINT_STALE_CONFIRMATION',
        TASK_ACTIVE: 'CHECKPOINT_TASK_ACTIVE',
        COMMIT_FAILED: 'CHECKPOINT_COMMIT_FAILED',
      };
      const publicCode = publicCodes[error.code];
      return publicCode ? failureEnvelope(publicCode) : failureEnvelope('IPC_OPERATION_FAILED');
    }
    if (isTypedPublicError(error) && publicIpcFailureMessage(error.code) !== null) {
      return failureEnvelope(error.code as PublicIpcFailureCode);
    }
  } catch {
    // Error proxies/getters are untrusted diagnostic material. Ignore them.
  }
  return failureEnvelope('IPC_OPERATION_FAILED');
}

function successEnvelope<Value>(value: Value): PublicIpcEnvelope<Value> {
  const envelope = {
    schemaVersion: PUBLIC_IPC_SCHEMA_VERSION,
    ok: true,
    value,
  } satisfies PublicIpcEnvelope<Value>;
  // Electron serializes after the listener settles. Preflight here so an
  // uncloneable result is converted to the same closed failure envelope.
  return structuredClone(envelope) as PublicIpcEnvelope<Value>;
}

export function createPublicIpcMain(
  rawIpcMain: Pick<IpcMain, 'handle' | 'removeHandler'>,
): PublicIpcRegistrar {
  return {
    [publicIpcRegistrarBrand]: true,
    handle: (channel, listener) => {
      rawIpcMain.handle(channel, async (event, ...args) => {
        try {
          return successEnvelope(await listener(event, ...args));
        } catch (error) {
          return projectFailure(error);
        }
      });
    },
    removeHandler: (channel) => rawIpcMain.removeHandler(channel),
  };
}
