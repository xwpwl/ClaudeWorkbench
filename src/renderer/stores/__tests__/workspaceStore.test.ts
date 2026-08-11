import { beforeEach, describe, expect, it } from 'vitest';
import type { ClaudeEvent } from '../../../shared/types/claude';
import type { PermissionRequest } from '../../../shared/types/permissionBroker';
import type { Project } from '../../../shared/types/project';
import type { SessionSummary } from '../../../shared/types/session';
import {
  mergeProjectSessions,
  mergeWorkspaceMessages,
  mapHistoricalMessages,
  type WorkspaceMessage,
  useWorkspaceStore,
} from '../workspaceStore';

const NOW = '2026-08-01T00:00:00.000Z';

function project(id: string, path: string): Project {
  return {
    id,
    name: id,
    path,
    createdAt: NOW,
    lastOpenedAt: NOW,
  };
}

function session(
  id: string,
  projectId: string,
  patch: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    projectId,
    claudeSessionId: null,
    title: id,
    status: 'idle',
    model: null,
    permissionMode: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    messageCount: 0,
    source: 'workbench',
    archived: false,
    tags: [],
    ...patch,
  };
}

function assistantEvent(
  text: string,
  patch: Partial<Extract<ClaudeEvent, { type: 'assistant_text' }>> = {},
): Extract<ClaudeEvent, { type: 'assistant_text' }> {
  return {
    type: 'assistant_text',
    text,
    messageId: 'assistant-1',
    isSnapshot: true,
    timestamp: 1,
    ...patch,
  };
}

