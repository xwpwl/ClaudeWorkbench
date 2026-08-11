import { describe, expect, it, vi } from 'vitest';
import {
  ProviderConnectionTester,
  ProviderConnectionValidationError,
  type ProviderConnectionTestInput,
} from '../ProviderConnectionTester';

const baseInput: ProviderConnectionTestInput = {
  apiFormat: 'anthropic-messages',
  baseUrl: 'https://provider.example/gateway',
  apiKey: 'credential-sentinel',
  modelId: 'model-one',
};

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('ProviderConnectionTester', () => {
  it('sends a minimal Anthropic Messages probe without returning the API key', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response(200, {
      id: 'message-1', type: 'message', content: [{ type: 'text', text: 'ok' }],
    }));
    const tester = new ProviderConnectionTester({ fetchImpl, now: () => 1_000 });

    const result = await tester.test(baseInput);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://provider.example/gateway/v1/messages');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(new Headers(init?.headers).get('x-api-key')).toBe('credential-sentinel');
    expect(new Headers(init?.headers).get('anthropic-version')).toBe('2023-06-01');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'model-one', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }],
    });
    expect(result).toEqual({
      ok: true,
      testedAt: 1_000,
      latencyMs: 0,
      discoveredModelIds: [],
    });
    expect(JSON.stringify(result)).not.toContain('credential-sentinel');
  });

  it('mirrors Claude Code token authentication for Anthropic-compatible gateways', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response(200, {
      id: 'message-mimo', type: 'message', content: [{ type: 'text', text: 'ok' }],
    }));
    const tester = new ProviderConnectionTester({ fetchImpl });

    await tester.test({
      ...baseInput,
      providerType: 'anthropic-compatible',
      baseUrl: 'https://api.xiaomimimo.com/anthropic',
      modelId: 'mimo-v2.5-pro',
    });

    const headers = new Headers(fetchImpl.mock.calls[0][1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer credential-sentinel');
    expect(headers.has('x-api-key')).toBe(false);
  });

  it('uses Claude Code token authentication for custom Anthropic-format Providers', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response(200, {
      id: 'message-custom', type: 'message', content: [],
    }));

    await new ProviderConnectionTester({ fetchImpl }).test({
      ...baseInput,
      providerType: 'custom',
    });

    const headers = new Headers(fetchImpl.mock.calls[0][1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer credential-sentinel');
    expect(headers.has('x-api-key')).toBe(false);
  });

  it('discovers OpenAI-compatible models through GET /models', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response(200, {
      object: 'list',
      data: [
        { id: 'deepseek-chat', object: 'model' },
        { id: 'deepseek-reasoner', object: 'model' },
        { id: 'deepseek-chat', object: 'model' },
      ],
    }));
    const tester = new ProviderConnectionTester({ fetchImpl });
    const result = await tester.test({
      ...baseInput,
      apiFormat: 'openai-chat-completions',
      baseUrl: 'https://api.deepseek.example/v1/',
      modelId: undefined,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.deepseek.example/v1/models');
    expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer credential-sentinel');
    expect(result.ok).toBe(true);
    expect(result.discoveredModelIds).toEqual(['deepseek-chat', 'deepseek-reasoner']);
  });

  it('falls back to a minimal chat completion only when /models is unsupported and a model is supplied', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(404, { error: 'unsupported endpoint' }))
      .mockResolvedValueOnce(response(200, { id: 'completion-1', choices: [] }));
    const tester = new ProviderConnectionTester({ fetchImpl });
    const result = await tester.test({
      ...baseInput,
      apiFormat: 'openai-chat-completions',
      baseUrl: 'http://127.0.0.1:7777/v1',
      modelId: 'local-model',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toBe('http://127.0.0.1:7777/v1/chat/completions');
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({
      model: 'local-model', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }],
    });
    expect(result.discoveredModelIds).toEqual([]);
  });

  it('does not use chat fallback for authentication failures', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response(401, { secret: 'raw-error' }));
    const result = await new ProviderConnectionTester({ fetchImpl }).test({
      ...baseInput,
      apiFormat: 'openai-chat-completions',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: false,
      error: { type: 'invalid_key', statusCode: 401, message: 'API key was rejected.' },
    });
    expect(JSON.stringify(result)).not.toContain('raw-error');
  });

  it.each([
    [401, 'invalid_key', 'API key was rejected.'],
    [403, 'forbidden', 'Provider access was forbidden.'],
    [404, 'not_found', 'Provider endpoint was not found.'],
    [429, 'rate_limited', 'Provider rate limit was reached.'],
  ] as const)('classifies HTTP %i without exposing response content', async (status, type, message) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response(status, {
      error: `raw-${status}-credential-sentinel`,
    }));
    const result = await new ProviderConnectionTester({ fetchImpl, retryDelayMs: 0 }).test(baseInput);
    expect(result).toMatchObject({ ok: false, error: { type, statusCode: status, message } });
    expect(JSON.stringify(result)).not.toContain(`raw-${status}`);
  });

  it('retries one 429 response and records the successful total latency', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(429, {}))
      .mockResolvedValueOnce(response(200, { id: 'message' }));
    const ticks = [100, 180];
    const tester = new ProviderConnectionTester({
      fetchImpl,
      retryDelayMs: 0,
      now: () => ticks.shift() ?? 180,
    });
    const result = await tester.test(baseInput);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: true, testedAt: 180, latencyMs: 80 });
  });

  it('retries one 5xx response but never loops indefinitely', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response(503, {}));
    const result = await new ProviderConnectionTester({ fetchImpl, retryDelayMs: 0 }).test(baseInput);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: false,
      error: { type: 'network', statusCode: 503, message: 'Provider is temporarily unavailable.' },
    });
  });

  it('retries one transport failure and returns a sanitized network error', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('connect ECONNREFUSED credential-sentinel');
    });
    const result = await new ProviderConnectionTester({ fetchImpl, retryDelayMs: 0 }).test(baseInput);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: false,
      error: { type: 'network', statusCode: null, message: 'Provider network request failed.' },
    });
    expect(JSON.stringify(result)).not.toContain('credential-sentinel');
    expect(JSON.stringify(result)).not.toContain('ECONNREFUSED');
  });

  it('aborts a timed-out request and returns the timeout category', async () => {
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('request carried credential-sentinel', 'AbortError'));
      }, { once: true });
    }));
    const result = await new ProviderConnectionTester({ fetchImpl, retryDelayMs: 0 }).test({
      ...baseInput,
      timeoutMs: 5,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: false,
      error: { type: 'timeout', statusCode: null, message: 'Provider request timed out.' },
    });
  });

  it('rejects redirects instead of forwarding credentials', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://attacker.example/collect' },
    }));
    const result = await new ProviderConnectionTester({ fetchImpl }).test(baseInput);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][1]?.redirect).toBe('manual');
    expect(result).toMatchObject({
      ok: false,
      error: { type: 'invalid_response', statusCode: 302 },
    });
  });

  it('rejects malformed success bodies', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response(200, { data: [{ nope: true }] }));
    const result = await new ProviderConnectionTester({ fetchImpl }).test({
      ...baseInput,
      apiFormat: 'openai-chat-completions',
      modelId: undefined,
    });
    expect(result).toMatchObject({ ok: false, error: { type: 'invalid_response' } });
  });

  it('rejects discovered model identifiers containing control characters', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response(200, {
      data: [{ id: 'safe-model\nforged-log-entry' }, { id: '\u0000hidden' }],
    }));
    const result = await new ProviderConnectionTester({ fetchImpl }).test({
      ...baseInput,
      apiFormat: 'openai-chat-completions',
      modelId: undefined,
    });
    expect(result).toMatchObject({ ok: false, error: { type: 'invalid_response' } });
    expect(result.discoveredModelIds).toEqual([]);
  });

  it('rejects response bodies over the configured byte limit', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response(200, { data: 'x'.repeat(128) }));
    const result = await new ProviderConnectionTester({ fetchImpl, maxResponseBytes: 32 }).test(baseInput);
    expect(result).toMatchObject({ ok: false, error: { type: 'invalid_response' } });
  });

  it.each([
    ['not a url', 'valid URL'],
    ['ftp://provider.example', 'HTTPS'],
    ['http://provider.example', 'HTTPS'],
    ['https://user:pass@provider.example', 'credentials'],
    ['https://provider.example/path?api_key=secret', 'query'],
    ['https://provider.example/path#token', 'fragment'],
    ['http://169.254.169.254/latest', 'metadata'],
    ['https://169.254.77.8/internal', 'metadata'],
    ['https://[fe80::1]/internal', 'metadata'],
    ['https://[::ffff:169.254.169.254]/latest', 'metadata'],
  ])('rejects unsafe base URL %s', async (baseUrl, message) => {
    const tester = new ProviderConnectionTester({ fetchImpl: vi.fn<typeof fetch>() });
    await expect(tester.test({ ...baseInput, baseUrl })).rejects.toThrowError(
      ProviderConnectionValidationError,
    );
    await expect(tester.test({ ...baseInput, baseUrl })).rejects.toThrowError(
      new RegExp(message, 'iu'),
    );
  });

  it.each(['localhost', '127.0.0.1', '[::1]'])('allows loopback HTTP for %s', async (host) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response(200, { id: 'message' }));
    const result = await new ProviderConnectionTester({ fetchImpl }).test({
      ...baseInput,
      baseUrl: `http://${host}:9000/api`,
    });
    expect(result.ok).toBe(true);
  });

  it('validates API key, model ID, timeout, and input sizes before calling fetch', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const tester = new ProviderConnectionTester({ fetchImpl });
    await expect(tester.test({ ...baseInput, apiKey: '' })).rejects.toThrow(/API key/iu);
    await expect(tester.test({ ...baseInput, modelId: 'x'.repeat(257) })).rejects.toThrow(/model/iu);
    await expect(tester.test({ ...baseInput, timeoutMs: 0 })).rejects.toThrow(/timeout/iu);
    await expect(tester.test({ ...baseInput, apiKey: 'x'.repeat(16_385) })).rejects.toThrow(/API key/iu);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('merges a manual OpenAI model with discovered models without hardcoded entries', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response(200, {
      data: [{ id: 'remote-model' }],
    }));
    const result = await new ProviderConnectionTester({ fetchImpl }).test({
      ...baseInput,
      apiFormat: 'openai-chat-completions',
      modelId: 'manual-model',
    });
    expect(result.discoveredModelIds).toEqual(['remote-model']);
    expect(JSON.stringify(result.discoveredModelIds)).not.toContain('gpt-');
    expect(JSON.stringify(result.discoveredModelIds)).not.toContain('deepseek-');
  });
});
