import type {
  ModelApiFormat,
  ModelProviderType,
  ProviderConnectionError,
  ProviderConnectionResult,
} from '../../shared/types/modelProviders';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 150;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_API_KEY_LENGTH = 16_384;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_BASE_URL_LENGTH = 2_048;

export interface ProviderConnectionTestInput {
  providerType?: ModelProviderType;
  apiFormat: ModelApiFormat;
  baseUrl: string;
  apiKey: string;
  modelId?: string;
  timeoutMs?: number;
}

export interface ProviderConnectionTesterOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  retryDelayMs?: number;
  maxResponseBytes?: number;
}

export class ProviderConnectionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConnectionValidationError';
  }
}

class TransportFailure extends Error {
  constructor(readonly kind: 'timeout' | 'network') {
    super(kind);
  }
}

class InvalidResponseError extends Error {
  constructor() {
    super('invalid response');
  }
}

export class ProviderConnectionTester {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: ProviderConnectionTesterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }));
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  async test(input: ProviderConnectionTestInput): Promise<ProviderConnectionResult> {
    const validated = validateInput(input);
    const startedAt = this.now();
    try {
      const discoveredModelIds = validated.apiFormat === 'anthropic-messages'
        ? await this.testAnthropic(validated)
        : await this.testOpenAI(validated);
      const testedAt = this.now();
      return {
        ok: true,
        testedAt,
        latencyMs: elapsed(startedAt, testedAt),
        discoveredModelIds,
      };
    } catch (error) {
      const testedAt = this.now();
      return {
        ok: false,
        testedAt,
        latencyMs: elapsed(startedAt, testedAt),
        discoveredModelIds: [],
        error: publicError(error),
      };
    }
  }

  private async testAnthropic(
    input: ValidatedConnectionInput,
  ): Promise<string[]> {
    if (!input.modelId) {
      throw new ProviderConnectionValidationError(
        'A model ID is required for an Anthropic connection test.',
      );
    }
    const response = await this.requestWithRetry(
      endpoint(input.baseUrl, '/v1/messages'),
      {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...(input.providerType && input.providerType !== 'anthropic'
            ? { authorization: `Bearer ${input.apiKey}` }
            : { 'x-api-key': input.apiKey }),
        },
        body: JSON.stringify({
          model: input.modelId,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      },
      input.timeoutMs,
    );
    if (!response.ok) throw response;
    const body = await this.readJson(response);
    if (!isRecord(body) || typeof body.id !== 'string' || body.id.length === 0) {
      throw new InvalidResponseError();
    }
    return [];
  }

  private async testOpenAI(
    input: ValidatedConnectionInput,
  ): Promise<string[]> {
    const headers = { authorization: `Bearer ${input.apiKey}` };
    const modelsResponse = await this.requestWithRetry(
      endpoint(input.baseUrl, '/models'),
      { method: 'GET', redirect: 'manual', headers },
      input.timeoutMs,
    );
    if (modelsResponse.ok) {
      const body = await this.readJson(modelsResponse);
      if (!isRecord(body) || !Array.isArray(body.data)) throw new InvalidResponseError();
      const modelIds = body.data
        .map((value) => isRecord(value) && typeof value.id === 'string' ? value.id.trim() : '')
        .filter((value) => value.length > 0
          && value.length <= MAX_MODEL_ID_LENGTH
          && !/[\u0000-\u001f\u007f]/u.test(value));
      if (body.data.length > 0 && modelIds.length === 0) throw new InvalidResponseError();
      return [...new Set(modelIds)];
    }
    if (modelsResponse.status !== 404 || !input.modelId) throw modelsResponse;

    const chatResponse = await this.requestWithRetry(
      endpoint(input.baseUrl, '/chat/completions'),
      {
        method: 'POST',
        redirect: 'manual',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: input.modelId,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      },
      input.timeoutMs,
    );
    if (!chatResponse.ok) throw chatResponse;
    const body = await this.readJson(chatResponse);
    if (!isRecord(body) || typeof body.id !== 'string' || body.id.length === 0) {
      throw new InvalidResponseError();
    }
    return [];
  }

  private async requestWithRetry(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    let lastFailure: TransportFailure | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.requestOnce(url, init, timeoutMs);
        const retryableStatus = response.status === 429 || response.status >= 500;
        if (!retryableStatus || attempt === 1) return response;
      } catch (error) {
        if (!(error instanceof TransportFailure)) throw error;
        lastFailure = error;
        if (attempt === 1) throw error;
      }
      if (this.retryDelayMs > 0) await this.sleep(this.retryDelayMs);
    }
    throw lastFailure ?? new TransportFailure('network');
  }

  private async requestOnce(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch {
      throw new TransportFailure(controller.signal.aborted ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  private async readJson(response: Response): Promise<unknown> {
    const declaredSize = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > this.maxResponseBytes) {
      throw new InvalidResponseError();
    }
    if (!response.body) throw new InvalidResponseError();

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > this.maxResponseBytes) {
          await reader.cancel();
          throw new InvalidResponseError();
        }
        chunks.push(next.value);
      }
    } catch (error) {
      if (error instanceof InvalidResponseError) throw error;
      throw new InvalidResponseError();
    }

    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new InvalidResponseError();
    }
  }
}

