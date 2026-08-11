import { useCallback } from 'react';
import { useAppStore } from '../stores/appStore';
import {
  mapHistoricalMessages,
  mergeProjectSessions,
  useWorkspaceStore,
  type WorkspaceMessage,
} from '../stores/workspaceStore';
import type { Project } from '../../shared/types/project';
import type { ForkOptions, Message, SessionSummary } from '../../shared/types/session';
import { sessionKeyOf } from '../../shared/sessionIdentity';
import { hydratePersistedTasks } from '../../shared/taskPersistence';
import type { UIPermissionMode } from '../../shared/types/claude';

function requestId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

const messagePageLoads = new Set<string>();

export function shouldSelectCreatedSession(
  currentProjectId: string | undefined,
  activeProjectRequestId: string | null,
  targetProjectId: string,
  capturedProjectRequestId: string | null,
): boolean {
  return currentProjectId === targetProjectId
    && activeProjectRequestId === capturedProjectRequestId;
}

function newSessionSummary(project: Project, id: string): SessionSummary {
  const now = new Date().toISOString();
  return {
    id,
    projectId: project.id,
    projectPath: project.path,
    claudeSessionId: null,
    title: '新任务',
    titleSource: 'default',
    status: 'idle',
    model: null,
    permissionMode: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    messageCount: 0,
    source: 'workbench',
    archived: false,
    tags: [],
  };
}

function detailMessages(
  detail: Awaited<ReturnType<typeof window.api.getSession>>,
): WorkspaceMessage[] {
  return storedMessages(detail?.messages ?? []);
}

function storedMessages(messages: Message[]): WorkspaceMessage[] {
  return messages.map((message) => {
    const protocolMessageId = message.id.split(':').at(-1) ?? message.id;
    const forkable = message.role === 'assistant' && protocolMessageId.startsWith('msg_');
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: new Date(message.createdAt).getTime(),
      origin: 'workbench' as const,
      forkable,
      forkMessageId: forkable ? protocolMessageId : undefined,
      forkReason: forkable
        ? undefined
        : message.role === 'user'
          ? 'Workbench 用户消息 ID 与 Claude transcript messageId 不同，请从后续 Claude 回复分叉'
          : '该消息没有可供 Claude SDK 分叉的稳定 messageId',
    };
  });
}

