import { create } from 'zustand';
import type { ClaudeEvent } from '../../shared/types/claude';
import type { PermissionRequest } from '../../shared/types/permissionBroker';
import type { Project } from '../../shared/types/project';
import type { HistoricalMessage, SessionStatus, SessionSummary } from '../../shared/types/session';
import type { TaskRecord, TaskTimelineEntry, TaskSyntheticEvent } from '../../shared/types/task';
import type { HydratedTaskState } from '../../shared/taskPersistence';
import { canonicalProjectKey, sessionKeyOf } from '../../shared/sessionIdentity';
import { isBusy, transitionSessionStatus } from '../../shared/sessionStateMachine';
import {
  appendTimelineEntry,
  createTaskRecord,
  isTaskTerminal,
  reduceTaskEvent,
  taskToolKey,
} from '../../shared/taskState';

export interface WorkspaceMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  origin: 'workbench' | 'claude-history' | 'live';
  forkable?: boolean;
  forkReason?: string;
  forkMessageId?: string;
  runId?: string;
}

export interface WorkspaceToolCall {
  key: string;
  runId: string;
  toolUseId: string;
  toolName: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  status: 'waiting_permission' | 'running' | 'completed' | 'failed' | 'denied';
  timestamp: number;
}

export interface SessionRuntime {
  key: string;
  projectPath: string;
  summary: SessionSummary;
  messages: WorkspaceMessage[];
  messageOffset: number;
  messageTotal: number;
  events: ClaudeEvent[];
  toolCalls: WorkspaceToolCall[];
  stderr: Array<{ text: string; level: string; timestamp: number }>;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  tasksById: Record<string, TaskRecord>;
  taskOrder: string[];
  timeline: TaskTimelineEntry[];
  taskEventOffset: number;
  taskEventTotal: number;
  draft: string;
  activeRunId: string | null;
  startedAt: number | null;
  hydrated: boolean;
  loadRequestId: string | null;
  statusBeforeHydration: SessionStatus | null;
  error: string | null;
}

export interface StartWorkspaceTaskInput {
  prompt?: string;
  agentMode?: string;
  userMessageId?: string;
  model?: string;
  startedAt?: number;
}

export interface FinishWorkspaceTaskInput {
  status: 'failed' | 'cancelled';
  message: string;
  timestamp?: number;
}

interface WorkspaceState {
  projects: Project[];
  currentProject: Project | null;
  currentSessionKey: string | null;
  sessionsByProject: Record<string, SessionSummary[]>;
  runtimes: Record<string, SessionRuntime>;
  projectRequestId: string | null;
  projectLoading: boolean;
  projectError: string | null;
  activeTab: 'conversation' | 'work';
  permissionRequests: PermissionRequest[];

  setProjects: (projects: Project[]) => void;
  upsertProject: (project: Project) => void;
  removeProjectIndex: (projectId: string) => void;
  beginProjectSelection: (project: Project, requestId: string) => void;
  commitProjectSessions: (
    project: Project,
    requestId: string,
    sessions: SessionSummary[],
  ) => boolean;
  failProjectSelection: (project: Project, requestId: string, error: string) => boolean;
  beginSessionSelection: (
    project: Project,
    session: SessionSummary,
    requestId: string,
  ) => string;
  hydrateSession: (
    sessionKey: string,
    requestId: string,
    messages: WorkspaceMessage[],
    tasks?: HydratedTaskState,
    messagePage?: { offset: number; total: number },
    taskPage?: { offset: number; total: number },
  ) => boolean;
  prependMessages: (
    sessionKey: string,
    messages: WorkspaceMessage[],
    page: { offset: number; total: number },
  ) => void;
  prependTaskState: (
    sessionKey: string,
    tasks: HydratedTaskState,
    page: { offset: number; total: number },
  ) => void;
  setSessionError: (sessionKey: string, error: string | null) => void;
  failSessionLoad: (sessionKey: string, requestId: string, error: string) => boolean;
  addSession: (project: Project, session: SessionSummary, select?: boolean) => string;
  updateSessionSummary: (sessionKey: string, patch: Partial<SessionSummary>) => void;
  removeSession: (project: Project, sessionKey: string) => void;
  setDraft: (sessionKey: string, draft: string) => void;
  appendUserMessage: (sessionKey: string, id: string, content: string, runId?: string) => void;
  setActiveRun: (sessionKey: string, runId: string) => void;
  tryStartRun: (
    sessionKey: string,
    runId: string,
    input?: StartWorkspaceTaskInput,
  ) => boolean;
  finishTask: (
    sessionKey: string,
    runId: string,
    input: FinishWorkspaceTaskInput,
  ) => boolean;
  applyClaudeEvent: (sessionKey: string, runId: string, event: ClaudeEvent) => boolean;
  setSessionStatus: (sessionKey: string, status: SessionStatus) => void;
  enqueuePermissionRequest: (request: PermissionRequest) => void;
  settlePermissionRequest: (requestId: string) => void;
  clearPermissionRequestsForRun: (runId: string) => void;
  setActiveTab: (tab: 'conversation' | 'work') => void;
  reset: () => void;
}

