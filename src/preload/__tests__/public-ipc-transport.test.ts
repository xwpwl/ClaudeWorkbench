import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcRenderer: electronMocks,
}));

const {
  publicIpcRenderer,
  settlePublicIpcTransportCall,
} = await import('../public-ipc-renderer');

function invokeTransport(channel = 'fixed:test') {
  return settlePublicIpcTransportCall(() => publicIpcRenderer.invoke(channel));
}

beforeEach(() => {
  electronMocks.invoke.mockReset();
});

describe('preload fulfilled public IPC transport', () => {
  it('returns a fresh exact success envelope including an explicit undefined value', async () => {
    const source = { schemaVersion: 1, ok: true, value: undefined };
    electronMocks.invoke.mockResolvedValueOnce(source);

    const result = await invokeTransport();

    expect(result).toStrictEqual({ schemaVersion: 1, ok: true, value: undefined });
    expect(result).not.toBe(source);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Reflect.ownKeys(result)).toStrictEqual(['schemaVersion', 'ok', 'value']);
  });

  it('returns a fresh exact failure envelope without rejecting or reflecting extra data', async () => {
    const source = {
      schemaVersion: 1,
      ok: false,
      error: {
        code: 'NOT_A_REPOSITORY',
        message: 'Selected project is not a Git working tree.',
      },
    };
    electronMocks.invoke.mockResolvedValueOnce(source);

    const result = await invokeTransport();

    expect(result).toStrictEqual(source);
    expect(result).not.toBe(source);
    expect((result as { error: object }).error).not.toBe(source.error);
    expect(Reflect.ownKeys(result)).toStrictEqual(['schemaVersion', 'ok', 'error']);
    expect(Reflect.ownKeys((result as { error: object }).error)).toStrictEqual(['code', 'message']);
  });

  it('turns a dirty raw transport rejection into one fixed fulfilled envelope', async () => {
    const dirty = Object.assign(
      new Error('C:\\Users\\PrivateProfile\\private-transport-secret'),
      { cause: { secret: 'private-transport-secret' }, privateField: 'PrivateProfile' },
    );
    dirty.stack = 'Error: C:/Users/PrivateProfile/private-transport-secret.ts:1:1';
    electronMocks.invoke.mockRejectedValueOnce(dirty);

    const result = await invokeTransport();

    expect(result).toStrictEqual({
      schemaVersion: 1,
      ok: false,
      error: {
        code: 'IPC_TRANSPORT_FAILED',
        message: 'The main process did not return a response.',
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/PrivateProfile|private-transport-secret/iu);
  });

  it.each([
    undefined,
    null,
    [],
    { schemaVersion: 2, ok: true, value: null },
    { schemaVersion: 1, ok: true },
    { schemaVersion: 1, ok: true, value: null, extra: 'C:\\Users\\PrivateProfile' },
    { schemaVersion: 1, ok: false, error: {
      code: 'NOT_A_REPOSITORY', message: 'C:\\Users\\PrivateProfile\\dynamic',
    } },
    { schemaVersion: 1, ok: false, error: {
      code: 'UNKNOWN_PRIVATE_CODE', message: 'Selected project is not a Git working tree.',
    } },
    { schemaVersion: 1, ok: false, error: {
      code: 'IPC_TRANSPORT_FAILED', message: 'The main process did not return a response.',
    } },
    { schemaVersion: 1, ok: false, error: Object.assign(
      Object.create(null) as Record<string, unknown>,
      { code: 'NOT_A_REPOSITORY', message: 'Selected project is not a Git working tree.' },
    ) },
    Object.assign(
      Object.create(null) as Record<string, unknown>,
      { schemaVersion: 1, ok: true, value: null },
    ),
    { schemaVersion: 1, ok: true, value: null, [Symbol('private')]: 'private-symbol' },
    new Proxy({}, {
      ownKeys: () => { throw new Error('C:\\Users\\PrivateProfile\\private-proxy'); },
    }),
  ])('maps malformed or hostile response %# to a fixed fulfilled envelope', async (response) => {
    electronMocks.invoke.mockResolvedValueOnce(response);

    const result = await invokeTransport();

    expect(result).toStrictEqual({
      schemaVersion: 1,
      ok: false,
      error: {
        code: 'IPC_RESPONSE_INVALID',
        message: 'Invalid response from the main process.',
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/PrivateProfile|private-proxy/iu);
  });

  it('does not read outer or nested accessors while settling malformed responses', async () => {
    let outerReads = 0;
    const outer = { schemaVersion: 1, ok: true } as Record<string, unknown>;
    Object.defineProperty(outer, 'value', {
      enumerable: true,
      get: () => {
        outerReads += 1;
        throw new Error('C:\\Users\\PrivateProfile\\outer-accessor');
      },
    });
    electronMocks.invoke.mockResolvedValueOnce(outer);
    await expect(invokeTransport()).resolves.toMatchObject({
      ok: false,
      error: { code: 'IPC_RESPONSE_INVALID' },
    });
    expect(outerReads).toBe(0);

    let nestedReads = 0;
    const nested = { code: 'NOT_A_REPOSITORY' } as Record<string, unknown>;
    Object.defineProperty(nested, 'message', {
      enumerable: true,
      get: () => {
        nestedReads += 1;
        throw new Error('C:\\Users\\PrivateProfile\\nested-accessor');
      },
    });
    electronMocks.invoke.mockResolvedValueOnce({ schemaVersion: 1, ok: false, error: nested });
    await expect(invokeTransport()).resolves.toMatchObject({
      ok: false,
      error: { code: 'IPC_RESPONSE_INVALID' },
    });
    expect(nestedReads).toBe(0);
  });

  it('settles synchronous dirty throws and returns fresh outer and nested envelopes per call', async () => {
    const dirty = Object.assign(new Error('C:\\Users\\PrivateProfile\\sync-secret'), {
      cause: { secret: 'sync-secret' },
      code: 'NOT_A_REPOSITORY',
    });
    const first = await settlePublicIpcTransportCall(() => { throw dirty; });
    const second = await settlePublicIpcTransportCall(() => { throw dirty; });

    expect(first).toStrictEqual({
      schemaVersion: 1,
      ok: false,
      error: {
        code: 'IPC_TRANSPORT_FAILED',
        message: 'The main process did not return a response.',
      },
    });
    expect(second).toStrictEqual(first);
    expect(second).not.toBe(first);
    expect((second as { error: object }).error).not.toBe((first as { error: object }).error);
    expect(JSON.stringify([first, second])).not.toMatch(/PrivateProfile|sync-secret/iu);
  });

  it('always fulfills when a hostile thrown Proxy traps prototype inspection', async () => {
    const hostile = new Proxy({}, {
      getPrototypeOf: () => {
        throw new Error('C:\\Users\\PrivateProfile\\proxy-prototype-secret');
      },
    });

    const result = await settlePublicIpcTransportCall(() => { throw hostile; });

    expect(result).toStrictEqual({
      schemaVersion: 1,
      ok: false,
      error: {
        code: 'IPC_TRANSPORT_FAILED',
        message: 'The main process did not return a response.',
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/PrivateProfile|proxy-prototype-secret/iu);
  });

  it('maps a response trap that throws a hostile Proxy to one fixed invalid envelope', async () => {
    const hostileThrownValue = new Proxy({}, {
      getPrototypeOf: () => {
        throw new Error('C:\\Users\\PrivateProfile\\nested-proxy-secret');
      },
    });
    const response = new Proxy({}, {
      getPrototypeOf: () => { throw hostileThrownValue; },
    });
    electronMocks.invoke.mockResolvedValueOnce(response);

    const result = await invokeTransport();

    expect(result).toStrictEqual({
      schemaVersion: 1,
      ok: false,
      error: {
        code: 'IPC_RESPONSE_INVALID',
        message: 'Invalid response from the main process.',
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/PrivateProfile|nested-proxy-secret/iu);
  });
});
