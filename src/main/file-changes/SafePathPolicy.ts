import path from 'path';
import { promises as fs, realpathSync, statSync } from 'fs';

export class UnsafePathError extends Error {
  readonly code = 'UNSAFE_PATH';

  constructor(message: string) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

export interface ResolvedProjectFile {
  projectRoot: string;
  absolutePath: string;
  /** Git always uses forward slashes for repository-relative pathspecs. */
  gitPath: string;
}

function containsNull(value: string): boolean {
  return value.includes('\0');
}

function isContainedBy(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isAbsoluteOnAnyPlatform(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

function absoluteProjectPath(projectPath: string): string {
  if (!projectPath || containsNull(projectPath) || !isAbsoluteOnAnyPlatform(projectPath)) {
    throw new UnsafePathError('Project path must be a non-empty absolute path.');
  }
  return path.resolve(projectPath);
}

function lexicalProjectFile(
  root: string,
  filePath: string,
): {
  absolutePath: string;
  relativePath: string;
} {
  if (!filePath || containsNull(filePath) || isAbsoluteOnAnyPlatform(filePath) || /^[A-Za-z]:/.test(filePath)) {
    throw new UnsafePathError('File path must be a non-empty project-relative path.');
  }

  const platformRelative = filePath.split('/').join(path.sep);
  const absolutePath = path.resolve(root, platformRelative);
  if (absolutePath === root || !isContainedBy(root, absolutePath)) {
    throw new UnsafePathError('File path escapes the selected project.');
  }

  const relativePath = path.relative(root, absolutePath);
  if (relativePath.split(path.sep).some((segment) => segment.toLocaleLowerCase() === '.git')) {
    throw new UnsafePathError('Repository metadata cannot be accessed as a project file.');
  }
  return { absolutePath, relativePath };
}

/** Resolves renderer-provided paths without allowing access outside a project root. */
export class SafePathPolicy {
  async resolveProjectRoot(projectPath: string): Promise<string> {
    let realRoot: string;
    try {
      realRoot = await fs.realpath(absoluteProjectPath(projectPath));
      const stat = await fs.stat(realRoot);
      if (!stat.isDirectory()) throw new UnsafePathError('Project path is not a directory.');
    } catch (error) {
      if (error instanceof UnsafePathError) throw error;
      throw new UnsafePathError('Project directory does not exist or cannot be accessed.');
    }
    return realRoot;
  }

  resolveProjectRootSync(projectPath: string): string {
    let realRoot: string;
    try {
      realRoot = realpathSync.native(absoluteProjectPath(projectPath));
      const stat = statSync(realRoot);
      if (!stat.isDirectory()) throw new UnsafePathError('Project path is not a directory.');
    } catch (error) {
      if (error instanceof UnsafePathError) throw error;
      throw new UnsafePathError('Project directory does not exist or cannot be accessed.');
    }
    return realRoot;
  }

  async resolveFile(
    projectRoot: string,
    filePath: string,
    options: { mustExist?: boolean } = {},
  ): Promise<ResolvedProjectFile> {
    const root = await this.resolveProjectRoot(projectRoot);
    const lexical = lexicalProjectFile(root, filePath);
    const effectivePath = await this.resolveThroughExistingAncestor(lexical.absolutePath, options.mustExist ?? false);
    if (!isContainedBy(root, effectivePath)) {
      throw new UnsafePathError('File path resolves outside the selected project.');
    }

    return {
      projectRoot: root,
      absolutePath: lexical.absolutePath,
      gitPath: lexical.relativePath.split(path.sep).join('/'),
    };
  }

  resolveFileSync(projectRoot: string, filePath: string, options: { mustExist?: boolean } = {}): ResolvedProjectFile {
    const root = this.resolveProjectRootSync(projectRoot);
    const lexical = lexicalProjectFile(root, filePath);
    const effectivePath = this.resolveThroughExistingAncestorSync(lexical.absolutePath, options.mustExist ?? false);
    if (!isContainedBy(root, effectivePath)) {
      throw new UnsafePathError('File path resolves outside the selected project.');
    }

    return {
      projectRoot: root,
      absolutePath: lexical.absolutePath,
      gitPath: lexical.relativePath.split(path.sep).join('/'),
    };
  }

  private async resolveThroughExistingAncestor(candidate: string, mustExist: boolean): Promise<string> {
    try {
      return await fs.realpath(candidate);
    } catch {
      if (mustExist) {
        throw new UnsafePathError('Project file does not exist or cannot be accessed.');
      }

      const missingSegments: string[] = [];
      let ancestor = candidate;
      while (true) {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          throw new UnsafePathError('File path cannot be resolved safely.');
        }
        missingSegments.unshift(path.basename(ancestor));
        ancestor = parent;
        try {
          const realAncestor = await fs.realpath(ancestor);
          return path.resolve(realAncestor, ...missingSegments);
        } catch {
          // Continue until the nearest existing ancestor is found.
        }
      }
    }
  }

  private resolveThroughExistingAncestorSync(candidate: string, mustExist: boolean): string {
    try {
      return realpathSync.native(candidate);
    } catch {
      if (mustExist) {
        throw new UnsafePathError('Project file does not exist or cannot be accessed.');
      }

      const missingSegments: string[] = [];
      let ancestor = candidate;
      while (true) {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          throw new UnsafePathError('File path cannot be resolved safely.');
        }
        missingSegments.unshift(path.basename(ancestor));
        ancestor = parent;
        try {
          const realAncestor = realpathSync.native(ancestor);
          return path.resolve(realAncestor, ...missingSegments);
        } catch {
          // Continue until the nearest existing ancestor is found.
        }
      }
    }
  }
}

export const safePathPolicy = new SafePathPolicy();
