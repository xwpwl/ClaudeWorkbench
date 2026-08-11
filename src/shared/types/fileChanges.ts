export type FileChangeType =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'unmerged';

/** A single entry in the selected project's Git working tree. */
export interface FileChange {
  filePath: string;
  originalPath?: string;
  changeType: FileChangeType;
  /** The two-character Git porcelain XY status. */
  statusCode: string;
  staged: boolean;
  unstaged: boolean;
  additions: number;
  deletions: number;
  /** False when Git reports a binary file or a safe text count is unavailable. */
  statsAvailable: boolean;
  isBinary: boolean;
  /** Added/untracked files are not deleted by the restore API. */
  canRestore: boolean;
}

export type DiffLimitReason = 'bytes' | 'lines';

export interface DiffLimitInfo {
  reason: DiffLimitReason;
  maxBytes: number;
  maxLines: number;
  oldBytes: number;
  newBytes: number;
  oldLines: number | null;
  newLines: number | null;
}

/** A bounded HEAD-to-working-tree text comparison safe to send over IPC. */
export interface DiffResult {
  filePath: string;
  oldContent: string | null;
  newContent: string | null;
  additions: number;
  deletions: number;
  isBinary: boolean;
  tooLarge: boolean;
  limit: DiffLimitInfo | null;
}

