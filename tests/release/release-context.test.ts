import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalJson,
  safeRelativePath,
  sha256File,
  writeAtomicJson,
} from '../../scripts/release/lib/common.mjs';
import { createReleaseContext } from '../../scripts/release/lib/release-context.mjs';

const COMMIT_SHA = '89abcdef0123456789abcdef0123456789abcdef';
const LOCK_SHA = '1'.repeat(64);
const NOTES_SHA = '2'.repeat(64);
const BUILD_TIME = '2026-08-12T12:34:56Z';
const SOURCE_DATE_EPOCH = 1_786_538_096;
const METADATA_PATH = 'release-validation/staging/release-metadata.json';

let workspace = '';
const roots: string[] = [];

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validMetadata(): Record<string, unknown> {
  return {
    metadataSchemaVersion: 1,
    purpose: 'candidate',
    productName: 'Claude Workbench',
    appId: 'com.claudeworkbench.app',
    version: '1.0.1-rc.1',
    channel: 'rc',
    buildId: '1.0.1-rc.1+89abcdef0123.20260812T123456Z',
    branch: 'task15',
    commitSha: COMMIT_SHA,
    commitShort: '89abcdef0123',
    dirty: false,
    buildTimeUtc: BUILD_TIME,
    nodeVersion: 'v24.15.0',
    npmVersion: '11.12.1',
    electronVersion: '35.7.5',
    sqliteSchemaVersion: 7,
    platform: 'win32',
    arch: 'x64',
    lockfileSha256: LOCK_SHA,
    releaseNotesSha256: NOTES_SHA,
  };
}

function writeMetadata(metadata = validMetadata()): { bytes: Buffer; sha256: string } {
  const absolutePath = path.join(workspace, ...METADATA_PATH.split('/'));
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  fs.writeFileSync(absolutePath, bytes);
  return { bytes, sha256: sha256(bytes) };
}

