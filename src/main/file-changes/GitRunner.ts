import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface GitCommandResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export interface GitRunOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  allowNonZeroExit?: boolean;
}

export type GitSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly code: 'START_FAILED' | 'TIMEOUT' | 'OUTPUT_LIMIT' | 'EXIT_NON_ZERO',
    readonly exitCode: number | null = null,
  ) {
    super(message);
    this.name = 'GitCommandError';
  }
}

/** Executes Git without a shell and with bounded output and runtime. */
export class GitRunner {
  constructor(
    private readonly gitPath = 'git',
    private readonly spawnProcess: GitSpawn = spawn,
  ) {}

  run(cwd: string, args: readonly string[], options: GitRunOptions = {}): Promise<GitCommandResult> {
    if (!this.gitPath || this.gitPath.includes('\0')) {
      return Promise.reject(new GitCommandError('Git executable path is invalid.', 'START_FAILED'));
    }
    if (args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
      return Promise.reject(new GitCommandError('Git arguments contain an invalid null byte.', 'START_FAILED'));
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawnProcess(this.gitPath, [...args], {
          cwd,
          env: {
            ...process.env,
            GIT_PAGER: 'cat',
            GIT_TERMINAL_PROMPT: '0',
          },
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(new GitCommandError(
          `Unable to start Git: ${error instanceof Error ? error.message : String(error)}`,
          'START_FAILED',
        ));
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;

      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };

      const failForLimit = () => finish(() => {
        child.kill();
        reject(new GitCommandError('Git output exceeded the configured safety limit.', 'OUTPUT_LIMIT'));
      });

      const collect = (target: Buffer[]) => (chunk: Buffer | string) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += buffer.length;
        if (outputBytes > maxOutputBytes) {
          failForLimit();
          return;
        }
        target.push(buffer);
      };

      child.stdout?.on('data', collect(stdout));
      child.stderr?.on('data', collect(stderr));
      child.once('error', (error) => finish(() => reject(new GitCommandError(
        `Unable to run Git: ${error.message}`,
        'START_FAILED',
      ))));
      child.once('close', (code) => finish(() => {
        const result: GitCommandResult = {
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          exitCode: code ?? -1,
        };
        if (result.exitCode !== 0 && !options.allowNonZeroExit) {
          const detail = result.stderr.toString('utf8').trim().slice(0, 1_000);
          reject(new GitCommandError(
            detail ? `Git exited with code ${result.exitCode}: ${detail}` : `Git exited with code ${result.exitCode}.`,
            'EXIT_NON_ZERO',
            result.exitCode,
          ));
          return;
        }
        resolve(result);
      }));

      const timer = setTimeout(() => finish(() => {
        child.kill();
        reject(new GitCommandError(`Git timed out after ${timeoutMs}ms.`, 'TIMEOUT'));
      }), timeoutMs);
      timer.unref?.();
    });
  }

  async runText(cwd: string, args: readonly string[], options?: GitRunOptions): Promise<string> {
    const result = await this.run(cwd, args, options);
    return result.stdout.toString('utf8');
  }

  async succeeds(cwd: string, args: readonly string[], options?: GitRunOptions): Promise<boolean> {
    const result = await this.run(cwd, args, { ...options, allowNonZeroExit: true });
    return result.exitCode === 0;
  }
}
