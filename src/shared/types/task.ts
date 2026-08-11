import type { ClaudeEvent, PermissionDenial } from './claude';
import type { AgentType, WorkflowStatus } from './workflow';

export const DEFAULT_TASK_AGENT_MODE = 'normal';

export type TaskStatus = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface TaskUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type TaskResult =
  | {
      kind: 'completed';
      markdown: string | null;
      permissionDenials: PermissionDenial[];
    }
  | {
      kind: 'failed';
      error: string;
      permissionDenials: PermissionDenial[];
    }
  | {
      kind: 'cancelled';
      reason: string;
      permissionDenials: PermissionDenial[];
    };

/** One renderer-visible execution. In v1 the task id is exactly the Claude run id. */
export interface TaskRecord {
  id: string;
  runId: string;
  projectKey: string;
  sessionKey: string;
  prompt: string;
  agentMode: string;
  userMessageId?: string;
  model?: string;
  claudeSessionId?: string;
  status: TaskStatus;
  createdAt: number;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  durationMs?: number;
  usage: TaskUsage | null;
  result: TaskResult | null;
}

export interface TaskStartInput {
  runId: string;
  projectKey: string;
  sessionKey: string;
  prompt: string;
  agentMode?: string;
  userMessageId?: string;
  model?: string;
  startedAt?: number;
}

export type TaskSyntheticEvent =
  | {
      type: 'task_start_failed';
      error: string;
      timestamp: number;
    }
  | {
      type: 'task_cancelled';
      reason: string;
      timestamp: number;
    }
  | {
      type: 'permission_waiting';
      requestId: string;
      toolName: string;
      toolUseId?: string;
      risk: 'low' | 'medium' | 'high';
      timestamp: number;
    }
  | {
      type: 'permission_settled';
      requestId: string;
      toolName: string;
      toolUseId?: string;
      timestamp: number;
    }
  | {
      type: 'git_checkpoint_created';
      checkpointId: string;
      checkpointType: string;
      files: string[];
      timestamp: number;
    }
  | {
      type: 'git_restore_completed';
      checkpointId: string;
      files: string[];
      deletedFiles: string[];
      timestamp: number;
    }
  | {
      type: 'git_changes_accepted';
      checkpointId: string;
      files: string[];
      timestamp: number;
    }
  | {
      type: 'git_commit_created';
      commit: string;
      subject: string;
      files: string[];
      timestamp: number;
    }
  | {
      type: 'workflow_progress';
      workflowId: string;
      projectId: string;
      eventType: string;
      status: WorkflowStatus;
      currentStage: AgentType | null;
      revision: number;
      round: number;
      summary: {
        title: string;
        detail: string | null;
        tone: 'info' | 'success' | 'warning' | 'error' | 'neutral';
      };
      timestamp: number;
    };

export type TaskTimelineEvent = ClaudeEvent | TaskSyntheticEvent;

export interface TaskTimelineEntry {
  id: string;
  taskId: string;
  runId: string;
  projectKey: string;
  sessionKey: string;
  sequence: number;
  timestamp: number;
  event: TaskTimelineEvent;
}

export type TimelineTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

export interface TimelinePresentation {
  id: string;
  runId: string;
  sequence: number;
  timestamp: number;
  title: string;
  detail?: string;
  tone: TimelineTone;
  toolUseId?: string;
  event: TaskTimelineEvent;
}
