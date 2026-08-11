import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const REFERENCE_PREFIX = 'safe-storage://v1/';
const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DEFAULT_MAX_BLOB_BYTES = 64 * 1024;
const INTERNAL_MANIFEST_FILENAME = '.internal-credential-refs.v1.json';
const INTERNAL_LOCK_FILENAME = '.internal-credential-refs.v1.lock';
const INTERNAL_MANIFEST_MAX_BYTES = 16 * 1024;
const INTERNAL_SECRET_NAMES = ['model-tier-synthetic-hmac-v1'] as const;
type InternalSecretName = (typeof INTERNAL_SECRET_NAMES)[number];

export interface SafeStorageFacade {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export type CredentialStoreErrorCode =
  | 'ENCRYPTION_UNAVAILABLE'
  | 'INVALID_REFERENCE'
  | 'INVALID_SECRET'
  | 'NOT_FOUND'
  | 'BLOB_TOO_LARGE'
  | 'SYMLINK_REJECTED'
  | 'DECRYPT_FAILED'
  | 'INTERNAL_METADATA_INVALID'
  | 'PERSIST_FAILED';

export class CredentialStoreError extends Error {
  constructor(
    readonly code: CredentialStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CredentialStoreError';
  }
}

export interface CredentialStoreOptions {
  platform?: NodeJS.Platform;
  maxBlobBytes?: number;
  randomId?: () => string;
}

export class CredentialStore {
  readonly directory: string;
  private readonly platform: NodeJS.Platform;
  private readonly maxBlobBytes: number;
  private readonly randomId: () => string;

  constructor(
    directory: string,
    private readonly safeStorage: SafeStorageFacade,
    options: CredentialStoreOptions = {},
  ) {
    this.directory = path.resolve(directory);
    this.platform = options.platform ?? process.platform;
    this.maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
    this.randomId = options.randomId ?? randomUUID;
    if (!Number.isSafeInteger(this.maxBlobBytes) || this.maxBlobBytes <= 0) {
      throw new CredentialStoreError('BLOB_TOO_LARGE', 'Credential blob limit is invalid.');
    }
  }

  create(secret: string): string {
    this.assertSecureBackend();
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new CredentialStoreError('INVALID_SECRET', 'Credential must not be empty.');
    }

    let encrypted: Buffer;
    try {
      encrypted = this.safeStorage.encryptString(secret);
    } catch {
      throw new CredentialStoreError(
        'ENCRYPTION_UNAVAILABLE',
        'Secure credential encryption is unavailable.',
      );
    }
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
      throw new CredentialStoreError('PERSIST_FAILED', 'Credential encryption returned no data.');
    }
    this.assertBlobSize(encrypted.length);

    const id = this.randomId();
    if (!OPAQUE_ID.test(id)) {
      throw new CredentialStoreError('INVALID_REFERENCE', 'Credential identifier is invalid.');
    }
    const finalPath = this.pathForId(id);
    const temporaryPath = path.join(this.directory, `.${id}.${randomUUID()}.tmp`);

