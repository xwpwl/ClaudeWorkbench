import type { ReleaseVersionInfo } from '../../shared/types/ipc';

export interface VersionInfoInput {
  version: string;
  electronVersion?: string | null;
  nodeVersion?: string | null;
  sqliteSchemaVersion?: number;
  agentRuntime?: 'claude-code';
  packaged: boolean;
  environment?: Readonly<Record<string, string | undefined>>;
}

const SAFE_BUILD_VALUE = /^[a-zA-Z0-9._+-]{1,128}$/;
const SAFE_COMMIT = /^[a-fA-F0-9]{7,64}$/;
const SAFE_CHANNEL = /^[a-zA-Z0-9._-]{1,32}$/;

function safeValue(
  value: string | undefined,
  pattern: RegExp,
  fallback: string,
): string {
  const trimmed = value?.trim();
  return trimmed && pattern.test(trimmed) ? trimmed : fallback;
}

/**
 * Builds public release metadata without exposing arbitrary environment values.
 * Release CI may inject only the three WORKBENCH_* values below.
 */
export function buildVersionInfo(input: VersionInfoInput): ReleaseVersionInfo {
  const environment = input.environment ?? process.env;
  const version = safeValue(input.version, SAFE_BUILD_VALUE, '0.0.0');

  return {
    version,
    buildId: safeValue(
      environment.WORKBENCH_BUILD_ID,
      SAFE_BUILD_VALUE,
      input.packaged ? `release-${version}` : 'development',
    ),
    commit: safeValue(environment.WORKBENCH_COMMIT, SAFE_COMMIT, 'unknown'),
    channel: safeValue(environment.WORKBENCH_RELEASE_CHANNEL, SAFE_CHANNEL, 'stable'),
    electronVersion: safeValue(input.electronVersion ?? undefined, SAFE_BUILD_VALUE, 'unknown'),
    nodeVersion: safeValue(input.nodeVersion ?? undefined, SAFE_BUILD_VALUE, 'unknown'),
    sqliteSchemaVersion: Number.isSafeInteger(input.sqliteSchemaVersion) && (input.sqliteSchemaVersion ?? -1) >= 0
      ? input.sqliteSchemaVersion!
      : 0,
    agentRuntime: input.agentRuntime ?? 'claude-code',
    packaged: input.packaged,
  };
}
