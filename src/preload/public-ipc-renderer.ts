import { ipcRenderer as rawIpcRenderer } from 'electron';
import {
  PUBLIC_IPC_SCHEMA_VERSION,
  createPublicIpcTransportFailureEnvelope,
  createPublicIpcTransportSuccessEnvelope,
  isPublicIpcFailurePair,
  publicIpcFailureMessage,
  type PublicIpcFailureCode,
  type PublicIpcTransportEnvelope,
} from '../shared/types/publicIpc';
import {
  CLAUDE_WORKBENCH_API_METHODS,
  CLAUDE_WORKBENCH_API_METHOD_KINDS,
  type ClaudeWorkbenchAPI,
  type ClaudeWorkbenchIpcTransport,
} from '../shared/types/ipc';

type LocalIpcErrorCode = PublicIpcFailureCode
  | 'IPC_RESPONSE_INVALID'
  | 'IPC_TRANSPORT_FAILED';

const LOCAL_IPC_ERRORS = new WeakSet<object>();

class LocalIpcError extends Error {
  declare readonly code: LocalIpcErrorCode;

  constructor(code: LocalIpcErrorCode, message: string) {
    super(message);
    LOCAL_IPC_ERRORS.add(this);
    Object.defineProperty(this, 'code', {
      configurable: false,
      enumerable: true,
      value: code,
      writable: false,
    });
    this.stack = `Error: ${message}`;
  }
}

function localError(code: LocalIpcErrorCode, message: string): LocalIpcError {
  return new LocalIpcError(code, message);
}

function isLocalIpcError(error: unknown): error is LocalIpcError {
  return (typeof error === 'object' && error !== null) || typeof error === 'function'
    ? LOCAL_IPC_ERRORS.has(error as object)
    : false;
}

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

type OwnDataValue =
  | { found: true; value: unknown }
  | { found: false };

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

function unwrapEnvelope(response: unknown): unknown {
  try {
    if (!isPlainRecord(response)) {
      throw localError('IPC_RESPONSE_INVALID', 'Invalid response from the main process.');
    }
    const schemaVersion = ownEnumerableDataValue(response, 'schemaVersion');
    const ok = ownEnumerableDataValue(response, 'ok');
    if (!schemaVersion.found || schemaVersion.value !== PUBLIC_IPC_SCHEMA_VERSION || !ok.found) {
      throw localError('IPC_RESPONSE_INVALID', 'Invalid response from the main process.');
    }
    if (ok.value === true && hasExactKeys(response, ['schemaVersion', 'ok', 'value'])) {
      const value = ownEnumerableDataValue(response, 'value');
      if (value.found) return value.value;
    }
    if (
      ok.value === false
      && hasExactKeys(response, ['schemaVersion', 'ok', 'error'])
    ) {
      const nested = ownEnumerableDataValue(response, 'error');
      if (nested.found && isPlainRecord(nested.value) && hasExactKeys(nested.value, ['code', 'message'])) {
        const code = ownEnumerableDataValue(nested.value, 'code');
        const message = ownEnumerableDataValue(nested.value, 'message');
        const fixedMessage = code.found ? publicIpcFailureMessage(code.value) : null;
        if (
          code.found
          && message.found
          && fixedMessage !== null
          && isPublicIpcFailurePair(code.value, message.value)
        ) {
        throw localError(
          code.value as PublicIpcFailureCode,
          message.value as string,
        );
        }
      }
    }
  } catch (error) {
    if (isLocalIpcError(error)) throw error;
  }
  throw localError('IPC_RESPONSE_INVALID', 'Invalid response from the main process.');
}

async function invokePublic(channel: string, ...args: unknown[]): Promise<unknown> {
  let response: unknown;
  try {
    response = await rawIpcRenderer.invoke(channel, ...args);
  } catch {
    throw localError('IPC_TRANSPORT_FAILED', 'The main process did not return a response.');
  }
  return unwrapEnvelope(response);
}

export async function settlePublicIpcTransportCall<Value>(
  call: () => Value | PromiseLike<Value>,
): Promise<PublicIpcTransportEnvelope<Value>> {
  try {
    return createPublicIpcTransportSuccessEnvelope(await call());
  } catch (error) {
    return createPublicIpcTransportFailureEnvelope(
      isLocalIpcError(error) ? error.code : 'IPC_TRANSPORT_FAILED',
    );
  }
}

function exactNamedApiMethod(
  api: ClaudeWorkbenchAPI,
  method: keyof ClaudeWorkbenchAPI,
): (...args: unknown[]) => unknown {
  const descriptor = Object.getOwnPropertyDescriptor(api, method);
  if (
    descriptor === undefined
    || !descriptor.enumerable
    || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    || typeof descriptor.value !== 'function'
  ) {
    throw new Error('Invalid explicit preload API.');
  }
  return descriptor.value as (...args: unknown[]) => unknown;
}

export function createPublicIpcTransport(
  api: ClaudeWorkbenchAPI,
): ClaudeWorkbenchIpcTransport {
  const actualKeys = Reflect.ownKeys(api);
  if (
    actualKeys.length !== CLAUDE_WORKBENCH_API_METHODS.length
    || !CLAUDE_WORKBENCH_API_METHODS.every((method) => actualKeys.includes(method))
  ) {
    throw new Error('Invalid explicit preload API.');
  }

  const transport: Record<string, (...args: unknown[]) => unknown> = {};
  for (const method of CLAUDE_WORKBENCH_API_METHODS) {
    const implementation = exactNamedApiMethod(api, method);
    const wrapper = CLAUDE_WORKBENCH_API_METHOD_KINDS[method] === 'subscription'
      ? (...args: unknown[]) => Reflect.apply(implementation, api, args)
      : (...args: unknown[]) => settlePublicIpcTransportCall(
        () => Reflect.apply(implementation, api, args),
      );
    Object.defineProperty(transport, method, {
      configurable: false,
      enumerable: true,
      value: wrapper,
      writable: false,
    });
  }
  return Object.freeze(transport) as unknown as ClaudeWorkbenchIpcTransport;
}

export const publicIpcRenderer = {
  invoke: invokePublic as typeof rawIpcRenderer.invoke,
  on: rawIpcRenderer.on.bind(rawIpcRenderer),
  removeListener: rawIpcRenderer.removeListener.bind(rawIpcRenderer),
  send: rawIpcRenderer.send.bind(rawIpcRenderer),
};
