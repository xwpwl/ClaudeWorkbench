import { afterEach, describe, expect, it } from 'vitest';
import type {
  ReleaseMetadata,
  ReleaseRuntimeStatus,
  RuntimeMetadata,
} from '../../../shared/types/release';
import { buildVersionInfo } from '../VersionInfo';

const metadata: ReleaseMetadata = {
  metadataSchemaVersion: 1,
  purpose: 'candidate',
  productName: 'Claude Workbench',
  appId: 'com.claudeworkbench.app',
  version: '1.0.1-rc.1',
  channel: 'rc',
  buildId: '1.0.1-rc.1+0123456789ab.20260812T123456Z',
  branch: 'task15',
  commitSha: '0123456789abcdef0123456789abcdef01234567',
  commitShort: '0123456789ab',
  dirty: false,
  buildTimeUtc: '2026-08-12T12:34:56Z',
  nodeVersion: 'v24.15.0',
  npmVersion: '11.12.1',
  electronVersion: '35.7.5',
  sqliteSchemaVersion: 7,
  platform: 'win32',
  arch: 'x64',
  lockfileSha256: 'a'.repeat(64),
  releaseNotesSha256: 'b'.repeat(64),
};

const runtimeStatus: ReleaseRuntimeStatus = {
  packaged: true,
  signatureStatus: 'UnknownError',
  productionFeedConfigured: false,
  licenseStatus: 'decision_required',
  privacyStatus: 'draft',
};

const savedEnvironment = {
  buildId: process.env.WORKBENCH_BUILD_ID,
  commit: process.env.WORKBENCH_COMMIT,
  channel: process.env.WORKBENCH_RELEASE_CHANNEL,
};

afterEach(() => {
  for (const [key, value] of Object.entries({
    WORKBENCH_BUILD_ID: savedEnvironment.buildId,
    WORKBENCH_COMMIT: savedEnvironment.commit,
    WORKBENCH_RELEASE_CHANNEL: savedEnvironment.channel,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('buildVersionInfo', () => {
  it('projects immutable release metadata and conservative runtime status', () => {
    expect(buildVersionInfo({
      runtimeMetadata: { mode: 'release', metadata },
      runtimeStatus,
      runtimeVersions: { electron: '35.7.5', node: '24.15.0' },
      sqliteSchemaVersion: 7,
    })).toEqual({
      version: '1.0.1-rc.1',
      channel: 'rc',
      buildId: metadata.buildId,
      commit: metadata.commitShort,
      electronVersion: '35.7.5',
      nodeVersion: 'v24.15.0',
      sqliteSchemaVersion: 7,
      agentRuntime: 'claude-code',
      packaged: true,
      signatureStatus: 'UnknownError',
      productionFeedConfigured: false,
      licenseStatus: 'decision_required',
      privacyStatus: 'draft',
      releaseNotesSha256: 'b'.repeat(64),
    });
  });

  it('does not expose the private data directory in diagnostic version metadata', () => {
    const info = buildVersionInfo({
      runtimeMetadata: { mode: 'release', metadata },
      runtimeStatus,
      runtimeVersions: { electron: '35.7.5', node: '24.15.0' },
      sqliteSchemaVersion: 7,
      dataDirectory: 'C:\\private\\WorkbenchData',
    });

    expect(info).not.toHaveProperty('dataDirectory');
    expect(JSON.stringify(info)).not.toContain('WorkbenchData');
  });

  it('labels unpackaged development builds without inventing release provenance', () => {
    const runtimeMetadata: RuntimeMetadata = {
      mode: 'development',
      version: '1.0.1-rc.1',
      commit: 'unknown',
      channel: 'dev',
      dirty: true,
    };
    expect(buildVersionInfo({
      runtimeMetadata,
      runtimeStatus: { ...runtimeStatus, packaged: false },
      runtimeVersions: { electron: '35.7.5', node: '24.15.0' },
      sqliteSchemaVersion: 7,
    })).toEqual({
      version: '1.0.1-rc.1',
      channel: 'dev',
      buildId: 'development',
      commit: 'unknown',
      electronVersion: '35.7.5',
      nodeVersion: '24.15.0',
      sqliteSchemaVersion: 7,
      agentRuntime: 'claude-code',
      packaged: false,
      signatureStatus: 'UnknownError',
      productionFeedConfigured: false,
      licenseStatus: 'decision_required',
      privacyStatus: 'draft',
      releaseNotesSha256: '',
    });
  });

  it('never reads or exposes legacy WORKBENCH environment metadata', () => {
    process.env.WORKBENCH_BUILD_ID = 'secret-value';
    process.env.WORKBENCH_COMMIT = 'fedcba9876543210';
    process.env.WORKBENCH_RELEASE_CHANNEL = 'latest';

    const info = buildVersionInfo({
      runtimeMetadata: { mode: 'release', metadata },
      runtimeStatus,
      runtimeVersions: { electron: '35.7.5', node: '24.15.0' },
      sqliteSchemaVersion: 7,
    });
    expect(info.buildId).toBe(metadata.buildId);
    expect(info.commit).toBe(metadata.commitShort);
    expect(info.channel).toBe('rc');
    expect(JSON.stringify(info)).not.toContain('secret-value');
  });
});
