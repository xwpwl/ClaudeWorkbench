import { promises as fs } from 'fs';
import { TextDecoder } from 'util';
import type {
  DiffOptions,
  FileDiff,
  GitChangeType,
  GitDiffMode,
  GitStatus,
  GitStatusFile,
} from '../../shared/types/git';
import {
  isBinaryBuffer,
  parseNumstatZ,
  parsePorcelainV1Z,
  type NumstatEntry,
} from '../file-changes/WorkingTreeService';
import { GitCommandError, GitRunner } from '../file-changes/GitRunner';
import { SafePathPolicy, UnsafePathError } from '../file-changes/SafePathPolicy';

export const DEFAULT_GIT_DIFF_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_GIT_DIFF_MAX_LINES = 5_000;
export const MAX_GIT_DIFF_CONTEXT_LINES = 100;

const SMALL_GIT_OUTPUT_LIMIT = 64 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

export class GitWorkspaceError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'NOT_A_REPOSITORY'
      | 'INVALID_GIT_OUTPUT'
      | 'INVALID_OPTIONS'
      | 'UNSAFE_PATH'
      | 'FILE_UNAVAILABLE',
  ) {
    super(message);
    this.name = 'GitWorkspaceError';
  }
}

interface ContentInspection {
  content: Buffer | null;
  exists: boolean;
  binary: boolean;
  tooLarge: boolean;
  reason: 'bytes' | 'lines' | null;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function countLines(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let lines = 0;
  for (const byte of buffer) {
    if (byte === 0x0a) lines += 1;
  }
  return buffer[buffer.length - 1] === 0x0a ? lines : lines + 1;
}

function classifyChange(statusCode: string, parsedType: string): GitChangeType {
  if (statusCode === '??') return 'untracked';
  if (parsedType === 'added'
    || parsedType === 'modified'
    || parsedType === 'deleted'
    || parsedType === 'renamed'
    || parsedType === 'copied'
    || parsedType === 'unmerged') {
    return parsedType;
  }
  return 'modified';
}

function mergeNumstat(
  target: Map<string, NumstatEntry>,
  entries: readonly NumstatEntry[],
): void {
  for (const entry of entries) {
    const current = target.get(entry.filePath);
    if (!current) {
      target.set(entry.filePath, entry);
      continue;
    }
    target.set(entry.filePath, {
      filePath: entry.filePath,
      originalPath: entry.originalPath ?? current.originalPath,
      additions: current.additions + entry.additions,
      deletions: current.deletions + entry.deletions,
      isBinary: current.isBinary || entry.isBinary,
    });
  }
}

function parseAheadBehind(value: string): { ahead: number; behind: number } {
  const match = /^(\d+)\s+(\d+)$/.exec(value.trim());
  if (!match) {
    throw new GitWorkspaceError('Git returned invalid ahead/behind counts.', 'INVALID_GIT_OUTPUT');
  }
  const ahead = Number(match[1]);
  const behind = Number(match[2]);
  if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) {
    throw new GitWorkspaceError('Git returned unsafe ahead/behind counts.', 'INVALID_GIT_OUTPUT');
  }
  return { ahead, behind };
}

