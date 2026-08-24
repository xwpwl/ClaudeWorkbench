import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  detectPackagedUpdateSource,
  UpdateManager,
  type UpdateClient,
} from '../UpdateManager';
import {
  loadUpdateBootstrapConfig,
  prepareUpdaterCacheRoot,
  resolveElectronUpdaterBaseCachePath,
} from '../UpdateBootstrapConfig';

const directories: string[] = [];

function client(overrides: Partial<UpdateClient> = {}): UpdateClient {
  return {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowDowngrade: true,
    checkForUpdates: vi.fn(async () => ({
      isUpdateAvailable: false,
      updateInfo: { version: '1.0.0' },
    })),
    downloadUpdate: vi.fn(async () => ['update.exe']),
    quitAndInstall: vi.fn(),
    ...overrides,
  };
}

function config(contents: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-update-test-'));
  directories.push(directory);
  const target = path.join(directory, 'app-update.yml');
  fs.writeFileSync(target, contents);
  return target;
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('detectPackagedUpdateSource', () => {
  it('fails closed for missing and malformed configuration', () => {
    expect(detectPackagedUpdateSource(path.join(os.tmpdir(), 'missing-app-update.yml'))).toBe(false);
    expect(detectPackagedUpdateSource(config('provider: unknown\n'))).toBe(false);
  });

  it('accepts a configured HTTPS generic provider', () => {
    expect(detectPackagedUpdateSource(config(
      'provider: generic\nurl: https://updates.claudeworkbench.test/stable\n',
    ))).toBe(true);
  });

  it('rejects insecure or placeholder generic feeds', () => {
    expect(detectPackagedUpdateSource(config('provider: generic\nurl: http://updates.test\n'))).toBe(false);
    expect(detectPackagedUpdateSource(config('provider: generic\nurl: https://example.invalid\n'))).toBe(false);
  });

  it('requires owner and repository for GitHub', () => {
    expect(detectPackagedUpdateSource(config('provider: github\nowner: team\nrepo: workbench\n'))).toBe(true);
    expect(detectPackagedUpdateSource(config('provider: github\nowner: team\n'))).toBe(false);
  });
});

describe('UpdateManager', () => {
  it('always disables automatic download, quit installation, and downgrade', () => {
    const updater = client();
    new UpdateManager(updater, { isPackaged: true, sourceConfigured: true });
    expect(updater).toMatchObject({
      autoDownload: false, autoInstallOnAppQuit: false, allowDowngrade: false,
    });
  });

  it('does not contact the update service in development', async () => {
    const updater = client();
    const manager = new UpdateManager(updater, { isPackaged: false, sourceConfigured: true });
    await expect(manager.checkForUpdates()).resolves.toMatchObject({
      status: 'disabled', reason: 'development',
    });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('fails safely without contacting an unconfigured release source', async () => {
    const updater = client();
    const manager = new UpdateManager(updater, { isPackaged: true, sourceConfigured: false });
    await expect(manager.checkForUpdates()).resolves.toMatchObject({
      status: 'disabled', reason: 'not_configured',
    });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('reports availability without downloading automatically', async () => {
    const updater = client({
      checkForUpdates: vi.fn(async () => ({
        isUpdateAvailable: true, updateInfo: { version: '1.1.0' },
      })),
    });
    const manager = new UpdateManager(updater, { isPackaged: true, sourceConfigured: true });
    await expect(manager.checkForUpdates()).resolves.toMatchObject({ status: 'available', version: '1.1.0' });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent update checks', async () => {
    let resolve!: (result: { isUpdateAvailable: boolean; updateInfo: { version: string } }) => void;
    const updater = client({
      checkForUpdates: vi.fn(() => new Promise((done) => { resolve = done; })),
    });
    const manager = new UpdateManager(updater, { isPackaged: true, sourceConfigured: true });
    const first = manager.checkForUpdates();
    const second = manager.checkForUpdates();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    resolve({ isUpdateAvailable: false, updateInfo: { version: '1.0.0' } });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'not_available' }),
      expect.objectContaining({ status: 'not_available' }),
    ]);
  });

  it('redacts raw update-check failures', async () => {
    const updater = client({
      checkForUpdates: vi.fn(async () => { throw new Error('https://feed/?token=secret'); }),
    });
    const manager = new UpdateManager(updater, { isPackaged: true, sourceConfigured: true });
    const result = await manager.checkForUpdates();
    expect(result).toMatchObject({ status: 'error', message: 'Unable to check for updates.' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('downloads only after availability and an explicit call', async () => {
    const events: string[] = [];
    const baseCachePath = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-cache-base-'));
    directories.push(baseCachePath);
    const bootstrap = loadUpdateBootstrapConfig({
      packaged: false,
      resourcesPath: 'unused',
    });
    const updater = client({
      checkForUpdates: vi.fn(async () => ({
        isUpdateAvailable: true, updateInfo: { version: '1.1.0' },
      })),
      downloadUpdate: vi.fn(async () => {
        events.push('client-download');
        return ['update.exe'];
      }),
    });
    const manager = new UpdateManager(updater, {
      isPackaged: true,
      sourceConfigured: true,
      prepareDownloadCache: () => {
        events.push('cache-preflight');
        return prepareUpdaterCacheRoot(baseCachePath, bootstrap);
      },
    });
    await manager.checkForUpdates();
    await expect(manager.downloadUpdate()).resolves.toMatchObject({ status: 'downloaded', version: '1.1.0' });
    expect(events).toEqual(['cache-preflight', 'client-download']);
    expect(fs.statSync(path.join(
      baseCachePath,
      bootstrap.updaterCacheDirName,
      'pending',
    )).isDirectory()).toBe(true);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('matches electron-updater cache-base selection and rejects relative overrides', () => {
    const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-cache-home-'));
    directories.push(homeDirectory);
    const localAppData = path.join(homeDirectory, 'local-app-data');
    const windowsFallback = path.join(homeDirectory, 'AppData', 'Local');
    const macFallback = path.join(homeDirectory, 'Library', 'Caches');
    const linuxFallback = path.join(homeDirectory, '.cache');
    const xdgCacheHome = path.join(homeDirectory, 'xdg-cache');
    for (const directory of [localAppData, windowsFallback, macFallback, linuxFallback, xdgCacheHome]) {
      fs.mkdirSync(directory, { recursive: true });
    }

    expect(resolveElectronUpdaterBaseCachePath({
      platform: 'win32', localAppData, homeDirectory,
    })).toBe(localAppData);
    expect(resolveElectronUpdaterBaseCachePath({
      platform: 'win32', homeDirectory,
    })).toBe(windowsFallback);
    expect(resolveElectronUpdaterBaseCachePath({
      platform: 'darwin', homeDirectory,
    })).toBe(macFallback);
    expect(resolveElectronUpdaterBaseCachePath({
      platform: 'linux', xdgCacheHome, homeDirectory,
    })).toBe(xdgCacheHome);
    expect(resolveElectronUpdaterBaseCachePath({
      platform: 'linux', homeDirectory,
    })).toBe(linuxFallback);
    expect(() => resolveElectronUpdaterBaseCachePath({
      platform: 'win32', localAppData: 'relative-cache', homeDirectory,
    })).toThrow('must be absolute');
  });

  it('blocks download before the client when pending is a real directory junction', async () => {
    const baseCachePath = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-cache-base-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-cache-outside-'));
    directories.push(baseCachePath, outside);
    const bootstrap = loadUpdateBootstrapConfig({
      packaged: false,
      resourcesPath: 'unused',
    });
    const cacheRoot = path.join(baseCachePath, bootstrap.updaterCacheDirName);
    fs.mkdirSync(cacheRoot);
    const pending = path.join(cacheRoot, 'pending');
    fs.symlinkSync(outside, pending, 'junction');
    const updater = client({
      checkForUpdates: vi.fn(async () => ({
        isUpdateAvailable: true, updateInfo: { version: '1.1.0' },
      })),
    });
    const manager = new UpdateManager(updater, {
      isPackaged: true,
      sourceConfigured: true,
      prepareDownloadCache: () => prepareUpdaterCacheRoot(baseCachePath, bootstrap),
    });
    await manager.checkForUpdates();
    await expect(manager.downloadUpdate()).resolves.toMatchObject({ status: 'error' });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('never installs without both a completed download and literal confirmation', async () => {
    const updater = client({
      checkForUpdates: vi.fn(async () => ({
        isUpdateAvailable: true, updateInfo: { version: '1.1.0' },
      })),
    });
    const manager = new UpdateManager(updater, { isPackaged: true, sourceConfigured: true });
    expect(manager.installDownloadedUpdate(true)).toBe(false);
    await manager.checkForUpdates();
    await manager.downloadUpdate();
    expect(manager.installDownloadedUpdate(false)).toBe(false);
    expect(manager.installDownloadedUpdate(true)).toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, false);
  });
});
