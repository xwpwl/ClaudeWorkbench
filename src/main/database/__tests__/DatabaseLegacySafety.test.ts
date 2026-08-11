import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../Database';

const TEMP_PREFIX = 'claude-workbench-legacy-safety-';

describe('legacy database fail-closed safety', () => {
  let directory: string;
  let databasePath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    databasePath = path.join(directory, 'workbench.sqlite');
  });

  afterEach(() => {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith(TEMP_PREFIX)) {
      throw new Error(`Refusing to remove unexpected fixture: ${target}`);
    }
    fs.rmSync(target, { recursive: true, force: true });
  });

  it.each([
    ['truncated bytes', 'SQLite forma'],
    ['malformed JSON', '{"projects":'],
    ['JSON null', 'null'],
    ['JSON array', '[]'],
    ['JSON scalar', '42'],
  ])('rejects %s without replacing the source', (_label, source) => {
    fs.writeFileSync(databasePath, source, 'utf8');
    expect(() => new AppDatabase(databasePath)).toThrow(/neither valid SQLite nor valid legacy/i);
    expect(fs.readFileSync(databasePath, 'utf8')).toBe(source);
    expect(fs.readdirSync(directory)).toEqual(['workbench.sqlite']);
  });

  it('rejects a corrupt file with a SQLite header without moving or recreating it', () => {
    const source = Buffer.alloc(512, 0xa5);
    Buffer.from('SQLite format 3\0', 'binary').copy(source, 0);
    fs.writeFileSync(databasePath, source);

    expect(() => new AppDatabase(databasePath)).toThrow();
    expect(fs.readFileSync(databasePath)).toEqual(source);
    expect(fs.readdirSync(directory)).toEqual(['workbench.sqlite']);
  });

  it('still migrates a valid empty legacy object and keeps its backup', () => {
    fs.writeFileSync(databasePath, '{}', 'utf8');
    const database = new AppDatabase(databasePath);
    const migration = database.getMigrationInfo();
    database.close();
    expect(migration).toMatchObject({ migratedLegacyJson: true, schemaVersion: 7 });
    expect(migration.backupPath && fs.readFileSync(migration.backupPath, 'utf8')).toBe('{}');
  });
});
