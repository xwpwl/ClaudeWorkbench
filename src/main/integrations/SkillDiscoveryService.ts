import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  IntegrationDiagnostic,
  IntegrationSource,
  SkillDiscoveryResult,
  SkillDocument,
  SkillIntegration,
  SkillIntegrationStatus,
} from '../../shared/types/integrations';

export const MAX_SKILL_BYTES = 1024 * 1024;

interface SkillDiscoveryOptions {
  userHome?: string;
  maxSkillBytes?: number;
  maxDepth?: number;
  maxEntries?: number;
}

interface SkillRoot {
  source: IntegrationSource;
  rootPath: string;
}

interface SkillMetadata {
  name?: string;
  description?: string;
}

export class SkillReadError extends Error {
  constructor(
    readonly code:
      | 'outside_allowed_root'
      | 'too_large'
      | 'invalid_utf8'
      | 'inaccessible',
    message: string,
  ) {
    super(message);
    this.name = 'SkillReadError';
  }
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SkillReadError('invalid_utf8', 'SKILL.md 不是有效 UTF-8');
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function metadataFromContent(content: string): SkillMetadata {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  const metadata: SkillMetadata = {};
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '---') break;
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLocaleLowerCase();
    const value = unquote(line.slice(separator + 1));
    if (key === 'name' && value) metadata.name = value;
    if (key === 'description' && value) metadata.description = value;
  }
  return metadata;
}

function skillId(source: IntegrationSource, skillPath: string): string {
  return crypto
    .createHash('sha256')
    .update(`${source}\0${path.resolve(skillPath)}`)
    .digest('hex')
    .slice(0, 20);
}

function diagnostic(
  source: IntegrationSource,
  skillPath: string,
  code: IntegrationDiagnostic['code'],
  message: string,
): IntegrationDiagnostic {
  return { source, path: skillPath, code, message };
}

export class SkillDiscoveryService {
  private readonly userHome: string;
  private readonly maxSkillBytes: number;
  private readonly maxDepth: number;
  private readonly maxEntries: number;

  constructor(options: SkillDiscoveryOptions = {}) {
    this.userHome = path.resolve(options.userHome ?? os.homedir());
    this.maxSkillBytes = options.maxSkillBytes ?? MAX_SKILL_BYTES;
    this.maxDepth = options.maxDepth ?? 8;
    this.maxEntries = options.maxEntries ?? 5000;
  }

  discover(projectPath: string): SkillDiscoveryResult {
    const roots = this.rootsFor(path.resolve(projectPath));
    const skills: SkillIntegration[] = [];
    const diagnostics: IntegrationDiagnostic[] = [];
    let inspectedEntries = 0;

    for (const root of roots) {
      if (!fs.existsSync(root.rootPath)) continue;
      let realRoot: string;
      try {
        realRoot = fs.realpathSync(root.rootPath);
      } catch {
        diagnostics.push(diagnostic(
          root.source,
          root.rootPath,
          'inaccessible',
          '无法读取 Skills 根目录',
        ));
        continue;
      }
      const visitedDirectories = new Set<string>();
      const visit = (directory: string, depth: number): void => {
        if (depth > this.maxDepth || inspectedEntries >= this.maxEntries) return;
        let realDirectory: string;
        try {
          realDirectory = fs.realpathSync(directory);
        } catch {
          diagnostics.push(diagnostic(
            root.source,
            directory,
            'inaccessible',
            '无法读取 Skill 目录',
          ));
          return;
        }
        if (!isContained(realRoot, realDirectory)) {
          diagnostics.push(diagnostic(
            root.source,
            directory,
            'symlink_escape',
            'Skill 链接指向允许目录之外，已跳过',
          ));
          return;
        }
        if (visitedDirectories.has(realDirectory)) return;
        visitedDirectories.add(realDirectory);

        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(realDirectory, { withFileTypes: true });
        } catch {
          diagnostics.push(diagnostic(
            root.source,
            realDirectory,
            'inaccessible',
            '无法列出 Skill 目录',
          ));
          return;
        }

        for (const entry of entries) {
          if (inspectedEntries >= this.maxEntries) return;
          inspectedEntries += 1;
          const entryPath = path.join(realDirectory, entry.name);
          if (entry.isDirectory() || entry.isSymbolicLink()) {
            if (entry.isSymbolicLink()) {
              try {
                const target = fs.realpathSync(entryPath);
                const stats = fs.statSync(target);
                if (!isContained(realRoot, target)) {
                  diagnostics.push(diagnostic(
                    root.source,
                    entryPath,
                    'symlink_escape',
                    'Skill 链接指向允许目录之外，已跳过',
                  ));
                  continue;
                }
                if (stats.isDirectory()) visit(target, depth + 1);
                else if (stats.isFile() && entry.name.toLocaleLowerCase() === 'skill.md') {
                  this.inspectSkill(root, realRoot, entryPath, skills, diagnostics);
                }
              } catch {
                diagnostics.push(diagnostic(
                  root.source,
                  entryPath,
                  'inaccessible',
                  '无法解析 Skill 链接',
                ));
              }
            } else {
              visit(entryPath, depth + 1);
            }
            continue;
          }
          if (entry.isFile() && entry.name.toLocaleLowerCase() === 'skill.md') {
            this.inspectSkill(root, realRoot, entryPath, skills, diagnostics);
          }
        }
      };
      visit(realRoot, 0);
    }

