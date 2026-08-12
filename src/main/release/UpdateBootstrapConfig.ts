import fs from 'node:fs';
import path from 'node:path';
import updateBootstrapContract from '../../shared/update-bootstrap-contract.json';

interface UpdateBootstrapContract {
  schemaVersion: 1;
  provider: 'generic';
  url: 'https://updates.invalid/disabled/';
  updaterCacheDirName: 'claude-workbench-updater';
}

export interface UpdateBootstrapConfig {
  provider: 'generic';
  placeholderUrl: 'https://updates.invalid/disabled/';
  updaterCacheDirName: 'claude-workbench-updater';
}

export interface UpdateBootstrapConfigInput {
  packaged: boolean;
  resourcesPath: string;
  fileSystem?: UpdateBootstrapFileSystem;
}

interface FileIdentityFacts {
  dev: number | bigint;
  ino: number | bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface UpdateBootstrapFileSystem {
  lstat(filePath: string): FileIdentityFacts;
  realpath(filePath: string): string;
  open(filePath: string): number;
  fstat(descriptor: number): FileIdentityFacts;
  read(descriptor: number): Buffer;
  close(descriptor: number): void;
}

const runtimeFileSystem: UpdateBootstrapFileSystem = {
  lstat: (filePath) => fs.lstatSync(filePath),
  realpath: (filePath) => fs.realpathSync.native(filePath),
  open: (filePath) => fs.openSync(filePath, 'r'),
  fstat: (descriptor) => fs.fstatSync(descriptor),
  read: (descriptor) => fs.readFileSync(descriptor),
  close: (descriptor) => fs.closeSync(descriptor),
};

const APPROVED_CONTRACT_KEYS = [
  'schemaVersion',
  'provider',
  'url',
  'updaterCacheDirName',
];

function approvedContract(): UpdateBootstrapContract {
  const candidate = updateBootstrapContract as Partial<UpdateBootstrapContract>;
  if (
    JSON.stringify(Object.keys(candidate)) !== JSON.stringify(APPROVED_CONTRACT_KEYS)
    || candidate.schemaVersion !== 1
    || candidate.provider !== 'generic'
    || candidate.url !== 'https://updates.invalid/disabled/'
    || candidate.updaterCacheDirName !== 'claude-workbench-updater'
  ) {
    throw new Error('The update bootstrap contract is outside the approved closed-Beta bounds.');
  }
  return candidate as UpdateBootstrapContract;
}

function canonicalBootstrapBytes(contract: UpdateBootstrapContract): Buffer {
  return Buffer.from([
    `provider: ${contract.provider}`,
    `url: ${contract.url}`,
    `updaterCacheDirName: ${contract.updaterCacheDirName}`,
    '',
  ].join('\n'), 'utf8');
}

function sameResolvedPath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function sameIdentity(left: FileIdentityFacts, right: FileIdentityFacts): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function readBoundBootstrapResource(
  resourcePath: string,
  fileSystem: UpdateBootstrapFileSystem = runtimeFileSystem,
): Buffer {
  const absolute = path.resolve(resourcePath);
  const expectedReal = path.join(
    path.resolve(fileSystem.realpath(path.dirname(absolute))),
    path.basename(absolute),
  );
  const before = fileSystem.lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('Packaged app-update.yml must be a plain regular file.');
  }
  if (!sameResolvedPath(path.resolve(fileSystem.realpath(absolute)), expectedReal)) {
    throw new Error('Packaged app-update.yml final path changed.');
  }
  const descriptor = fileSystem.open(absolute);
  try {
    const opened = fileSystem.fstat(descriptor);
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new Error('Packaged app-update.yml identity changed.');
    }
    const bytes = fileSystem.read(descriptor);
    const after = fileSystem.fstat(descriptor);
    const pathAfter = fileSystem.lstat(absolute);
    if (
      !after.isFile()
      || !sameIdentity(opened, after)
      || !sameIdentity(opened, pathAfter)
      || pathAfter.isSymbolicLink()
      || !sameResolvedPath(path.resolve(fileSystem.realpath(absolute)), expectedReal)
    ) {
      throw new Error('Packaged app-update.yml identity changed.');
    }
    return bytes;
  } finally {
    fileSystem.close(descriptor);
  }
}

