import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  MAX_DIFF_BYTES,
  MAX_DIFF_LINES,
  WorkingTreeService,
  parseNumstatZ,
  parsePorcelainV1Z,
} from '../WorkingTreeService';

describe('Git -z parsers', () => {
  it('preserves the two porcelain status columns', () => {
    expect(parsePorcelainV1Z(' M worktree.ts\0M  staged.ts\0MM both.ts\0?? new.ts\0'))
      .toMatchObject([
        { filePath: 'worktree.ts', statusCode: ' M', staged: false, unstaged: true },
        { filePath: 'staged.ts', statusCode: 'M ', staged: true, unstaged: false },
        { filePath: 'both.ts', statusCode: 'MM', staged: true, unstaged: true },
        { filePath: 'new.ts', statusCode: '??', staged: false, unstaged: true, changeType: 'added' },
      ]);
  });

  it('parses porcelain rename destination followed by source', () => {
    expect(parsePorcelainV1Z('R  new name.ts\0old name.ts\0')).toEqual([{
      filePath: 'new name.ts',
      originalPath: 'old name.ts',
      statusCode: 'R ',
      changeType: 'renamed',
      staged: true,
      unstaged: false,
    }]);
  });

  it('consumes the second path for a copy record', () => {
    expect(parsePorcelainV1Z('C  copy.ts\0source.ts\0 M next.ts\0')).toHaveLength(2);
    expect(parsePorcelainV1Z('C  copy.ts\0source.ts\0')[0]).toMatchObject({
      changeType: 'copied',
      originalPath: 'source.ts',
    });
  });

  it('preserves whitespace, newlines, quotes, and Unicode inside NUL-delimited paths', () => {
    const special = 'folder/line\nwith\ttab "你好".ts';
    expect(parsePorcelainV1Z(` M ${special}\0`)[0].filePath).toBe(special);
  });

  it('classifies merge conflict status', () => {
    expect(parsePorcelainV1Z('UU conflict.ts\0')[0].changeType).toBe('unmerged');
  });

  it('rejects an incomplete porcelain rename', () => {
    expect(() => parsePorcelainV1Z('R  new.ts\0')).toThrow('incomplete rename');
  });

  it('parses normal numstat records', () => {
    expect(parseNumstatZ('12\t3\tsrc/file.ts\0')).toEqual([{
      filePath: 'src/file.ts',
      additions: 12,
      deletions: 3,
      isBinary: false,
    }]);
  });

  it('parses binary numstat records without inventing line counts', () => {
    expect(parseNumstatZ('-\t-\timage.png\0')[0]).toMatchObject({
      additions: 0,
      deletions: 0,
      isBinary: true,
    });
  });

  it('parses numstat rename source and destination fields', () => {
    expect(parseNumstatZ('1\t2\t\0old.ts\0new.ts\0')).toEqual([{
      filePath: 'new.ts',
      originalPath: 'old.ts',
      additions: 1,
      deletions: 2,
      isBinary: false,
    }]);
  });

  it('does not split a tab contained in a normal path after the two count fields', () => {
    expect(parseNumstatZ('1\t0\tpath/with\ttab.ts\0')[0].filePath).toBe('path/with\ttab.ts');
  });

  it('rejects malformed numstat counts', () => {
    expect(() => parseNumstatZ('many\t0\tfile.ts\0')).toThrow('invalid numstat count');
  });
});

