import { describe, it, expect } from 'vitest';
import { ClaudeEventParser } from '../ClaudeEventParser';
import type { ClaudeEvent } from '../../../shared/types/claude';

function appendJson(parser: ClaudeEventParser, value: unknown, newline = true): void {
  parser.append(JSON.stringify(value) + (newline ? '\n' : ''));
}

function eventsOfType<T extends ClaudeEvent['type']>(
  events: ClaudeEvent[],
  type: T,
): Array<Extract<ClaudeEvent, { type: T }>> {
  return events.filter((event) => event.type === type) as Array<Extract<ClaudeEvent, { type: T }>>;
}

describe('ClaudeEventParser', () => {
  it('should parse a real assistant message', () => {
    const parser = new ClaudeEventParser();
    const events: ClaudeEvent[] = [];
    parser.on('event', (e) => events.push(e));

    parser.append(
      '{"type":"assistant","message":{"id":"msg_1","type":"message","role":"assistant","model":"test","content":[{"type":"text","text":"Hello world"}],"usage":{"input_tokens":100,"output_tokens":10}},"session_id":"sess_1"}\n',
    );

    expect(events.length).toBeGreaterThanOrEqual(1);
    const textEvents = events.filter((e) => e.type === 'assistant_text');
    expect(textEvents.length).toBeGreaterThanOrEqual(1);
    expect((textEvents[0] as { text: string }).text).toBe('Hello world');
  });

  it('should parse multiple lines in one chunk', () => {
    const parser = new ClaudeEventParser();
    const events: ClaudeEvent[] = [];
    parser.on('event', (e) => events.push(e));

    parser.append(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Line 1"}]}}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Line 2"}]}}\n',
    );

    const textEvents = events.filter((e) => e.type === 'assistant_text');
    expect(textEvents.length).toBeGreaterThanOrEqual(2);
  });

  it('should handle JSON split across chunks', () => {
    const parser = new ClaudeEventParser();
    const events: ClaudeEvent[] = [];
    parser.on('event', (e) => events.push(e));

    parser.append('{"type":"assistant","message":{"content":[{"type":"tex');
    expect(events).toHaveLength(0);

    parser.append('t","text":"Hello"}]}}\n');
    const textEvents = events.filter((e) => e.type === 'assistant_text');
    expect(textEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('should handle non-JSON output as stderr', () => {
    const parser = new ClaudeEventParser();
    const events: ClaudeEvent[] = [];
    parser.on('event', (e) => events.push(e));

    parser.append('This is not JSON\n');

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('stderr');
    expect((events[0] as { text: string }).text).toBe('This is not JSON');
  });

  it('should handle empty lines', () => {
    const parser = new ClaudeEventParser();
    const events: ClaudeEvent[] = [];
    parser.on('event', (e) => events.push(e));

    parser.append(
      '\n\n\n{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}\n\n\n',
    );

    const textEvents = events.filter((e) => e.type === 'assistant_text');
    expect(textEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('should parse tool_use in assistant message', () => {
    const parser = new ClaudeEventParser();
    const events: ClaudeEvent[] = [];
    parser.on('event', (e) => events.push(e));

    parser.append(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool_1","name":"Read","input":{"file_path":"test.ts"}}]}}\n',
    );

    const toolEvents = events.filter((e) => e.type === 'tool_started');
    expect(toolEvents.length).toBeGreaterThanOrEqual(1);
    expect((toolEvents[0] as { toolName: string }).toolName).toBe('Read');
  });

  it('should parse result event as session_completed', () => {
    const parser = new ClaudeEventParser();
    const events: ClaudeEvent[] = [];
    parser.on('event', (e) => events.push(e));

    parser.append(
      '{"type":"result","is_error":false,"session_id":"sess_1","result":"Done","usage":{"input_tokens":100,"output_tokens":50},"duration_ms":5000}\n',
    );

    const completedEvents = events.filter((e) => e.type === 'session_completed');
    expect(completedEvents.length).toBeGreaterThanOrEqual(1);

    const usageEvents = events.filter((e) => e.type === 'usage_updated');
    expect(usageEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('should parse error result as session_failed', () => {
    const parser = new ClaudeEventParser();
    const events: ClaudeEvent[] = [];
    parser.on('event', (e) => events.push(e));

    parser.append(
      '{"type":"result","is_error":true,"result":"Something went wrong"}\n',
    );

    const failedEvents = events.filter((e) => e.type === 'session_failed');
    expect(failedEvents.length).toBeGreaterThanOrEqual(1);
    expect((failedEvents[0] as { error: string }).error).toBe('Something went wrong');
  });

  it('should parse system init event', () => {
    const parser = new ClaudeEventParser();
    const events: ClaudeEvent[] = [];
    parser.on('event', (e) => events.push(e));

    parser.append(
      '{"type":"system","subtype":"init","session_id":"sess_1","cwd":"/test"}\n',
    );

    const initEvents = events.filter((e) => e.type === 'system_init');
    expect(initEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('should silently consume unknown event types', () => {
    const parser = new ClaudeEventParser();
    const events: ClaudeEvent[] = [];
    parser.on('event', (e) => events.push(e));

    parser.append('{"type":"unknown_type","data":"test"}\n');

    expect(events).toHaveLength(0);
  });

  it('should flush remaining buffer', () => {
    const parser = new ClaudeEventParser();
    const events: ClaudeEvent[] = [];
    parser.on('event', (e) => events.push(e));

    parser.append('{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}');
    expect(events).toHaveLength(0);

    parser.flush();
    const textEvents = events.filter((e) => e.type === 'assistant_text');
    expect(textEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('should handle Chinese text correctly', () => {
    const parser = new ClaudeEventParser();
    const events: ClaudeEvent[] = [];
    parser.on('event', (e) => events.push(e));

    parser.append(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"你好世界"}]}}\n',
    );

    const textEvents = events.filter((e) => e.type === 'assistant_text');
    expect(textEvents.length).toBeGreaterThanOrEqual(1);
    expect((textEvents[0] as { text: string }).text).toBe('你好世界');
  });

  it('should handle mixed JSON and non-JSON lines', () => {
    const parser = new ClaudeEventParser();
    const events: ClaudeEvent[] = [];
    parser.on('event', (e) => events.push(e));

    parser.append(
      'Warning: some debug output\n{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}\nMore debug\n',
    );

    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events[0].type).toBe('stderr');
    expect((events[0] as { text: string }).text).toBe('Warning: some debug output');
  });

  it('should parse tool_use with Bash command', () => {
    const parser = new ClaudeEventParser();
    const events: ClaudeEvent[] = [];
    parser.on('event', (e) => events.push(e));

    parser.append(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool_1","name":"Bash","input":{"command":"npm test"}}]}}\n',
    );

    const toolEvents = events.filter((e) => e.type === 'tool_started');
    const commandEvents = events.filter((e) => e.type === 'command_started');
    expect(toolEvents.length).toBeGreaterThanOrEqual(1);
    expect(commandEvents.length).toBeGreaterThanOrEqual(1);
    expect((commandEvents[0] as { command: string }).command).toBe('npm test');
  });

  it('should parse tool_use with Read file', () => {
    const parser = new ClaudeEventParser();
    const events: ClaudeEvent[] = [];
    parser.on('event', (e) => events.push(e));

    parser.append(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool_1","name":"Read","input":{"file_path":"src/index.ts"}}]}}\n',
    );

    const fileEvents = events.filter((e) => e.type === 'file_read');
    expect(fileEvents.length).toBeGreaterThanOrEqual(1);
    expect((fileEvents[0] as { filePath: string }).filePath).toBe('src/index.ts');
  });

  describe('assistant snapshot identity and replacement semantics', () => {
    it('preserves message id, block index, and snapshot metadata', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'assistant',
        message: {
          id: 'msg-snapshot',
          content: [
            { type: 'thinking', thinking: 'private' },
            { type: 'text', text: 'Visible answer' },
          ],
        },
      });

      expect(eventsOfType(events, 'assistant_text')).toEqual([
        expect.objectContaining({
          text: 'Visible answer',
          messageId: 'msg-snapshot',
          blockIndex: 1,
          isSnapshot: true,
        }),
      ]);
    });

    it('uses message uuid when message id is absent', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'assistant',
        message: { uuid: 'message-uuid', content: [{ type: 'text', text: 'Hello' }] },
      });

      expect(eventsOfType(events, 'assistant_text')[0].messageId).toBe('message-uuid');
    });

    it('uses top-level uuid when message identity is absent', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'assistant',
        uuid: 'envelope-uuid',
        message: { content: [{ type: 'text', text: 'Hello' }] },
      });

      expect(eventsOfType(events, 'assistant_text')[0].messageId).toBe('envelope-uuid');
    });

    it('emits a growing snapshot as a full replacement, not an appended suffix', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'assistant',
        message: { id: 'msg-grow', content: [{ type: 'text', text: 'Hel' }] },
      });
      appendJson(parser, {
        type: 'assistant',
        message: { id: 'msg-grow', content: [{ type: 'text', text: 'Hello' }] },
      });

      const textEvents = eventsOfType(events, 'assistant_text');
      expect(textEvents.map((event) => event.text)).toEqual(['Hel', 'Hello']);
      expect(textEvents.every((event) => event.isSnapshot === true)).toBe(true);
      expect(textEvents.every((event) => event.messageId === 'msg-grow')).toBe(true);
    });

    it('suppresses an identical repeated snapshot', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));
      const snapshot = {
        type: 'assistant',
        message: { id: 'msg-repeat', content: [{ type: 'text', text: 'Same' }] },
      };

      appendJson(parser, snapshot);
      appendJson(parser, snapshot);

      expect(eventsOfType(events, 'assistant_text')).toHaveLength(1);
    });

    it('keeps independent text blocks under the same message identity', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'assistant',
        message: {
          id: 'msg-blocks',
          content: [{ type: 'text', text: 'First' }, { type: 'text', text: 'Second' }],
        },
      });

      expect(eventsOfType(events, 'assistant_text').map((event) => event.blockIndex)).toEqual([0, 1]);
    });
  });

  describe('tool lifecycle normalization', () => {
    it.each([
      ['WebSearch', { query: 'Claude Code permissions' }],
      ['WebFetch', { url: 'https://example.com' }],
      ['Bash', { command: 'npm test' }],
      ['Read', { file_path: 'README.md' }],
      ['Edit', { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' }],
      ['Write', { file_path: 'src/new.ts', content: 'export {}' }],
    ])('preserves %s tool input on tool_started', (toolName, input) => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'assistant',
        message: {
          id: `msg-${toolName}`,
          content: [{ type: 'tool_use', id: `tool-${toolName}`, name: toolName, input }],
        },
      });

      expect(eventsOfType(events, 'tool_started')[0]).toMatchObject({
        toolName,
        toolUseId: `tool-${toolName}`,
        input,
      });
    });

    it('correlates a top-level user tool_result success with its tool name', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'assistant',
        message: {
          id: 'msg-tools',
          content: [{ type: 'tool_use', id: 'tool-web', name: 'WebFetch', input: { url: 'https://example.com' } }],
        },
      });
      appendJson(parser, {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tool-web', content: 'Fetched' }],
        },
      });

      expect(eventsOfType(events, 'tool_completed')).toEqual([
        expect.objectContaining({ toolName: 'WebFetch', toolUseId: 'tool-web', output: 'Fetched' }),
      ]);
      expect(eventsOfType(events, 'tool_failed')).toHaveLength(0);
    });

    it('normalizes an errored user tool_result as tool_failed', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'assistant',
        message: {
          id: 'msg-tools',
          content: [{ type: 'tool_use', id: 'tool-search', name: 'WebSearch', input: { query: 'x' } }],
        },
      });
      appendJson(parser, {
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-search',
            is_error: true,
            content: [{ type: 'text', text: 'Network unavailable' }],
          }],
        },
      });

      expect(eventsOfType(events, 'tool_failed')).toEqual([
        expect.objectContaining({
          toolName: 'WebSearch',
          toolUseId: 'tool-search',
          error: 'Network unavailable',
        }),
      ]);
      expect(eventsOfType(events, 'tool_completed')).toHaveLength(0);
    });

    it('falls back to an unknown tool name for an orphan tool_result', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'ok' }] },
      });

      expect(eventsOfType(events, 'tool_completed')[0].toolName).toBe('unknown');
    });

    it('does not repeat tool_started for a repeated assistant snapshot', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));
      const snapshot = {
        type: 'assistant',
        message: {
          id: 'msg-repeat-tool',
          content: [{ type: 'tool_use', id: 'tool-repeat', name: 'Read', input: { file_path: 'a.ts' } }],
        },
      };

      appendJson(parser, snapshot);
      appendJson(parser, snapshot);

      expect(eventsOfType(events, 'tool_started')).toHaveLength(1);
      expect(eventsOfType(events, 'file_read')).toHaveLength(1);
    });
  });

  describe('stream deltas', () => {
    it('emits stream text deltas as non-snapshot chunks with stable identity', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'msg-stream' } },
      });
      appendJson(parser, {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'text_delta', text: 'partial' },
        },
      });

      expect(eventsOfType(events, 'assistant_text')).toEqual([
        expect.objectContaining({
          text: 'partial',
          messageId: 'msg-stream',
          blockIndex: 2,
          isSnapshot: false,
        }),
      ]);
    });

    it('uses the stream envelope uuid when no message_start was observed', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'stream_event',
        uuid: 'stream-uuid',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'chunk' },
        },
      });

      expect(eventsOfType(events, 'assistant_text')[0].messageId).toBe('stream-uuid');
    });

    it('silently consumes stream thinking deltas', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'private reasoning' },
        },
      });

      expect(events).toHaveLength(0);
    });
  });

  describe('result, permissions, usage, and terminal states', () => {
    it('does not repeat result text as assistant_text', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'assistant',
        message: { id: 'msg-final', content: [{ type: 'text', text: 'Done' }] },
      });
      appendJson(parser, {
        type: 'result',
        is_error: false,
        session_id: 'session-final',
        result: 'Done',
      });

      expect(eventsOfType(events, 'assistant_text')).toHaveLength(1);
      expect(eventsOfType(events, 'session_completed')[0]).toMatchObject({
        sessionId: 'session-final',
        result: 'Done',
      });
    });

    it('carries WebSearch permission denials on the completed terminal event', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'result',
        is_error: false,
        session_id: 'session-denied',
        permission_denials: [{
          tool_name: 'WebSearch',
          tool_use_id: 'tool-denied',
          tool_input: { query: 'latest docs' },
          reason: 'User denied permission',
        }],
      });

      expect(eventsOfType(events, 'session_completed')[0].permissionDenials).toEqual([{
        toolName: 'WebSearch',
        toolUseId: 'tool-denied',
        toolInput: { query: 'latest docs' },
        reason: 'User denied permission',
      }]);
    });

    it('carries permission denials on a failed terminal event', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        session_id: 'session-failed',
        duration_ms: 1200,
        result: 'Permission rejected',
        permission_denials: ['Policy blocked this request'],
      });

      expect(eventsOfType(events, 'session_failed')[0]).toMatchObject({
        sessionId: 'session-failed',
        duration: 1200,
        error: 'Permission rejected',
        permissionDenials: [{ toolName: 'unknown', reason: 'Policy blocked this request' }],
      });
      expect(eventsOfType(events, 'session_completed')).toHaveLength(0);
    });

    it('emits result usage before the completed terminal state', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'result',
        is_error: false,
        session_id: 'session-usage',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      expect(events.map((event) => event.type)).toEqual(['usage_updated', 'session_completed']);
      expect(eventsOfType(events, 'usage_updated')[0]).toMatchObject({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      });
    });

    it('emits result usage before the failed terminal state', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'result',
        is_error: true,
        result: 'boom',
        usage: { total_tokens: 9 },
      });

      expect(events.map((event) => event.type)).toEqual(['usage_updated', 'session_failed']);
      expect(eventsOfType(events, 'usage_updated')[0].totalTokens).toBe(9);
    });

    it('emits usage found on a full assistant message', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'assistant',
        message: {
          id: 'msg-usage',
          content: [{ type: 'text', text: 'answer' }],
          usage: { input_tokens: 7, output_tokens: 3 },
        },
      });

      expect(eventsOfType(events, 'usage_updated')[0].totalTokens).toBe(10);
    });

    it('emits usage from a stream message_delta', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'stream_event',
        event: { type: 'message_delta', usage: { output_tokens: 4 } },
      });

      expect(eventsOfType(events, 'usage_updated')[0]).toMatchObject({
        outputTokens: 4,
        totalTokens: 4,
      });
    });
  });

  describe('buffering and protocol noise', () => {
    it('waits for a newline before parsing a partial JSON line', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'assistant',
        message: { id: 'msg-buffer', content: [{ type: 'text', text: 'Buffered' }] },
      }, false);
      expect(events).toHaveLength(0);

      parser.append('\n');
      expect(eventsOfType(events, 'assistant_text')).toHaveLength(1);
    });

    it('flushes a final assistant snapshot without a trailing newline', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'assistant',
        message: { id: 'msg-flush', content: [{ type: 'text', text: 'Flushed' }] },
      }, false);
      parser.flush();

      expect(eventsOfType(events, 'assistant_text')[0].text).toBe('Flushed');
    });

    it('flushes a final result into a terminal event without a trailing newline', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, { type: 'result', is_error: false, session_id: 'session-flush' }, false);
      parser.flush();

      expect(eventsOfType(events, 'session_completed')[0].sessionId).toBe('session-flush');
    });

    it('silently consumes assistant thinking blocks', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'assistant',
        message: { id: 'msg-thinking', content: [{ type: 'thinking', thinking: 'private' }] },
      });

      expect(events).toHaveLength(0);
    });

    it('silently consumes non-init system events', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, { type: 'system', subtype: 'thinking_tokens', count: 42 });

      expect(events).toHaveLength(0);
    });

    it('silently consumes replayed user text', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'replayed prompt' }] },
      });

      expect(events).toHaveLength(0);
    });
  });

  describe('web tool compatibility failures', () => {
    it('marks a provider-synthesized unavailable WebSearch result as unsupported', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'web-search-1',
            name: 'WebSearch',
            input: { query: 'OpenAI official website' },
          }],
        },
      });
      appendJson(parser, {
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'web-search-1',
            content: "I'd be happy to help, but I don't currently have a web search tool available to me. I'm unable to perform live web searches.",
          }],
        },
      });

      expect(eventsOfType(events, 'tool_failed')[0]).toMatchObject({
        toolName: 'WebSearch',
        error: '[connection_unsupported] 当前模型连接不支持 WebSearch',
      });
      expect(eventsOfType(events, 'tool_completed')).toHaveLength(0);
    });

    it('matches the provider variant that says WebSearch access is unavailable', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'web-search-access',
            name: 'WebSearch',
            input: { query: 'OpenAI official website' },
          }],
        },
      });
      appendJson(parser, {
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'web-search-access',
            content: "I'd be happy to help. However, I don't currently have access to a web search tool in this conversation. I don't see any tools available that I can use to perform a web search.",
          }],
        },
      });

      expect(eventsOfType(events, 'tool_failed')[0].error)
        .toBe('[connection_unsupported] 当前模型连接不支持 WebSearch');
    });

    it('distinguishes an unconfigured WebFetch result', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'web-fetch-1',
            name: 'WebFetch',
            input: { url: 'https://example.com' },
          }],
        },
      });
      appendJson(parser, {
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'web-fetch-1',
            content: 'WebFetch is not configured for this connection.',
          }],
        },
      });

      expect(eventsOfType(events, 'tool_failed')[0].error)
        .toBe('[tool_unconfigured] WebFetch 工具未配置');
    });

    it('classifies the real WebFetch domain safety failure as a network policy block', () => {
      const parser = new ClaudeEventParser();
      const events: ClaudeEvent[] = [];
      parser.on('event', (event) => events.push(event));

      appendJson(parser, {
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'web-fetch-policy',
            name: 'WebFetch',
            input: { url: 'https://example.com' },
          }],
        },
      });
      appendJson(parser, {
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'web-fetch-policy',
            is_error: true,
            content: 'Unable to verify if domain example.com is safe to fetch. This may be due to network restrictions or enterprise security policies blocking claude.ai.',
          }],
        },
      });

      expect(eventsOfType(events, 'tool_failed')[0].error)
        .toBe('[config_disabled] WebFetch 被配置或网络安全策略禁止');
    });
  });
});
