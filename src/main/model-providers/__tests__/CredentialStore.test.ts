import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CredentialStore,
  CredentialStoreError,
  type SafeStorageFacade,
} from '../CredentialStore';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-provider-credentials-'));
  roots.push(root);
  return root;
}

function safeStorage(overrides: Partial<SafeStorageFacade> = {}): SafeStorageFacade {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText) => Buffer.from(`encrypted:${plainText}`, 'utf8'),
    decryptString: (encrypted) => encrypted.toString('utf8').replace(/^encrypted:/u, ''),
    getSelectedStorageBackend: () => 'dpapi',
    ...overrides,
  };
}

function store(options: {
  platform?: NodeJS.Platform;
  safeStorage?: SafeStorageFacade;
  maxBlobBytes?: number;
  randomId?: () => string;
} = {}): CredentialStore {
  return new CredentialStore(temporaryRoot(), options.safeStorage ?? safeStorage(), {
    platform: options.platform ?? 'win32',
    maxBlobBytes: options.maxBlobBytes,
    randomId: options.randomId,
  });
}

const INTERNAL_NAME = 'model-tier-synthetic-hmac-v1';
const INTERNAL_MANIFEST = '.internal-credential-refs.v1.json';
const INTERNAL_LOCK = '.internal-credential-refs.v1.lock';
const INTERNAL_SECRET = 'h'.repeat(43);

function storeAt(
  directory: string,
  options: {
    safeStorage?: SafeStorageFacade;
    randomId?: () => string;
  } = {},
): CredentialStore {
  return new CredentialStore(directory, options.safeStorage ?? safeStorage(), {
    platform: 'win32',
    randomId: options.randomId,
  });
}

