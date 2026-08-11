import { useCallback, useEffect, useState } from 'react';
import { Pause, Play, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import type {
  PermissionAuditRecord,
  ProjectPermissionRuleRecord,
} from '../../../shared/types/permissionBroker';

const PAGE_SIZE = 50;

function formatTime(value: number | string | null): string {
  if (value === null) return '尚未命中';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未知' : date.toLocaleString();
}

function capabilityLabel(capability: string): string {
  const labels: Record<string, string> = {
    'shell.read_only': 'Shell 只读',
    'shell.build': '项目构建',
    'shell.test': '项目测试',
    'shell.run_project': '运行项目',
    'shell.git_read': 'Git 只读',
    'tool.read': '读取文件',
  };
  return labels[capability] ?? capability;
}

export interface ProjectPermissionRuleListProps {
  rules: ProjectPermissionRuleRecord[];
  audits: PermissionAuditRecord[];
  showAudit: boolean;
  busyRuleId: string | null;
  onToggleRule: (rule: ProjectPermissionRuleRecord) => void;
  onDeleteRule: (rule: ProjectPermissionRuleRecord) => void;
  onClearRules: () => void;
  onToggleAudit: () => void;
}

export function ProjectPermissionRuleList({
  rules,
  audits,
  showAudit,
  busyRuleId,
  onToggleRule,
  onDeleteRule,
  onClearRules,
  onToggleAudit,
}: ProjectPermissionRuleListProps) {
  return (
    <section className="space-y-3 rounded-lg border p-3" style={{ borderColor: 'var(--border-secondary)' }}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-1.5 text-xs font-semibold">
            <ShieldCheck size={14} style={{ color: 'var(--accent)' }} />
            权限规则
          </h3>
          <p className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            只保存当前项目中的低、中风险匹配规则；高风险和跨项目访问不会持久化。
          </p>
        </div>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={onToggleAudit}
            className="rounded-md px-2 py-1 text-[11px]"
            style={{ background: 'var(--bg-hover)' }}
          >
            {showAudit ? '隐藏审计记录' : '查看审计记录'}
          </button>
          <button
            type="button"
            onClick={onClearRules}
            disabled={rules.length === 0 || busyRuleId !== null}
            className="rounded-md px-2 py-1 text-[11px] disabled:opacity-40"
            style={{ color: 'var(--error)', background: 'var(--bg-hover)' }}
          >
            清除所有规则
          </button>
        </div>
      </div>

      {rules.length === 0 ? (
        <p className="rounded-md px-3 py-4 text-center text-xs" style={{ color: 'var(--text-tertiary)', background: 'var(--bg-hover)' }}>
          当前项目没有持久权限规则
        </p>
      ) : (
        <div className="space-y-2">
          {rules.map((rule) => (
            <article
              key={rule.id}
              className="rounded-md border p-2.5 text-[11px]"
              style={{ borderColor: 'var(--border-secondary)', opacity: rule.enabled ? 1 : 0.62 }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <strong className="text-xs">{rule.toolName} · {capabilityLabel(rule.capability)}</strong>
                  <p className="mt-0.5 break-all" style={{ color: 'var(--text-tertiary)' }}>
                    {rule.commandPattern || '按 capability 匹配'}
                  </p>
                </div>
                <span className="shrink-0 rounded px-1.5 py-0.5" style={{ background: 'var(--bg-hover)' }}>
                  风险上限：{rule.riskCeiling === 'low' ? '低' : '中'}
                </span>
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1" style={{ color: 'var(--text-secondary)' }}>
                <div><dt className="inline" style={{ color: 'var(--text-tertiary)' }}>创建：</dt><dd className="inline">{formatTime(rule.createdAt)}</dd></div>
                <div><dt className="inline" style={{ color: 'var(--text-tertiary)' }}>来源：</dt><dd className="inline">用户确认</dd></div>
                <div><dt className="inline" style={{ color: 'var(--text-tertiary)' }}>最近命中：</dt><dd className="inline">{formatTime(rule.lastHitAt)}</dd></div>
                <div><dt className="inline" style={{ color: 'var(--text-tertiary)' }}>命中次数：</dt><dd className="inline">{rule.hitCount}</dd></div>
              </dl>
              <div className="mt-2 flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => onToggleRule(rule)}
                  disabled={busyRuleId !== null}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 disabled:opacity-40"
                  style={{ background: 'var(--bg-hover)' }}
                >
                  {rule.enabled ? <Pause size={11} /> : <Play size={11} />}
                  {rule.enabled ? '暂停规则' : '恢复规则'}
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteRule(rule)}
                  disabled={busyRuleId !== null}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 disabled:opacity-40"
                  style={{ color: 'var(--error)', background: 'var(--bg-hover)' }}
                >
                  <Trash2 size={11} />删除
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {showAudit ? (
        <div className="space-y-1.5 border-t pt-3" style={{ borderColor: 'var(--border-secondary)' }}>
          <h4 className="text-xs font-semibold">权限审计记录</h4>
          {audits.length === 0 ? (
            <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>暂无规则自动命中或高风险授权记录</p>
          ) : audits.map((audit) => (
            <div key={audit.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded px-2 py-1.5 text-[11px]" style={{ background: 'var(--bg-hover)' }}>
              <div className="min-w-0">
                <p className="truncate">{audit.toolName || '权限请求'} · {audit.capability ? capabilityLabel(audit.capability) : audit.eventType}</p>
                <p className="truncate" style={{ color: 'var(--text-tertiary)' }}>
                  {audit.scope ? `${audit.scope === 'task' ? '任务' : '项目'}规则` : '独立高风险流程'}
                  {audit.matchedRuleId ? ` · 规则 ${audit.matchedRuleId}` : ''}
                </p>
              </div>
              <time style={{ color: 'var(--text-tertiary)' }}>{formatTime(audit.createdAt)}</time>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export interface ProjectPermissionRulesProps {
  projectId: string;
}

export function ProjectPermissionRules({ projectId }: ProjectPermissionRulesProps) {
  const [rules, setRules] = useState<ProjectPermissionRuleRecord[]>([]);
  const [audits, setAudits] = useState<PermissionAuditRecord[]>([]);
  const [showAudit, setShowAudit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [auditLoaded, setAuditLoaded] = useState(false);
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadRules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.api.listProjectPermissionRules(projectId, {
        limit: PAGE_SIZE,
        offset: 0,
      });
      setRules(result.items);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法读取项目权限规则');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  const toggleAudit = async () => {
    const next = !showAudit;
    setShowAudit(next);
    if (!next || auditLoaded) return;
    try {
      const result = await window.api.listProjectPermissionAudit(projectId, {
        limit: PAGE_SIZE,
        offset: 0,
      });
      setAudits(result.items);
      setAuditLoaded(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法读取权限审计记录');
    }
  };

  const toggleRule = async (rule: ProjectPermissionRuleRecord) => {
    setBusyRuleId(rule.id);
    setError(null);
    try {
      const updated = await window.api.setProjectPermissionRuleEnabled(
        projectId,
        rule.id,
        !rule.enabled,
      );
      setRules((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法更新权限规则');
    } finally {
      setBusyRuleId(null);
    }
  };

  const deleteRule = async (rule: ProjectPermissionRuleRecord) => {
    if (!window.confirm(`删除 ${capabilityLabel(rule.capability)} 权限规则？`)) return;
    setBusyRuleId(rule.id);
    setError(null);
    try {
      const deleted = await window.api.deleteProjectPermissionRule(projectId, rule.id);
      if (deleted) setRules((current) => current.filter((item) => item.id !== rule.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法删除权限规则');
    } finally {
      setBusyRuleId(null);
    }
  };

  const clearRules = async () => {
    if (!window.confirm('清除当前项目的所有持久权限规则？之后匹配操作会重新询问。')) return;
    setBusyRuleId('__all__');
    setError(null);
    try {
      await window.api.clearProjectPermissionRules(projectId, true);
      setRules([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法清除权限规则');
    } finally {
      setBusyRuleId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border p-3 text-xs" style={{ borderColor: 'var(--border-secondary)', color: 'var(--text-tertiary)' }}>
        <RefreshCw className="animate-spin" size={12} />正在读取权限规则…
      </div>
    );
  }

  return (
    <>
      <ProjectPermissionRuleList
        rules={rules}
        audits={audits}
        showAudit={showAudit}
        busyRuleId={busyRuleId}
        onToggleRule={(rule) => void toggleRule(rule)}
        onDeleteRule={(rule) => void deleteRule(rule)}
        onClearRules={() => void clearRules()}
        onToggleAudit={() => void toggleAudit()}
      />
      {error ? <p className="mt-2 text-xs" style={{ color: 'var(--error)' }}>{error}</p> : null}
    </>
  );
}
