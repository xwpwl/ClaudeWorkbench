export const PUBLIC_IPC_SCHEMA_VERSION = 1 as const;

/**
 * Closed main-to-renderer failure vocabulary. Messages are derived from the
 * code on both sides of the transport; arbitrary Error text never crosses IPC.
 */
export const PUBLIC_IPC_FAILURE_MESSAGES = Object.freeze({
  IPC_OPERATION_FAILED: 'The requested operation failed.',
  NOT_A_REPOSITORY: 'Selected project is not a Git working tree.',
  TASK_ACTIVE: '正在运行任务时禁止切换模型。',
  PRESET_ROLE_UNAVAILABLE: 'One or more Agent roles need a valid model tier binding.',
  PROVIDER_DISABLED: 'Provider is disabled.',
  TIER_UNBOUND: 'The selected model tier is not bound.',
  PROVIDER_DELETED: 'The selected Provider is no longer available.',
  PROVIDER_UNCONFIGURED: 'The selected Provider is not configured.',
  CONNECTION_UNAVAILABLE: 'The selected Provider connection is unavailable.',
  MODEL_MISSING: 'The selected model is no longer available.',
  RUNTIME_INCOMPATIBLE: 'The selected model is incompatible with this Agent runtime.',
  WORKFLOW_CAPABILITY_MISSING:
    'The selected model does not support the required workflow capability.',
  SOURCE_CHANGED: 'The selected model source changed and must be selected again.',
  CLAUDE_CLI_UNAVAILABLE: 'Claude Code is unavailable for the selected model.',
  SELECTION_UNAVAILABLE: 'The selected model is unavailable.',
  TIER_CANDIDATE_INVALID: 'The selected model is not an available Agent candidate.',
  PROJECT_NOT_FOUND: 'The selected project was not found.',
  TIER_BINDING_WRITE_FAILED: 'The model tier binding could not be saved.',
  TIER_BINDING_CLEAR_FAILED: 'The project model tier binding could not be cleared.',
  INVALID_PRESET_REQUEST: 'The Agent template request is invalid.',
  PREVIEW_STALE: 'The Agent template preview is out of date.',
  PREVIEW_CONFIRMATION_REQUIRED: 'Applying this template requires preview confirmation.',
  OVERWRITE_CONFIRMATION_REQUIRED: 'Reapplying this template requires confirmation.',
  PRESET_PREVIEW_FAILED: 'The Agent template preview could not be prepared.',
  PRESET_APPLY_FAILED: 'The Agent template could not be applied.',
  PRESET_STATUS_FAILED: 'The Agent template status could not be read.',
  INVALID_DRAFT: 'Provider configuration is invalid.',
  PROVIDER_NOT_FOUND: 'Provider was not found.',
  PROVIDER_IN_USE: 'Provider is currently in use.',
  INVALID_VALIDATION_TOKEN: 'Provider validation has expired or is invalid.',
  EXPIRED_VALIDATION_TOKEN: 'Provider validation has expired or is invalid.',
  TOKEN_PROVIDER_MISMATCH: 'Provider validation does not match this Provider.',
  STALE_PROVIDER: 'Provider changed after validation. Test the connection again.',
  CREDENTIAL_REENTRY_REQUIRED: 'Provider credential entry is required.',
  DELETE_CONFIRMATION_REQUIRED: 'Credential deletion confirmation is required.',
  UNSUPPORTED_RUNTIME: 'Provider is unavailable for Agent execution.',
  CREDENTIAL_CLEANUP_PENDING: 'Credential cleanup is pending.',
  INVALID_POLICY: 'Model policy configuration is invalid.',
  INVALID_SELECTION: 'The selected model is invalid.',
  INVALID_MODEL_CONFIGURATION_REQUEST: 'Invalid model configuration request.',
  TASK_NOT_FOUND: 'Task was not found.',
  MODEL_POLICY_REFERENCES_FAILED: 'Agent model policy references could not be listed.',
  PROJECT_AI_CONFIGURATION_FAILED: 'Project AI configuration could not be read.',
  MODEL_PROVIDER_OPERATION_FAILED: 'Model Provider operation failed.',
  FIRST_RUN_PROJECT_BUSY: 'First-run test project creation is already in progress.',
  FIRST_RUN_PROJECT_UNSAFE: 'The first-run test project location is unsafe.',
  FIRST_RUN_PROJECT_CREATE_FAILED: 'Unable to create the first-run test project.',
  FIRST_RUN_PROJECT_ROLLBACK_FAILED: 'Unable to safely roll back first-run test project creation.',
  SESSION_CREATE_INVALID: 'Invalid Session create request.',
  TASK_SESSION_BUSY: 'This task already has a running operation.',
  TASK_PROJECT_BUSY: 'This project already has a running task or file mutation.',
  CHECKPOINT_NOT_FOUND: 'Checkpoint was not found.',
  CHECKPOINT_PROJECT_MISMATCH: 'Checkpoint project identity does not match the task.',
  CHECKPOINT_SNAPSHOT_LIMIT: 'Checkpoint exceeds the snapshot safety limit.',
  CHECKPOINT_UNSAFE_FILE: 'Checkpoint contains an unsafe file.',
  CHECKPOINT_RESTORE_BLOCKED: 'Checkpoint restore is blocked.',
  CHECKPOINT_CONFIRMATION_REQUIRED: 'Checkpoint action requires confirmation.',
  CHECKPOINT_STALE_CONFIRMATION: 'Checkpoint confirmation is stale.',
  CHECKPOINT_TASK_ACTIVE: 'An active task blocks this checkpoint action.',
  CHECKPOINT_COMMIT_FAILED: 'Checkpoint commit failed.',
  PATH_NOT_ALLOWED: 'Requested path is not allowed.',
  OPEN_PATH_FAILED: 'Unable to open the requested path.',
  OPEN_VSCODE_FAILED: 'Unable to open the requested path in VS Code.',
} as const);

