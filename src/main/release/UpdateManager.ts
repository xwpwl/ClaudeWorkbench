import fs from 'node:fs';
import type { UpdateSnapshot, UpdateStatus } from '../../shared/types/ipc';

export type { UpdateSnapshot, UpdateStatus } from '../../shared/types/ipc';

export interface UpdateCheckResultLike {
  isUpdateAvailable: boolean;
  updateInfo: { version: string };
}

/** Minimal electron-updater surface, kept injectable for deterministic tests. */
export interface UpdateClient {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  checkForUpdates(): Promise<UpdateCheckResultLike | null>;
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateManagerOptions {
  isPackaged: boolean;
  sourceConfigured: boolean;
}

const SAFE_VERSION = /^[a-zA-Z0-9._+-]{1,128}$/;
const CONFIGURED_PROVIDERS = new Set([
  'generic', 'github', 's3', 'spaces', 'keygen', 'bitbucket', 'custom',
]);
const PLACEHOLDER = /example\.(?:com|invalid)|change[-_ ]?me|replace[-_ ]?me|your[-_ ]/i;

function publicVersion(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && SAFE_VERSION.test(trimmed) ? trimmed : null;
}

/**
 * Reads electron-builder's generated app-update.yml conservatively. A missing,
 * malformed, or placeholder provider is treated as "updates disabled".
 */
export function detectPackagedUpdateSource(configPath: string): boolean {
  let contents: string;
  try {
    contents = fs.readFileSync(configPath, 'utf8');
  } catch {
    return false;
  }

  const provider = /^provider:\s*['"]?([a-z0-9_-]+)['"]?\s*$/im.exec(contents)?.[1]?.toLowerCase();
  if (!provider || !CONFIGURED_PROVIDERS.has(provider) || PLACEHOLDER.test(contents)) return false;

  if (provider === 'generic') {
    const url = /^url:\s*['"]?([^'"\s]+)['"]?\s*$/im.exec(contents)?.[1];
    return Boolean(url && /^https:\/\//i.test(url));
  }
  if (provider === 'github') {
    return /^owner:\s*\S+/im.test(contents) && /^repo:\s*\S+/im.test(contents);
  }
  return true;
}

export class UpdateManager {
  private snapshot: UpdateSnapshot = {
    status: 'idle', version: null, reason: null, message: null,
  };
  private checkPromise: Promise<UpdateSnapshot> | null = null;

  constructor(
    private readonly client: UpdateClient,
    private readonly options: UpdateManagerOptions,
  ) {
    // These are security properties, not caller preferences. Updates are never
    // downloaded or installed without a later, explicit user action.
    this.client.autoDownload = false;
    this.client.autoInstallOnAppQuit = false;
    this.client.allowDowngrade = false;
  }

  getState(): UpdateSnapshot {
    return { ...this.snapshot };
  }

  checkForUpdates(): Promise<UpdateSnapshot> {
    if (this.checkPromise) return this.checkPromise;
    this.checkPromise = this.performCheck().finally(() => {
      this.checkPromise = null;
    });
    return this.checkPromise;
  }

  private async performCheck(): Promise<UpdateSnapshot> {
    if (!this.options.isPackaged) {
      return this.setState('disabled', null, 'development', 'Update checks are disabled in development.');
    }
    if (!this.options.sourceConfigured) {
      return this.setState('disabled', null, 'not_configured', 'No update source is configured.');
    }

    this.setState('checking');
    try {
      const result = await this.client.checkForUpdates();
      if (!result?.isUpdateAvailable) return this.setState('not_available');
      return this.setState('available', publicVersion(result.updateInfo.version));
    } catch {
      // Raw updater errors can include authenticated feed URLs. Do not expose
      // them through public state; the diagnostics layer may record a redacted code.
      return this.setState('error', null, null, 'Unable to check for updates.');
    }
  }

  /** Must only be called from an explicit user action after an available result. */
  async downloadUpdate(): Promise<UpdateSnapshot> {
    if (this.snapshot.status !== 'available') return this.getState();
    const version = this.snapshot.version;
    this.setState('downloading', version);
    try {
      await this.client.downloadUpdate();
      return this.setState('downloaded', version);
    } catch {
      return this.setState('error', version, null, 'Unable to download the update.');
    }
  }

  /** Installation is fail-closed unless both download and explicit confirmation exist. */
  installDownloadedUpdate(confirmed: boolean): boolean {
    if (confirmed !== true || this.snapshot.status !== 'downloaded') return false;
    this.client.quitAndInstall(false, false);
    return true;
  }

  private setState(
    status: UpdateStatus,
    version: string | null = null,
    reason: UpdateSnapshot['reason'] = null,
    message: string | null = null,
  ): UpdateSnapshot {
    this.snapshot = { status, version, reason, message };
    return this.getState();
  }
}
