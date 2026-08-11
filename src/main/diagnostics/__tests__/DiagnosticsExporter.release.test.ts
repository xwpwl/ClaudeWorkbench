import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StructuredLogger } from '../../logging/StructuredLogger';
import { DiagnosticsExporter } from '../DiagnosticsExporter';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-diagnostics-release-'));
  roots.push(root);
  return root;
}

function storedEntries(zip: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const contentStart = nameStart + nameLength + extraLength;
    entries.set(
      zip.subarray(nameStart, nameStart + nameLength).toString('utf8'),
      zip.subarray(contentStart, contentStart + size),
    );
    offset = contentStart + size;
  }
  return entries;
}

function exportInput(destinationPath: string) {
  return {
    destinationPath,
    createdAt: '2026-08-01T12:34:56.789Z',
    version: { version: '1.0.0' },
    system: { platform: 'win32' },
    database: { schemaVersion: 4, sizeBytes: 10, journalMode: 'wal', integrity: 'ok' as const, counts: {} },
  };
}

describe('DiagnosticsExporter release privacy boundary', () => {
  it('uses an exact allowlist even when logs contain source-shaped and rotated files', async () => {
    const root = temporaryRoot();
    const logs = path.join(root, 'logs');
    fs.mkdirSync(logs);
    const logger = new StructuredLogger(logs);
    for (const category of ['app', 'agent', 'permission', 'git', 'database', 'error'] as const) {
      await logger.info(category, `${category}.safe`);
    }
    for (const [name, sentinel] of [
      ['project.ts', 'SOURCE-TS-SENTINEL'],
      ['.env', 'ENV-SENTINEL'],
      ['claude-workbench.db', 'DATABASE-SENTINEL'],
      ['app.log.1', 'ROTATED-SECRET-SENTINEL'],
    ]) {
      fs.writeFileSync(path.join(logs, name), sentinel);
    }

    const output = await new DiagnosticsExporter(logs).export(exportInput(path.join(root, 'export')));
    const entries = storedEntries(fs.readFileSync(output));
    expect([...entries.keys()].sort()).toEqual([
      'database-summary.json',
      'error-summary.json',
      'logs/agent.log',
      'logs/app.log',
      'logs/database.log',
      'logs/error.log',
      'logs/git.log',
      'logs/permission.log',
      'manifest.json',
      'system.json',
      'version.json',
    ]);
    const archiveText = fs.readFileSync(output).toString('utf8');
    expect(archiveText).not.toMatch(/SOURCE-TS-SENTINEL|ENV-SENTINEL|DATABASE-SENTINEL|ROTATED-SECRET-SENTINEL/u);
  });

  it('re-sanitizes structured and unstructured log lines before ZIP serialization', async () => {
    const root = temporaryRoot();
    const logs = path.join(root, 'logs');
    fs.mkdirSync(logs);
    fs.writeFileSync(path.join(logs, 'error.log'), [
      JSON.stringify({ timestamp: 'now', level: 'error', event: 'failed', password: 'JSON-SENTINEL' }),
      'Bearer RAW-LINE-SENTINEL',
    ].join('\n'));

    const output = await new DiagnosticsExporter(logs).export(exportInput(path.join(root, 'diagnostics.zip')));
    const entries = storedEntries(fs.readFileSync(output));
    const log = entries.get('logs/error.log')?.toString('utf8') ?? '';
    const summary = entries.get('error-summary.json')?.toString('utf8') ?? '';
    expect(log).not.toContain('JSON-SENTINEL');
    expect(log).not.toContain('RAW-LINE-SENTINEL');
    expect(summary).not.toContain('JSON-SENTINEL');
    expect(summary).not.toContain('RAW-LINE-SENTINEL');
    expect(summary).toContain('unstructured-error-log-entry');
  });

  it('tails oversized logs so stale content cannot inflate the diagnostic archive', async () => {
    const root = temporaryRoot();
    const logs = path.join(root, 'logs');
    fs.mkdirSync(logs);
    fs.writeFileSync(path.join(logs, 'app.log'), `STALE-BEGIN-SENTINEL${'x'.repeat(80_000)}\n${JSON.stringify({ event: 'latest' })}`);

    const output = await new DiagnosticsExporter(logs, { maxLogBytes: 64 * 1024 })
      .export(exportInput(path.join(root, 'diagnostics.zip')));
    const archive = fs.readFileSync(output).toString('utf8');
    expect(archive).not.toContain('STALE-BEGIN-SENTINEL');
    expect(archive).toContain('latest');
  });
});
