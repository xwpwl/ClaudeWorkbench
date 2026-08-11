export type GitChangeType =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'unmerged'
  | 'untracked';

/** A renderer-safe projection of one porcelain status entry. */
export interface GitStatusFile {
  filePath: string;
  originalPath?: string;
  changeType: GitChangeType;
  /** Git porcelain XY status (for example `M `, ` M`, or `??`). */
  statusCode: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  additions: number;
  deletions: number;
  statsAvailable: boolean;
  isBinary: boolean;
}

export interface GitStatus {
  projectPath: string;
  branch: string | null;
  detached: boolean;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  files: GitStatusFile[];
  stagedFiles: GitStatusFile[];
  unstagedFiles: GitStatusFile[];
  untrackedFiles: GitStatusFile[];
  additions: number;
  deletions: number;
}

export type GitDiffMode = 'all' | 'staged' | 'unstaged';

export interface DiffOptions {
  /** Defaults to `all` (HEAD to working tree). */
  mode?: GitDiffMode;
  /** Compatibility shorthand: true means staged, false means unstaged. */
  staged?: boolean;
  filePaths?: readonly string[];
  includeUntracked?: boolean;
  contextLines?: number;
  maxBytes?: number;
  maxLines?: number;
}

export type DiffOmittedReason = 'binary' | 'bytes' | 'lines' | 'unavailable';

export interface FileDiff {
  filePath: string;
  originalPath?: string;
  changeType: GitChangeType;
  statusCode: string;
  staged: boolean;
  unstaged: boolean;
  additions: number;
  deletions: number;
  isBinary: boolean;
  tooLarge: boolean;
  patch: string | null;
  omittedReason: DiffOmittedReason | null;
}

export type ConventionalCommitType =
  | 'feat'
  | 'fix'
  | 'docs'
  | 'style'
  | 'refactor'
  | 'perf'
  | 'test'
  | 'build'
  | 'ci'
  | 'chore'
  | 'revert';

export type CommitPreviewTimelineItem =
  | string
  | {
      title?: string;
      detail?: string;
      eventType?: string;
      successful?: boolean;
    };

export interface CommitPreviewInput {
  taskTitle: string;
  timeline?: readonly CommitPreviewTimelineItem[];
  files: readonly GitStatusFile[];
}

/** A deterministic conventional-commit suggestion. It never implies a commit was made. */
export interface CommitPreview {
  type: ConventionalCommitType;
  scope: string | null;
  description: string;
  subject: string;
  message: string;
  files: string[];
  fileCount: number;
  additions: number;
  deletions: number;
}