export function loadUpdateBootstrapConfig(
  input: UpdateBootstrapConfigInput,
): UpdateBootstrapConfig {
  const contract = approvedContract();
  if (input.packaged) {
    let packagedBytes: Buffer;
    try {
      packagedBytes = readBoundBootstrapResource(
        path.join(input.resourcesPath, 'app-update.yml'),
        input.fileSystem,
      );
    } catch {
      throw new Error('Packaged app-update.yml does not match the tracked bootstrap contract.');
    }
    if (!packagedBytes.equals(canonicalBootstrapBytes(contract))) {
      throw new Error('Packaged app-update.yml does not match the tracked bootstrap contract.');
    }
  }
  return Object.freeze({
    provider: contract.provider,
    placeholderUrl: contract.url,
    updaterCacheDirName: contract.updaterCacheDirName,
  });
}

export function resolveUpdaterCacheRoot(
  baseCachePath: string,
  config: UpdateBootstrapConfig,
): string {
  return path.join(baseCachePath, config.updaterCacheDirName);
}

export interface ElectronUpdaterCacheEnvironment {
  platform: NodeJS.Platform;
  localAppData?: string;
  xdgCacheHome?: string;
  homeDirectory: string;
}

export function resolveElectronUpdaterBaseCachePath(
  input: ElectronUpdaterCacheEnvironment,
): string {
  const selected = input.platform === 'win32'
    ? input.localAppData || path.join(input.homeDirectory, 'AppData', 'Local')
    : input.platform === 'darwin'
      ? path.join(input.homeDirectory, 'Library', 'Caches')
      : input.xdgCacheHome || path.join(input.homeDirectory, '.cache');
  if (!path.isAbsolute(selected)) {
    throw new Error('Updater cache base must be absolute.');
  }
  const resolved = path.resolve(selected);
  assertPlainDirectoryChain(resolved);
  return resolved;
}

function assertPlainDirectory(directoryPath: string): void {
  const stats = fs.lstatSync(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Updater cache path must contain only plain directories.');
  }
  const resolved = path.resolve(directoryPath);
  const real = path.resolve(fs.realpathSync.native(directoryPath));
  const equal = process.platform === 'win32'
    ? resolved.toLowerCase() === real.toLowerCase()
    : resolved === real;
  if (!equal) throw new Error('Updater cache path must not traverse a reparse point.');
}

function assertPlainDirectoryChain(directoryPath: string): void {
  const absolute = path.resolve(directoryPath);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  assertPlainDirectory(current);
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    assertPlainDirectory(current);
  }
}

function createOwnedDirectory(directoryPath: string): void {
  try {
    fs.mkdirSync(directoryPath, { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/**
 * This synchronous pre-download check prevents electron-updater from emptying
 * a pre-existing redirected pending directory. A same-user replacement after
 * validation remains a TOCTOU limit and is not claimed to be atomically closed.
 */
export function prepareUpdaterCacheRoot(
  baseCachePath: string,
  config: UpdateBootstrapConfig,
): string {
  if (!path.isAbsolute(baseCachePath)) throw new Error('Updater cache base must be absolute.');
  const base = path.resolve(baseCachePath);
  const root = resolveUpdaterCacheRoot(base, config);
  const pending = path.join(root, 'pending');
  if (
    path.dirname(root) !== base
    || path.dirname(pending) !== root
    || path.basename(root) !== config.updaterCacheDirName
  ) {
    throw new Error('Updater cache path escaped its main-owned base.');
  }
  assertPlainDirectoryChain(base);
  createOwnedDirectory(root);
  assertPlainDirectoryChain(root);
  createOwnedDirectory(pending);
  assertPlainDirectoryChain(pending);
  return root;
}

export function bootstrapConfiguresUpdateSource(
  _config: UpdateBootstrapConfig,
): false {
  return false;
}
