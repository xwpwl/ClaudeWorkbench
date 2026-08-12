import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CANDIDATE_VERSION = '1.0.1-rc.1';
const RELEASE_NOTES_PATH = 'docs/releases/1.0.1-rc.1.md';
const OUTPUT_PATH = 'release-validation/staging/release-metadata.json';
const EARLIEST_EPOCH_SECONDS = 946_684_800;
const TRUSTED_GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';
const RELEASE_CONTRACT_KEYS = [
  'metadataSchemaVersion',
  'sqliteSchemaVersion',
  'approvedPublisherSubjects',
  'approvedPublisherThumbprints',
];
const MAX_APPROVED_PUBLISHER_ENTRIES = 64;
const MAX_APPROVED_PUBLISHER_VALUE_LENGTH = 512;
const FORBIDDEN_PUBLISHER_POLICY_CHARACTERS = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readJson(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed;
}

function wholeSecondUtc(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error('Release timestamp is invalid.');
  }
  return new Date(Math.floor(date.getTime() / 1_000) * 1_000)
    .toISOString()
    .replace('.000Z', 'Z');
}

function resolveBuildTime({ now, sourceDateEpoch }) {
  const observedNow = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (Number.isNaN(observedNow.getTime())) throw new Error('Release timestamp is invalid.');
  if (sourceDateEpoch === undefined) return wholeSecondUtc(observedNow);
  if (typeof sourceDateEpoch !== 'string' || !/^\d+$/u.test(sourceDateEpoch)) {
    throw new Error('SOURCE_DATE_EPOCH must be a bounded integer UTC epoch.');
  }
  const epochSeconds = Number(sourceDateEpoch);
  if (!Number.isSafeInteger(epochSeconds)
    || epochSeconds < EARLIEST_EPOCH_SECONDS
    || epochSeconds > Math.floor(observedNow.getTime() / 1_000)) {
    throw new Error('SOURCE_DATE_EPOCH must be a bounded integer UTC epoch without future skew.');
  }
  return wholeSecondUtc(new Date(epochSeconds * 1_000));
}

function exactObjectKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function validPublisherPolicyArray(value) {
  if (!Array.isArray(value) || value.length > MAX_APPROVED_PUBLISHER_ENTRIES) {
    return false;
  }
  const unique = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string'
      || entry.length === 0
      || entry.length > MAX_APPROVED_PUBLISHER_VALUE_LENGTH
      || entry !== entry.trim()
      || FORBIDDEN_PUBLISHER_POLICY_CHARACTERS.test(entry)
      || unique.has(entry)) {
      return false;
    }
    unique.add(entry);
  }
  return true;
}

export function projectReleaseMetadataContract(validatedContract) {
  if (!validatedContract
    || typeof validatedContract !== 'object'
    || Array.isArray(validatedContract)
    || !exactObjectKeys(validatedContract, RELEASE_CONTRACT_KEYS)
    || validatedContract.metadataSchemaVersion !== 1
    || validatedContract.sqliteSchemaVersion !== 7
    || !validPublisherPolicyArray(validatedContract.approvedPublisherSubjects)
    || !validPublisherPolicyArray(validatedContract.approvedPublisherThumbprints)) {
    throw new Error('Release contract contains unexpected static facts.');
  }
  return {
    metadataSchemaVersion: validatedContract.metadataSchemaVersion,
    sqliteSchemaVersion: validatedContract.sqliteSchemaVersion,
  };
}

function assertObservedVersions(versions) {
  if (!versions || typeof versions !== 'object'
    || !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(versions.nodeVersion)
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(versions.npmVersion)
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(versions.electronVersion)
    || versions.platform !== 'win32'
    || versions.arch !== 'x64') {
    throw new Error('Release runtime versions must describe the approved Windows x64 toolchain.');
  }
}

export function buildId({ version, commitShort, buildTimeUtc }) {
  const stamp = buildTimeUtc.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
  return `${version}+${commitShort}.${stamp}`;
}

export function assertReleaseGit({ branch, dirty, commitSha }) {
  if (branch !== 'task15') throw new Error('Release branch must be task15.');
  if (dirty !== false) throw new Error('Release worktree must be clean.');
  if (!/^[0-9a-f]{40,64}$/u.test(commitSha)) throw new Error('Release commit is invalid.');
}

