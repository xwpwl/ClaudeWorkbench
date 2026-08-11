import { execFileSync, spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GIT_DIFF_MAX_BYTES,
  DEFAULT_GIT_DIFF_MAX_LINES,
  GitWorkspaceService,
} from '../GitWorkspaceService';
import { GitCommandError, GitRunner } from '../../file-changes/GitRunner';

describe('GitWorkspaceService initialization', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-git-init-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('initializes a safely resolved project with only the fixed git init argv', async () => {
    const calls: string[][] = [];
    const runner = new GitRunner(
      'git',
      (command, args, options) => {
        calls.push([...args]);
        return spawn(command, args, options);
      },
    );
    const service = new GitWorkspaceService(runner);

    const status = await service.initialize(root);

    expect(status.projectPath).toBe(await fs.realpath(root));
    expect(status.head).toBeNull();
    expect((await fs.stat(path.join(root, '.git'))).isDirectory()).toBe(true);
    expect(calls.filter((args) => args[0] === 'init')).toEqual([['init']]);
  });

  it('is idempotent for an existing repository and preserves its Git metadata', async () => {
    const calls: string[][] = [];
    const runner = new GitRunner(
      'git',
      (command, args, options) => {
        calls.push([...args]);
        return spawn(command, args, options);
      },
    );
    const service = new GitWorkspaceService(runner);
    await service.initialize(root);
    await fs.writeFile(path.join(root, '.git', 'workbench-marker'), 'preserve');

    await service.initialize(root);

    expect(await fs.readFile(path.join(root, '.git', 'workbench-marker'), 'utf8')).toBe('preserve');
    expect(calls.filter((args) => args[0] === 'init')).toEqual([['init']]);
  });

  it('rejects an unsafe project path before invoking Git', async () => {
    const run = vi.fn();
    const service = new GitWorkspaceService({ run } as never);

    await expect(service.initialize('.')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(run).not.toHaveBeenCalled();
  });

  it('propagates Git runner failures without attempting initialization', async () => {
    const failure = new GitCommandError('Unable to start Git.', 'START_FAILED');
    const run = vi.fn().mockRejectedValue(failure);
    const service = new GitWorkspaceService({ run } as never);

    await expect(service.initialize(root)).rejects.toBe(failure);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls.some(([, args]) => args[0] === 'init')).toBe(false);
  });

  it('does not treat an unexpected rev-parse failure as a non-repository', async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: Buffer.alloc(0),
      stderr: Buffer.from('fatal: detected dubious ownership in repository'),
      exitCode: 128,
    });
    const service = new GitWorkspaceService({ run } as never);

    await expect(service.initialize(root)).rejects.toMatchObject({ code: 'INVALID_GIT_OUTPUT' });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls.some(([, args]) => args[0] === 'init')).toBe(false);
  });
});