function validInput(metadataSha256: string): Record<string, unknown> {
  return {
    workspaceRoot: workspace,
    releaseFacts: {
      branch: 'task15',
      dirty: false,
      commitSha: COMMIT_SHA,
      packageLockSha256: LOCK_SHA,
      releaseNotesSha256: NOTES_SHA,
      sourceDateEpoch: SOURCE_DATE_EPOCH,
      toolchain: {
        nodeVersion: 'v24.15.0',
        npmVersion: '11.12.1',
        electronVersion: '35.7.5',
        platform: 'win32',
        arch: 'x64',
      },
    },
    preparedMetadata: {
      relativePath: METADATA_PATH,
      sha256: metadataSha256,
    },
  };
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-release-context-'));
  roots.push(workspace);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('canonical release utilities', () => {
  it('recursively sorts object keys, preserves array order, and emits exactly one LF', () => {
    const value = {
      z: [{ y: 2, x: 1 }, 3],
      a: { d: true, b: null },
    };

    expect(canonicalJson(value)).toBe(
      '{"a":{"b":null,"d":true},"z":[{"x":1,"y":2},3]}\n',
    );
    expect(canonicalJson(value).endsWith('\n\n')).toBe(false);
  });

  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1n,
    Symbol('not-json'),
    () => undefined,
    new Date('2026-08-12T12:34:56Z'),
    [, 'sparse'],
    [undefined],
  ])('rejects values that JSON would omit or silently change: %s', (value) => {
    expect(() => canonicalJson(value)).toThrow('JSON');
  });

  it('rejects cyclic structures', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow('cyclic');
  });

  it('accepts only contained ordinary workspace-relative paths and returns POSIX form', () => {
    fs.mkdirSync(path.join(workspace, 'release-validation', 'reports'), { recursive: true });

    expect(safeRelativePath(workspace, 'release-validation\\reports\\preflight.json'))
      .toBe('release-validation/reports/preflight.json');
    for (const unsafe of [
      'C:\\Users\\person\\secret.txt',
      '\\\\server\\share\\secret.txt',
      '\\\\?\\C:\\secret.txt',
      '/absolute/secret.txt',
      '../escape.json',
      'release-validation/../../escape.json',
      'D:drive-relative.txt',
    ]) {
      expect(() => safeRelativePath(workspace, unsafe)).toThrow('workspace-relative');
    }
  });

  it('rejects final and ancestor reparse traversal', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-release-outside-'));
    roots.push(outside);
    fs.writeFileSync(path.join(outside, 'evidence.json'), '{}\n');
    fs.symlinkSync(outside, path.join(workspace, 'linked'), 'junction');

    expect(() => safeRelativePath(workspace, 'linked')).toThrow('reparse');
    expect(() => safeRelativePath(workspace, 'linked/evidence.json')).toThrow('reparse');
  });

  it('writes canonical JSON through an exclusive 0600 sibling, flushes, and renames', () => {
    fs.mkdirSync(path.join(workspace, 'release-validation', 'reports'), { recursive: true });
    const openSpy = vi.spyOn(fs, 'openSync');
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync');
    const renameSpy = vi.spyOn(fs, 'renameSync');

    const relative = writeAtomicJson(
      workspace,
      'release-validation/reports/preflight.json',
      { z: 2, a: 1 },
    );
    const destination = path.join(workspace, ...relative.split('/'));

    expect(relative).toBe('release-validation/reports/preflight.json');
    expect(fs.readFileSync(destination, 'utf8')).toBe('{"a":1,"z":2}\n');
    expect(openSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\.preflight\.json\.[0-9a-f]+\.tmp$/u),
      'wx',
      0o600,
    );
    expect(fsyncSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(renameSpy).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(path.dirname(destination))).toEqual(['preflight.json']);
  });

  it('removes the sibling temporary file and leaves no success marker after failure', () => {
    const directory = path.join(workspace, 'release-validation', 'reports');
    fs.mkdirSync(directory, { recursive: true });
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('injected rename failure');
    });

    expect(() => writeAtomicJson(
      workspace,
      'release-validation/reports/preflight.json',
      { ok: true },
    )).toThrow('injected rename failure');
    expect(fs.existsSync(path.join(directory, 'preflight.json'))).toBe(false);
    const residue = fs.readdirSync(directory);
    expect(residue).toHaveLength(1);
    expect(residue[0]).toMatch(/^\.preflight\.json\.[0-9a-f]+\.tmp$/u);
    const residueStat = fs.lstatSync(path.join(directory, residue[0]));
    expect(residueStat.isFile()).toBe(true);
    expect(residueStat.isSymbolicLink()).toBe(false);
  });

  it('rejects a parent replacement performed across rename and does not delete attacker bytes', () => {
    const directory = path.join(workspace, 'release-validation', 'reports');
    const movedDirectory = path.join(workspace, 'release-validation', 'reports-owned');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-atomic-outside-'));
    roots.push(outside);
    fs.mkdirSync(directory, { recursive: true });
    const originalRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementationOnce((source, destination) => {
      originalRename(source, destination);
      originalRename(directory, movedDirectory);
      fs.symlinkSync(outside, directory, 'junction');
      fs.writeFileSync(path.join(outside, 'preflight.json'), 'attacker-owned\n');
    });

    expect(() => writeAtomicJson(
      workspace,
      'release-validation/reports/preflight.json',
      { trusted: true },
    )).toThrow();
    const attackerPath = path.join(outside, 'preflight.json');
    if (fs.existsSync(attackerPath)) {
      expect(fs.readFileSync(attackerPath, 'utf8')).toBe('attacker-owned\n');
    }
  });

  it('writes no report bytes when the parent identity changes before the temp handle is bound', () => {
    const directory = path.join(workspace, 'release-validation', 'reports');
    const movedDirectory = path.join(workspace, 'release-validation', 'reports-owned');
    fs.mkdirSync(directory, { recursive: true });
    const originalOpen = fs.openSync.bind(fs);
    const originalRename = fs.renameSync.bind(fs);
    const originalWrite = fs.writeFileSync.bind(fs);
    let directoryDescriptor: number | undefined;
    let reportWriteCount = 0;
    vi.spyOn(fs, 'openSync').mockImplementation(((file: unknown, ...args: unknown[]) => {
      if (typeof file === 'string' && path.resolve(file) === directory) {
        directoryDescriptor = originalOpen(file as never, ...args as never[]);
        return directoryDescriptor;
      }
      if (typeof file === 'string' && /\.preflight\.json\.[0-9a-f]+\.tmp$/u.test(file)) {
        fs.closeSync(directoryDescriptor!);
        originalRename(directory, movedDirectory);
        fs.mkdirSync(directory);
      }
      return originalOpen(file as never, ...args as never[]);
    }) as typeof fs.openSync);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: unknown, ...args: unknown[]) => {
      if (typeof file === 'number') reportWriteCount += 1;
      return originalWrite(file as never, ...args as never[]);
    }) as typeof fs.writeFileSync);

    expect(() => writeAtomicJson(
      workspace,
      'release-validation/reports/preflight.json',
      { trusted: true },
    )).toThrow();
    expect(reportWriteCount).toBe(0);
    expect(fs.existsSync(path.join(directory, 'preflight.json'))).toBe(false);
    for (const name of fs.readdirSync(directory)) {
      expect(fs.statSync(path.join(directory, name)).size).toBe(0);
    }
  });

  it('rejects a rename that does not preserve the temporary file identity', () => {
    const directory = path.join(workspace, 'release-validation', 'reports');
    fs.mkdirSync(directory, { recursive: true });
    const originalRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementationOnce((source, destination) => {
      originalRename(source, `${source}.owned`);
      fs.writeFileSync(source, 'substituted\n');
      originalRename(source, destination);
    });

    expect(() => writeAtomicJson(
      workspace,
      'release-validation/reports/preflight.json',
      { trusted: true },
    )).toThrow(/identity|temporary/iu);
  });

  it('treats unsupported directory fsync as explicit platform behavior but propagates I/O failure', () => {
    const directory = path.join(workspace, 'release-validation', 'reports');
    fs.mkdirSync(directory, { recursive: true });
    const originalFsync = fs.fsyncSync.bind(fs);
    let calls = 0;
    vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      calls += 1;
      if (calls === 2) {
        throw Object.assign(new Error('directory sync unsupported'), { code: 'EINVAL' });
      }
      return originalFsync(descriptor);
    });
    expect(writeAtomicJson(
      workspace,
      'release-validation/reports/preflight.json',
      { trusted: true },
    )).toBe('release-validation/reports/preflight.json');
    expect(calls).toBeGreaterThanOrEqual(2);

    vi.restoreAllMocks();
    fs.unlinkSync(path.join(directory, 'preflight.json'));
    calls = 0;
    vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      calls += 1;
      if (calls === 2) {
        throw Object.assign(new Error('directory sync failed'), { code: 'EIO' });
      }
      return originalFsync(descriptor);
    });
    expect(() => writeAtomicJson(
      workspace,
      'release-validation/reports/preflight.json',
      { trusted: true },
    )).toThrow('directory sync failed');
    expect(fs.readFileSync(path.join(directory, 'preflight.json'), 'utf8'))
      .toBe('{"trusted":true}\n');
  });

  it('never removes a substituted temporary path during failure cleanup', () => {
    const directory = path.join(workspace, 'release-validation', 'reports');
    fs.mkdirSync(directory, { recursive: true });
    const originalRename = fs.renameSync.bind(fs);
    let substitutedPath = '';
    vi.spyOn(fs, 'renameSync').mockImplementationOnce((source) => {
      substitutedPath = String(source);
      originalRename(source, `${source}.owned`);
      fs.writeFileSync(source, 'do-not-delete\n');
      throw new Error('injected rename failure');
    });

    expect(() => writeAtomicJson(
      workspace,
      'release-validation/reports/preflight.json',
      { trusted: true },
    )).toThrow('injected rename failure');
    expect(fs.readFileSync(substitutedPath, 'utf8')).toBe('do-not-delete\n');
  });

  it('never calls pathname unlink after a writer failure, even if cleanup identity races', () => {
    const directory = path.join(workspace, 'release-validation', 'reports');
    fs.mkdirSync(directory, { recursive: true });
    const originalRename = fs.renameSync.bind(fs);
    const originalUnlink = fs.unlinkSync.bind(fs);
    let writerPath = '';
    vi.spyOn(fs, 'renameSync').mockImplementationOnce((source) => {
      writerPath = String(source);
      throw new Error('injected rename failure');
    });
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(((target: unknown) => {
      if (String(target) === writerPath) {
        originalRename(writerPath, `${writerPath}.owned`);
        fs.writeFileSync(writerPath, 'attacker-survives\n');
      }
      return originalUnlink(target as never);
    }) as typeof fs.unlinkSync);

    expect(() => writeAtomicJson(
      workspace,
      'release-validation/reports/preflight.json',
      { trusted: true },
    )).toThrow('injected rename failure');
    expect(unlinkSpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(writerPath, 'utf8')).toBe('{"trusted":true}\n');
    expect(fs.existsSync(path.join(directory, 'preflight.json'))).toBe(false);
  });

  it('hashes binary bytes without text decoding', () => {
    const binaryPath = path.join(workspace, 'binary.dat');
    const bytes = Buffer.from([0x00, 0xff, 0xc3, 0x28, 0x0d, 0x0a]);
    fs.writeFileSync(binaryPath, bytes);
    expect(sha256File(binaryPath)).toBe(sha256(bytes));
  });
});