export function createReleaseMetadata({
  workspace,
  now = new Date(),
  sourceDateEpoch,
  git,
  versions,
}) {
  const workspaceRoot = path.resolve(workspace);
  assertReleaseGit(git);
  assertObservedVersions(versions);

  const packagePath = path.join(workspaceRoot, 'package.json');
  const lockfilePath = path.join(workspaceRoot, 'package-lock.json');
  const contractPath = path.join(workspaceRoot, 'src', 'shared', 'release-contract.json');
  const notesPath = path.join(workspaceRoot, ...RELEASE_NOTES_PATH.split('/'));
  const packageJson = readJson(packagePath, 'package.json');
  const packageLock = readJson(lockfilePath, 'package-lock.json');
  const contract = readJson(contractPath, 'release contract');
  const metadataContract = projectReleaseMetadataContract(contract);

  if (packageJson.version !== CANDIDATE_VERSION
    || packageLock.version !== packageJson.version
    || packageLock.packages?.['']?.version !== packageJson.version) {
    throw new Error('Package and lockfile versions must match the candidate version.');
  }
  const buildTimeUtc = resolveBuildTime({ now, sourceDateEpoch });
  const commitShort = git.commitSha.slice(0, 12);
  const lockfileBytes = fs.readFileSync(lockfilePath);
  const releaseNotesBytes = fs.readFileSync(notesPath);

  return {
    metadataSchemaVersion: metadataContract.metadataSchemaVersion,
    purpose: 'candidate',
    productName: 'Claude Workbench',
    appId: 'com.claudeworkbench.app',
    version: packageJson.version,
    channel: 'rc',
    buildId: buildId({ version: packageJson.version, commitShort, buildTimeUtc }),
    branch: git.branch,
    commitSha: git.commitSha,
    commitShort,
    dirty: git.dirty,
    buildTimeUtc,
    nodeVersion: versions.nodeVersion,
    npmVersion: versions.npmVersion,
    electronVersion: versions.electronVersion,
    sqliteSchemaVersion: metadataContract.sqliteSchemaVersion,
    platform: versions.platform,
    arch: versions.arch,
    lockfileSha256: sha256(lockfileBytes),
    releaseNotesSha256: sha256(releaseNotesBytes),
  };
}

export function writeReleaseMetadataSnapshot({ workspace, metadata }) {
  const workspaceRoot = path.resolve(workspace);
  const outputPath = path.join(workspaceRoot, ...OUTPUT_PATH.split('/'));
  const outputDirectory = path.dirname(outputPath);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const temporaryPath = path.join(
    outputDirectory,
    `.release-metadata.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, outputPath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The temporary path either was never created or was already renamed.
    }
    throw error;
  }
  return outputPath;
}

function sameCanonicalPath(left, right) {
  const normalize = (value) => path.resolve(value).replace(/[\\/]+$/u, '').toLowerCase();
  return normalize(left) === normalize(right);
}

function trustedGitExecutable() {
  const resolved = path.resolve(TRUSTED_GIT);
  let current = path.parse(resolved).root;
  for (const component of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('Trusted Git executable is unavailable.');
  }
  const stat = fs.lstatSync(resolved);
  const real = fs.realpathSync.native(resolved);
  if (!stat.isFile() || !sameCanonicalPath(real, resolved)) {
    throw new Error('Trusted Git executable is unavailable.');
  }
  return real;
}

function minimalGitEnvironment() {
  const environment = {};
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PATHEXT']) {
    if (typeof process.env[key] === 'string') environment[key] = process.env[key];
  }
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: 'NUL',
    GIT_CONFIG_COUNT: '0',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    LC_ALL: 'C',
  };
}

function trustedGit(workspace, args) {
  return execFileSync(trustedGitExecutable(), ['-C', workspace, ...args], {
    encoding: 'utf8',
    env: minimalGitEnvironment(),
    maxBuffer: 4096,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

function observedNpmVersion() {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return execFileSync(process.execPath, [npmCli, '--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

function cli() {
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const commitSha = trustedGit(workspace, ['rev-parse', 'HEAD']);
  const branch = trustedGit(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirty = trustedGit(workspace, ['status', '--porcelain=v1', '--untracked-files=all']).length > 0;
  const electronPackage = readJson(
    path.join(workspace, 'node_modules', 'electron', 'package.json'),
    'Electron package metadata',
  );
  const metadata = createReleaseMetadata({
    workspace,
    now: new Date(),
    sourceDateEpoch: process.env.SOURCE_DATE_EPOCH,
    git: { branch, dirty, commitSha },
    versions: {
      nodeVersion: process.version,
      npmVersion: observedNpmVersion(),
      electronVersion: electronPackage.version,
      platform: process.platform,
      arch: process.arch,
    },
  });
  writeReleaseMetadataSnapshot({ workspace, metadata });
  process.stdout.write('release-metadata.json written.\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    cli();
  } catch {
    process.stderr.write('Release metadata generation failed.\n');
    process.exitCode = 1;
  }
}
