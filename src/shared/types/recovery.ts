export type RecoveryItemKind = 'task' | 'workflow' | 'process' | 'permission' | 'mutation';
export type RecoveryItemStatus = 'pending' | 'resumed' | 'abandoned' | 'resolved';

export interface RecoveryItem {
  id: string;
  kind: RecoveryItemKind;
  resourceId: string;
  projectId: string | null;
  sessionId: string | null;
  taskId: string | null;
  lastState: string;
  reason: string;
  status: RecoveryItemStatus;
  detectedAt: string;
  resolvedAt: string | null;
}

export interface RecoveryCenterSnapshot {
  abnormalExitDetected: boolean;
  appRunId: string;
  items: RecoveryItem[];
}
