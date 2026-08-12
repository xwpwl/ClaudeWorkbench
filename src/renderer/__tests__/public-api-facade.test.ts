import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const EVENT_METHODS = Object.freeze([
  'onClaudeEvent',
  'onPermissionRequest',
  'onPermissionSettled',
  'onWorkflowChanged',
  'onModelProviderChanged',
  'onCheckpointChanged',
  'onTerminalOutput',
  'onTerminalExit',
  'onMenuCommand',
]);

type Method = (...args: unknown[]) => unknown;
type MethodRecord = Record<string, Method>;
type FacadeModule = {
  createMainWorldPublicApi(transport: MethodRecord): MethodRecord;
  installMainWorldPublicApi(target: Record<string, unknown>): MethodRecord;
};

function authoritativeApiMethods(): readonly string[] {
  const source = ts.createSourceFile(
    'ipc.ts',
    readFileSync(new URL('../../shared/types/ipc.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const api = source.statements.find((statement): statement is ts.InterfaceDeclaration =>
    ts.isInterfaceDeclaration(statement) && statement.name.text === 'ClaudeWorkbenchAPI');
  if (!api) throw new Error('ClaudeWorkbenchAPI contract was not found.');
  return api.members.map((member) => {
    if (!ts.isMethodSignature(member) || !ts.isIdentifier(member.name)) {
      throw new Error('ClaudeWorkbenchAPI contains a non-method member.');
    }
    return member.name.text;
  });
}

const API_METHODS = Object.freeze(authoritativeApiMethods());

async function loadFacadeModule(): Promise<FacadeModule> {
  return await import('../public-api-facade') as unknown as FacadeModule;
}

function success(value: unknown) {
  return { schemaVersion: 1, ok: true, value };
}

function failure(code: string, message: string) {
  return { schemaVersion: 1, ok: false, error: { code, message } };
}

function exactTransport(): MethodRecord {
  const transport: MethodRecord = {};
  for (const name of API_METHODS) {
    transport[name] = EVENT_METHODS.includes(name)
      ? vi.fn(() => () => undefined)
      : vi.fn(async () => success(undefined));
  }
  transport.getFirstRunCompletedVersion = vi.fn(async () => success(1));
  transport.openPath = vi.fn(async () => failure(
    'PATH_NOT_ALLOWED',
    'Requested path is not allowed.',
  ));
  return transport;
}

async function rejectionOf(pending: Promise<unknown>): Promise<Error & { code?: unknown }> {
  const value = await pending.then(
    () => null,
    (error: unknown) => error,
  );
  expect(value).toBeInstanceOf(Error);
  return value as Error & { code?: unknown };
}

describe('Renderer Main-World public API facade', () => {
  it('builds one frozen exact own-key surface with stable wrappers and no raw bypass', async () => {
    const { createMainWorldPublicApi } = await loadFacadeModule();
    const transport = exactTransport();
    const api = createMainWorldPublicApi(transport);

    expect(API_METHODS).toHaveLength(143);
    expect(Reflect.ownKeys(api)).toStrictEqual(API_METHODS);
    expect(Object.isFrozen(api)).toBe(true);
    expect(api.getFirstRunCompletedVersion).toBe(api.getFirstRunCompletedVersion);
    expect(api.invoke).toBeUndefined();
    expect(api.on).toBeUndefined();
    expect(api.send).toBeUndefined();
    expect(api.removeListener).toBeUndefined();
    expect(api.channel).toBeUndefined();
    expect(api.then).toBeUndefined();
    expect(api.constructor).toBeUndefined();
    expect(api.toString).toBeUndefined();
    expect(api.__proto__).toBeUndefined();
    expect(api.unknownPrivateMethod).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(api, 'getFirstRunCompletedVersion')).toMatchObject({
      configurable: false,
      enumerable: true,
      writable: false,
    });
    await expect(api.getFirstRunCompletedVersion()).resolves.toBe(1);
  });

  it('constructs the fixed Error in the Main World with exact descriptors and no cause', async () => {
    const { createMainWorldPublicApi } = await loadFacadeModule();
    const api = createMainWorldPublicApi(exactTransport());

    const error = await rejectionOf(api.openPath('C:\\Users\\PrivateProfile') as Promise<unknown>);

    expect(error).toMatchObject({
      name: 'Error',
      message: 'Requested path is not allowed.',
      code: 'PATH_NOT_ALLOWED',
      stack: 'Error: Requested path is not allowed.',
    });
    expect(Reflect.ownKeys(error)).toStrictEqual(['stack', 'message', 'code']);
    expect(error).not.toHaveProperty('cause');
    expect(Object.getOwnPropertyDescriptor(error, 'code')).toStrictEqual({
      configurable: false,
      enumerable: true,
      value: 'PATH_NOT_ALLOWED',
      writable: false,
    });
  });

  it('maps malformed and rejected transport results to fixed Errors without reflecting raw values', async () => {
    const { createMainWorldPublicApi } = await loadFacadeModule();
    const malformedTransport = exactTransport();
    malformedTransport.getFirstRunCompletedVersion = vi.fn(async () => ({
      schemaVersion: 1,
      ok: true,
      value: 1,
      raw: 'C:\\Users\\PrivateProfile\\private-malformed',
    }));
    const malformedApi = createMainWorldPublicApi(malformedTransport);
    const malformed = await rejectionOf(
      malformedApi.getFirstRunCompletedVersion() as Promise<unknown>,
    );
    expect(malformed).toMatchObject({
      code: 'IPC_RESPONSE_INVALID',
      message: 'Invalid response from the main process.',
    });

    const prototypeTransport = exactTransport();
    prototypeTransport.getFirstRunCompletedVersion = vi.fn(async () => Object.assign(
      Object.create(null) as Record<string, unknown>,
      success(1),
    ));
    const prototypeError = await rejectionOf(
      createMainWorldPublicApi(prototypeTransport).getFirstRunCompletedVersion() as Promise<unknown>,
    );
    expect(prototypeError.code).toBe('IPC_RESPONSE_INVALID');

    const unknownPairTransport = exactTransport();
    unknownPairTransport.getFirstRunCompletedVersion = vi.fn(async () => failure(
      'UNKNOWN_PRIVATE_CODE',
      'Requested path is not allowed.',
    ));
    const unknownPair = await rejectionOf(
      createMainWorldPublicApi(unknownPairTransport).getFirstRunCompletedVersion() as Promise<unknown>,
    );
    expect(unknownPair.code).toBe('IPC_RESPONSE_INVALID');

    let nestedGetterReads = 0;
    const nestedAccessorTransport = exactTransport();
    const nestedFailure: Record<string, unknown> = { code: 'PATH_NOT_ALLOWED' };
    Object.defineProperty(nestedFailure, 'message', {
      configurable: true,
      enumerable: true,
      get: () => {
        nestedGetterReads += 1;
        return 'C:\\Users\\PrivateProfile\\private-accessor';
      },
    });
    nestedAccessorTransport.getFirstRunCompletedVersion = vi.fn(async () => ({
      schemaVersion: 1,
      ok: false,
      error: nestedFailure,
    }));
    const nestedAccessor = await rejectionOf(
      createMainWorldPublicApi(nestedAccessorTransport)
        .getFirstRunCompletedVersion() as Promise<unknown>,
    );
    expect(nestedAccessor.code).toBe('IPC_RESPONSE_INVALID');
    expect(nestedGetterReads).toBe(0);

    const rejectedTransport = exactTransport();
    rejectedTransport.getFirstRunCompletedVersion = vi.fn(async () => {
      throw Object.assign(new Error('C:\\Users\\PrivateProfile\\private-transport'), {
        cause: { secret: 'private-transport' },
      });
    });
    const rejectedApi = createMainWorldPublicApi(rejectedTransport);
    const rejected = await rejectionOf(
      rejectedApi.getFirstRunCompletedVersion() as Promise<unknown>,
    );
    expect(rejected).toMatchObject({
      code: 'IPC_TRANSPORT_FAILED',
      message: 'The main process did not return a response.',
    });

    let thenReads = 0;
    const dirtyThenableTransport = exactTransport();
    const dirtyThenable = {};
    Object.defineProperty(dirtyThenable, 'then', {
      configurable: true,
      enumerable: true,
      get: () => {
        thenReads += 1;
        throw new Error('C:\\Users\\PrivateProfile\\private-thenable');
      },
    });
    dirtyThenableTransport.getFirstRunCompletedVersion = vi.fn(() => dirtyThenable);
    const dirtyThenableError = await rejectionOf(
      createMainWorldPublicApi(dirtyThenableTransport)
        .getFirstRunCompletedVersion() as Promise<unknown>,
    );
    expect(dirtyThenableError.code).toBe('IPC_TRANSPORT_FAILED');
    expect(thenReads).toBe(1);
    expect(JSON.stringify([
      malformed, prototypeError, unknownPair, nestedAccessor, rejected, dirtyThenableError,
    ])).not.toMatch(/PrivateProfile|private-transport|private-accessor|private-thenable/iu);
  });

  it('returns sanitized Main-World unsubscribe wrappers for all nine subscriptions', async () => {
    const { createMainWorldPublicApi } = await loadFacadeModule();
    const transport = exactTransport();
    const listener = vi.fn();
    const remoteUnsubscribes = new Map<string, ReturnType<typeof vi.fn>>();
    for (const name of EVENT_METHODS) {
      const unsubscribe = vi.fn();
      remoteUnsubscribes.set(name, unsubscribe);
      transport[name] = vi.fn(() => unsubscribe);
    }
    const api = createMainWorldPublicApi(transport);

    for (const name of EVENT_METHODS) {
      const args = name === 'onTerminalOutput' || name === 'onTerminalExit'
        ? ['terminal-fixed', listener]
        : [listener];
      const received = api[name](...args);
      expect(received).not.toBe(remoteUnsubscribes.get(name));
      expect(received).not.toBeInstanceOf(Promise);
      expect(typeof received).toBe('function');
      expect(transport[name]).toHaveBeenCalledWith(...args);
      (received as () => void)();
      expect(remoteUnsubscribes.get(name)).toHaveBeenCalledTimes(1);
    }
  });

  it('sanitizes synchronous subscription registration and unsubscribe failures', async () => {
    const { createMainWorldPublicApi } = await loadFacadeModule();
    const registration = exactTransport();
    registration.onClaudeEvent = vi.fn(() => {
      throw new Error('C:\\Users\\PrivateProfile\\registration-secret');
    });
    const registrationApi = createMainWorldPublicApi(registration);
    let registrationError: unknown;
    try {
      registrationApi.onClaudeEvent(vi.fn());
    } catch (error) {
      registrationError = error;
    }
    expect(registrationError).toMatchObject({
      code: 'IPC_TRANSPORT_FAILED',
      message: 'The main process did not return a response.',
    });

    const unsubscription = exactTransport();
    unsubscription.onTerminalOutput = vi.fn(() => () => {
      throw new Error('C:\\Users\\PrivateProfile\\unsubscribe-secret');
    });
    const unsubscribe = createMainWorldPublicApi(unsubscription)
      .onTerminalOutput('terminal-fixed', vi.fn()) as () => void;
    let unsubscribeError: unknown;
    try {
      unsubscribe();
    } catch (error) {
      unsubscribeError = error;
    }
    expect(unsubscribeError).toMatchObject({
      code: 'IPC_TRANSPORT_FAILED',
      message: 'The main process did not return a response.',
    });
    expect(JSON.stringify([registrationError, unsubscribeError]))
      .not.toMatch(/PrivateProfile|registration-secret|unsubscribe-secret/iu);
  });

  it('rejects extra and accessor-backed surfaces while adopting exact named results', async () => {
    const { createMainWorldPublicApi } = await loadFacadeModule();
    const extra = exactTransport();
    extra.invoke = vi.fn();
    expect(() => createMainWorldPublicApi(extra)).toThrow('Invalid public IPC transport.');

    let getterReads = 0;
    const accessor = exactTransport();
    Object.defineProperty(accessor, 'getFirstRunCompletedVersion', {
      configurable: true,
      enumerable: true,
      get: () => {
        getterReads += 1;
        throw new Error('C:\\Users\\PrivateProfile\\private-getter');
      },
    });
    expect(() => createMainWorldPublicApi(accessor)).toThrow('Invalid public IPC transport.');
    expect(getterReads).toBe(0);

    const swapped = exactTransport();
    delete swapped.getConnectionStatus;
    swapped.unknownCountPreservingMethod = vi.fn(async () => success(undefined));
    expect(Reflect.ownKeys(swapped)).toHaveLength(API_METHODS.length);
    expect(() => createMainWorldPublicApi(swapped)).toThrow('Invalid public IPC transport.');

    const nonPromise = exactTransport();
    nonPromise.getFirstRunCompletedVersion = vi.fn(() => success(1));
    const api = createMainWorldPublicApi(nonPromise);
    const result = api.getFirstRunCompletedVersion();
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe(1);
  });

  it('adopts a real cross-realm Promise without depending on prototype identity', async () => {
    const { createMainWorldPublicApi } = await loadFacadeModule();
    const transport = exactTransport();
    const envelope = success(1);
    transport.getFirstRunCompletedVersion = vi.fn(() => runInNewContext(
      'Promise.resolve(envelope)',
      { envelope },
    ));

    const result = createMainWorldPublicApi(transport).getFirstRunCompletedVersion();

    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe(1);
  });

  it('installs and locks the facade before exposing it as window.api', async () => {
    const { installMainWorldPublicApi } = await loadFacadeModule();
    const transport = exactTransport();
    const target: Record<string, unknown> = {
      __claudeWorkbenchIpcTransport: transport,
    };

    const api = installMainWorldPublicApi(target);

    expect(target.api).toBe(api);
    expect(Object.getOwnPropertyDescriptor(target, 'api')).toMatchObject({
      configurable: false,
      enumerable: true,
      writable: false,
    });
    expect((target.api as MethodRecord).invoke).toBeUndefined();
    expect((target.api as MethodRecord).__claudeWorkbenchIpcTransport).toBeUndefined();
  });
});
