import { EventEmitter } from 'events';
import type { ClaudeEvent, PermissionDenial } from '../../shared/types/claude';

type JsonObject = Record<string, unknown>;

/**
 * Parses Claude CLI stream-json output into stable, renderer-safe events.
 *
 * Full `assistant` messages are snapshots: a later event with the same
 * messageId/blockIndex replaces the earlier text. `stream_event` text deltas
 * are append-only chunks. Consumers can distinguish the two via isSnapshot.
 */
export class ClaudeEventParser extends EventEmitter {
  private buffer = '';
  private anonymousMessageSequence = 0;
  private anonymousToolSequence = 0;
  private activeStreamMessageId: string | null = null;
  private currentSessionId = '';
  private readonly snapshotTexts = new Map<string, string>();
  private readonly toolNamesByUseId = new Map<string, string>();
  private readonly emittedToolStarts = new Set<string>();

  append(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      this.processLine(line);
    }
  }

  flush(): void {
    const remaining = this.buffer;
    this.buffer = '';
    if (remaining.trim()) {
      this.processLine(remaining);
    }
  }

  private processLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const parsed: unknown = JSON.parse(trimmed);
      for (const event of this.normalizeEvent(parsed)) {
        this.emit('event', event);
      }
    } catch {
      this.emit('event', {
        type: 'stderr',
        text: trimmed,
        level: this.classifyStderr(trimmed),
        timestamp: Date.now(),
      } satisfies ClaudeEvent);
    }
  }

  private classifyStderr(text: string): 'warning' | 'error' | 'info' {
    const lower = text.toLowerCase();
    if (lower.includes('error') || lower.includes('fatal') || lower.includes('panic')) {
      return 'error';
    }
    if (lower.includes('warning') || lower.includes('warn') || lower.includes('no stdin data')) {
      return 'warning';
    }
    return 'info';
  }

  private normalizeEvent(raw: unknown): ClaudeEvent[] {
    const obj = this.asObject(raw);
    if (!obj) return [];

    const sessionId = this.asString(obj.session_id);
    if (sessionId) this.currentSessionId = sessionId;

    switch (this.asString(obj.type)) {
      case 'system':
        return this.normalizeSystemEvent(obj);
      case 'assistant':
        return this.normalizeAssistantEvent(obj);
      case 'user':
        return this.normalizeUserEvent(obj);
      case 'stream_event':
        return this.normalizeStreamEvent(obj);
      case 'result':
        return this.normalizeResultEvent(obj);
      default:
        // Unknown JSON events are protocol noise, not workflow events.
        return [];
    }
  }

  private normalizeSystemEvent(obj: JsonObject): ClaudeEvent[] {
    if (this.asString(obj.subtype) !== 'init') return [];

    const sessionId = this.asString(obj.session_id) ?? this.currentSessionId;
    this.currentSessionId = sessionId;
    return [{
      type: 'system_init',
      sessionId,
      model: this.asString(obj.model) ?? '',
      timestamp: Date.now(),
    }];
  }

  private normalizeAssistantEvent(obj: JsonObject): ClaudeEvent[] {
    const message = this.asObject(obj.message);
    if (!message) return [];

    const messageId = this.resolveMessageId(obj, message);
    const content = Array.isArray(message.content) ? message.content : [];
    const events: ClaudeEvent[] = [];
    const now = Date.now();

    content.forEach((rawBlock, blockIndex) => {
      const block = this.asObject(rawBlock);
      if (!block) return;

      switch (this.asString(block.type)) {
        case 'text': {
          const text = this.asString(block.text) ?? '';
          const snapshotKey = `${messageId}:${blockIndex}`;
          if (this.snapshotTexts.get(snapshotKey) === text) return;

          this.snapshotTexts.set(snapshotKey, text);
          events.push({
            type: 'assistant_text',
            text,
            messageId,
            blockIndex,
            isSnapshot: true,
            timestamp: now,
          });
          return;
        }
        case 'tool_use':
          events.push(...this.normalizeToolUse(block, now));
          return;
        case 'tool_result':
          // Some compatible providers place tool_result in assistant content.
          events.push(...this.normalizeToolResult(block, now));
          return;
        case 'thinking':
          // Never forward model reasoning into the workflow or conversation.
          return;
        default:
          return;
      }
    });

    const usageEvent = this.normalizeUsage(message.usage, now);
    if (usageEvent) events.push(usageEvent);
    return events;
  }

  private normalizeUserEvent(obj: JsonObject): ClaudeEvent[] {
    const message = this.asObject(obj.message);
    const content = message && Array.isArray(message.content) ? message.content : [];
    const events: ClaudeEvent[] = [];
    const now = Date.now();

    for (const rawBlock of content) {
      const block = this.asObject(rawBlock);
      if (block && this.asString(block.type) === 'tool_result') {
        events.push(...this.normalizeToolResult(block, now));
      }
    }

    // Replayed user text and system reminders are not workflow events.
    return events;
  }

  private normalizeStreamEvent(obj: JsonObject): ClaudeEvent[] {
    const streamEvent = this.asObject(obj.event);
    if (!streamEvent) return [];

    const eventType = this.asString(streamEvent.type);
    const now = Date.now();

    if (eventType === 'message_start') {
      const message = this.asObject(streamEvent.message);
      this.activeStreamMessageId = this.resolveStreamMessageId(obj, streamEvent, message);
      const usageEvent = this.normalizeUsage(message?.usage, now);
      return usageEvent ? [usageEvent] : [];
    }

    if (eventType === 'content_block_delta') {
      const delta = this.asObject(streamEvent.delta);
      if (!delta || this.asString(delta.type) !== 'text_delta') return [];

      const text = this.asString(delta.text);
      if (!text) return [];

      return [{
        type: 'assistant_text',
        text,
        messageId: this.resolveStreamMessageId(obj, streamEvent),
        blockIndex: this.asInteger(streamEvent.index) ?? this.asInteger(obj.index) ?? 0,
        isSnapshot: false,
        timestamp: now,
      }];
    }

    if (eventType === 'message_delta') {
      const usageEvent = this.normalizeUsage(streamEvent.usage, now);
      return usageEvent ? [usageEvent] : [];
    }

    // Thinking deltas, pings, block boundaries, and unknown stream events are noise.
    return [];
  }

  private normalizeResultEvent(obj: JsonObject): ClaudeEvent[] {
    const events: ClaudeEvent[] = [];
    const now = Date.now();
    const usageEvent = this.normalizeUsage(obj.usage, now);
    if (usageEvent) events.push(usageEvent);

    const permissionDenials = this.normalizePermissionDenials(obj.permission_denials);
    const result = this.asString(obj.result);
    const sessionId = this.asString(obj.session_id) ?? this.currentSessionId;
    const duration = this.asNumber(obj.duration_ms) ?? 0;
    const subtype = this.asString(obj.subtype) ?? '';
    const isError = obj.is_error === true || subtype.includes('error');

    if (isError) {
      events.push({
        type: 'session_failed',
        error: result ?? this.asString(obj.error) ?? 'Unknown error',
        sessionId,
        duration,
        permissionDenials,
        timestamp: now,
      });
    } else {
      events.push({
        type: 'session_completed',
        sessionId,
        duration,
        result,
        permissionDenials,
        timestamp: now,
      });
    }

    return events;
  }

  private normalizeToolUse(block: JsonObject, timestamp: number): ClaudeEvent[] {
    const toolName = this.asString(block.name) ?? 'unknown';
    const toolUseId = this.asString(block.id) ?? `tool_${++this.anonymousToolSequence}`;
    this.toolNamesByUseId.set(toolUseId, toolName);

    // A growing assistant snapshot can repeat the same tool block.
    if (this.emittedToolStarts.has(toolUseId)) return [];
    this.emittedToolStarts.add(toolUseId);

    const input = block.input;
    const events: ClaudeEvent[] = [{
      type: 'tool_started',
      toolName,
      toolUseId,
      input,
      timestamp,
    }];
    const inputObject = this.asObject(input);

    if (toolName === 'Bash') {
      const command = this.asString(inputObject?.command);
      if (command) {
        events.push({ type: 'command_started', command, toolUseId, timestamp });
      }
    } else if (toolName === 'Read') {
      const filePath = this.asString(inputObject?.file_path);
      if (filePath) {
        events.push({ type: 'file_read', filePath, toolUseId, timestamp });
      }
    } else if (toolName === 'Edit' || toolName === 'Write') {
      const filePath = this.asString(inputObject?.file_path);
      if (filePath) {
        events.push({ type: 'file_changed', filePath, toolUseId, timestamp });
      }
    }

    return events;
  }

  private normalizeToolResult(block: JsonObject, timestamp: number): ClaudeEvent[] {
    const toolUseId = this.asString(block.tool_use_id) ?? '';
    const toolName = this.toolNamesByUseId.get(toolUseId)
      ?? this.asString(block.tool_name)
      ?? 'unknown';
    const output = block.content ?? block.output;
    this.toolNamesByUseId.delete(toolUseId);
    const inferredFailure = this.inferWebToolFailure(toolName, output);

    if (block.is_error === true || inferredFailure) {
      return [{
        type: 'tool_failed',
        toolName,
        toolUseId,
        error: inferredFailure ?? this.extractError(output, block),
        output,
        timestamp,
      }];
    }

    return [{
      type: 'tool_completed',
      toolName,
      toolUseId,
      output,
      timestamp,
    }];
  }

  private inferWebToolFailure(toolName: string, output: unknown): string | null {
    if (toolName !== 'WebSearch' && toolName !== 'WebFetch') return null;
    const text = this.extractError(output, {}).toLocaleLowerCase();

    if (
      text.includes('permission denied')
      || text.includes('permission was not granted')
      || text.includes('user denied')
    ) {
      return `[permission_denied] ${toolName} 权限未授予`;
    }
    if (
      text.includes('disabled by')
      || text.includes('disallowed')
      || text.includes('not allowed by settings')
      || text.includes('blocked by configuration')
      || text.includes('unable to verify if domain')
      || text.includes('network restrictions')
      || text.includes('enterprise security policies')
    ) {
      return `[config_disabled] ${toolName} 被配置或网络安全策略禁止`;
    }
    if (
      text.includes('not configured')
      || text.includes('tool is not installed')
      || text.includes('no web tool configured')
    ) {
      return `[tool_unconfigured] ${toolName} 工具未配置`;
    }

    const unsupportedSearch = toolName === 'WebSearch' && (
      text.includes("don't currently have a web search tool")
      || text.includes('do not currently have a web search tool')
      || text.includes('unable to perform live web searches')
      || text.includes('web search is not available')
      || text.includes('no web search tool available')
      || /(?:do not|don't|does not|doesn't|cannot|can't)[^.\n]{0,140}(?:web search tool|live web search)/.test(text)
      || /(?:no|not any)[^.\n]{0,80}tools? available[^.\n]{0,80}web search/.test(text)
      || /(?:enable|provide access to)[^.\n]{0,80}web search tool/.test(text)
    );
    const unsupportedFetch = toolName === 'WebFetch' && (
      text.includes('unable to access the web')
      || text.includes('unable to access external web')
      || text.includes('cannot access external websites')
      || text.includes("don't have access to the internet")
      || text.includes('do not have access to the internet')
      || text.includes('web browsing is not available')
      || text.includes('web fetch is not available')
    );
    if (unsupportedSearch || unsupportedFetch) {
      return `[connection_unsupported] 当前模型连接不支持 ${toolName}`;
    }
    return null;
  }

  private normalizeUsage(rawUsage: unknown, timestamp: number): ClaudeEvent | null {
    const usage = this.asObject(rawUsage);
    if (!usage) return null;

    const inputTokens = this.asNumber(usage.input_tokens);
    const outputTokens = this.asNumber(usage.output_tokens);
    const explicitTotal = this.asNumber(usage.total_tokens);
    if (inputTokens === undefined && outputTokens === undefined && explicitTotal === undefined) {
      return null;
    }

    return {
      type: 'usage_updated',
      inputTokens,
      outputTokens,
      totalTokens: explicitTotal ?? (inputTokens ?? 0) + (outputTokens ?? 0),
      timestamp,
    };
  }

  private normalizePermissionDenials(rawDenials: unknown): PermissionDenial[] {
    if (!Array.isArray(rawDenials)) return [];

    return rawDenials.map((rawDenial) => {
      const denial = this.asObject(rawDenial);
      if (!denial) {
        return { toolName: 'unknown', reason: this.asString(rawDenial) ?? 'Permission denied' };
      }

      return {
        toolName: this.asString(denial.tool_name)
          ?? this.asString(denial.toolName)
          ?? 'unknown',
        toolUseId: this.asString(denial.tool_use_id) ?? this.asString(denial.toolUseId),
        toolInput: denial.tool_input ?? denial.toolInput,
        reason: this.asString(denial.reason)
          ?? this.asString(denial.message)
          ?? this.asString(denial.description),
      };
    });
  }

  private resolveMessageId(obj: JsonObject, message: JsonObject): string {
    return this.asString(message.id)
      ?? this.asString(message.uuid)
      ?? this.asString(obj.uuid)
      ?? this.asString(obj.message_id)
      ?? `assistant_${++this.anonymousMessageSequence}`;
  }

  private resolveStreamMessageId(
    obj: JsonObject,
    streamEvent: JsonObject,
    message?: JsonObject | null,
  ): string {
    const messageId = this.asString(message?.id)
      ?? this.asString(message?.uuid)
      ?? this.asString(streamEvent.message_id)
      ?? this.asString(obj.message_id)
      ?? this.asString(obj.uuid)
      ?? this.activeStreamMessageId
      ?? `assistant_${++this.anonymousMessageSequence}`;
    this.activeStreamMessageId = messageId;
    return messageId;
  }

  private extractError(output: unknown, block: JsonObject): string {
    const explicit = this.asString(block.error) ?? this.asString(block.message);
    if (explicit) return explicit;
    if (typeof output === 'string' && output) return output;

    if (Array.isArray(output)) {
      const text = output
        .map((item) => {
          if (typeof item === 'string') return item;
          const part = this.asObject(item);
          return this.asString(part?.text) ?? this.asString(part?.content) ?? '';
        })
        .filter(Boolean)
        .join('\n');
      if (text) return text;
    }

    const outputObject = this.asObject(output);
    const nested = this.asString(outputObject?.error)
      ?? this.asString(outputObject?.message)
      ?? this.asString(outputObject?.text);
    if (nested) return nested;

    if (output !== undefined) {
      try {
        return JSON.stringify(output);
      } catch {
        // Fall through to the stable generic message.
      }
    }
    return 'Tool execution failed';
  }

  private asObject(value: unknown): JsonObject | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as JsonObject
      : null;
  }

  private asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private asInteger(value: unknown): number | undefined {
    const number = this.asNumber(value);
    return number !== undefined && Number.isInteger(number) ? number : undefined;
  }
}