export function useWorkspaceController() {
  const selectSession = useCallback(async (project: Project, session: SessionSummary) => {
    const id = requestId('session-load');
    const store = useWorkspaceStore.getState();
    const key = store.beginSessionSelection(project, session, id);
    if (useWorkspaceStore.getState().runtimes[key]?.hydrated) return;
    try {
      if (session.source === 'claude-code') {
        const result = await window.api.getHistoryMessagePage(
          session.projectPath || project.path,
          session.id,
          { limit: 100 },
        );
        const messages = mapHistoricalMessages(result.items, result.offset);
        useWorkspaceStore.getState().hydrateSession(
          key,
          id,
          messages,
          undefined,
          { offset: result.offset, total: result.total },
        );
      } else {
        const [detail, firstSnapshot] = await Promise.all([
          window.api.getSession(session.id),
          window.api.getTaskSnapshot(session.id, { limit: 500, offset: 0 }),
        ]);
        const snapshot = firstSnapshot && firstSnapshot.eventTotal > firstSnapshot.events.length
          ? await window.api.getTaskSnapshot(session.id, {
            limit: 500,
            offset: Math.max(0, firstSnapshot.eventTotal - 500),
          })
          : firstSnapshot;
        const messages = detailMessages(detail);
        const total = detail?.messageCount ?? messages.length;
        useWorkspaceStore.getState().hydrateSession(
          key,
          id,
          messages,
          snapshot ? hydratePersistedTasks(snapshot) : undefined,
          { offset: Math.max(0, total - messages.length), total },
          snapshot
            ? {
              offset: snapshot.eventOffset ?? Math.max(0, snapshot.eventTotal - snapshot.events.length),
              total: snapshot.eventTotal,
            }
            : undefined,
        );
      }
    } catch (error) {
      useWorkspaceStore.getState().failSessionLoad(
        key,
        id,
        error instanceof Error ? error.message : '读取会话失败',
      );
    }
  }, []);

  const createTask = useCallback(async (project?: Project) => {
    const target = project || useWorkspaceStore.getState().currentProject;
    if (!target) return null;
    const selectionRequestId = useWorkspaceStore.getState().projectRequestId;
    const id = await window.api.createSession(target.id);
    const summary = newSessionSummary(target, id);
    const current = useWorkspaceStore.getState();
    const select = shouldSelectCreatedSession(
      current.currentProject?.id,
      current.projectRequestId,
      target.id,
      selectionRequestId,
    );
    current.addSession(target, summary, select);
    return summary;
  }, []);

  const loadOlderMessages = useCallback(async () => {
    const state = useWorkspaceStore.getState();
    const key = state.currentSessionKey;
    const runtime = key ? state.runtimes[key] : undefined;
    if (!key || !runtime || runtime.messageOffset <= 0 || messagePageLoads.has(key)) {
      return false;
    }
    messagePageLoads.add(key);
    try {
      const limit = Math.min(100, runtime.messageOffset);
      const offset = Math.max(0, runtime.messageOffset - limit);
      if (runtime.summary.source === 'claude-code') {
        const result = await window.api.getHistoryMessagePage(
          runtime.summary.projectPath || runtime.projectPath,
          runtime.summary.id,
          { limit, offset },
        );
        useWorkspaceStore.getState().prependMessages(
          key,
          mapHistoricalMessages(result.items, result.offset),
          { offset: result.offset, total: result.total },
        );
        return true;
      }
      const result = await window.api.listMessagePage(runtime.summary.id, { limit, offset });
      useWorkspaceStore.getState().prependMessages(
        key,
        storedMessages(result.items),
        { offset: result.offset, total: result.total },
      );
      return true;
    } catch (error) {
      useWorkspaceStore.getState().setSessionError(
        key,
        error instanceof Error ? error.message : '读取更早消息失败',
      );
      return false;
    } finally {
      messagePageLoads.delete(key);
    }
  }, []);

  const loadOlderTaskEvents = useCallback(async () => {
    const state = useWorkspaceStore.getState();
    const key = state.currentSessionKey;
    const runtime = key ? state.runtimes[key] : undefined;
    if (!key || !runtime || runtime.summary.source !== 'workbench' || runtime.taskEventOffset <= 0) {
      return false;
    }
    const limit = Math.min(500, runtime.taskEventOffset);
    const offset = Math.max(0, runtime.taskEventOffset - limit);
    const snapshot = await window.api.getTaskSnapshot(runtime.summary.id, { limit, offset });
    if (!snapshot) return false;
    useWorkspaceStore.getState().prependTaskState(
      key,
      hydratePersistedTasks(snapshot),
      { offset, total: snapshot.eventTotal },
    );
    return true;
  }, []);

  const selectProject = useCallback(async (
    project: Project,
    preferredSessionId?: string,
  ) => {
    const id = requestId('project-load');
    useAppStore.getState().setCurrentProject(project);
    const store = useWorkspaceStore.getState();
    store.upsertProject(project);
    store.beginProjectSelection(project, id);
    try {
      const [workbench, history, projectSettings, appSettings] = await Promise.all([
        window.api.listSessions(project.id),
        window.api.listHistorySessions(project.path),
        window.api.getProjectSettings(project.id),
        window.api.getSettings(),
      ]);
      const merged = mergeProjectSessions(project, workbench, history);
      const committed = useWorkspaceStore
        .getState()
        .commitProjectSessions(project, id, merged);
      if (!committed) return;
      const app = useAppStore.getState();
      app.setCurrentProjectSettings(projectSettings);
      app.setAgentMode(projectSettings.agentMode);
      app.setCurrentModel(projectSettings.defaultModel ?? appSettings.defaultModel ?? '');
      if (
        projectSettings.defaultPermission
        && ['standard', 'accept-edits', 'plan', 'bypass'].includes(projectSettings.defaultPermission)
      ) {
        app.setPermissionMode(projectSettings.defaultPermission as UIPermissionMode);
      } else {
        app.setPermissionMode(appSettings.defaultPermissionMode);
      }
      if (merged.length === 0) {
        await createTask(project);
        return;
      }
      const selected = merged.find((session) => session.id === preferredSessionId)
        || merged.find((session) => !session.archived)
        || merged[0];
      await selectSession(project, selected);
    } catch (error) {
      useWorkspaceStore.getState().failProjectSelection(
        project,
        id,
        error instanceof Error ? error.message : '读取项目会话失败',
      );
    }
  }, [createTask, selectSession]);

  const loadProjects = useCallback(async (autoSelect = true) => {
    const projects = await window.api.listProjects();
    useWorkspaceStore.getState().setProjects(projects);
    if (autoSelect && projects.length > 0 && !useWorkspaceStore.getState().currentProject) {
      await selectProject(projects[0]);
    }
    return projects;
  }, [selectProject]);

  const openProject = useCallback(async () => {
    const project = await window.api.openProject();
    if (!project) return null;
    useWorkspaceStore.getState().upsertProject(project);
    await selectProject(project);
    return project;
  }, [selectProject]);

  const renameSession = useCallback(async (session: SessionSummary, title: string) => {
    const project = useWorkspaceStore.getState().currentProject;
    if (!project) return;
    const value = title.trim().slice(0, 80);
    if (!value) return;
    if (session.source === 'claude-code') {
      await window.api.renameHistorySession(
        session.projectPath || project.path,
        session.id,
        value,
      );
    } else {
      await window.api.updateSession(session.id, { title: value, titleSource: 'manual' });
    }
    const key = sessionKeyOf(project.path, session);
    useWorkspaceStore.getState().updateSessionSummary(key, {
      title: value,
      titleSource: 'manual',
    });
  }, []);

  const setArchived = useCallback(async (session: SessionSummary, archived: boolean) => {
    const project = useWorkspaceStore.getState().currentProject;
    if (!project) return;
    if (session.source === 'claude-code') {
      await window.api.setHistorySessionArchived(
        session.projectPath || project.path,
        session.id,
        archived,
      );
    } else {
      await window.api.updateSession(session.id, { archived });
    }
    await selectProject(project, archived ? undefined : session.id);
  }, [selectProject]);

  const setFavorite = useCallback(async (session: SessionSummary, favorite: boolean) => {
    const project = useWorkspaceStore.getState().currentProject;
    if (!project || session.source !== 'workbench') return;
    const tags = favorite
      ? [...new Set([...session.tags, 'favorite'])]
      : session.tags.filter((tag) => tag !== 'favorite');
    await window.api.updateSession(session.id, { tags });
    useWorkspaceStore.getState().updateSessionSummary(
      sessionKeyOf(project.path, session),
      { tags },
    );
  }, []);

  const fork = useCallback(async (session: SessionSummary, options?: ForkOptions) => {
    const project = useWorkspaceStore.getState().currentProject;
    if (!project) return null;
    const result = session.source === 'claude-code'
      ? await window.api.forkHistorySession(
        session.projectPath || project.path,
        session.id,
        options,
      )
      : await window.api.forkSession(session.id, options);
    await selectProject(project, result.sessionId);
    return result;
  }, [selectProject]);

  return {
    loadProjects,
    openProject,
    selectProject,
    selectSession,
    createTask,
    loadOlderMessages,
    loadOlderTaskEvents,
    renameSession,
    setArchived,
    setFavorite,
    fork,
  };
}