function validateOptions(options: DiffOptions): {
  mode: GitDiffMode;
  includeUntracked: boolean;
  contextLines: number;
  maxBytes: number;
  maxLines: number;
} {
  if (options.mode && options.staged !== undefined) {
    throw new GitWorkspaceError('Use either mode or staged, not both.', 'INVALID_OPTIONS');
  }
  const mode = options.mode ?? (options.staged === true
    ? 'staged'
    : options.staged === false ? 'unstaged' : 'all');
  if (mode !== 'all' && mode !== 'staged' && mode !== 'unstaged') {
    throw new GitWorkspaceError('Diff mode is invalid.', 'INVALID_OPTIONS');
  }

  const contextLines = options.contextLines ?? 3;
  if (!Number.isSafeInteger(contextLines) || contextLines < 0 || contextLines > MAX_GIT_DIFF_CONTEXT_LINES) {
    throw new GitWorkspaceError('Diff context must be an integer between 0 and 100.', 'INVALID_OPTIONS');
  }

  const requestedBytes = options.maxBytes ?? DEFAULT_GIT_DIFF_MAX_BYTES;
  const requestedLines = options.maxLines ?? DEFAULT_GIT_DIFF_MAX_LINES;
  if (!Number.isSafeInteger(requestedBytes) || requestedBytes <= 0
    || !Number.isSafeInteger(requestedLines) || requestedLines <= 0) {
    throw new GitWorkspaceError('Diff limits must be positive safe integers.', 'INVALID_OPTIONS');
  }

  return {
    mode,
    includeUntracked: options.includeUntracked ?? true,
    contextLines,
    maxBytes: Math.min(requestedBytes, DEFAULT_GIT_DIFF_MAX_BYTES),
    maxLines: Math.min(requestedLines, DEFAULT_GIT_DIFF_MAX_LINES),
  };
}

function quotedPatchPath(filePath: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(filePath) ? filePath : JSON.stringify(filePath);
}

function syntheticAddedPatch(filePath: string, content: string): string {
  const oldDisplayPath = quotedPatchPath(`a/${filePath}`);
  const newDisplayPath = quotedPatchPath(`b/${filePath}`);
  if (content.length === 0) {
    return [
      `diff --git ${oldDisplayPath} ${newDisplayPath}`,
      'new file mode 100644',
      'index 0000000..e69de29',
      '',
    ].join('\n');
  }
  const bodyLines = content.split('\n');
  const endsWithNewline = content.endsWith('\n');
  if (endsWithNewline) bodyLines.pop();
  const additions = bodyLines.length;
  const body = bodyLines.map((line) => `+${line}`).join('\n');
  const chunks = [
    `diff --git ${oldDisplayPath} ${newDisplayPath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ ${newDisplayPath}`,
    `@@ -0,0 +1,${additions} @@`,
    body,
  ];
  if (!endsWithNewline && content.length > 0) chunks.push('\\ No newline at end of file');
  return `${chunks.join('\n')}\n`;
}

/** Git workspace inspection plus explicit repository initialization. */
export class GitWorkspaceService {
  constructor(
    private readonly git = new GitRunner(),
    private readonly paths = new SafePathPolicy(),
  ) {}

  async initialize(projectPath: string): Promise<GitStatus> {
    const root = await this.safeRoot(projectPath);
    if (!(await this.isRepository(root))) {
      try {
        await this.git.run(root, ['init'], {
          timeoutMs: 10_000,
          maxOutputBytes: SMALL_GIT_OUTPUT_LIMIT,
        });
      } catch (error) {
        throw this.mapGitFailure(error, 'Unable to initialize Git repository.');
      }
    }
    return this.getStatus(root);
  }

