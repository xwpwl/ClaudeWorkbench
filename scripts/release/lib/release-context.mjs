import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { canonicalJson, safeRelativePath } from './common.mjs';

const METADATA_PATH = 'release-validation/staging/release-metadata.json';
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT_SHA = /^[0-9a-f]{40,64}$/u;
const COMMIT_SHORT = /^[0-9a-f]{7,16}$/u;
const UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const NODE_VERSION = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

const INPUT_KEYS = ['workspaceRoot', 'releaseFacts', 'preparedMetadata'];
const FACT_KEYS = [
  'branch', 'dirty', 'commitSha', 'packageLockSha256', 'releaseNotesSha256',
  'sourceDateEpoch', 'toolchain',
];
const PREPARED_KEYS = ['relativePath', 'sha256'];
const TOOLCHAIN_KEYS = ['nodeVersion', 'npmVersion', 'electronVersion', 'platform', 'arch'];
const METADATA_KEYS = [
  'metadataSchemaVersion', 'purpose', 'productName', 'appId', 'version', 'channel',
  'buildId', 'branch', 'commitSha', 'commitShort', 'dirty', 'buildTimeUtc',
  'nodeVersion', 'npmVersion', 'electronVersion', 'sqliteSchemaVersion', 'platform',
  'arch', 'lockfileSha256', 'releaseNotesSha256',
];

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactObject(value, keys, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be a plain object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains unexpected or missing fields.`);
  }
}

function assertSha(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256.`);
  }
}

function parseStrictUtf8Json(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Prepared release metadata must be strict UTF-8 JSON.');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Prepared release metadata must be valid JSON.');
  }
  return parsed;
}

function expectedBuildId(metadata) {
  const stamp = metadata.buildTimeUtc.replace(/[-:]/gu, '');
  return `${metadata.version}+${metadata.commitShort}.${stamp}`;
}

function assertMetadata(metadata) {
  assertExactObject(metadata, METADATA_KEYS, 'Prepared release metadata');
  if (metadata.metadataSchemaVersion !== 1
    || metadata.purpose !== 'candidate'
    || metadata.productName !== 'Claude Workbench'
    || metadata.appId !== 'com.claudeworkbench.app'
    || metadata.version !== '1.0.1-rc.1'
    || metadata.channel !== 'rc'
    || metadata.branch !== 'task15'
    || metadata.dirty !== false
    || metadata.sqliteSchemaVersion !== 7
    || metadata.platform !== 'win32'
    || metadata.arch !== 'x64') {
    throw new Error('Prepared release metadata does not describe the approved candidate.');
  }
  if (typeof metadata.commitSha !== 'string' || !COMMIT_SHA.test(metadata.commitSha)
    || typeof metadata.commitShort !== 'string' || !COMMIT_SHORT.test(metadata.commitShort)
    || !metadata.commitSha.startsWith(metadata.commitShort)) {
    throw new Error('Prepared release metadata commit does not match.');
  }
  if (typeof metadata.buildTimeUtc !== 'string' || !UTC_SECONDS.test(metadata.buildTimeUtc)) {
    throw new Error('Prepared release metadata time is not canonical whole-second UTC.');
  }
  const parsedTime = new Date(metadata.buildTimeUtc);
  if (Number.isNaN(parsedTime.getTime())
    || parsedTime.toISOString().replace('.000Z', 'Z') !== metadata.buildTimeUtc) {
    throw new Error('Prepared release metadata time is invalid.');
  }
  if (metadata.buildId !== expectedBuildId(metadata)) {
    throw new Error('Prepared release metadata Build ID does not match.');
  }
  if (typeof metadata.nodeVersion !== 'string' || !NODE_VERSION.test(metadata.nodeVersion)
    || typeof metadata.npmVersion !== 'string' || !VERSION.test(metadata.npmVersion)
    || typeof metadata.electronVersion !== 'string' || !VERSION.test(metadata.electronVersion)) {
    throw new Error('Prepared release metadata toolchain is invalid.');
  }
  assertSha(metadata.lockfileSha256, 'Metadata lockfile hash');
  assertSha(metadata.releaseNotesSha256, 'Metadata release-notes hash');
}

