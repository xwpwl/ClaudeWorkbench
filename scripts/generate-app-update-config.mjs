import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = path.join(workspace, 'src', 'shared', 'update-bootstrap-contract.json');
const outputPath = path.join(workspace, 'build-resources', 'app-update.yml');
const expectedKeys = ['schemaVersion', 'provider', 'url', 'updaterCacheDirName'];

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function assertPlainDirectory(directoryPath) {
  const absolute = path.resolve(directoryPath);
  const stats = fs.lstatSync(absolute);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Update bootstrap paths must not traverse a reparse point.');
  }
  const real = path.resolve(fs.realpathSync.native(absolute));
  if (!samePath(absolute, real)) {
    throw new Error('Update bootstrap paths must not traverse a reparse point.');
  }
}

function assertPlainDirectoryChain(directoryPath) {
  const absolute = path.resolve(directoryPath);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  assertPlainDirectory(current);
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    assertPlainDirectory(current);
  }
}

export function readBoundRegularFile(filePath, fileSystem = fs) {
  const absolute = path.resolve(filePath);
  const parentReal = path.resolve(fileSystem.realpathSync.native(path.dirname(absolute)));
  const expectedReal = path.join(parentReal, path.basename(absolute));
  const before = fileSystem.lstatSync(absolute);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('Update bootstrap input must be a plain regular file.');
  }
  const real = path.resolve(fileSystem.realpathSync.native(absolute));
  if (!samePath(real, expectedReal)) {
    throw new Error('Update bootstrap input final path changed.');
  }
  const descriptor = fileSystem.openSync(absolute, 'r');
  try {
    const opened = fileSystem.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('Update bootstrap input identity changed.');
    }
    const bytes = fileSystem.readFileSync(descriptor);
    const after = fileSystem.fstatSync(descriptor);
    const pathAfter = fileSystem.lstatSync(absolute);
    if (
      !after.isFile()
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || pathAfter.dev !== opened.dev
      || pathAfter.ino !== opened.ino
      || pathAfter.isSymbolicLink()
      || !samePath(path.resolve(fileSystem.realpathSync.native(absolute)), expectedReal)
    ) {
      throw new Error('Update bootstrap input identity changed.');
    }
    return bytes;
  } finally {
    fileSystem.closeSync(descriptor);
  }
}

function readContract() {
  assertPlainDirectoryChain(path.dirname(contractPath));
  const bytes = readBoundRegularFile(contractPath);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const contract = JSON.parse(text);
  if (
    contract === null
    || typeof contract !== 'object'
    || Array.isArray(contract)
    || JSON.stringify(Object.keys(contract)) !== JSON.stringify(expectedKeys)
    || contract.schemaVersion !== 1
    || contract.provider !== 'generic'
    || contract.url !== 'https://updates.invalid/disabled/'
    || contract.updaterCacheDirName !== 'claude-workbench-updater'
  ) {
    throw new Error('The update bootstrap contract is outside the approved closed-Beta bounds.');
  }
  return contract;
}

export function generateAppUpdateConfig(contract) {
  return Buffer.from([
    `provider: ${contract.provider}`,
    `url: ${contract.url}`,
    `updaterCacheDirName: ${contract.updaterCacheDirName}`,
    '',
  ].join('\n'), 'utf8');
}

export function run(mode) {
  if (mode !== '--write' && mode !== '--verify') {
    throw new Error('Usage: node scripts/generate-app-update-config.mjs --write|--verify');
  }
  const expected = generateAppUpdateConfig(readContract());
  assertPlainDirectoryChain(path.dirname(outputPath));
  if (mode === '--write') {
    try {
      readBoundRegularFile(outputPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const temporaryPath = path.join(
      path.dirname(outputPath),
      `.app-update.yml.${process.pid}.${Date.now()}.tmp`,
    );
    let descriptor;
    try {
      descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, expected);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      assertPlainDirectoryChain(path.dirname(outputPath));
      try {
        readBoundRegularFile(outputPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      fs.renameSync(temporaryPath, outputPath);
      if (!readBoundRegularFile(outputPath).equals(expected)) {
        throw new Error('Written update bootstrap bytes did not bind to the tracked output.');
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.rmSync(temporaryPath, { force: true });
    }
    process.stdout.write('app-update.yml: WRITTEN\n');
    return 0;
  }
  let actual;
  try {
    actual = readBoundRegularFile(outputPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    actual = Buffer.alloc(0);
  }
  const matches = actual.equals(expected);
  process.stdout.write(`app-update.yml: ${matches ? 'MATCH' : 'MISMATCH'}\n`);
  return matches ? 0 : 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = run(process.argv[2]);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