describe('GitWorkspaceService status', () => {
  const service = new GitWorkspaceService();
  let root: string;

  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();

  const write = async (relative: string, content: string | Buffer) => {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  };

  const commitBase = async (content = 'base\n') => {
    await write('tracked.txt', content);
    git('add', '--', 'tracked.txt');
    git('commit', '--quiet', '-m', 'base');
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-git-status-'));
    git('init', '--quiet');
    git('branch', '-M', 'main');
    git('config', 'user.name', 'Workbench Test');
    git('config', 'user.email', 'workbench@example.test');
    git('config', 'core.autocrlf', 'false');
    git('config', 'core.quotepath', 'false');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reports a clean repository, branch, and HEAD', async () => {
    await commitBase();
    const status = await service.getStatus(root);
    expect(status).toMatchObject({ branch: 'main', detached: false, clean: true, ahead: 0, behind: 0 });
    expect(status.head).toMatch(/^[a-f0-9]{40,64}$/u);
    expect(status.files).toEqual([]);
  });

  it('reports an unstaged modification', async () => {
    await commitBase();
    await write('tracked.txt', 'base\nchanged\n');
    expect((await service.getStatus(root)).files[0]).toMatchObject({
      filePath: 'tracked.txt', statusCode: ' M', staged: false, unstaged: true, changeType: 'modified',
    });
  });

  it('reports a staged modification', async () => {
    await commitBase();
    await write('tracked.txt', 'changed\n');
    git('add', '--', 'tracked.txt');
    expect((await service.getStatus(root)).files[0]).toMatchObject({
      statusCode: 'M ', staged: true, unstaged: false,
    });
  });

  it('reports staged and unstaged changes on the same file', async () => {
    await commitBase();
    await write('tracked.txt', 'base\nstaged\n');
    git('add', '--', 'tracked.txt');
    await write('tracked.txt', 'base\nstaged\nunstaged\n');
    expect((await service.getStatus(root)).files[0]).toMatchObject({
      statusCode: 'MM', staged: true, unstaged: true, additions: 2, deletions: 0,
    });
  });

  it('classifies an untracked file separately from an added file', async () => {
    await commitBase();
    await write('new.txt', 'one\ntwo\n');
    const status = await service.getStatus(root);
    expect(status.untrackedFiles[0]).toMatchObject({
      filePath: 'new.txt', statusCode: '??', changeType: 'untracked', additions: 2, untracked: true,
    });
    expect(status.stagedFiles).toEqual([]);
  });

  it('reports a staged added file', async () => {
    await commitBase();
    await write('added.txt', 'new\n');
    git('add', '--', 'added.txt');
    expect((await service.getStatus(root)).files[0]).toMatchObject({
      filePath: 'added.txt', changeType: 'added', staged: true, untracked: false, additions: 1,
    });
  });

  it('reports an unstaged deletion and its numstat', async () => {
    await commitBase('one\ntwo\n');
    await fs.unlink(path.join(root, 'tracked.txt'));
    expect((await service.getStatus(root)).files[0]).toMatchObject({
      changeType: 'deleted', unstaged: true, additions: 0, deletions: 2,
    });
  });

  it('reports a staged deletion', async () => {
    await commitBase();
    git('rm', '--quiet', '--', 'tracked.txt');
    expect((await service.getStatus(root)).files[0]).toMatchObject({
      changeType: 'deleted', staged: true, unstaged: false,
    });
  });

  it('reports both paths for a staged rename', async () => {
    await commitBase();
    git('mv', '--', 'tracked.txt', 'renamed.txt');
    expect((await service.getStatus(root)).files[0]).toMatchObject({
      filePath: 'renamed.txt', originalPath: 'tracked.txt', changeType: 'renamed', staged: true,
    });
  });

  it('treats shell metacharacters as literal path data', async () => {
    await commitBase();
    await write('safe & literal $(echo no).txt', 'literal\n');
    expect((await service.getStatus(root)).untrackedFiles[0].filePath).toBe('safe & literal $(echo no).txt');
  });

  it('preserves Unicode paths', async () => {
    await commitBase();
    await write('目录/你好.txt', '内容\n');
    expect((await service.getStatus(root)).untrackedFiles[0].filePath).toBe('目录/你好.txt');
  });

  it('sorts status files by repository-relative path', async () => {
    await commitBase();
    await write('z.txt', 'z\n');
    await write('a.txt', 'a\n');
    expect((await service.getStatus(root)).files.map((file) => file.filePath))
      .toEqual(['a.txt', 'z.txt']);
  });

  it('sums additions and deletions across files', async () => {
    await commitBase('old-one\nold-two\n');
    await write('tracked.txt', 'new\n');
    await write('new.txt', 'a\nb\n');
    const status = await service.getStatus(root);
    expect(status).toMatchObject({ additions: 3, deletions: 2, clean: false });
  });

  it('projects staged and unstaged lists independently', async () => {
    await commitBase();
    await write('staged.txt', 'staged\n');
    git('add', '--', 'staged.txt');
    await write('tracked.txt', 'changed\n');
    const status = await service.getStatus(root);
    expect(status.stagedFiles.map((file) => file.filePath)).toEqual(['staged.txt']);
    expect(status.unstagedFiles.map((file) => file.filePath)).toEqual(['tracked.txt']);
  });

  it('reports detached HEAD without inventing a branch', async () => {
    await commitBase();
    const head = git('rev-parse', 'HEAD');
    git('switch', '--detach', '--quiet', head);
    expect(await service.getStatus(root)).toMatchObject({ branch: null, detached: true, head });
  });

  it('supports an unborn branch and staged initial content', async () => {
    await write('initial.txt', 'first\nsecond\n');
    git('add', '--', 'initial.txt');
    const status = await service.getStatus(root);
    expect(status).toMatchObject({ branch: 'main', head: null, detached: false, additions: 2 });
    expect(status.files[0]).toMatchObject({ changeType: 'added', staged: true });
  });

  it('reports a local branch ahead of its configured upstream', async () => {
    await commitBase();
    const base = git('rev-parse', 'HEAD');
    git('config', 'remote.origin.url', 'https://example.invalid/workbench.git');
    git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    git('update-ref', 'refs/remotes/origin/main', base);
    git('branch', '--set-upstream-to=origin/main', 'main');
    await write('second.txt', 'second\n');
    git('add', '--', 'second.txt');
    git('commit', '--quiet', '-m', 'second');
    expect(await service.getStatus(root)).toMatchObject({ upstream: 'origin/main', ahead: 1, behind: 0 });
  });

  it('reports a local branch behind its configured upstream', async () => {
    await commitBase();
    const head = git('rev-parse', 'HEAD');
    const tree = git('rev-parse', 'HEAD^{tree}');
    const remoteCommit = git('commit-tree', tree, '-p', head, '-m', 'remote');
    git('config', 'remote.origin.url', 'https://example.invalid/workbench.git');
    git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    git('update-ref', 'refs/remotes/origin/main', remoteCommit);
    git('branch', '--set-upstream-to=origin/main', 'main');
    expect(await service.getStatus(root)).toMatchObject({ upstream: 'origin/main', ahead: 0, behind: 1 });
  });

  it('marks a bounded untracked binary file without exposing line stats', async () => {
    await commitBase();
    await write('image.bin', Buffer.from([0, 1, 2, 3]));
    expect((await service.getStatus(root)).files[0]).toMatchObject({
      isBinary: true, statsAvailable: false, additions: 0, deletions: 0,
    });
  });

  it('does not read an oversized untracked file for status statistics', async () => {
    await commitBase();
    await write('large.txt', Buffer.alloc(DEFAULT_GIT_DIFF_MAX_BYTES + 1, 0x61));
    expect((await service.getStatus(root)).files[0]).toMatchObject({
      isBinary: false, statsAvailable: false, additions: 0,
    });
  });

  it('rejects a non-repository directory', async () => {
    const separate = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-not-git-'));
    try {
      await expect(service.getStatus(separate)).rejects.toMatchObject({ code: 'NOT_A_REPOSITORY' });
    } finally {
      await fs.rm(separate, { recursive: true, force: true });
    }
  });

  it('rejects a relative project path before invoking Git', async () => {
    await expect(service.getStatus('.')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('rejects a missing project directory', async () => {
    await expect(service.getStatus(path.join(root, 'missing'))).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });
});

describe('GitWorkspaceService diffs', () => {
  const service = new GitWorkspaceService();
  let root: string;

  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const write = async (relative: string, content: string | Buffer) => {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-git-diff-'));
    git('init', '--quiet');
    git('branch', '-M', 'main');
    git('config', 'user.name', 'Workbench Test');
    git('config', 'user.email', 'workbench@example.test');
    git('config', 'core.autocrlf', 'false');
    await write('tracked.txt', 'base\n');
    git('add', '--', 'tracked.txt');
    git('commit', '--quiet', '-m', 'base');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns a bounded HEAD-to-worktree patch by default', async () => {
    await write('tracked.txt', 'base\nchanged\n');
    const diff = (await service.getDiff(root))[0];
    expect(diff).toMatchObject({ filePath: 'tracked.txt', additions: 1, tooLarge: false, omittedReason: null });
    expect(diff.patch).toContain('+changed');
  });

  it('returns only the staged portion in staged mode', async () => {
    await write('tracked.txt', 'base\nstaged\n');
    git('add', '--', 'tracked.txt');
    await write('tracked.txt', 'base\nstaged\nunstaged\n');
    const diff = (await service.getDiff(root, { mode: 'staged' }))[0];
    expect(diff.patch).toContain('+staged');
    expect(diff.patch).not.toContain('+unstaged');
    expect(diff.additions).toBe(1);
  });

  it('returns only the index-to-worktree portion in unstaged mode', async () => {
    await write('tracked.txt', 'base\nstaged\n');
    git('add', '--', 'tracked.txt');
    await write('tracked.txt', 'base\nstaged\nunstaged\n');
    const diff = (await service.getDiff(root, { mode: 'unstaged' }))[0];
    expect(diff.patch).toContain('+unstaged');
    expect(diff.patch).not.toContain('+staged');
    expect(diff.additions).toBe(1);
  });

  it('supports the staged boolean shorthand', async () => {
    await write('tracked.txt', 'base\nstaged\n');
    git('add', '--', 'tracked.txt');
    expect((await service.getDiff(root, { staged: true }))[0].patch).toContain('+staged');
  });

  it('supports the unstaged boolean shorthand', async () => {
    await write('tracked.txt', 'base\nstaged\n');
    git('add', '--', 'tracked.txt');
    await write('tracked.txt', 'base\nstaged\nunstaged\n');
    expect((await service.getDiff(root, { staged: false }))[0].patch).toContain('+unstaged');
  });

  it('filters diffs using safely resolved literal paths', async () => {
    await write('tracked.txt', 'changed\n');
    await write('other.txt', 'other\n');
    expect((await service.getDiff(root, { filePaths: ['other.txt'] })).map((diff) => diff.filePath))
      .toEqual(['other.txt']);
  });

  it('returns an empty list for an unchanged requested file', async () => {
    expect(await service.getDiff(root, { filePaths: ['tracked.txt'] })).toEqual([]);
  });

  it('rejects parent traversal in a requested path', async () => {
    await expect(service.getDiff(root, { filePaths: ['../outside.txt'] }))
      .rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('rejects an absolute requested path', async () => {
    await expect(service.getDiff(root, { filePaths: [path.join(root, 'tracked.txt')] }))
      .rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('rejects a null byte in a requested path', async () => {
    await expect(service.getDiff(root, { filePaths: ['bad\0path.txt'] }))
      .rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('protects a binary tracked diff', async () => {
    await write('tracked.txt', Buffer.from([0, 1, 2, 3]));
    expect((await service.getDiff(root))[0]).toMatchObject({
      isBinary: true, tooLarge: false, patch: null, omittedReason: 'binary',
    });
  });

  it('protects a tracked file larger than the hard byte limit', async () => {
    await write('tracked.txt', Buffer.alloc(DEFAULT_GIT_DIFF_MAX_BYTES + 1, 0x61));
    expect((await service.getDiff(root))[0]).toMatchObject({
      isBinary: false, tooLarge: true, patch: null, omittedReason: 'bytes',
    });
  });

  it('does not let an option raise the hard byte limit', async () => {
    await write('tracked.txt', Buffer.alloc(DEFAULT_GIT_DIFF_MAX_BYTES + 1, 0x61));
    expect((await service.getDiff(root, { maxBytes: DEFAULT_GIT_DIFF_MAX_BYTES * 4 }))[0])
      .toMatchObject({ tooLarge: true, omittedReason: 'bytes' });
  });

  it('supports a lower caller-selected byte limit', async () => {
    await write('tracked.txt', 'base\nchanged\n');
    expect((await service.getDiff(root, { maxBytes: 8 }))[0])
      .toMatchObject({ tooLarge: true, omittedReason: 'bytes' });
  });

  it('protects content above the hard line limit', async () => {
    await write('tracked.txt', `${'line\n'.repeat(DEFAULT_GIT_DIFF_MAX_LINES)}last`);
    expect((await service.getDiff(root))[0]).toMatchObject({
      tooLarge: true, patch: null, omittedReason: 'lines',
    });
  });

  it('supports a lower caller-selected line limit', async () => {
    await write('tracked.txt', 'one\ntwo\nthree\n');
    expect((await service.getDiff(root, { maxLines: 2 }))[0])
      .toMatchObject({ tooLarge: true, omittedReason: 'lines' });
  });

  it('emits a deterministic synthetic patch for an untracked text file', async () => {
    await write('new file.txt', 'one\ntwo\n');
    const diff = (await service.getDiff(root))[0];
    expect(diff).toMatchObject({ changeType: 'untracked', additions: 2, omittedReason: null });
    expect(diff.patch).toContain('--- /dev/null');
    expect(diff.patch).toContain('+one\n+two');
  });

  it('marks a missing final newline in a synthetic patch', async () => {
    await write('new.txt', 'no newline');
    expect((await service.getDiff(root))[0].patch).toContain('\\ No newline at end of file');
  });

  it('represents an empty untracked file without inventing a content line', async () => {
    await write('empty.txt', '');
    const diff = (await service.getDiff(root))[0];
    expect(diff).toMatchObject({ additions: 0, deletions: 0, tooLarge: false });
    expect(diff.patch).toContain('index 0000000..e69de29');
    expect(diff.patch).not.toContain('@@');
  });

  it('can exclude untracked files', async () => {
    await write('new.txt', 'new\n');
    expect(await service.getDiff(root, { includeUntracked: false })).toEqual([]);
  });

  it('returns a deletion patch', async () => {
    await fs.unlink(path.join(root, 'tracked.txt'));
    const diff = (await service.getDiff(root))[0];
    expect(diff).toMatchObject({ changeType: 'deleted', deletions: 1 });
    expect(diff.patch).toContain('-base');
  });

  it('returns a rename patch with both repository paths', async () => {
    git('mv', '--', 'tracked.txt', 'renamed.txt');
    const diff = (await service.getDiff(root))[0];
    expect(diff).toMatchObject({ filePath: 'renamed.txt', originalPath: 'tracked.txt', changeType: 'renamed' });
    expect(diff.patch).toContain('rename from tracked.txt');
  });

  it('honors a zero-context diff request', async () => {
    await write('tracked.txt', 'changed\n');
    expect((await service.getDiff(root, { contextLines: 0 }))[0].patch).toContain('@@ -1 +1 @@');
  });

  it('keeps shell metacharacters inside a literal argv pathspec', async () => {
    const special = 'literal & safe.txt';
    await write(special, 'safe\n');
    expect((await service.getDiff(root, { filePaths: [special] }))[0]).toMatchObject({ filePath: special });
  });

  it.each([
    [{ contextLines: -1 }, 'INVALID_OPTIONS'],
    [{ contextLines: 101 }, 'INVALID_OPTIONS'],
    [{ contextLines: 1.5 }, 'INVALID_OPTIONS'],
    [{ maxBytes: 0 }, 'INVALID_OPTIONS'],
    [{ maxLines: Number.NaN }, 'INVALID_OPTIONS'],
    [{ mode: 'staged', staged: true }, 'INVALID_OPTIONS'],
  ] as const)('rejects invalid diff options %#', async (options, code) => {
    await expect(service.getDiff(root, options)).rejects.toMatchObject({ code });
  });

  it('bounds the number of caller-supplied pathspecs', async () => {
    const paths = Array.from({ length: 1_001 }, (_, index) => `file-${index}.txt`);
    await expect(service.getDiff(root, { filePaths: paths }))
      .rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
  });
});