function assertToolchain(toolchain) {
  assertExactObject(toolchain, TOOLCHAIN_KEYS, 'Release toolchain facts');
  if (typeof toolchain.nodeVersion !== 'string' || !NODE_VERSION.test(toolchain.nodeVersion)
    || typeof toolchain.npmVersion !== 'string' || !VERSION.test(toolchain.npmVersion)
    || typeof toolchain.electronVersion !== 'string' || !VERSION.test(toolchain.electronVersion)
    || toolchain.platform !== 'win32' || toolchain.arch !== 'x64') {
    throw new Error('Release toolchain facts do not describe Windows x64.');
  }
}

function sameCanonicalPath(left, right) {
  const normalize = (value) => path.resolve(value).replace(/[\\/]+$/u, '').toLowerCase();
  return normalize(left) === normalize(right);
}

function identityOf(stat) {
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function stableStateOf(stat) {
  return Object.freeze({
    ...identityOf(stat),
    size: stat.size,
    mode: stat.mode,
    mtimeNs: stat.mtimeNs,
  });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableState(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs;
}

function stablePathSnapshot(filePath, kind, label) {
  const before = fs.lstatSync(filePath, { bigint: true });
  if (before.isSymbolicLink()
    || (kind === 'file' && !before.isFile())
    || (kind === 'directory' && !before.isDirectory())) {
    throw new Error(`${label} must be an ordinary ${kind}; reparse points are forbidden.`);
  }
  const canonical = fs.realpathSync.native(filePath);
  if (!sameCanonicalPath(canonical, filePath)) {
    throw new Error(`${label} must not traverse a reparse point.`);
  }
  const after = fs.lstatSync(filePath, { bigint: true });
  const beforeState = stableStateOf(before);
  const afterState = stableStateOf(after);
  if (!sameStableState(beforeState, afterState)) {
    throw new Error(`${label} identity changed during validation.`);
  }
  return afterState;
}

function parentChainSnapshot(root, filePath) {
  const workspaceRoot = path.resolve(root);
  const parent = path.dirname(filePath);
  const relative = path.relative(workspaceRoot, parent);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Prepared release metadata parent must remain inside the workspace.');
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
      identity: stablePathSnapshot(current, 'directory', 'Prepared metadata parent'),
    });
  }
  return snapshots;
}

function assertParentChainStable(snapshots) {
  for (const snapshot of snapshots) {
    const current = stablePathSnapshot(
      snapshot.path,
      'directory',
      'Prepared metadata parent',
    );
    if (!sameIdentity(current, snapshot.identity)) {
      throw new Error('Prepared metadata parent identity changed.');
    }
  }
}

