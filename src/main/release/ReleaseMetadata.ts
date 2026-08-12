import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import releaseContract from '../../shared/release-contract.json';
import type {
  LocalUpdateFixtureMetadata,
  ReleaseMetadata,
  ReleaseRuntimeStatus,
  ReleaseVersionInfo,
  RuntimeMetadata,
} from '../../shared/types/release';

declare const __WORKBENCH_RELEASE_METADATA_JSON__: string;
declare const __WORKBENCH_LOCAL_UPDATE_FIXTURE__: boolean;

const CANDIDATE_VERSION = '1.0.1-rc.1';
const FIXTURE_VERSION = '1.0.1-rc.0';
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT_SHA = /^[0-9a-f]{40,64}$/u;
const COMMIT_SHORT = /^[0-9a-f]{7,16}$/u;
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/u;
const UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

const staticShape = {
  metadataSchemaVersion: z.number().int().refine(
    (value) => value === releaseContract.metadataSchemaVersion,
    'Unexpected release metadata schema version.',
  ),
  productName: z.literal('Claude Workbench'),
  appId: z.literal('com.claudeworkbench.app'),
  channel: z.literal('rc'),
  buildId: z.string().min(1).max(256),
  branch: z.literal('task15'),
  commitSha: z.string().regex(COMMIT_SHA),
  commitShort: z.string().regex(COMMIT_SHORT),
  dirty: z.boolean(),
  buildTimeUtc: z.string().regex(UTC_SECONDS).refine((value) => {
    const parsed = new Date(value);
    return !Number.isNaN(parsed.getTime())
      && parsed.toISOString().replace('.000Z', 'Z') === value;
  }, 'Release build time must be an ISO UTC whole-second timestamp.'),
  nodeVersion: z.string().regex(/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u),
  npmVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u),
  electronVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u),
  sqliteSchemaVersion: z.number().int().refine(
    (value) => value === releaseContract.sqliteSchemaVersion,
    'Unexpected SQLite schema version.',
  ),
  platform: z.literal('win32'),
  arch: z.literal('x64'),
  lockfileSha256: z.string().regex(SHA256),
  releaseNotesSha256: z.string().regex(SHA256),
};

function expectedBuildId(metadata: {
  version: string;
  commitShort: string;
  buildTimeUtc: string;
}): string {
  const stamp = metadata.buildTimeUtc.replace(/[-:]/gu, '');
  return `${metadata.version}+${metadata.commitShort}.${stamp}`;
}

function validateMetadataRelationships(
  metadata: {
    version: string;
    buildId: string;
    commitSha: string;
    commitShort: string;
    dirty: boolean;
    buildTimeUtc: string;
  },
  context: z.RefinementCtx,
): void {
  if (metadata.dirty) {
    context.addIssue({
      code: 'custom',
      path: ['dirty'],
      message: 'Release metadata requires a clean worktree.',
    });
  }
  if (!metadata.commitSha.startsWith(metadata.commitShort)) {
    context.addIssue({
      code: 'custom',
      path: ['commitShort'],
      message: 'Release commit abbreviation must match the full commit.',
    });
  }
  if (metadata.buildId !== expectedBuildId(metadata)) {
    context.addIssue({
      code: 'custom',
      path: ['buildId'],
      message: 'Release Build ID does not match its immutable metadata.',
    });
  }
}

export const releaseMetadataSchema = z.object({
  ...staticShape,
  purpose: z.literal('candidate'),
  version: z.literal(CANDIDATE_VERSION),
}).strict().superRefine(validateMetadataRelationships);

export const localUpdateFixtureMetadataSchema = z.object({
  ...staticShape,
  purpose: z.literal('local-update-fixture'),
  version: z.literal(FIXTURE_VERSION),
}).strict().superRefine(validateMetadataRelationships);

const releaseRuntimeStatusSchema = z.object({
  packaged: z.boolean(),
  signatureStatus: z.enum([
    'Signed',
    'NotSigned',
    'UnknownError',
    'HashMismatch',
    'NotTrusted',
    'Expired',
  ]),
  productionFeedConfigured: z.boolean(),
  licenseStatus: z.literal('decision_required'),
  privacyStatus: z.literal('draft'),
}).strict();

export interface LoadRuntimeMetadataInput {
  packaged: boolean;
  resourcesPath: string;
  fallbackVersion: string;
  runtimeVersions: Readonly<{
    node: string | null | undefined;
    electron: string | null | undefined;
    platform: NodeJS.Platform;
    arch: string;
  }>;
  sqliteSchemaVersion: number;
}

let cachedEmbeddedText: string | undefined;
let cachedEmbeddedJson: unknown;

function embeddedMetadataText(): string {
  return typeof __WORKBENCH_RELEASE_METADATA_JSON__ === 'string'
    ? __WORKBENCH_RELEASE_METADATA_JSON__
    : 'null';
}

function fixtureBuildEnabled(): boolean {
  return typeof __WORKBENCH_LOCAL_UPDATE_FIXTURE__ === 'boolean'
    && __WORKBENCH_LOCAL_UPDATE_FIXTURE__;
}

