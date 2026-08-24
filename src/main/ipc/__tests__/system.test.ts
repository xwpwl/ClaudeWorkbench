import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IpcMain } from 'electron';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import type { ResolvedClaudeInvocation } from '../../claude/ClaudeInvocationResolver';
import { ClaudeRuntimeMutationGate } from '../../claude/ClaudeRuntimeMutationGate';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  shellOpenPath: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: mocks.execFile,
  execFileSync: mocks.execFileSync,
}));

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '1.0.0-test') },
  shell: { openPath: mocks.shellOpenPath },
}));

import { registerSystemIPC, systemIpcInternals } from '../system';
import { publicIpcMainForTest } from './public-invoke-test-helper';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
const originalApiKey = process.env.ANTHROPIC_API_KEY;

let testRoot = '';
let allowedRoot = '';
let outsideRoot = '';
let allowedFile = '';
let outsideFile = '';
let mockCodeExecutable = '';
let mockCodeShim = '';
let mockClaudeExecutable = '';

function claudeRuntimeDouble(invocationPatch: Partial<ResolvedClaudeInvocation> = {}) {
  const invocation: ResolvedClaudeInvocation = Object.freeze({
    executable: 'node-test',
    prefixArgs: Object.freeze(['C:\\synthetic\\claude\\cli.js']),
    environmentPatch: Object.freeze({ ELECTRON_RUN_AS_NODE: '1' }),
    displayPath: 'C:\\synthetic\\claude\\claude.cmd',
    canonicalTargetPath: 'C:\\synthetic\\claude\\cli.js',
    provenance: 'npm',
    ...invocationPatch,
  });
  const gate = new ClaudeRuntimeMutationGate();
  const resolve = vi.fn(() => ({ ok: true as const, invocation }));
  return { resolver: { resolve }, gate, resolve, invocation };
}

type HarnessOptions = Omit<
  NonNullable<Parameters<typeof registerSystemIPC>[1]>,
  'claudeRuntime'
> & {
  claudeRuntime?: ReturnType<typeof claudeRuntimeDouble>;
};