const emptyState = {
  projects: [] as Project[],
  currentProject: null as Project | null,
  currentSessionKey: null as string | null,
  sessionsByProject: {} as Record<string, SessionSummary[]>,
  runtimes: {} as Record<string, SessionRuntime>,
  projectRequestId: null as string | null,
  projectLoading: false,
  projectError: null as string | null,
  activeTab: 'conversation' as const,
  permissionRequests: [] as PermissionRequest[],
};

function makeRuntime(project: Project, summary: SessionSummary): SessionRuntime {
  const key = sessionKeyOf(project.path, summary);
  return {
    key,
    projectPath: project.path,
    summary: { ...summary, projectId: project.id, projectPath: project.path },
    messages: [],
    messageOffset: 0,
    messageTotal: 0,
    events: [],
    toolCalls: [],
    stderr: [],
    usage: null,
    tasksById: {},
    taskOrder: [],
    timeline: [],
    taskEventOffset: 0,
    taskEventTotal: 0,
    draft: '',
    activeRunId: null,
    startedAt: null,
    hydrated: false,
    loadRequestId: null,
    statusBeforeHydration: null,
    error: null,
  };
}

function mapHistoricalMessages(
  messages: HistoricalMessage[],
  indexOffset = 0,
): WorkspaceMessage[] {
  return messages.map((message, index) => ({
    id: message.uuid || `history-${indexOffset + index}`,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp ?? indexOffset + index,
    origin: 'claude-history' as const,
    forkable: Boolean(message.uuid),
    forkReason: message.uuid ? undefined : '该历史消息没有稳定 messageId，无法从这里分叉',
    forkMessageId: message.uuid,
  }));
}

