import type { CommitPreview, GitStatusFile } from './git';

export type CheckpointType =
  | 'before_task'
  | 'before_plan'
  | 'after_plan'
  | 'before_execute'
  | 'after_execute'
  | 'before_review'
  | 'before_fix'
  | 'after_fix'
  | 'after_edit'
  | 'after_test'
  | 'task_completed'
  | 'accepted'
  | 'manual';

export interface CheckpointFile {
  checkpointId: string;
  filePath: string;
  hash: string;
  size: number;
  modifiedAt: string;
  exists: boolean;
  status: GitStatusFile['changeType'];
  staged: boolean;
  unstaged: boolean;
}

export interface CheckpointMetadata {
  runId?: string;
  title?: string;
  branch: string | null;
  baselineFiles: GitStatusFile[];
  touchedFiles: string[];
  reason?: string;
}

export interface Checkpoint {
  id: string;
  taskId: string;
  projectPath: string;
  type: CheckpointType;
  createdAt: string;
  gitCommit: string | null;
  metadata: CheckpointMetadata;
  files: CheckpointFile[];
}

export interface RestoreImpact {
  checkpointId: string;
  taskId: string;
  restoreFiles: string[];
  deleteFiles: string[];
  preservedUserFiles: string[];
  blockedFiles: Array<{ filePath: string; reason: string }>;
  confirmationToken: string;
  expiresAt: string;
}

export interface RestoreResult {
  checkpointId: string;
  restoredFiles: string[];
  deletedFiles: string[];
  preservedUserFiles: string[];
  rollbackCheckpointId: string;
}

export interface AcceptChangesResult {
  checkpoint: Checkpoint;
  preview: CommitPreview;
}

export interface CommitTaskResult {
  commit: string;
  subject: string;
  files: string[];
}

export interface CheckpointChangedEvent {
  taskId: string;
  projectPath: string;
  action: 'created' | 'restored' | 'accepted' | 'committed';
  checkpointId?: string;
  timestamp: number;
}