export type PublicIpcFailureCode = keyof typeof PUBLIC_IPC_FAILURE_MESSAGES;
export type PublicIpcFailure = {
  [Code in PublicIpcFailureCode]: {
    code: Code;
    message: (typeof PUBLIC_IPC_FAILURE_MESSAGES)[Code];
  };
}[PublicIpcFailureCode];

export type PublicIpcSuccessEnvelope<Value> = {
  schemaVersion: typeof PUBLIC_IPC_SCHEMA_VERSION;
  ok: true;
  value: Value;
};

export type PublicIpcFailureEnvelope = {
  schemaVersion: typeof PUBLIC_IPC_SCHEMA_VERSION;
  ok: false;
  error: PublicIpcFailure;
};

export type PublicIpcEnvelope<Value> =
  | PublicIpcSuccessEnvelope<Value>
  | PublicIpcFailureEnvelope;

export const PUBLIC_IPC_TRANSPORT_FAILURE_MESSAGES = Object.freeze({
  ...PUBLIC_IPC_FAILURE_MESSAGES,
  IPC_RESPONSE_INVALID: 'Invalid response from the main process.',
  IPC_TRANSPORT_FAILED: 'The main process did not return a response.',
} as const);

export type PublicIpcTransportFailureCode =
  keyof typeof PUBLIC_IPC_TRANSPORT_FAILURE_MESSAGES;
export type PublicIpcTransportFailure = {
  [Code in PublicIpcTransportFailureCode]: {
    code: Code;
    message: (typeof PUBLIC_IPC_TRANSPORT_FAILURE_MESSAGES)[Code];
  };
}[PublicIpcTransportFailureCode];
export type PublicIpcTransportFailureEnvelope = {
  schemaVersion: typeof PUBLIC_IPC_SCHEMA_VERSION;
  ok: false;
  error: PublicIpcTransportFailure;
};
export type PublicIpcTransportEnvelope<Value> =
  | PublicIpcSuccessEnvelope<Value>
  | PublicIpcTransportFailureEnvelope;

type OwnDataValue =
  | { found: true; value: unknown }
  | { found: false };

function isPlainRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(
  value: Record<PropertyKey, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === expected.length
    && expected.every((key) => actual.includes(key));
}