export function mergeProjectSessions(
  project: Project,
  workbench: SessionSummary[],
  history: SessionSummary[],
): SessionSummary[] {
  const claimedClaudeIds = new Set(
    workbench.map((session) => session.claudeSessionId).filter(Boolean),
  );
  const normalizedWorkbench = workbench.map((session) => {
    const historyMatch = session.claudeSessionId
      ? history.find((candidate) => candidate.id === session.claudeSessionId)
      : undefined;
    return {
      ...session,
      projectId: project.id,
      projectPath: project.path,
      source: 'workbench' as const,
      archived: session.archived ?? false,
      tags: session.tags ?? [],
      summary: session.summary ?? historyMatch?.summary,
      gitBranch: session.gitBranch ?? historyMatch?.gitBranch,
    };
  });
  const normalizedHistory = history
    .filter((session) => !claimedClaudeIds.has(session.id))
    .map((session) => ({
      ...session,
      projectId: project.id,
      projectPath: project.path,
      claudeSessionId: session.claudeSessionId || session.id,
      source: 'claude-code' as const,
      archived: session.archived ?? false,
      tags: session.tags ?? [],
    }));
  return [...normalizedWorkbench, ...normalizedHistory].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

export function mergeWorkspaceMessages(
  historical: WorkspaceMessage[],
  current: WorkspaceMessage[],
): WorkspaceMessage[] {
  const merged = [...historical];
  const indexes = new Map(merged.map((message, index) => [message.id, index]));
  for (const message of current) {
    const index = indexes.get(message.id);
    if (index === undefined) {
      indexes.set(message.id, merged.length);
      merged.push(message);
    } else {
      merged[index] = message;
    }
  }
  return merged;
}

function uniqueEventKey(runId: string, event: ClaudeEvent): string {
  const record = event as unknown as Record<string, unknown>;
  return [
    runId,
    event.type,
    record.toolUseId,
    record.messageId,
    record.blockIndex,
    record.timestamp,
  ].join(':');
}

function startRuntimeTask(
  runtime: SessionRuntime,
  runId: string,
  input: StartWorkspaceTaskInput = {},
): SessionRuntime {
  const startedAt = input.startedAt ?? Date.now();
  const task = createTaskRecord({
    runId,
    projectKey: canonicalProjectKey(runtime.projectPath),
    sessionKey: runtime.key,
    prompt: input.prompt ?? '',
    agentMode: input.agentMode,
    userMessageId: input.userMessageId,
    model: input.model,
    startedAt,
  });
  return {
    ...runtime,
    tasksById: { ...runtime.tasksById, [runId]: task },
    taskOrder: [...runtime.taskOrder.filter((id) => id !== runId), runId],
    activeRunId: runId,
    startedAt,
    error: null,
    summary: { ...runtime.summary, status: 'running' },
  };
}

function applyTaskProjection(
  runtime: SessionRuntime,
  runId: string,
  event: TaskTimelineEntry['event'],
): SessionRuntime {
  const task = runtime.tasksById[runId];
  if (!task) return runtime;
  return {
    ...runtime,
    tasksById: {
      ...runtime.tasksById,
      [runId]: reduceTaskEvent(task, event),
    },
    timeline: appendTimelineEntry(runtime.timeline, task, event),
  };
}

function applyEvent(
  runtime: SessionRuntime,
  runId: string,
  event: ClaudeEvent,
): SessionRuntime {
  const record = event as ClaudeEvent & Record<string, unknown>;
  const active = runtime.activeRunId === runId;
  const legacyEventExists = runtime.timeline.some(
    (entry) => entry.runId === runId
      && 'type' in entry.event
      && uniqueEventKey(runId, entry.event as ClaudeEvent) === uniqueEventKey(runId, event),
  );
  let next = applyTaskProjection(runtime, runId, event);

  if (event.type === 'system_init' && active) {
    next = {
      ...next,
      summary: {
        ...next.summary,
        claudeSessionId: event.sessionId || next.summary.claudeSessionId,
        model: event.model || next.summary.model,
        status: 'running',
      },
    };
  } else if (event.type === 'assistant_text') {
    const messageId = String(record.messageId || `assistant:${runId}`);
    const existingIndex = next.messages.findIndex(
      (message) => message.id === messageId
        && message.role === 'assistant'
        && message.runId === runId,
    );
    const existing = existingIndex >= 0 ? next.messages[existingIndex] : undefined;
    const isSnapshot = record.isSnapshot !== false;
    const content = isSnapshot ? event.text : `${existing?.content ?? ''}${event.text}`;
    const message: WorkspaceMessage = {
      id: messageId,
      role: 'assistant',
      content,
      timestamp: event.timestamp,
      origin: 'live',
      forkable: typeof record.messageId === 'string' && record.messageId.length > 0,
      forkReason: typeof record.messageId === 'string'
        ? undefined
        : '该实时消息没有稳定 messageId，无法从这里分叉',
      forkMessageId: typeof record.messageId === 'string' ? record.messageId : undefined,
      runId,
    };
    const messages = [...next.messages];
    if (existingIndex >= 0) messages[existingIndex] = message;
    else messages.push(message);
    next = { ...next, messages };
  } else if (event.type === 'tool_started') {
    const key = taskToolKey(runId, event.toolUseId);
    const index = next.toolCalls.findIndex((tool) => tool.key === key);
    const tool: WorkspaceToolCall = {
      key,
      runId,
      toolUseId: event.toolUseId,
      toolName: event.toolName,
      input: event.input,
      status: 'running',
      timestamp: event.timestamp,
    };
    const toolCalls = [...next.toolCalls];
    if (index >= 0) toolCalls[index] = { ...toolCalls[index], ...tool };
    else toolCalls.push(tool);
    next = { ...next, toolCalls };
  } else if (event.type === 'tool_completed' || event.type === ('tool_failed' as ClaudeEvent['type'])) {
    const toolUseId = String(record.toolUseId || '');
    const key = taskToolKey(runId, toolUseId);
    const index = next.toolCalls.findIndex((tool) => tool.key === key);
    const failed = event.type === ('tool_failed' as ClaudeEvent['type']);
    const tool: WorkspaceToolCall = {
      key,
      runId,
      toolUseId,
      toolName: String(record.toolName || next.toolCalls[index]?.toolName || 'Tool'),
      input: next.toolCalls[index]?.input,
      output: record.output,
      error: typeof record.error === 'string' ? record.error : undefined,
      status: failed ? 'failed' : 'completed',
      timestamp: event.timestamp,
    };
    const toolCalls = [...next.toolCalls];
    if (index >= 0) toolCalls[index] = { ...toolCalls[index], ...tool };
    else toolCalls.push(tool);
    next = { ...next, toolCalls };
  } else if (event.type === 'usage_updated' && active) {
    next = {
      ...next,
      usage: {
        inputTokens: event.inputTokens ?? 0,
        outputTokens: event.outputTokens ?? 0,
        totalTokens: event.totalTokens ?? 0,
      },
    };
  } else if (event.type === 'stderr') {
    next = {
      ...next,
      stderr: [
        ...next.stderr,
        { text: event.text, level: event.level, timestamp: event.timestamp },
      ],
    };
  } else if (event.type === 'session_completed') {
    next = {
      ...next,
      ...(active ? {
        summary: {
          ...next.summary,
          status: 'completed' as const,
          completedAt: new Date(event.timestamp).toISOString(),
        },
        activeRunId: null,
      } : {}),
      toolCalls: next.toolCalls.map((tool) =>
        tool.runId === runId
          && (tool.status === 'running' || tool.status === 'waiting_permission')
          ? { ...tool, status: 'failed' as const, error: '任务结束前未收到工具结果' }
          : tool),
    };
  } else if (event.type === 'session_failed') {
    const status = next.summary.status === 'cancelled' ? 'cancelled' as const : 'failed' as const;
    next = {
      ...next,
      ...(active ? {
        summary: { ...next.summary, status },
        activeRunId: null,
        error: event.error,
      } : {}),
      toolCalls: next.toolCalls.map((tool) =>
        tool.runId === runId
          && (tool.status === 'running' || tool.status === 'waiting_permission')
          ? { ...tool, status: 'failed' as const, error: event.error }
          : tool),
    };
  }

  const displayable = ![
    'system_init',
    'session_started',
    'assistant_text',
    'thinking_content',
    'stderr',
  ].includes(event.type);
  if (displayable) {
    if (!legacyEventExists) next = { ...next, events: [...next.events, event] };
  }
  return next;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  ...emptyState,

  setProjects: (projects) => set({ projects }),
  upsertProject: (project) =>
    set((state) => ({
      projects: [project, ...state.projects.filter((candidate) => candidate.id !== project.id)],
    })),

  removeProjectIndex: (projectId) => set((state) => {
    const removed = state.currentProject?.id === projectId;
    const sessionsByProject = { ...state.sessionsByProject };
    delete sessionsByProject[projectId];
    return {
      projects: state.projects.filter((project) => project.id !== projectId),
      sessionsByProject,
      currentProject: removed ? null : state.currentProject,
      currentSessionKey: removed ? null : state.currentSessionKey,
      projectRequestId: removed ? null : state.projectRequestId,
      projectLoading: removed ? false : state.projectLoading,
      projectError: removed ? null : state.projectError,
    };
  }),

  beginProjectSelection: (project, requestId) =>
    set({
      currentProject: project,
      currentSessionKey: null,
      projectRequestId: requestId,
      projectLoading: true,
      projectError: null,
    }),

  commitProjectSessions: (project, requestId, sessions) => {
    const state = get();
    if (
      state.projectRequestId !== requestId ||
      state.currentProject?.id !== project.id
    ) return false;
    set((current) => ({
      sessionsByProject: { ...current.sessionsByProject, [project.id]: sessions },
      projectLoading: false,
      projectError: null,
    }));
    return true;
  },

  failProjectSelection: (project, requestId, error) => {
    const state = get();
    if (state.projectRequestId !== requestId || state.currentProject?.id !== project.id) {
      return false;
    }
    set({ projectLoading: false, projectError: error });
    return true;
  },

  beginSessionSelection: (project, session, requestId) => {
    const key = sessionKeyOf(project.path, session);
    set((state) => {
      const existing = state.runtimes[key] ?? makeRuntime(project, session);
      const runtime = {
        ...existing,
        projectPath: project.path,
        statusBeforeHydration: existing.hydrated ? null : session.status,
        summary: {
          ...existing.summary,
          ...session,
          projectId: project.id,
          projectPath: project.path,
          status: existing.hydrated ? existing.summary.status : 'loading_history' as const,
        },
        loadRequestId: existing.hydrated ? null : requestId,
        error: null,
      };
      return {
        currentSessionKey: key,
        runtimes: { ...state.runtimes, [key]: runtime },
      };
    });
    return key;
  },

  hydrateSession: (sessionKey, requestId, messages, tasks, messagePage, taskPage) => {
    const current = get();
    const runtime = current.runtimes[sessionKey];
    if (
      !runtime ||
      runtime.loadRequestId !== requestId ||
      current.currentSessionKey !== sessionKey
    ) return false;
    const nextStatus = runtime.activeRunId
      ? runtime.summary.status
      : runtime.statusBeforeHydration && runtime.statusBeforeHydration !== 'loading_history'
        ? runtime.statusBeforeHydration
        : 'idle';
    set((state) => ({
      runtimes: {
        ...state.runtimes,
        [sessionKey]: {
          ...runtime,
          messages: mergeWorkspaceMessages(messages, runtime.messages),
          messageOffset: messagePage?.offset ?? 0,
          messageTotal: messagePage?.total ?? messages.length,
          tasksById: tasks?.tasksById ?? runtime.tasksById,
          taskOrder: tasks?.taskOrder ?? runtime.taskOrder,
          timeline: tasks?.timeline ?? runtime.timeline,
          taskEventOffset: taskPage?.offset ?? 0,
          taskEventTotal: taskPage?.total ?? tasks?.timeline.length ?? runtime.taskEventTotal,
          hydrated: true,
          loadRequestId: null,
          statusBeforeHydration: null,
          summary: { ...runtime.summary, status: nextStatus },
          error: null,
        },
      },
    }));
    return true;
  },

  prependMessages: (sessionKey, messages, page) => set((state) => {
    const runtime = state.runtimes[sessionKey];
    if (!runtime || page.offset >= runtime.messageOffset) return state;
    return {
      runtimes: {
        ...state.runtimes,
        [sessionKey]: {
          ...runtime,
          messages: mergeWorkspaceMessages(messages, runtime.messages),
          messageOffset: page.offset,
          messageTotal: page.total,
          error: null,
        },
      },
    };
  }),

  prependTaskState: (sessionKey, tasks, page) => set((state) => {
    const runtime = state.runtimes[sessionKey];
    if (!runtime) return state;
    const timelineById = new Map([
      ...tasks.timeline.map((entry) => [entry.id, entry] as const),
      ...runtime.timeline.map((entry) => [entry.id, entry] as const),
    ]);
    return {
      runtimes: {
        ...state.runtimes,
        [sessionKey]: {
          ...runtime,
          tasksById: { ...tasks.tasksById, ...runtime.tasksById },
          taskOrder: [...new Set([...tasks.taskOrder, ...runtime.taskOrder])],
          timeline: [...timelineById.values()].sort(
            (left, right) => left.timestamp - right.timestamp || left.sequence - right.sequence,
          ),
          taskEventOffset: page.offset,
          taskEventTotal: page.total,
        },
      },
    };
  }),

  setSessionError: (sessionKey, error) => set((state) => {
    const runtime = state.runtimes[sessionKey];
    if (!runtime) return state;
    return {
      runtimes: {
        ...state.runtimes,
        [sessionKey]: { ...runtime, error },
      },
    };
  }),

  failSessionLoad: (sessionKey, requestId, error) => {
    const current = get();
    const runtime = current.runtimes[sessionKey];
    if (
      !runtime ||
      runtime.loadRequestId !== requestId ||
      current.currentSessionKey !== sessionKey
    ) return false;
    set((state) => ({
      runtimes: {
        ...state.runtimes,
        [sessionKey]: {
          ...runtime,
          loadRequestId: null,
          hydrated: true,
          statusBeforeHydration: null,
          summary: { ...runtime.summary, status: 'failed' },
          error,
        },
      },
    }));
    return true;
  },

  addSession: (project, session, select = true) => {
    const key = sessionKeyOf(project.path, session);
    set((state) => ({
      sessionsByProject: {
        ...state.sessionsByProject,
        [project.id]: [
          { ...session, projectId: project.id, projectPath: project.path },
          ...(state.sessionsByProject[project.id] ?? []).filter(
            (candidate) => sessionKeyOf(project.path, candidate) !== key,
          ),
        ],
      },
      runtimes: {
        ...state.runtimes,
        [key]: {
          ...makeRuntime(project, session),
          hydrated: true,
        },
      },
      currentSessionKey: select ? key : state.currentSessionKey,
    }));
    return key;
  },

  updateSessionSummary: (sessionKey, patch) =>
    set((state) => {
      const runtime = state.runtimes[sessionKey];
      if (!runtime) return state;
      const summary = { ...runtime.summary, ...patch };
      return {
        runtimes: {
          ...state.runtimes,
          [sessionKey]: { ...runtime, summary },
        },
        sessionsByProject: {
          ...state.sessionsByProject,
          [summary.projectId]: (state.sessionsByProject[summary.projectId] ?? []).map(
            (candidate) =>
              sessionKeyOf(runtime.projectPath, candidate) === sessionKey
                ? { ...candidate, ...patch }
                : candidate,
          ),
        },
      };
    }),

  removeSession: (project, sessionKey) =>
    set((state) => {
      const runtimes = { ...state.runtimes };
      delete runtimes[sessionKey];
      return {
        runtimes,
        sessionsByProject: {
          ...state.sessionsByProject,
          [project.id]: (state.sessionsByProject[project.id] ?? []).filter(
            (candidate) => sessionKeyOf(project.path, candidate) !== sessionKey,
          ),
        },
        currentSessionKey:
          state.currentSessionKey === sessionKey ? null : state.currentSessionKey,
      };
    }),

  setDraft: (sessionKey, draft) =>
    set((state) => {
      const runtime = state.runtimes[sessionKey];
      if (!runtime) return state;
      return {
        runtimes: {
          ...state.runtimes,
          [sessionKey]: { ...runtime, draft },
        },
      };
    }),

  appendUserMessage: (sessionKey, id, content, runId) =>
    set((state) => {
      const runtime = state.runtimes[sessionKey];
      if (!runtime) return state;
      return {
        runtimes: {
          ...state.runtimes,
          [sessionKey]: {
            ...runtime,
            messages: [
              ...runtime.messages,
              {
                id,
                role: 'user',
                content,
                timestamp: Date.now(),
                origin: 'live',
                forkable: false,
                forkReason: 'Workbench 用户消息 ID 与 Claude transcript messageId 不同，请从后续 Claude 回复分叉',
                runId,
              },
            ],
            draft: '',
          },
        },
      };
    }),

  setActiveRun: (sessionKey, runId) =>
    set((state) => {
      const runtime = state.runtimes[sessionKey];
      if (!runtime) return state;
      return {
        runtimes: {
          ...state.runtimes,
          [sessionKey]: startRuntimeTask(runtime, runId),
        },
      };
    }),

  tryStartRun: (sessionKey, runId, input) => {
    let started = false;
    set((state) => {
      const runtime = state.runtimes[sessionKey];
      if (!runtime || runtime.activeRunId || isBusy(runtime.summary.status)) return state;
      started = true;
      return {
        runtimes: {
          ...state.runtimes,
          [sessionKey]: startRuntimeTask(runtime, runId, input),
        },
      };
    });
    return started;
  },

  applyClaudeEvent: (sessionKey, runId, event) => {
    const initialRuntime = get().runtimes[sessionKey];
    if (!initialRuntime?.tasksById[runId]) return false;
    let applied = false;
    const terminal = event.type === 'session_completed' || event.type === 'session_failed';
    set((state) => {
      const runtime = state.runtimes[sessionKey];
      if (!runtime?.tasksById[runId]) return state;
      applied = true;
      return {
        runtimes: {
          ...state.runtimes,
          [sessionKey]: applyEvent(runtime, runId, event),
        },
        permissionRequests: terminal
          ? state.permissionRequests.filter((request) => request.runId !== runId)
          : state.permissionRequests,
      };
    });
    return applied;
  },

  finishTask: (sessionKey, runId, input) => {
    let finished = false;
    set((state) => {
      const runtime = state.runtimes[sessionKey];
      const task = runtime?.tasksById[runId];
      if (!runtime || !task || isTaskTerminal(task.status)) return state;
      finished = true;
      const timestamp = input.timestamp ?? Date.now();
      const event: TaskSyntheticEvent = input.status === 'cancelled'
        ? { type: 'task_cancelled', reason: input.message, timestamp }
        : { type: 'task_start_failed', error: input.message, timestamp };
      let nextRuntime = applyTaskProjection(runtime, runId, event);
      const active = runtime.activeRunId === runId;
      nextRuntime = {
        ...nextRuntime,
        ...(active ? {
          activeRunId: null,
          summary: { ...nextRuntime.summary, status: input.status },
          error: input.status === 'failed' ? input.message : nextRuntime.error,
        } : {}),
        toolCalls: nextRuntime.toolCalls.map((tool) =>
          tool.runId === runId
            && (tool.status === 'running' || tool.status === 'waiting_permission')
            ? {
              ...tool,
              status: input.status === 'cancelled' ? 'denied' as const : 'failed' as const,
              error: input.message,
            }
            : tool),
      };
      return {
        runtimes: { ...state.runtimes, [sessionKey]: nextRuntime },
        permissionRequests: state.permissionRequests.filter(
          (request) => request.runId !== runId,
        ),
      };
    });
    return finished;
  },

  setSessionStatus: (sessionKey, status) =>
    set((state) => {
      const runtime = state.runtimes[sessionKey];
      if (!runtime) return state;
      const next = transitionSessionStatus(runtime.summary.status, status);
      const terminal = ['completed', 'failed', 'cancelled'].includes(next);
      const activeRunId = runtime.activeRunId;
      let projected = runtime;
      if (activeRunId && (next === 'cancelled' || next === 'failed')) {
        const event: TaskSyntheticEvent = next === 'cancelled'
          ? { type: 'task_cancelled', reason: '任务已停止', timestamp: Date.now() }
          : { type: 'task_start_failed', error: runtime.error || '任务运行失败', timestamp: Date.now() };
        projected = applyTaskProjection(runtime, activeRunId, event);
      }
      return {
        runtimes: {
          ...state.runtimes,
          [sessionKey]: {
            ...projected,
            activeRunId: terminal ? null : projected.activeRunId,
            summary: { ...projected.summary, status: next },
            toolCalls: terminal
              ? projected.toolCalls.map((tool) =>
                (!activeRunId || tool.runId === activeRunId)
                  && (tool.status === 'running' || tool.status === 'waiting_permission')
                  ? {
                    ...tool,
                    status: next === 'cancelled' ? 'denied' : 'failed',
                    error: next === 'cancelled' ? '任务已停止' : projected.error ?? undefined,
                  }
                  : tool)
              : projected.toolCalls,
          },
        },
        permissionRequests: terminal && activeRunId
          ? state.permissionRequests.filter((request) => request.runId !== activeRunId)
          : state.permissionRequests,
      };
    }),

  enqueuePermissionRequest: (request) =>
    set((state) => {
      const runtime = state.runtimes[request.sessionKey];
      if (!runtime || runtime.activeRunId !== request.runId) return state;
      const toolUseId = request.toolUseId || request.requestId;
      const key = taskToolKey(request.runId, toolUseId);
      const index = runtime.toolCalls.findIndex(
        (tool) => tool.key === key,
      );
      const toolCalls = [...runtime.toolCalls];
      const tool: WorkspaceToolCall = {
        key,
        runId: request.runId,
        toolUseId,
        toolName: request.toolName,
        input: request.input,
        status: 'waiting_permission',
        timestamp: request.createdAt,
      };
      if (index >= 0) toolCalls[index] = { ...toolCalls[index], ...tool };
      else toolCalls.push(tool);
      const nextRuntime = applyTaskProjection(runtime, request.runId, {
        type: 'permission_waiting',
        requestId: request.requestId,
        toolName: request.toolName,
        toolUseId: request.toolUseId,
        risk: request.risk,
        timestamp: request.createdAt,
      });
      return {
        permissionRequests: [
          ...state.permissionRequests.filter(
            (candidate) => candidate.requestId !== request.requestId,
          ),
          request,
        ].sort((a, b) => a.createdAt - b.createdAt),
        runtimes: {
          ...state.runtimes,
          [request.sessionKey]: {
            ...nextRuntime,
            toolCalls,
            summary: { ...nextRuntime.summary, status: 'waiting_permission' },
          },
        },
      };
    }),

  settlePermissionRequest: (requestId) =>
    set((state) => {
      const request = state.permissionRequests.find(
        (candidate) => candidate.requestId === requestId,
      );
      if (!request) return state;
      const permissionRequests = state.permissionRequests.filter(
        (candidate) => candidate.requestId !== requestId,
      );
      const runtime = state.runtimes[request.sessionKey];
      if (!runtime) return { permissionRequests };
      const stillWaiting = permissionRequests.some(
        (candidate) => candidate.sessionKey === request.sessionKey
          && candidate.runId === request.runId,
      );
      const projected = runtime.tasksById[request.runId]
        ? applyTaskProjection(runtime, request.runId, {
          type: 'permission_settled',
          requestId: request.requestId,
          toolName: request.toolName,
          toolUseId: request.toolUseId,
          timestamp: Date.now(),
        })
        : runtime;
      return {
        permissionRequests,
        runtimes: {
          ...state.runtimes,
          [request.sessionKey]: {
            ...projected,
            toolCalls: projected.toolCalls.map((tool) =>
              tool.runId === request.runId
                && tool.toolUseId === (request.toolUseId || request.requestId)
                && tool.status === 'waiting_permission'
                ? { ...tool, status: 'running' as const }
                : tool),
            summary: {
              ...projected.summary,
              status: projected.activeRunId === request.runId && !stillWaiting
                ? 'running'
                : projected.summary.status,
            },
          },
        },
      };
    }),

  clearPermissionRequestsForRun: (runId) =>
    set((state) => ({
      permissionRequests: state.permissionRequests.filter(
        (request) => request.runId !== runId,
      ),
    })),

  setActiveTab: (activeTab) => set({ activeTab }),
  reset: () => set({ ...emptyState }),
}));

export { mapHistoricalMessages };
