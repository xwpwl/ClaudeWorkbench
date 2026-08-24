import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProxy } from 'node:util/types';

const EXPECTED_SQL = 'select sqlite_version() as version';
const EXPECTED_SQLITE_VERSION = '3.53.4';

function exactRowVersion(row) {
  if (row === null
    || typeof row !== 'object'
    || Array.isArray(row)
    || isProxy(row)
    || Object.getPrototypeOf(row) !== Object.prototype) {
    throw new Error('Native ABI row is invalid.');
  }
  const keys = Reflect.ownKeys(row);
  if (keys.length !== 1 || keys[0] !== 'version') {
    throw new Error('Native ABI row is invalid.');
  }
  const descriptor = Object.getOwnPropertyDescriptor(row, 'version');
  if (!descriptor
    || !descriptor.enumerable
    || !Object.hasOwn(descriptor, 'value')
    || descriptor.value !== EXPECTED_SQLITE_VERSION) {
    throw new Error('Native ABI row is invalid.');
  }
  return descriptor.value;
}

function runtimeResult(sqliteVersion) {
  const electronVersion = process.versions.electron;
  const electronRuntime = typeof electronVersion === 'string';
  if (electronRuntime) {
    if (process.env.ELECTRON_RUN_AS_NODE !== '1') {
      throw new Error('Electron run-as-Node identity is invalid.');
    }
  } else if (Object.hasOwn(process.env, 'ELECTRON_RUN_AS_NODE')) {
    throw new Error('Node runtime cannot be relabeled.');
  }
  return {
    schemaVersion: 1,
    runtime: electronRuntime ? 'electron-run-as-node' : 'node',
    nodeVersion: process.version,
    electronVersion: electronRuntime ? electronVersion : null,
    modulesAbi: process.versions.modules,
    napi: process.versions.napi,
    platform: process.platform,
    arch: process.arch,
    sqliteVersion,
    status: 'PASS',
  };
}

async function executeProbe() {
  if (process.argv.length !== 2) throw new Error('Native ABI probe accepts no arguments.');
  const imported = await import('better-sqlite3/win32-x64');
  if (Reflect.ownKeys(imported).length === 0 || typeof imported.default !== 'function') {
    throw new Error('Native ABI module is invalid.');
  }
  let database;
  let primaryError;
  let result;
  try {
    database = new imported.default(':memory:');
    const statement = database.prepare(EXPECTED_SQL);
    if (statement === null || typeof statement !== 'object' || typeof statement.get !== 'function') {
      throw new Error('Native ABI statement is invalid.');
    }
    const sqliteVersion = exactRowVersion(statement.get());
    result = runtimeResult(sqliteVersion);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (database !== undefined) {
      try {
        database.close();
      } catch (closeError) {
        if (primaryError === undefined) throw closeError;
        throw new AggregateError([primaryError, closeError], 'Native ABI probe and close failed.');
      }
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await executeProbe();
  } catch {
    process.stdout.write('');
    process.stderr.write('Native ABI probe failed.\n');
    process.exitCode = 1;
  }
}
