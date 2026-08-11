import {
  deleteSession,
  forkSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  renameSession,
  tagSession,
} from '@anthropic-ai/claude-agent-sdk';
import type { SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  ForkOptions,
  ForkResult,
  HistoricalMessage,
  SessionSource,
  SessionSummary,
} from '../../shared/types/session';

/** Read-only/history mutations for Claude Code's own JSONL session store. */
export class ClaudeLocalSessionAdapter {
  async listSessions(projectPath: string): Promise<SessionSummary[]> {
    try {
      const sessions = await listSessions({ dir: projectPath });
      return sessions.map((session) => this.sdkSessionToSummary(session, projectPath));
    } catch (error) {
      console.error('[ClaudeLocalSessionAdapter] listSessions failed:', error);
      throw error;
    }
  }

  async getMessages(projectPath: string, sessionId: string): Promise<HistoricalMessage[]> {
    try {
      const messages = await getSessionMessages(sessionId, { dir: projectPath });
      return messages
        .filter((message) => message.type === 'user' || message.type === 'assistant')
        .map((message) => this.sdkMessageToHistorical(message));
    } catch (error) {
      console.error('[ClaudeLocalSessionAdapter] getMessages failed:', error);
      throw error;
    }
  }

  async getSessionInfo(projectPath: string, sessionId: string): Promise<SessionSummary | null> {
    try {
      const info = await getSessionInfo(sessionId, { dir: projectPath });
      return info ? this.sdkSessionToSummary(info, projectPath) : null;
    } catch (error) {
      console.error('[ClaudeLocalSessionAdapter] getSessionInfo failed:', error);
      throw error;
    }
  }

  async renameSession(projectPath: string, sessionId: string, title: string): Promise<void> {
    await renameSession(sessionId, title, { dir: projectPath });
  }

  async archiveSession(projectPath: string, sessionId: string): Promise<void> {
    await this.setArchived(projectPath, sessionId, true);
  }

  async setArchived(
    projectPath: string,
    sessionId: string,
    archived: boolean,
  ): Promise<void> {
    await tagSession(sessionId, archived ? 'archived' : null, { dir: projectPath });
  }

  async forkSession(
    projectPath: string,
    sessionId: string,
    options?: ForkOptions,
  ): Promise<ForkResult> {
    const result = await forkSession(sessionId, {
      dir: projectPath,
      upToMessageId: options?.upToMessageId,
      title: options?.title,
    });
    return { sessionId: result.sessionId };
  }

  async deleteSession(projectPath: string, sessionId: string): Promise<void> {
    await deleteSession(sessionId, { dir: projectPath });
  }

  private sdkSessionToSummary(session: SDKSessionInfo, projectPath: string): SessionSummary {
    const firstPrompt = session.firstPrompt?.trim();
    const firstPromptTitle = firstPrompt
      ? firstPrompt.length > 40
        ? `${firstPrompt.slice(0, 39)}…`
        : firstPrompt
      : '';
    const title = session.customTitle?.trim()
      || firstPromptTitle
      || session.summary?.trim()
      || '未命名任务';
    const titleSource = session.customTitle
      ? 'custom'
      : firstPrompt
        ? 'first_prompt'
        : session.summary
          ? 'summary'
          : 'default';
    const archived = session.tag === 'archived';

    return {
      id: session.sessionId,
      projectId: '',
      claudeSessionId: session.sessionId,
      title,
      titleSource,
      status: 'idle',
      model: null,
      permissionMode: null,
      createdAt: new Date(session.createdAt ?? session.lastModified).toISOString(),
      updatedAt: new Date(session.lastModified).toISOString(),
      completedAt: null,
      messageCount: 0,
      source: 'claude-code' as SessionSource,
      archived,
      tags: session.tag ? [session.tag] : [],
      summary: session.summary,
      projectPath,
      gitBranch: session.gitBranch,
    };
  }

  private sdkMessageToHistorical(message: SessionMessage): HistoricalMessage {
    let content = '';
    if (typeof message.message === 'string') {
      content = message.message;
    } else if (message.message && typeof message.message === 'object') {
      const payload = message.message as Record<string, unknown>;
      if (typeof payload.content === 'string') {
        content = payload.content;
      } else if (Array.isArray(payload.content)) {
        content = payload.content
          .filter(
            (block): block is Record<string, unknown> =>
              Boolean(block) && typeof block === 'object' && (block as Record<string, unknown>).type === 'text',
          )
          .map((block) => (typeof block.text === 'string' ? block.text : ''))
          .filter(Boolean)
          .join('\n');
      }
    }
    return {
      role: message.type as 'user' | 'assistant',
      content,
      uuid: message.uuid,
    };
  }
}