    try {
      this.ensureDirectory();
      if (fs.existsSync(finalPath)) {
        throw new Error('credential identifier collision');
      }
      fs.writeFileSync(temporaryPath, encrypted, { flag: 'wx', mode: 0o600 });
      fs.chmodSync(temporaryPath, 0o600);
      fs.renameSync(temporaryPath, finalPath);
      fs.chmodSync(finalPath, 0o600);
    } catch {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch {
        // Cleanup is best effort; the name contains no secret and is never a valid reference.
      }
      throw new CredentialStoreError('PERSIST_FAILED', 'Credential could not be persisted.');
    }
    return `${REFERENCE_PREFIX}${id}`;
  }

  read(reference: string): string {
    this.assertSecureBackend();
    const credentialPath = this.resolveReference(reference);
    const stat = this.safeFileStat(credentialPath, true);
    this.assertBlobSize(stat.size);

    let encrypted: Buffer;
    try {
      encrypted = fs.readFileSync(credentialPath);
    } catch {
      throw new CredentialStoreError('NOT_FOUND', 'Stored credential was not found.');
    }
    this.assertBlobSize(encrypted.length);
    try {
      const secret = this.safeStorage.decryptString(encrypted);
      if (typeof secret !== 'string' || secret.length === 0) {
        throw new Error('empty credential');
      }
      return secret;
    } catch {
      throw new CredentialStoreError(
        'DECRYPT_FAILED',
        'Stored credential could not be decrypted.',
      );
    }
  }

  async withSecret<T>(reference: string, use: (secret: string) => T | Promise<T>): Promise<T> {
    const secret = this.read(reference);
    return use(secret);
  }

  /**
   * Private main-process metadata for non-Provider secrets. The manifest stores only an opaque
   * encrypted-store reference and is deliberately outside Provider rows and cleanup jobs.
   */
  getOrCreateInternalSecret(
    name: InternalSecretName,
    createSecret: () => string,
  ): string {
    if (!(INTERNAL_SECRET_NAMES as readonly string[]).includes(name)) {
      throw internalMetadataError();
    }
    if (typeof createSecret !== 'function') throw internalMetadataError();
    this.assertSecureBackend();
    this.ensureDirectory();

    const manifestPath = path.join(this.directory, INTERNAL_MANIFEST_FILENAME);
    if (this.internalManifestExists(manifestPath)) {
      return this.read(this.readInternalReference(manifestPath, name));
    }

    const lockPath = path.join(this.directory, INTERNAL_LOCK_FILENAME);
    let lockHandle: number;
    try {
      lockHandle = fs.openSync(lockPath, 'wx', 0o600);
      fs.closeSync(lockHandle);
      fs.chmodSync(lockPath, 0o600);
    } catch {
      throw internalMetadataError();
    }

    let createdReference: string | null = null;
    let published = false;
    let temporaryPath: string | null = null;
    try {
      // Another process may have completed provisioning between the first read and lock acquire.
      if (this.internalManifestExists(manifestPath)) {
        return this.read(this.readInternalReference(manifestPath, name));
      }
      const secret = createSecret();
      if (
        typeof secret !== 'string'
        || secret.length < 32
        || secret.length > 4_096
        || /[\u0000-\u001f\u007f]/u.test(secret)
      ) {
        throw internalMetadataError();
      }
      createdReference = this.create(secret);
      const manifest = JSON.stringify({
        version: 1,
        entries: [{ name, reference: createdReference }],
      });
      temporaryPath = path.join(
        this.directory,
        `.${INTERNAL_MANIFEST_FILENAME}.${randomUUID()}.tmp`,
      );
      fs.writeFileSync(temporaryPath, manifest, { flag: 'wx', mode: 0o600 });
      fs.chmodSync(temporaryPath, 0o600);
      if (this.internalManifestExists(manifestPath)) throw internalMetadataError();
      fs.renameSync(temporaryPath, manifestPath);
      temporaryPath = null;
      published = true;
      return secret;
    } catch (error) {
      if (!published && createdReference) {
        try {
          this.delete(createdReference);
        } catch {
          // The manifest was not published; cleanup failure must not hide the provisioning error.
        }
      }
      if (error instanceof CredentialStoreError) throw error;
      throw internalMetadataError();
    } finally {
      if (temporaryPath) {
        try {
          fs.rmSync(temporaryPath, { force: true });
        } catch {
          // Best effort for a non-secret temporary filename.
        }
      }
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        // A stale lock fails the next startup closed rather than rotating the identity.
      }
    }
  }

  exists(reference: string): boolean {
    const credentialPath = this.resolveReference(reference);
    try {
      this.safeFileStat(credentialPath, false);
      return true;
    } catch (error) {
      if (error instanceof CredentialStoreError && error.code === 'NOT_FOUND') return false;
      throw error;
    }
  }

  delete(reference: string): void {
    const credentialPath = this.resolveReference(reference);
    try {
      this.safeFileStat(credentialPath, false);
    } catch (error) {
      if (error instanceof CredentialStoreError && error.code === 'NOT_FOUND') return;
      throw error;
    }
    try {
      fs.rmSync(credentialPath);
    } catch {
      throw new CredentialStoreError('PERSIST_FAILED', 'Stored credential could not be deleted.');
    }
  }

  private assertSecureBackend(): void {
    let available = false;
    try {
      available = this.safeStorage.isEncryptionAvailable();
    } catch {
      available = false;
    }
    if (!available) {
      throw new CredentialStoreError(
        'ENCRYPTION_UNAVAILABLE',
        'Secure credential encryption is unavailable.',
      );
    }
    if (this.platform !== 'linux') return;

    let backend = 'unknown';
    try {
      backend = this.safeStorage.getSelectedStorageBackend?.() ?? 'unknown';
    } catch {
      backend = 'unknown';
    }
    if (backend === 'basic_text' || backend === 'unknown' || backend.length === 0) {
      throw new CredentialStoreError(
        'ENCRYPTION_UNAVAILABLE',
        'Secure credential encryption is unavailable.',
      );
    }
  }

  private ensureDirectory(): void {
    if (fs.existsSync(this.directory)) {
      const stat = fs.lstatSync(this.directory);
      if (stat.isSymbolicLink()) {
        throw new CredentialStoreError('SYMLINK_REJECTED', 'Credential vault cannot be a symbolic link.');
      }
      if (!stat.isDirectory()) {
        throw new CredentialStoreError('PERSIST_FAILED', 'Credential vault is not a directory.');
      }
    } else {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    }
    fs.chmodSync(this.directory, 0o700);
  }

  private resolveReference(reference: string): string {
    if (typeof reference !== 'string' || !reference.startsWith(REFERENCE_PREFIX)) {
      throw new CredentialStoreError('INVALID_REFERENCE', 'Stored credential reference is invalid.');
    }
    const id = reference.slice(REFERENCE_PREFIX.length);
    if (!OPAQUE_ID.test(id) || reference !== `${REFERENCE_PREFIX}${id}`) {
      throw new CredentialStoreError('INVALID_REFERENCE', 'Stored credential reference is invalid.');
    }
    return this.pathForId(id);
  }

  private pathForId(id: string): string {
    const candidate = path.resolve(this.directory, `${id}.bin`);
    if (path.dirname(candidate) !== this.directory) {
      throw new CredentialStoreError('INVALID_REFERENCE', 'Stored credential reference is invalid.');
    }
    return candidate;
  }

  private safeFileStat(credentialPath: string, requireSecureBackend: boolean): fs.Stats {
    if (requireSecureBackend) this.assertSecureBackend();
    this.assertVaultDirectory();
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(credentialPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new CredentialStoreError('NOT_FOUND', 'Stored credential was not found.');
      }
      throw new CredentialStoreError('NOT_FOUND', 'Stored credential was not found.');
    }
    if (stat.isSymbolicLink()) {
      throw new CredentialStoreError(
        'SYMLINK_REJECTED',
        'Stored credential cannot be a symbolic link.',
      );
    }
    if (!stat.isFile()) {
      throw new CredentialStoreError('NOT_FOUND', 'Stored credential was not found.');
    }
    return stat;
  }

  private assertVaultDirectory(): void {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(this.directory);
    } catch {
      throw new CredentialStoreError('NOT_FOUND', 'Stored credential was not found.');
    }
    if (stat.isSymbolicLink()) {
      throw new CredentialStoreError(
        'SYMLINK_REJECTED',
        'Credential vault cannot be a symbolic link.',
      );
    }
    if (!stat.isDirectory()) {
      throw new CredentialStoreError('NOT_FOUND', 'Stored credential was not found.');
    }
  }

  private internalManifestExists(manifestPath: string): boolean {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(manifestPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw internalMetadataError();
    }
    if (
      stat.isSymbolicLink()
      || !stat.isFile()
      || stat.size <= 0
      || stat.size > INTERNAL_MANIFEST_MAX_BYTES
      || (this.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    ) {
      throw internalMetadataError();
    }
    return true;
  }

  private readInternalReference(
    manifestPath: string,
    expectedName: InternalSecretName,
  ): string {
    let raw: Buffer;
    try {
      raw = fs.readFileSync(manifestPath);
    } catch {
      throw internalMetadataError();
    }
    if (raw.length <= 0 || raw.length > INTERNAL_MANIFEST_MAX_BYTES) {
      throw internalMetadataError();
    }
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      throw internalMetadataError();
    }
    let value: unknown;
    try {
      value = JSON.parse(decoded) as unknown;
    } catch {
      throw internalMetadataError();
    }
    if (!isExactObject(value, ['version', 'entries']) || value.version !== 1) {
      throw internalMetadataError();
    }
    if (!Array.isArray(value.entries) || value.entries.length !== 1) {
      throw internalMetadataError();
    }
    const entry = value.entries[0];
    if (
      !isExactObject(entry, ['name', 'reference'])
      || entry.name !== expectedName
      || !(INTERNAL_SECRET_NAMES as readonly unknown[]).includes(entry.name)
      || typeof entry.reference !== 'string'
      || /[\u0000-\u001f\u007f]/u.test(entry.reference)
    ) {
      throw internalMetadataError();
    }
    // Reuse the normal strict reference parser before the value is ever read.
    this.resolveReference(entry.reference);
    return entry.reference;
  }

  private assertBlobSize(size: number): void {
    if (!Number.isSafeInteger(size) || size <= 0 || size > this.maxBlobBytes) {
      throw new CredentialStoreError('BLOB_TOO_LARGE', 'Stored credential blob is too large.');
    }
  }
}

function isExactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)),
  );
}

function internalMetadataError(): CredentialStoreError {
  return new CredentialStoreError(
    'INTERNAL_METADATA_INVALID',
    'Internal credential metadata is unavailable or invalid.',
  );
}
