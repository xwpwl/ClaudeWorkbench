import crypto from 'crypto';
import type { AppDatabase } from '../database/Database';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { StartSessionOptions } from '../../shared/types/claude';
import type { SessionMetadataPatch } from '../../shared/types/session';
import type { PageRequest } from '../../shared/types/workbench';
import type { ClaudeLocalSessionAdapter } from '../claude/ClaudeLocalSessionAdapter';
import { z } from 'zod';
import type { PublicIpcRegistrar } from './public-invoke-boundary';
import { PublicIpcError } from '../../shared/types/publicIpc';

const sessionProjectIdSchema = z.string().trim().min(1).max(256);
const sessionOptionsSchema = z.object({
  systemPrompt: z.string().max(8_192).optional(),
  model: z.string().max(256).optional(),
  permissionMode: z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions']).optional(),
}).strict();
const sessionCreateSchema = z.union([
  z.tuple([sessionProjectIdSchema]),
  z.tuple([sessionProjectIdSchema, sessionOptionsSchema]),
]);

class SessionCreateError extends PublicIpcError {
  constructor(code: 'PROJECT_NOT_FOUND' | 'SESSION_CREATE_INVALID') {
    super(code);
    this.name = 'SessionCreateError';
  }
}

export function normalizeForkMessageId(messageId?: string): string | undefined {
  return messageId?.split(':').at(-1);
}

function page(request: PageRequest = {}): { limit: number; offset: number } {
  const requestedLimit = Number.isFinite(request.limit) ? Math.trunc(request.limit as number) : 100;
  const requestedOffset = Number.isFinite(request.offset) ? Math.trunc(request.offset as number) : 0;
  return {
    limit: Math.min(500, Math.max(1, requestedLimit)),
    offset: Math.max(0, requestedOffset),
  };
}