describe('CredentialStore', () => {
  it('provisions one encrypted internal secret and returns the same identity after restart', () => {
    const root = temporaryRoot();
    const directory = path.join(root, 'vault');
    const first = storeAt(directory, {
      randomId: () => '7de5fe22-e45c-4ae0-9904-618379303d0b',
    });

    const initial = first.getOrCreateInternalSecret(INTERNAL_NAME, () => INTERNAL_SECRET);
    const restarted = storeAt(directory, {
      randomId: () => 'a80a4be6-0e1f-4207-ac29-0db955b4c997',
    });

    expect(initial).toBe(INTERNAL_SECRET);
    expect(restarted.getOrCreateInternalSecret(INTERNAL_NAME, () => 'rotated-key'))
      .toBe(INTERNAL_SECRET);
    expect(fs.readdirSync(directory).filter((name) => name.endsWith('.bin'))).toHaveLength(1);
    expect(fs.readFileSync(path.join(directory, INTERNAL_MANIFEST), 'utf8'))
      .not.toContain(INTERNAL_SECRET);
  });

  it.each([
    ['truncated JSON', '{"version":1'],
    ['unknown version', JSON.stringify({ version: 2, entries: [] })],
    ['unknown top-level key', JSON.stringify({ version: 1, entries: [], extra: true })],
    ['unknown entry key', JSON.stringify({
      version: 1,
      entries: [{
        name: INTERNAL_NAME,
        reference: 'safe-storage://v1/7de5fe22-e45c-4ae0-9904-618379303d0b',
        extra: true,
      }],
    })],
    ['unknown internal name', JSON.stringify({
      version: 1,
      entries: [{ name: 'other-internal-key', reference: 'safe-storage://v1/7de5fe22-e45c-4ae0-9904-618379303d0b' }],
    })],
    ['control-character name', JSON.stringify({
      version: 1,
      entries: [{ name: `${INTERNAL_NAME}\n`, reference: 'safe-storage://v1/7de5fe22-e45c-4ae0-9904-618379303d0b' }],
    })],
    ['duplicate name', JSON.stringify({
      version: 1,
      entries: [
        { name: INTERNAL_NAME, reference: 'safe-storage://v1/7de5fe22-e45c-4ae0-9904-618379303d0b' },
        { name: INTERNAL_NAME, reference: 'safe-storage://v1/a80a4be6-0e1f-4207-ac29-0db955b4c997' },
      ],
    })],
  ])('fails closed for an existing malformed internal manifest: %s', (_label, content) => {
    const directory = path.join(temporaryRoot(), 'vault');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, INTERNAL_MANIFEST), content);

    expect(() => storeAt(directory).getOrCreateInternalSecret(
      INTERNAL_NAME,
      () => 'replacement-key',
    )).toThrowError(/internal credential metadata/iu);
    expect(fs.readdirSync(directory).filter((name) => name.endsWith('.bin'))).toEqual([]);
  });

  it('rejects oversized and symlinked internal metadata', () => {
    const root = temporaryRoot();
    const oversizedDirectory = path.join(root, 'oversized');
    fs.mkdirSync(oversizedDirectory, { recursive: true });
    fs.writeFileSync(path.join(oversizedDirectory, INTERNAL_MANIFEST), Buffer.alloc(16 * 1024 + 1));
    expect(() => storeAt(oversizedDirectory).getOrCreateInternalSecret(
      INTERNAL_NAME,
      () => 'replacement-key',
    )).toThrowError(/internal credential metadata/iu);

    const linkedDirectory = path.join(root, 'linked');
    fs.mkdirSync(linkedDirectory, { recursive: true });
    const outside = path.join(root, 'outside.json');
    fs.writeFileSync(outside, JSON.stringify({ version: 1, entries: [] }));
    try {
      fs.symlinkSync(outside, path.join(linkedDirectory, INTERNAL_MANIFEST));
    } catch {
      return;
    }
    expect(() => storeAt(linkedDirectory).getOrCreateInternalSecret(
      INTERNAL_NAME,
      () => 'replacement-key',
    )).toThrowError(/internal credential metadata/iu);
  });

  it('fails closed when an existing internal reference is missing or cannot decrypt', () => {
    const root = temporaryRoot();
    const directory = path.join(root, 'vault');
    const first = storeAt(directory, {
      randomId: () => '7de5fe22-e45c-4ae0-9904-618379303d0b',
    });
    first.getOrCreateInternalSecret(INTERNAL_NAME, () => INTERNAL_SECRET);
    const blob = fs.readdirSync(directory).find((name) => name.endsWith('.bin')) as string;
    fs.rmSync(path.join(directory, blob));
    expect(() => storeAt(directory).getOrCreateInternalSecret(
      INTERNAL_NAME,
      () => 'replacement-key',
    )).toThrowError(/stored credential was not found/iu);

    const secondDirectory = path.join(root, 'decrypt');
    const second = storeAt(secondDirectory, {
      randomId: () => 'a80a4be6-0e1f-4207-ac29-0db955b4c997',
    });
    second.getOrCreateInternalSecret(INTERNAL_NAME, () => INTERNAL_SECRET);
    const unreadable = storeAt(secondDirectory, {
      safeStorage: safeStorage({ decryptString: () => { throw new Error('raw decrypt failure'); } }),
    });
    expect(() => unreadable.getOrCreateInternalSecret(
      INTERNAL_NAME,
      () => 'replacement-key',
    )).toThrowError('Stored credential could not be decrypted.');
  });

  it('fails closed on a concurrent first-provision lock instead of creating another identity', () => {
    const directory = path.join(temporaryRoot(), 'vault');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, INTERNAL_LOCK), 'locked', { flag: 'wx' });
    const vault = storeAt(directory, {
      randomId: () => '7de5fe22-e45c-4ae0-9904-618379303d0b',
    });

    expect(() => vault.getOrCreateInternalSecret(
      INTERNAL_NAME,
      () => INTERNAL_SECRET,
    )).toThrowError(/internal credential metadata/iu);
    expect(fs.readdirSync(directory).filter((name) => name.endsWith('.bin'))).toEqual([]);
  });

  it('keeps the internal secret isolated when a Provider credential is deleted', () => {
    const directory = path.join(temporaryRoot(), 'vault');
    const ids = [
      '7de5fe22-e45c-4ae0-9904-618379303d0b',
      'a80a4be6-0e1f-4207-ac29-0db955b4c997',
    ];
    const vault = storeAt(directory, { randomId: () => ids.shift() as string });
    expect(vault.getOrCreateInternalSecret(INTERNAL_NAME, () => INTERNAL_SECRET))
      .toBe(INTERNAL_SECRET);
    const providerReference = vault.create('provider-secret');

    vault.delete(providerReference);

    expect(vault.getOrCreateInternalSecret(INTERNAL_NAME, () => 'rotated-key'))
      .toBe(INTERNAL_SECRET);
  });
  it('stores only encrypted bytes and returns an opaque reference', () => {
    const vault = store({ randomId: () => '7de5fe22-e45c-4ae0-9904-618379303d0b' });
    const reference = vault.create('sk-secret-sentinel');

    expect(reference).toBe('safe-storage://v1/7de5fe22-e45c-4ae0-9904-618379303d0b');
    const files = fs.readdirSync(vault.directory);
    expect(files).toEqual(['7de5fe22-e45c-4ae0-9904-618379303d0b.bin']);
    expect(fs.readFileSync(path.join(vault.directory, files[0]), 'utf8')).toBe(
      'encrypted:sk-secret-sentinel',
    );
    expect(fs.readFileSync(path.join(vault.directory, files[0]), 'utf8')).not.toBe(
      'sk-secret-sentinel',
    );
  });

  it('decrypts a valid reference only inside the main-process store', () => {
    const vault = store();
    const reference = vault.create('private-key');
    expect(vault.read(reference)).toBe('private-key');
  });

  it('passes a secret to a callback without exposing storage internals', async () => {
    const vault = store();
    const reference = vault.create('one-shot-secret');
    await expect(vault.withSecret(reference, async (secret) => `${secret}:used`))
      .resolves.toBe('one-shot-secret:used');
  });

  it('fails closed when OS encryption is unavailable', () => {
    const vault = store({
      safeStorage: safeStorage({ isEncryptionAvailable: () => false }),
    });
    expect(() => vault.create('secret')).toThrowError(CredentialStoreError);
    try {
      vault.create('secret');
    } catch (error) {
      expect(error).toMatchObject({ code: 'ENCRYPTION_UNAVAILABLE' });
    }
    expect(fs.readdirSync(vault.directory)).toEqual([]);
  });

  it('rejects the insecure Linux basic_text backend', () => {
    const vault = store({
      platform: 'linux',
      safeStorage: safeStorage({ getSelectedStorageBackend: () => 'basic_text' }),
    });
    expect(() => vault.create('secret')).toThrowError(/secure credential encryption is unavailable/iu);
  });

  it('allows a secure Linux backend', () => {
    const vault = store({
      platform: 'linux',
      safeStorage: safeStorage({ getSelectedStorageBackend: () => 'gnome_libsecret' }),
    });
    expect(vault.read(vault.create('secret'))).toBe('secret');
  });

  it.each([
    '',
    'safe-storage://v1/',
    'safe-storage://v2/7de5fe22-e45c-4ae0-9904-618379303d0b',
    'file:///tmp/key',
    'safe-storage://v1/../outside',
    'safe-storage://v1/C:/outside',
    'safe-storage://v1/not-a-uuid',
    ' SAFE-storage://v1/7de5fe22-e45c-4ae0-9904-618379303d0b',
  ])('rejects malformed or path-bearing references: %s', (reference) => {
    expect(() => store().read(reference)).toThrowError(/credential reference/iu);
  });

  it('rejects a symlinked credential file', () => {
    const vault = store({ randomId: () => '7de5fe22-e45c-4ae0-9904-618379303d0b' });
    const reference = vault.create('secret');
    const target = path.join(temporaryRoot(), 'outside.bin');
    fs.writeFileSync(target, 'encrypted:outside');
    fs.rmSync(path.join(vault.directory, '7de5fe22-e45c-4ae0-9904-618379303d0b.bin'));
    try {
      fs.symlinkSync(target, path.join(vault.directory, '7de5fe22-e45c-4ae0-9904-618379303d0b.bin'));
    } catch {
      return;
    }
    expect(() => vault.read(reference)).toThrowError(/symbolic link/iu);
  });

  it('rejects a credential vault replaced by a directory link', () => {
    const vault = store({ randomId: () => '7de5fe22-e45c-4ae0-9904-618379303d0b' });
    const reference = vault.create('secret');
    const outside = temporaryRoot();
    fs.writeFileSync(
      path.join(outside, '7de5fe22-e45c-4ae0-9904-618379303d0b.bin'),
      'encrypted:redirected-secret',
    );
    fs.rmSync(vault.directory, { recursive: true });
    try {
      fs.symlinkSync(outside, vault.directory, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }

    expect(() => vault.read(reference)).toThrowError(/symbolic link/iu);
    expect(() => vault.delete(reference)).toThrowError(/symbolic link/iu);
  });

  it('rejects missing and oversized blobs before decrypting', () => {
    const decryptString = vi.fn((value: Buffer) => value.toString('utf8'));
    const vault = store({
      maxBlobBytes: 8,
      randomId: () => '7de5fe22-e45c-4ae0-9904-618379303d0b',
      safeStorage: safeStorage({ decryptString }),
    });
    const reference = 'safe-storage://v1/7de5fe22-e45c-4ae0-9904-618379303d0b';
    expect(() => vault.read(reference)).toThrowError(/not found/iu);
    fs.mkdirSync(vault.directory, { recursive: true });
    fs.writeFileSync(path.join(vault.directory, '7de5fe22-e45c-4ae0-9904-618379303d0b.bin'), Buffer.alloc(9));
    expect(() => vault.read(reference)).toThrowError(/too large/iu);
    expect(decryptString).not.toHaveBeenCalled();
  });

  it('normalizes decryption failures to a safe error without secret material', () => {
    const vault = store({
      safeStorage: safeStorage({ decryptString: () => { throw new Error('raw OS failure'); } }),
    });
    const reference = vault.create('credential-sentinel');
    expect(() => vault.read(reference)).toThrowError('Stored credential could not be decrypted.');
    try {
      vault.read(reference);
    } catch (error) {
      expect(String(error)).not.toContain('credential-sentinel');
      expect(String(error)).not.toContain('raw OS failure');
    }
  });

  it('replaces with a new reference and leaves old deletion to the caller compensation step', () => {
    const ids = [
      '7de5fe22-e45c-4ae0-9904-618379303d0b',
      'a80a4be6-0e1f-4207-ac29-0db955b4c997',
    ];
    const vault = store({ randomId: () => ids.shift() as string });
    const oldReference = vault.create('old');
    const newReference = vault.create('new');
    expect(vault.read(oldReference)).toBe('old');
    expect(vault.read(newReference)).toBe('new');
    vault.delete(oldReference);
    expect(() => vault.read(oldReference)).toThrowError(/not found/iu);
    expect(vault.read(newReference)).toBe('new');
  });

  it('deletes idempotently and reports existence without decrypting', () => {
    const decryptString = vi.fn((value: Buffer) => value.toString('utf8'));
    const vault = store({ safeStorage: safeStorage({ decryptString }) });
    const reference = vault.create('secret');
    expect(vault.exists(reference)).toBe(true);
    vault.delete(reference);
    expect(vault.exists(reference)).toBe(false);
    expect(() => vault.delete(reference)).not.toThrow();
    expect(decryptString).not.toHaveBeenCalled();
  });

  it('rejects empty secrets and oversized encrypted output', () => {
    const vault = store({
      maxBlobBytes: 8,
      safeStorage: safeStorage({ encryptString: () => Buffer.alloc(9) }),
    });
    expect(() => vault.create('')).toThrowError(/must not be empty/iu);
    expect(() => vault.create('secret')).toThrowError(/too large/iu);
  });

  it('does not leave a temporary or final file when atomic persistence fails', () => {
    const vault = store({ randomId: () => '7de5fe22-e45c-4ae0-9904-618379303d0b' });
    fs.mkdirSync(vault.directory, { recursive: true });
    fs.mkdirSync(path.join(vault.directory, '7de5fe22-e45c-4ae0-9904-618379303d0b.bin'));
    expect(() => vault.create('secret')).toThrowError(/persist/iu);
    expect(fs.readdirSync(vault.directory).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('creates the vault and credential file with restrictive modes', () => {
    const vault = store();
    const reference = vault.create('secret');
    const id = reference.split('/').at(-1) as string;
    const credentialPath = path.join(vault.directory, `${id}.bin`);
    expect(fs.statSync(credentialPath).isFile()).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(vault.directory).mode & 0o777).toBe(0o700);
      expect(fs.statSync(credentialPath).mode & 0o777).toBe(0o600);
    }
  });
});