function parseEmbeddedJson(serialized: string): unknown {
  if (cachedEmbeddedText !== serialized) {
    cachedEmbeddedJson = JSON.parse(serialized) as unknown;
    cachedEmbeddedText = serialized;
  }
  return cachedEmbeddedJson;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function frozenReleaseRuntime(metadata: ReleaseMetadata): RuntimeMetadata {
  return Object.freeze({
    mode: 'release' as const,
    metadata: Object.freeze({ ...metadata }),
  });
}

function frozenFixtureRuntime(metadata: LocalUpdateFixtureMetadata): RuntimeMetadata {
  return Object.freeze({
    mode: 'local-update-fixture' as const,
    metadata: Object.freeze({ ...metadata }),
  });
}

function assertRuntimeCompatibility(
  metadata: ReleaseMetadata | LocalUpdateFixtureMetadata,
  input: LoadRuntimeMetadataInput,
): void {
  if (input.fallbackVersion !== metadata.version) {
    throw new Error('Packaged application version does not match release metadata.');
  }
  const runtimeNode = input.runtimeVersions.node?.replace(/^v/u, '');
  if (!runtimeNode || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(runtimeNode)) {
    throw new Error('Electron runtime Node version is invalid.');
  }
  // metadata.nodeVersion records the build-tool Node. Electron embeds its own Node,
  // so the runtime value is sanity-checked above but intentionally not compared.
  if (!input.runtimeVersions.electron
    || input.runtimeVersions.electron !== metadata.electronVersion) {
    throw new Error('Packaged Electron runtime version does not match release metadata.');
  }
  if (input.runtimeVersions.platform !== metadata.platform
    || input.runtimeVersions.arch !== metadata.arch) {
    throw new Error('Packaged runtime target does not match release metadata.');
  }
  if (input.sqliteSchemaVersion !== metadata.sqliteSchemaVersion) {
    throw new Error('Packaged SQLite schema does not match release metadata.');
  }
}

export function assertReleasableMetadata(input: unknown): ReleaseMetadata {
  if (input && typeof input === 'object' && 'dirty' in input && input.dirty !== false) {
    throw new Error('Release metadata requires a clean worktree.');
  }
  if (input && typeof input === 'object'
    && 'purpose' in input && input.purpose === 'local-update-fixture') {
    throw new Error('Local update fixture metadata is not releasable.');
  }
  return releaseMetadataSchema.parse(input) as ReleaseMetadata;
}

export function publicReleaseVersionInfo(
  metadata: ReleaseMetadata | LocalUpdateFixtureMetadata,
  runtimeStatus: ReleaseRuntimeStatus,
): ReleaseVersionInfo {
  const validated = metadata.purpose === 'candidate'
    ? releaseMetadataSchema.parse(metadata)
    : localUpdateFixtureMetadataSchema.parse(metadata);
  const status = releaseRuntimeStatusSchema.parse(runtimeStatus);
  return {
    version: validated.version,
    channel: validated.channel,
    buildId: validated.buildId,
    commit: validated.commitShort,
    electronVersion: validated.electronVersion,
    nodeVersion: validated.nodeVersion,
    sqliteSchemaVersion: validated.sqliteSchemaVersion,
    agentRuntime: 'claude-code',
    packaged: status.packaged,
    signatureStatus: status.signatureStatus,
    productionFeedConfigured: status.productionFeedConfigured,
    licenseStatus: status.licenseStatus,
    privacyStatus: status.privacyStatus,
    releaseNotesSha256: validated.releaseNotesSha256,
  };
}

export function loadRuntimeMetadata(input: LoadRuntimeMetadataInput): RuntimeMetadata {
  if (!input.packaged) {
    const version = SAFE_VERSION.test(input.fallbackVersion) ? input.fallbackVersion : '0.0.0';
    return Object.freeze({
      mode: 'development',
      version,
      commit: 'unknown',
      channel: 'dev',
      dirty: true,
    });
  }

  const serialized = embeddedMetadataText();
  if (serialized === 'null') {
    throw new Error('Packaged release metadata is missing.');
  }
  const resourcePath = path.join(input.resourcesPath, 'release-metadata.json');
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resourcePath);
  } catch {
    throw new Error('Packaged release metadata resource is unavailable.');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Packaged release metadata resource is invalid.');
  }
  let resourceBytes: Buffer;
  try {
    resourceBytes = fs.readFileSync(resourcePath);
  } catch {
    throw new Error('Packaged release metadata resource is unavailable.');
  }
  const embeddedBytes = Buffer.from(serialized, 'utf8');
  if (!resourceBytes.equals(embeddedBytes)
    || sha256(resourceBytes) !== sha256(embeddedBytes)) {
    throw new Error('Packaged release metadata must match the embedded snapshot.');
  }

  const parsed = parseEmbeddedJson(serialized);
  if (fixtureBuildEnabled()) {
    if (input.fallbackVersion !== FIXTURE_VERSION) {
      throw new Error('Local update fixture metadata requires the rc.0 fixture application.');
    }
    const metadata = localUpdateFixtureMetadataSchema.parse(parsed) as LocalUpdateFixtureMetadata;
    assertRuntimeCompatibility(metadata, input);
    return frozenFixtureRuntime(metadata);
  }

  const metadata = assertReleasableMetadata(parsed);
  assertRuntimeCompatibility(metadata, input);
  return frozenReleaseRuntime(metadata);
}
