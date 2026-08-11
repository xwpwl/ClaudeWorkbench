import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SDK functions
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  listSessions: vi.fn(),
  getSessionMessages: vi.fn(),
  getSessionInfo: vi.fn(),
  renameSession: vi.fn(),
  tagSession: vi.fn(),
  forkSession: vi.fn(),
  deleteSession: vi.fn(),
}));

import { ClaudeLocalSessionAdapter } from '../ClaudeLocalSessionAdapter';
import {
  listSessions,
  getSessionMessages,
  getSessionInfo,
  renameSession,
  tagSession,
  forkSession,
  deleteSession,
} from '@anthropic-ai/claude-agent-sdk';

describe('ClaudeLocalSessionAdapter', () => {
  let adapter: ClaudeLocalSessionAdapter;

  beforeEach(() => {
    adapter = new ClaudeLocalSessionAdapter();
    vi.clearAllMocks();
  });

  it('should list sessions and convert to SessionSummary format', async () => {
    vi.mocked(listSessions).mockResolvedValue([
      {
        sessionId: 'sess-1',
        summary: 'Test session',
        lastModified: Date.now(),
        customTitle: 'My Title',
        firstPrompt: 'Hello world',
        gitBranch: 'main',
        cwd: '/test',
        createdAt: Date.now() - 10000,
      },
      {
        sessionId: 'sess-2',
        summary: 'Another session',
        lastModified: Date.now() - 5000,
        firstPrompt: 'Do something',
        cwd: '/test',
      },
    ]);

    const sessions = await adapter.listSessions('/test/project');

    expect(listSessions).toHaveBeenCalledWith({ dir: '/test/project' });
    expect(sessions).toHaveLength(2);
    expect(sessions[0].title).toBe('My Title');
    expect(sessions[0].source).toBe('claude-code');
    expect(sessions[0].claudeSessionId).toBe('sess-1');
    expect(sessions[0].gitBranch).toBe('main');
    expect(sessions[1].title).toBe('Do something');
  });

  it('should truncate long first prompts for title', async () => {
    vi.mocked(listSessions).mockResolvedValue([
      {
        sessionId: 'sess-1',
        summary: '',
        lastModified: Date.now(),
        firstPrompt: 'This is a very long prompt that should be truncated because it exceeds forty characters',
        cwd: '/test',
      },
    ]);

    const sessions = await adapter.listSessions('/test');
    expect(sessions[0].title).toContain('…');
    expect(sessions[0].title.length).toBeLessThan(60);
  });

  it('should use default title when no summary or prompt', async () => {
    vi.mocked(listSessions).mockResolvedValue([
      {
        sessionId: 'sess-1',
        summary: '',
        lastModified: Date.now(),
        cwd: '/test',
      },
    ]);

    const sessions = await adapter.listSessions('/test');
    expect(sessions[0].title).toBe('未命名任务');
  });

  it('should detect archived sessions from tag', async () => {
    vi.mocked(listSessions).mockResolvedValue([
      {
        sessionId: 'sess-1',
        summary: 'Archived session',
        lastModified: Date.now(),
        tag: 'archived',
        cwd: '/test',
      },
    ]);

    const sessions = await adapter.listSessions('/test');
    expect(sessions[0].archived).toBe(true);
    expect(sessions[0].tags).toContain('archived');
  });

  it('should get session messages and extract text content', async () => {
    vi.mocked(getSessionMessages).mockResolvedValue([
      {
        type: 'user',
        uuid: 'u1',
        session_id: 'sess-1',
        message: { role: 'user', content: 'Hello' },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
      {
        type: 'assistant',
        uuid: 'a1',
        session_id: 'sess-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
    ]);

    const messages = await adapter.getMessages('/test', 'sess-1');

    expect(getSessionMessages).toHaveBeenCalledWith('sess-1', { dir: '/test' });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Hello');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toBe('Hi there!');
  });

  it('should filter out system messages', async () => {
    vi.mocked(getSessionMessages).mockResolvedValue([
      {
        type: 'user',
        uuid: 'u1',
        session_id: 'sess-1',
        message: 'Hello',
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
      {
        type: 'system',
        uuid: 's1',
        session_id: 'sess-1',
        message: 'system info',
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
    ]);

    const messages = await adapter.getMessages('/test', 'sess-1');
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
  });

  it('should handle empty session messages gracefully', async () => {
    vi.mocked(getSessionMessages).mockResolvedValue([]);

    const messages = await adapter.getMessages('/test', 'nonexistent');
    expect(messages).toHaveLength(0);
  });

  it('should rename session via SDK', async () => {
    vi.mocked(renameSession).mockResolvedValue();

    await adapter.renameSession('/test', 'sess-1', 'New Title');

    expect(renameSession).toHaveBeenCalledWith('sess-1', 'New Title', { dir: '/test' });
  });

  it('should archive session via tagSession', async () => {
    vi.mocked(tagSession).mockResolvedValue();

    await adapter.archiveSession('/test', 'sess-1');

    expect(tagSession).toHaveBeenCalledWith('sess-1', 'archived', { dir: '/test' });
  });

  it('should fork session with options', async () => {
    vi.mocked(forkSession).mockResolvedValue({ sessionId: 'forked-1' });

    const result = await adapter.forkSession('/test', 'sess-1', {
      upToMessageId: 'msg-5',
      title: 'My Fork',
    });

    expect(forkSession).toHaveBeenCalledWith('sess-1', {
      dir: '/test',
      upToMessageId: 'msg-5',
      title: 'My Fork',
    });
    expect(result.sessionId).toBe('forked-1');
  });

  it('should delete session via SDK', async () => {
    vi.mocked(deleteSession).mockResolvedValue();

    await adapter.deleteSession('/test', 'sess-1');

    expect(deleteSession).toHaveBeenCalledWith('sess-1', { dir: '/test' });
  });

  it('should get session info', async () => {
    vi.mocked(getSessionInfo).mockResolvedValue({
      sessionId: 'sess-1',
      summary: 'Test',
      lastModified: Date.now(),
      cwd: '/test',
    });

    const info = await adapter.getSessionInfo('/test', 'sess-1');

    expect(getSessionInfo).toHaveBeenCalledWith('sess-1', { dir: '/test' });
    expect(info).not.toBeNull();
    expect(info?.id).toBe('sess-1');
  });

  it('should return null for nonexistent session info', async () => {
    vi.mocked(getSessionInfo).mockResolvedValue(undefined);

    const info = await adapter.getSessionInfo('/test', 'nonexistent');
    expect(info).toBeNull();
  });

  it('should propagate SDK errors in listSessions', async () => {
    vi.mocked(listSessions).mockRejectedValue(new Error('SDK error'));

    await expect(adapter.listSessions('/test')).rejects.toThrow('SDK error');
  });

  it('should propagate SDK errors in getMessages', async () => {
    vi.mocked(getSessionMessages).mockRejectedValue(new Error('SDK error'));

    await expect(adapter.getMessages('/test', 'sess-1')).rejects.toThrow('SDK error');
  });
});
