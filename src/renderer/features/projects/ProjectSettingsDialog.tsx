import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderCog, Save, X } from 'lucide-react';
import type { Project, ProjectInspection, ProjectSettings } from '../../../shared/types/project';
import type {
  ProjectAiBaselineSelectionSource,
  ProjectAiConfigurationSummaryPublic,
  ProjectAiRoleOutcomePublic,
} from '../../../shared/types/projectAi';
import { useAppStore } from '../../stores/appStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { ProjectPermissionRules } from '../permissions/ProjectPermissionRules';
import { ProjectModelPolicySettings } from '../settings/ModelProviderCenter';
import {
  AgentModelTierSettings,
  invalidReasonLabel,
  localizedTierLabel,
  localizedTierSourceLabel,
  type AgentTierSettingsApi,
} from '../settings/AgentModelTierSettings';
import {
  AgentPresetSettings,
  type AgentPresetSettingsApi,
} from '../settings/AgentPresetSettings';
import { t, type LocaleKey } from '../../i18n';

export interface ProjectAiConfigurationApi extends AgentPresetSettingsApi {
  getProjectAiConfigurationSummary(
    input: { projectId: string },
  ): Promise<ProjectAiConfigurationSummaryPublic>;
}

export interface ProjectAiConfigurationProps {
  projectId: string;
  settings: ProjectSettings;
  inspection: ProjectInspection;
  api?: ProjectAiConfigurationApi;
  onOpenProviderCenter(): void;
}

const ROLE_LABELS: Readonly<Record<ProjectAiRoleOutcomePublic['role'], string>> = {
  planner: 'Planner', coder: 'Coder', tester: 'Tester', reviewer: 'Reviewer', fixer: 'Fixer',
};

function presetStatusLabel(value: ProjectAiConfigurationSummaryPublic['presetStatus']): string {
  if (value.kind === 'custom') return t('project.ai.custom');
  const keys = {
    software_development: 'agent.preset.softwareDevelopment',
    quick_change: 'agent.preset.quickChange',
    high_quality_review: 'agent.preset.highQualityReview',
  } as const;
  return t(keys[value.presetId]);
}

const SOURCE_LABEL_KEYS: Readonly<Record<ProjectAiBaselineSelectionSource, LocaleKey>> = {
  project_policy: 'project.ai.source.projectPolicy',
  global_agent_policy: 'project.ai.source.globalAgentPolicy',
  global_default: 'project.ai.source.globalDefault',
  environment: 'project.ai.source.environment',
  claude_code: 'project.ai.source.claudeCode',
};

function sourceLabel(source: ProjectAiBaselineSelectionSource): string {
  return t(SOURCE_LABEL_KEYS[source]);
}

function safeSummary(value: ProjectAiConfigurationSummaryPublic): ProjectAiConfigurationSummaryPublic {
  return {
    includesTaskOverride: false,
    presetStatus: value.presetStatus.kind === 'preset'
      ? { kind: 'preset', presetId: value.presetStatus.presetId }
      : { kind: 'custom' },
    tiers: value.tiers.map((tier) => ({
      tier: tier.tier,
      display: {
        tier: tier.display.tier,
        displayName: tier.display.displayName,
        quality: tier.display.quality,
        speed: tier.display.speed,
        cost: tier.display.cost,
      },
      source: tier.source,
      validity: tier.validity,
      invalidReason: tier.invalidReason,
      candidate: tier.candidate ? {
        providerName: tier.candidate.providerName,
        modelId: tier.candidate.modelId,
        modelDisplayName: tier.candidate.modelDisplayName,
        runtimeType: tier.candidate.runtimeType,
        health: { ...tier.candidate.health },
      } : null,
    })),
    roles: value.roles.map((role) => role.status === 'unavailable'
      ? { status: 'unavailable', role: role.role, reason: role.reason }
      : {
          status: 'resolved',
          role: role.role,
          providerName: role.providerName,
          modelId: role.modelId,
          runtimeType: role.runtimeType,
          source: role.source,
          ...(role.tier ? { tier: role.tier, tierSource: role.tierSource } : {}),
        }),
  };
}

