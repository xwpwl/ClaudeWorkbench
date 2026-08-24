import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function jsonError(message) {
  return new TypeError(`Canonical JSON ${message}.`);
}

function canonicalValue(value, ancestors) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw jsonError('does not support non-finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw jsonError('contains a non-JSON value');
  if (ancestors.has(value)) throw jsonError('contains a cyclic value');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw jsonError('contains a sparse array');
      }
      if (Reflect.ownKeys(value).some((key) => key !== 'length'
        && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/u.test(key)))) {
        throw jsonError('contains unsupported array properties');
      }
      return `[${value.map((item) => canonicalValue(item, ancestors)).join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw jsonError('requires plain objects');
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== 'string')) {
      throw jsonError('does not support symbol keys');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of ownKeys) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw jsonError('requires enumerable data properties');
      }
    }
    return `{${ownKeys.sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalValue(value[key], ancestors)}`
    )).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value) {
  return `${canonicalValue(value, new WeakSet())}\n`;
}

function samePath(left, right) {
  const normalize = (value) => path.resolve(value).replace(/[\\/]+$/u, '').toLowerCase();
  return normalize(left) === normalize(right);
}

function bigLstat(filePath) {
  return fs.lstatSync(filePath, { bigint: true });
}

function bigFstat(descriptor) {
  return fs.fstatSync(descriptor, { bigint: true });
}

function identityOf(stat) {
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function contentStateOf(stat) {
  return Object.freeze({
    ...identityOf(stat),
    size: stat.size,
    mode: stat.mode,
    mtimeNs: stat.mtimeNs,
  });
}

function sameContentState(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs;
}

function stablePathSnapshot(filePath, kind, label) {
  const before = bigLstat(filePath);
  if (before.isSymbolicLink()
    || (kind === 'file' && !before.isFile())
    || (kind === 'directory' && !before.isDirectory())) {
    throw new Error(`${label} must be an ordinary ${kind}; reparse points are forbidden.`);
  }
  const canonical = fs.realpathSync.native(filePath);
  if (!samePath(canonical, filePath)) {
    throw new Error(`${label} must not traverse a reparse point.`);
  }
  const after = bigLstat(filePath);
  const beforeState = contentStateOf(before);
  const afterState = contentStateOf(after);
  if (!sameContentState(beforeState, afterState)) {
    throw new Error(`${label} identity changed during validation.`);
  }
  return afterState;
}

function optionalFileSnapshot(filePath, label) {
  try {
    return stablePathSnapshot(filePath, 'file', label);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function directoryChainSnapshot(root, directory) {
  const workspaceRoot = path.resolve(root);
  const relative = path.relative(workspaceRoot, directory);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Atomic destination parent must remain inside the workspace.');
  }
  const snapshots = [];
  let current = workspaceRoot;
  snapshots.push({
    path: current,
    identity: stablePathSnapshot(current, 'directory', 'Release workspace root'),
  });
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    snapshots.push({
      path: current,
      identity: stablePathSnapshot(current, 'directory', 'Atomic destination parent'),
    });
  }
  return snapshots;
}

function assertDirectoryChainStable(snapshots) {
  for (const snapshot of snapshots) {
    const current = stablePathSnapshot(snapshot.path, 'directory', 'Atomic destination parent');
    if (!sameIdentity(current, snapshot.identity)) {
      throw new Error('Atomic destination parent identity changed.');
    }
  }
}

function assertHeldDirectory(descriptor, expected) {
  const observed = bigFstat(descriptor);
  if (!observed.isDirectory() || !sameIdentity(identityOf(observed), expected)) {
    throw new Error('Atomic destination parent handle identity changed.');
  }
}

function assertDestinationUnchanged(destination, expected) {
  const observed = optionalFileSnapshot(destination, 'Atomic destination');
  if (expected === null) {
    if (observed !== null) throw new Error('Atomic destination appeared before rename.');
    return;
  }
  if (observed === null || !sameContentState(observed, expected)) {
    throw new Error('Atomic destination identity changed before rename.');
  }
}

function assertPathMatchesFile(filePath, expected, label) {
  const observed = stablePathSnapshot(filePath, 'file', label);
  if (!sameContentState(observed, expected)) {
    throw new Error(`${label} identity or bytes changed.`);
  }
}

function unsupportedDirectorySync(error) {
  const code = error && error.code;
  return code === 'EINVAL'
    || code === 'ENOTSUP'
    || code === 'ENOSYS'
    || code === 'EISDIR'
    || (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES'));
}

function syncDirectoryIfSupported(descriptor) {
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    // Windows opens the directory handle but reports EPERM for directory fsync.
    // Ignoring that known result records no durability claim; all other failures propagate.
    if (unsupportedDirectorySync(error)) return;
    throw error;
  }
}

function isWindowsAbsoluteOrDrive(value) {
  return path.win32.isAbsolute(value)
    || /^[A-Za-z]:/u.test(value)
    || /^\\\\(?:\?|\.)\\/u.test(value);
}

function assertOrdinaryPath(root, segments) {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error('Release path must not traverse a reparse point.');
    }
    const real = fs.realpathSync.native(current);
    if (!samePath(real, current)) {
      throw new Error('Release path must not traverse a reparse point.');
    }
  }
}

export function safeRelativePath(root, candidate) {
  if (typeof root !== 'string' || root.length === 0
    || typeof candidate !== 'string' || candidate.length === 0
    || candidate.includes('\0')
    || path.isAbsolute(candidate)
    || isWindowsAbsoluteOrDrive(candidate)) {
    throw new Error('Release path must be workspace-relative.');
  }

  const normalizedInput = candidate.replace(/\\/gu, '/');
  const segments = normalizedInput.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('Release path must be workspace-relative.');
  }

  const workspaceRoot = path.resolve(root);
  const rootStat = fs.lstatSync(workspaceRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
    || !samePath(fs.realpathSync.native(workspaceRoot), workspaceRoot)) {
    throw new Error('Release workspace root must be an ordinary directory.');
  }
  const resolved = path.resolve(workspaceRoot, ...segments);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..'
    || path.isAbsolute(relative)
    || path.parse(resolved).root.toLowerCase() !== path.parse(workspaceRoot).root.toLowerCase()) {
    throw new Error('Release path must be workspace-relative.');
  }

  assertOrdinaryPath(workspaceRoot, segments);
  return segments.join('/');
}

export function writeAtomicJson(root, relativePath, value) {
  const safePath = safeRelativePath(root, relativePath);
  const workspaceRoot = path.resolve(root);
  const destination = path.join(workspaceRoot, ...safePath.split('/'));
  const directory = path.dirname(destination);
  const serialized = Buffer.from(canonicalJson(value), 'utf8');
  const parentChain = directoryChainSnapshot(workspaceRoot, directory);
  const parentIdentity = parentChain[parentChain.length - 1].identity;
  const destinationBefore = optionalFileSnapshot(destination, 'Atomic destination');
  const temporary = path.join(
    directory,
    `.${path.basename(destination)}.${randomBytes(12).toString('hex')}.tmp`,
  );
  let descriptor;
  let directoryDescriptor;
  let temporaryState;
  try {
    directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    assertHeldDirectory(directoryDescriptor, parentIdentity);
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    const openedStat = bigFstat(descriptor);
    const openedState = contentStateOf(openedStat);
    temporaryState = openedState;
    if (!openedStat.isFile()) {
      throw new Error('Atomic temporary path must be an ordinary file.');
    }
    // Node exposes no openat/handle-relative rename. Revalidate the held parent
    // and the new wx file before any report bytes are written; a detected swap
    // can therefore leave at most this process's random zero-byte temp.
    assertDirectoryChainStable(parentChain);
    assertHeldDirectory(directoryDescriptor, parentIdentity);
    assertPathMatchesFile(temporary, openedState, 'Atomic temporary file');
    fs.writeFileSync(descriptor, serialized);
    fs.fsyncSync(descriptor);
    temporaryState = contentStateOf(bigFstat(descriptor));
    if (temporaryState.size !== BigInt(serialized.length)
      || !sameIdentity(temporaryState, openedState)) {
      throw new Error('Atomic temporary file changed while writing.');
    }
    assertPathMatchesFile(temporary, temporaryState, 'Atomic temporary file');
    assertDirectoryChainStable(parentChain);
    assertHeldDirectory(directoryDescriptor, parentIdentity);
    assertDestinationUnchanged(destination, destinationBefore);
    fs.renameSync(temporary, destination);
    const heldAfterRename = contentStateOf(bigFstat(descriptor));
    if (!sameContentState(heldAfterRename, temporaryState)) {
      throw new Error('Atomic temporary file identity changed across rename.');
    }
    assertDirectoryChainStable(parentChain);
    assertHeldDirectory(directoryDescriptor, parentIdentity);
    assertPathMatchesFile(destination, temporaryState, 'Atomic destination');
    syncDirectoryIfSupported(directoryDescriptor);
    assertDirectoryChainStable(parentChain);
    assertHeldDirectory(directoryDescriptor, parentIdentity);
    assertPathMatchesFile(destination, temporaryState, 'Atomic destination');
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.closeSync(directoryDescriptor);
    directoryDescriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Cleanup proceeds to the sibling path even when close itself failed.
      }
      descriptor = undefined;
    }
    if (directoryDescriptor !== undefined) {
      try {
        fs.closeSync(directoryDescriptor);
      } catch {
        // The primary atomic-write failure remains authoritative.
      }
    }
    throw error;
  }
  return safePath;
}

export function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
