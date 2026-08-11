import type { ClaudeEvent } from './claude';

export type SessionStatus =
  | 'idle'
  | 'loading_history'
  | 'running'
  | 'waiting_permission'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Source of the session */
export type SessionSource = 'workbench' | 'claude-code';

export interface SessionSummary {
  id: string;
  projectId: string;
  claudeSessionId: string | null;
  title: string;
  status: SessionStatus;
  model: string | null;
  permissionMode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  messageCount: number;
  /** Where this session originated */
  source: SessionSource;
  /** Whether this session is archived */
  archived: boolean;
  /** User-defined tags */
  tags: string[];
  /** SDK-provided summary text */
  summary?: string;
  /** Original project filesystem path (for external sessions) */
  projectPath?: string;
  /** Git branch at session time */
  gitBranch?: string;
  /** How the visible title was selected. Manual titles always win. */
  titleSource?: 'default' | 'first_prompt' | 'manual' | 'custom' | 'summary';
  /** Last run duration when known. */
  durationMs?: number;
  /** Concise actionable failure from the last run or load. */
  error?: string;
}

export interface SessionMetadataPatch {
  title?: string;
  titleSource?: 'default' | 'first_prompt' | 'manual' | 'custom' | 'summary';
  status?: SessionStatus;
  claudeSessionId?: string | null;
  model?: string | null;
  permissionMode?: string | null;
  archived?: boolean;
  tags?: string[];
  completedAt?: string | null;
}

export interface SessionDetail extends SessionSummary {
  messages: Message[];
  events: ClaudeEvent[];
}

export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

/** A message read from a historical Claude Code transcript */
export interface HistoricalMessage {
  role: 'user' | 'assistant';
  content: string;
  uuid?: string;
  timestamp?: number;
}

export interface FileChange {
  id: string;
  sessionId: string;
  filePath: string;
  changeType: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  createdAt: string;
}

/** Options for forking a session */
export interface ForkOptions {
  upToMessageId?: string;
  title?: string;
}

/** Result of a fork operation */
export interface ForkResult {
  sessionId: string;
}
