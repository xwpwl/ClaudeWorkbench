import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { describe, expect, it, vi } from 'vitest';
import { GitCommandError, GitRunner, type GitSpawn } from '../GitRunner';

function makeChild() {
  const child = new EventEmitter() as ChildProcess & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

describe('GitRunner', () => {
  it('passes every Git argument separately with shell disabled', async () => {
    let captured: { command: string; args: string[]; options: SpawnOptions } | null = null;
    const spawnProcess: GitSpawn = (command, args, options) => {
      captured = { command, args, options };
      const child = makeChild();
      queueMicrotask(() => {
        child.stdout.end('ok');
        child.emit('close', 0);
      });
      return child;
    };
    const runner = new GitRunner('C:\\Program Files\\Git\\bin\\git.exe', spawnProcess);
    const malicious = 'name" & calc.exe &.txt';

    await expect(runner.runText('C:\\repo', ['diff', 'HEAD', '--', malicious])).resolves.toBe('ok');
    expect(captured).toEqual({
      command: 'C:\\Program Files\\Git\\bin\\git.exe',
      args: ['diff', 'HEAD', '--', malicious],
      options: expect.objectContaining({
        cwd: 'C:\\repo',
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    });
  });

  it('rejects a null byte before spawning Git', async () => {
    const spawnProcess = vi.fn() as unknown as GitSpawn;
    const runner = new GitRunner('git', spawnProcess);
    await expect(runner.run(process.cwd(), ['diff', 'bad\0path']))
      .rejects.toMatchObject({ code: 'START_FAILED' });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('kills Git when combined output exceeds the configured limit', async () => {
    const child = makeChild();
    const runner = new GitRunner('git', () => {
      queueMicrotask(() => child.stdout.write(Buffer.alloc(32, 1)));
      return child;
    });
    await expect(runner.run(process.cwd(), ['status'], { maxOutputBytes: 16 }))
      .rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('returns a bounded non-zero exit error with the exit code', async () => {
    const child = makeChild();
    const runner = new GitRunner('git', () => {
      queueMicrotask(() => {
        child.stderr.end('fatal: expected failure');
        child.emit('close', 128);
      });
      return child;
    });
    await expect(runner.run(process.cwd(), ['show', 'missing']))
      .rejects.toMatchObject({ code: 'EXIT_NON_ZERO', exitCode: 128 });
  });

  it('can explicitly inspect a non-zero exit without throwing', async () => {
    const child = makeChild();
    const runner = new GitRunner('git', () => {
      queueMicrotask(() => child.emit('close', 1));
      return child;
    });
    await expect(runner.succeeds(process.cwd(), ['rev-parse', '--verify', 'HEAD']))
      .resolves.toBe(false);
  });

  it('wraps synchronous process start failures', async () => {
    const runner = new GitRunner('git', () => {
      throw new Error('spawn unavailable');
    });
    await expect(runner.run(process.cwd(), ['status']))
      .rejects.toEqual(expect.objectContaining<Partial<GitCommandError>>({ code: 'START_FAILED' }));
  });
});

