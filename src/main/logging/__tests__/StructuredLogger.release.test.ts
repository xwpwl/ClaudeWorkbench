import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { redactText, redactValue, StructuredLogger } from '../StructuredLogger';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function logRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-log-release-'));
  roots.push(root);
  return root;
}

const sensitiveKeys = [
  'authorization',
  'cookie',
  'password',
  'passwd',
  'secret',
  'token',
  'api_key',
  'api-key',
  'auth_token',
  'broker_token',
  'private_key',
  'mcp_config',
  'prompt',
  'system_prompt',
  'input',
  'output',
  'content',
  'source',
  'old_content',
  'new_content',
] as const;

describe('StructuredLogger release redaction matrix', () => {
  it.each(sensitiveKeys)('redacts the sensitive key %s at the closest object boundary', (key) => {
    const sentinel = `SENTINEL-${key}-PRIVATE`;
    expect(redactValue({ [key]: sentinel })).toEqual({ [key]: '[REDACTED]' });
    expect(JSON.stringify(redactValue({ nested: { [key]: sentinel } }))).not.toContain(sentinel);
  });

  it.each([
    ['Bearer', { authorization: 'Bearer bearer-secret' }],
    ['Basic', { authorization: 'Basic dXNlcjpwYXNz' }],
  ])('removes an %s Authorization credential', (_scheme, value) => {
    expect(JSON.stringify(redactValue(value))).toBe('{"authorization":"[REDACTED]"}');
  });

  it.each([
    ['Bearer alpha.beta.gamma', 'alpha.beta.gamma'],
    ['bearer ABC_def-123', 'ABC_def-123'],
    ['ANTHROPIC_API_KEY=anthropic-secret', 'anthropic-secret'],
    ['AUTH_TOKEN:token-secret', 'token-secret'],
    ['sk-ant-abcdefghijklmno', 'sk-ant-abcdefghijklmno'],
    ['sk-proj-abcdefghijklmno', 'sk-proj-abcdefghijklmno'],
  ])('redacts a standalone credential in %s', (input, sentinel) => {
    expect(redactText(input)).not.toContain(sentinel);
  });

  it.each([
    'access_token',
    'auth',
    'authorization',
    'code',
    'credential',
    'key',
    'password',
    'secret',
    'signature',
    'sig',
    'token',
  ])('redacts URL query secret %s and removes the fragment', (parameter) => {
    const output = redactText(`https://example.test/path?${parameter}=URL-SENTINEL&safe=visible#fragment`);
    expect(output).not.toContain('URL-SENTINEL');
    expect(output).not.toContain('fragment');
  });

  it('removes both URL username and password credentials', () => {
    const output = redactText('https://private-user:private-pass@example.test/path?safe=1');
    expect(output).not.toContain('private-user');
    expect(output).not.toContain('private-pass');
    expect(output).toContain('safe=1');
  });

  it('redacts a private-key block including all key material', () => {
    const output = redactText([
      'before',
      '-----BEGIN RSA PRIVATE KEY-----',
      'PRIVATE-KEY-SENTINEL',
      '-----END RSA PRIVATE KEY-----',
      'after',
    ].join('\n'));
    expect(output).not.toContain('PRIVATE-KEY-SENTINEL');
    expect(output).toContain('[REDACTED]');
  });

  it('handles nested cycles, repeated references, bigint and Error values without throwing', () => {
    const shared: Record<string, unknown> = { safe: 1, password: 'cycle-secret' };
    const value: Record<string, unknown> = {
      first: shared,
      second: shared,
      count: 12n,
      error: new Error('Bearer error-secret'),
    };
    value.self = value;
    const redacted = redactValue(value);
    const json = JSON.stringify(redacted);
    expect(json).not.toContain('cycle-secret');
    expect(json).not.toContain('error-secret');
    expect(json).toContain('[CIRCULAR]');
    expect(json).toContain('"count":"12"');
  });

  it.each(['app', 'agent', 'permission', 'git', 'database', 'error'] as const)(
    'writes sanitized JSONL only to the selected %s category',
    async (category) => {
      const root = logRoot();
      const logger = new StructuredLogger(root, { now: () => new Date('2026-08-01T00:00:00.000Z') });
      await logger.info(category, ' unsafe event / name ', { authorization: 'Basic hidden' });
      const files = fs.readdirSync(root);
      expect(files).toEqual([`${category}.log`]);
      const line = fs.readFileSync(path.join(root, `${category}.log`), 'utf8');
      expect(line.endsWith('\n')).toBe(true);
      expect(JSON.parse(line)).toMatchObject({
        timestamp: '2026-08-01T00:00:00.000Z',
        category,
        event: 'unsafe_event___name',
        data: { authorization: '[REDACTED]' },
      });
      expect(line).not.toContain('hidden');
    },
  );

  it('serializes concurrent writes in call order without corrupting JSONL records', async () => {
    const root = logRoot();
    const logger = new StructuredLogger(root);
    await Promise.all(Array.from({ length: 25 }, (_, index) => logger.info('agent', `event.${index}`)));
    const records = fs.readFileSync(path.join(root, 'agent.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(records.map((record) => record.event)).toEqual(Array.from({ length: 25 }, (_, index) => `event.${index}`));
  });

  it('rejects writes after close and preserves the flushed file', async () => {
    const root = logRoot();
    const logger = new StructuredLogger(root);
    await logger.info('app', 'before.close');
    await logger.close();
    await expect(logger.info('app', 'after.close')).rejects.toThrow(/closed/i);
    expect(fs.readFileSync(path.join(root, 'app.log'), 'utf8')).toContain('before.close');
    expect(fs.readFileSync(path.join(root, 'app.log'), 'utf8')).not.toContain('after.close');
  });

  it('bounds rotation history and keeps the newest record in the active file', async () => {
    const root = logRoot();
    const logger = new StructuredLogger(root, { maxBytes: 64 * 1024, retainedFiles: 2 });
    for (let index = 0; index < 150; index += 1) {
      await logger.info('agent', `rotation.${index}`, { metadata: 'x'.repeat(1_000) });
    }
    expect(fs.readdirSync(root).sort()).toEqual(['agent.log', 'agent.log.1', 'agent.log.2']);
    expect(fs.readFileSync(path.join(root, 'agent.log'), 'utf8')).toContain('rotation.149');
  });
});
