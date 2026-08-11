import type { ResolvedModelSelection } from './modelProviders';

/** Claude Code installation information */
export interface ClaudeInstallationInfo {
  installed: boolean;
  path: string | null;
  version: string | null;
}

/** Options for starting a Claude session */
export interface StartSessionOptions {
  projectPath: string;
  model?: string;
  permissionMode?: CliPermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  systemPrompt?: string;
  maxTurns?: number;
}

/**
 * Permission modes that map directly to Claude CLI --permission-mode values.
 * These are the ONLY valid values passed to the CLI.
 */
export type CliPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

/**
 * UI permission mode identifiers used in settings and UI selectors.
 * These map to CliPermissionMode via PERMISSION_MODE_MAP.
 */
export type UIPermissionMode = 'standard' | 'accept-edits' | 'plan' | 'bypass';

/**
 * Maps UI permission mode values to CLI --permission-mode arguments.
 * This is the SINGLE source of truth for the mapping.
 */
export const PERMISSION_MODE_MAP: Record<UIPermissionMode, CliPermissionMode> = {
  standard: 'default',
  'accept-edits': 'acceptEdits',
  plan: 'plan',
  bypass: 'bypassPermissions',
};

/**
 * Maps legacy permission mode values (from older settings) to UI values.
 * Used during settings migration.
 */
export const LEGACY_PERMISSION_MAP: Record<string, UIPermissionMode> = {
  safe: 'standard',
  acceptEdits: 'accept-edits',
  plan: 'plan',
  custom: 'standard',
  standard: 'standard',
  'accept-edits': 'accept-edits',
  bypass: 'bypass',
};

/**
 * Permission mode display info for UI.
 */
export interface PermissionModeInfo {
  uiValue: UIPermissionMode;
  cliValue: CliPermissionMode;
  nameKey: string;
  descKey: string;
  dangerous?: boolean;
}

export const PERMISSION_MODES: PermissionModeInfo[] = [
  {
    uiValue: 'standard',
    cliValue: 'default',
    nameKey: 'permission.standard',
    descKey: 'permission.standardDesc',
  },
  {
    uiValue: 'accept-edits',
    cliValue: 'acceptEdits',
    nameKey: 'permission.acceptEdits',
    descKey: 'permission.acceptEditsDesc',
  },
  {
    uiValue: 'plan',
    cliValue: 'plan',
    nameKey: 'permission.plan',
    descKey: 'permission.planDesc',
  },
  {
    uiValue: 'bypass',
    cliValue: 'bypassPermissions',
    nameKey: 'permission.bypass',
    descKey: 'permission.bypassDesc',
    dangerous: true,
  },
];

/** Normalized Claude events */
export type ClaudeEvent =
  | SessionStartedEvent
  | SystemInitEvent
  | AssistantTextEvent
  | ThinkingContentEvent
  | StderrEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ToolFailedEvent
  | CommandStartedEvent
  | CommandOutputEvent
  | FileReadEvent
  | FileChangedEvent
  | PermissionRequestedEvent
  | UsageUpdatedEvent
  | SessionCompletedEvent
  | SessionFailedEvent;

export interface SessionStartedEvent {
  type: 'session_started';
  sessionId: string;
  timestamp: number;
}

export interface SystemInitEvent {
  type: 'system_init';
  sessionId: string;
  model: string;
  timestamp: number;
}

export interface AssistantTextEvent {
  type: 'assistant_text';
  text: string;
  /** Stable Claude message identity. ClaudeEventParser always supplies this. */
  messageId?: string;
  /** Index of the text content block within the assistant message. */
  blockIndex?: number;
  /** Full assistant messages are snapshots; stream deltas are append-only chunks. */
  isSnapshot?: boolean;
  timestamp: number;
}

/** Thinking content — internal reasoning, not shown in chat */
export interface ThinkingContentEvent {
  type: 'thinking_content';
  text: string;
  timestamp: number;
}

/** Stderr output from CLI process */
export interface StderrEvent {
  type: 'stderr';
  text: string;
  level: 'warning' | 'error' | 'info';
  timestamp: number;
}