interface ValidatedConnectionInput {
  providerType?: ModelProviderType;
  apiFormat: ModelApiFormat;
  baseUrl: URL;
  apiKey: string;
  modelId?: string;
  timeoutMs: number;
}

function validateInput(input: ProviderConnectionTestInput): ValidatedConnectionInput {
  if (!input.apiKey || input.apiKey.length > MAX_API_KEY_LENGTH) {
    throw new ProviderConnectionValidationError('API key is required and must be within limits.');
  }
  const modelId = input.modelId?.trim();
  if (input.modelId !== undefined && (
    !modelId
    || modelId.length > MAX_MODEL_ID_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(modelId)
  )) {
    throw new ProviderConnectionValidationError('Model ID is invalid or too long.');
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new ProviderConnectionValidationError('Connection timeout is invalid.');
  }
  const baseUrl = new URL(normalizeProviderBaseUrl(input.baseUrl));
  return {
    ...(input.providerType ? { providerType: input.providerType } : {}),
    apiFormat: input.apiFormat,
    baseUrl,
    apiKey: input.apiKey,
    ...(modelId ? { modelId } : {}),
    timeoutMs,
  };
}

export function normalizeProviderBaseUrl(input: string): string {
  if (!input || input.length > MAX_BASE_URL_LENGTH) {
    throw new ProviderConnectionValidationError('Base URL must be a valid URL.');
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(input);
  } catch {
    throw new ProviderConnectionValidationError('Base URL must be a valid URL.');
  }
  if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') {
    throw new ProviderConnectionValidationError('Base URL must use HTTPS.');
  }
  if (baseUrl.username || baseUrl.password) {
    throw new ProviderConnectionValidationError('Base URL must not contain credentials.');
  }
  if (baseUrl.search) {
    throw new ProviderConnectionValidationError('Base URL must not contain a query.');
  }
  if (baseUrl.hash) {
    throw new ProviderConnectionValidationError('Base URL must not contain a fragment.');
  }
  const hostname = baseUrl.hostname.toLowerCase();
  if (isMetadataHost(hostname)) {
    throw new ProviderConnectionValidationError('Base URL must not target a cloud metadata service.');
  }
  if (baseUrl.protocol === 'http:' && !isLoopbackHost(hostname)) {
    throw new ProviderConnectionValidationError('Base URL must use HTTPS except for loopback development.');
  }

  const pathname = baseUrl.pathname.replace(/\/+$/u, '');
  return `${baseUrl.origin}${pathname}`;
}

function endpoint(baseUrl: URL, suffix: string): string {
  const target = new URL(baseUrl.toString());
  target.pathname = `${target.pathname}${suffix}`.replace(/\/{2,}/gu, '/');
  return target.toString();
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function isMetadataHost(hostname: string): boolean {
  return isLinkLocalIpv4(hostname)
    || isLinkLocalIpv6(hostname)
    || isIpv4MappedLinkLocal(hostname)
    || hostname === 'metadata.google.internal'
    || hostname === '100.100.100.200'
    || hostname === '[fd00:ec2::254]'
    || hostname === '[fd20:ce::254]';
}

function isLinkLocalIpv4(hostname: string): boolean {
  const octets = hostname.split('.');
  return octets.length === 4
    && octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
    && Number(octets[0]) === 169
    && Number(octets[1]) === 254;
}

function isLinkLocalIpv6(hostname: string): boolean {
  return /^\[fe[89ab][0-9a-f]:/iu.test(hostname);
}

function isIpv4MappedLinkLocal(hostname: string): boolean {
  const match = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/iu.exec(hostname);
  if (!match) return false;
  const high = Number.parseInt(match[1], 16);
  return (high >>> 8) === 169 && (high & 0xff) === 254;
}

function elapsed(startedAt: number, testedAt: number): number {
  return Math.max(0, Math.round(testedAt - startedAt));
}

function publicError(error: unknown): ProviderConnectionError {
  if (error instanceof TransportFailure) {
    return error.kind === 'timeout'
      ? { type: 'timeout', statusCode: null, message: 'Provider request timed out.' }
      : { type: 'network', statusCode: null, message: 'Provider network request failed.' };
  }
  if (error instanceof InvalidResponseError) {
    return { type: 'invalid_response', statusCode: null, message: 'Provider returned an invalid response.' };
  }
  if (error instanceof Response) {
    if (error.status === 401) {
      return { type: 'invalid_key', statusCode: 401, message: 'API key was rejected.' };
    }
    if (error.status === 403) {
      return { type: 'forbidden', statusCode: 403, message: 'Provider access was forbidden.' };
    }
    if (error.status === 404) {
      return { type: 'not_found', statusCode: 404, message: 'Provider endpoint was not found.' };
    }
    if (error.status === 429) {
      return { type: 'rate_limited', statusCode: 429, message: 'Provider rate limit was reached.' };
    }
    if (error.status >= 500) {
      return {
        type: 'network',
        statusCode: error.status,
        message: 'Provider is temporarily unavailable.',
      };
    }
    if (error.status >= 300 && error.status < 400) {
      return {
        type: 'invalid_response',
        statusCode: error.status,
        message: 'Provider returned an unsafe redirect.',
      };
    }
    return { type: 'unknown', statusCode: error.status, message: 'Provider request failed.' };
  }
  return { type: 'unknown', statusCode: null, message: 'Provider request failed.' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
