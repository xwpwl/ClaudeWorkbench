import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  Copy,
  FolderOpen,
  GitFork,
  Loader2,
  MoreHorizontal,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Code2,
  FolderCog,
  Trash2,
  Star,
} from 'lucide-react';
import { sessionKeyOf } from '../../../shared/sessionIdentity';
import type { SessionSummary } from '../../../shared/types/session';
import { useWorkspaceController } from '../../hooks/useWorkspaceController';
import { useAppStore } from '../../stores/appStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import type { Project } from '../../../shared/types/project';
import { EmptyState } from '../../components/EmptyState';
import { t } from '../../i18n';
import { filterTasks, groupProjectTasks } from './projectTaskGroups';

interface ProjectSidebarProps {
  onOpenProject: () => void;
  onProjectSettings?: (project: Project) => void;
  onOpenIntegrations?: (project: Project) => void;
}

function relativeTime(value: string): string {
  const delta = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function statusLabel(status: SessionSummary['status']): string {
  switch (status) {
    case 'loading_history': return '正在加载历史';
    case 'running': return 'Claude 正在工作';
    case 'waiting_permission': return '等待你的授权';
    case 'completed': return '已完成';
    case 'failed': return '失败';
    case 'cancelled': return '已停止';
    default: return '空闲';
  }
}

export function ProjectSidebar({ onOpenProject, onProjectSettings, onOpenIntegrations }: ProjectSidebarProps) {
  const {
    currentProject,
    currentSessionKey,
    projects,
    sessionsByProject,
    runtimes,
    projectLoading,
    projectError,
  } = useWorkspaceStore();
  const { selectProject, selectSession, createTask, renameSession, setArchived, setFavorite, fork } =
    useWorkspaceController();
  const [query, setQuery] = useState('');
  const [taskQuery, setTaskQuery] = useState('');
  const [taskScrollTop, setTaskScrollTop] = useState(0);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [projectMenu, setProjectMenu] = useState<{
    project: Project;
    x: number;
    y: number;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuKey(null);
        setProjectMenu(null);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const sessions = currentProject ? sessionsByProject[currentProject.id] ?? [] : [];
  const visibleProjects = projects.filter((project) =>
    project.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const projectedSessions = sessions.map((session) => {
    if (!currentProject) return session;
    const runtime = runtimes[sessionKeyOf(currentProject.path, session)];
    return runtime?.summary ?? session;
  });
  const currentSessionId = currentSessionKey && currentProject
    ? runtimes[currentSessionKey]?.summary.id ?? null
    : null;
  const groups = groupProjectTasks(filterTasks(projectedSessions, taskQuery), currentSessionId);
  const runningRuntimes = Object.values(runtimes).filter((runtime) => Boolean(runtime.activeRunId));
  const taskRows: Array<
    | { kind: 'header'; label: string; top: number; height: number }
    | { kind: 'task'; session: SessionSummary; top: number; height: number }
  > = [];
  let taskRowsHeight = 0;
  for (const [label, entries] of [
    ['当前任务', groups.current],
    ['运行中', groups.running],
    ['收藏任务', groups.favorites],
    ['最近任务', groups.recent],
    ['已归档', groups.archived],
  ] as const) {
    if (entries.length === 0) continue;
    taskRows.push({ kind: 'header', label: `${label}（${entries.length}）`, top: taskRowsHeight, height: 26 });
    taskRowsHeight += 26;
    for (const session of entries) {
      taskRows.push({ kind: 'task', session, top: taskRowsHeight, height: 52 });
      taskRowsHeight += 52;
    }
  }
  const taskViewportHeight = Math.min(420, Math.max(52, taskRowsHeight));
  const visibleTaskRows = taskRows.filter((row) => (
    row.top + row.height >= Math.max(0, taskScrollTop - 104)
      && row.top <= taskScrollTop + taskViewportHeight + 104
  ));

  useEffect(() => {
    setTaskScrollTop(0);
  }, [currentProject?.id, taskQuery]);

  const select = async (session: SessionSummary) => {
    if (!currentProject) return;
    setMenuKey(null);
    await selectSession(currentProject, session);
  };

  const menuSession = useMemo(() => {
    if (!menuKey || !currentProject) return null;
    return sessions.find((session) => sessionKeyOf(currentProject.path, session) === menuKey) ?? null;
  }, [currentProject, menuKey, sessions]);

  const beginRename = (session: SessionSummary) => {
    if (!currentProject) return;
    setRenamingKey(sessionKeyOf(currentProject.path, session));
    setRenameValue(session.title);
    setMenuKey(null);
  };

  const commitRename = async (session: SessionSummary) => {
    if (!renameValue.trim()) return;
    await renameSession(session, renameValue);
    setRenamingKey(null);
  };

  const renderSession = (session: SessionSummary) => {
    if (!currentProject) return null;
    const key = sessionKeyOf(currentProject.path, session);
    const runtime = runtimes[key];
    const status = runtime?.summary.status ?? session.status;
    const selected = currentSessionKey === key;
    const runningElsewhere = Boolean(runtime?.activeRunId && !selected);
    return (
      <div key={key} className="relative group">
        <button
          data-session-key={key}
          onClick={() => void select(session)}
          className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-left transition-colors"
          style={{
            color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
            backgroundColor: selected ? 'var(--bg-active)' : 'transparent',
          }}
          title={`${session.title} · ${statusLabel(status)}`}
        >
          <span className={`status-dot ${status}`} />
          <span className="min-w-0 flex-1">
            {renamingKey === key ? (
              <input
                autoFocus
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onBlur={() => void commitRename(session)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter') void commitRename(session);
                  if (event.key === 'Escape') setRenamingKey(null);
                }}
                className="w-full px-1 py-0.5 rounded border text-xs"
                style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}
              />
            ) : (
              <>
                <span className="block truncate text-xs font-medium">{session.title}</span>
                <span className="block truncate text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                  {runningElsewhere ? '后台运行 · ' : ''}
                  {session.source === 'claude-code' ? 'Claude Code 历史 · ' : ''}
                  {statusLabel(status)} · {relativeTime(session.updatedAt)}
                </span>
              </>
            )}
          </span>
        </button>
        <button
          onClick={(event) => {
            event.stopPropagation();
            setMenuKey(menuKey === key ? null : key);
          }}
          className="absolute right-1 top-2 p-1 rounded opacity-0 group-hover:opacity-100"
          style={{ color: 'var(--text-tertiary)' }}
          title="任务操作"
        >
          <MoreHorizontal size={13} />
        </button>
      </div>
    );
  };

  return (
    <aside className="h-full flex flex-col" style={{ background: 'var(--bg-sidebar)' }}>
      <div className="p-3" style={{ borderBottom: '1px solid var(--border-primary)' }}>
        <button
          onClick={() => void createTask()}
          disabled={!currentProject}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-40"
          style={{ background: 'var(--accent)', color: 'var(--accent-text)' }}
        >
          <Plus size={15} />
          新建任务
        </button>
        <div className="relative mt-2">
          <Search size={13} className="absolute left-2.5 top-2.5" style={{ color: 'var(--text-tertiary)' }} />
          <input
            data-project-search
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索项目"
            className="w-full rounded-lg py-2 pl-8 pr-2 text-xs border"
            style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2 scrollbar-hidden">
        {runningRuntimes.length > 0 ? (
          <section className="mb-2 rounded-lg border p-1" style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-hover)' }} aria-label="运行中">
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--info)' }}>运行中（{runningRuntimes.length}）</div>
            {runningRuntimes.map((runtime) => {
              const project = projects.find((candidate) => candidate.id === runtime.summary.projectId)
                ?? projects.find((candidate) => candidate.path === runtime.projectPath);
              return (
                <button
                  type="button"
                  key={runtime.key}
                  onClick={() => { if (project) void selectProject(project, runtime.summary.id); }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs"
                  title={`${project?.name ?? '项目'} · ${runtime.summary.title}`}
                >
                  <span className="h-2 w-2 flex-shrink-0 animate-pulse rounded-full" style={{ background: 'var(--info)' }} />
                  <span className="min-w-0 flex-1 truncate">{runtime.summary.title}</span>
                  <span className="max-w-16 truncate text-[9px]" style={{ color: 'var(--text-disabled)' }}>{project?.name}</span>
                </button>
              );
            })}
          </section>
        ) : null}
        {projects.length === 0 ? (
          <EmptyState
            icon={FolderOpen}
            title={t('project.noProjects')}
            description={t('project.clickToStart')}
            action={{ label: t('project.open'), onClick: onOpenProject }}
            compact
          />
        ) : null}
        {visibleProjects.map((project) => {
          const selected = currentProject?.id === project.id;
          return (
            <div key={project.id} className="mb-1">
              <button
                onClick={() => void selectProject(project)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setProjectMenu({ project, x: event.clientX, y: event.clientY });
                  setMenuKey(null);
                }}
                className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-sm text-left"
                style={{
                  color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
                  background: selected ? 'var(--accent-light)' : 'transparent',
                }}
              >
                <FolderOpen size={14} style={{ color: selected ? 'var(--accent)' : 'var(--text-tertiary)' }} />
                <span className="truncate flex-1">{project.name}</span>
              </button>

              {selected && (
                <div className="ml-3 mt-1 pl-2" style={{ borderLeft: '1px solid var(--border-primary)' }}>
                  <div className="flex items-center justify-between px-1 py-1">
                    <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
                      最近任务
                    </span>
                    <button
                      onClick={() => void selectProject(project, undefined)}
                      title="刷新 Workbench 与 Claude Code 历史"
                      className="p-1 rounded"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      <RefreshCw size={11} className={projectLoading ? 'animate-spin' : ''} />
                    </button>
                  </div>
                  <div className="relative mb-1">
                    <Search size={11} className="absolute left-2 top-2" style={{ color: 'var(--text-tertiary)' }} />
                    <input
                      data-task-search
                      value={taskQuery}
                      onChange={(event) => setTaskQuery(event.target.value)}
                      placeholder="搜索任务"
                      className="w-full rounded-md border py-1.5 pl-7 pr-2 text-[11px]"
                      style={{ background: 'var(--bg-input)', borderColor: 'var(--border-secondary)' }}
                    />
                  </div>
                  {projectLoading && projectedSessions.length === 0 && (
                    <div className="flex items-center gap-2 px-2 py-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      <Loader2 size={12} className="animate-spin" /> 正在加载本项目历史…
                    </div>
                  )}
                  {projectError && (
                    <div className="px-2 py-2 text-xs rounded" style={{ color: 'var(--error)', background: 'var(--error-bg)' }}>
                      历史加载失败：{projectError}
                    </div>
                  )}
                  {!projectLoading && !projectError && projectedSessions.length === 0 && (
                    <EmptyState
                      icon={MessageSquare}
                      title={t('task.noTasks')}
                      description={t('chat.createTask')}
                      action={{ label: t('task.new'), onClick: () => { void createTask(); } }}
                      compact
                    />
                  )}
                  {taskRows.length > 0 ? (
                    <div
                      className="relative overflow-y-auto"
                      style={{ height: taskViewportHeight }}
                      onScroll={(event) => setTaskScrollTop(event.currentTarget.scrollTop)}
                      data-testid="virtual-task-list"
                    >
                      <div className="relative" style={{ height: taskRowsHeight }}>
                        {visibleTaskRows.map((row) => (
                          <div
                            key={row.kind === 'header'
                              ? `header:${row.label}`
                              : `task:${row.session.id}:${row.session.source}`}
                            className="absolute inset-x-0 overflow-hidden"
                            style={{ top: row.top, height: row.height }}
                          >
                            {row.kind === 'header' ? (
                              <div className="px-1 py-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>{row.label}</div>
                            ) : renderSession(row.session)}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="p-2 space-y-1" style={{ borderTop: '1px solid var(--border-primary)' }}>
        <button
          onClick={onOpenProject}
          className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-xs"
          style={{ color: 'var(--text-secondary)' }}
        >
          <FolderOpen size={14} /> 打开项目
        </button>
        {currentProject && onOpenIntegrations ? (
          <button
            onClick={() => onOpenIntegrations(currentProject)}
            className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-xs"
            style={{ color: 'var(--text-secondary)' }}
          >
            <Code2 size={14} /> MCP 与 Skills
          </button>
        ) : null}
        <button
          onClick={() => useAppStore.getState().setShowSettings(true)}
          className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-xs"
          style={{ color: 'var(--text-secondary)' }}
        >
          <Settings size={14} /> 设置
        </button>
      </div>

      {menuKey && menuSession && (
        <div
          ref={menuRef}
          className="fixed z-50 w-48 rounded-lg border p-1 shadow-lg"
          style={{ left: 245, top: '35%', background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}
        >
          <button onClick={() => beginRename(menuSession)} className="w-full flex items-center gap-2 px-2 py-2 text-xs rounded hover:bg-[var(--bg-hover)]">
            <Pencil size={13} /> 重命名
          </button>
          <button onClick={() => void fork(menuSession)} className="w-full flex items-center gap-2 px-2 py-2 text-xs rounded hover:bg-[var(--bg-hover)]">
            <GitFork size={13} /> 从会话末尾分叉
          </button>
          <button
            onClick={() => {
              void navigator.clipboard.writeText(menuSession.claudeSessionId || menuSession.id);
              setMenuKey(null);
            }}
            className="w-full flex items-center gap-2 px-2 py-2 text-xs rounded hover:bg-[var(--bg-hover)]"
          >
            <Copy size={13} /> 复制会话 ID
          </button>
          <button
            onClick={() => void setArchived(menuSession, !menuSession.archived)}
            className="w-full flex items-center gap-2 px-2 py-2 text-xs rounded hover:bg-[var(--bg-hover)]"
          >
            {menuSession.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
            {menuSession.archived ? '取消归档' : '归档'}
          </button>
          {menuSession.source === 'workbench' ? (
            <button
              onClick={() => { void setFavorite(menuSession, !menuSession.tags.includes('favorite')); setMenuKey(null); }}
              className="w-full flex items-center gap-2 px-2 py-2 text-xs rounded hover:bg-[var(--bg-hover)]"
            >
              <Star size={13} fill={menuSession.tags.includes('favorite') ? 'currentColor' : 'none'} />
              {menuSession.tags.includes('favorite') ? '取消收藏' : '收藏'}
            </button>
          ) : null}
        </div>
      )}
      {projectMenu ? (
        <div
          ref={menuRef}
          className="fixed z-50 w-52 rounded-lg border p-1 shadow-lg"
          style={{
            left: Math.min(projectMenu.x, window.innerWidth - 220),
            top: Math.min(projectMenu.y, window.innerHeight - 250),
            background: 'var(--bg-card)',
            borderColor: 'var(--border-primary)',
          }}
          role="menu"
        >
          <button onClick={() => { void window.api.openPath(projectMenu.project.path); setProjectMenu(null); }} className="w-full flex items-center gap-2 px-2 py-2 text-xs rounded hover:bg-[var(--bg-hover)]"><FolderOpen size={13} />打开目录</button>
          <button onClick={() => { void window.api.openInVSCode(projectMenu.project.path); setProjectMenu(null); }} className="w-full flex items-center gap-2 px-2 py-2 text-xs rounded hover:bg-[var(--bg-hover)]"><Code2 size={13} />打开 VS Code</button>
          <button onClick={() => { void selectProject(projectMenu.project); setProjectMenu(null); }} className="w-full flex items-center gap-2 px-2 py-2 text-xs rounded hover:bg-[var(--bg-hover)]"><RefreshCw size={13} />刷新历史</button>
          <button onClick={() => { onProjectSettings?.(projectMenu.project); setProjectMenu(null); }} className="w-full flex items-center gap-2 px-2 py-2 text-xs rounded hover:bg-[var(--bg-hover)]"><FolderCog size={13} />项目设置</button>
          <div className="my-1 h-px" style={{ background: 'var(--border-secondary)' }} />
          <button
            onClick={() => {
              const project = projectMenu.project;
              const isRunning = Object.values(runtimes).some(
                (runtime) => runtime.summary.projectId === project.id && runtime.activeRunId,
              );
              if (isRunning) {
                window.alert('该项目仍有运行中的任务，请先停止任务。');
                return;
              }
              if (!window.confirm(`仅删除“${project.name}”的 Workbench 索引？真实文件不会被删除。`)) return;
              void window.api.deleteProject(project.id).then(() => {
                useWorkspaceStore.getState().removeProjectIndex(project.id);
                if (useAppStore.getState().currentProject?.id === project.id) {
                  useAppStore.getState().setCurrentProject(null);
                  useAppStore.getState().setCurrentProjectSettings(null);
                }
                setProjectMenu(null);
              });
            }}
            className="w-full flex items-center gap-2 px-2 py-2 text-xs rounded hover:bg-[var(--bg-hover)]"
            style={{ color: 'var(--error)' }}
          >
            <Trash2 size={13} />删除索引（不删除文件）
          </button>
        </div>
      ) : null}
    </aside>
  );
}