export function ProjectAiConfiguration({
  projectId,
  settings,
  inspection,
  api,
  onOpenProviderCenter,
}: ProjectAiConfigurationProps) {
  const port = api ?? window.api;
  const mountedRef = useRef(false);
  const loadEpochRef = useRef(0);
  const scopeSequenceRef = useRef(0);
  const scopeIncarnationRef = useRef({ projectId, sequence: scopeSequenceRef.current });
  if (scopeIncarnationRef.current.projectId !== projectId) {
    scopeSequenceRef.current += 1;
    scopeIncarnationRef.current = { projectId, sequence: scopeSequenceRef.current };
    loadEpochRef.current += 1;
  }
  const scopeIncarnation = scopeIncarnationRef.current;
  const [viewState, setViewState] = useState<{
    incarnation: typeof scopeIncarnation;
    summary: ProjectAiConfigurationSummaryPublic | null;
    error: string | null;
  } | null>(null);
  const visibleState = viewState?.incarnation === scopeIncarnation ? viewState : null;
  const summary = visibleState?.summary ?? null;
  const error = visibleState?.error ?? null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadEpochRef.current += 1;
    };
  }, []);

  const load = useCallback(async () => {
    const requestEpoch = ++loadEpochRef.current;
    setViewState((current) => current?.incarnation === scopeIncarnation
      ? { ...current, error: null }
      : { incarnation: scopeIncarnation, summary: null, error: null });
    try {
      const nextSummary = safeSummary(await port.getProjectAiConfigurationSummary({ projectId }));
      if (
        !mountedRef.current
        || scopeIncarnationRef.current !== scopeIncarnation
        || loadEpochRef.current !== requestEpoch
      ) return;
      setViewState({ incarnation: scopeIncarnation, summary: nextSummary, error: null });
    } catch {
      if (
        !mountedRef.current
        || scopeIncarnationRef.current !== scopeIncarnation
        || loadEpochRef.current !== requestEpoch
      ) return;
      setViewState((current) => current?.incarnation === scopeIncarnation
        ? { ...current, error: t('project.ai.loadFailed') }
        : { incarnation: scopeIncarnation, summary: null, error: t('project.ai.loadFailed') });
    }
  }, [port, projectId, scopeIncarnation]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (api) return undefined;
    return window.api.onModelProviderChanged(() => { void load(); });
  }, [api, load]);
  const scope = useMemo(() => ({ type: 'project', projectId } as const), [projectId]);
  const tierPort = port as AgentTierSettingsApi;

  return (
    <section
      className="project-ai-configuration agent-settings-section min-w-0 space-y-4"
      data-narrow-safe="true"
      role="region"
      aria-label={t('project.ai.title')}
    >
      <header>
        <h2 className="text-sm font-semibold">{t('project.ai.title')}</h2>
        <p className="agent-tier-disclaimer">{t('project.ai.immediateSave')}</p>
      </header>
      {error ? <p role="alert" className="agent-error-text">{error}</p> : null}
      {!summary && !error ? <p role="status">{t('common.loading')}</p> : null}
      {summary ? <>
        <div className="project-ai-summary-grid">
          <article className="project-ai-summary-card">
            <h3>{t('project.ai.currentTemplate')}</h3>
            <strong>{presetStatusLabel(summary.presetStatus)}</strong>
          </article>
          <article className="project-ai-summary-card">
            <h3>{t('project.ai.tiers')}</h3>
            <ul>
              {summary.tiers.map((tier) => <li key={tier.tier}>
                <strong>{localizedTierLabel(tier.tier)}</strong>
                <span>{localizedTierSourceLabel(tier.source)}</span>
              </li>)}
            </ul>
          </article>
        </div>
        <article className="project-ai-role-card">
          <h3>{t('project.ai.roles')}</h3>
          <ul>
            {summary.roles.map((role) => <li key={role.role}>
              <strong>{ROLE_LABELS[role.role]}</strong>
              {role.status === 'resolved' ? <span title={`${role.providerName} / ${role.modelId}`}>
                {role.providerName} / {role.modelId} · {sourceLabel(role.source)}
              </span> : <span className="agent-error-text">
                {ROLE_LABELS[role.role]} · {t('project.ai.unavailable')} · {
                  role.reason === 'selection_unavailable'
                    ? t('project.ai.unavailable')
                    : invalidReasonLabel(role.reason)
                }
              </span>}
            </li>)}
          </ul>
        </article>
      </> : null}
      <article className="project-ai-facts" aria-label={t('project.ai.facts')}>
        <h3>{t('project.ai.facts')}</h3>
        <dl>
          <div><dt>{t('project.ai.permission')}</dt><dd>{settings.defaultPermission ? settings.defaultPermission[0].toUpperCase() + settings.defaultPermission.slice(1) : t('project.ai.followGlobalValue')}</dd></div>
          <div><dt>{t('project.ai.git')}</dt><dd>{inspection.git.isRepo ? inspection.git.branch ?? 'detached' : t('project.ai.gitNotDetected')}</dd></div>
          <div><dt>{t('project.ai.checkpoint')}</dt><dd>{inspection.git.isRepo ? t('project.ai.checkpointAvailable') : t('project.ai.checkpointUnavailable')}</dd></div>
          <div><dt>{t('project.ai.mcp')}</dt><dd>{inspection.mcpCount}</dd></div>
          <div><dt>{t('project.ai.skills')}</dt><dd>{inspection.skillCount}</dd></div>
          <div><dt>{t('project.ai.permissionRules')}</dt><dd>{t('project.ai.permissionRulesManaged')}</dd></div>
        </dl>
      </article>
      <div className="project-ai-editors">
        <AgentModelTierSettings scope={scope} api={tierPort} onOpenProviderCenter={onOpenProviderCenter} />
        <AgentPresetSettings
          scope={scope}
          api={port}
          onOpenProviderCenter={onOpenProviderCenter}
          manualPolicyControls={api ? undefined : <ProjectModelPolicySettings projectId={projectId} />}
        />
      </div>
    </section>
  );
}

