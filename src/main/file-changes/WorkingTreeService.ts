import { createHash } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import { TextDecoder } from 'util';
import type {
  DiffLimitInfo,
  DiffResult,
  FileChange,
  FileChangeType,
} from '../../shared/types/fileChanges';
import { GitCommandError, GitRunner } from './GitRunner';
import { SafePathPolicy, UnsafePathError } from './SafePathPolicy';

export const MAX_DIFF_BYTES = 2 * 1024 * 1024;
export const MAX_DIFF_LINES = 5_000;

export class WorkingTreeError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'NOT_A_REPOSITORY'
      | 'INVALID_GIT_OUTPUT'
      | 'UNSAFE_PATH'
      | 'NOT_CHANGED'
      | 'RESTORE_UNSAFE'
      | 'STALE_RESTORE'
      | 'FILE_UNAVAILABLE',
  ) {
    super(message);
    this.name = 'WorkingTreeError';
  }
}

export interface PorcelainEntry {
  filePath: string;
  originalPath?: string;
  statusCode: string;
  changeType: FileChangeType;
  staged: boolean;
  unstaged: boolean;
}

export interface NumstatEntry {
  filePath: string;
  originalPath?: string;
  additions: number;
  deletions: number;
  isBinary: boolean;
}

export interface RestorePreparation {
  projectPath: string;
  filePath: string;
  paths: string[];
  fingerprint: string;
}

function changeTypeFor(statusCode: string): FileChangeType {
  if (statusCode.includes('U') || statusCode === 'AA' || statusCode === 'DD') return 'unmerged';
  if (statusCode.includes('R')) return 'renamed';
  if (statusCode.includes('C')) return 'copied';
  if (statusCode === '??' || statusCode.includes('A')) return 'added';
  if (statusCode.includes('D')) return 'deleted';
  return 'modified';
}

/** Parses `git status --porcelain=v1 -z`, including its destination/source rename order. */
export function parsePorcelainV1Z(output: Buffer | string): PorcelainEntry[] {
  const fields = (Buffer.isBuffer(output) ? output.toString('utf8') : output).split('\0');
  const entries: PorcelainEntry[] = [];

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    if (field.length < 4 || field[2] !== ' ') {
      throw new WorkingTreeError('Git returned an invalid porcelain status record.', 'INVALID_GIT_OUTPUT');
    }

    const statusCode = field.slice(0, 2);
    const filePath = field.slice(3);
    if (!filePath) {
      throw new WorkingTreeError('Git returned an empty file path.', 'INVALID_GIT_OUTPUT');
    }

    let originalPath: string | undefined;
    if (statusCode.includes('R') || statusCode.includes('C')) {
      originalPath = fields[index + 1];
      if (!originalPath) {
        throw new WorkingTreeError('Git returned an incomplete rename record.', 'INVALID_GIT_OUTPUT');
      }
      index += 1;
    }

    const x = statusCode[0];
    const y = statusCode[1];
    entries.push({
      filePath,
      originalPath,
      statusCode,
      changeType: changeTypeFor(statusCode),
      staged: x !== ' ' && x !== '?' && x !== '!',
      unstaged: statusCode === '??' || (y !== ' ' && y !== '?' && y !== '!'),
    });
  }
  return entries;
}

function parseCount(value: string): number | null {
  if (value === '-') return null;
  if (!/^\d+$/.test(value)) {
    throw new WorkingTreeError('Git returned an invalid numstat count.', 'INVALID_GIT_OUTPUT');
  }
  return Number(value);
}

/** Parses `git diff --numstat -z`, including the three-field rename form. */
export function parseNumstatZ(output: Buffer | string): NumstatEntry[] {
  const fields = (Buffer.isBuffer(output) ? output.toString('utf8') : output).split('\0');
  const entries: NumstatEntry[] = [];

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const firstTab = field.indexOf('\t');
    const secondTab = firstTab < 0 ? -1 : field.indexOf('\t', firstTab + 1);
    if (firstTab <= 0 || secondTab <= firstTab) {
      throw new WorkingTreeError('Git returned an invalid numstat record.', 'INVALID_GIT_OUTPUT');
    }

    const additionsValue = parseCount(field.slice(0, firstTab));
    const deletionsValue = parseCount(field.slice(firstTab + 1, secondTab));
    let filePath = field.slice(secondTab + 1);
    let originalPath: string | undefined;

    if (!filePath) {
      originalPath = fields[index + 1];
      filePath = fields[index + 2];
      if (!originalPath || !filePath) {
        throw new WorkingTreeError('Git returned an incomplete numstat rename record.', 'INVALID_GIT_OUTPUT');
      }
      index += 2;
    }

    const isBinary = additionsValue === null || deletionsValue === null;
    entries.push({
      filePath,
      originalPath,
      additions: additionsValue ?? 0,
      deletions: deletionsValue ?? 0,
      isBinary,
    });
  }
  return entries;
}

