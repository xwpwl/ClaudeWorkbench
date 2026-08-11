import fs from 'node:fs';
import path from 'node:path';

export type LogCategory = 'app' | 'agent' | 'permission' | 'git' | 'database' | 'error';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface StructuredLogRecord {
  timestamp: string;
  category: LogCategory;
  level: LogLevel;
  event: string;
  data?: unknown;
}

export interface StructuredLoggerOptions {
  maxBytes?: number;
  retainedFiles?: number;
  now?: () => Date;
}

const CATEGORIES: readonly LogCategory[] = [
  'app',
  'agent',
  'permission',
  'git',
  'database',
  'error',
] as const;

const SECRET_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|auth[_-]?token|broker[_-]?token|private[_-]?key|mcp[_-]?config|prompt|system[_-]?prompt|input|output|content|source|old[_-]?content|new[_-]?content)/iu;
const URL_SECRET_PARAM = /^(?:access[_-]?token|auth|authorization|code|credential|key|password|secret|signature|sig|token)$/iu;
const REDACTED = '[REDACTED]';

function sanitizeUrl(value: string): string {
  if (!/^https?:\/\//iu.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.username) url.username = REDACTED;
    if (url.password) url.password = REDACTED;
    for (const key of [...url.searchParams.keys()]) {
      if (URL_SECRET_PARAM.test(key)) url.searchParams.set(key, REDACTED);
    }
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

export function redactText(value: string): string {
  let result = sanitizeUrl(value);
  result = result.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu, REDACTED);
  result = result.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, `Bearer ${REDACTED}`);
  result = result.replace(/\b(?:sk-ant|sk-proj|sk)-[A-Za-z0-9_-]{8,}\b/gu, REDACTED);
  result = result.replace(
    /\b(ANTHROPIC_(?:API_KEY|AUTH_TOKEN)|CLAUDE_WORKBENCH_PERMISSION_TOKEN|API_KEY|AUTH_TOKEN|ACCESS_TOKEN|PASSWORD|SECRET)\s*[=:]\s*([^\s,;]+)/giu,
    '$1=[REDACTED]',
  );
  result = result.replace(/([?&](?:access[_-]?token|auth|authorization|code|credential|key|password|secret|signature|sig|token)=)[^&#\s]*/giu, '$1[REDACTED]');
  return result;
}

export function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      stack: value.stack ? redactText(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, seen));
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(entry, seen);
  }
  return output;
}

function safeEventName(event: string): string {
  const normalized = event.trim().replace(/[^a-zA-Z0-9_.:-]/gu, '_').slice(0, 160);
  return normalized || 'unknown';
}

export class StructuredLogger {
  readonly logsDirectory: string;
  private readonly maxBytes: number;
  private readonly retainedFiles: number;
  private readonly now: () => Date;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(logsDirectory: string, options: StructuredLoggerOptions = {}) {
    this.logsDirectory = path.resolve(logsDirectory);
    this.maxBytes = Math.max(64 * 1024, options.maxBytes ?? 5 * 1024 * 1024);
    this.retainedFiles = Math.max(1, Math.min(20, options.retainedFiles ?? 5));
    this.now = options.now ?? (() => new Date());
    fs.mkdirSync(this.logsDirectory, { recursive: true });
  }

  log(category: LogCategory, level: LogLevel, event: string, data?: unknown): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Structured logger is closed.'));
    if (!CATEGORIES.includes(category)) return Promise.reject(new Error('Invalid log category.'));
    const record: StructuredLogRecord = {
      timestamp: this.now().toISOString(),
      category,
      level,
      event: safeEventName(event),
      ...(data === undefined ? {} : { data: redactValue(data) }),
    };
    const line = `${JSON.stringify(record)}\n`;
    const write = this.queue.then(() => this.append(category, line));
    this.queue = write.catch(() => undefined);
    return write;
  }

  debug(category: LogCategory, event: string, data?: unknown): Promise<void> {
    return this.log(category, 'debug', event, data);
  }

  info(category: LogCategory, event: string, data?: unknown): Promise<void> {
    return this.log(category, 'info', event, data);
  }

  warn(category: LogCategory, event: string, data?: unknown): Promise<void> {
    return this.log(category, 'warn', event, data);
  }

  error(category: LogCategory, event: string, data?: unknown): Promise<void> {
    return this.log(category, 'error', event, data);
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }

  private async append(category: LogCategory, line: string): Promise<void> {
    const filePath = path.join(this.logsDirectory, `${category}.log`);
    await this.rotateIfNeeded(filePath, Buffer.byteLength(line));
    await fs.promises.appendFile(filePath, line, { encoding: 'utf8', mode: 0o600 });
  }

  private async rotateIfNeeded(filePath: string, incomingBytes: number): Promise<void> {
    let currentBytes = 0;
    try {
      currentBytes = (await fs.promises.stat(filePath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (currentBytes + incomingBytes <= this.maxBytes) return;
    for (let index = this.retainedFiles; index >= 1; index -= 1) {
      const source = index === 1 ? filePath : `${filePath}.${index - 1}`;
      const target = `${filePath}.${index}`;
      try {
        if (index === this.retainedFiles) await fs.promises.rm(target, { force: true });
        await fs.promises.rename(source, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}

export const structuredLoggerInternals = {
  categories: CATEGORIES,
  secretKey: SECRET_KEY,
};