  async getStatus(projectPath: string): Promise<GitStatus> {
    const root = await this.safeRoot(projectPath);
    await this.assertRepository(root);

    let porcelain: Buffer;
    try {
      porcelain = (await this.git.run(root, [
        '--no-pager',
        '--literal-pathspecs',
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
      ])).stdout;
    } catch (error) {
      throw this.mapGitFailure(error, 'Unable to read Git status.');
    }

    let parsed;
    try {
      parsed = parsePorcelainV1Z(porcelain);
    } catch {
      throw new GitWorkspaceError('Git returned invalid porcelain status.', 'INVALID_GIT_OUTPUT');
    }

    const [head, branch, upstream] = await Promise.all([
      this.optionalText(root, ['rev-parse', '--verify', 'HEAD']),
      this.optionalText(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      this.optionalText(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    ]);
    const stats = await this.readNumstat(root, head !== null, 'all');
    const files: GitStatusFile[] = [];

    for (const entry of parsed) {
      await this.safeFile(root, entry.filePath);
      if (entry.originalPath) await this.safeFile(root, entry.originalPath);

      const changeType = classifyChange(entry.statusCode, entry.changeType);
      let stat = stats.get(entry.filePath);
      if (!stat && changeType === 'untracked') {
        stat = await this.readUntrackedNumstat(root, entry.filePath);
      }
      files.push({
        filePath: entry.filePath,
        ...(entry.originalPath ? { originalPath: entry.originalPath } : {}),
        changeType,
        statusCode: entry.statusCode,
        staged: entry.staged,
        unstaged: entry.unstaged,
        untracked: changeType === 'untracked',
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
        statsAvailable: Boolean(stat) && !stat?.isBinary,
        isBinary: stat?.isBinary ?? false,
      });
    }
    files.sort((left, right) => comparePaths(left.filePath, right.filePath));

    let ahead = 0;
    let behind = 0;
    if (head && upstream) {
      const counts = await this.optionalText(root, [
        'rev-list',
        '--left-right',
        '--count',
        `HEAD...${upstream}`,
      ]);
      if (counts !== null) ({ ahead, behind } = parseAheadBehind(counts));
    }

    return {
      projectPath: root,
      branch,
      detached: head !== null && branch === null,
      head,
      upstream,
      ahead,
      behind,
      clean: files.length === 0,
      files,
      stagedFiles: files.filter((file) => file.staged),
      unstagedFiles: files.filter((file) => file.unstaged),
      untrackedFiles: files.filter((file) => file.untracked),
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    };
  }

  async getDiff(projectPath: string, options: DiffOptions = {}): Promise<FileDiff[]> {
    const settings = validateOptions(options);
    const root = await this.safeRoot(projectPath);
    const status = await this.getStatus(root);
    const requested = options.filePaths === undefined
      ? null
      : await this.validateRequestedPaths(root, options.filePaths);
    const modeStats = await this.readNumstat(root, status.head !== null, settings.mode);

    const selected = status.files.filter((file) => {
      if (requested && !requested.has(file.filePath)) return false;
      if (!settings.includeUntracked && file.untracked) return false;
      if (settings.mode === 'staged') return file.staged;
      if (settings.mode === 'unstaged') return file.unstaged;
      return true;
    });

    const results: FileDiff[] = [];
    for (const file of selected) {
      let stat = modeStats.get(file.filePath);
      if (!stat && file.untracked && settings.mode !== 'staged') {
        stat = await this.readUntrackedNumstat(root, file.filePath, settings.maxBytes);
      }
      results.push(await this.readFileDiff(root, file, stat, status.head !== null, settings));
    }
    return results;
  }

  private async readFileDiff(
    root: string,
    file: GitStatusFile,
    stat: NumstatEntry | undefined,
    hasHead: boolean,
    settings: ReturnType<typeof validateOptions>,
  ): Promise<FileDiff> {
    const additions = stat?.additions ?? 0;
    const deletions = stat?.deletions ?? 0;
    const base: Omit<FileDiff, 'isBinary' | 'tooLarge' | 'patch' | 'omittedReason'> = {
      filePath: file.filePath,
      ...(file.originalPath ? { originalPath: file.originalPath } : {}),
      changeType: file.changeType,
      statusCode: file.statusCode,
      staged: file.staged,
      unstaged: file.unstaged,
      additions,
      deletions,
    };

    if (stat?.isBinary) {
      return { ...base, isBinary: true, tooLarge: false, patch: null, omittedReason: 'binary' };
    }

    const inspection = await this.inspectRelevantContent(root, file, hasHead, settings);
    if (inspection.binary) {
      return { ...base, isBinary: true, tooLarge: false, patch: null, omittedReason: 'binary' };
    }
    if (inspection.tooLarge) {
      return {
        ...base,
        isBinary: false,
        tooLarge: true,
        patch: null,
        omittedReason: inspection.reason ?? 'bytes',
      };
    }

    if (file.untracked || (!hasHead && file.changeType === 'added' && settings.mode === 'all')) {
      if (!inspection.content) {
        return { ...base, isBinary: false, tooLarge: false, patch: null, omittedReason: 'unavailable' };
      }
      const patch = syntheticAddedPatch(file.filePath, decoder.decode(inspection.content));
      if (Buffer.byteLength(patch) > settings.maxBytes) {
        return { ...base, isBinary: false, tooLarge: true, patch: null, omittedReason: 'bytes' };
      }
      return { ...base, isBinary: false, tooLarge: false, patch, omittedReason: null };
    }

    try {
      // Include the source path so Git can retain rename/copy semantics instead of
      // projecting the destination as a standalone added file.
      const patchPaths = file.originalPath
        ? [file.originalPath, file.filePath]
        : [file.filePath];
      const args = this.diffArgs(settings.mode, hasHead, settings.contextLines, false, patchPaths);
      const result = await this.git.run(root, args, {
        maxOutputBytes: settings.maxBytes + SMALL_GIT_OUTPUT_LIMIT,
      });
      if (result.stdout.length > settings.maxBytes) {
        return { ...base, isBinary: false, tooLarge: true, patch: null, omittedReason: 'bytes' };
      }
      if (countLines(result.stdout) > settings.maxLines) {
        return { ...base, isBinary: false, tooLarge: true, patch: null, omittedReason: 'lines' };
      }
      return {
        ...base,
        isBinary: false,
        tooLarge: false,
        patch: result.stdout.toString('utf8'),
        omittedReason: null,
      };
    } catch (error) {
      if (error instanceof GitCommandError && error.code === 'OUTPUT_LIMIT') {
        return { ...base, isBinary: false, tooLarge: true, patch: null, omittedReason: 'bytes' };
      }
      throw this.mapGitFailure(error, `Unable to read diff for ${file.filePath}.`);
    }
  }

  private async inspectRelevantContent(
    root: string,
    file: GitStatusFile,
    hasHead: boolean,
    settings: ReturnType<typeof validateOptions>,
  ): Promise<ContentInspection> {
    const inspections: ContentInspection[] = [];
    const originalPath = file.originalPath ?? file.filePath;

    if (settings.mode === 'all') {
      if (hasHead) inspections.push(await this.inspectGitObject(root, `HEAD:${originalPath}`, settings));
      inspections.push(await this.inspectWorktree(root, file.filePath, settings));
    } else if (settings.mode === 'staged') {
      if (hasHead) inspections.push(await this.inspectGitObject(root, `HEAD:${originalPath}`, settings));
      inspections.push(await this.inspectGitObject(root, `:${file.filePath}`, settings));
    } else {
      inspections.push(await this.inspectGitObject(root, `:${file.filePath}`, settings));
      inspections.push(await this.inspectWorktree(root, file.filePath, settings));
    }

    const binary = inspections.some((item) => item.binary);
    const tooLarge = inspections.some((item) => item.tooLarge);
    const reason = inspections.find((item) => item.reason === 'bytes')?.reason
      ?? inspections.find((item) => item.reason === 'lines')?.reason
      ?? null;
    const worktree = inspections.at(-1);
    return {
      content: worktree?.content ?? null,
      exists: inspections.some((item) => item.exists),
      binary,
      tooLarge,
      reason,
    };
  }

  private async inspectGitObject(
    root: string,
    object: string,
    settings: ReturnType<typeof validateOptions>,
  ): Promise<ContentInspection> {
    const exists = await this.git.succeeds(root, ['--no-pager', 'cat-file', '-e', object], {
      timeoutMs: 5_000,
      maxOutputBytes: SMALL_GIT_OUTPUT_LIMIT,
    });
    if (!exists) return { content: null, exists: false, binary: false, tooLarge: false, reason: null };

    const sizeText = await this.git.runText(root, ['--no-pager', 'cat-file', '-s', object], {
      timeoutMs: 5_000,
      maxOutputBytes: SMALL_GIT_OUTPUT_LIMIT,
    });
    const size = Number(sizeText.trim());
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new GitWorkspaceError('Git returned an invalid object size.', 'INVALID_GIT_OUTPUT');
    }
    if (size > settings.maxBytes) {
      return { content: null, exists: true, binary: false, tooLarge: true, reason: 'bytes' };
    }

    const content = (await this.git.run(root, ['--no-pager', 'cat-file', 'blob', object], {
      timeoutMs: 5_000,
      maxOutputBytes: settings.maxBytes + SMALL_GIT_OUTPUT_LIMIT,
    })).stdout;
    if (isBinaryBuffer(content)) {
      return { content: null, exists: true, binary: true, tooLarge: false, reason: null };
    }
    if (countLines(content) > settings.maxLines) {
      return { content: null, exists: true, binary: false, tooLarge: true, reason: 'lines' };
    }
    return { content, exists: true, binary: false, tooLarge: false, reason: null };
  }

  private async inspectWorktree(
    root: string,
    filePath: string,
    settings: ReturnType<typeof validateOptions>,
  ): Promise<ContentInspection> {
    const resolved = await this.safeFile(root, filePath);
    try {
      const stat = await fs.lstat(resolved.absolutePath);
      if (!stat.isFile()) {
        return { content: null, exists: true, binary: true, tooLarge: false, reason: null };
      }
      if (stat.size > settings.maxBytes) {
        return { content: null, exists: true, binary: false, tooLarge: true, reason: 'bytes' };
      }
      const content = await fs.readFile(resolved.absolutePath);
      if (isBinaryBuffer(content)) {
        return { content: null, exists: true, binary: true, tooLarge: false, reason: null };
      }
      if (countLines(content) > settings.maxLines) {
        return { content: null, exists: true, binary: false, tooLarge: true, reason: 'lines' };
      }
      return { content, exists: true, binary: false, tooLarge: false, reason: null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { content: null, exists: false, binary: false, tooLarge: false, reason: null };
      }
      throw new GitWorkspaceError('Working-tree file cannot be inspected safely.', 'FILE_UNAVAILABLE');
    }
  }

  private async readNumstat(
    root: string,
    hasHead: boolean,
    mode: GitDiffMode,
  ): Promise<Map<string, NumstatEntry>> {
    const target = new Map<string, NumstatEntry>();
    const commands = mode === 'all' && !hasHead
      ? [this.diffArgs('staged', false, 0, true), this.diffArgs('unstaged', false, 0, true)]
      : [this.diffArgs(mode, hasHead, 0, true)];

    for (const args of commands) {
      try {
        const result = await this.git.run(root, args);
        mergeNumstat(target, parseNumstatZ(result.stdout));
      } catch (error) {
        if (error instanceof GitCommandError && error.code === 'EXIT_NON_ZERO') continue;
        if (error instanceof GitWorkspaceError) throw error;
        if (error instanceof Error && error.name === 'WorkingTreeError') {
          throw new GitWorkspaceError('Git returned invalid numstat output.', 'INVALID_GIT_OUTPUT');
        }
        throw this.mapGitFailure(error, 'Unable to read Git diff statistics.');
      }
    }
    return target;
  }

  private diffArgs(
    mode: GitDiffMode,
    hasHead: boolean,
    contextLines: number,
    numstat: boolean,
    filePaths: readonly string[] = [],
  ): string[] {
    const args = [
      '--no-pager',
      '--literal-pathspecs',
      'diff',
      '--no-ext-diff',
      '--no-textconv',
    ];
    if (numstat) args.push('--numstat', '-z');
    else args.push('--patch', `--unified=${contextLines}`);
    if (mode === 'staged') args.push('--cached');
    else if (mode === 'all' && hasHead) args.push('HEAD');
    args.push('--', ...filePaths);
    return args;
  }

  private async readUntrackedNumstat(
    root: string,
    filePath: string,
    maxBytes = DEFAULT_GIT_DIFF_MAX_BYTES,
  ): Promise<NumstatEntry | undefined> {
    const resolved = await this.safeFile(root, filePath);
    try {
      const stat = await fs.lstat(resolved.absolutePath);
      if (!stat.isFile() || stat.size > Math.min(maxBytes, DEFAULT_GIT_DIFF_MAX_BYTES)) return undefined;
      const content = await fs.readFile(resolved.absolutePath);
      const binary = isBinaryBuffer(content);
      return {
        filePath,
        additions: binary ? 0 : countLines(content),
        deletions: 0,
        isBinary: binary,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new GitWorkspaceError('Untracked file cannot be inspected safely.', 'FILE_UNAVAILABLE');
    }
  }

  private async validateRequestedPaths(
    root: string,
    filePaths: readonly string[],
  ): Promise<Set<string>> {
    if (filePaths.length > 1_000) {
      throw new GitWorkspaceError('Too many diff paths were requested.', 'INVALID_OPTIONS');
    }
    const requested = new Set<string>();
    for (const filePath of filePaths) {
      const resolved = await this.safeFile(root, filePath);
      requested.add(resolved.gitPath);
    }
    return requested;
  }

  private async optionalText(root: string, args: readonly string[]): Promise<string | null> {
    try {
      const result = await this.git.run(root, ['--no-pager', ...args], {
        timeoutMs: 5_000,
        maxOutputBytes: SMALL_GIT_OUTPUT_LIMIT,
        allowNonZeroExit: true,
      });
      if (result.exitCode !== 0) return null;
      const value = result.stdout.toString('utf8').trim();
      return value || null;
    } catch (error) {
      throw this.mapGitFailure(error, 'Unable to inspect Git metadata.');
    }
  }

  private async assertRepository(root: string): Promise<void> {
    if (!(await this.isRepository(root))) {
      throw new GitWorkspaceError('Selected project is not a Git working tree.', 'NOT_A_REPOSITORY');
    }
  }

  private async isRepository(root: string): Promise<boolean> {
    const result = await this.git.run(root, [
      '--no-pager',
      'rev-parse',
      '--is-inside-work-tree',
    ], {
      timeoutMs: 5_000,
      maxOutputBytes: SMALL_GIT_OUTPUT_LIMIT,
      allowNonZeroExit: true,
    });
    const value = result.stdout.toString('utf8').trim();
    if (result.exitCode === 0) {
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw new GitWorkspaceError('Git returned an invalid repository status.', 'INVALID_GIT_OUTPUT');
    }
    const detail = result.stderr.toString('utf8').trim();
    if (/not a git (?:repository|directory)/iu.test(detail)) {
      return false;
    }
    throw new GitWorkspaceError(
      detail
        ? `Unable to inspect Git repository. ${detail.slice(0, 1_000)}`
        : 'Unable to inspect Git repository.',
      'INVALID_GIT_OUTPUT',
    );
  }

  private async safeRoot(projectPath: string): Promise<string> {
    try {
      return await this.paths.resolveProjectRoot(projectPath);
    } catch (error) {
      if (error instanceof UnsafePathError) {
        throw new GitWorkspaceError(error.message, 'UNSAFE_PATH');
      }
      throw error;
    }
  }

  private async safeFile(root: string, filePath: string) {
    try {
      return await this.paths.resolveFile(root, filePath);
    } catch (error) {
      if (error instanceof UnsafePathError) {
        throw new GitWorkspaceError(error.message, 'UNSAFE_PATH');
      }
      throw error;
    }
  }

  private mapGitFailure(error: unknown, message: string): GitWorkspaceError {
    if (error instanceof GitWorkspaceError) return error;
    return new GitWorkspaceError(
      error instanceof Error ? `${message} ${error.message}` : message,
      'INVALID_GIT_OUTPUT',
    );
  }
}
