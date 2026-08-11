import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitInfo } from '../../shared/types/ipc';
import type { ProjectInspection } from '../../shared/types/project';

const execFileAsync = promisify(execFile);
const MAX_CONFIG_BYTES = 1024 * 1024;

export interface CanonicalProjectPath {
  displayPath: string;
  canonicalPath: string;
}

function existingRealPath(candidate: string): string {
  const resolved = path.resolve(candidate);
  if (!fs.existsSync(resolved)) return resolved;
  return fs.realpathSync.native(resolved);
}

export function canonicalizeProjectPath(candidate: string): CanonicalProjectPath {
  if (!candidate.trim()) throw new Error('Project path is required');
  const displayPath = path.normalize(existingRealPath(candidate.trim()));
  const canonicalPath = process.platform === 'win32'
    ? displayPath.toLocaleLowerCase('en-US')
    : displayPath;
  return { displayPath, canonicalPath };
}

export function projectIdForPath(candidate: string): string {
  const { canonicalPath } = canonicalizeProjectPath(candidate);
  return crypto.createHash('sha256').update(canonicalPath).digest('hex').slice(0, 16);
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function mcpNamesFromConfig(filePath: string): string[] {
  const config = readJsonObject(filePath);
  const servers = config?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];
  return Object.keys(servers as Record<string, unknown>);
}

export function countProjectMcpServers(projectPath: string): number {
  const names = new Set<string>();
  for (const configPath of [
    path.join(projectPath, '.mcp.json'),
    path.join(projectPath, '.claude', 'settings.json'),
  ]) {
    for (const name of mcpNamesFromConfig(configPath)) names.add(name);
  }
  return names.size;
}

export function countProjectSkills(projectPath: string): number {
  const skillFiles = new Set<string>();
  for (const root of [
    path.join(projectPath, '.claude', 'skills'),
    path.join(projectPath, '.agents', 'skills'),
  ]) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(root, entry.name, 'SKILL.md');
      if (fs.existsSync(skillFile) && fs.statSync(skillFile).isFile()) {
        skillFiles.add(fs.realpathSync.native(skillFile));
      }
    }
  }
  return skillFiles.size;
}

async function git(projectPath: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd: projectPath,
    timeout: 8_000,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
    encoding: 'utf8',
  });
  return result.stdout.trim();
}

export async function getProjectGitInfo(projectPath: string): Promise<GitInfo> {
  try {
    await git(projectPath, ['rev-parse', '--is-inside-work-tree']);
    const [branch, status, aheadBehind] = await Promise.all([
      git(projectPath, ['symbolic-ref', '--short', 'HEAD'])
        .catch(() => git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])),
      git(projectPath, ['status', '--porcelain=v1']),
      git(projectPath, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])
        .catch(() => '0\t0'),
    ]);
    const [behind = '0', ahead = '0'] = aheadBehind.split(/\s+/);
    return {
      branch: branch || null,
      hasChanges: Boolean(status),
      isRepo: true,
      ahead: Number(ahead) || 0,
      behind: Number(behind) || 0,
    };
  } catch {
    return {
      branch: null,
      hasChanges: false,
      isRepo: false,
      ahead: 0,
      behind: 0,
    };
  }
}

export async function inspectProject(projectPath: string): Promise<ProjectInspection> {
  const { displayPath } = canonicalizeProjectPath(projectPath);
  return {
    claudeMdExists: fs.existsSync(path.join(displayPath, 'CLAUDE.md')),
    mcpCount: countProjectMcpServers(displayPath),
    skillCount: countProjectSkills(displayPath),
    git: await getProjectGitInfo(displayPath),
  };
}

export const projectServiceInternals = { mcpNamesFromConfig, readJsonObject };