export function registerSessionIPC(
  ipcMain: PublicIpcRegistrar,
  db: AppDatabase,
  historyAdapter: ClaudeLocalSessionAdapter,
  dependencies: {
    validateExecutableModel?: (request: {
      projectId: string;
      fallbackModelId: string | null;
    }) => void | Promise<void>;
  } = {},
): void {
  ipcMain.handle(
    IPC_CHANNELS.SESSION_CREATE,
    async (_event, ...args: unknown[]) => {
      const parsed = sessionCreateSchema.safeParse(args);
      if (!parsed.success) {
        throw new SessionCreateError('SESSION_CREATE_INVALID');
      }
      const [projectId, options] = parsed.data as [string, Partial<StartSessionOptions>?];
      if (!db.getProject(projectId)) {
        throw new SessionCreateError('PROJECT_NOT_FOUND');
      }
      await dependencies.validateExecutableModel?.({
        projectId,
        fallbackModelId: options?.model?.trim() || null,
      });
      const id = crypto.randomUUID();
      const title = options?.systemPrompt?.trim().slice(0, 40) || '新任务';
      db.createSession(
        id,
        projectId,
        title,
        options?.model,
        options?.permissionMode,
      );
      return id;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SESSION_LIST,
    async (_event, projectId: string) => {
      const sessions = db.listSessions(projectId);
      return sessions.map((s) => ({
        id: s.id,
        projectId: s.project_id,
        claudeSessionId: s.claude_session_id,
        title: s.title,
        status: s.status,
        model: s.model,
        permissionMode: s.permission_mode,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        completedAt: s.completed_at,
        messageCount: s.message_count ?? db.countMessages(s.id),
        source: 'workbench' as const,
        archived: s.archived ?? false,
        tags: s.tags ?? [],
        titleSource: s.title_source ?? (s.title === 'New Task' ? 'default' : 'manual'),
        projectPath: db.getProject(s.project_id)?.path,
      }));
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SESSION_LIST_PAGE,
    (_event, projectId: string, request?: PageRequest) => {
      const options = page(request);
      const sessions = db.listSessions(projectId, options);
      return {
        items: sessions.map((s) => ({
          id: s.id,
          projectId: s.project_id,
          claudeSessionId: s.claude_session_id,
          title: s.title,
          status: s.status,
          model: s.model,
          permissionMode: s.permission_mode,
          createdAt: s.created_at,
          updatedAt: s.updated_at,
          completedAt: s.completed_at,
          messageCount: s.message_count ?? db.countMessages(s.id),
          source: 'workbench' as const,
          archived: s.archived ?? false,
          tags: s.tags ?? [],
          titleSource: s.title_source ?? (s.title === 'New Task' ? 'default' : 'manual'),
          projectPath: db.getProject(s.project_id)?.path,
        })),
        total: db.countSessions(projectId),
        ...options,
      };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SESSION_GET,
    async (_event, sessionId: string) => {
      const session = db.getSession(sessionId);
      if (!session) return null;

      const messageTotal = db.countMessages(sessionId);
      const messageOffset = Math.max(0, messageTotal - 100);
      const messages = db.listMessages(sessionId, { limit: 100, offset: messageOffset });
      const eventTotal = db.countEvents(sessionId);
      const events = db.listEvents(sessionId, {
        limit: 100,
        offset: Math.max(0, eventTotal - 100),
      });

      return {
        id: session.id,
        projectId: session.project_id,
        claudeSessionId: session.claude_session_id,
        title: session.title,
        status: session.status,
        model: session.model,
        permissionMode: session.permission_mode,
        createdAt: session.created_at,
        updatedAt: session.updated_at,
        completedAt: session.completed_at,
        messageCount: messageTotal,
        source: 'workbench' as const,
        archived: session.archived ?? false,
        tags: session.tags ?? [],
        titleSource: session.title_source ?? (session.title === 'New Task' ? 'default' : 'manual'),
        projectPath: db.getProject(session.project_id)?.path,
        messages: messages.map((m) => ({
          id: m.id,
          sessionId: m.session_id,
          role: m.role as 'user' | 'assistant',
          content: m.content,
          createdAt: m.created_at,
        })),
        events: events.map((e) => ({
          id: e.id,
          sessionId: e.session_id,
          eventType: e.event_type,
          payloadJson: e.payload_json,
          createdAt: e.created_at,
        })),
      };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SESSION_UPDATE,
    async (_event, sessionId: string, patch: SessionMetadataPatch) => {
      db.updateSessionMetadata(sessionId, patch);
      return true;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SESSION_FORK,
    async (
      _event,
      sessionId: string,
      options?: { upToMessageId?: string; title?: string },
    ) => {
      const source = db.getSession(sessionId);
      if (!source) throw new Error('Session not found');
      const id = crypto.randomUUID();
      const title = options?.title?.trim().slice(0, 80) || `${source.title}（分支）`;
      let claudeSessionId: string | null = null;

      if (source.claude_session_id) {
        const project = db.getProject(source.project_id);
        if (!project) throw new Error('Session project not found');
        const forked = await historyAdapter.forkSession(
          project.path,
          source.claude_session_id,
          {
            title,
            upToMessageId: normalizeForkMessageId(options?.upToMessageId),
          },
        );
        claudeSessionId = forked.sessionId;
      } else if (db.listMessages(sessionId).length > 0) {
        throw new Error('原会话没有可分叉的 Claude sessionId，不能伪造可继续的分支');
      }

      db.createSession(
        id,
        source.project_id,
        title,
        source.model ?? undefined,
        source.permission_mode ?? undefined,
      );
      db.updateSessionMetadata(id, {
        titleSource: 'manual',
        claudeSessionId,
      });
      db.copyMessages(sessionId, id, options?.upToMessageId);
      return { sessionId: id };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SESSION_DELETE,
    async (_event, sessionId: string) => {
      db.deleteSession(sessionId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MESSAGE_LIST,
    async (_event, sessionId: string) => {
      const messages = db.listMessages(sessionId);
      return messages.map((m) => ({
        id: m.id,
        sessionId: m.session_id,
        role: m.role as 'user' | 'assistant',
        content: m.content,
        createdAt: m.created_at,
      }));
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MESSAGE_LIST_PAGE,
    (_event, sessionId: string, request?: PageRequest) => {
      const options = page(request);
      return {
        items: db.listMessages(sessionId, options).map((m) => ({
          id: m.id,
          sessionId: m.session_id,
          role: m.role as 'user' | 'assistant',
          content: m.content,
          createdAt: m.created_at,
        })),
        total: db.countMessages(sessionId),
        ...options,
      };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MESSAGE_SAVE,
    async (
      _event,
      sessionId: string,
      role: 'user' | 'assistant',
      content: string,
      messageId?: string,
    ) => {
      const id = messageId || crypto.randomUUID();
      db.createMessage(id, sessionId, role, content);
      return id;
    },
  );
}