export interface ProjectSettingsDialogProps {
  project: Project;
  onClose: () => void;
}

export function ProjectSettingsDialog({ project, onClose }: ProjectSettingsDialogProps) {
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [inspection, setInspection] = useState<ProjectInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([
      window.api.getProjectSettings(project.id),
      window.api.inspectProject(project.path),
    ]).then(([nextSettings, nextInspection]) => {
      if (!active) return;
      setSettings(nextSettings);
      setInspection(nextInspection);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : '无法读取项目设置');
    });
    return () => { active = false; };
  }, [project.id, project.path]);

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const stored = await window.api.setProjectSettings(project.id, settings);
      const updatedProject = {
        ...project,
        name: stored.displayName || project.name,
      };
      useAppStore.getState().setCurrentProject(updatedProject);
      useAppStore.getState().setCurrentProjectSettings(stored);
      useAppStore.getState().setAgentMode(stored.agentMode);
      useWorkspaceStore.getState().upsertProject(updatedProject);
      setSettings(stored);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存项目设置失败');
    } finally {
      setSaving(false);
    }
  };

  const update = <K extends keyof ProjectSettings>(key: K, value: ProjectSettings[K]) => {
    setSettings((current) => current ? { ...current, [key]: value } : current);
  };

  return (
    <div className="fixed inset-0 z-[66] flex items-center justify-center p-5" style={{ background: 'var(--bg-overlay)' }}>
      <section className="flex max-h-[90vh] w-[min(760px,94vw)] flex-col overflow-hidden rounded-xl border shadow-xl" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }} role="dialog" aria-modal="true" aria-label="项目设置">
        <header className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--border-primary)' }}>
          <FolderCog size={16} style={{ color: 'var(--accent)' }} />
          <h2 className="flex-1 text-sm font-semibold">项目设置 · {project.name}</h2>
          <button type="button" onClick={onClose} className="rounded p-1" aria-label="关闭项目设置"><X size={15} /></button>
        </header>
        {!settings ? (
          <div className="p-8 text-center text-sm" style={{ color: error ? 'var(--error)' : 'var(--text-tertiary)' }}>{error || '正在读取项目设置…'}</div>
        ) : (
          <div className="flex-1 space-y-4 overflow-y-auto p-4 text-sm">
            <label className="block">
              <span className="mb-1 block text-xs" style={{ color: 'var(--text-secondary)' }}>项目名称</span>
              <input value={settings.displayName ?? ''} onChange={(event) => update('displayName', event.target.value || null)} className="w-full rounded-lg border px-3 py-2" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-primary)' }} placeholder={project.name} />
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label>
                <span className="mb-1 block text-xs" style={{ color: 'var(--text-secondary)' }}>默认权限</span>
                <select value={settings.defaultPermission ?? ''} onChange={(event) => update('defaultPermission', event.target.value || null)} className="w-full rounded-lg border px-2 py-2 text-xs" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-primary)' }}>
                  <option value="">跟随全局</option><option value="standard">Standard</option><option value="accept-edits">Accept edits</option><option value="plan">Plan</option>
                </select>
              </label>
              <label>
                <span className="mb-1 block text-xs" style={{ color: 'var(--text-secondary)' }}>Agent 模式</span>
                <select value={settings.agentMode} onChange={(event) => update('agentMode', event.target.value as ProjectSettings['agentMode'])} className="w-full rounded-lg border px-2 py-2 text-xs" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-primary)' }}>
                  <option value="normal">普通</option><option value="plan">规划</option><option value="develop">开发</option><option value="review">审查</option>
                </select>
              </label>
            </div>
            <label className="block rounded-lg border p-3" style={{ borderColor: 'var(--border-secondary)' }}>
              <span className="mb-1 block text-xs" style={{ color: 'var(--text-secondary)' }}>{t('project.settings.advancedFallbackLabel')}</span>
              <input
                value={settings.defaultModel ?? ''}
                onChange={(event) => update('defaultModel', event.target.value || null)}
                aria-label={t('project.settings.advancedFallbackLabel')}
                className="w-full rounded-lg border px-2 py-2 text-xs"
                style={{ background: 'var(--bg-input)', borderColor: 'var(--border-primary)' }}
                placeholder={t('project.settings.advancedFallbackPlaceholder')}
              />
              <span className="mt-1 block text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                {t('project.settings.advancedFallbackHelp')}
              </span>
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={settings.favorite} onChange={(event) => update('favorite', event.target.checked)} /> 收藏项目
            </label>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border p-3 text-xs" style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-hover)' }}>
              <div><dt style={{ color: 'var(--text-tertiary)' }}>CLAUDE.md</dt><dd>{inspection?.claudeMdExists ? '存在' : '未发现'}</dd></div>
              <div><dt style={{ color: 'var(--text-tertiary)' }}>Git</dt><dd>{inspection?.git.isRepo ? inspection.git.branch || 'detached' : '非 Git 项目'}</dd></div>
              <div><dt style={{ color: 'var(--text-tertiary)' }}>MCP</dt><dd>{inspection?.mcpCount ?? '—'} 个</dd></div>
              <div><dt style={{ color: 'var(--text-tertiary)' }}>Skills</dt><dd>{inspection?.skillCount ?? '—'} 个</dd></div>
            </dl>
            {inspection ? <ProjectAiConfiguration
              projectId={project.id}
              settings={settings}
              inspection={inspection}
              onOpenProviderCenter={() => {
                onClose();
                useAppStore.getState().setShowSettings(true);
              }}
            /> : null}
            <ProjectPermissionRules projectId={project.id} />
            {error ? <p className="text-xs" style={{ color: 'var(--error)' }}>{error}</p> : null}
          </div>
        )}
        <footer className="flex justify-end gap-2 border-t px-4 py-3" style={{ borderColor: 'var(--border-primary)' }}>
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs" style={{ background: 'var(--bg-hover)' }}>{t('project.ai.closeNotice')}</button>
          <button type="button" onClick={() => void save()} disabled={!settings || saving} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs disabled:opacity-40" style={{ background: 'var(--accent)', color: 'var(--accent-text)' }}><Save size={12} />{saving ? '保存中…' : '保存'}</button>
        </footer>
      </section>
    </div>
  );
}
