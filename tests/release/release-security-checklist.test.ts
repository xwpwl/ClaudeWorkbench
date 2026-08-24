import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const workspace = process.cwd();
const cliPath = path.join(workspace, 'scripts', 'release-security-checklist.mjs');
const packageJson = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};

const IDS = [
  'permissions-default-standard',
  'renderer-node-integration-disabled',
  'renderer-context-isolation-enabled',
  'renderer-sandbox-enabled',
  'single-instance-lock-enabled',
  'nsis-current-user',
  'code-signing-hook-prepared',
  'dangerous-git-mutations-absent',
] as const;

function passingSources() {
  return new Map([
    ['src/main/ipc/settings.ts', "defaultPermissionMode: 'standard'"],
    ['src/main/index.ts', [
      'nodeIntegration: false',
      'contextIsolation: true',
      'sandbox: true',
      'installSingleInstanceGuard()',
    ].join('\n')],
    ['src/main/lifecycle/SingleInstanceGuard.ts', 'requestSingleInstanceLock()'],
    ['electron-builder.yml', [
      'requestedExecutionLevel: asInvoker',
      'CSC_LINK/CSC_KEY_PASSWORD',
    ].join('\n')],
  ]);
}

async function loadCore() {
  vi.resetModules();
  return import('../../scripts/release/lib/security-checklist.mjs');
}

