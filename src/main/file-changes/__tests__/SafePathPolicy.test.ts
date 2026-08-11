import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { SafePathPolicy, UnsafePathError } from '../SafePathPolicy';

describe('SafePathPolicy', () => {
  const policy = new SafePathPolicy();
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-safe-path-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export {};\n');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('resolves an existing nested file to an absolute path and Git path', async () => {
    const result = await policy.resolveFile(root, 'src/index.ts', { mustExist: true });
    expect(result.absolutePath).toBe(path.join(root, 'src', 'index.ts'));
    expect(result.gitPath).toBe('src/index.ts');
  });

  it('normalizes Git forward slashes on the host platform', async () => {
    const result = await policy.resolveFile(root, 'src/new/file.ts');
    expect(result.absolutePath).toBe(path.join(root, 'src', 'new', 'file.ts'));
    expect(result.gitPath).toBe('src/new/file.ts');
  });

  it('allows a missing file only when its nearest existing ancestor is inside the project', async () => {
    const result = await policy.resolveFile(root, 'src/missing/deep.ts');
    expect(result.gitPath).toBe('src/missing/deep.ts');
  });

  it('rejects a missing file when mustExist is requested', async () => {
    await expect(policy.resolveFile(root, 'src/missing.ts', { mustExist: true }))
      .rejects.toBeInstanceOf(UnsafePathError);
  });

  it('rejects parent traversal outside the project', async () => {
    await expect(policy.resolveFile(root, '../secret.txt')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('does not confuse a sibling sharing the project name prefix with a child', async () => {
    const siblingName = `${path.basename(root)}-outside`;
    await expect(policy.resolveFile(root, `../${siblingName}/secret.txt`))
      .rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('rejects absolute file paths', async () => {
    await expect(policy.resolveFile(root, path.join(root, 'src', 'index.ts')))
      .rejects.toBeInstanceOf(UnsafePathError);
  });

  it('rejects Windows drive-relative paths', async () => {
    await expect(policy.resolveFile(root, 'C:relative.txt')).rejects.toBeInstanceOf(UnsafePathError);
  });

  it('rejects null bytes before touching the filesystem', async () => {
    await expect(policy.resolveFile(root, 'src/bad\0name.ts')).rejects.toBeInstanceOf(UnsafePathError);
  });

  it('rejects access to repository metadata', async () => {
    await expect(policy.resolveFile(root, '.git/config')).rejects.toBeInstanceOf(UnsafePathError);
    await expect(policy.resolveFile(root, '.GIT/config')).rejects.toBeInstanceOf(UnsafePathError);
  });

  it('rejects resolving the project root as a file', async () => {
    await expect(policy.resolveFile(root, '.')).rejects.toBeInstanceOf(UnsafePathError);
  });

  it('requires the project root itself to be absolute', async () => {
    await expect(policy.resolveProjectRoot('.')).rejects.toBeInstanceOf(UnsafePathError);
  });

  it('requires the project root to be a directory', async () => {
    const file = path.join(root, 'src', 'index.ts');
    await expect(policy.resolveProjectRoot(file)).rejects.toBeInstanceOf(UnsafePathError);
  });
});