function readStableMetadataFile(workspaceRoot, metadataAbsolutePath) {
  const parentChain = parentChainSnapshot(workspaceRoot, metadataAbsolutePath);
  const pathBeforeOpen = stablePathSnapshot(
    metadataAbsolutePath,
    'file',
    'Prepared release metadata',
  );
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = fs.openSync(metadataAbsolutePath, fs.constants.O_RDONLY | noFollow);
    const heldBeforeReadStat = fs.fstatSync(descriptor, { bigint: true });
    if (!heldBeforeReadStat.isFile()) {
      throw new Error('Prepared release metadata handle must reference an ordinary file.');
    }
    const heldBeforeRead = stableStateOf(heldBeforeReadStat);
    if (!sameStableState(heldBeforeRead, pathBeforeOpen)) {
      throw new Error('Prepared release metadata identity changed while opening.');
    }
    assertParentChainStable(parentChain);
    const pathAfterOpen = stablePathSnapshot(
      metadataAbsolutePath,
      'file',
      'Prepared release metadata',
    );
    if (!sameStableState(pathAfterOpen, heldBeforeRead)) {
      throw new Error('Prepared release metadata path identity drifted after opening.');
    }

    const bytes = fs.readFileSync(descriptor);
    const heldAfterReadStat = fs.fstatSync(descriptor, { bigint: true });
    if (!heldAfterReadStat.isFile()) {
      throw new Error('Prepared release metadata handle changed type while reading.');
    }
    const heldAfterRead = stableStateOf(heldAfterReadStat);
    if (!sameStableState(heldAfterRead, heldBeforeRead)) {
      throw new Error('Prepared release metadata bytes changed while reading.');
    }
    assertParentChainStable(parentChain);
    const pathAfterRead = stablePathSnapshot(
      metadataAbsolutePath,
      'file',
      'Prepared release metadata',
    );
    if (!sameStableState(pathAfterRead, heldAfterRead)) {
      throw new Error('Prepared release metadata path identity drifted after reading.');
    }
    const heldAtReturn = stableStateOf(fs.fstatSync(descriptor, { bigint: true }));
    if (!sameStableState(heldAtReturn, heldAfterRead)) {
      throw new Error('Prepared release metadata did not remain stable after reading.');
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function freezeContext(value) {
  Object.freeze(value.toolchain);
  return Object.freeze(value);
}

export function createReleaseContext(input) {
  assertExactObject(input, INPUT_KEYS, 'Release context input');
  assertExactObject(input.releaseFacts, FACT_KEYS, 'Release facts');
  assertExactObject(input.preparedMetadata, PREPARED_KEYS, 'Prepared metadata identity');
  const { releaseFacts, preparedMetadata } = input;
  if (releaseFacts.branch !== 'task15') throw new Error('Release branch must be task15.');
  if (releaseFacts.dirty !== false) throw new Error('Release worktree must be clean.');
  if (typeof releaseFacts.commitSha !== 'string' || !COMMIT_SHA.test(releaseFacts.commitSha)) {
    throw new Error('Release commit is invalid.');
  }
  assertSha(releaseFacts.packageLockSha256, 'Release package-lock hash');
  assertSha(releaseFacts.releaseNotesSha256, 'Release notes hash');
  if (!Number.isSafeInteger(releaseFacts.sourceDateEpoch) || releaseFacts.sourceDateEpoch < 0) {
    throw new Error('Release source time must be a normalized integer epoch.');
  }
  assertToolchain(releaseFacts.toolchain);
  assertSha(preparedMetadata.sha256, 'Prepared metadata hash');
  if (preparedMetadata.relativePath !== METADATA_PATH) {
    throw new Error('Prepared release metadata must use the fixed snapshot path.');
  }

  const metadataPath = safeRelativePath(input.workspaceRoot, preparedMetadata.relativePath);
  const metadataAbsolutePath = path.join(
    path.resolve(input.workspaceRoot),
    ...metadataPath.split('/'),
  );
  const bytes = readStableMetadataFile(input.workspaceRoot, metadataAbsolutePath);
  const observedHash = createHash('sha256').update(bytes).digest('hex');
  if (observedHash !== preparedMetadata.sha256) {
    throw new Error('Prepared release metadata hash does not match the snapshot bytes.');
  }
  const metadata = parseStrictUtf8Json(bytes);
  assertMetadata(metadata);

  if (metadata.commitSha !== releaseFacts.commitSha
    || metadata.branch !== releaseFacts.branch
    || metadata.dirty !== releaseFacts.dirty) {
    throw new Error('Prepared release metadata Git facts drift from the release facts.');
  }
  if (metadata.lockfileSha256 !== releaseFacts.packageLockSha256) {
    throw new Error('Prepared release metadata lock hash does not match the release facts.');
  }
  if (metadata.releaseNotesSha256 !== releaseFacts.releaseNotesSha256) {
    throw new Error('Prepared release metadata notes hash does not match the release facts.');
  }
  const epoch = Math.floor(new Date(metadata.buildTimeUtc).getTime() / 1_000);
  if (epoch !== releaseFacts.sourceDateEpoch) {
    throw new Error('Prepared release metadata time does not match the normalized release time.');
  }
  for (const key of TOOLCHAIN_KEYS) {
    if (metadata[key] !== releaseFacts.toolchain[key]) {
      throw new Error('Prepared release metadata toolchain facts drift from the release facts.');
    }
  }

  const safeFacts = {
    schemaVersion: 1,
    branch: metadata.branch,
    dirty: metadata.dirty,
    commitSha: metadata.commitSha,
    version: metadata.version,
    channel: metadata.channel,
    buildId: metadata.buildId,
    metadataPath,
    metadataSha256: observedHash,
    packageLockSha256: metadata.lockfileSha256,
    releaseNotesSha256: metadata.releaseNotesSha256,
    sourceDateEpoch: epoch,
    toolchain: {
      nodeVersion: metadata.nodeVersion,
      npmVersion: metadata.npmVersion,
      electronVersion: metadata.electronVersion,
      platform: metadata.platform,
      arch: metadata.arch,
    },
  };
  const contextId = createHash('sha256').update(canonicalJson(safeFacts)).digest('hex');
  return freezeContext({ contextId, ...safeFacts });
}