    skills.sort((left, right) => {
      if (left.source !== right.source) return left.source === 'project' ? -1 : 1;
      const byName = left.name.localeCompare(right.name);
      return byName || left.skillPath.localeCompare(right.skillPath);
    });
    return { skills, diagnostics };
  }

  readSkill(
    projectPath: string,
    request: Pick<SkillIntegration, 'source' | 'skillPath'>,
  ): SkillDocument {
    const projectRoot = path.resolve(projectPath);
    const allowedRoots = this.rootsFor(projectRoot)
      .filter((root) => root.source === request.source && fs.existsSync(root.rootPath))
      .flatMap((root) => {
        try {
          return [{ ...root, realRoot: fs.realpathSync(root.rootPath) }];
        } catch {
          return [];
        }
      });
    if (path.basename(path.resolve(request.skillPath)).toLocaleLowerCase() !== 'skill.md') {
      throw new SkillReadError('outside_allowed_root', '只能读取 SKILL.md');
    }
    let realSkillPath: string;
    try {
      realSkillPath = fs.realpathSync(path.resolve(request.skillPath));
    } catch {
      throw new SkillReadError('inaccessible', '无法读取 SKILL.md');
    }
    const containingRoot = allowedRoots.find((root) => isContained(root.realRoot, realSkillPath));
    if (!containingRoot) {
      throw new SkillReadError('outside_allowed_root', 'SKILL.md 位于允许目录之外');
    }
    let stats: fs.Stats;
    try {
      stats = fs.statSync(realSkillPath);
    } catch {
      throw new SkillReadError('inaccessible', '无法读取 SKILL.md');
    }
    if (!stats.isFile()) throw new SkillReadError('inaccessible', 'SKILL.md 不是文件');
    if (stats.size > this.maxSkillBytes) {
      throw new SkillReadError('too_large', 'SKILL.md 超过 1MB 读取上限');
    }
    let content: string;
    try {
      content = decodeUtf8(fs.readFileSync(realSkillPath));
    } catch (error) {
      if (error instanceof SkillReadError) throw error;
      throw new SkillReadError('inaccessible', '无法读取 SKILL.md');
    }
    const metadata = metadataFromContent(content);
    return {
      id: skillId(request.source, realSkillPath),
      name: metadata.name || path.basename(path.dirname(realSkillPath)),
      description: metadata.description,
      source: request.source,
      rootPath: containingRoot.realRoot,
      skillPath: path.resolve(request.skillPath),
      status: 'available',
      sizeBytes: stats.size,
      content,
    };
  }

  private rootsFor(projectPath: string): SkillRoot[] {
    return [
      { source: 'project', rootPath: path.join(projectPath, '.claude', 'skills') },
      { source: 'user', rootPath: path.join(this.userHome, '.claude', 'skills') },
    ];
  }

  private inspectSkill(
    root: SkillRoot,
    realRoot: string,
    skillPath: string,
    skills: SkillIntegration[],
    diagnostics: IntegrationDiagnostic[],
  ): void {
    let realSkillPath: string;
    let stats: fs.Stats;
    try {
      realSkillPath = fs.realpathSync(skillPath);
      if (!isContained(realRoot, realSkillPath)) {
        diagnostics.push(diagnostic(
          root.source,
          skillPath,
          'symlink_escape',
          'SKILL.md 指向允许目录之外，已跳过',
        ));
        return;
      }
      stats = fs.statSync(realSkillPath);
    } catch {
      diagnostics.push(diagnostic(
        root.source,
        skillPath,
        'inaccessible',
        '无法读取 SKILL.md',
      ));
      return;
    }
    if (!stats.isFile()) return;

    let status: SkillIntegrationStatus = 'available';
    let error: string | undefined;
    let metadata: SkillMetadata = {};
    if (stats.size > this.maxSkillBytes) {
      status = 'too_large';
      error = 'SKILL.md 超过 1MB 读取上限';
      diagnostics.push(diagnostic(root.source, skillPath, 'too_large', error));
    } else {
      try {
        metadata = metadataFromContent(decodeUtf8(fs.readFileSync(realSkillPath)));
      } catch (readError) {
        if (readError instanceof SkillReadError && readError.code === 'invalid_utf8') {
          status = 'invalid_utf8';
          error = readError.message;
          diagnostics.push(diagnostic(root.source, skillPath, 'invalid_utf8', error));
        } else {
          status = 'inaccessible';
          error = '无法读取 SKILL.md';
          diagnostics.push(diagnostic(root.source, skillPath, 'inaccessible', error));
        }
      }
    }

    skills.push({
      id: skillId(root.source, realSkillPath),
      name: metadata.name || path.basename(path.dirname(realSkillPath)),
      description: metadata.description,
      source: root.source,
      rootPath: realRoot,
      skillPath: path.resolve(skillPath),
      status,
      sizeBytes: stats.size,
      error,
    });
  }
}
