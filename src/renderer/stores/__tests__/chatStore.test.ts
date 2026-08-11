import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../chatStore';

describe('chatStore', () => {
  beforeEach(() => {
    useChatStore.getState().clearMessages();
    useChatStore.getState().setSessionStatus('idle');
    useChatStore.getState().setStreamingText('');
  });

  describe('streaming text aggregation', () => {
    it('should append streaming text', () => {
      useChatStore.getState().appendStreamingText('Hello ');
      useChatStore.getState().appendStreamingText('world');

      expect(useChatStore.getState().streamingText).toBe('Hello world');
    });

    it('should not duplicate exact same chunk', () => {
      useChatStore.getState().appendStreamingText('Hello world');
      useChatStore.getState().appendStreamingText('Hello world');

      // Should not duplicate because exact same text was just appended
      expect(useChatStore.getState().streamingText).toBe('Hello world');
    });

    it('should commit streaming message', () => {
      useChatStore.getState().appendStreamingText('Hello world');
      useChatStore.getState().commitStreamingMessage();

      expect(useChatStore.getState().streamingText).toBe('');
      expect(useChatStore.getState().messages).toHaveLength(1);
      expect(useChatStore.getState().messages[0].role).toBe('assistant');
      expect(useChatStore.getState().messages[0].content).toBe('Hello world');
    });

    it('should not commit empty streaming text', () => {
      useChatStore.getState().commitStreamingMessage();

      expect(useChatStore.getState().messages).toHaveLength(0);
    });

    it('should handle Chinese text aggregation', () => {
      useChatStore.getState().appendStreamingText('你好');
      useChatStore.getState().appendStreamingText('世界');

      expect(useChatStore.getState().streamingText).toBe('你好世界');
    });

    it('should handle markdown code block aggregation', () => {
      useChatStore.getState().appendStreamingText('```typescript\n');
      useChatStore.getState().appendStreamingText('const x = 1;\n');
      useChatStore.getState().appendStreamingText('```');

      expect(useChatStore.getState().streamingText).toBe('```typescript\nconst x = 1;\n```');
    });
  });

  describe('event filtering', () => {
    it('should filter system_init events from work timeline', () => {
      useChatStore.getState().addEvent({
        type: 'system_init',
        sessionId: 'sess-1',
        model: 'test',
        timestamp: Date.now(),
      });

      expect(useChatStore.getState().events).toHaveLength(0);
    });

    it('should filter session_started events from work timeline', () => {
      useChatStore.getState().addEvent({
        type: 'session_started',
        sessionId: 'sess-1',
        timestamp: Date.now(),
      });

      expect(useChatStore.getState().events).toHaveLength(0);
    });

    it('should filter thinking_content events from work timeline', () => {
      useChatStore.getState().addEvent({
        type: 'thinking_content',
        text: 'internal reasoning',
        timestamp: Date.now(),
      });

      expect(useChatStore.getState().events).toHaveLength(0);
    });

    it('should filter stderr events from work timeline', () => {
      useChatStore.getState().addEvent({
        type: 'stderr',
        text: 'warning message',
        level: 'warning',
        timestamp: Date.now(),
      });

      expect(useChatStore.getState().events).toHaveLength(0);
    });

    it('should keep tool events in work timeline', () => {
      useChatStore.getState().addEvent({
        type: 'tool_started',
        toolName: 'Read',
        toolUseId: 'tool-1',
        timestamp: Date.now(),
      });

      expect(useChatStore.getState().events).toHaveLength(1);
    });

    it('should keep file events in work timeline', () => {
      useChatStore.getState().addEvent({
        type: 'file_read',
        filePath: 'test.ts',
        toolUseId: 'tool-1',
        timestamp: Date.now(),
      });

      expect(useChatStore.getState().events).toHaveLength(1);
    });
  });

  describe('stderr collection', () => {
    it('should collect stderr messages', () => {
      useChatStore.getState().addStderr('warning text', 'warning');
      useChatStore.getState().addStderr('error text', 'error');

      expect(useChatStore.getState().stderrMessages).toHaveLength(2);
      expect(useChatStore.getState().stderrMessages[0].level).toBe('warning');
      expect(useChatStore.getState().stderrMessages[1].level).toBe('error');
    });

    it('should clear stderr messages', () => {
      useChatStore.getState().addStderr('test', 'info');
      useChatStore.getState().clearStderr();

      expect(useChatStore.getState().stderrMessages).toHaveLength(0);
    });
  });

  describe('state machine', () => {
    it('should set session status', () => {
      useChatStore.getState().setSessionStatus('running');
      expect(useChatStore.getState().sessionStatus).toBe('running');

      useChatStore.getState().setSessionStatus('completed');
      expect(useChatStore.getState().sessionStatus).toBe('completed');
    });

    it('should support loading_history status', () => {
      useChatStore.getState().setSessionStatus('loading_history');
      expect(useChatStore.getState().sessionStatus).toBe('loading_history');
    });

    it('should track usage', () => {
      useChatStore.getState().setUsage({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      });

      expect(useChatStore.getState().usage?.totalTokens).toBe(150);
    });
  });

  describe('message management', () => {
    it('should add user messages', () => {
      useChatStore.getState().addUserMessage('Hello');

      expect(useChatStore.getState().messages).toHaveLength(1);
      expect(useChatStore.getState().messages[0].role).toBe('user');
      expect(useChatStore.getState().messages[0].content).toBe('Hello');
    });

    it('should add assistant messages', () => {
      useChatStore.getState().addAssistantMessage('Hi there');

      expect(useChatStore.getState().messages).toHaveLength(1);
      expect(useChatStore.getState().messages[0].role).toBe('assistant');
      expect(useChatStore.getState().messages[0].content).toBe('Hi there');
    });

    it('should clear all messages and state', () => {
      useChatStore.getState().addUserMessage('Hello');
      useChatStore.getState().appendStreamingText('streaming');
      useChatStore.getState().addStderr('test', 'info');
      useChatStore.getState().clearMessages();

      expect(useChatStore.getState().messages).toHaveLength(0);
      expect(useChatStore.getState().streamingText).toBe('');
      expect(useChatStore.getState().stderrMessages).toHaveLength(0);
    });
  });

  describe('view tabs', () => {
    it('should switch between conversation and work tabs', () => {
      expect(useChatStore.getState().activeTab).toBe('conversation');

      useChatStore.getState().setActiveTab('work');
      expect(useChatStore.getState().activeTab).toBe('work');

      useChatStore.getState().setActiveTab('conversation');
      expect(useChatStore.getState().activeTab).toBe('conversation');
    });
  });
});
