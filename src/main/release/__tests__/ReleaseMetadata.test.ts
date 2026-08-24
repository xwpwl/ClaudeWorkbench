import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ReleaseMetadata,
  ReleaseRuntimeStatus,
} from '../../../shared/types/release';
import {
  assertReleasableMetadata,
  loadRuntimeMetadata,
  publicReleaseVersionInfo,
  releaseMetadataSchema,
} from '../ReleaseMetadata';

const COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';
const LOCKFILE_SHA = 'a'.repeat(64);
const NOTES_SHA = 'b'.repeat(64);

const validMetadata: ReleaseMetadata = {
  metadataSchemaVersion: 1,
  purpose: 'candidate',
  productName: 'Claude Workbench',
  appId: 'com.claudeworkbench.app',
  version: '1.0.1-rc.1',
  channel: 'rc',
  buildId: '1.0.1-rc.1+0123456789ab.20260812T123456Z',
  branch: 'task15',
  commitSha: COMMIT_SHA,
  commitShort: COMMIT_SHA.slice(0, 12),
  dirty: false,
  buildTimeUtc: '2026-08-12T12:34:56Z',
  nodeVersion: 'v24.15.0',
  npmVersion: '11.12.1',
  electronVersion: '35.7.5',
  sqliteSchemaVersion: 7,
  platform: 'win32',
  arch: 'x64',
  lockfileSha256: LOCKFILE_SHA,
  releaseNotesSha256: NOTES_SHA,
};

const validRuntimeStatus: ReleaseRuntimeStatus = {
  packaged: true,
  signatureStatus: 'UnknownError',
  productionFeedConfigured: false,
  licenseStatus: 'decision_required',
  privacyStatus: 'draft',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('release metadata contract', () => {
  it('uses package.json as the only 1.0.1-rc.1 version source', () => {
    const workspace = path.resolve(__dirname, '../../../..');
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'),
    ) as { version: string };
    const packageLock = JSON.parse(
      fs.readFileSync(path.join(workspace, 'package-lock.json'), 'utf8'),
    ) as { version: string; packages: Record<string, { version?: string }> };

    expect(packageJson.version).toBe('1.0.1-rc.1');
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages['']?.version).toBe(packageJson.version);
  });

  it('rejects unknown provenance, dirty candidates, and extra fields', () => {
    expect(() => releaseMetadataSchema.parse({
      ...validMetadata,
      commitSha: 'unknown',
    })).toThrow();
    expect(() => assertReleasableMetadata({
      ...validMetadata,
      dirty: true,
    })).toThrow('clean');
    expect(() => releaseMetadataSchema.parse({
      ...validMetadata,
      sourcePath: 'C:\\Users\\tester\\source',
    })).toThrow();
  });

  it.each([
    ['purpose', 'local-update-fixture'],
    ['version', '1.0.1'],
    ['channel', 'latest'],
    ['branch', 'main'],
    ['platform', 'linux'],
    ['arch', 'arm64'],
  ] as const)('rejects a candidate with the wrong %s', (field, value) => {
    expect(() => releaseMetadataSchema.parse({
      ...validMetadata,
      [field]: value,
    })).toThrow();
  });

  it('projects no source path, environment value, username, credential reference, or vault path', () => {
    const publicInfo = publicReleaseVersionInfo(validMetadata, validRuntimeStatus);
    expect(publicInfo).toEqual({
      version: '1.0.1-rc.1',
      channel: 'rc',
      buildId: validMetadata.buildId,
      commit: validMetadata.commitShort,
      electronVersion: '35.7.5',
      nodeVersion: 'v24.15.0',
      sqliteSchemaVersion: 7,
      agentRuntime: 'claude-code',
      packaged: true,
      signatureStatus: 'UnknownError',
      productionFeedConfigured: false,
      licenseStatus: 'decision_required',
      privacyStatus: 'draft',
      releaseNotesSha256: NOTES_SHA,
    });
    expect(JSON.stringify(publicInfo)).not.toMatch(
      /C:\\Users|credential_ref|vault|secret-value/iu,
    );
  });

  it('rejects unsafe runtime status instead of projecting an arbitrary value', () => {
    expect(() => publicReleaseVersionInfo(validMetadata, {
      ...validRuntimeStatus,
      signatureStatus: 'secret-value',
    } as ReleaseRuntimeStatus)).toThrow();
  });
});

