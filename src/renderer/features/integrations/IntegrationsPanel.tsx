import { useDeferredValue, useMemo, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  FileCode2,
  Plug,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import type {
  IntegrationDiagnostic,
  McpServerIntegration,
  SkillDocument,
  SkillIntegration,
} from '../../../shared/types/integrations';

export interface IntegrationsPanelProps {
  mcpServers: readonly McpServerIntegration[];
  skills: readonly SkillIntegration[];
  diagnostics?: readonly IntegrationDiagnostic[];
  selectedSkill?: SkillDocument | null;
  loading?: boolean;
  error?: string | null;
  onRefresh: () => void;
  onViewSkill: (skill: SkillIntegration) => void;
  onSetMcpEnabled?: (server: McpServerIntegration, enabled: boolean) => void;
  onTestMcp?: (server: McpServerIntegration) => void;
  mcpTestMessages?: Readonly<Record<string, string>>;
  onCloseSkill?: () => void;
  onClose?: () => void;
  initialTab?: IntegrationTab;
}

export type IntegrationTab = 'mcp' | 'skills';

function sourceLabel(source: 'project' | 'user'): string {
  return source === 'project' ? '项目' : '用户';
}

function StatusBadge({ children, tone }: { children: ReactNode; tone: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]"
      style={{ color: tone, background: 'var(--bg-hover)' }}
    >
      {children}
    </span>
  );
}

function McpStatus({ server }: { server: McpServerIntegration }) {
  if (server.status === 'configured') {
    return <StatusBadge tone="var(--success)"><CheckCircle2 size={10} />已配置</StatusBadge>;
  }
  if (server.status === 'disabled') {
    return <StatusBadge tone="var(--text-tertiary)">已禁用</StatusBadge>;
  }
  return <StatusBadge tone="var(--error)"><AlertCircle size={10} />配置错误</StatusBadge>;
}

function SkillStatus({ skill }: { skill: SkillIntegration }) {
  if (skill.status === 'available') {
    return <StatusBadge tone="var(--success)"><CheckCircle2 size={10} />可用</StatusBadge>;
  }
  const label = skill.status === 'too_large'
    ? '超过 1MB'
    : skill.status === 'invalid_utf8'
      ? '编码无效'
      : '不可读取';
  return <StatusBadge tone="var(--error)"><AlertCircle size={10} />{label}</StatusBadge>;
}

