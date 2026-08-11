import type { Project } from './types/project';
import type { SessionSummary } from './types/session';

export function canonicalProjectKey(projectPath: string): string {
  const normalized = projectPath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  // Claude Workbench currently targets Windows, whose project paths are
  // case-insensitive. Keeping this helper browser-safe also avoids relying on
  // Node globals in the renderer bundle.
  return normalized.toLocaleLowerCase('en-US');
}

export function projectKeyOf(project: Pick<Project, 'path'>): string {
  return canonicalProjectKey(project.path);
}

export function sessionKeyOf(
  projectPath: string,
  session: Pick<SessionSummary, 'id'>,
): string {
  return `${canonicalProjectKey(projectPath)}::${session.id}`;
}

export function sessionProjectPath(session: SessionSummary, fallback = ''): string {
  return session.projectPath || fallback;
}