describe('loadRuntimeMetadata', () => {
  it('returns a frozen development union that cannot be released', () => {
    const runtime = loadRuntimeMetadata({
      packaged: false,
      resourcesPath: 'unused',
      fallbackVersion: '1.0.1-rc.1',
      runtimeVersions: { node: '24.15.0', electron: '35.7.5', platform: 'win32', arch: 'x64' },
      sqliteSchemaVersion: 7,
    });

    expect(runtime).toEqual({
      mode: 'development',
      version: '1.0.1-rc.1',
      commit: 'unknown',
      channel: 'dev',
      dirty: true,
    });
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(() => assertReleasableMetadata(runtime)).toThrow();
  });

  it('requires packaged resource bytes to equal the embedded candidate snapshot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-release-metadata-'));
    const serialized = `${JSON.stringify(validMetadata, null, 2)}\n`;
    fs.writeFileSync(path.join(root, 'release-metadata.json'), serialized, 'utf8');
    vi.stubGlobal('__WORKBENCH_RELEASE_METADATA_JSON__', serialized);
    vi.stubGlobal('__WORKBENCH_LOCAL_UPDATE_FIXTURE__', false);

    try {
      const runtime = loadRuntimeMetadata({
        packaged: true,
        resourcesPath: root,
        fallbackVersion: '1.0.1-rc.1',
        runtimeVersions: { node: '22.16.0', electron: '35.7.5', platform: 'win32', arch: 'x64' },
        sqliteSchemaVersion: 7,
      });
      expect(runtime).toEqual({ mode: 'release', metadata: validMetadata });
      expect(Object.isFrozen(runtime)).toBe(true);
      expect(Object.isFrozen(runtime.metadata)).toBe(true);

      fs.writeFileSync(
        path.join(root, 'release-metadata.json'),
        JSON.stringify(validMetadata),
        'utf8',
      );
      expect(() => loadRuntimeMetadata({
        packaged: true,
        resourcesPath: root,
        fallbackVersion: '1.0.1-rc.1',
        runtimeVersions: { node: '24.15.0', electron: '35.7.5', platform: 'win32', arch: 'x64' },
        sqliteSchemaVersion: 7,
      })).toThrow('match');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not disclose an absolute resource path when packaged metadata is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-release-missing-'));
    vi.stubGlobal(
      '__WORKBENCH_RELEASE_METADATA_JSON__',
      `${JSON.stringify(validMetadata, null, 2)}\n`,
    );
    vi.stubGlobal('__WORKBENCH_LOCAL_UPDATE_FIXTURE__', false);

    try {
      let message = '';
      try {
        loadRuntimeMetadata({
          packaged: true,
          resourcesPath: root,
          fallbackVersion: '1.0.1-rc.1',
          runtimeVersions: { node: '24.15.0', electron: '35.7.5', platform: 'win32', arch: 'x64' },
          sqliteSchemaVersion: 7,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe('Packaged release metadata resource is unavailable.');
      expect(message).not.toContain(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports malformed Electron runtime Node separately from build-tool provenance', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-runtime-node-'));
    const serialized = `${JSON.stringify(validMetadata, null, 2)}\n`;
    fs.writeFileSync(path.join(root, 'release-metadata.json'), serialized, 'utf8');
    vi.stubGlobal('__WORKBENCH_RELEASE_METADATA_JSON__', serialized);
    vi.stubGlobal('__WORKBENCH_LOCAL_UPDATE_FIXTURE__', false);

    try {
      expect(() => loadRuntimeMetadata({
        packaged: true,
        resourcesPath: root,
        fallbackVersion: '1.0.1-rc.1',
        runtimeVersions: {
          node: 'not-a-runtime-version',
          electron: '35.7.5',
          platform: 'win32',
          arch: 'x64',
        },
        sqliteSchemaVersion: 7,
      })).toThrow('Electron runtime Node version is invalid');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects packaged runtime platform or architecture mismatch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-release-platform-'));
    const serialized = `${JSON.stringify(validMetadata, null, 2)}\n`;
    fs.writeFileSync(path.join(root, 'release-metadata.json'), serialized, 'utf8');
    vi.stubGlobal('__WORKBENCH_RELEASE_METADATA_JSON__', serialized);
    vi.stubGlobal('__WORKBENCH_LOCAL_UPDATE_FIXTURE__', false);

    try {
      expect(() => loadRuntimeMetadata({
        packaged: true,
        resourcesPath: root,
        fallbackVersion: '1.0.1-rc.1',
        runtimeVersions: {
          node: '22.16.0',
          electron: '35.7.5',
          platform: 'linux',
          arch: 'x64',
        },
        sqliteSchemaVersion: 7,
      })).toThrow('runtime');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts fixture metadata only for an rc.0 fixture build', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-release-fixture-'));
    const fixture = {
      ...validMetadata,
      purpose: 'local-update-fixture',
      version: '1.0.1-rc.0',
      buildId: '1.0.1-rc.0+0123456789ab.20260812T123456Z',
    };
    const serialized = `${JSON.stringify(fixture, null, 2)}\n`;
    fs.writeFileSync(path.join(root, 'release-metadata.json'), serialized, 'utf8');
    vi.stubGlobal('__WORKBENCH_RELEASE_METADATA_JSON__', serialized);
    vi.stubGlobal('__WORKBENCH_LOCAL_UPDATE_FIXTURE__', true);

    try {
      expect(loadRuntimeMetadata({
        packaged: true,
        resourcesPath: root,
        fallbackVersion: '1.0.1-rc.0',
        runtimeVersions: { node: '24.15.0', electron: '35.7.5', platform: 'win32', arch: 'x64' },
        sqliteSchemaVersion: 7,
      })).toEqual({ mode: 'local-update-fixture', metadata: fixture });
      expect(() => assertReleasableMetadata(fixture)).toThrow();

      expect(() => loadRuntimeMetadata({
        packaged: true,
        resourcesPath: root,
        fallbackVersion: '1.0.1-rc.1',
        runtimeVersions: { node: '24.15.0', electron: '35.7.5', platform: 'win32', arch: 'x64' },
        sqliteSchemaVersion: 7,
      })).toThrow('fixture');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
