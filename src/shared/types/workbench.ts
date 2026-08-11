export interface PageRequest {
  limit?: number;
  offset?: number;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface PersistedTaskEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface PersistedTaskFileChange {
  id: string;
  filePath: string;
  changeType: string;
  additions: number;
  deletions: number;
  oldContent: string | null;
  newContent: string | null;
  isBinary: boolean;
  createdAt: string;
}

export interface PermissionStats {
  total: number;
  userAllowed: number;
  autoAllowed: number;
  denied: number;
  timedOut: number;
  unsupported: number;
  policyBlocked: number;
  lifecycleCancelled: number;
  other: number;
}

export interface PersistedPermissionRecord {
  id: string;
  runId: string;
  toolName: string;
  decision: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface PersistedTaskSnapshot {
  sessionId: string;
  projectId: string;
  title: string;
  status: string;
  model: string | null;
  permissionMode: string | null;
  agentMode: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  permissionCount: number;
  permissionStats: PermissionStats;
  permissionRecords: PersistedPermissionRecord[];
  test: {
    status: string | null;
    command: string | null;
    output: string | null;
  };
  fileChanges: PersistedTaskFileChange[];
  totalAdditions: number;
  totalDeletions: number;
  events: PersistedTaskEvent[];
  eventOffset?: number;
  eventTotal: number;
}

export interface TaskReport {
  fileName: string;
  markdown: string;
}
