import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { redactText, redactValue, StructuredLogger } from '../StructuredLogger';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-logs-'));
  roots.push(root);
  return root;
}

describe('StructuredLogger', () => {
  it('writes one parseable JSON object per line to its category file', async () => {
    const root = tempRoot();
    const logger = new StructuredLogger(root);
    await logger.info('app', 'application.started', { pid: 42 });
    const record = JSON.parse(fs.readFileSync(path.join(root, 'app.log'), 'utf8'));
    expect(record).toMatchObject({ category: 'app', level: 'info', event: 'application.started', data: { pid: 42 } });
  });

  it('recursively removes credentials, prompts, source content, URLs and error secrets', async () => {
    const root = tempRoot();
    const logger = new StructuredLogger(root);
    await logger.error('error', 'operation.failed', {
      authorization: 'Bearer should-not-survive',
      nested: {
        prompt: 'private user request',
        source: 'const password = 1',
        url: 'https://person:pass@example.test/a?token=abc&safe=1#private',
        message: 'ANTHROPIC_AUTH_TOKEN=very-secret',
      },
      error: new Error('Bearer token-value'),
    });
    const text = fs.readFileSync(path.join(root, 'error.log'), 'utf8');
    expect(text).not.toContain('should-not-survive');
    expect(text).not.toContain('private user request');
    expect(text).not.toContain('const password');
    expect(text).not.toContain('person');
    expect(text).not.toContain('pass@');
    expect(text).not.toContain('abc');
    expect(text).not.toContain('very-secret');
    expect(text).not.toContain('token-value');
  });

  it('serializes circular values safely', () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(redactValue(value)).toEqual({ self: '[CIRCULAR]' });
  });

  it('redacts credential forms in standalone text', () => {
    expect(redactText('Bearer abc.def')).toBe('Bearer [REDACTED]');
    expect(redactText('API_KEY=abcdef')).toBe('API_KEY=[REDACTED]');
    expect(redactText('https://host/a?signature=abcdef&ok=yes')).not.toContain('abcdef');
  });

  it('rotates bounded files without losing the newest record', async () => {
    const root = tempRoot();
    const logger = new StructuredLogger(root, { maxBytes: 64 * 1024, retainedFiles: 2 });
    for (let index = 0; index < 80; index += 1) {
      await logger.info('agent', `stage.${index}`, { metadata: 'x'.repeat(1_000) });
    }
    expect(fs.existsSync(path.join(root, 'agent.log.1'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'agent.log'), 'utf8')).toContain('stage.79');
  });
});
