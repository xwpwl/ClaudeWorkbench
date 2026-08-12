import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { EnvironmentCheckResult } from '../../shared/types/ipc';

/**
 * Checks the local environment for required tools and permissions.
 */
export function checkEnvironment(): EnvironmentCheckResult {
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
    const nodeVersion = execSync('node --version', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    result.node = { ok: true, version: nodeVersion, path: 'node' };
  } catch {
    // Node.js not found
  }

  // Check Claude Code
  try {
    const claudeVersion = execSync('claude --version', {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
    result.claude = { ok: true, version: claudeVersion, path: 'claude', installType: 'npm' };
  } catch {
    // Try common alternative locations
    const altPaths = [
      path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'claude', 'claude.exe'),
    ];

    for (const altPath of altPaths) {
      try {
        if (fs.existsSync(altPath)) {
          const claudeVersion = execSync(`"${altPath}" --version`, {
            encoding: 'utf-8',
            timeout: 10000,
          }).trim();
          result.claude = { ok: true, version: claudeVersion, path: altPath, installType: 'alternative' };
          break;
        }
      } catch {
        continue;
      }
    }
  }

  // Check Git
  try {
    const gitVersion = execSync('git --version', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    result.git = { ok: true, version: gitVersion, path: 'git' };
  } catch {
    // Git not found
  }

  // Check Shell
  const shellPath = process.env.COMSPEC || 'powershell.exe';
  result.shell = { ok: true, name: path.basename(shellPath), path: shellPath };

  // Project dir is checked separately
  result.projectDir = { ok: true, readable: true, writable: true };

  return result;
}

/**
 * Checks if a specific project directory is accessible.
 */
export function checkProjectDirectory(projectPath: string): {
  ok: boolean;
  readable: boolean;
  writable: boolean;
  isGitRepo: boolean;
} {
  let readable = false;
  let writable = false;
  let isGitRepo = false;

  try {
    fs.accessSync(projectPath, fs.constants.R_OK);
    readable = true;
  } catch {
    // Not readable
  }

  try {
    fs.accessSync(projectPath, fs.constants.W_OK);
    writable = true;
  } catch {
    // Not writable
  }

  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: projectPath,
      timeout: 5000,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    isGitRepo = true;
  } catch {
    // Not a git repo
  }

  return {
    ok: readable,
    readable,
    writable,
    isGitRepo,
  };
}
