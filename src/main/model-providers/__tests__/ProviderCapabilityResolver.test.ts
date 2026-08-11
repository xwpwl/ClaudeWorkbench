import { describe, expect, it } from 'vitest';
import {
  ProviderCapabilityResolver,
  resolveProviderCapabilities,
  resolveProviderRuntime,
} from '../ProviderCapabilityResolver';

describe('ProviderCapabilityResolver', () => {
  it.each([
    ['anthropic', 'anthropic-messages', 'claude-code'],
    ['anthropic-compatible', 'anthropic-messages', 'claude-code'],
    ['openai-compatible', 'openai-chat-completions', 'none'],
    ['custom', 'anthropic-messages', 'claude-code'],
    ['custom', 'openai-chat-completions', 'none'],
  ] as const)('maps %s / %s to the trusted %s runtime', (type, apiFormat, expected) => {
    expect(resolveProviderRuntime(type, apiFormat)).toBe(expected);
  });

  it('fails closed when an Anthropic provider declares an OpenAI API format', () => {
    expect(resolveProviderRuntime('anthropic', 'openai-chat-completions')).toBe('none');
  });

  it('gives an Anthropic provider the full Claude Code capability envelope', () => {
    expect(resolveProviderCapabilities('anthropic', 'anthropic-messages')).toEqual({
      supportsClaudeCode: true,
      supportsAgentWorkflow: true,
      supportsTools: true,
      supportsMCP: true,
      supportsStreaming: true,
      supportsVision: true,
    });
  });

  it('keeps Anthropic-compatible vision disabled by default', () => {
    expect(resolveProviderCapabilities('anthropic-compatible', 'anthropic-messages'))
      .toMatchObject({
        supportsClaudeCode: true,
        supportsAgentWorkflow: true,
        supportsTools: true,
        supportsMCP: true,
        supportsStreaming: true,
        supportsVision: false,
      });
  });

  it('keeps the custom Anthropic capability envelope internally consistent', () => {
    expect(resolveProviderCapabilities('custom', 'anthropic-messages')).toEqual({
      supportsClaudeCode: true,
      supportsAgentWorkflow: true,
      supportsTools: true,
      supportsMCP: true,
      supportsStreaming: true,
      supportsVision: false,
    });
  });

  it('does not let an OpenAI-compatible provider elevate Claude runtime capabilities', () => {
    expect(resolveProviderCapabilities(
      'openai-compatible',
      'openai-chat-completions',
      {
        supportsClaudeCode: true,
        supportsAgentWorkflow: true,
        supportsTools: true,
        supportsMCP: true,
        supportsStreaming: true,
        supportsVision: true,
      },
    )).toEqual({
      supportsClaudeCode: false,
      supportsAgentWorkflow: false,
      supportsTools: true,
      supportsMCP: false,
      supportsStreaming: true,
      supportsVision: false,
    });
  });

  it('lets a user narrow but not widen an Anthropic-compatible capability envelope', () => {
    expect(resolveProviderCapabilities(
      'anthropic-compatible',
      'anthropic-messages',
      {
        supportsClaudeCode: true,
        supportsAgentWorkflow: false,
        supportsTools: false,
        supportsMCP: true,
        supportsStreaming: false,
        supportsVision: true,
      },
    )).toEqual({
      supportsClaudeCode: true,
      supportsAgentWorkflow: false,
      supportsTools: false,
      supportsMCP: false,
      supportsStreaming: false,
      supportsVision: false,
    });
  });

  it('co-narrows dependent capabilities so every persisted combination remains valid', () => {
    expect(resolveProviderCapabilities('anthropic', 'anthropic-messages', {
      supportsClaudeCode: false,
      supportsAgentWorkflow: true,
      supportsTools: false,
      supportsMCP: true,
    })).toMatchObject({
      supportsClaudeCode: false,
      supportsAgentWorkflow: false,
      supportsTools: false,
      supportsMCP: false,
    });
  });

  it('fails closed for a mismatched Provider/API combination', () => {
    expect(new ProviderCapabilityResolver().resolve(
      'openai-compatible',
      'anthropic-messages',
    )).toEqual({
      runtimeType: 'none',
      capabilities: {
        supportsClaudeCode: false,
        supportsAgentWorkflow: false,
        supportsTools: false,
        supportsMCP: false,
        supportsStreaming: false,
        supportsVision: false,
      },
    });
  });
});