async function loadCli() {
  vi.resetModules();
  return import('../../scripts/release-security-checklist.mjs');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('importable release security checklist core', () => {
  it('has no import-time filesystem, process, timer, or console side effects', async () => {
    const read = vi.spyOn(fs, 'readFileSync');
    const readdir = vi.spyOn(fs, 'readdirSync');
    const write = vi.spyOn(fs, 'writeFileSync');
    const mkdir = vi.spyOn(fs, 'mkdirSync');
    const lstat = vi.spyOn(fs, 'lstatSync');
    const realpath = vi.spyOn(fs.realpathSync, 'native');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const processExit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    try {
      const module = await loadCore();
      expect(module.runSecurityChecklist).toBeTypeOf('function');
      expect(read).not.toHaveBeenCalled();
      expect(readdir).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
      expect(lstat).not.toHaveBeenCalled();
      expect(realpath).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(timer).not.toHaveBeenCalled();
      expect(processExit).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('returns the exact ordered eight-result contract without raw details', async () => {
    const { runSecurityChecklist } = await loadCore();
    const sources = passingSources();
    const results = await runSecurityChecklist({
      workspaceRoot: workspace,
      deps: {
        readText: (relativePath: string) => sources.get(relativePath) ?? '',
        readProductionSources: () => ['git status --short'],
      },
    });

    expect(results).toEqual(IDS.map((id) => ({ id, status: 'PASS' })));
    expect(results.every((result: object) => Object.keys(result).join(',') === 'id,status'))
      .toBe(true);
  });

  it('fails each check independently without spawning a test runner or leaking source text', async () => {
    const { runSecurityChecklist } = await loadCore();
    const base = passingSources();
    const mutations = [
      ['src/main/ipc/settings.ts', "const defaultPermissionMode = 'bypass';"],
      ['src/main/index.ts', 'contextIsolation: true\nsandbox: true\ninstallSingleInstanceGuard()'],
      ['src/main/index.ts', 'nodeIntegration: false\nsandbox: true\ninstallSingleInstanceGuard()'],
      ['src/main/index.ts', 'nodeIntegration: false\ncontextIsolation: true\ninstallSingleInstanceGuard()'],
      ['src/main/lifecycle/SingleInstanceGuard.ts', 'no lock here'],
      ['electron-builder.yml', 'requestedExecutionLevel: requireAdministrator\nCSC_LINK/CSC_KEY_PASSWORD'],
      ['electron-builder.yml', 'requestedExecutionLevel: asInvoker'],
    ] as const;
    for (let index = 0; index < mutations.length; index += 1) {
      const sources = new Map(base);
      sources.set(...mutations[index]);
      const results = await runSecurityChecklist({
        workspaceRoot: workspace,
        deps: {
          readText: (relativePath: string) => sources.get(relativePath) ?? '',
          readProductionSources: () => ['git status --short'],
        },
      });
      expect(results[index].status).toBe('FAIL');
      expect(JSON.stringify(results)).not.toContain([...sources.values()].join('\n'));
    }

    const gitResults = await runSecurityChecklist({
      workspaceRoot: workspace,
      deps: {
        readText: (relativePath: string) => base.get(relativePath) ?? '',
        readProductionSources: () => ['git reset --hard HEAD'],
      },
    });
    expect(gitResults[7]).toEqual({ id: IDS[7], status: 'FAIL' });
  });

  it('rejects hidden fields, accessors, prototypes, and reordered or unknown results', async () => {
    const { assertSecurityChecklistResults } = await loadCore();
    const valid = IDS.map((id) => ({ id, status: 'PASS' }));
    expect(assertSecurityChecklistResults(valid)).toEqual(valid);

    const hidden = IDS.map((id) => ({ id, status: 'PASS' }));
    Object.defineProperty(hidden[0], 'rawOutput', { value: 'secret', enumerable: false });
    expect(() => assertSecurityChecklistResults(hidden)).toThrow();

    const symbol = IDS.map((id) => ({ id, status: 'PASS' }));
    Object.defineProperty(symbol[0], Symbol('secret'), { value: 'secret' });
    expect(() => assertSecurityChecklistResults(symbol)).toThrow();

    const accessor = IDS.map((id) => ({ id, status: 'PASS' }));
    Object.defineProperty(accessor[0], 'status', { get: () => 'PASS', enumerable: true });
    expect(() => assertSecurityChecklistResults(accessor)).toThrow();

    const inherited = IDS.map((id) => ({ id, status: 'PASS' }));
    Object.setPrototypeOf(inherited[0], { rawOutput: 'secret' });
    expect(() => assertSecurityChecklistResults(inherited)).toThrow();

    expect(() => assertSecurityChecklistResults([...valid].reverse())).toThrow();
    expect(() => assertSecurityChecklistResults(valid.slice(0, -1))).toThrow();
    expect(() => assertSecurityChecklistResults([
      ...valid.slice(0, -1),
      { id: 'unknown', status: 'PASS' },
    ])).toThrow();
  });
});

describe('zero-argument security checklist diagnostic CLI', () => {
  it('keeps the package alias zero-argument and removes nested test-runner behavior', () => {
    const source = fs.readFileSync(cliPath, 'utf8');
    expect(packageJson.scripts?.['test:release-security'])
      .toBe('node scripts/release-security-checklist.mjs');
    expect(source).not.toMatch(/node:child_process|vitest|focusedTests|npm\s+(?:run\s+)?test/iu);
    expect(source).toContain('security-checklist-diagnostic.json');
    expect(source).toMatch(/process\.argv\.slice\(2\)/u);
  });

  it('rejects every argv token with the same bounded error before writing a caller path', () => {
    const callerPath = path.join(workspace, 'release-validation', 'caller-selected.json');
    const before = fs.existsSync(callerPath) ? fs.readFileSync(callerPath) : null;
    const result = spawnSync(process.execPath, [cliPath, '--report', callerPath], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    const after = fs.existsSync(callerPath) ? fs.readFileSync(callerPath) : null;

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('Release security checklist accepts no arguments.\n');
    expect(after).toEqual(before);
  });

  it('rejects invalid argv before touching any injected dependency', async () => {
    const { runDiagnosticCli } = await loadCli();
    let touches = 0;
    const deps = new Proxy({}, {
      get() {
        touches += 1;
        throw new Error('dependency touched before argv rejection');
      },
    });

    for (const argv of [['--report'], ['path.json'], ['--'], ['', 'extra']]) {
      await expect(runDiagnosticCli({ argv, deps })).rejects.toThrow(
        'Release security checklist accepts no arguments.',
      );
    }
    expect(touches).toBe(0);
  });

  it('writes only the fixed non-authoritative path through the injected atomic writer', async () => {
    const { runDiagnosticCli } = await loadCli();
    const results = IDS.map((id) => ({ id, status: 'PASS' }));
    const calls: unknown[][] = [];
    const outcome = await runDiagnosticCli({
      argv: [],
      deps: {
        runSecurityChecklist: async () => results,
        assertSecurityChecklistResults: (value: unknown) => value,
        ensureFixedReportDirectory: (...args: unknown[]) => calls.push(['ensure', ...args]),
        writeAtomicJson: (...args: unknown[]) => {
          calls.push(['write', ...args]);
          return 'release-validation/reports/security-checklist-diagnostic.json';
        },
      },
    });

    expect(outcome).toMatchObject({
      exitCode: 0,
      reportPath: 'release-validation/reports/security-checklist-diagnostic.json',
      report: { schemaVersion: 1, kind: 'security-checklist-diagnostic', authoritative: false },
    });
    expect(calls[0][0]).toBe('ensure');
    expect(calls[1][0]).toBe('write');
    expect(calls[1][2]).toBe('release-validation/reports/security-checklist-diagnostic.json');
    expect(calls[1][3]).toEqual(outcome.report);
  });

  it('rejects a report-directory junction before the atomic writer is reached', async () => {
    const { ensureFixedReportDirectory } = await loadCli();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-security-cli-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-security-outside-'));
    try {
      fs.symlinkSync(outside, path.join(root, 'release-validation'), 'junction');
      expect(() => ensureFixedReportDirectory(root)).toThrow(/ordinary directory/iu);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