function lineCount(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let lines = 0;
  for (const byte of buffer) {
    if (byte === 0x0a) lines += 1;
  }
  return buffer[buffer.length - 1] === 0x0a ? lines : lines + 1;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

export function isBinaryBuffer(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  try {
    decoder.decode(buffer);
    return false;
  } catch {
    return true;
  }
}

interface WorktreeStats {
  additions: number;
  isBinary: boolean;
  available: boolean;
}

export class WorkingTreeService {
  constructor(
    private readonly git = new GitRunner(),
    private readonly paths = new SafePathPolicy(),
    private readonly maxDiffBytes = MAX_DIFF_BYTES,
    private readonly maxDiffLines = MAX_DIFF_LINES,
  ) {}

  async listChanges(projectPath: string): Promise<FileChange[]> {
    const root = await this.safeRoot(projectPath);
    await this.assertRepository(root);

    const status = await this.git.run(root, [
      '--no-pager',
      '--literal-pathspecs',
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]);
    const entries = parsePorcelainV1Z(status.stdout);
    const hasHead = await this.hasHead(root);
    const stats = hasHead ? await this.readNumstat(root) : new Map<string, NumstatEntry>();
    const changes: FileChange[] = [];

    for (const entry of entries) {
      try {
        await this.paths.resolveFile(root, entry.filePath);
        if (entry.originalPath) await this.paths.resolveFile(root, entry.originalPath);
      } catch (error) {
        if (error instanceof UnsafePathError) continue;
        throw error;
      }

      const stat = stats.get(entry.filePath);
      let additions = stat?.additions ?? 0;
      let deletions = stat?.deletions ?? 0;
      let isBinary = stat?.isBinary ?? false;
      let statsAvailable = Boolean(stat) && !stat?.isBinary;

      if (!stat && entry.changeType === 'added') {
        const worktree = await this.readWorktreeStats(root, entry.filePath);
        additions = worktree.additions;
        isBinary = worktree.isBinary;
        statsAvailable = worktree.available;
      }

      changes.push({
        ...entry,
        additions,
        deletions,
        statsAvailable,
        isBinary,
        canRestore: hasHead && !['added', 'copied'].includes(entry.changeType),
      });
    }

    return changes.sort((left, right) => left.filePath.localeCompare(right.filePath));
  }

  async getDiff(projectPath: string, filePath: string): Promise<DiffResult> {
    const root = await this.safeRoot(projectPath);
    await this.assertRepository(root);
    const resolved = await this.safeFile(root, filePath);
    const changes = await this.listChanges(root);
    const change = changes.find((candidate) => candidate.filePath === resolved.gitPath);
    if (!change) {
      throw new WorkingTreeError('The requested file is not changed in the working tree.', 'NOT_CHANGED');
    }

    const basePath = change.originalPath ?? resolved.gitPath;
    const oldInfo = await this.readHeadInfo(root, basePath);
    const newInfo = await this.readWorktreeInfo(resolved.absolutePath, change.changeType === 'deleted');
    const oldBytes = oldInfo?.size ?? 0;
    const newBytes = newInfo?.size ?? 0;

    if (change.isBinary || oldInfo?.binary || newInfo?.binary) {
      return this.protectedResult(change, true, false, null);
    }

    if (oldBytes > this.maxDiffBytes || newBytes > this.maxDiffBytes) {
      return this.protectedResult(change, false, true, {
        reason: 'bytes',
        maxBytes: this.maxDiffBytes,
        maxLines: this.maxDiffLines,
        oldBytes,
        newBytes,
        oldLines: null,
        newLines: null,
      });
    }

    const oldBuffer = oldInfo ? await this.readHeadBlob(root, basePath) : null;
    const newBuffer = newInfo ? await this.readRegularFile(resolved.absolutePath) : null;
    if ((oldBuffer && isBinaryBuffer(oldBuffer)) || (newBuffer && isBinaryBuffer(newBuffer))) {
      return this.protectedResult(change, true, false, null);
    }

    const oldLines = oldBuffer ? lineCount(oldBuffer) : 0;
    const newLines = newBuffer ? lineCount(newBuffer) : 0;
    if (oldLines > this.maxDiffLines || newLines > this.maxDiffLines) {
      return this.protectedResult(change, false, true, {
        reason: 'lines',
        maxBytes: this.maxDiffBytes,
        maxLines: this.maxDiffLines,
        oldBytes,
        newBytes,
        oldLines,
        newLines,
      });
    }

    return {
      filePath: change.filePath,
      oldContent: oldBuffer ? decoder.decode(oldBuffer) : null,
      newContent: newBuffer ? decoder.decode(newBuffer) : null,
      additions: change.additions,
      deletions: change.deletions,
      isBinary: false,
      tooLarge: false,
      limit: null,
    };
  }

  async prepareRestore(projectPath: string, filePath: string): Promise<RestorePreparation> {
    const root = await this.safeRoot(projectPath);
    const resolved = await this.safeFile(root, filePath);
    const change = (await this.listChanges(root)).find((candidate) => candidate.filePath === resolved.gitPath);
    if (!change) throw new WorkingTreeError('The requested file is not changed.', 'NOT_CHANGED');
    if (!change.canRestore) {
      throw new WorkingTreeError('Added and untracked files are not deleted by the safe restore action.', 'RESTORE_UNSAFE');
    }

    const paths = [change.filePath];
    if (change.originalPath) {
      await this.safeFile(root, change.originalPath);
      paths.push(change.originalPath);
    }
    return {
      projectPath: root,
      filePath: resolved.gitPath,
      paths,
      fingerprint: await this.restoreFingerprint(root, paths),
    };
  }

  async restore(
    projectPath: string,
    filePath: string,
    expectedFingerprint: string,
  ): Promise<void> {
    const preparation = await this.verifyRestoreFingerprint(
      projectPath,
      filePath,
      expectedFingerprint,
    );
    await this.git.run(preparation.projectPath, [
      '--no-pager',
      '--literal-pathspecs',
      'restore',
      '--source=HEAD',
      '--staged',
      '--worktree',
      '--',
      ...preparation.paths,
    ]);
  }

  async verifyRestoreFingerprint(
    projectPath: string,
    filePath: string,
    expectedFingerprint: string,
  ): Promise<RestorePreparation> {
    if (!expectedFingerprint) {
      throw new WorkingTreeError('Restore requires a verified file fingerprint.', 'STALE_RESTORE');
    }
    const preparation = await this.prepareRestore(projectPath, filePath);
    if (preparation.fingerprint !== expectedFingerprint) {
      throw new WorkingTreeError(
        'The file changed after restore was requested. Review it again before restoring.',
        'STALE_RESTORE',
      );
    }
    return preparation;
  }

  async resolveFileForOpen(projectPath: string, filePath: string): Promise<string> {
    const root = await this.safeRoot(projectPath);
    const resolved = await this.paths.resolveFile(root, filePath, { mustExist: true });
    return resolved.absolutePath;
  }

  private async restoreFingerprint(root: string, paths: readonly string[]): Promise<string> {
    const args = ['--', ...paths];
    const [head, status, index] = await Promise.all([
      this.git.run(root, ['--no-pager', 'rev-parse', 'HEAD']),
      this.git.run(root, ['--no-pager', 'status', '--porcelain=v1', '-z', ...args]),
      this.git.run(root, ['--no-pager', 'ls-files', '--stage', '-z', ...args]),
    ]);
    const fingerprint = createHash('sha256')
      .update(head.stdout)
      .update('\0status\0')
      .update(status.stdout)
      .update('\0index\0')
      .update(index.stdout);

    for (const filePath of [...paths].sort((left, right) => left.localeCompare(right))) {
      const resolved = await this.safeFile(root, filePath);
      fingerprint.update('\0path\0').update(resolved.gitPath);
      try {
        const stat = await fs.lstat(resolved.absolutePath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          fingerprint.update('\0unsafe');
          continue;
        }
        fingerprint.update(`\0file\0${stat.size}\0`);
        await new Promise<void>((resolve, reject) => {
          const stream = createReadStream(resolved.absolutePath);
          stream.on('data', (chunk) => fingerprint.update(chunk));
          stream.once('error', reject);
          stream.once('end', resolve);
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        fingerprint.update('\0absent');
      }
    }
    return fingerprint.digest('hex');
  }

  private protectedResult(
    change: FileChange,
    isBinary: boolean,
    tooLarge: boolean,
    limit: DiffLimitInfo | null,
  ): DiffResult {
    return {
      filePath: change.filePath,
      oldContent: null,
      newContent: null,
      additions: change.additions,
      deletions: change.deletions,
      isBinary,
      tooLarge,
      limit,
    };
  }

  private async safeRoot(projectPath: string): Promise<string> {
    try {
      return await this.paths.resolveProjectRoot(projectPath);
    } catch (error) {
      if (error instanceof UnsafePathError) {
        throw new WorkingTreeError(error.message, 'UNSAFE_PATH');
      }
      throw error;
    }
  }

  private async safeFile(projectRoot: string, filePath: string) {
    try {
      return await this.paths.resolveFile(projectRoot, filePath);
    } catch (error) {
      if (error instanceof UnsafePathError) {
        throw new WorkingTreeError(error.message, 'UNSAFE_PATH');
      }
      throw error;
    }
  }

  private async assertRepository(root: string): Promise<void> {
    try {
      const value = await this.git.runText(root, ['--no-pager', 'rev-parse', '--is-inside-work-tree'], {
        timeoutMs: 5_000,
        maxOutputBytes: 64 * 1024,
      });
      if (value.trim() !== 'true') throw new WorkingTreeError('Selected project is not a Git working tree.', 'NOT_A_REPOSITORY');
    } catch (error) {
      if (error instanceof WorkingTreeError) throw error;
      if (error instanceof GitCommandError) {
        throw new WorkingTreeError('Selected project is not a Git working tree.', 'NOT_A_REPOSITORY');
      }
      throw error;
    }
  }

  private async hasHead(root: string): Promise<boolean> {
    try {
      return await this.git.succeeds(root, ['--no-pager', 'rev-parse', '--verify', 'HEAD'], {
        timeoutMs: 5_000,
        maxOutputBytes: 64 * 1024,
      });
    } catch {
      return false;
    }
  }

  private async readNumstat(root: string): Promise<Map<string, NumstatEntry>> {
    try {
      const result = await this.git.run(root, [
        '--no-pager',
        '--literal-pathspecs',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--numstat',
        '-z',
        'HEAD',
        '--',
      ]);
      return new Map(parseNumstatZ(result.stdout).map((entry) => [entry.filePath, entry]));
    } catch {
      return new Map();
    }
  }

  private async readWorktreeStats(root: string, filePath: string): Promise<WorktreeStats> {
    try {
      const resolved = await this.paths.resolveFile(root, filePath, { mustExist: true });
      const stat = await fs.stat(resolved.absolutePath);
      if (!stat.isFile() || stat.size > this.maxDiffBytes) {
        return { additions: 0, isBinary: false, available: false };
      }
      const buffer = await this.readRegularFile(resolved.absolutePath);
      const binary = isBinaryBuffer(buffer);
      return {
        additions: binary ? 0 : lineCount(buffer),
        isBinary: binary,
        available: !binary,
      };
    } catch {
      return { additions: 0, isBinary: false, available: false };
    }
  }

  private async readHeadInfo(root: string, filePath: string): Promise<{ size: number; binary: boolean } | null> {
    const exists = await this.git.succeeds(root, ['--no-pager', 'cat-file', '-e', `HEAD:${filePath}`], {
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
    });
    if (!exists) return null;
    const sizeText = await this.git.runText(root, ['--no-pager', 'cat-file', '-s', `HEAD:${filePath}`], {
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
    });
    const size = Number(sizeText.trim());
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new WorkingTreeError('Git returned an invalid blob size.', 'INVALID_GIT_OUTPUT');
    }
    return { size, binary: false };
  }

  private async readHeadBlob(root: string, filePath: string): Promise<Buffer> {
    const result = await this.git.run(root, ['--no-pager', 'show', `HEAD:${filePath}`], {
      maxOutputBytes: this.maxDiffBytes + 64 * 1024,
    });
    return result.stdout;
  }

  private async readWorktreeInfo(
    absolutePath: string,
    deleted: boolean,
  ): Promise<{ size: number; binary: boolean } | null> {
    if (deleted) return null;
    try {
      const stat = await fs.lstat(absolutePath);
      if (!stat.isFile()) return { size: stat.size, binary: true };
      return { size: stat.size, binary: false };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      throw new WorkingTreeError('Working-tree file cannot be read.', 'FILE_UNAVAILABLE');
    }
  }

  private async readRegularFile(absolutePath: string): Promise<Buffer> {
    const handle = await fs.open(absolutePath, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > this.maxDiffBytes) {
        throw new WorkingTreeError('Working-tree file is not a bounded regular file.', 'FILE_UNAVAILABLE');
      }
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }
}