describe('workspaceStore', () => {
  beforeEach(() => {
    useWorkspaceStore.getState().reset();
  });

  it('isolates identical session ids with composite project/session keys', () => {
    const projectA = project('project-a', 'C:\\Projects\\Alpha');
    const projectB = project('project-b', 'C:\\Projects\\Beta');

    const keyA = useWorkspaceStore.getState().addSession(
      projectA,
      session('same-session', projectA.id),
    );
    const keyB = useWorkspaceStore.getState().addSession(
      projectB,
      session('same-session', projectB.id),
    );

    expect(keyA).not.toBe(keyB);
    expect(useWorkspaceStore.getState().runtimes[keyA].projectPath).toBe(projectA.path);
    expect(useWorkspaceStore.getState().runtimes[keyB].projectPath).toBe(projectB.path);
  });

  it('does not let a stale project request overwrite the active project', () => {
    const projectA = project('project-a', 'C:\\Projects\\Alpha');
    const projectB = project('project-b', 'C:\\Projects\\Beta');
    const store = useWorkspaceStore.getState();

    store.beginProjectSelection(projectA, 'project-request-a');
    store.beginProjectSelection(projectB, 'project-request-b');
    const committed = store.commitProjectSessions(
      projectA,
      'project-request-a',
      [session('session-a', projectA.id)],
    );

    expect(committed).toBe(false);
    expect(useWorkspaceStore.getState().currentProject).toEqual(projectB);
    expect(useWorkspaceStore.getState().sessionsByProject[projectA.id]).toBeUndefined();
  });

  it('does not hydrate a stale session request after another session is selected', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const firstSession = session('session-a', selectedProject.id);
    const secondSession = session('session-b', selectedProject.id);
    const store = useWorkspaceStore.getState();
    const firstKey = store.beginSessionSelection(
      selectedProject,
      firstSession,
      'session-request-a',
    );
    const secondKey = store.beginSessionSelection(
      selectedProject,
      secondSession,
      'session-request-b',
    );
    const staleMessages: WorkspaceMessage[] = [{
      id: 'stale-message',
      role: 'assistant',
      content: 'stale',
      timestamp: 1,
      origin: 'claude-history',
    }];

    const hydrated = store.hydrateSession(firstKey, 'session-request-a', staleMessages);

    expect(hydrated).toBe(false);
    expect(useWorkspaceStore.getState().currentSessionKey).toBe(secondKey);
    expect(useWorkspaceStore.getState().runtimes[firstKey].hydrated).toBe(false);
  });

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'preserves a persisted %s session status after history hydration',
    (status) => {
      const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
      const selectedSession = session('session-a', selectedProject.id, { status });
      const store = useWorkspaceStore.getState();
      const key = store.beginSessionSelection(selectedProject, selectedSession, 'load-terminal');

      expect(useWorkspaceStore.getState().runtimes[key].summary.status).toBe('loading_history');
      expect(store.hydrateSession(key, 'load-terminal', [])).toBe(true);
      expect(useWorkspaceStore.getState().runtimes[key].summary.status).toBe(status);
      expect(useWorkspaceStore.getState().runtimes[key].statusBeforeHydration).toBeNull();
    },
  );

  it('returns an idle persisted session to idle after history hydration', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const selectedSession = session('session-a', selectedProject.id);
    const store = useWorkspaceStore.getState();
    const key = store.beginSessionSelection(selectedProject, selectedSession, 'load-idle');

    expect(store.hydrateSession(key, 'load-idle', [])).toBe(true);
    expect(useWorkspaceStore.getState().runtimes[key].summary.status).toBe('idle');
  });

  it('clears currentSessionKey immediately when project selection begins', () => {
    const projectA = project('project-a', 'C:\\Projects\\Alpha');
    const projectB = project('project-b', 'C:\\Projects\\Beta');
    useWorkspaceStore.getState().addSession(projectA, session('session-a', projectA.id));

    useWorkspaceStore.getState().beginProjectSelection(projectB, 'project-request-b');

    expect(useWorkspaceStore.getState().currentSessionKey).toBeNull();
    expect(useWorkspaceStore.getState().projectLoading).toBe(true);
  });

  it('keeps session lists isolated by project', () => {
    const projectA = project('project-a', 'C:\\Projects\\Alpha');
    const projectB = project('project-b', 'C:\\Projects\\Beta');

    useWorkspaceStore.getState().addSession(projectA, session('session-a', projectA.id));
    useWorkspaceStore.getState().addSession(projectB, session('session-b', projectB.id));

    expect(useWorkspaceStore.getState().sessionsByProject[projectA.id].map((item) => item.id))
      .toEqual(['session-a']);
    expect(useWorkspaceStore.getState().sessionsByProject[projectB.id].map((item) => item.id))
      .toEqual(['session-b']);
  });

  it('merges Workbench and history sessions without duplicating a claimed Claude session', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const workbench = session('workbench-1', selectedProject.id, {
      claudeSessionId: 'claude-1',
      summary: undefined,
    });
    const matchingHistory = session('claude-1', '', {
      claudeSessionId: 'claude-1',
      source: 'claude-code',
      summary: 'history summary',
    });
    const otherHistory = session('claude-2', '', {
      claudeSessionId: 'claude-2',
      source: 'claude-code',
    });

    const merged = mergeProjectSessions(
      selectedProject,
      [workbench],
      [matchingHistory, otherHistory],
    );

    expect(merged).toHaveLength(2);
    expect(merged.filter((item) => item.claudeSessionId === 'claude-1')).toHaveLength(1);
    expect(merged.find((item) => item.id === 'workbench-1')?.summary).toBe('history summary');
    expect(merged.find((item) => item.id === 'claude-2')?.source).toBe('claude-code');
  });

  it('keeps drafts independent for each session', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const keyA = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-a', selectedProject.id),
    );
    const keyB = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-b', selectedProject.id),
    );

    useWorkspaceStore.getState().setDraft(keyA, 'draft A');
    useWorkspaceStore.getState().setDraft(keyB, 'draft B');

    expect(useWorkspaceStore.getState().runtimes[keyA].draft).toBe('draft A');
    expect(useWorkspaceStore.getState().runtimes[keyB].draft).toBe('draft B');
  });

  it('replaces an assistant snapshot with the newer snapshot', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const key = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-a', selectedProject.id),
    );
    useWorkspaceStore.getState().setActiveRun(key, 'run-a');

    useWorkspaceStore.getState().applyClaudeEvent(
      key,
      'run-a',
      assistantEvent('Hel', { timestamp: 1 }),
    );
    useWorkspaceStore.getState().applyClaudeEvent(
      key,
      'run-a',
      assistantEvent('Hello', { timestamp: 2 }),
    );

    expect(useWorkspaceStore.getState().runtimes[key].messages).toHaveLength(1);
    expect(useWorkspaceStore.getState().runtimes[key].messages[0].content).toBe('Hello');
  });

  it('appends assistant chunks when isSnapshot is false', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const key = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-a', selectedProject.id),
    );
    useWorkspaceStore.getState().setActiveRun(key, 'run-a');

    useWorkspaceStore.getState().applyClaudeEvent(
      key,
      'run-a',
      assistantEvent('Hello ', { isSnapshot: false, timestamp: 1 }),
    );
    useWorkspaceStore.getState().applyClaudeEvent(
      key,
      'run-a',
      assistantEvent('world', { isSnapshot: false, timestamp: 2 }),
    );

    expect(useWorkspaceStore.getState().runtimes[key].messages).toHaveLength(1);
    expect(useWorkspaceStore.getState().runtimes[key].messages[0].content)
      .toBe('Hello world');
  });

  it('ignores Claude events whose runId does not match the active run', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const key = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-a', selectedProject.id),
    );
    useWorkspaceStore.getState().setActiveRun(key, 'run-a');

    const applied = useWorkspaceStore.getState().applyClaudeEvent(
      key,
      'run-b',
      assistantEvent('wrong run'),
    );

    expect(applied).toBe(false);
    expect(useWorkspaceStore.getState().runtimes[key].messages).toEqual([]);
  });

  it('deduplicates tool start/completion updates by toolUseId', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const key = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-a', selectedProject.id),
    );
    useWorkspaceStore.getState().setActiveRun(key, 'run-a');

    useWorkspaceStore.getState().applyClaudeEvent(key, 'run-a', {
      type: 'tool_started',
      toolName: 'Read',
      toolUseId: 'tool-1',
      input: { file_path: 'README.md' },
      timestamp: 1,
    });
    useWorkspaceStore.getState().applyClaudeEvent(key, 'run-a', {
      type: 'tool_completed',
      toolName: 'Read',
      toolUseId: 'tool-1',
      output: 'done',
      timestamp: 2,
    });

    const tools = useWorkspaceStore.getState().runtimes[key].toolCalls;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      toolUseId: 'tool-1',
      toolName: 'Read',
      status: 'completed',
      output: 'done',
    });
  });

  it('clears activeRunId when a terminal event arrives', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const key = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-a', selectedProject.id),
    );
    useWorkspaceStore.getState().setActiveRun(key, 'run-a');

    useWorkspaceStore.getState().applyClaudeEvent(key, 'run-a', {
      type: 'session_completed',
      sessionId: 'claude-session-a',
      duration: 100,
      timestamp: 2,
    });

    expect(useWorkspaceStore.getState().runtimes[key].activeRunId).toBeNull();
    expect(useWorkspaceStore.getState().runtimes[key].summary.status).toBe('completed');
  });

  it('marks an unfinished permission tool failed when the process exits abnormally', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const key = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-a', selectedProject.id),
    );
    useWorkspaceStore.getState().setActiveRun(key, 'run-a');
    useWorkspaceStore.getState().enqueuePermissionRequest({
      requestId: 'permission-a',
      runId: 'run-a',
      sessionKey: key,
      projectPath: selectedProject.path,
      toolName: 'Write',
      toolUseId: 'tool-a',
      input: { file_path: 'probe.txt' },
      risk: 'medium',
      createdAt: 1,
    });

    useWorkspaceStore.getState().applyClaudeEvent(key, 'run-a', {
      type: 'session_failed',
      error: 'process exited unexpectedly',
      timestamp: 2,
    });

    const runtime = useWorkspaceStore.getState().runtimes[key];
    expect(runtime.toolCalls[0]).toMatchObject({
      status: 'failed',
      error: 'process exited unexpectedly',
    });
    expect(runtime.summary.status).toBe('failed');
    expect(useWorkspaceStore.getState().permissionRequests).toEqual([]);
  });

  it('returns from waiting_permission to running when permission is resolved', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const key = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-a', selectedProject.id),
    );
    useWorkspaceStore.getState().setActiveRun(key, 'run-a');
    const request: PermissionRequest = {
      requestId: 'permission-1',
      runId: 'run-a',
      sessionKey: key,
      projectPath: selectedProject.path,
      toolName: 'Write',
      toolUseId: 'tool-1',
      input: { file_path: 'test.ts' },
      risk: 'medium',
      createdAt: 1,
    };

    useWorkspaceStore.getState().enqueuePermissionRequest(request);
    expect(useWorkspaceStore.getState().runtimes[key].summary.status)
      .toBe('waiting_permission');

    useWorkspaceStore.getState().settlePermissionRequest(request.requestId);

    expect(useWorkspaceStore.getState().permissionRequests).toEqual([]);
    expect(useWorkspaceStore.getState().runtimes[key].summary.status).toBe('running');
  });

  it('isolates events from two concurrently running sessions', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const keyA = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-a', selectedProject.id),
    );
    const keyB = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-b', selectedProject.id),
    );
    useWorkspaceStore.getState().setActiveRun(keyA, 'run-a');
    useWorkspaceStore.getState().setActiveRun(keyB, 'run-b');

    useWorkspaceStore.getState().applyClaudeEvent(
      keyA,
      'run-a',
      assistantEvent('answer A', { messageId: 'assistant-a' }),
    );
    useWorkspaceStore.getState().applyClaudeEvent(
      keyB,
      'run-b',
      assistantEvent('answer B', { messageId: 'assistant-b' }),
    );
    useWorkspaceStore.getState().applyClaudeEvent(keyA, 'run-a', {
      type: 'session_completed',
      sessionId: 'claude-session-a',
      duration: 100,
      timestamp: 2,
    });

    const state = useWorkspaceStore.getState();
    expect(state.runtimes[keyA].messages.map((message) => message.content)).toEqual(['answer A']);
    expect(state.runtimes[keyB].messages.map((message) => message.content)).toEqual(['answer B']);
    expect(state.runtimes[keyA].summary.status).toBe('completed');
    expect(state.runtimes[keyB].summary.status).toBe('running');
    expect(state.runtimes[keyB].activeRunId).toBe('run-b');
  });

  it('queues concurrent permission requests without overwriting either run', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const keyA = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-a', selectedProject.id),
    );
    const keyB = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-b', selectedProject.id),
    );
    useWorkspaceStore.getState().setActiveRun(keyA, 'run-a');
    useWorkspaceStore.getState().setActiveRun(keyB, 'run-b');

    useWorkspaceStore.getState().enqueuePermissionRequest({
      requestId: 'permission-a',
      runId: 'run-a',
      sessionKey: keyA,
      projectPath: selectedProject.path,
      toolName: 'Write',
      input: { file_path: 'a.ts' },
      risk: 'medium',
      createdAt: 2,
    });
    useWorkspaceStore.getState().enqueuePermissionRequest({
      requestId: 'permission-b',
      runId: 'run-b',
      sessionKey: keyB,
      projectPath: selectedProject.path,
      toolName: 'WebSearch',
      input: { query: 'b' },
      risk: 'medium',
      createdAt: 1,
    });

    const state = useWorkspaceStore.getState();
    expect(state.permissionRequests.map((request) => request.requestId))
      .toEqual(['permission-b', 'permission-a']);
    expect(state.runtimes[keyA].summary.status).toBe('waiting_permission');
    expect(state.runtimes[keyB].summary.status).toBe('waiting_permission');
  });

  it('keeps a run waiting until all of its permission requests settle', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const key = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-a', selectedProject.id),
    );
    useWorkspaceStore.getState().setActiveRun(key, 'run-a');
    for (const requestId of ['permission-1', 'permission-2']) {
      useWorkspaceStore.getState().enqueuePermissionRequest({
        requestId,
        runId: 'run-a',
        sessionKey: key,
        projectPath: selectedProject.path,
        toolName: 'Read',
        input: { file_path: `${requestId}.ts` },
        risk: 'low',
        createdAt: requestId === 'permission-1' ? 1 : 2,
      });
    }

    useWorkspaceStore.getState().settlePermissionRequest('permission-1');
    expect(useWorkspaceStore.getState().runtimes[key].summary.status)
      .toBe('waiting_permission');

    useWorkspaceStore.getState().settlePermissionRequest('permission-2');
    expect(useWorkspaceStore.getState().runtimes[key].summary.status).toBe('running');
  });

  it('clears only the terminal run permission requests', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const keyA = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-a', selectedProject.id),
    );
    const keyB = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-b', selectedProject.id),
    );
    useWorkspaceStore.getState().setActiveRun(keyA, 'run-a');
    useWorkspaceStore.getState().setActiveRun(keyB, 'run-b');
    for (const [requestId, runId, sessionKey] of [
      ['permission-a', 'run-a', keyA],
      ['permission-b', 'run-b', keyB],
    ] as const) {
      useWorkspaceStore.getState().enqueuePermissionRequest({
        requestId,
        runId,
        sessionKey,
        projectPath: selectedProject.path,
        toolName: 'Read',
        input: {},
        risk: 'low',
        createdAt: 1,
      });
    }

    useWorkspaceStore.getState().applyClaudeEvent(keyA, 'run-a', {
      type: 'session_completed',
      sessionId: 'claude-a',
      duration: 5,
      timestamp: 3,
    });

    expect(useWorkspaceStore.getState().permissionRequests.map((request) => request.requestId))
      .toEqual(['permission-b']);
    expect(useWorkspaceStore.getState().runtimes[keyB].summary.status)
      .toBe('waiting_permission');
  });

  it('starts at most one run atomically for the same session', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const key = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-a', selectedProject.id),
    );

    expect(useWorkspaceStore.getState().tryStartRun(key, 'run-a')).toBe(true);
    expect(useWorkspaceStore.getState().tryStartRun(key, 'run-b')).toBe(false);
    expect(useWorkspaceStore.getState().runtimes[key].activeRunId).toBe('run-a');
  });

  it('merges live messages that arrive before history hydration completes', () => {
    const historical: WorkspaceMessage[] = [{
      id: 'old',
      role: 'user',
      content: 'old prompt',
      timestamp: 1,
      origin: 'workbench',
    }];
    const live: WorkspaceMessage[] = [{
      id: 'live',
      role: 'assistant',
      content: 'new answer',
      timestamp: 2,
      origin: 'live',
    }];

    expect(mergeWorkspaceMessages(historical, live).map((message) => message.id))
      .toEqual(['old', 'live']);
  });

  it('disables message-level fork when Claude history has no stable message id', () => {
    const [message] = mapHistoricalMessages([{
      role: 'assistant',
      content: 'legacy history',
    }]);

    expect(message).toMatchObject({
      id: 'history-0',
      forkable: false,
      forkReason: '该历史消息没有稳定 messageId，无法从这里分叉',
    });
  });

  it('keeps fallback history ids stable across paged transcript loads', () => {
    const messages = mapHistoricalMessages([{
      role: 'assistant',
      content: 'paged history',
    }], 200);

    expect(messages[0]).toMatchObject({
      id: 'history-200',
      timestamp: 200,
    });
  });

  it('ignores a stale overlapping transcript page after an older page was applied', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const selectedSession = session('session-a', selectedProject.id);
    const store = useWorkspaceStore.getState();
    const key = store.beginSessionSelection(selectedProject, selectedSession, 'load-a');
    store.hydrateSession(key, 'load-a', [], undefined, { offset: 100, total: 200 });

    store.prependMessages(key, [{
      id: 'oldest',
      role: 'user',
      content: 'oldest',
      timestamp: 0,
      origin: 'claude-history',
    }], { offset: 0, total: 200 });
    store.prependMessages(key, [{
      id: 'stale-overlap',
      role: 'user',
      content: 'stale',
      timestamp: 50,
      origin: 'claude-history',
    }], { offset: 50, total: 200 });

    const runtime = useWorkspaceStore.getState().runtimes[key];
    expect(runtime.messageOffset).toBe(0);
    expect(runtime.messages.map((message) => message.id)).toEqual(['oldest']);
  });

  it('records prompt, agent mode, user message, and model when a run starts', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const key = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-a', selectedProject.id),
    );

    expect(useWorkspaceStore.getState().tryStartRun(key, 'run-a', {
      prompt: 'Implement task view',
      agentMode: 'plan',
      userMessageId: 'message-a',
      model: 'opus',
      startedAt: 100,
    })).toBe(true);

    expect(useWorkspaceStore.getState().runtimes[key].tasksById['run-a']).toMatchObject({
      id: 'run-a',
      prompt: 'Implement task view',
      agentMode: 'plan',
      userMessageId: 'message-a',
      model: 'opus',
      startedAt: 100,
    });
  });

  it('stores terminal result, usage, duration, and denials on the matching task', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const key = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-a', selectedProject.id),
    );
    useWorkspaceStore.getState().setActiveRun(key, 'run-a');
    useWorkspaceStore.getState().applyClaudeEvent(key, 'run-a', {
      type: 'usage_updated', inputTokens: 12, outputTokens: 8, totalTokens: 20, timestamp: 2,
    });
    useWorkspaceStore.getState().applyClaudeEvent(key, 'run-a', {
      type: 'session_completed',
      sessionId: 'claude-a',
      duration: 90,
      result: '# Result',
      permissionDenials: [{ toolName: 'WebSearch', reason: 'disabled' }],
      timestamp: 3,
    });

    const task = useWorkspaceStore.getState().runtimes[key].tasksById['run-a'];
    expect(task).toMatchObject({
      status: 'completed',
      durationMs: 90,
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    });
    expect(task.result).toEqual({
      kind: 'completed',
      markdown: '# Result',
      permissionDenials: [{ toolName: 'WebSearch', reason: 'disabled' }],
    });
  });

  it('keeps sequential runs in task order instead of overwriting the prior task', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const key = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-a', selectedProject.id),
    );
    useWorkspaceStore.getState().setActiveRun(key, 'run-a');
    useWorkspaceStore.getState().applyClaudeEvent(key, 'run-a', {
      type: 'session_completed', sessionId: 'claude-a', duration: 1, result: 'first', timestamp: 2,
    });
    expect(useWorkspaceStore.getState().tryStartRun(key, 'run-b', { prompt: 'second' })).toBe(true);
    useWorkspaceStore.getState().applyClaudeEvent(key, 'run-b', {
      type: 'session_completed', sessionId: 'claude-a', duration: 1, result: 'second', timestamp: 4,
    });

    const runtime = useWorkspaceStore.getState().runtimes[key];
    expect(runtime.taskOrder).toEqual(['run-a', 'run-b']);
    expect(runtime.tasksById['run-a'].result).toMatchObject({ markdown: 'first' });
    expect(runtime.tasksById['run-b'].result).toMatchObject({ markdown: 'second' });
  });

  it('does not let a late old run terminal event overwrite a new active run', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const key = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-a', selectedProject.id),
    );
    useWorkspaceStore.getState().setActiveRun(key, 'run-a');
    useWorkspaceStore.getState().applyClaudeEvent(key, 'run-a', {
      type: 'session_completed', sessionId: 'claude-a', duration: 1, result: 'done', timestamp: 2,
    });
    useWorkspaceStore.getState().tryStartRun(key, 'run-b', { prompt: 'new work' });

    expect(useWorkspaceStore.getState().applyClaudeEvent(key, 'run-a', {
      type: 'session_failed', error: 'late failure', timestamp: 3,
    })).toBe(true);

    const runtime = useWorkspaceStore.getState().runtimes[key];
    expect(runtime.activeRunId).toBe('run-b');
    expect(runtime.summary.status).toBe('running');
    expect(runtime.tasksById['run-a'].status).toBe('completed');
  });

  it('keeps identical toolUseIds isolated by run id', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const key = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-a', selectedProject.id),
    );
    useWorkspaceStore.getState().setActiveRun(key, 'run-a');
    useWorkspaceStore.getState().applyClaudeEvent(key, 'run-a', {
      type: 'tool_started', toolName: 'Read', toolUseId: 'tool-1', timestamp: 1,
    });
    useWorkspaceStore.getState().applyClaudeEvent(key, 'run-a', {
      type: 'session_completed', sessionId: 'claude-a', duration: 1, timestamp: 2,
    });
    useWorkspaceStore.getState().tryStartRun(key, 'run-b');
    useWorkspaceStore.getState().applyClaudeEvent(key, 'run-b', {
      type: 'tool_started', toolName: 'Write', toolUseId: 'tool-1', timestamp: 3,
    });

    expect(useWorkspaceStore.getState().runtimes[key].toolCalls.map((tool) => tool.key))
      .toEqual(['run-a:tool-1', 'run-b:tool-1']);
  });

  it('keeps identical assistant message ids isolated by run id', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const key = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-a', selectedProject.id),
    );
    useWorkspaceStore.getState().setActiveRun(key, 'run-a');
    useWorkspaceStore.getState().applyClaudeEvent(key, 'run-a', assistantEvent('first', { messageId: 'same' }));
    useWorkspaceStore.getState().applyClaudeEvent(key, 'run-a', {
      type: 'session_completed', sessionId: 'claude-a', duration: 1, timestamp: 2,
    });
    useWorkspaceStore.getState().tryStartRun(key, 'run-b');
    useWorkspaceStore.getState().applyClaudeEvent(key, 'run-b', assistantEvent('second', { messageId: 'same' }));

    expect(useWorkspaceStore.getState().runtimes[key].messages.map((message) => [message.runId, message.content]))
      .toEqual([['run-a', 'first'], ['run-b', 'second']]);
  });

  it('records explicit startup failure on the concrete task', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const key = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-a', selectedProject.id),
    );
    useWorkspaceStore.getState().tryStartRun(key, 'run-a', { startedAt: 10 });

    expect(useWorkspaceStore.getState().finishTask(key, 'run-a', {
      status: 'failed', message: 'CLI unavailable', timestamp: 30,
    })).toBe(true);

    const runtime = useWorkspaceStore.getState().runtimes[key];
    expect(runtime.activeRunId).toBeNull();
    expect(runtime.tasksById['run-a']).toMatchObject({ status: 'failed', durationMs: 20 });
    expect(runtime.tasksById['run-a'].result).toMatchObject({ error: 'CLI unavailable' });
  });

  it('records explicit cancellation on the concrete task', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const key = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-a', selectedProject.id),
    );
    useWorkspaceStore.getState().tryStartRun(key, 'run-a', { startedAt: 10 });
    useWorkspaceStore.getState().finishTask(key, 'run-a', {
      status: 'cancelled', message: '用户停止了任务', timestamp: 40,
    });

    const task = useWorkspaceStore.getState().runtimes[key].tasksById['run-a'];
    expect(task).toMatchObject({ status: 'cancelled', durationMs: 30 });
    expect(task.result).toMatchObject({ kind: 'cancelled', reason: '用户停止了任务' });
  });

  it('projects permission wait and settlement into the matching run timeline', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const key = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-a', selectedProject.id),
    );
    useWorkspaceStore.getState().setActiveRun(key, 'run-a');
    useWorkspaceStore.getState().enqueuePermissionRequest({
      requestId: 'request-a',
      runId: 'run-a',
      sessionKey: key,
      projectPath: selectedProject.path,
      toolName: 'Write',
      toolUseId: 'tool-a',
      input: {},
      risk: 'high',
      createdAt: 10,
    });
    useWorkspaceStore.getState().settlePermissionRequest('request-a');

    expect(useWorkspaceStore.getState().runtimes[key].timeline.map((item) => item.event.type))
      .toEqual(['permission_waiting', 'permission_settled']);
  });

  it('rejects finishing an unknown or already terminal task', () => {
    const selectedProject = project('project-a', 'C:\\Projects\\Alpha');
    const key = useWorkspaceStore.getState().addSession(
      selectedProject,
      session('session-a', selectedProject.id),
    );
    expect(useWorkspaceStore.getState().finishTask(key, 'missing', {
      status: 'failed', message: 'missing',
    })).toBe(false);
    useWorkspaceStore.getState().setActiveRun(key, 'run-a');
    useWorkspaceStore.getState().finishTask(key, 'run-a', {
      status: 'cancelled', message: 'stop',
    });
    expect(useWorkspaceStore.getState().finishTask(key, 'run-a', {
      status: 'failed', message: 'late',
    })).toBe(false);
  });
});