function harness(
  options: HarnessOptions = {},
  publicTransport = false,
) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
  } as unknown as IpcMain;
  const claudeRuntime = options.claudeRuntime ?? claudeRuntimeDouble();
  registerSystemIPC(
    (publicTransport ? publicIpcMainForTest(ipcMain) : ipcMain) as never,
    { ...options, claudeRuntime } as Parameters<typeof registerSystemIPC>[1],
  );
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing handler: ${channel}`);
    return handler({}, ...args);
  };
  return { handlers, invoke, ipcMain, claudeRuntime };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  mocks.shellOpenPath.mockResolvedValue('');
  mocks.execFile.mockImplementation((
    _file: string,
    _args: readonly string[],
    _options: unknown,
    callback: (error: Error | null) => void,
  ) => callback(null));
  mocks.execFileSync.mockImplementation((file: string, args: readonly string[]) => {
    if (args.at(-1) === '--version') return `${path.basename(file)} version 1.0.0`;
    if (args.at(-1) === '--help') return 'help';
    if (file === 'where' || file === 'which') {
      if (args[0] === 'code') {
        return process.platform === 'win32' ? mockCodeShim : '/mock/bin/code';
      }
      if (args[0] === 'claude') {
        return process.platform === 'win32' ? mockClaudeExecutable : '/mock/bin/claude';
      }
      return `/mock/bin/${String(args[0])}`;
    }
    return '';
  });

  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-workbench-system-ipc-'));
  allowedRoot = path.join(testRoot, 'project');
  outsideRoot = path.join(testRoot, 'project-outside');
  fs.mkdirSync(path.join(allowedRoot, 'src'), { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });
  allowedFile = path.join(allowedRoot, 'src', 'index.ts');
  outsideFile = path.join(outsideRoot, 'secret.txt');
  fs.writeFileSync(allowedFile, 'export {};\n');
  fs.writeFileSync(outsideFile, 'secret\n');

  const mockVSCodeRoot = path.join(testRoot, 'vscode');
  mockCodeExecutable = path.join(mockVSCodeRoot, 'Code.exe');
  mockCodeShim = path.join(mockVSCodeRoot, 'bin', 'code.cmd');
  mockClaudeExecutable = path.join(testRoot, 'claude.exe');
  fs.mkdirSync(path.dirname(mockCodeShim), { recursive: true });
  fs.writeFileSync(mockCodeExecutable, '');
  fs.writeFileSync(mockCodeShim, '');
  fs.writeFileSync(mockClaudeExecutable, '');
});

afterEach(() => {
  if (testRoot && path.basename(testRoot).startsWith('claude-workbench-system-ipc-')) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (originalBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
  if (originalAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
  else process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken;
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalApiKey;
});

describe('system public invoke failures', () => {
  it('returns fixed path, shell, and VS Code envelopes without reflecting private paths', async () => {
    const test = harness({ allowedPaths: [allowedRoot] }, true);

    await expect(test.invoke(IPC_CHANNELS.SYSTEM_OPEN_PATH, outsideFile)).resolves.toStrictEqual({
      schemaVersion: 1,
      ok: false,
      error: { code: 'PATH_NOT_ALLOWED', message: 'Requested path is not allowed.' },
    });

    mocks.shellOpenPath.mockResolvedValueOnce(`C:\\private\\shell-failure`);
    await expect(test.invoke(IPC_CHANNELS.SYSTEM_OPEN_PATH, allowedRoot)).resolves.toStrictEqual({
      schemaVersion: 1,
      ok: false,
      error: { code: 'OPEN_PATH_FAILED', message: 'Unable to open the requested path.' },
    });

    mocks.execFile.mockImplementationOnce((
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error | null) => void,
    ) => callback(new Error(`C:\\private\\vscode-failure`)));
    await expect(test.invoke(IPC_CHANNELS.SYSTEM_OPEN_VSCODE, allowedFile)).resolves.toStrictEqual({
      schemaVersion: 1,
      ok: false,
      error: { code: 'OPEN_VSCODE_FAILED', message: 'Unable to open the requested path in VS Code.' },
    });
  });
});

describe('system path authorization', () => {
  it('opens the exact registered root after canonicalization', async () => {
    const test = harness({ allowedPaths: () => [allowedRoot] });
    await expect(test.invoke(IPC_CHANNELS.SYSTEM_OPEN_PATH, path.join(allowedRoot, '.')))
      .resolves.toBeUndefined();
    expect(mocks.shellOpenPath).toHaveBeenCalledWith(fs.realpathSync.native(allowedRoot));
  });

  it('opens an existing descendant directory after canonicalization', async () => {
    const descendantDirectory = path.dirname(allowedFile);
    const test = harness({ allowedPaths: () => [allowedRoot] });
    await expect(test.invoke(IPC_CHANNELS.SYSTEM_OPEN_PATH, descendantDirectory))
      .resolves.toBeUndefined();
    expect(mocks.shellOpenPath).toHaveBeenCalledWith(
      fs.realpathSync.native(descendantDirectory),
    );
  });

  it('does not pass an authorized descendant file to the OS shell', async () => {
    const test = harness({ allowedPaths: () => [allowedRoot] });
    await expect(test.invoke(IPC_CHANNELS.SYSTEM_OPEN_PATH, allowedFile))
      .rejects.toThrow('Requested path is not allowed.');
    expect(mocks.shellOpenPath).not.toHaveBeenCalled();
  });

  it('fails closed when the compatible one-argument registration has no policy', async () => {
    const test = harness();
    await expect(test.invoke(IPC_CHANNELS.SYSTEM_OPEN_PATH, allowedFile))
      .rejects.toThrow('Requested path is not allowed.');
    expect(mocks.shellOpenPath).not.toHaveBeenCalled();
  });

  it('rejects a sibling whose name shares the allowed root prefix', async () => {
    const test = harness({ allowedPaths: [allowedRoot] });
    await expect(test.invoke(IPC_CHANNELS.SYSTEM_OPEN_PATH, outsideFile))
      .rejects.toThrow('Requested path is not allowed.');
    expect(mocks.shellOpenPath).not.toHaveBeenCalled();
  });

  it('rejects a lexically unauthorized target before resolving it on the filesystem', async () => {
    const realpathSpy = vi.spyOn(fs.realpathSync, 'native');
    try {
      const test = harness({ allowedPaths: [allowedRoot] });
      await expect(test.invoke(IPC_CHANNELS.SYSTEM_OPEN_PATH, outsideFile))
        .rejects.toThrow('Requested path is not allowed.');
      expect(realpathSpy).toHaveBeenCalledWith(path.resolve(allowedRoot));
      expect(realpathSpy).not.toHaveBeenCalledWith(path.resolve(outsideFile));
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it('rejects relative targets without filesystem resolution', async () => {
    const realpathSpy = vi.spyOn(fs.realpathSync, 'native');
    try {
      const test = harness({ allowedPaths: [allowedRoot] });
      await expect(test.invoke(
        IPC_CHANNELS.SYSTEM_OPEN_PATH,
        path.relative(process.cwd(), allowedFile),
      )).rejects.toThrow('Requested path is not allowed.');
      expect(realpathSpy).not.toHaveBeenCalledWith(path.resolve(allowedFile));
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it('rejects dot-dot traversal outside the registered root', async () => {
    const requested = path.join(allowedRoot, '..', path.basename(outsideRoot), 'secret.txt');
    const test = harness({ allowedPaths: () => [allowedRoot] });
    await expect(test.invoke(IPC_CHANNELS.SYSTEM_OPEN_PATH, requested))
      .rejects.toThrow('Requested path is not allowed.');
  });

  it('rejects a symlink descendant whose real target escapes the root', async () => {
    const link = path.join(allowedRoot, 'linked-outside');
    fs.symlinkSync(outsideRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
    const test = harness({ allowedPaths: () => [allowedRoot] });
    await expect(test.invoke(IPC_CHANNELS.SYSTEM_OPEN_PATH, path.join(link, 'secret.txt')))
      .rejects.toThrow('Requested path is not allowed.');
  });

  it.each([undefined, null, 0, {}, [], Buffer.from(allowedFile)])(
    'rejects non-string renderer path %#',
    async (requested) => {
      const test = harness({ allowedPaths: () => [allowedRoot] });
      await expect(test.invoke(IPC_CHANNELS.SYSTEM_OPEN_PATH, requested))
        .rejects.toThrow('Requested path is not allowed.');
    },
  );

  it('rejects NUL and missing paths without exposing them', async () => {
    const test = harness({ allowedPaths: () => [allowedRoot] });
    await expect(test.invoke(IPC_CHANNELS.SYSTEM_OPEN_PATH, `${allowedFile}\0secret`))
      .rejects.toThrow('Requested path is not allowed.');
    await expect(test.invoke(IPC_CHANNELS.SYSTEM_OPEN_PATH, path.join(allowedRoot, 'missing.txt')))
      .rejects.toThrow('Requested path is not allowed.');
  });

  it('reads the allowed root provider at invocation time', async () => {
    let roots: readonly string[] = [allowedRoot];
    const test = harness({ allowedPaths: () => roots });
    await expect(test.invoke(IPC_CHANNELS.SYSTEM_OPEN_PATH, outsideRoot))
      .rejects.toThrow('Requested path is not allowed.');
    roots = [outsideRoot];
    await expect(test.invoke(IPC_CHANNELS.SYSTEM_OPEN_PATH, outsideRoot)).resolves.toBeUndefined();
  });

  it('passes only the canonical authorized path as a VS Code argv element', async () => {
    const test = harness({ allowedPaths: () => [allowedRoot] });
    await expect(test.invoke(IPC_CHANNELS.SYSTEM_OPEN_VSCODE, allowedFile)).resolves.toBeUndefined();
    expect(mocks.execFile).toHaveBeenCalledWith(
      process.platform === 'win32'
        ? fs.realpathSync.native(mockCodeExecutable)
        : '/mock/bin/code',
      [fs.realpathSync.native(allowedFile)],
      { timeout: 5_000, windowsHide: true, shell: false },
      expect.any(Function),
    );
  });

  it('rejects an unauthorized VS Code target before launching a process', async () => {
    const test = harness({ allowedPaths: () => [allowedRoot] });
    await expect(test.invoke(IPC_CHANNELS.SYSTEM_OPEN_VSCODE, outsideFile))
      .rejects.toThrow('Requested path is not allowed.');
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('redacts shell.openPath failures at the public IPC boundary', async () => {
    mocks.shellOpenPath.mockResolvedValue(`private failure at ${allowedRoot}?token=secret`);
    const test = harness({ allowedPaths: () => [allowedRoot] });
    const result = test.invoke(IPC_CHANNELS.SYSTEM_OPEN_PATH, allowedRoot);
    await expect(result).rejects.toThrow('Unable to open the requested path.');
    await expect(result).rejects.not.toThrow(allowedRoot);
  });

  it('redacts rejected shell.openPath promises at the public IPC boundary', async () => {
    mocks.shellOpenPath.mockRejectedValue(new Error(`private failure at ${allowedRoot}`));
    const test = harness({ allowedPaths: () => [allowedRoot] });
    const result = test.invoke(IPC_CHANNELS.SYSTEM_OPEN_PATH, allowedRoot);
    await expect(result).rejects.toThrow('Unable to open the requested path.');
    await expect(result).rejects.not.toThrow(allowedRoot);
  });

  it('redacts VS Code process failures at the public IPC boundary', async () => {
    mocks.execFile.mockImplementation((
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error | null) => void,
    ) => callback(new Error(`spawn failed for ${allowedFile} token=secret`)));
    const test = harness({ allowedPaths: () => [allowedRoot] });
    const result = test.invoke(IPC_CHANNELS.SYSTEM_OPEN_VSCODE, allowedFile);
    await expect(result).rejects.toThrow('Unable to open the requested path in VS Code.');
    await expect(result).rejects.not.toThrow(allowedFile);
  });
});

describe('system environment privacy and process execution', () => {
  it.each([
    [IPC_CHANNELS.SYSTEM_CHECK_ENV, ['--version']],
    [IPC_CHANNELS.SYSTEM_GET_CONNECTION_STATUS, ['--version']],
    [IPC_CHANNELS.SYSTEM_TEST_CLAUDE, ['--version', '--help']],
    [IPC_CHANNELS.SYSTEM_GET_DIAGNOSTICS, ['--version']],
  ] as const)(
    'uses the injected Claude resolver and one ordinary lease for %s',
    async (channel, expectedSuffixes) => {
      const runtime = claudeRuntimeDouble();
      const trace: string[] = [];
      runtime.resolve.mockImplementation(() => {
        trace.push(`resolve:${runtime.gate.snapshot().ordinaryLeaseCount}`);
        return { ok: true, invocation: runtime.invocation };
      });
      mocks.execFileSync.mockImplementation((file: string, args: readonly string[]) => {
        if (file === runtime.invocation.executable) {
          trace.push(`${args.at(-1)}:${runtime.gate.snapshot().ordinaryLeaseCount}`);
          return args.at(-1) === '--help' ? 'help' : '2.1.218 (Claude Code)';
        }
        if (file === 'where' || file === 'which') return `/mock/bin/${String(args[0])}`;
        if (args.at(-1) === '--version') return `${path.basename(file)} version 1.0.0`;
        return '';
      });
      const test = harness({ claudeRuntime: runtime });

      await test.invoke(channel);

      expect(runtime.resolve).toHaveBeenCalledOnce();
      expect(trace).toEqual([
        'resolve:1',
        ...expectedSuffixes.map((suffix) => `${suffix}:1`),
      ]);
      expect(runtime.gate.snapshot().ordinaryLeaseCount).toBe(0);
      expect(mocks.execFileSync).toHaveBeenCalledWith(
        'node-test',
        expect.arrayContaining(['C:\\synthetic\\claude\\cli.js']),
        expect.objectContaining({
          shell: false,
          env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
        }),
      );
    },
  );

  it.each([
    [IPC_CHANNELS.SYSTEM_CHECK_ENV, {
      claude: { ok: false, version: null, path: null, installType: null },
    }],
    [IPC_CHANNELS.SYSTEM_GET_CONNECTION_STATUS, { loginStatus: 'not-detected' }],
    [IPC_CHANNELS.SYSTEM_TEST_CLAUDE, {
      success: false,
      error: 'Claude Code is unavailable or could not be executed.',
    }],
    [IPC_CHANNELS.SYSTEM_GET_DIAGNOSTICS, {
      claude: { path: null, version: null, installType: null },
    }],
  ] as const)(
    'returns a bounded unavailable result without Claude work during an update for %s',
    async (channel, expected) => {
      const runtime = claudeRuntimeDouble();
      const update = runtime.gate.tryAcquireUpdate();
      const test = harness({ claudeRuntime: runtime });

      await expect(test.invoke(channel)).resolves.toMatchObject(expected);

      expect(runtime.resolve).not.toHaveBeenCalled();
      expect(mocks.execFileSync.mock.calls.some(([file, args]) => (
        file === runtime.invocation.executable
        || ((file === 'where' || file === 'which') && args[0] === 'claude')
      ))).toBe(false);
      update?.release();
    },
  );

  it('returns only an http(s) base URL origin and path', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://user:password@proxy.example.com/anthropic/v1?api_key=secret#token';
    const test = harness();
    await expect(test.invoke(IPC_CHANNELS.SYSTEM_GET_CONNECTION_STATUS)).resolves.toMatchObject({
      baseUrl: 'https://proxy.example.com/anthropic/v1',
      baseUrlDetected: true,
    });
  });

  it.each([
    'ftp://user:password@example.com/private?token=secret',
    'not a URL',
  ])('does not return a non-http(s) or malformed base URL: %s', async (value) => {
    process.env.ANTHROPIC_BASE_URL = value;
    const test = harness();
    await expect(test.invoke(IPC_CHANNELS.SYSTEM_GET_CONNECTION_STATUS)).resolves.toMatchObject({
      baseUrl: null,
      baseUrlDetected: true,
    });
  });

  it('uses executable plus argv calls for every synchronous command probe', async () => {
    const test = harness();
    const environment = await test.invoke(IPC_CHANNELS.SYSTEM_CHECK_ENV) as { node: { ok: boolean }; git: { ok: boolean } };
    expect(environment.node.ok).toBe(true);
    expect(environment.git.ok).toBe(true);
    expect(mocks.execFileSync).toHaveBeenCalledWith('node', ['--version'], expect.objectContaining({ shell: false }));
    expect(mocks.execFileSync).toHaveBeenCalledWith('git', ['--version'], expect.objectContaining({ shell: false }));
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      process.platform === 'win32' ? 'where' : 'which',
      ['node'],
      expect.objectContaining({ shell: false }),
    );
  });

  it('adds trusted runtime readiness facts without returning a data or credential path', async () => {
    const test = harness({
      environmentFacts: vi.fn(async () => ({
        dataDirectoryWritable: true,
        sqliteOk: true,
        sqliteSchemaVersion: 7,
        runnableProviderCount: 2,
        sourceDevelopment: false,
      })),
    });

    const environment = await test.invoke(IPC_CHANNELS.SYSTEM_CHECK_ENV);
    expect(environment).toMatchObject({
      claudeConfiguration: { ok: true, source: 'claude_cli' },
      buildTools: { required: false, ok: null },
      providers: { runnable: 2 },
      dataDirectory: { ok: true, writable: true },
      sqlite: { ok: true, schemaVersion: 7 },
    });
    expect(JSON.stringify(environment)).not.toContain(testRoot);
  });

  it('returns a fixed public Claude error instead of child-process details', async () => {
    mocks.execFileSync.mockImplementation(() => {
      throw new Error('spawn C:\\Users\\private\\claude.cmd sk-ant-super-secret');
    });
    const test = harness();
    const result = await test.invoke(IPC_CHANNELS.SYSTEM_TEST_CLAUDE) as { error: string | null };
    expect(result.error).toBe('Claude Code is unavailable or could not be executed.');
    expect(result.error).not.toContain('private');
    expect(result.error).not.toContain('sk-ant');
  });

  it('redacts Claude help failures after a successful version probe', async () => {
    mocks.execFileSync.mockImplementation((file: string, args: readonly string[]) => {
      if (file === 'where' && args[0] === 'claude') return mockClaudeExecutable;
      if (args.at(-1) === '--version') return 'claude 1.0.0';
      if (args.at(-1) === '--help') {
        throw new Error('C:\\Users\\private\\project token=sk-ant-super-secret');
      }
      return '';
    });
    const test = harness();
    const result = await test.invoke(IPC_CHANNELS.SYSTEM_TEST_CLAUDE) as {
      success: boolean;
      error: string | null;
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe('Claude Code is unavailable or could not be executed.');
    expect(result.error).not.toContain('private');
    expect(result.error).not.toContain('sk-ant');
  });

  it.runIf(process.platform === 'win32')(
    'runs an npm Claude shim through its CLI entrypoint without a command shell',
    async () => {
      const npmRoot = path.join(testRoot, 'npm');
      const shimPath = path.join(npmRoot, 'claude.cmd');
      const cliPath = path.join(
        npmRoot,
        'node_modules',
        '@anthropic-ai',
        'claude-code',
        'cli.js',
      );
      fs.mkdirSync(path.dirname(cliPath), { recursive: true });
      fs.writeFileSync(shimPath, '@echo off\r\n');
      fs.writeFileSync(cliPath, '');
      const canonicalCliPath = fs.realpathSync.native(cliPath);
      const runtime = claudeRuntimeDouble({
        executable: process.execPath,
        prefixArgs: Object.freeze([canonicalCliPath]),
        environmentPatch: Object.freeze({ ELECTRON_RUN_AS_NODE: '1' }),
        displayPath: shimPath,
        canonicalTargetPath: canonicalCliPath,
        provenance: 'npm',
      });

      mocks.execFileSync.mockImplementation((file: string, args: readonly string[]) => {
        if (file === process.execPath && args.at(-1) === '--version') return 'claude 1.0.0';
        if (file === process.execPath && args.at(-1) === '--help') return 'help';
        return '';
      });

      const test = harness({ claudeRuntime: runtime });
      await expect(test.invoke(IPC_CHANNELS.SYSTEM_TEST_CLAUDE)).resolves.toMatchObject({
        claudePath: shimPath,
        claudeVersion: 'claude 1.0.0',
        success: true,
        error: null,
      });
      expect(mocks.execFileSync).toHaveBeenCalledWith(
        process.execPath,
        [canonicalCliPath, '--version'],
        expect.objectContaining({
          shell: false,
          env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
        }),
      );
      expect(mocks.execFileSync).toHaveBeenCalledWith(
        process.execPath,
        [canonicalCliPath, '--help'],
        expect.objectContaining({ shell: false }),
      );
    },
  );

  it('sanitizes base URLs without changing a safe path', () => {
    expect(systemIpcInternals.sanitizeBaseUrl('http://localhost:8080/api/v1'))
      .toBe('http://localhost:8080/api/v1');
  });
});
