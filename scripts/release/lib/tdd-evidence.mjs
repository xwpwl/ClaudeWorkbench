import { createHash, randomBytes } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  TDD_REQUIREMENT_CASES,
  assertTddCommandAssignment,
  assertTddTestReferences,
  getTddPhase,
} from '../requirements-contract.mjs';

const execFile = promisify(execFileCallback);
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFAULT_EVIDENCE_PATH = path.join(MODULE_ROOT, 'release-validation', 'tdd', 'requirements-tdd-evidence.json');
const ROOT_KEYS = ['entries', 'schemaVersion'];
const RECORD_KEYS = [
  'caseIds', 'commandId', 'exitCategory', 'observedAtUtc', 'phase', 'plannedTestReferences',
  'previousRecordSha256', 'recordSha256', 'sequence', 'trackedFileHashes',
];
const WINDOWS_TRUSTED_GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';
let trustedGitExecutablePromise;

function sameCanonicalPath(left, right) {
  const normalize = (value) => path.resolve(value).replace(/[\\/]+$/u, '');
  return process.platform === 'win32'
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);
}

function containedBy(root, candidate, allowRoot = false) {
  const relative = path.relative(root, candidate);
  return (allowRoot && relative === '')
    || (relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function minimalEnvironment(extra = {}) {
  const inheritedKeys = process.platform === 'win32'
    ? ['SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PATHEXT']
    : ['TMPDIR'];
  const environment = {};
  for (const key of inheritedKeys) {
    if (typeof process.env[key] === 'string') environment[key] = process.env[key];
  }
  return { ...environment, LANG: 'C', LC_ALL: 'C', ...extra };
}

export function minimalChildEnvironment() {
  return minimalEnvironment();
}

async function trustedGitExecutable() {
  trustedGitExecutablePromise ??= (async () => {
    const configured = process.platform === 'win32' ? WINDOWS_TRUSTED_GIT : '/usr/bin/git';
    if (!path.isAbsolute(configured)) throw new Error('Trusted Git executable is unavailable.');
    const [real, stat] = await Promise.all([fs.realpath(configured), fs.lstat(configured)]);
    if (!stat.isFile() || stat.isSymbolicLink() || !sameCanonicalPath(real, configured)) {
      throw new Error('Trusted Git executable is unavailable.');
    }
    return real;
  })();
  return trustedGitExecutablePromise;
}

export async function runTrustedGit(args, options = {}) {
  const executable = await trustedGitExecutable();
  return execFile(executable, args, {
    windowsHide: true,
    maxBuffer: 4096,
    ...options,
    env: minimalEnvironment({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_COUNT: '0',
      GIT_TERMINAL_PROMPT: '0',
    }),
  });
}

async function rejectReparseComponents(absolutePath, { allowMissingTail = false } = {}) {
  const resolved = path.resolve(absolutePath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (allowMissingTail && error?.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('Workspace paths must not traverse a reparse point.');
  }
}

export async function assertCanonicalWorkspace(workspaceRoot) {
  const resolved = path.resolve(workspaceRoot);
  await rejectReparseComponents(resolved);
  const real = await fs.realpath(resolved);
  if (!sameCanonicalPath(real, resolved)) throw new Error('Workspace root must be canonical.');
  return real;
}

async function ensureContainedDirectory(workspaceRoot, directoryPath) {
  const resolved = path.resolve(directoryPath);
  if (!containedBy(workspaceRoot, resolved, true)) throw new Error('Evidence path must stay inside the workspace.');
  const relative = path.relative(workspaceRoot, resolved);
  let current = workspaceRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const existing = await fs.lstat(current);
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Evidence path must not traverse a reparse point.');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await fs.mkdir(current);
      const created = await fs.lstat(current);
      if (!created.isDirectory() || created.isSymbolicLink()) throw new Error('Evidence directory is unsafe.');
    }
    const real = await fs.realpath(current);
    if (!containedBy(workspaceRoot, real, true) || !sameCanonicalPath(real, current)) {
      throw new Error('Evidence path must stay inside the workspace without reparse traversal.');
    }
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFileState(left, right) {
  return sameFileIdentity(left, right)
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function inspectContainedRegularPath(workspaceRoot, filePath, errorMessage) {
  try {
    await rejectReparseComponents(filePath);
    const [real, pathStat] = await Promise.all([
      fs.realpath(filePath),
      fs.lstat(filePath, { bigint: true }),
    ]);
    if (!containedBy(workspaceRoot, real) || !sameCanonicalPath(real, filePath)
      || !pathStat.isFile() || pathStat.isSymbolicLink()) {
      throw new Error(errorMessage);
    }
    await rejectReparseComponents(filePath);
    const [finalReal, finalPathStat] = await Promise.all([
      fs.realpath(filePath),
      fs.lstat(filePath, { bigint: true }),
    ]);
    if (!sameCanonicalPath(finalReal, real) || !sameStableFileState(pathStat, finalPathStat)) {
      throw new Error(errorMessage);
    }
    return finalPathStat;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') throw error;
    throw new Error(errorMessage);
  }
}

async function validateOpenedContainedFile(workspaceRoot, filePath, handle, expectedIdentity = null, errorMessage = 'Evidence file identity is unsafe.') {
  const pathStat = await inspectContainedRegularPath(workspaceRoot, filePath, errorMessage);
  const handleStat = await handle.stat({ bigint: true });
  if (!sameFileIdentity(pathStat, handleStat)
    || (expectedIdentity && !sameFileIdentity(expectedIdentity, handleStat))) {
    throw new Error(errorMessage);
  }
  return handleStat;
}

async function unlinkIfSameContainedFile(workspaceRoot, filePath, expectedIdentity) {
  try {
    await rejectReparseComponents(filePath);
    const [real, current] = await Promise.all([fs.realpath(filePath), fs.lstat(filePath, { bigint: true })]);
    if (containedBy(workspaceRoot, real) && sameCanonicalPath(real, filePath)
      && current.isFile() && !current.isSymbolicLink() && sameFileIdentity(current, expectedIdentity)) {
      await fs.unlink(filePath);
    }
  } catch {
    // Fail closed without deleting an object whose identity or containment is no longer proven.
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function recordHash(record) {
  const { recordSha256, ...unsigned } = record;
  return sha256(canonicalJson(unsigned));
}

function exactKeys(value, expectedKeys) {
  return value && typeof value === 'object'
    && Object.keys(value).sort().join(',') === [...expectedKeys].sort().join(',');
}

function sameArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((item, index) => item === expected[index]);
}

function safeRelativePath(workspaceRoot, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)
    || /^[a-z]:/iu.test(relativePath) || relativePath.includes('\\')) {
    throw new Error('Only workspace-relative tracked paths are permitted.');
  }
  const resolved = path.resolve(workspaceRoot, relativePath);
  const relative = path.relative(workspaceRoot, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Only workspace-relative tracked paths are permitted.');
  }
  return relative.split(path.sep).join('/');
}

async function defaultIsTrackedPath(workspaceRoot, relativePath) {
  try {
    await runTrustedGit(['-C', workspaceRoot, 'ls-files', '--error-unmatch', '--', relativePath]);
    return true;
  } catch {
    return false;
  }
}

function emptyHistory() {
  return { schemaVersion: 1, entries: [] };
}

function assertRecordSemantics(record, previous) {
  if (!exactKeys(record, RECORD_KEYS)
    || !Number.isInteger(record.sequence) || record.sequence !== (previous?.sequence ?? 0) + 1
    || !['red', 'green'].includes(record.phase)
    || !['nonzero', 'zero'].includes(record.exitCategory)
    || (record.phase === 'red' && record.exitCategory !== 'nonzero')
    || (record.phase === 'green' && record.exitCategory !== 'zero')
    || typeof record.observedAtUtc !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(record.observedAtUtc)
    || Number.isNaN(Date.parse(record.observedAtUtc)) || new Date(record.observedAtUtc).toISOString() !== record.observedAtUtc
    || (previous && Date.parse(record.observedAtUtc) < Date.parse(previous.observedAtUtc))
    || record.previousRecordSha256 !== (previous?.recordSha256 ?? null)
    || typeof record.recordSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(record.recordSha256)
    || record.recordSha256 !== recordHash(record)) {
    throw new Error('Evidence integrity validation failed.');
  }

  let slice;
  try {
    slice = assertTddCommandAssignment({ commandId: record.commandId, caseIds: record.caseIds });
    assertTddTestReferences(record.commandId, record.phase, record.plannedTestReferences);
  } catch {
    throw new Error('Evidence integrity validation failed.');
  }

  if (!Array.isArray(record.trackedFileHashes)
    || new Set(record.trackedFileHashes.map((entry) => entry?.path)).size !== record.trackedFileHashes.length
    || record.trackedFileHashes.some((entry) => !exactKeys(entry, ['path', 'sha256'])
      || typeof entry.path !== 'string' || path.isAbsolute(entry.path) || entry.path.includes('\\')
      || !/^[a-f0-9]{64}$/u.test(entry.sha256))) {
    throw new Error('Evidence integrity validation failed.');
  }

  const phaseDefinition = getTddPhase(record.commandId, record.phase);
  const actualPaths = record.trackedFileHashes.map(({ path: storedPath }) => storedPath);
  const testPaths = phaseDefinition.testReferences;
  const sourcePaths = slice.relatedSourcePaths;
  const expectedGreenPaths = [...testPaths, ...sourcePaths];
  const expectedRedPrefix = actualPaths.slice(0, testPaths.length);
  const redSources = actualPaths.slice(testPaths.length);
  const validRedSources = redSources.every((storedPath, index) => sourcePaths.indexOf(storedPath) >= 0
    && sourcePaths.indexOf(storedPath) > (index === 0 ? -1 : sourcePaths.indexOf(redSources[index - 1])));
  if (!sameArray(expectedRedPrefix, testPaths)
    || (record.phase === 'green' && !sameArray(actualPaths, expectedGreenPaths))
    || (record.phase === 'red' && !validRedSources)) {
    throw new Error('Evidence integrity validation failed.');
  }
}

function assertHistory(history) {
  if (!exactKeys(history, ROOT_KEYS) || history.schemaVersion !== 1 || !Array.isArray(history.entries)) {
    throw new Error('Evidence integrity validation failed.');
  }
  const states = new Map();
  let previous = null;
  for (const record of history.entries) {
    assertRecordSemantics(record, previous);
    const state = states.get(record.commandId) ?? 'none';
    if ((state === 'none' && record.phase !== 'red')
      || (state === 'red' && record.phase !== 'green')
      || state === 'green') {
      throw new Error('Evidence integrity validation failed.');
    }
    states.set(record.commandId, record.phase);
    previous = record;
  }
  return previous;
}

async function loadHistory(evidencePath, workspaceRoot) {
  try {
    const expectedIdentity = await inspectContainedRegularPath(workspaceRoot, evidencePath, 'unsafe evidence file');
    const handle = await fs.open(evidencePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const before = await validateOpenedContainedFile(workspaceRoot, evidencePath, handle, expectedIdentity);
      const content = await handle.readFile('utf8');
      const after = await validateOpenedContainedFile(workspaceRoot, evidencePath, handle, expectedIdentity);
      if (!sameStableFileState(before, after)) {
        throw new Error('unsafe evidence file');
      }
      return JSON.parse(content);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return emptyHistory();
    throw new Error('Evidence integrity validation failed.');
  }
}

async function acquireLock(evidencePath, workspaceRoot) {
  const lockPath = `${evidencePath}.lock`;
  await ensureContainedDirectory(workspaceRoot, path.dirname(lockPath));
  try {
    const handle = await fs.open(lockPath, 'wx', 0o600);
    try {
      const identity = await validateOpenedContainedFile(workspaceRoot, lockPath, handle);
      return { handle, identity, path: lockPath };
    } catch (error) {
      const identity = await handle.stat({ bigint: true }).catch(() => null);
      await handle.close().catch(() => undefined);
      if (identity) await unlinkIfSameContainedFile(workspaceRoot, lockPath, identity);
      throw error;
    }
  } catch {
    throw new Error('Evidence recorder is already active.');
  }
}

async function writeHistoryAtomically(evidencePath, history, workspaceRoot) {
  const serialized = `${canonicalJson(history)}\n`;
  const temporaryPath = `${evidencePath}.${randomBytes(12).toString('hex')}.tmp`;
  let handle;
  let temporaryIdentity;
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    temporaryIdentity = await validateOpenedContainedFile(workspaceRoot, temporaryPath, handle);
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await validateOpenedContainedFile(workspaceRoot, temporaryPath, handle);
    await handle.close();
    handle = null;
    await ensureContainedDirectory(workspaceRoot, path.dirname(evidencePath));
    await fs.rename(temporaryPath, evidencePath);
    const written = await fs.open(evidencePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const destinationIdentity = await validateOpenedContainedFile(workspaceRoot, evidencePath, written);
      if (!sameFileIdentity(destinationIdentity, temporaryIdentity)) throw new Error('Evidence file identity changed during rename.');
    } finally {
      await written.close();
    }
  } catch {
    await handle?.close().catch(() => undefined);
    if (temporaryIdentity) await unlinkIfSameContainedFile(workspaceRoot, temporaryPath, temporaryIdentity);
    throw new Error('Evidence could not be appended atomically.');
  }
}

async function readRegularFile({ workspaceRoot, relativePath, isTrackedPath, kind, requireTracked, fileReadHooks }) {
  const safePath = safeRelativePath(workspaceRoot, relativePath);
  const absolutePath = path.join(workspaceRoot, safePath);
  const errorMessage = `Required ${kind} changed while it was being read.`;
  let expectedIdentity;
  try {
    expectedIdentity = await inspectContainedRegularPath(workspaceRoot, absolutePath, `Required ${kind} must be a ${requireTracked ? 'tracked ' : ''}regular file.`);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(`Required ${kind} is missing.`);
    }
    if (error instanceof Error && error.message.includes('regular file')) throw error;
    throw new Error(`Required ${kind} is unavailable.`);
  }
  if (requireTracked && !await isTrackedPath(safePath)) {
    throw new Error(`Required ${kind} must be a ${requireTracked ? 'tracked ' : ''}regular file.`);
  }
  const afterTrackingIdentity = await inspectContainedRegularPath(workspaceRoot, absolutePath, errorMessage);
  if (!sameFileIdentity(expectedIdentity, afterTrackingIdentity)) throw new Error(errorMessage);
  expectedIdentity = afterTrackingIdentity;
  await fileReadHooks?.beforeOpen?.({ absolutePath, relativePath: safePath, kind });
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(absolutePath, flags);
  try {
    await fileReadHooks?.afterOpen?.({ absolutePath, relativePath: safePath, kind });
    const before = await validateOpenedContainedFile(workspaceRoot, absolutePath, handle, expectedIdentity, errorMessage);
    const content = await handle.readFile();
    await fileReadHooks?.afterRead?.({ absolutePath, relativePath: safePath, kind });
    const after = await validateOpenedContainedFile(workspaceRoot, absolutePath, handle, expectedIdentity, errorMessage);
    if (!sameStableFileState(before, after)) throw new Error(errorMessage);
    return content;
  } finally {
    await handle.close();
  }
}

async function trackedFileHashes({ workspaceRoot, slice, phase, observedTestReferences, isTrackedPath, fileReadHooks }) {
  const hashes = [];
  for (const testReference of observedTestReferences) {
    const content = await readRegularFile({ workspaceRoot, relativePath: testReference, isTrackedPath, kind: 'focused test', requireTracked: phase === 'green', fileReadHooks });
    hashes.push({ path: testReference, sha256: sha256(content) });
  }
  for (const sourcePath of slice.relatedSourcePaths) {
    try {
      const content = await readRegularFile({ workspaceRoot, relativePath: sourcePath, isTrackedPath, kind: 'implementation source', requireTracked: phase === 'green', fileReadHooks });
      hashes.push({ path: sourcePath, sha256: sha256(content) });
    } catch (error) {
      if (phase === 'red' && error instanceof Error && error.message === 'Required implementation source is missing.') continue;
      throw error;
    }
  }
  return hashes;
}

function assertChronology(history, commandId, phase) {
  const state = history.entries.find((entry) => entry.commandId === commandId)?.phase ?? 'none';
  if ((state === 'none' && phase !== 'red') || (state === 'red' && phase !== 'green') || state === 'green') {
    throw new Error('Evidence chronology is invalid.');
  }
}

async function runRunner(runner) {
  try {
    const result = await runner();
    const exitCode = Number(result?.exitCode);
    if (!Number.isInteger(exitCode)) throw new Error('invalid exit status');
    return exitCode;
  } catch {
    return 1;
  }
}

export async function runObservedTddCommand({
  phase,
  caseIds,
  commandId,
  observedTestReferences,
  runner,
  evidencePath = DEFAULT_EVIDENCE_PATH,
  workspaceRoot = MODULE_ROOT,
  isTrackedPath = (relativePath) => defaultIsTrackedPath(workspaceRoot, relativePath),
  now = () => new Date(),
  fileReadHooks,
}) {
  if (!['red', 'green'].includes(phase) || typeof runner !== 'function') {
    throw new Error('The TDD observation request is invalid.');
  }
  if (fileReadHooks !== undefined && (fileReadHooks === null || typeof fileReadHooks !== 'object'
    || Object.entries(fileReadHooks).some(([name, hook]) => !['beforeOpen', 'afterOpen', 'afterRead'].includes(name) || typeof hook !== 'function'))) {
    throw new Error('The TDD observation request is invalid.');
  }
  const slice = assertTddCommandAssignment({ commandId, caseIds });
  assertTddTestReferences(commandId, phase, observedTestReferences);
  const canonicalWorkspaceRoot = await assertCanonicalWorkspace(workspaceRoot);
  const resolvedEvidencePath = path.resolve(evidencePath);
  if (!containedBy(canonicalWorkspaceRoot, resolvedEvidencePath)) {
    throw new Error('Evidence path must stay inside the workspace.');
  }
  const lock = await acquireLock(resolvedEvidencePath, canonicalWorkspaceRoot);
  try {
    const history = await loadHistory(resolvedEvidencePath, canonicalWorkspaceRoot);
    const previous = assertHistory(history);
    assertChronology(history, commandId, phase);
    await trackedFileHashes({
      workspaceRoot: canonicalWorkspaceRoot,
      slice,
      phase,
      observedTestReferences,
      isTrackedPath,
      fileReadHooks,
    });
    const exitCode = await runRunner(runner);
    if ((phase === 'red' && exitCode === 0) || (phase === 'green' && exitCode !== 0)) {
      throw new Error(phase === 'red'
        ? 'Observed red evidence requires a nonzero result.'
        : 'Observed green evidence requires a zero result.');
    }
    const observedAt = now();
    if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) {
      throw new Error('The TDD observation clock is invalid.');
    }
    const record = {
      caseIds: [...slice.caseIds],
      commandId: slice.commandId,
      exitCategory: exitCode === 0 ? 'zero' : 'nonzero',
      observedAtUtc: observedAt.toISOString(),
      phase,
      plannedTestReferences: [...observedTestReferences],
      previousRecordSha256: previous?.recordSha256 ?? null,
      sequence: (previous?.sequence ?? 0) + 1,
      trackedFileHashes: await trackedFileHashes({
        workspaceRoot: canonicalWorkspaceRoot,
        slice,
        phase,
        observedTestReferences,
        isTrackedPath,
        fileReadHooks,
      }),
    };
    record.recordSha256 = recordHash(record);
    assertRecordSemantics(record, previous);
    const nextHistory = { schemaVersion: 1, entries: [...history.entries, record] };
    assertHistory(nextHistory);
    await writeHistoryAtomically(resolvedEvidencePath, nextHistory, canonicalWorkspaceRoot);
    return {
      phase: record.phase,
      caseIds: record.caseIds,
      commandId: record.commandId,
      exitCategory: record.exitCategory,
      sequence: record.sequence,
    };
  } finally {
    await lock.handle.close().catch(() => undefined);
    await unlinkIfSameContainedFile(canonicalWorkspaceRoot, lock.path, lock.identity);
  }
}

export { DEFAULT_EVIDENCE_PATH, TDD_REQUIREMENT_CASES };
