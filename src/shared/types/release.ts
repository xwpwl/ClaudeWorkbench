export const RELEASE_CHANNELS = ['dev', 'rc', 'beta', 'latest'] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

export interface ReleaseMetadata {
  metadataSchemaVersion: 1;
  purpose: 'candidate';
  productName: 'Claude Workbench';
  appId: 'com.claudeworkbench.app';
  version: string;
  channel: ReleaseChannel;
  buildId: string;
  branch: 'task15';
  commitSha: string;
  commitShort: string;
  dirty: boolean;
  buildTimeUtc: string;
  nodeVersion: string;
  npmVersion: string;
  electronVersion: string;
  sqliteSchemaVersion: number;
  platform: string;
  arch: string;
  lockfileSha256: string;
  releaseNotesSha256: string;
}

export interface LocalUpdateFixtureMetadata
  extends Omit<ReleaseMetadata, 'purpose' | 'version'> {
  purpose: 'local-update-fixture';
  version: '1.0.1-rc.0';
}

export type RuntimeMetadata =
  | { mode: 'release'; metadata: ReleaseMetadata }
  | { mode: 'local-update-fixture'; metadata: LocalUpdateFixtureMetadata }
  | { mode: 'development'; version: string; commit: 'unknown'; channel: 'dev'; dirty: true };

export interface ReleaseRuntimeStatus {
  packaged: boolean;
  signatureStatus: 'Signed' | 'NotSigned' | 'UnknownError' | 'HashMismatch' | 'NotTrusted' | 'Expired';
  productionFeedConfigured: boolean;
  licenseStatus: 'decision_required';
  privacyStatus: 'draft';
}

export interface ReleaseVersionInfo {
  version: string;
  channel: ReleaseChannel;
  buildId: string;
  commit: string;
  electronVersion: string;
  nodeVersion: string;
  sqliteSchemaVersion: number;
  agentRuntime: 'claude-code';
  packaged: boolean;
  signatureStatus: ReleaseRuntimeStatus['signatureStatus'];
  productionFeedConfigured: ReleaseRuntimeStatus['productionFeedConfigured'];
  licenseStatus: ReleaseRuntimeStatus['licenseStatus'];
  privacyStatus: ReleaseRuntimeStatus['privacyStatus'];
  releaseNotesSha256: string;
}