describe('WorkingTreeService integration', () => {
  const service = new WorkingTreeService();
  let root: string;

  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const write = (relative: string, content: string | Buffer) =>
    fs.writeFile(path.join(root, relative), content);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-diff-'));
    git('init', '--quiet');
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

  it('compares HEAD with the worktree when a file has staged and unstaged edits', async () => {
    await write('tracked.txt', 'base\nstaged\n');
    git('add', '--', 'tracked.txt');
    await write('tracked.txt', 'base\nstaged\nworktree\n');

    const change = (await service.listChanges(root))[0];
    expect(change).toMatchObject({ statusCode: 'MM', additions: 2, deletions: 0 });

    const diff = await service.getDiff(root, 'tracked.txt');
    expect(diff.oldContent).toBe('base\n');
    expect(diff.newContent).toBe('base\nstaged\nworktree\n');
  });

  it('represents an untracked text file as an empty HEAD side', async () => {
    await write('new file.txt', 'one\ntwo\n');
    const change = (await service.listChanges(root)).find((item) => item.filePath === 'new file.txt');
    expect(change).toMatchObject({ changeType: 'added', additions: 2, canRestore: false });

    const diff = await service.getDiff(root, 'new file.txt');
    expect(diff.oldContent).toBeNull();
    expect(diff.newContent).toBe('one\ntwo\n');
  });

  it('represents a deleted file with an empty worktree side', async () => {
    await fs.unlink(path.join(root, 'tracked.txt'));
    const diff = await service.getDiff(root, 'tracked.txt');
    expect(diff.oldContent).toBe('base\n');
    expect(diff.newContent).toBeNull();
    expect(diff.deletions).toBe(1);
  });

  it('uses the original HEAD path for a rename', async () => {
    git('mv', '--', 'tracked.txt', 'renamed file.txt');
    const change = (await service.listChanges(root))[0];
    expect(change).toMatchObject({
      filePath: 'renamed file.txt',
      originalPath: 'tracked.txt',
      changeType: 'renamed',
    });
    const diff = await service.getDiff(root, 'renamed file.txt');
    expect(diff.oldContent).toBe('base\n');
    expect(diff.newContent).toBe('base\n');
  });

  it('protects binary files and does not return their content', async () => {
    await write('tracked.txt', Buffer.from([0, 1, 2, 3, 4]));
    const diff = await service.getDiff(root, 'tracked.txt');
    expect(diff).toMatchObject({ isBinary: true, tooLarge: false, oldContent: null, newContent: null });
  });

  it('protects a worktree file larger than 2 MiB', async () => {
    await write('tracked.txt', Buffer.alloc(MAX_DIFF_BYTES + 1, 0x61));
    const diff = await service.getDiff(root, 'tracked.txt');
    expect(diff.tooLarge).toBe(true);
    expect(diff.limit).toMatchObject({ reason: 'bytes', maxBytes: MAX_DIFF_BYTES });
    expect(diff.newContent).toBeNull();
  });

  it('accepts exactly 5000 text lines', async () => {
    const content = Array.from({ length: MAX_DIFF_LINES }, (_, index) => `line ${index}`).join('\n');
    await write('tracked.txt', content);
    const diff = await service.getDiff(root, 'tracked.txt');
    expect(diff.tooLarge).toBe(false);
    expect(diff.newContent).toBe(content);
  });

  it('protects a text file with 5001 lines', async () => {
    await write('tracked.txt', `${'line\n'.repeat(MAX_DIFF_LINES)}last`);
    const diff = await service.getDiff(root, 'tracked.txt');
    expect(diff.tooLarge).toBe(true);
    expect(diff.limit).toMatchObject({ reason: 'lines', newLines: MAX_DIFF_LINES + 1 });
    expect(diff.newContent).toBeNull();
  });

  it('rejects a renderer path that escapes the repository', async () => {
    await expect(service.getDiff(root, '../outside.txt')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('restores a tracked modification from HEAD', async () => {
    await write('tracked.txt', 'changed\n');
    const preparation = await service.prepareRestore(root, 'tracked.txt');
    await service.restore(root, 'tracked.txt', preparation.fingerprint);
    expect(await fs.readFile(path.join(root, 'tracked.txt'), 'utf8')).toBe('base\n');
    expect(await service.listChanges(root)).toEqual([]);
  });

  it('restores both sides of a tracked rename from HEAD', async () => {
    git('mv', '--', 'tracked.txt', 'renamed.txt');
    const preparation = await service.prepareRestore(root, 'renamed.txt');
    await service.restore(root, 'renamed.txt', preparation.fingerprint);
    expect(await fs.readFile(path.join(root, 'tracked.txt'), 'utf8')).toBe('base\n');
    await expect(fs.stat(path.join(root, 'renamed.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await service.listChanges(root)).toEqual([]);
  });

  it('does not delete an untracked file through restore', async () => {
    await write('untracked.txt', 'keep me\n');
    await expect(service.prepareRestore(root, 'untracked.txt')).rejects.toMatchObject({ code: 'RESTORE_UNSAFE' });
    expect(await fs.readFile(path.join(root, 'untracked.txt'), 'utf8')).toBe('keep me\n');
  });

  it('does not overwrite user edits made after the restore fingerprint was captured', async () => {
    await write('tracked.txt', 'first edit\n');
    const preparation = await service.prepareRestore(root, 'tracked.txt');
    await write('tracked.txt', 'new user edit\n');

    await expect(service.restore(root, 'tracked.txt', preparation.fingerprint))
      .rejects.toMatchObject({ code: 'STALE_RESTORE' });
    expect(await fs.readFile(path.join(root, 'tracked.txt'), 'utf8')).toBe('new user edit\n');
  });

  it('handles shell metacharacters as a literal file path', async () => {
    const special = 'safe & literal.txt';
    await write(special, 'new\n');
    const diff = await service.getDiff(root, special);
    expect(diff.filePath).toBe(special);
    expect(diff.newContent).toBe('new\n');
  });
});