describe('createReleaseContext', () => {
  it('builds one immutable, path-free context from strict facts and the fixed snapshot', () => {
    const prepared = writeMetadata();
    const context = createReleaseContext(validInput(prepared.sha256));

    expect(context).toMatchObject({
      schemaVersion: 1,
      branch: 'task15',
      dirty: false,
      commitSha: COMMIT_SHA,
      version: '1.0.1-rc.1',
      channel: 'rc',
      buildId: '1.0.1-rc.1+89abcdef0123.20260812T123456Z',
      metadataPath: METADATA_PATH,
      metadataSha256: prepared.sha256,
      packageLockSha256: LOCK_SHA,
      releaseNotesSha256: NOTES_SHA,
      sourceDateEpoch: SOURCE_DATE_EPOCH,
      toolchain: {
        nodeVersion: 'v24.15.0',
        npmVersion: '11.12.1',
        electronVersion: '35.7.5',
        platform: 'win32',
        arch: 'x64',
      },
    });
    expect(context.contextId).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.toolchain)).toBe(true);
    expect(JSON.stringify(context)).not.toContain(workspace);
  });

  it('derives an identical context ID in a different workspace', () => {
    const first = writeMetadata();
    const firstContext = createReleaseContext(validInput(first.sha256));
    const secondWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-release-context-'));
    roots.push(secondWorkspace);
    workspace = secondWorkspace;
    const second = writeMetadata();
    const secondContext = createReleaseContext(validInput(second.sha256));
    expect(secondContext.contextId).toBe(firstContext.contextId);
  });

  it('reads prepared metadata only from an already-open ordinary file descriptor', () => {
    const prepared = writeMetadata();
    const metadataAbsolute = path.join(workspace, ...METADATA_PATH.split('/'));
    const originalRead = fs.readFileSync.bind(fs);
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: unknown, ...args: unknown[]) => {
      if (typeof file === 'string' && path.resolve(file) === metadataAbsolute) {
        throw new Error('pathname metadata read is forbidden');
      }
      return originalRead(file as never, ...args as never[]);
    }) as typeof fs.readFileSync);

    expect(() => createReleaseContext(validInput(prepared.sha256))).not.toThrow();
    expect(readSpy.mock.calls.some(([file]) => typeof file === 'number')).toBe(true);
  });

  it('rejects replacement between pathname validation and metadata read', () => {
    writeMetadata();
    const metadataAbsolute = path.join(workspace, ...METADATA_PATH.split('/'));
    const originalPath = `${metadataAbsolute}.original`;
    const replacementBytes = Buffer.from(`${JSON.stringify(validMetadata())}\n`, 'utf8');
    const originalRead = fs.readFileSync.bind(fs);
    const originalOpen = fs.openSync.bind(fs);
    let replaced = false;
    const replaceMetadata = () => {
      replaced = true;
      fs.renameSync(metadataAbsolute, originalPath);
      fs.writeFileSync(metadataAbsolute, replacementBytes);
    };
    vi.spyOn(fs, 'openSync').mockImplementation(((file: unknown, ...args: unknown[]) => {
      if (!replaced && typeof file === 'string' && path.resolve(file) === metadataAbsolute) {
        replaceMetadata();
      }
      return originalOpen(file as never, ...args as never[]);
    }) as typeof fs.openSync);
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: unknown, ...args: unknown[]) => {
      if (!replaced && typeof file === 'string' && path.resolve(file) === metadataAbsolute) {
        replaceMetadata();
      }
      return originalRead(file as never, ...args as never[]);
    }) as typeof fs.readFileSync);

    expect(() => createReleaseContext(validInput(sha256(replacementBytes))))
      .toThrow(/identity|drift|hash/iu);
  });

  it.each(['mutate-bytes', 'replace-path']) (
    'rejects metadata %s immediately after the held-handle read',
    (mode) => {
      const prepared = writeMetadata();
      const metadataAbsolute = path.join(workspace, ...METADATA_PATH.split('/'));
      const originalRead = fs.readFileSync.bind(fs);
      let mutated = false;
      vi.spyOn(fs, 'readFileSync').mockImplementation(((file: unknown, ...args: unknown[]) => {
        const bytes = originalRead(file as never, ...args as never[]);
        const isMetadata = typeof file === 'number'
          || (typeof file === 'string' && path.resolve(file) === metadataAbsolute);
        if (!mutated && isMetadata) {
          mutated = true;
          if (mode === 'mutate-bytes') {
            fs.appendFileSync(metadataAbsolute, ' ');
          } else {
            fs.renameSync(metadataAbsolute, `${metadataAbsolute}.original`);
            fs.writeFileSync(metadataAbsolute, bytes);
          }
        }
        return bytes;
      }) as typeof fs.readFileSync);

      expect(() => createReleaseContext(validInput(prepared.sha256)))
        .toThrow(/identity|changed|drift|stable/iu);
    },
  );

  it('rejects a non-task15 branch and a dirty worktree', () => {
    const prepared = writeMetadata();
    const input = validInput(prepared.sha256) as any;
    expect(() => createReleaseContext({
      ...input,
      releaseFacts: { ...input.releaseFacts, branch: 'main' },
    })).toThrow('task15');
    expect(() => createReleaseContext({
      ...input,
      releaseFacts: { ...input.releaseFacts, dirty: true },
    })).toThrow('clean');
  });

  it.each([
    ['commitSha', 'a'.repeat(40)],
    ['packageLockSha256', '3'.repeat(64)],
    ['releaseNotesSha256', '4'.repeat(64)],
    ['sourceDateEpoch', SOURCE_DATE_EPOCH + 1],
  ])('rejects release-fact drift in %s', (key, value) => {
    const prepared = writeMetadata();
    const input = validInput(prepared.sha256) as any;
    expect(() => createReleaseContext({
      ...input,
      releaseFacts: { ...input.releaseFacts, [key]: value },
    })).toThrow(/drift|match|time/iu);
  });

  it.each([
    ['version', '1.0.1-rc.2'],
    ['channel', 'latest'],
    ['buildId', 'forged-build'],
    ['branch', 'main'],
    ['dirty', true],
    ['lockfileSha256', '3'.repeat(64)],
    ['releaseNotesSha256', '4'.repeat(64)],
  ])('rejects metadata drift in %s', (key, value) => {
    const metadata = { ...validMetadata(), [key]: value };
    const prepared = writeMetadata(metadata);
    expect(() => createReleaseContext(validInput(prepared.sha256))).toThrow();
  });

  it('rejects snapshot hash/path drift, unknown fields, and a non-canonical timestamp', () => {
    const prepared = writeMetadata();
    const input = validInput(prepared.sha256) as any;
    expect(() => createReleaseContext({
      ...input,
      preparedMetadata: { ...input.preparedMetadata, sha256: '5'.repeat(64) },
    })).toThrow('hash');
    expect(() => createReleaseContext({
      ...input,
      preparedMetadata: {
        ...input.preparedMetadata,
        relativePath: 'release-validation/other.json',
      },
    })).toThrow('fixed');
    expect(() => createReleaseContext({ ...input, unexpected: true })).toThrow('unexpected');

    const metadata = { ...validMetadata(), buildTimeUtc: '2026-08-12T12:34:56.000Z' };
    const nonCanonical = writeMetadata(metadata);
    expect(() => createReleaseContext(validInput(nonCanonical.sha256))).toThrow('time');
  });
});
