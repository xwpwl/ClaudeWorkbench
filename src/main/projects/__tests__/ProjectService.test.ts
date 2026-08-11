import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../../shared/types/session';
import {
  canonicalizeProjectPath,
  countProjectMcpServers,
  countProjectSkills,
  getProjectGitInfo,
  inspectProject,
  projectIdForPath,
} from '../ProjectService';
import {
  filterTasks,
  groupProjectTasks,
} from '../../../renderer/features/projects/projectTaskGroups';

const TEMP_PREFIX = 'claude-workbench-project-test-';

function removeTemp(directory: string): void {
  const target = path.resolve(directory);
  if (
    path.dirname(target) !== path.resolve(os.tmpdir())
    || !path.basename(target).startsWith(TEMP_PREFIX)
  ) throw new Error(`Refusing to remove unexpected test directory: ${target}`);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function session(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    projectId: 'project',
    claudeSessionId: null,
    title: id,
    status: 'completed',
    model: null,
    permissionMode: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    completedAt: null,
    messageCount: 0,
    source: 'workbench',
    archived: false,
    tags: [],
    ...patch,
  };
}

describe('project management', () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  });

  afterEach(() => removeTemp(directory));

  it('[PM-01] rejects an empty project path', () => {
    expect(() => canonicalizeProjectPath('   ')).toThrow('Project path is required');
  });

  it('[PM-02] resolves a project to an absolute display path', () => {
    expect(canonicalizeProjectPath(directory).displayPath).toBe(fs.realpathSync.native(directory));
  });

  it('[PM-03] normalizes equivalent trailing path separators', () => {
    expect(projectIdForPath(`${directory}${path.sep}`)).toBe(projectIdForPath(directory));
  });

  it('[PM-04] creates a stable project identity', () => {
    expect(projectIdForPath(directory)).toMatch(/^[a-f0-9]{16}$/);
    expect(projectIdForPath(directory)).toBe(projectIdForPath(directory));
  });

  it('[PM-05] distinguishes different project directories', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    try {
      expect(projectIdForPath(other)).not.toBe(projectIdForPath(directory));
    } finally {
      removeTemp(other);
    }
  });

  it('[PM-06] discovers root project MCP servers', () => {
    fs.writeFileSync(path.join(directory, '.mcp.json'), JSON.stringify({
      mcpServers: { filesystem: {}, browser: {} },
    }));
    expect(countProjectMcpServers(directory)).toBe(2);
  });

  it('[PM-07] discovers MCP servers in project Claude settings', () => {
    fs.mkdirSync(path.join(directory, '.claude'));
    fs.writeFileSync(path.join(directory, '.claude', 'settings.json'), JSON.stringify({
      mcpServers: { github: {} },
    }));
    expect(countProjectMcpServers(directory)).toBe(1);
  });

  it('[PM-08] de-duplicates MCP server names across project config files', () => {
    fs.mkdirSync(path.join(directory, '.claude'));
    fs.writeFileSync(path.join(directory, '.mcp.json'), JSON.stringify({ mcpServers: { shared: {} } }));
    fs.writeFileSync(path.join(directory, '.claude', 'settings.json'), JSON.stringify({ mcpServers: { shared: {} } }));
    expect(countProjectMcpServers(directory)).toBe(1);
  });

  it('[PM-09] treats malformed MCP JSON as a diagnostic-safe empty config', () => {
    fs.writeFileSync(path.join(directory, '.mcp.json'), '{bad json');
    expect(countProjectMcpServers(directory)).toBe(0);
  });

  it('[PM-10] ignores oversized MCP config files', () => {
    fs.writeFileSync(path.join(directory, '.mcp.json'), ' '.repeat(1024 * 1024 + 1));
    expect(countProjectMcpServers(directory)).toBe(0);
  });

  it('[PM-11] discovers project Claude skills', () => {
    const skill = path.join(directory, '.claude', 'skills', 'review');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '# Review');
    expect(countProjectSkills(directory)).toBe(1);
  });

  it('[PM-12] discovers project agent skills', () => {
    const skill = path.join(directory, '.agents', 'skills', 'build');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '# Build');
    expect(countProjectSkills(directory)).toBe(1);
  });

  it('[PM-13] ignores directories without SKILL.md', () => {
    fs.mkdirSync(path.join(directory, '.claude', 'skills', 'empty'), { recursive: true });
    expect(countProjectSkills(directory)).toBe(0);
  });

  it('[PM-14] inspects CLAUDE.md and capability counts', async () => {
    fs.writeFileSync(path.join(directory, 'CLAUDE.md'), '# Instructions');
    fs.writeFileSync(path.join(directory, '.mcp.json'), JSON.stringify({ mcpServers: { local: {} } }));
    expect(await inspectProject(directory)).toMatchObject({
      claudeMdExists: true,
      mcpCount: 1,
      skillCount: 0,
    });
  });

  it('[PM-15] reports a non-repository without throwing', async () => {
    expect(await getProjectGitInfo(directory)).toEqual({
      branch: null,
      hasChanges: false,
      isRepo: false,
      ahead: 0,
      behind: 0,
    });
  });

  it('[PM-16] reports the exact Git branch', async () => {
    execFileSync('git', ['init', '-b', 'main'], { cwd: directory, stdio: 'ignore' });
    expect(await getProjectGitInfo(directory)).toMatchObject({ isRepo: true, branch: 'main' });
  });

  it('[PM-17] reports working-tree changes', async () => {
    execFileSync('git', ['init', '-b', 'main'], { cwd: directory, stdio: 'ignore' });
    fs.writeFileSync(path.join(directory, 'dirty.txt'), 'dirty');
    expect((await getProjectGitInfo(directory)).hasChanges).toBe(true);
  });

  it('[PM-18] groups current, running, and recent tasks without duplicates', () => {
    const groups = groupProjectTasks([
      session('current'),
      session('running', { status: 'running' }),
      session('recent'),
    ], 'current');
    expect(groups.current.map((item) => item.id)).toEqual(['current']);
    expect(groups.running.map((item) => item.id)).toEqual(['running']);
    expect(groups.recent.map((item) => item.id)).toEqual(['recent']);
  });

  it('[PM-19] groups favorites and archived tasks independently', () => {
    const groups = groupProjectTasks([
      session('favorite', { tags: ['favorite'] }),
      session('archived', { archived: true, tags: ['favorite'] }),
    ]);
    expect(groups.favorites.map((item) => item.id)).toEqual(['favorite']);
    expect(groups.archived.map((item) => item.id)).toEqual(['archived']);
  });

  it('[PM-20] searches title, summary, branch, and tags case-insensitively', () => {
    const sessions = [
      session('one', { title: 'Fix Login' }),
      session('two', { summary: 'Database work' }),
      session('three', { gitBranch: 'feature/AUTH', tags: ['urgent'] }),
    ];
    expect(filterTasks(sessions, 'LOGIN').map((item) => item.id)).toEqual(['one']);
    expect(filterTasks(sessions, 'database').map((item) => item.id)).toEqual(['two']);
    expect(filterTasks(sessions, 'auth').map((item) => item.id)).toEqual(['three']);
    expect(filterTasks(sessions, 'URGENT').map((item) => item.id)).toEqual(['three']);
  });
});