function ownEnumerableDataValue(
  value: Record<PropertyKey, unknown>,
  key: string,
): OwnDataValue {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined
    && descriptor.enumerable
    && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? { found: true, value: descriptor.value }
    : { found: false };
}

export function publicIpcTransportFailureMessage(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(PUBLIC_IPC_TRANSPORT_FAILURE_MESSAGES, code)
    ? PUBLIC_IPC_TRANSPORT_FAILURE_MESSAGES[code as PublicIpcTransportFailureCode]
    : null;
}

export function createPublicIpcTransportFailureEnvelope<
  Code extends PublicIpcTransportFailureCode,
>(code: Code): PublicIpcTransportFailureEnvelope {
  return {
    schemaVersion: PUBLIC_IPC_SCHEMA_VERSION,
    ok: false,
    error: {
      code,
      message: PUBLIC_IPC_TRANSPORT_FAILURE_MESSAGES[code],
    } as PublicIpcTransportFailure,
  };
}

export function createPublicIpcTransportSuccessEnvelope<Value>(
  value: Value,
): PublicIpcSuccessEnvelope<Value> {
  return {
    schemaVersion: PUBLIC_IPC_SCHEMA_VERSION,
    ok: true,
    value,
  };
}

export function normalizePublicIpcTransportEnvelope<Value = unknown>(
  response: unknown,
): PublicIpcTransportEnvelope<Value> | null {
  try {
    if (!isPlainRecord(response)) return null;
    const schemaVersion = ownEnumerableDataValue(response, 'schemaVersion');
    const ok = ownEnumerableDataValue(response, 'ok');
    if (!schemaVersion.found || schemaVersion.value !== PUBLIC_IPC_SCHEMA_VERSION || !ok.found) {
      return null;
    }
    if (ok.value === true && hasExactKeys(response, ['schemaVersion', 'ok', 'value'])) {
      const value = ownEnumerableDataValue(response, 'value');
      if (!value.found) return null;
      return createPublicIpcTransportSuccessEnvelope(value.value as Value);
    }
    if (ok.value !== false || !hasExactKeys(response, ['schemaVersion', 'ok', 'error'])) {
      return null;
    }
    const nested = ownEnumerableDataValue(response, 'error');
    if (!nested.found || !isPlainRecord(nested.value)
      || !hasExactKeys(nested.value, ['code', 'message'])) return null;
    const code = ownEnumerableDataValue(nested.value, 'code');
    const message = ownEnumerableDataValue(nested.value, 'message');
    const fixedMessage = code.found ? publicIpcTransportFailureMessage(code.value) : null;
    if (!code.found || !message.found || fixedMessage === null || message.value !== fixedMessage) {
      return null;
    }
    return createPublicIpcTransportFailureEnvelope(
      code.value as PublicIpcTransportFailureCode,
    ) as PublicIpcTransportEnvelope<Value>;
  } catch {
    return null;
  }
}

export function publicIpcFailureMessage(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(PUBLIC_IPC_FAILURE_MESSAGES, code)
    ? PUBLIC_IPC_FAILURE_MESSAGES[code as PublicIpcFailureCode]
    : null;
}

export function isPublicIpcFailurePair(code: unknown, message: unknown): boolean {
  const primary = publicIpcFailureMessage(code);
  return primary !== null && typeof message === 'string' && message === primary;
}

export function publicIpcFailureCodeForMessage(message: unknown): PublicIpcFailureCode | null {
  if (typeof message !== 'string') return null;
  let match: PublicIpcFailureCode | null = null;
  for (const [code, fixedMessage] of Object.entries(PUBLIC_IPC_FAILURE_MESSAGES)) {
    if (message !== fixedMessage) continue;
    if (match !== null) return null;
    match = code as PublicIpcFailureCode;
  }
  return match;
}

/** Main-process domain projectors use this class only with a closed code. */
export class PublicIpcError extends Error {
  readonly code: PublicIpcFailureCode;

  constructor(code: PublicIpcFailureCode) {
    super(PUBLIC_IPC_FAILURE_MESSAGES[code]);
    this.name = 'PublicIpcError';
    this.code = code;
  }
}
