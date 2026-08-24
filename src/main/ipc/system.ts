import { shell, app } from 'electron';
import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type {
  EnvironmentCheckResult,
  ConnectionStatus,
  ClaudeTestResult,
  DiagnosticsInfo,
} from '../../shared/types/ipc';
import type { PublicIpcRegistrar } from './public-invoke-boundary';
import { PublicIpcError } from '../../shared/types/publicIpc';
import {
  mergeClaudeInvocationEnvironment,
  type ClaudeInvocationResolverPort,
  type ResolvedClaudeInvocation,
} from '../claude/ClaudeInvocationResolver';
import { ClaudeRuntimeMutationGate } from '../claude/ClaudeRuntimeMutationGate';

export interface SystemIPCOptions {
  claudeRuntime: {
    resolver: ClaudeInvocationResolverPort;
    gate: ClaudeRuntimeMutationGate;
  };
  /** Dynamic provider is preferred because registered projects can change after startup. */
  allowedPaths?: readonly string[] | (() => readonly string[]);
  environmentFacts?: () => SystemEnvironmentFacts | Promise<SystemEnvironmentFacts>;
}

export interface SystemEnvironmentFacts {
  dataDirectoryWritable: boolean;
  sqliteOk: boolean;
  sqliteSchemaVersion: number | null;
  runnableProviderCount: number;
  sourceDevelopment: boolean;
}

const CLAUDE_PUBLIC_ERROR = 'Claude Code is unavailable or could not be executed.';

function runCommand(
  executable: string,
  args: readonly string[],
  timeout: number,
  environment?: NodeJS.ProcessEnv,
): string {
  return execFileSync(executable, [...args], {
    encoding: 'utf-8',
    timeout,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
    ...(environment ? { env: environment } : {}),
  }).trim();
}

function runInvocation(
  invocation: ResolvedClaudeInvocation,
  args: readonly string[],
  timeout: number,
): string {
  return runCommand(
    invocation.executable,
    [...invocation.prefixArgs, ...args],
    timeout,
    { ...mergeClaudeInvocationEnvironment(process.env, invocation) },
  );
}

interface AllowedRoot {
  lexicalPath: string;
  canonicalPath: string;
}

function allowedRoots(options: SystemIPCOptions): AllowedRoot[] {
  const configured = typeof options.allowedPaths === 'function'
    ? options.allowedPaths()
    : options.allowedPaths ?? [];
  if (!Array.isArray(configured)) return [];
  return configured.flatMap((root) => {
    if (
      typeof root !== 'string'
      || !root.trim()
      || root.includes('\0')
      || !path.isAbsolute(root)
    ) return [];
    try {
      const lexicalPath = path.resolve(root);
      return [{
        lexicalPath,
        canonicalPath: fs.realpathSync.native(lexicalPath),
      }];
    } catch {
      return [];
    }
  });
}

function isExactOrDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveAuthorizedPath(targetPath: unknown, options: SystemIPCOptions): string {
  try {
    if (
      typeof targetPath !== 'string'
      || !targetPath.trim()
      || targetPath.includes('\0')
      || !path.isAbsolute(targetPath)
    ) {
      throw new PublicIpcError('PATH_NOT_ALLOWED');
    }
    const roots = allowedRoots(options);
    const lexicalTarget = path.resolve(targetPath);
    const candidateRoots = roots.filter((root) => (
      isExactOrDescendant(root.lexicalPath, lexicalTarget)
      || isExactOrDescendant(root.canonicalPath, lexicalTarget)
    ));
    if (candidateRoots.length === 0) throw new PublicIpcError('PATH_NOT_ALLOWED');

    const canonicalTarget = fs.realpathSync.native(lexicalTarget);
    if (candidateRoots.some((root) => isExactOrDescendant(root.canonicalPath, canonicalTarget))) {
      return canonicalTarget;
    }
  } catch {
    // The public IPC boundary intentionally does not disclose path or filesystem details.
  }
  throw new PublicIpcError('PATH_NOT_ALLOWED');
}