export interface ToolStartedEvent {
  type: 'tool_started';
  toolName: string;
  toolUseId: string;
  input?: unknown;
  timestamp: number;
}

export interface ToolCompletedEvent {
  type: 'tool_completed';
  toolName: string;
  toolUseId: string;
  output?: unknown;
  timestamp: number;
}

export interface ToolFailedEvent {
  type: 'tool_failed';
  toolName: string;
  toolUseId: string;
  error: string;
  output?: unknown;
  timestamp: number;
}

export interface CommandStartedEvent {
  type: 'command_started';
  command: string;
  toolUseId: string;
  timestamp: number;
}

export interface CommandOutputEvent {
  type: 'command_output';
  output: string;
  toolUseId: string;
  timestamp: number;
}

export interface FileReadEvent {
  type: 'file_read';
  filePath: string;
  toolUseId: string;
  timestamp: number;
}

export interface FileChangedEvent {
  type: 'file_changed';
  filePath: string;
  toolUseId: string;
  timestamp: number;
}

export interface PermissionRequestedEvent {
  type: 'permission_requested';
  toolName: string;
  toolUseId: string;
  description: string;
  timestamp: number;
}

export interface UsageUpdatedEvent {
  type: 'usage_updated';
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  timestamp: number;
}

/** A tool invocation denied by Claude Code's permission system. */
export interface PermissionDenial {
  toolName: string;
  toolUseId?: string;
  toolInput?: unknown;
  reason?: string;
}

export interface SessionCompletedEvent {
  type: 'session_completed';
  sessionId: string;
  duration: number;
  /** Final result is retained on the terminal event instead of repeated as chat text. */
  result?: string;
  permissionDenials?: PermissionDenial[];
  timestamp: number;
}

export interface SessionFailedEvent {
  type: 'session_failed';
  error: string;
  sessionId?: string;
  duration?: number;
  permissionDenials?: PermissionDenial[];
  timestamp: number;
}

/** A single one-shot Claude Code process/turn. */
export interface ClaudeRunOptions extends StartSessionOptions {
  runId: string;
  /** Stable task identity used by the main-process permission scope. */
  taskId?: string;
  projectId?: string;
  projectKey: string;
  sessionKey: string;
  prompt: string;
  /** Main-process-resolved Provider identity. Renderer values must be re-resolved before this boundary. */
  modelProviderId?: string;
  /** Renderer-safe immutable snapshot chosen by the main-process policy resolver. */
  resolvedModelSelection?: ResolvedModelSelection;
  /** Main-process-authored JSON Schema enforced by Claude Code for agent stage output. */
  structuredOutputSchema?: Readonly<Record<string, unknown>>;
  /** Workbench-only policy. The adapter still receives an ordinary CLI permission mode. */
  agentMode?: 'normal' | 'plan' | 'develop' | 'review';
  /** Exact Claude transcript id used with --resume. */
  resumeSessionId?: string;
  /** Main-process workflow routing metadata; renderer-originated values are never trusted. */
  workflowContext?: {
    workflowId: string;
    stage: 'planner' | 'coder' | 'tester' | 'reviewer';
    reviewRound: number;
  };
}

export interface ClaudeRunDescriptor {
  runId: string;
  pid: number | null;
}

export interface ClaudeEventEnvelope {
  runId: string;
  projectKey: string;
  sessionKey: string;
  projectId?: string;
  projectPath?: string;
  taskId?: string;
  workflowId?: string;
  event: ClaudeEvent;
}

/** Claude adapter interface. One prompt always maps to one child process. */
export interface ClaudeAdapter {
  checkInstallation(): Promise<ClaudeInstallationInfo>;
  runPrompt(options: ClaudeRunOptions): Promise<ClaudeRunDescriptor>;
  stopRun(runId: string): Promise<boolean>;
  stopAll(): Promise<void>;
  subscribe(listener: (envelope: ClaudeEventEnvelope) => void): () => void;
}
