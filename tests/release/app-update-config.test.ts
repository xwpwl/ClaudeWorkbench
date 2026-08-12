import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readBoundRegularFile } from '../../scripts/generate-app-update-config.mjs';
import {
  bootstrapConfiguresUpdateSource,
  loadUpdateBootstrapConfig,
  readBoundBootstrapResource,
  resolveUpdaterCacheRoot,
  type UpdateBootstrapFileSystem,
} from '../../src/main/release/UpdateBootstrapConfig';

const workspace = process.cwd();
const configPath = path.join(workspace, 'build-resources', 'app-update.yml');
const contractPath = path.join(workspace, 'src', 'shared', 'update-bootstrap-contract.json');
const generatorPath = path.join(workspace, 'scripts', 'generate-app-update-config.mjs');
const builderConfig = fs.readFileSync(path.join(workspace, 'electron-builder.yml'), 'utf8');
const temporaryDirectories: string[] = [];
const EXPECTED_BYTES = Buffer.from([
  'provider: generic',
  'url: https://updates.invalid/disabled/',
  'updaterCacheDirName: claude-workbench-updater',
  '',
].join('\n'), 'utf8');

function runGenerator(mode: string) {
  return spawnSync(process.execPath, [generatorPath, mode], {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
    },
    windowsHide: true,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('non-routing updater bootstrap configuration', () => {
  it('regenerates exact LF-only bytes from the one bounded tracked contract', () => {
    const contractBytes = fs.readFileSync(contractPath);
    const contract = JSON.parse(contractBytes.toString('utf8')) as Record<string, unknown>;
    const configBytes = fs.readFileSync(configPath);

    expect(Buffer.from(contractBytes.toString('utf8'), 'utf8')).toEqual(contractBytes);
    expect(Object.keys(contract)).toEqual([
      'schemaVersion',
      'provider',
      'url',
      'updaterCacheDirName',
    ]);
    expect(contract).toEqual({
      schemaVersion: 1,
      provider: 'generic',
      url: 'https://updates.invalid/disabled/',
      updaterCacheDirName: 'claude-workbench-updater',
    });
    expect(configBytes).toEqual(EXPECTED_BYTES);
    expect(configBytes.includes(Buffer.from('\r', 'utf8'))).toBe(false);

    const verification = runGenerator('--verify');
    expect(verification.error).toBeUndefined();
    expect(verification.status, `${verification.stdout}\n${verification.stderr}`).toBe(0);
    expect(verification.stdout).toBe('app-update.yml: MATCH\n');
    expect(verification.stderr).toBe('');
  });

  it('is copied to the default resource name without becoming a publish or update channel', () => {
    expect(builderConfig).toMatch(
      /^\s{2}- from: build-resources\/app-update\.yml\r?\n\s{4}to: app-update\.yml$/mu,
    );
    expect(builderConfig).not.toMatch(/^publish:/mu);
    expect(EXPECTED_BYTES.toString('utf8')).not.toMatch(
      /credential|token|password|authorization|channel|sha(?:256|512)|path:|query|fragment|userinfo|localhost|127\.0\.0\.1|\[?::1\]?|192\.168\.|10\.\d+\.|172\.(?:1[6-9]|2\d|3[01])\.|github\.com|anthropic\.com|openai\.com/iu,
    );
    const placeholder = new URL('https://updates.invalid/disabled/');
    expect(placeholder.protocol).toBe('https:');
    expect(placeholder.hostname).toBe('updates.invalid');
    expect(placeholder.pathname).toBe('/disabled/');
    expect(placeholder.username).toBe('');
    expect(placeholder.password).toBe('');
    expect(placeholder.search).toBe('');
    expect(placeholder.hash).toBe('');
  });

  it('verifies packaged bytes before exposing its main-owned cache-root resolver', () => {
    const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-update-bootstrap-'));
    temporaryDirectories.push(resourcesPath);
    fs.writeFileSync(path.join(resourcesPath, 'app-update.yml'), EXPECTED_BYTES);

    const loaded = loadUpdateBootstrapConfig({ packaged: true, resourcesPath });
    expect(loaded).toEqual({
      provider: 'generic',
      placeholderUrl: 'https://updates.invalid/disabled/',
      updaterCacheDirName: 'claude-workbench-updater',
    });
    expect(resolveUpdaterCacheRoot('CACHE', loaded)).toBe(
      path.join('CACHE', 'claude-workbench-updater'),
    );

    fs.writeFileSync(
      path.join(resourcesPath, 'app-update.yml'),
      Buffer.concat([EXPECTED_BYTES, Buffer.from('# changed\n', 'utf8')]),
    );
    expect(() => loadUpdateBootstrapConfig({ packaged: true, resourcesPath }))
      .toThrow('does not match the tracked bootstrap contract');

    const missingResources = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workbench-update-bootstrap-missing-'),
    );
    temporaryDirectories.push(missingResources);
    expect(() => loadUpdateBootstrapConfig({
      packaged: true,
      resourcesPath: missingResources,
    })).toThrow('does not match the tracked bootstrap contract');
  });

  it('rejects a final reparse point or file-identity drift before trusting packaged bytes', () => {
    const resourcePath = path.join(os.tmpdir(), 'virtual-app-update.yml');
    const facts = (
      dev: number,
      ino: number,
      symbolicLink = false,
    ) => ({
      dev,
      ino,
      isFile: () => true,
      isSymbolicLink: () => symbolicLink,
    });
    const symlinkFileSystem: UpdateBootstrapFileSystem = {
      lstat: () => facts(1, 1, true),
      realpath: (target) => target,
      open: () => { throw new Error('must not open'); },
      fstat: () => facts(1, 1),
      read: () => EXPECTED_BYTES,
      close: () => undefined,
    };
    expect(() => readBoundBootstrapResource(resourcePath, symlinkFileSystem))
      .toThrow('plain regular file');

    let closed = false;
    const driftFileSystem: UpdateBootstrapFileSystem = {
      lstat: () => facts(1, 1),
      realpath: (target) => target,
      open: () => 7,
      fstat: () => facts(1, 2),
      read: () => EXPECTED_BYTES,
      close: () => { closed = true; },
    };
    expect(() => readBoundBootstrapResource(resourcePath, driftFileSystem))
      .toThrow('identity changed');
    expect(closed).toBe(true);
  });

  it('never exposes the reserved placeholder as a configurable feed URL', () => {
    const loaded = loadUpdateBootstrapConfig({ packaged: false, resourcesPath: 'unused' });
    expect(Object.keys(loaded)).toEqual([
      'provider',
      'placeholderUrl',
      'updaterCacheDirName',
    ]);
    expect('feedUrl' in loaded).toBe(false);
    expect('setFeedURL' in loaded).toBe(false);
    expect(bootstrapConfiguresUpdateSource(loaded)).toBe(false);
  });

  it('fails closed on byte drift or an unsupported mode without rewriting the tracked file', () => {
    const original = fs.readFileSync(configPath);
    const changed = Buffer.concat([original, Buffer.from('# changed\n', 'utf8')]);
    try {
      fs.writeFileSync(configPath, changed);
      const mismatch = runGenerator('--verify');
      expect(mismatch.error).toBeUndefined();
      expect(mismatch.status).toBe(1);
      expect(mismatch.stdout).toBe('app-update.yml: MISMATCH\n');
      expect(mismatch.stderr).toBe('');
      expect(fs.readFileSync(configPath)).toEqual(changed);

      const unsupported = runGenerator('--unsupported');
      expect(unsupported.error).toBeUndefined();
      expect(unsupported.status).toBe(1);
      expect(unsupported.stdout).toBe('');
      expect(unsupported.stderr).toBe(
        'Usage: node scripts/generate-app-update-config.mjs --write|--verify\n',
      );
      expect(fs.readFileSync(configPath)).toEqual(changed);
    } finally {
      fs.writeFileSync(configPath, original);
    }
    expect(fs.readFileSync(configPath)).toEqual(EXPECTED_BYTES);
  });

  it('rejects a real junction in the output parent without writing outside', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-update-generator-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-update-generator-outside-'));
    temporaryDirectories.push(fixture, outside);
    fs.mkdirSync(path.join(fixture, 'scripts'));
    fs.mkdirSync(path.join(fixture, 'src', 'shared'), { recursive: true });
    fs.copyFileSync(generatorPath, path.join(fixture, 'scripts', 'generate-app-update-config.mjs'));
    fs.copyFileSync(contractPath, path.join(fixture, 'src', 'shared', 'update-bootstrap-contract.json'));
    fs.symlinkSync(outside, path.join(fixture, 'build-resources'), 'junction');

    const write = spawnSync(
      process.execPath,
      [path.join(fixture, 'scripts', 'generate-app-update-config.mjs'), '--write'],
      { cwd: fixture, encoding: 'utf8', windowsHide: true },
    );
    expect(write.status).toBe(1);
    expect(fs.existsSync(path.join(outside, 'app-update.yml'))).toBe(false);
  });

  it('rejects an injected final-file reparse point in the generator binding primitive', () => {
    const virtualPath = path.join(os.tmpdir(), 'generator-virtual-app-update.yml');
    const fileSystem = {
      realpathSync: Object.assign((target: string) => target, {
        native: (target: string) => target,
      }),
      lstatSync: () => ({
        dev: 1,
        ino: 1,
        isFile: () => true,
        isSymbolicLink: () => true,
      }),
      openSync: () => { throw new Error('must not open'); },
    };
    expect(() => readBoundRegularFile(virtualPath, fileSystem))
      .toThrow('plain regular file');
  });
});
