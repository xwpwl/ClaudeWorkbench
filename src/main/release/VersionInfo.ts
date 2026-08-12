import type {
  ReleaseRuntimeStatus,
  ReleaseVersionInfo,
  RuntimeMetadata,
} from '../../shared/types/release';
import { publicReleaseVersionInfo } from './ReleaseMetadata';

export interface VersionInfoInput {
  runtimeMetadata: RuntimeMetadata;
  runtimeStatus: ReleaseRuntimeStatus;
  runtimeVersions: Readonly<{
    electron: string | null | undefined;
    node: string | null | undefined;
  }>;
  sqliteSchemaVersion: number;
  agentRuntime?: 'claude-code';
}

const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/u;

function safeVersion(value: string | null | undefined): string {
  return value && SAFE_VERSION.test(value) ? value : 'unknown';
}

/**
 * Compatibility projection used by existing release IPC consumers.
 * Immutable release provenance comes only from the compiled metadata snapshot.
 */
export function buildVersionInfo(input: VersionInfoInput): ReleaseVersionInfo {
  if (input.runtimeMetadata.mode !== 'development') {
    if (!input.runtimeStatus.packaged) {
      throw new Error('Packaged release metadata requires packaged runtime status.');
    }
    return publicReleaseVersionInfo(input.runtimeMetadata.metadata, input.runtimeStatus);
  }
  if (input.runtimeStatus.packaged) {
    throw new Error('Development metadata cannot represent a packaged application.');
  }

  return {
    version: input.runtimeMetadata.version,
    channel: 'dev',
    buildId: 'development',
    commit: 'unknown',
    electronVersion: safeVersion(input.runtimeVersions.electron),
    nodeVersion: safeVersion(input.runtimeVersions.node),
    sqliteSchemaVersion: Number.isSafeInteger(input.sqliteSchemaVersion)
      && input.sqliteSchemaVersion >= 0
      ? input.sqliteSchemaVersion
      : 0,
    agentRuntime: input.agentRuntime ?? 'claude-code',
    packaged: false,
    signatureStatus: input.runtimeStatus.signatureStatus,
    productionFeedConfigured: input.runtimeStatus.productionFeedConfigured,
    licenseStatus: input.runtimeStatus.licenseStatus,
    privacyStatus: input.runtimeStatus.privacyStatus,
    releaseNotesSha256: '',
  };
}
