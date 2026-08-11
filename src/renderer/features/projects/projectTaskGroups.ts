import type { SessionSummary } from '../../../shared/types/session';

export interface ProjectTaskGroups {
  running: SessionSummary[];
  current: SessionSummary[];
  recent: SessionSummary[];
  favorites: SessionSummary[];
  archived: SessionSummary[];
}

function updatedDescending(a: SessionSummary, b: SessionSummary): number {
  const time = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  return time || a.id.localeCompare(b.id);
}

export function isFavoriteTask(session: SessionSummary): boolean {
  return session.tags.includes('favorite');
}

export function filterTasks(
  sessions: SessionSummary[],
  query: string,
): SessionSummary[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...sessions];
  return sessions.filter((session) => [
    session.title,
    session.summary ?? '',
    session.gitBranch ?? '',
    ...session.tags,
  ].some((value) => value.toLocaleLowerCase().includes(normalized)));
}

export function groupProjectTasks(
  sessions: SessionSummary[],
  currentSessionId?: string | null,
): ProjectTaskGroups {
  const sorted = [...sessions].sort(updatedDescending);
  const current = currentSessionId
    ? sorted.filter((session) => session.id === currentSessionId)
    : [];
  const running = sorted.filter(
    (session) => !session.archived
      && ['running', 'waiting_permission'].includes(session.status)
      && session.id !== currentSessionId,
  );
  const favorites = sorted.filter(
    (session) => !session.archived
      && isFavoriteTask(session)
      && session.id !== currentSessionId
      && !running.some((candidate) => candidate.id === session.id),
  );
  const excluded = new Set([
    ...current,
    ...running,
    ...favorites,
  ].map((session) => session.id));
  return {
    current,
    running,
    favorites,
    recent: sorted.filter((session) => !session.archived && !excluded.has(session.id)),
    archived: sorted.filter((session) => session.archived),
  };
}

export const projectTaskGroupInternals = { updatedDescending };