function McpServerCard({
  server,
  onSetEnabled,
  onTest,
  testMessage,
}: {
  server: McpServerIntegration;
  onSetEnabled?: (server: McpServerIntegration, enabled: boolean) => void;
  onTest?: (server: McpServerIntegration) => void;
  testMessage?: string;
}) {
  const envEntries = Object.entries(server.redactedEnv);
  return (
    <article
      className="rounded-lg border p-3"
      style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}
      data-testid={`mcp-server:${server.id}`}
    >
      <div className="flex items-start gap-2">
        <Plug size={15} style={{ color: 'var(--accent)', marginTop: 2 }} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <strong className="truncate text-sm">{server.name}</strong>
            <StatusBadge tone="var(--text-secondary)">{sourceLabel(server.source)}</StatusBadge>
            <McpStatus server={server} />
          </div>
          <div className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            {server.transport.toUpperCase()}
          </div>
          {server.command ? (
            <div className="mt-2 truncate font-mono text-[11px] selectable" title={server.command}>
              {server.command} {server.args.join(' ')}
            </div>
          ) : null}
          {server.url ? (
            <div className="mt-2 truncate font-mono text-[11px] selectable" title={server.url}>
              {server.url}
            </div>
          ) : null}
          {envEntries.length > 0 ? (
            <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-2 text-[10px] font-mono selectable">
              {envEntries.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt style={{ color: 'var(--text-tertiary)' }}>{key}</dt>
                  <dd className="truncate">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {server.error ? (
            <p className="mt-2 text-xs" style={{ color: 'var(--error)' }}>{server.error}</p>
          ) : null}
          <div className="mt-3 flex items-center gap-2">
            {onSetEnabled && server.status !== 'invalid' ? (
              <button
                type="button"
                onClick={() => onSetEnabled(server, server.status === 'disabled')}
                className="rounded-md px-2 py-1 text-[11px]"
                style={{ color: 'var(--accent)', background: 'var(--accent-light)' }}
              >
                {server.status === 'disabled' ? '启用' : '禁用'}
              </button>
            ) : null}
            {onTest ? (
              <button
                type="button"
                onClick={() => onTest(server)}
                className="rounded-md px-2 py-1 text-[11px]"
                style={{ color: 'var(--text-secondary)', background: 'var(--bg-hover)' }}
              >
                测试配置
              </button>
            ) : null}
            {testMessage ? (
              <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{testMessage}</span>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
}

function SkillCard({
  skill,
  onView,
}: {
  skill: SkillIntegration;
  onView: (skill: SkillIntegration) => void;
}) {
  return (
    <article
      className="rounded-lg border p-3"
      style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}
      data-testid={`skill:${skill.id}`}
    >
      <div className="flex items-start gap-2">
        <FileCode2 size={15} style={{ color: 'var(--accent)', marginTop: 2 }} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <strong className="truncate text-sm">{skill.name}</strong>
            <StatusBadge tone="var(--text-secondary)">{sourceLabel(skill.source)}</StatusBadge>
            <SkillStatus skill={skill} />
          </div>
          {skill.description ? (
            <p className="mt-1 line-clamp-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
              {skill.description}
            </p>
          ) : null}
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="truncate text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
              {(skill.sizeBytes / 1024).toFixed(1)} KB
            </span>
            <button
              type="button"
              disabled={skill.status !== 'available'}
              onClick={() => onView(skill)}
              className="rounded-md px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
              style={{ color: 'var(--accent)', background: 'var(--accent-light)' }}
            >
              只读查看
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

export function IntegrationsPanel({
  mcpServers,
  skills,
  diagnostics = [],
  selectedSkill = null,
  loading = false,
  error = null,
  onRefresh,
  onViewSkill,
  onSetMcpEnabled,
  onTestMcp,
  mcpTestMessages = {},
  onCloseSkill,
  onClose,
  initialTab = 'mcp',
}: IntegrationsPanelProps) {
  const [activeTab, setActiveTab] = useState<IntegrationTab>(initialTab);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const visibleMcpServers = useMemo(
    () => mcpServers.filter((server) => [
      server.name,
      server.transport,
      sourceLabel(server.source),
    ].some((value) => value.toLocaleLowerCase().includes(deferredQuery))),
    [deferredQuery, mcpServers],
  );
  const visibleSkills = useMemo(
    () => skills.filter((skill) => [
      skill.name,
      skill.description ?? '',
      sourceLabel(skill.source),
    ].some((value) => value.toLocaleLowerCase().includes(deferredQuery))),
    [deferredQuery, skills],
  );

  return (
    <section className="relative flex h-full min-h-0 flex-col" data-testid="integrations-panel">
      <header
        className="flex items-center gap-2 border-b px-4 py-3"
        style={{ borderColor: 'var(--border-primary)' }}
      >
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">集成管理</h2>
          <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            只读发现用户与项目 MCP、Skills；不会修改用户全局配置。
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="rounded-md p-1.5 disabled:opacity-50"
          title="刷新集成"
          aria-label="刷新集成"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
        {onClose ? (
          <button type="button" onClick={onClose} className="rounded-md p-1.5" aria-label="关闭集成管理">
            <X size={15} />
          </button>
        ) : null}
      </header>

      <div className="flex gap-1 px-4 pt-3">
        {(['mcp', 'skills'] as const).map((tab) => (
          <button
            type="button"
            key={tab}
            onClick={() => setActiveTab(tab)}
            className="rounded-md px-3 py-1.5 text-xs"
            style={{
              color: activeTab === tab ? 'var(--accent)' : 'var(--text-secondary)',
              background: activeTab === tab ? 'var(--accent-light)' : 'transparent',
            }}
          >
            {tab === 'mcp' ? `MCP（${mcpServers.length}）` : `Skills（${skills.length}）`}
          </button>
        ))}
      </div>

      <div className="relative px-4 py-3">
        <Search
          size={13}
          className="absolute left-6 top-[22px]"
          style={{ color: 'var(--text-tertiary)' }}
        />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="w-full rounded-lg border py-2 pl-8 pr-3 text-xs"
          style={{ background: 'var(--bg-input)', borderColor: 'var(--border-primary)' }}
          placeholder={activeTab === 'mcp' ? '搜索 MCP' : '搜索 Skills'}
          aria-label={activeTab === 'mcp' ? '搜索 MCP' : '搜索 Skills'}
        />
      </div>

      {error ? (
        <div className="mx-4 mb-3 rounded-md px-3 py-2 text-xs" style={{ color: 'var(--error)', background: 'var(--error-bg)' }}>
          {error}
        </div>
      ) : null}
      {diagnostics.length > 0 ? (
        <details className="mx-4 mb-3 text-xs">
          <summary className="cursor-pointer" style={{ color: 'var(--warning)' }}>
            {diagnostics.length} 条发现诊断
          </summary>
          <ul className="mt-2 space-y-1" style={{ color: 'var(--text-secondary)' }}>
            {diagnostics.map((entry) => (
              <li key={`${entry.source}:${entry.path}:${entry.code}`}>{entry.message}</li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto px-4 pb-4 content-start">
        {activeTab === 'mcp'
          ? visibleMcpServers.map((server) => (
            <McpServerCard
              key={server.id}
              server={server}
              onSetEnabled={onSetMcpEnabled}
              onTest={onTestMcp}
              testMessage={mcpTestMessages[server.id]}
            />
          ))
          : visibleSkills.map((skill) => (
            <SkillCard key={skill.id} skill={skill} onView={onViewSkill} />
          ))}
        {!loading && activeTab === 'mcp' && visibleMcpServers.length === 0 ? (
          <div className="py-10 text-center text-xs" style={{ color: 'var(--text-disabled)' }}>未发现 MCP 配置</div>
        ) : null}
        {!loading && activeTab === 'skills' && visibleSkills.length === 0 ? (
          <div className="py-10 text-center text-xs" style={{ color: 'var(--text-disabled)' }}>未发现 Skills</div>
        ) : null}
      </div>

      {selectedSkill ? (
        <aside
          className="absolute inset-y-0 right-0 z-20 flex w-[min(640px,80vw)] flex-col border-l shadow-xl"
          style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}
          data-testid="skill-readonly-viewer"
        >
          <header className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--border-primary)' }}>
            <FileCode2 size={15} style={{ color: 'var(--accent)' }} />
            <strong className="min-w-0 flex-1 truncate text-sm">{selectedSkill.name}</strong>
            <StatusBadge tone="var(--text-secondary)">只读</StatusBadge>
            <button type="button" onClick={onCloseSkill} className="rounded-md p-1" aria-label="关闭 Skill 内容">
              <X size={15} />
            </button>
          </header>
          <pre className="selectable min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-4 text-xs font-mono">
            {selectedSkill.content}
          </pre>
        </aside>
      ) : null}
    </section>
  );
}
