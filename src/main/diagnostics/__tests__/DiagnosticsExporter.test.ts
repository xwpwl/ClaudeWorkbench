import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticsExporter, diagnosticsExporterInternals } from '../DiagnosticsExporter';
import { StructuredLogger } from '../../logging/StructuredLogger';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-diagnostics-'));
  roots.push(value);
  return value;
}

function storedZipEntries(zip: Buffer): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const contentStart = nameStart + nameLength + extraLength;
    result.set(
      zip.subarray(nameStart, nameStart + nameLength).toString('utf8'),
      zip.subarray(contentStart, contentStart + size),
    );
    offset = contentStart + size;
  }
  return result;
}

const anonymousPerformanceSource = {
  operations: {
    direct: { total: 7, completed: 3, failed: 1, cancelled: 1, interrupted: 1 },
    orchestrated: { total: 5, completed: 2, failed: 1, cancelled: 1, interrupted: 0 },
  },
  durationBuckets: {
    underOneSecond: 1,
    oneToTenSeconds: 2,
    tenToSixtySeconds: 3,
    oneToTenMinutes: 4,
    tenMinutesOrMore: 5,
  },
};

describe('DiagnosticsExporter', () => {
  it('defaults every export to excluding anonymous performance data', async () => {
    const base = root();
    const output = await new DiagnosticsExporter(path.join(base, 'logs')).export({
      destinationPath: base,
      version: {},
      system: {},
      database: { schemaVersion: 7, sizeBytes: 0, journalMode: 'wal', integrity: 'ok', counts: {} },
      anonymousPerformanceData: anonymousPerformanceSource,
    });
    const entries = storedZipEntries(fs.readFileSync(output));
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8')) as Record<string, unknown>;

    expect([...entries.keys()]).not.toContain('anonymous-performance.json');
    expect(manifest.includeAnonymousPerformanceData).toBe(false);
  });

  it('projects an explicitly enabled aggregate to one exact closed schema', async () => {
    const base = root();
    const output = await new DiagnosticsExporter(path.join(base, 'logs')).export({
      destinationPath: base,
      version: {},
      system: {},
      database: { schemaVersion: 7, sizeBytes: 0, journalMode: 'wal', integrity: 'ok', counts: {} },
      includeAnonymousPerformanceData: true,
      anonymousPerformanceData: anonymousPerformanceSource,
    });
    const entries = storedZipEntries(fs.readFileSync(output));
    const aggregate = JSON.parse(entries.get('anonymous-performance.json')!.toString('utf8'));
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8')) as Record<string, unknown>;

    expect(aggregate).toEqual({ schemaVersion: 1, ...anonymousPerformanceSource });
    expect(Object.keys(aggregate)).toEqual(['schemaVersion', 'operations', 'durationBuckets']);
    expect(manifest.includeAnonymousPerformanceData).toBe(true);
    expect(JSON.stringify(manifest)).not.toMatch(
      /\b(?:id|name|path|prompt|message|url|error|rule|argument|provider|model|task|session|project|permission|git|checkpoint|mcp|tool|hardware|credential|ref|vault|blob|env)\b/iu,
    );
    expect(JSON.stringify(aggregate)).not.toMatch(
      /id|name|path|prompt|message|url|error|rule|argument|provider|model|task|session|project|permission|git|checkpoint|mcp|tool|hardware|credential|ref|vault|blob|env/iu,
    );
  });

  it.each([
    ['an extra root field', { ...anonymousPerformanceSource, providerId: 'provider-sentinel' }],
    ['an extra nested field', {
      ...anonymousPerformanceSource,
      operations: {
        ...anonymousPerformanceSource.operations,
        direct: { ...anonymousPerformanceSource.operations.direct, prompt: 'prompt-sentinel' },
      },
    }],
    ['a negative count', {
      ...anonymousPerformanceSource,
      durationBuckets: { ...anonymousPerformanceSource.durationBuckets, underOneSecond: -1 },
    }],
    ['a fractional count', {
      ...anonymousPerformanceSource,
      durationBuckets: { ...anonymousPerformanceSource.durationBuckets, underOneSecond: 1.5 },
    }],
    ['an unbounded count', {
      ...anonymousPerformanceSource,
      durationBuckets: { ...anonymousPerformanceSource.durationBuckets, underOneSecond: Number.MAX_SAFE_INTEGER },
    }],
  ])('fails closed without a partial ZIP for %s', async (_label, anonymousPerformanceData) => {
    const base = root();
    const destinationPath = path.join(base, 'diagnostics.zip');
    await expect(new DiagnosticsExporter(path.join(base, 'logs')).export({
      destinationPath,
      version: {},
      system: {},
      database: { schemaVersion: 7, sizeBytes: 0, journalMode: 'wal', integrity: 'ok', counts: {} },
      includeAnonymousPerformanceData: true,
      anonymousPerformanceData,
    })).rejects.toThrow('Anonymous performance data is unavailable.');
    expect(fs.existsSync(destinationPath)).toBe(false);
  });

  it('does not leak forbidden source fields through ZIP, logs, events, or console streams', async () => {
    const base = root();
    const logs = path.join(base, 'logs');
    const sentinels = {
      providerId: 'provider-privacy-sentinel',
      model: 'model-privacy-sentinel',
      taskId: 'task-privacy-sentinel',
      prompt: 'prompt-privacy-sentinel',
      credentialRef: 'credential-ref-privacy-sentinel',
      vaultPath: 'vault-path-privacy-sentinel',
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const destinationPath = path.join(base, 'diagnostics.zip');
      await expect(new DiagnosticsExporter(logs).export({
        destinationPath,
        version: { prompt: sentinels.prompt },
        system: { credentialRef: sentinels.credentialRef, vaultPath: sentinels.vaultPath },
        database: { schemaVersion: 7, sizeBytes: 0, journalMode: 'wal', integrity: 'ok', counts: {} },
        includeAnonymousPerformanceData: true,
        anonymousPerformanceData: { ...anonymousPerformanceSource, ...sentinels },
      })).rejects.toThrow('Anonymous performance data is unavailable.');
      const publicOutputs = [
        fs.existsSync(destinationPath) ? fs.readFileSync(destinationPath).toString('utf8') : '',
        JSON.stringify(consoleError.mock.calls),
        JSON.stringify(stdout.mock.calls),
        JSON.stringify(stderr.mock.calls),
      ].join('\n');
      for (const sentinel of Object.values(sentinels)) expect(publicOutputs).not.toContain(sentinel);
    } finally {
      consoleError.mockRestore();
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it('rejects unknown projector output instead of serializing a partial allowlist', () => {
    expect(() => diagnosticsExporterInternals.projectAnonymousPerformanceData({
      ...anonymousPerformanceSource,
      operations: undefined,
    })).toThrow('Anonymous performance data is unavailable.');
  });

  it('creates a valid store-only ZIP containing summaries and redacted logs', async () => {
    const base = root();
    const logs = path.join(base, 'logs');
    const logger = new StructuredLogger(logs);
    await logger.info('app', 'ready', { version: '1.0.0' });
    await logger.error('error', 'agent.failed', {
      prompt: 'private request',
      detail: 'Bearer top-secret',
    });
    const output = await new DiagnosticsExporter(logs).export({
      destinationPath: path.join(base, 'exports'),
      createdAt: '2026-08-01T00:00:00.000Z',
      version: { version: '1.0.0', buildId: 'test' },
      system: { platform: 'win32', authorization: 'secret' },
      database: { schemaVersion: 4, sizeBytes: 100, journalMode: 'wal', integrity: 'ok', counts: { tasks: 2 } },
    });
    const zip = fs.readFileSync(output);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    const entries = storedZipEntries(zip);
    expect([...entries.keys()]).toEqual(expect.arrayContaining([
      'manifest.json', 'version.json', 'system.json', 'database-summary.json',
      'error-summary.json', 'logs/app.log', 'logs/error.log',
    ]));
    const all = zip.toString('utf8');
    expect(all).not.toContain('private request');
    expect(all).not.toContain('top-secret');
    expect(all).not.toContain('"authorization":"secret"');
    expect(all).toContain('Only allowlisted, redacted local diagnostics are included.');
  });

  it('never includes the SQLite file even when it sits beside the logs', async () => {
    const base = root();
    const logs = path.join(base, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(base, 'claude-workbench.db'), 'SOURCE_SENTINEL');
    const output = await new DiagnosticsExporter(logs).export({
      destinationPath: base,
      version: {},
      system: {},
      database: { schemaVersion: 4, sizeBytes: 15, journalMode: 'wal', integrity: 'ok', counts: {} },
    });
    expect(fs.readFileSync(output).toString('utf8')).not.toContain('SOURCE_SENTINEL');
  });

  it('never includes Provider credentials or safeStorage vault blobs', async () => {
    const base = root();
    const logs = path.join(base, 'logs');
    const vault = path.join(base, 'model-credentials');
    const apiKey = 'deepseek-provider-credential-sentinel';
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(path.join(vault, '11111111-1111-4111-8111-111111111111.bin'), apiKey);
    const logger = new StructuredLogger(logs);
    await logger.error('error', 'provider.connection.failed', {
      providerId: 'provider-deepseek',
      apiKey,
      message: `API_KEY=${apiKey}`,
    });

    const output = await new DiagnosticsExporter(logs).export({
      destinationPath: path.join(base, 'exports'),
      version: {},
      system: {},
      database: { schemaVersion: 6, sizeBytes: 0, journalMode: 'wal', integrity: 'ok', counts: {} },
    });

    const archive = fs.readFileSync(output).toString('utf8');
    expect(archive).not.toContain(apiKey);
    expect(archive).not.toContain('11111111-1111-4111-8111-111111111111.bin');
    expect(archive).not.toContain('model-credentials');
  });
});