function resolveAuthorizedDirectory(targetPath: unknown, options: SystemIPCOptions): string {
  const authorizedPath = resolveAuthorizedPath(targetPath, options);
  try {
    if (fs.statSync(authorizedPath).isDirectory()) return authorizedPath;
  } catch {
    // The public IPC boundary intentionally does not disclose filesystem details.
  }
  throw new PublicIpcError('PATH_NOT_ALLOWED');
}

function sanitizeBaseUrl(value: string | undefined): string | null {
  if (!value || value.includes('\0')) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

export const systemIpcInternals = Object.freeze({
  sanitizeBaseUrl,
});

function resolveCommandPaths(command: string): string[] {
  try {
    const locator = process.platform === 'win32' ? 'where' : 'which';
    return runCommand(locator, [command], 5_000)
      .split(/\r?\n/)
      .map((candidate) => candidate.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function resolveCommandPath(command: string): string | null {
  return resolveCommandPaths(command)[0] ?? null;
}

function resolveVSCodeExecutable(): string | null {
  const resolvedPaths = resolveCommandPaths('code');
  if (process.platform !== 'win32') return resolvedPaths[0] ?? null;

  for (const candidate of resolvedPaths) {
    if (path.basename(path.dirname(candidate)).toLowerCase() !== 'bin') continue;
    const executable = path.resolve(path.dirname(candidate), '..', 'Code.exe');
    if (fs.existsSync(executable)) return fs.realpathSync.native(executable);
  }

  for (const candidate of resolvedPaths) {
    const extension = path.extname(candidate).toLowerCase();
    if ((extension === '.exe' || extension === '.com') && fs.existsSync(candidate)) {
      return fs.realpathSync.native(candidate);
    }
  }

  const knownCandidates = [
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe')
      : null,
    process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe')
      : null,
    process.env['ProgramFiles(x86)']
      ? path.join(process.env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe')
      : null,
  ].filter((candidate): candidate is string => candidate !== null);
  for (const candidate of knownCandidates) {
    if (fs.existsSync(candidate)) return fs.realpathSync.native(candidate);
  }
  return null;
}

function detectGitBash(): { path: string | null; configured: boolean } {
  const configured = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (configured && fs.existsSync(configured)) {
    return { path: configured, configured: true };
  }

  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { path: candidate, configured: false };
    }
  }

  return { path: null, configured: false };
}

export function registerSystemIPC(
  ipcMain: PublicIpcRegistrar,
  options: SystemIPCOptions,
): void {
  ipcMain.handle(IPC_CHANNELS.SYSTEM_CHECK_ENV, async (): Promise<EnvironmentCheckResult> => {
    const result: EnvironmentCheckResult = {
      node: { ok: false, version: null, path: null },
      claude: { ok: false, version: null, path: null, installType: null },
      git: { ok: false, version: null, path: null },
      gitBash: { ok: false, path: null, configured: false },
      shell: { ok: false, name: null, path: null },
      projectDir: { ok: false, readable: false, writable: false },
      claudeConfiguration: { ok: false, source: null },
      buildTools: { required: false, ok: null },
      providers: { runnable: 0 },
      dataDirectory: { ok: false, writable: false },
      sqlite: { ok: false, schemaVersion: null },
    };

    // Check Node.js
    try {
      const nodeVersion = runCommand('node', ['--version'], 5_000);
      const nodePath = resolveCommandPath('node');
      result.node = { ok: true, version: nodeVersion, path: nodePath };
    } catch {
      // Node.js not found
    }

    // Check Claude Code
    const claudeLease = options.claudeRuntime.gate.tryAcquireOrdinary();
    if (claudeLease) {
      try {
        const resolution = options.claudeRuntime.resolver.resolve();
        if (!resolution.ok) throw new Error(CLAUDE_PUBLIC_ERROR);
        const claudeVersion = runInvocation(resolution.invocation, ['--version'], 10_000);
        const claudePath = resolution.invocation.displayPath;
        let installType = 'npm';
        if (claudePath.includes('Program Files')) installType = 'global';
        else if (path.extname(claudePath).toLowerCase() === '.exe') installType = 'local';
        result.claude = { ok: true, version: claudeVersion, path: claudePath, installType };
      } catch {
        // Claude Code not found or not executable without a command shell.
      } finally {
        claudeLease.release();
      }
    }

    // Check Git
    try {
      const gitVersion = runCommand('git', ['--version'], 5_000);
      const gitPath = resolveCommandPath('git');
      result.git = { ok: true, version: gitVersion, path: gitPath };
    } catch {
      // Git not found
    }

    // Check Git Bash
    const bashInfo = detectGitBash();
    result.gitBash = {
      ok: bashInfo.path !== null,
      path: bashInfo.path,
      configured: bashInfo.configured,
    };

    // Check Shell
    const shellPath = process.env.COMSPEC || 'powershell.exe';
    result.shell = { ok: true, name: path.basename(shellPath), path: shellPath };

    // Project dir is checked separately
    result.projectDir = { ok: true, readable: true, writable: true };

    const hasClaudeEnvironment = Boolean(process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY);
    result.claudeConfiguration = {
      ok: hasClaudeEnvironment || result.claude.ok,
      source: hasClaudeEnvironment ? 'environment' : result.claude.ok ? 'claude_cli' : null,
    };

    let facts: SystemEnvironmentFacts = {
      dataDirectoryWritable: false,
      sqliteOk: false,
      sqliteSchemaVersion: null,
      runnableProviderCount: 0,
      sourceDevelopment: !app.isPackaged,
    };
    try {
      if (options.environmentFacts) facts = await options.environmentFacts();
    } catch {
      // Keep the environment screen available with closed, repairable states.
    }
    result.buildTools = {
      required: facts.sourceDevelopment,
      ok: facts.sourceDevelopment ? resolveCommandPath('cl') !== null : null,
    };
    result.providers = { runnable: Math.max(0, Math.trunc(facts.runnableProviderCount)) };
    result.dataDirectory = {
      ok: facts.dataDirectoryWritable,
      writable: facts.dataDirectoryWritable,
    };
    result.sqlite = {
      ok: facts.sqliteOk,
      schemaVersion: Number.isSafeInteger(facts.sqliteSchemaVersion) ? facts.sqliteSchemaVersion : null,
    };

    return result;
  });

  ipcMain.handle(
    IPC_CHANNELS.SYSTEM_OPEN_PATH,
    async (_event, targetPath: unknown) => {
      const authorizedPath = resolveAuthorizedDirectory(targetPath, options);
      try {
        const failure = await shell.openPath(authorizedPath);
        if (failure) throw new PublicIpcError('OPEN_PATH_FAILED');
      } catch {
        throw new PublicIpcError('OPEN_PATH_FAILED');
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SYSTEM_OPEN_VSCODE,
    async (_event, targetPath: unknown) => {
      const authorizedPath = resolveAuthorizedPath(targetPath, options);
      try {
        const executable = resolveVSCodeExecutable();
        if (!executable) throw new PublicIpcError('OPEN_VSCODE_FAILED');
        await new Promise<void>((resolve, reject) => {
          execFile(
            executable,
            [authorizedPath],
            { timeout: 5_000, windowsHide: true, shell: false },
            (error) => error ? reject(new PublicIpcError('OPEN_VSCODE_FAILED')) : resolve(),
          );
        });
      } catch {
        throw new PublicIpcError('OPEN_VSCODE_FAILED');
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SYSTEM_GET_CONNECTION_STATUS,
    async (): Promise<ConnectionStatus> => {
      const hasBaseUrl = !!process.env.ANTHROPIC_BASE_URL;
      const hasAuthToken = !!process.env.ANTHROPIC_AUTH_TOKEN;
      const hasApiKey = !!process.env.ANTHROPIC_API_KEY;

      let loginStatus: ConnectionStatus['loginStatus'] = 'unknown';
      const claudeLease = options.claudeRuntime.gate.tryAcquireOrdinary();
      if (!claudeLease) {
        loginStatus = 'not-detected';
      } else {
        try {
          const resolution = options.claudeRuntime.resolver.resolve();
          if (!resolution.ok) throw new Error(CLAUDE_PUBLIC_ERROR);
          runInvocation(resolution.invocation, ['--version'], 5_000);
          loginStatus = 'available';
        } catch {
          loginStatus = 'not-detected';
        } finally {
          claudeLease.release();
        }
      }

      return {
        connectionMethod: 'claude-environment',
        baseUrl: sanitizeBaseUrl(process.env.ANTHROPIC_BASE_URL),
        baseUrlDetected: hasBaseUrl,
        authToken: {
          configured: hasAuthToken,
          source: hasAuthToken ? 'environment' : null,
        },
        apiKey: {
          configured: hasApiKey,
          source: hasApiKey ? 'environment' : null,
        },
        loginStatus,
      };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SYSTEM_TEST_CLAUDE,
    async (): Promise<ClaudeTestResult> => {
      const startTime = Date.now();
      const result: ClaudeTestResult = {
        claudePath: 'claude',
        claudeVersion: null,
        detectedModel: null,
        baseUrlStatus: 'not-detected',
        success: false,
        durationMs: 0,
        error: null,
      };

      const claudeLease = options.claudeRuntime.gate.tryAcquireOrdinary();
      if (!claudeLease) {
        result.error = CLAUDE_PUBLIC_ERROR;
      } else {
        try {
          const resolution = options.claudeRuntime.resolver.resolve();
          if (!resolution.ok) throw new Error(CLAUDE_PUBLIC_ERROR);
          const claudeInvocation = resolution.invocation;
          result.claudePath = claudeInvocation.displayPath;

          // Get version
          const version = runInvocation(claudeInvocation, ['--version'], 10_000);
          result.claudeVersion = version;

          // Check base URL
          if (process.env.ANTHROPIC_BASE_URL) {
            result.baseUrlStatus = 'configured';
          } else {
            result.baseUrlStatus = 'default';
          }

          // Try a simple read-only test
          try {
            runInvocation(claudeInvocation, ['--help'], 10_000);
            result.success = true;
          } catch {
            result.error = CLAUDE_PUBLIC_ERROR;
          }
        } catch {
          result.error = CLAUDE_PUBLIC_ERROR;
        } finally {
          claudeLease.release();
        }
      }

      result.durationMs = Date.now() - startTime;
      return result;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SYSTEM_GET_DIAGNOSTICS,
    async (): Promise<DiagnosticsInfo> => {
      let claudePath: string | null = null;
      let claudeVersion: string | null = null;
      let installType: string | null = null;
      const claudeLease = options.claudeRuntime.gate.tryAcquireOrdinary();
      if (claudeLease) {
        try {
          const resolution = options.claudeRuntime.resolver.resolve();
          if (!resolution.ok) throw new Error(CLAUDE_PUBLIC_ERROR);
          claudePath = resolution.invocation.displayPath;
          claudeVersion = runInvocation(resolution.invocation, ['--version'], 5_000);
          if (claudePath.includes('Program Files')) installType = 'global';
          else if (path.extname(claudePath).toLowerCase() === '.exe') installType = 'local';
          else installType = 'npm';
        } catch {
          // not found
        } finally {
          claudeLease.release();
        }
      }

      const gitPath = resolveCommandPath('git');
      let gitVersion: string | null = null;
      try {
        gitVersion = runCommand('git', ['--version'], 5_000);
      } catch {
        // not found
      }

      const bashInfo = detectGitBash();

      return {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        electronVersion: process.versions.electron || 'unknown',
        appVersion: app.getVersion(),
        claude: {
          path: claudePath,
          version: claudeVersion,
          installType,
        },
        git: {
          path: gitPath,
          version: gitVersion,
        },
        gitBash: {
          path: bashInfo.path,
          configured: bashInfo.configured,
        },
        environment: {
          hasBaseUrl: !!process.env.ANTHROPIC_BASE_URL,
          hasAuthToken: !!process.env.ANTHROPIC_AUTH_TOKEN,
          hasApiKey: !!process.env.ANTHROPIC_API_KEY,
          shellType: process.env.SHELL || process.env.COMSPEC || 'unknown',
        },
      };
    },
  );
}
