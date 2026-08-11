import {
  CLAUDE_WORKBENCH_API_METHODS,
  CLAUDE_WORKBENCH_API_METHOD_KINDS,
  type ClaudeWorkbenchAPI,
  type ClaudeWorkbenchIpcTransport,
} from '../shared/types/ipc';
import {
  normalizePublicIpcTransportEnvelope,
  publicIpcTransportFailureMessage,
  type PublicIpcTransportFailureCode,
} from '../shared/types/publicIpc';

type AnyMethod = (...args: unknown[]) => unknown;
type MainWorldTarget = Record<PropertyKey, unknown>;

function mainWorldError(code: PublicIpcTransportFailureCode): Error & { readonly code: string } {
  const message = publicIpcTransportFailureMessage(code);
  if (message === null) throw new Error('Invalid public IPC failure code.');
  const error = new Error(message) as Error & { readonly code: string };
  error.stack = `Error: ${message}`;
  Object.defineProperty(error, 'code', {
    configurable: false,
    enumerable: true,
    value: code,
    writable: false,
  });
  return error;
}

function exactTransportMethod(
  transport: ClaudeWorkbenchIpcTransport,
  method: keyof ClaudeWorkbenchAPI,
): AnyMethod {
  const descriptor = Object.getOwnPropertyDescriptor(transport, method);
  if (
    descriptor === undefined
    || !descriptor.enumerable
    || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    || typeof descriptor.value !== 'function'
  ) {
    throw new Error('Invalid public IPC transport.');
  }
  return descriptor.value as AnyMethod;
}

function assertExactTransport(transport: unknown): asserts transport is ClaudeWorkbenchIpcTransport {
  try {
    if (
      transport === null
      || typeof transport !== 'object'
      || Array.isArray(transport)
      || Object.getPrototypeOf(transport) !== Object.prototype
    ) {
      throw new Error('Invalid public IPC transport.');
    }
    const keys = Reflect.ownKeys(transport);
    if (
      keys.length !== CLAUDE_WORKBENCH_API_METHODS.length
      || !CLAUDE_WORKBENCH_API_METHODS.every((method, index) => keys[index] === method)
    ) {
      throw new Error('Invalid public IPC transport.');
    }
    for (const method of CLAUDE_WORKBENCH_API_METHODS) {
      exactTransportMethod(transport as ClaudeWorkbenchIpcTransport, method);
    }
  } catch {
    throw new Error('Invalid public IPC transport.');
  }
}

function promiseMethodWrapper(
  transport: ClaudeWorkbenchIpcTransport,
  method: AnyMethod,
): AnyMethod {
  return async (...args: unknown[]): Promise<unknown> => {
    let pending: unknown;
    try {
      pending = Reflect.apply(method, transport, args);
    } catch {
      throw mainWorldError('IPC_TRANSPORT_FAILED');
    }
    let response: unknown;
    try {
      response = await Promise.resolve(pending);
    } catch {
      throw mainWorldError('IPC_TRANSPORT_FAILED');
    }
    const envelope = normalizePublicIpcTransportEnvelope(response);
    if (envelope === null) throw mainWorldError('IPC_RESPONSE_INVALID');
    if (envelope.ok) return envelope.value;
    throw mainWorldError(envelope.error.code);
  };
}

function subscriptionMethodWrapper(
  transport: ClaudeWorkbenchIpcTransport,
  method: AnyMethod,
): AnyMethod {
  return (...args: unknown[]): (() => void) => {
    let remoteUnsubscribe: unknown;
    try {
      remoteUnsubscribe = Reflect.apply(method, transport, args);
    } catch {
      throw mainWorldError('IPC_TRANSPORT_FAILED');
    }
    if (typeof remoteUnsubscribe !== 'function') {
      throw mainWorldError('IPC_RESPONSE_INVALID');
    }
    return () => {
      try {
        Reflect.apply(remoteUnsubscribe as AnyMethod, undefined, []);
      } catch {
        throw mainWorldError('IPC_TRANSPORT_FAILED');
      }
    };
  };
}

export function createMainWorldPublicApi(
  transport: ClaudeWorkbenchIpcTransport,
): ClaudeWorkbenchAPI {
  assertExactTransport(transport);
  const api = Object.create(null) as Record<string, AnyMethod>;
  for (const method of CLAUDE_WORKBENCH_API_METHODS) {
    const implementation = exactTransportMethod(transport, method);
    const wrapper = CLAUDE_WORKBENCH_API_METHOD_KINDS[method] === 'subscription'
      ? subscriptionMethodWrapper(transport, implementation)
      : promiseMethodWrapper(transport, implementation);
    Object.defineProperty(api, method, {
      configurable: false,
      enumerable: true,
      value: wrapper,
      writable: false,
    });
  }
  return Object.freeze(api) as unknown as ClaudeWorkbenchAPI;
}

export function installMainWorldPublicApi(
  target: MainWorldTarget = window as unknown as MainWorldTarget,
): ClaudeWorkbenchAPI {
  const transportDescriptor = Object.getOwnPropertyDescriptor(
    target,
    '__claudeWorkbenchIpcTransport',
  );
  if (
    transportDescriptor === undefined
    || !Object.prototype.hasOwnProperty.call(transportDescriptor, 'value')
  ) {
    throw new Error('Invalid public IPC transport.');
  }
  if (Object.prototype.hasOwnProperty.call(target, 'api')) {
    throw new Error('Public API is already installed.');
  }
  const api = createMainWorldPublicApi(
    transportDescriptor.value as ClaudeWorkbenchIpcTransport,
  );
  Object.defineProperty(target, 'api', {
    configurable: false,
    enumerable: true,
    value: api,
    writable: false,
  });
  return api;
}
