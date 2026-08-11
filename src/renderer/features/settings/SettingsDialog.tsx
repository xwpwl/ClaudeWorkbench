import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  X, Save, RotateCcw, CheckCircle, AlertCircle,
  Settings as SettingsIcon, Shield, Database, Info,
  Minus, Plus, ExternalLink, RefreshCw, Play, Copy, Download, Bot,
  GitBranch, Plug, FileCode2, FolderOpen,
} from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { t, setLocale, type Locale, type LocaleKey } from '../../i18n';
import type { AppSettings, ConnectionStatus, ClaudeTestResult, DiagnosticsInfo, EnvironmentCheckResult, ReleaseVersionInfo, UpdateSnapshot } from '../../../shared/types/ipc';
import type { GitStatus } from '../../../shared/types/git';
import type { Project } from '../../../shared/types/project';
import { PERMISSION_MODES } from '../../../shared/types/claude';
import { GlobalAgentModelPolicySettings, ModelProviderCenter } from './ModelProviderCenter';
import { AgentModelTierSettings } from './AgentModelTierSettings';
import { AgentPresetSettings } from './AgentPresetSettings';
import { EmptyState } from '../../components/EmptyState';
import { gitStatusOutcome } from '../git/gitPanelModel';

export type SettingsCategory = 'general' | 'models' | 'agent' | 'permissions' | 'git' | 'mcp' | 'skills' | 'data' | 'about';

interface SettingsDialogProps {
  onClose: () => void;
  initialCategory?: SettingsCategory;
  onOpenProject?: () => void;
  onOpenIntegrations?: (project: Project, initialTab: 'mcp' | 'skills') => void;
}

const CATEGORIES: { id: SettingsCategory; icon: React.ReactNode; labelKey: LocaleKey }[] = [
  { id: 'general', icon: <SettingsIcon size={16} />, labelKey: 'settings.general' },
  { id: 'models', icon: <Bot size={16} />, labelKey: 'settings.models' },
  { id: 'agent', icon: <Bot size={16} />, labelKey: 'settings.agent' },
  { id: 'permissions', icon: <Shield size={16} />, labelKey: 'settings.permissions' },
  { id: 'git', icon: <GitBranch size={16} />, labelKey: 'settings.git' },
  { id: 'mcp', icon: <Plug size={16} />, labelKey: 'settings.mcp' },
  { id: 'skills', icon: <FileCode2 size={16} />, labelKey: 'settings.skills' },
  { id: 'data', icon: <Database size={16} />, labelKey: 'settings.dataSection' },
  { id: 'about', icon: <Info size={16} />, labelKey: 'settings.about' },
];

const SETTINGS_FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function SettingsDialog({
  onClose,
  initialCategory = 'general',
  onOpenProject,
  onOpenIntegrations,
}: SettingsDialogProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [originalSettings, setOriginalSettings] = useState<AppSettings | null>(null);
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>(initialCategory);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [envCheck, setEnvCheck] = useState<EnvironmentCheckResult | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus | null>(null);
  const [claudeTestResult, setClaudeTestResult] = useState<ClaudeTestResult | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsInfo | null>(null);
  const [releaseInfo, setReleaseInfo] = useState<ReleaseVersionInfo | null>(null);
  const [releaseError, setReleaseError] = useState('');
  const [updateState, setUpdateState] = useState<UpdateSnapshot | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState('');
  const [diagnosticsExportBusy, setDiagnosticsExportBusy] = useState(false);
  const [diagnosticsExportError, setDiagnosticsExportError] = useState('');
  const [testing, setTesting] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const aboutRequestRef = useRef(0);
  const currentProject = useWorkspaceStore((state) => state.currentProject);

  const {
    setTheme, setLocale: setAppLocale,
    detectedModel, setPermissionMode, setShowDangerousPermissions,
  } = useAppStore();

  // Load settings
  useEffect(() => {
    const load = async () => {
      try {
        const s = await window.api.getSettings();
        const normalized = { ...s, autoCheckUpdates: s.autoCheckUpdates ?? false };
        setSettings(normalized);
        setOriginalSettings({ ...normalized });
      } catch (err) {
        console.error('Failed to load settings:', err);
      }
    };
    load();
  }, []);

  // About data is lazy and read-only. Merely opening the dialog never checks
  // the network; only the explicit button below invokes checkForUpdates().
  useEffect(() => {
    if (activeCategory !== 'about') return undefined;
    const requestId = ++aboutRequestRef.current;
    let active = true;
    setReleaseError('');
    setUpdateError('');

    void window.api.getReleaseVersion()
      .then((version) => {
        if (active && requestId === aboutRequestRef.current) setReleaseInfo(version);
      })
      .catch(() => {
        if (active && requestId === aboutRequestRef.current) {
          setReleaseError(t('about.releaseLoadFailed'));
        }
      });
    void window.api.getUpdateState()
      .then((update) => {
        if (active && requestId === aboutRequestRef.current) setUpdateState(update);
      })
      .catch(() => {
        if (active && requestId === aboutRequestRef.current) {
          setUpdateError(t('update.loadFailed'));
        }
      });

    return () => {
      active = false;
      if (requestId === aboutRequestRef.current) aboutRequestRef.current += 1;
    };
  }, [activeCategory]);

  // Load environment check
  useEffect(() => {
    window.api.checkEnvironment().then(setEnvCheck).catch(() => {});
    window.api.getConnectionStatus().then(setConnectionStatus).catch(() => {});
  }, []);

  // Check if settings have changed
  const hasChanges = useMemo(() => {
    if (!settings || !originalSettings) return false;
    return JSON.stringify(settings) !== JSON.stringify(originalSettings);
  }, [settings, originalSettings]);

  const updateSetting = useCallback(
    <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      setSettings((prev) => (prev ? { ...prev, [key]: value } : null));
    },
    [],
  );

  const handleSave = useCallback(async () => {
    if (!settings) return;
    setSaving(true);
    try {
      await window.api.setSettings(settings);
      if (settings.theme) setTheme(settings.theme);
      if (settings.language) {
        setAppLocale(settings.language as Locale);
        setLocale(settings.language as Locale);
      }
      // Update permission mode in store
      setPermissionMode(settings.defaultPermissionMode);
      setShowDangerousPermissions(settings.showDangerousPermissions);
      setOriginalSettings({ ...settings });
      setSaveStatus('success');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    } finally {
      setSaving(false);
    }
  }, [settings, setTheme, setAppLocale, setPermissionMode, setShowDangerousPermissions]);

  const handleResetDefaults = useCallback(async () => {
    if (!window.confirm(t('settings.resetConfirm'))) return;
    try {
      // Reset by clearing all settings and reloading
      await window.api.setSettings({
        claudePath: 'claude', autoDetectClaude: true, claudeGitBashPath: '',
        defaultModel: '', detectedModel: '', modelSource: 'claude-default',
        defaultPermissionMode: 'standard', showDangerousPermissions: false,
        gitPath: 'git', vscodePath: 'code',
        terminalShell: 'powershell',
        theme: 'light', fontSize: 14, language: 'zh-CN', dataPath: '',
        autoCheckUpdates: false,
      });
      const s = await window.api.getSettings();
      setSettings(s);
      setOriginalSettings({ ...s });
      setTheme('light');
      setAppLocale('zh-CN');
      setLocale('zh-CN');
    } catch (err) {
      console.error('Failed to reset settings:', err);
    }
  }, [setTheme, setAppLocale]);

  const handleClose = useCallback((): boolean => {
    if (hasChanges) {
      if (!window.confirm(t('settings.unsavedChanges'))) return false;
    }
    onClose();
    return true;
  }, [hasChanges, onClose]);

  const handleTestClaude = useCallback(async () => {
    setTesting(true);
    try {
      const result = await window.api.testClaude();
      setClaudeTestResult(result);
    } catch (err) {
      console.error('Test failed:', err);
    } finally {
      setTesting(false);
    }
  }, []);

  const handleRefreshConnection = useCallback(async () => {
    try {
      const status = await window.api.getConnectionStatus();
      setConnectionStatus(status);
      const env = await window.api.checkEnvironment();
      setEnvCheck(env);
    } catch (err) {
      console.error('Failed to refresh:', err);
    }
  }, []);

  const handleLoadDiagnostics = useCallback(async () => {
    try {
      const info = await window.api.getDiagnostics();
      setDiagnostics(info);
    } catch (err) {
      console.error('Failed to load diagnostics:', err);
    }
  }, []);

  const handleCopyDiagnostics = useCallback(() => {
    if (diagnostics) {
      navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
    }
  }, [diagnostics]);

  const runUpdateAction = useCallback(async (
    action: () => Promise<UpdateSnapshot>,
  ) => {
    setUpdateBusy(true);
    setUpdateError('');
    try {
      setUpdateState(await action());
    } catch {
      setUpdateError(t('update.actionFailed'));
    } finally {
      setUpdateBusy(false);
    }
  }, []);

  const handleInstallUpdate = useCallback(async () => {
    if (!window.confirm(t('update.installConfirm'))) return;
    setUpdateBusy(true);
    setUpdateError('');
    try {
      const accepted = await window.api.installUpdate(true);
      if (!accepted) setUpdateError(t('update.installUnavailable'));
    } catch {
      setUpdateError(t('update.actionFailed'));
    } finally {
      setUpdateBusy(false);
    }
  }, []);

  const settingsReady = settings !== null;
  useEffect(() => {
    if (!settingsReady) return undefined;
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    queueMicrotask(() => {
      dialogRef.current?.querySelector<HTMLElement>(SETTINGS_FOCUSABLE_SELECTOR)?.focus();
    });
    return () => origin?.focus();
  }, [settingsReady]);

  const handleDialogKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')];
    if (dialogs.at(-1) !== dialogRef.current) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      handleClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = [...(dialogRef.current?.querySelectorAll<HTMLElement>(SETTINGS_FOCUSABLE_SELECTOR) ?? [])];
    if (focusables.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, [handleClose]);

  if (!settings) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'var(--bg-overlay)' }}>
        <div className="rounded-xl p-6" style={{ backgroundColor: 'var(--bg-card)' }}>{t('common.loading')}</div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in" style={{ backgroundColor: 'var(--bg-overlay)' }}>
      <div
        ref={dialogRef}
        className="rounded-xl flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
        style={{
          width: '800px',
          height: '660px',
          maxWidth: '92vw',
          maxHeight: '88vh',
          backgroundColor: 'var(--bg-card)',
          border: '1px solid var(--border-primary)',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 flex-shrink-0" style={{ borderBottom: '1px solid var(--border-primary)' }}>
          <h2 id="settings-dialog-title" className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{t('settings.title')}</h2>
          <button
            onClick={handleClose}
            aria-label={t('common.close')}
            className="p-1 rounded-md transition-colors"
            style={{ color: 'var(--text-tertiary)' }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--bg-hover)';
              e.currentTarget.style.color = 'var(--text-primary)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
              e.currentTarget.style.color = 'var(--text-tertiary)';
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body: sidebar + content */}
        <div className="flex min-h-0 flex-1 max-sm:flex-col" data-testid="settings-body">
          {/* Sidebar */}
          <div
            className="w-40 flex-shrink-0 overflow-y-auto py-2 max-sm:flex max-sm:w-full max-sm:overflow-x-auto max-sm:overflow-y-hidden max-sm:py-1"
            data-testid="settings-sidebar"
            style={{
              borderRight: '1px solid var(--border-primary)',
              backgroundColor: 'var(--bg-secondary)',
            }}
          >
            {CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                aria-current={activeCategory === cat.id ? 'page' : undefined}
                onClick={() => {
                  setActiveCategory(cat.id);
                  contentRef.current?.scrollTo?.(0, 0);
                }}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-xs transition-colors max-sm:w-auto max-sm:flex-shrink-0"
                style={{
                  color: activeCategory === cat.id ? 'var(--accent)' : 'var(--text-secondary)',
                  backgroundColor: activeCategory === cat.id ? 'var(--accent-light)' : 'transparent',
                  fontWeight: activeCategory === cat.id ? 600 : 400,
                }}
                onMouseEnter={(e) => {
                  if (activeCategory !== cat.id) e.currentTarget.style.backgroundColor = 'var(--bg-hover)';
                }}
                onMouseLeave={(e) => {
                  if (activeCategory !== cat.id) e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                <span style={{ flexShrink: 0 }}>{cat.icon}</span>
                <span>{t(cat.labelKey)}</span>
              </button>
            ))}
          </div>

          {/* Content */}
          <div ref={contentRef} className="min-w-0 flex-1 overflow-y-auto p-5 max-sm:p-4" data-testid="settings-content">
            {activeCategory === 'general' && (
              <div className="space-y-8">
                <GeneralSection settings={settings} updateSetting={updateSetting} />
                <AppearanceSection settings={settings} updateSetting={updateSetting} />
                <TerminalToolsSection
                  settings={settings}
                  updateSetting={updateSetting}
                  envCheck={envCheck}
                  showGit={false}
                />
              </div>
            )}
            {activeCategory === 'models' && (
              <div className="space-y-6">
                <ModelProviderCenter />
                <details className="rounded-xl border" style={{ borderColor: 'var(--border-primary)' }}>
                  <summary className="cursor-pointer px-4 py-3 text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                    {t('settings.claudeAdvanced')}
                  </summary>
                  <div className="space-y-8 border-t p-4" style={{ borderColor: 'var(--border-primary)' }}>
                    <ClaudeCodeSection
                      settings={settings}
                      updateSetting={updateSetting}
                      envCheck={envCheck}
                    />
                    <ModelConnectionSection
                      settings={settings}
                      updateSetting={updateSetting}
                      connectionStatus={connectionStatus}
                      claudeTestResult={claudeTestResult}
                      testing={testing}
                      onTestClaude={handleTestClaude}
                      onRefresh={handleRefreshConnection}
                      diagnostics={diagnostics}
                      onLoadDiagnostics={handleLoadDiagnostics}
                      onCopyDiagnostics={handleCopyDiagnostics}
                      detectedModel={detectedModel}
                    />
                  </div>
                </details>
              </div>
            )}
            {activeCategory === 'agent' && (
              <AgentSettingsSection onOpenProviderCenter={() => setActiveCategory('models')} />
            )}
            {activeCategory === 'permissions' && (
              <PermissionsSection
                settings={settings}
                updateSetting={updateSetting}
              />
            )}
            {activeCategory === 'git' && (
              <GitSection
                settings={settings}
                envCheck={envCheck}
                project={currentProject}
                onOpenProject={onOpenProject}
              />
            )}
            {(activeCategory === 'mcp' || activeCategory === 'skills') && (
              <ProjectIntegrationSection
                kind={activeCategory}
                project={currentProject}
                onOpenProject={onOpenProject}
                onOpenIntegrations={(project, tab) => {
                  if (!handleClose()) return;
                  onOpenIntegrations?.(project, tab);
                }}
              />
            )}
            {activeCategory === 'data' && (
              <DataSection settings={settings} />
            )}
            {activeCategory === 'about' && (
              <AboutSection
                settings={settings}
                updateSetting={updateSetting}
                releaseInfo={releaseInfo}
                updateState={updateState}
                busy={updateBusy}
                error={updateError}
                onCheck={() => void runUpdateAction(() => window.api.checkForUpdates())}
                onDownload={() => void runUpdateAction(() => window.api.downloadUpdate())}
                onInstall={() => void handleInstallUpdate()}
                claudeVersion={envCheck?.claude.version ?? null}
                diagnosticsBusy={diagnosticsExportBusy}
                diagnosticsError={diagnosticsExportError}
                releaseError={releaseError}
                onExportDiagnostics={(includeAnonymousPerformanceData) => {
                  setDiagnosticsExportBusy(true);
                  setDiagnosticsExportError('');
                  void window.api
                    .exportDiagnostics({ includeAnonymousPerformanceData })
                    .catch(() => setDiagnosticsExportError(t('diag.exportFailed')))
                    .finally(() => setDiagnosticsExportBusy(false));
                }}
              />
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-2 px-5 py-3" style={{ borderTop: '1px solid var(--border-primary)' }}>
          <button
            onClick={handleResetDefaults}
            className="flex items-center gap-2 px-3 py-1.5 text-xs rounded-lg transition-colors"
            style={{ color: 'var(--text-secondary)', backgroundColor: 'var(--bg-hover)' }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-active)')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-hover)')}
          >
            <RotateCcw size={13} />
            {t('settings.resetDefault')}
          </button>
          <div className="flex items-center gap-2">
            {saveStatus === 'success' && (
              <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--success)' }}>
                <CheckCircle size={14} />
                {t('settings.saved')}
              </span>
            )}
            {saveStatus === 'error' && (
              <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--error)' }}>
                <AlertCircle size={14} />
                {t('settings.saveError')}
              </span>
            )}
            <button
              onClick={handleClose}
              className="px-3 py-1.5 text-xs rounded-lg transition-colors"
              style={{ color: 'var(--text-secondary)', backgroundColor: 'var(--bg-hover)' }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-active)')}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-hover)')}
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !hasChanges}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs rounded-lg transition-colors font-medium"
              style={{
                color: 'var(--accent-text)',
                backgroundColor: hasChanges ? 'var(--accent)' : 'var(--bg-hover)',
                opacity: saving || !hasChanges ? 0.5 : 1,
                cursor: saving || !hasChanges ? 'not-allowed' : 'pointer',
              }}
              onMouseEnter={(e) => {
                if (hasChanges) e.currentTarget.style.backgroundColor = 'var(--accent-hover)';
              }}
              onMouseLeave={(e) => {
                if (hasChanges) e.currentTarget.style.backgroundColor = 'var(--accent)';
              }}
            >
              <Save size={13} />
              {saving ? '...' : t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const GLOBAL_MODEL_TIER_SCOPE = { type: 'global' } as const;

function AgentSettingsSection({ onOpenProviderCenter }: { onOpenProviderCenter(): void }) {
  const [statusRefresh, setStatusRefresh] = useState(0);
  return (
    <div className="agent-settings-page">
      <AgentModelTierSettings scope={GLOBAL_MODEL_TIER_SCOPE} onOpenProviderCenter={onOpenProviderCenter} />
      <AgentPresetSettings
        scope={GLOBAL_MODEL_TIER_SCOPE}
        onOpenProviderCenter={onOpenProviderCenter}
        refreshToken={statusRefresh}
        manualPolicyControls={<GlobalAgentModelPolicySettings onChanged={() => setStatusRefresh((value) => value + 1)} />}
      />
    </div>
  );
}

// ============================================================
// Section Components
// ============================================================

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>{children}</h3>;
}

function SectionDesc({ children }: { children: React.ReactNode }) {
  return <p className="text-xs mb-3" style={{ color: 'var(--text-tertiary)' }}>{children}</p>;
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="block text-xs mb-1.5" style={{ color: 'var(--text-secondary)' }}>{children}</label>;
}

function TextInput({ value, onChange, disabled, placeholder }: {
  value: string; onChange: (v: string) => void; disabled?: boolean; placeholder?: string;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      placeholder={placeholder}
      className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
      style={{
        backgroundColor: disabled ? 'var(--bg-tertiary)' : 'var(--bg-input)',
        border: '1px solid var(--border-secondary)',
        color: disabled ? 'var(--text-disabled)' : 'var(--text-primary)',
        cursor: disabled ? 'not-allowed' : 'text',
      }}
    />
  );
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className="inline-block w-2 h-2 rounded-full"
      style={{ backgroundColor: ok ? 'var(--success)' : 'var(--error)' }}
    />
  );
}

function InfoRow({ label, value, status }: { label: string; value: string; status?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-xs py-1">
      <span style={{ color: 'var(--text-tertiary)', minWidth: 80 }}>{label}:</span>
      <span style={{ color: 'var(--text-primary)' }}>{value}</span>
      {status !== undefined && <StatusDot ok={status} />}
    </div>
  );
}

// ============================================================
// General Section
// ============================================================
function GeneralSection({ settings, updateSetting }: {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}) {
  return (
    <div className="space-y-6">
      <section>
        <SectionTitle>{t('settings.language')}</SectionTitle>
        <div className="flex gap-2">
          {(['zh-CN', 'en-US'] as const).map((lang) => (
            <button
              key={lang}
              onClick={() => updateSetting('language', lang)}
              className="px-4 py-2 rounded-lg text-xs transition-colors"
              style={{
                color: settings.language === lang ? 'var(--accent)' : 'var(--text-secondary)',
                backgroundColor: settings.language === lang ? 'var(--accent-light)' : 'var(--bg-hover)',
                border: settings.language === lang ? '1px solid var(--accent)' : '1px solid transparent',
                fontWeight: settings.language === lang ? 600 : 400,
              }}
            >
              {lang === 'zh-CN' ? t('settings.langZhCN') : t('settings.langEnUS')}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

// ============================================================
// Claude Code Section
// ============================================================
function ClaudeCodeSection({ settings, updateSetting, envCheck }: {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  envCheck: EnvironmentCheckResult | null;
}) {
  return (
    <div className="space-y-6">
      {/* Claude Code Command */}
      <section>
        <SectionTitle>{t('settings.claudeCommand')}</SectionTitle>
        <div className="space-y-2">
          <InfoRow label={t('settings.claudePath')} value={envCheck?.claude.path || settings.claudePath} status={envCheck?.claude.ok} />
          <InfoRow label={t('settings.claudeVersion')} value={envCheck?.claude.version || '—'} />
          <InfoRow label={t('settings.claudeInstallType')} value={envCheck?.claude.installType || '—'} />
          <InfoRow
            label={t('settings.claudeStatus')}
            value={envCheck?.claude.ok ? t('settings.claudeAvailable') : t('settings.claudeUnavailable')}
            status={envCheck?.claude.ok}
          />
        </div>
        <div className="flex items-center gap-2 mt-3">
          <FieldLabel>{t('settings.claudePath')}</FieldLabel>
          <div className="flex-1">
            <TextInput value={settings.claudePath} onChange={(v) => updateSetting('claudePath', v)} />
          </div>
        </div>
        <div className="flex items-center gap-2 mt-2">
          <input
            type="checkbox"
            id="autoDetect"
            checked={settings.autoDetectClaude}
            onChange={(e) => updateSetting('autoDetectClaude', e.target.checked)}
          />
          <label htmlFor="autoDetect" className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {t('settings.autoDetect')}
          </label>
        </div>
      </section>

      {/* Git Bash */}
      <section>
        <SectionTitle>{t('settings.claudeGitBash')}</SectionTitle>
        <SectionDesc>{t('settings.claudeGitBashDesc')}</SectionDesc>
        <div className="space-y-2">
          <InfoRow
            label="Path"
            value={envCheck?.gitBash.path || '—'}
            status={envCheck?.gitBash.ok}
          />
          <InfoRow
            label="Status"
            value={envCheck?.gitBash.configured ? t('settings.gitBashConfigured') : envCheck?.gitBash.ok ? t('settings.gitBashAutoDetected') : t('settings.gitBashNotFound')}
            status={envCheck?.gitBash.ok}
          />
        </div>
      </section>
    </div>
  );
}

// ============================================================
// Model & Connection Section
// ============================================================
function ModelConnectionSection({
  settings, updateSetting, connectionStatus, claudeTestResult, testing,
  onTestClaude, onRefresh, diagnostics, onLoadDiagnostics, onCopyDiagnostics,
  detectedModel,
}: {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  connectionStatus: ConnectionStatus | null;
  claudeTestResult: ClaudeTestResult | null;
  testing: boolean;
  onTestClaude: () => void;
  onRefresh: () => void;
  diagnostics: DiagnosticsInfo | null;
  onLoadDiagnostics: () => void;
  onCopyDiagnostics: () => void;
  detectedModel: string;
}) {
  return (
    <div className="space-y-6">
      {/* Model */}
      <section>
        <SectionTitle>{t('settings.defaultModel')}</SectionTitle>
        <div className="space-y-2 mb-3">
          <InfoRow label={t('settings.detectedModel')} value={detectedModel || t('model.pendingDetection')} />
          <InfoRow label={t('settings.modelSourceLabel')} value={t(`model.source.${settings.modelSource === 'claude-default' ? 'claudeDefault' : settings.modelSource}` as LocaleKey)} />
        </div>
        <FieldLabel>{t('settings.defaultModel')}</FieldLabel>
        <TextInput
          value={settings.defaultModel}
          onChange={(v) => updateSetting('defaultModel', v)}
          placeholder={t('model.customPlaceholder')}
        />
      </section>

      {/* Connection */}
      <section>
        <SectionTitle>{t('settings.connectionMethod')}</SectionTitle>
        <div className="space-y-2">
          <InfoRow label={t('settings.connectionMethod')} value={t('settings.connectionInherit')} />
          <InfoRow label={t('settings.baseUrl')} value={connectionStatus?.baseUrl || t('settings.baseUrlNotDetected')} status={connectionStatus?.baseUrlDetected} />
          <InfoRow label={t('settings.authToken')} value={connectionStatus?.authToken?.configured ? t('settings.configured') : t('settings.notConfigured')} status={connectionStatus?.authToken?.configured} />
          <InfoRow label={t('settings.apiKey')} value={connectionStatus?.apiKey?.configured ? t('settings.configured') : t('settings.notConfigured')} status={connectionStatus?.apiKey?.configured} />
          <InfoRow label={t('settings.loginStatus')} value={connectionStatus?.loginStatus === 'available' ? t('settings.loginAvailable') : t('settings.loginNotDetected')} status={connectionStatus?.loginStatus === 'available'} />
        </div>
        <div className="flex gap-2 mt-3">
          <button
            onClick={onRefresh}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors"
            style={{ color: 'var(--text-secondary)', backgroundColor: 'var(--bg-hover)' }}
          >
            <RefreshCw size={13} />
            {t('settings.recheckConnection')}
          </button>
          <button
            onClick={onTestClaude}
            disabled={testing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors"
            style={{ color: 'var(--text-secondary)', backgroundColor: 'var(--bg-hover)', opacity: testing ? 0.5 : 1 }}
          >
            <Play size={13} />
            {testing ? '...' : t('settings.testClaudeCode')}
          </button>
        </div>
      </section>

      {/* Test Result */}
      {claudeTestResult && (
        <section>
          <SectionTitle>{t('settings.cliTestResult')}</SectionTitle>
          <div className="space-y-1">
            <InfoRow label={t('settings.cliTestPath')} value={claudeTestResult.claudePath} />
            <InfoRow label={t('settings.cliTestVersion')} value={claudeTestResult.claudeVersion || '—'} />
            <InfoRow label={t('settings.cliTestModel')} value={claudeTestResult.detectedModel || '—'} />
            <InfoRow label={t('settings.cliTestBaseUrl')} value={claudeTestResult.baseUrlStatus} />
            <InfoRow
              label={t('settings.claudeStatus')}
              value={claudeTestResult.success ? t('settings.cliTestSuccess') : t('settings.cliTestFailed')}
              status={claudeTestResult.success}
            />
            <InfoRow label={t('settings.cliTestDuration')} value={`${claudeTestResult.durationMs}ms`} />
            {claudeTestResult.error && (
              <div className="text-xs mt-1 p-2 rounded" style={{ color: 'var(--error)', backgroundColor: 'var(--error-light, #fef2f2)' }}>
                {claudeTestResult.error}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Diagnostics */}
      <section>
        <SectionTitle>{t('diag.title')}</SectionTitle>
        {!diagnostics ? (
          <button
            onClick={onLoadDiagnostics}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors"
            style={{ color: 'var(--text-secondary)', backgroundColor: 'var(--bg-hover)' }}
          >
            {t('settings.openDiagnostics')}
          </button>
        ) : (
          <div>
            <div className="space-y-1 mb-2">
              <InfoRow label={t('diag.platform')} value={`${diagnostics.platform} ${diagnostics.arch}`} />
              <InfoRow label={t('diag.nodeVersion')} value={diagnostics.nodeVersion} />
              <InfoRow label={t('diag.electronVersion')} value={diagnostics.electronVersion} />
              <InfoRow label={t('diag.appVersion')} value={diagnostics.appVersion} />
              <InfoRow label={t('diag.claudePath')} value={diagnostics.claude.path || '—'} />
              <InfoRow label={t('diag.claudeVersion')} value={diagnostics.claude.version || '—'} />
              <InfoRow label={t('diag.hasBaseUrl')} value={diagnostics.environment.hasBaseUrl ? '✓' : '—'} />
              <InfoRow label={t('diag.hasAuthToken')} value={diagnostics.environment.hasAuthToken ? '✓' : '—'} />
              <InfoRow label={t('diag.hasApiKey')} value={diagnostics.environment.hasApiKey ? '✓' : '—'} />
            </div>
            <button
              onClick={onCopyDiagnostics}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors"
              style={{ color: 'var(--text-secondary)', backgroundColor: 'var(--bg-hover)' }}
            >
              <Copy size={13} />
              {t('common.copy')}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

// ============================================================
// Permissions Section
// ============================================================
function PermissionsSection({ settings, updateSetting }: {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}) {
  const visibleModes = PERMISSION_MODES.filter(
    (m) => settings.showDangerousPermissions || !m.dangerous,
  );

  return (
    <div className="space-y-6">
      <section>
        <SectionTitle>{t('settings.defaultPermission')}</SectionTitle>
        <div className="space-y-2">
          {visibleModes.map((mode) => (
            <button
              key={mode.uiValue}
              onClick={() => updateSetting('defaultPermissionMode', mode.uiValue)}
              className="w-full text-left px-3 py-2.5 rounded-lg text-xs transition-colors"
              style={{
                color: settings.defaultPermissionMode === mode.uiValue
                  ? mode.dangerous ? 'var(--error)' : 'var(--accent)'
                  : 'var(--text-primary)',
                backgroundColor: settings.defaultPermissionMode === mode.uiValue ? 'var(--accent-light)' : 'var(--bg-hover)',
                border: settings.defaultPermissionMode === mode.uiValue ? '1px solid var(--accent)' : '1px solid transparent',
              }}
            >
              <div className="font-medium">{t(mode.nameKey as LocaleKey)}</div>
              <div style={{ color: 'var(--text-tertiary)', marginTop: 2 }}>{t(mode.descKey as LocaleKey)}</div>
            </button>
          ))}
        </div>
      </section>

      <section>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="showDangerous"
            checked={settings.showDangerousPermissions}
            onChange={(e) => updateSetting('showDangerousPermissions', e.target.checked)}
          />
          <label htmlFor="showDangerous" className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {t('settings.showDangerousPermissions')}
          </label>
        </div>
        <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
          {t('settings.showDangerousPermissionsDesc')}
        </p>
      </section>
    </div>
  );
}

// ============================================================
// Terminal & Tools Section
// ============================================================
function TerminalToolsSection({ settings, updateSetting, envCheck, showGit = true }: {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  envCheck: EnvironmentCheckResult | null;
  showGit?: boolean;
}) {
  return (
    <div className="space-y-6">
      {/* Git */}
      {showGit ? <section>
        <SectionTitle>{t('settings.git')}</SectionTitle>
        <div className="space-y-2">
          <InfoRow label={t('settings.gitPath')} value={envCheck?.git.path || settings.gitPath} status={envCheck?.git.ok} />
          <InfoRow label={t('settings.claudeVersion')} value={envCheck?.git.version || '—'} />
          <InfoRow label={t('settings.claudeStatus')} value={envCheck?.git.ok ? t('settings.claudeAvailable') : t('settings.claudeUnavailable')} status={envCheck?.git.ok} />
        </div>
        <div className="mt-2">
          <FieldLabel>{t('settings.gitPath')}</FieldLabel>
          <TextInput value={settings.gitPath} onChange={(v) => updateSetting('gitPath', v)} />
        </div>
      </section> : null}

      {/* VS Code */}
      <section>
        <SectionTitle>{t('settings.vscode')}</SectionTitle>
        <div className="space-y-2">
          <InfoRow label={t('settings.vscodePath')} value={settings.vscodePath} />
        </div>
        <div className="mt-2">
          <FieldLabel>{t('settings.vscodePath')}</FieldLabel>
          <TextInput value={settings.vscodePath} onChange={(v) => updateSetting('vscodePath', v)} />
        </div>
      </section>

      {/* Terminal Shell */}
      <section>
        <SectionTitle>{t('settings.terminal')}</SectionTitle>
        <SectionDesc>{t('settings.terminalDesc')}</SectionDesc>
        <FieldLabel>{t('settings.defaultShell')}</FieldLabel>
        <select
          value={settings.terminalShell}
          onChange={(e) => updateSetting('terminalShell', e.target.value as AppSettings['terminalShell'])}
          className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
          style={{
            backgroundColor: 'var(--bg-input)',
            border: '1px solid var(--border-secondary)',
            color: 'var(--text-primary)',
          }}
        >
          <option value="powershell">PowerShell</option>
          <option value="powershell7">PowerShell 7</option>
          <option value="cmd">CMD</option>
          <option value="git-bash">Git Bash</option>
          <option value="wsl">WSL</option>
        </select>
      </section>
    </div>
  );
}

type GitSettingsState =
  | { kind: 'no_project' }
  | { kind: 'loading' }
  | { kind: 'not_repository' }
  | { kind: 'repository'; status: GitStatus }
  | { kind: 'error' };

function GitSection({ settings, envCheck, project, onOpenProject }: {
  settings: AppSettings;
  envCheck: EnvironmentCheckResult | null;
  project: Project | null;
  onOpenProject?: () => void;
}) {
  const requestRef = useRef(0);
  const [projectState, setProjectState] = useState<GitSettingsState>(
    project ? { kind: 'loading' } : { kind: 'no_project' },
  );

  useEffect(() => {
    const requestId = ++requestRef.current;
    if (!project) {
      setProjectState({ kind: 'no_project' });
      return undefined;
    }

    setProjectState({ kind: 'loading' });
    void window.api.getGitWorkspaceStatus(project.id, project.path)
      .then((status) => {
        if (requestId === requestRef.current) {
          setProjectState({ kind: 'repository', status });
        }
      })
      .catch((reason) => {
        if (requestId !== requestRef.current) return;
        const outcome = gitStatusOutcome({ status: 'rejected', reason });
        setProjectState(outcome.errorCode === 'NOT_A_REPOSITORY'
          ? { kind: 'not_repository' }
          : { kind: 'error' });
      });

    return () => {
      if (requestId === requestRef.current) requestRef.current += 1;
    };
  }, [project?.id, project?.path]);

  return (
    <div className="space-y-6">
      <section>
        <SectionTitle>{t('settings.git')}</SectionTitle>
        <SectionDesc>{t('settings.gitDescription')}</SectionDesc>
        <div className="space-y-2">
          <InfoRow label={t('settings.gitPath')} value={envCheck?.git.path || settings.gitPath || '—'} status={envCheck?.git.ok} />
          <InfoRow label={t('settings.claudeVersion')} value={envCheck?.git.version || '—'} />
          <InfoRow
            label={t('settings.gitStatus')}
            value={envCheck?.git.ok ? t('settings.claudeAvailable') : t('settings.claudeUnavailable')}
            status={envCheck?.git.ok}
          />
        </div>
      </section>

      <section>
        <SectionTitle>{t('settings.gitProjectTitle')}</SectionTitle>
        {projectState.kind === 'no_project' ? (
          <EmptyState
            icon={FolderOpen}
            title={t('settings.gitNoProjectTitle')}
            description={t('settings.gitNoProjectDescription')}
            action={onOpenProject ? { label: t('settings.openProject'), onClick: onOpenProject } : undefined}
            compact
          />
        ) : projectState.kind === 'loading' ? (
          <div className="flex items-center gap-2 rounded-lg border p-3 text-xs" role="status" style={{ borderColor: 'var(--border-secondary)', color: 'var(--text-tertiary)' }}>
            <RefreshCw size={13} className="animate-spin" aria-hidden="true" />
            {t('settings.gitLoading')}
          </div>
        ) : projectState.kind === 'not_repository' ? (
          <EmptyState
            icon={GitBranch}
            title={t('settings.gitNotRepository')}
            description={t('settings.gitNotRepositoryDescription')}
            compact
          />
        ) : projectState.kind === 'error' ? (
          <p role="alert" className="rounded-lg border px-3 py-2 text-xs" style={{ borderColor: 'var(--error)', color: 'var(--error)', backgroundColor: 'var(--error-bg)' }}>
            {t('settings.gitReadFailed')}
          </p>
        ) : (
          <div className="space-y-2 rounded-lg border p-3" data-testid="settings-git-repository" style={{ borderColor: 'var(--border-secondary)' }}>
            <p className="truncate text-xs font-medium" title={project?.name} style={{ color: 'var(--text-primary)' }}>{project?.name}</p>
            <InfoRow label={t('settings.gitStatus')} value={t('settings.gitRepository')} status />
            <InfoRow
              label={t('settings.gitBranch')}
              value={projectState.status.detached
                ? 'Detached HEAD'
                : projectState.status.branch ?? t('settings.gitNoCommits')}
            />
            <InfoRow label={t('settings.gitHead')} value={projectState.status.head ?? t('settings.gitNoCommits')} />
            <InfoRow
              label={t('settings.gitChanges')}
              value={projectState.status.clean
                ? t('settings.gitClean')
                : t('settings.gitDirty').replace('{count}', String(projectState.status.files.length))}
              status={projectState.status.clean}
            />
          </div>
        )}
      </section>
    </div>
  );
}

function ProjectIntegrationSection({
  kind,
  project,
  onOpenProject,
  onOpenIntegrations,
}: {
  kind: 'mcp' | 'skills';
  project: Project | null;
  onOpenProject?: () => void;
  onOpenIntegrations: (project: Project, initialTab: 'mcp' | 'skills') => void;
}) {
  const label = kind === 'mcp' ? t('settings.openMcp') : t('settings.openSkills');
  const Icon = kind === 'mcp' ? Plug : FileCode2;
  if (!project) {
    return (
      <EmptyState
        icon={FolderOpen}
        title={t('settings.projectIntegrationRequired')}
        description={t('settings.projectIntegrationDescription')}
        action={{ label: t('settings.openProject'), onClick: () => onOpenProject?.(), disabled: !onOpenProject }}
      />
    );
  }
  return (
    <EmptyState
      icon={Icon}
      title={kind === 'mcp' ? 'MCP' : 'Skills'}
      description={t('settings.projectIntegrationDescription')}
      action={{ label, onClick: () => onOpenIntegrations(project, kind) }}
    />
  );
}

// ============================================================
// Appearance Section
// ============================================================
function AppearanceSection({ settings, updateSetting }: {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}) {
  return (
    <div className="space-y-6">
      {/* Theme */}
      <section>
        <SectionTitle>{t('settings.theme')}</SectionTitle>
        <div className="flex gap-2">
          {(['system', 'light', 'dark'] as const).map((theme) => (
            <button
              key={theme}
              onClick={() => updateSetting('theme', theme)}
              className="px-4 py-2 rounded-lg text-xs transition-colors"
              style={{
                color: settings.theme === theme ? 'var(--accent)' : 'var(--text-secondary)',
                backgroundColor: settings.theme === theme ? 'var(--accent-light)' : 'var(--bg-hover)',
                border: settings.theme === theme ? '1px solid var(--accent)' : '1px solid transparent',
                fontWeight: settings.theme === theme ? 600 : 400,
              }}
            >
              {t(`settings.theme${theme.charAt(0).toUpperCase() + theme.slice(1)}` as LocaleKey)}
            </button>
          ))}
        </div>
      </section>

      {/* Font Size */}
      <section>
        <SectionTitle>{t('settings.fontSize')}</SectionTitle>
        <div className="flex items-center gap-3">
          <button
            onClick={() => updateSetting('fontSize', Math.max(12, settings.fontSize - 1))}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: 'var(--text-secondary)', backgroundColor: 'var(--bg-hover)' }}
            disabled={settings.fontSize <= 12}
          >
            <Minus size={14} />
          </button>
          <span className="text-sm font-medium w-8 text-center" style={{ color: 'var(--text-primary)' }}>
            {settings.fontSize}
          </span>
          <button
            onClick={() => updateSetting('fontSize', Math.min(20, settings.fontSize + 1))}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: 'var(--text-secondary)', backgroundColor: 'var(--bg-hover)' }}
            disabled={settings.fontSize >= 20}
          >
            <Plus size={14} />
          </button>
          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>px</span>
        </div>
      </section>
    </div>
  );
}

// ============================================================
// Data Section
// ============================================================
function DataSection({ settings }: { settings: AppSettings }) {
  const dataPath = settings.dataPath || t('settings.dataPathDefault');
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [includeAnonymousPerformanceData, setIncludeAnonymousPerformanceData] = useState(false);

  const exportDiagnostics = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const result = await window.api.exportDiagnostics({ includeAnonymousPerformanceData });
      setExportResult(result === true);
    } catch {
      setExportError(t('diag.exportFailed'));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <section>
        <SectionTitle>{t('settings.data')}</SectionTitle>
        <div className="space-y-3">
          <div>
            <FieldLabel>{t('settings.dataPath')}</FieldLabel>
            <div className="flex items-center gap-2">
              <div
                className="flex-1 rounded-lg px-3 py-2 text-sm"
                style={{
                  backgroundColor: 'var(--bg-tertiary)',
                  border: '1px solid var(--border-secondary)',
                  color: 'var(--text-disabled)',
                }}
              >
                {dataPath}
              </div>
              <button
                onClick={() => window.api.openPath(dataPath)}
                className="p-2 rounded-lg transition-colors"
                style={{ color: 'var(--text-secondary)', backgroundColor: 'var(--bg-hover)' }}
                title={t('settings.openDataDir')}
              >
                <ExternalLink size={14} />
              </button>
            </div>
          </div>
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.dataPathNote')}
          </p>
        </div>
      </section>

      <section>
        <SectionTitle>{t('diag.exportTitle')}</SectionTitle>
        <SectionDesc>{t('diag.exportDescription')}</SectionDesc>
        <p className="mb-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {t('diag.anonymousPrivacy')}
        </p>
        <label className="mb-3 flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
          <input
            type="checkbox"
            checked={includeAnonymousPerformanceData}
            onChange={(event) => setIncludeAnonymousPerformanceData(event.target.checked)}
            data-testid="data-anonymous-performance"
          />
          {t('diag.includeAnonymousPerformance')}
        </label>
        <button
          onClick={() => void exportDiagnostics()}
          disabled={exporting}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs"
          style={{ color: 'var(--text-secondary)', backgroundColor: 'var(--bg-hover)', opacity: exporting ? 0.5 : 1 }}
          data-testid="data-export-diagnostics"
        >
          <Download size={13} />
          {exporting ? t('diag.exporting') : t('diag.exportButton')}
        </button>
        {exportResult && <p className="mt-2 text-xs" style={{ color: 'var(--success)' }}>{t('diag.exported')}</p>}
        {exportError && <p role="alert" className="mt-2 text-xs" style={{ color: 'var(--error)' }}>{exportError}</p>}
      </section>

      <section>
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {t('settings.apiKeyNote')}
        </p>
      </section>
    </div>
  );
}

export function AboutSection({
  settings,
  updateSetting,
  releaseInfo,
  updateState,
  busy,
  error,
  onCheck,
  onDownload,
  onInstall,
  claudeVersion,
  onExportDiagnostics,
  diagnosticsBusy,
  diagnosticsError = '',
  releaseError = '',
}: {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  releaseInfo: ReleaseVersionInfo | null;
  updateState: UpdateSnapshot | null;
  busy: boolean;
  error: string;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
  claudeVersion: string | null;
  onExportDiagnostics: (includeAnonymousPerformanceData: boolean) => void;
  diagnosticsBusy: boolean;
  diagnosticsError?: string;
  releaseError?: string;
}) {
  const statusKey = `update.status.${updateState?.status ?? 'idle'}` as LocaleKey;
  const [includeAnonymousPerformanceData, setIncludeAnonymousPerformanceData] = useState(false);

  return (
    <div className="space-y-6" data-testid="release-about">
      <section>
        <SectionTitle>{t('about.title')}</SectionTitle>
        <div className="space-y-1 rounded-lg p-3" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
          <InfoRow label={t('about.version')} value={releaseInfo?.version ?? '—'} />
          <InfoRow label={t('about.buildId')} value={releaseInfo?.buildId ?? '—'} />
          <InfoRow label={t('about.commit')} value={releaseInfo?.commit ?? '—'} />
          <InfoRow label={t('about.electron')} value={releaseInfo?.electronVersion ?? '—'} />
          <InfoRow label={t('about.channel')} value={releaseInfo?.channel ?? '—'} />
          <InfoRow
            label={t('about.packagedState')}
            value={releaseInfo ? (releaseInfo.packaged ? t('about.packaged') : t('about.development')) : '—'}
          />
          <InfoRow label={t('about.claudeCode')} value={claudeVersion ?? '—'} />
        </div>
        {releaseError ? <p role="alert" className="mt-2 text-xs" style={{ color: 'var(--error)' }}>{releaseError}</p> : null}
      </section>

      <section>
        <SectionTitle>{t('update.title')}</SectionTitle>
        <label className="mb-3 flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
          <input
            type="checkbox"
            checked={settings.autoCheckUpdates ?? false}
            onChange={(event) => updateSetting('autoCheckUpdates', event.target.checked)}
            data-testid="auto-check-updates"
          />
          {t('update.autoCheck')}
        </label>
        <p className="mb-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {t('update.explicitOnly')}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCheck}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs disabled:opacity-50"
            style={{ backgroundColor: 'var(--bg-hover)', color: 'var(--text-secondary)' }}
            data-testid="check-for-updates"
          >
            <RefreshCw size={13} className={busy ? 'animate-spin' : ''} />
            {t('update.check')}
          </button>
          {updateState?.status === 'available' ? (
            <button type="button" onClick={onDownload} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-white disabled:opacity-50" style={{ backgroundColor: 'var(--accent)' }} data-testid="download-update">
              <Download size={13} />{t('update.download')}
            </button>
          ) : null}
          {updateState?.status === 'downloaded' ? (
            <button type="button" onClick={onInstall} disabled={busy} className="rounded-lg px-3 py-1.5 text-xs text-white disabled:opacity-50" style={{ backgroundColor: 'var(--accent)' }} data-testid="install-update">
              {t('update.install')}
            </button>
          ) : null}
        </div>
        <p className="mt-3 text-xs" data-testid="update-status" style={{ color: error ? 'var(--error)' : 'var(--text-tertiary)' }}>
          {error || t(statusKey)}{updateState?.version ? ` · ${updateState.version}` : ''}
        </p>
      </section>

      <section>
        <SectionTitle>{t('about.diagnostics')}</SectionTitle>
        <p className="mb-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('about.localPrivacy')}</p>
        <p className="mb-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('diag.anonymousPrivacy')}</p>
        <label className="mb-3 flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
          <input
            type="checkbox"
            checked={includeAnonymousPerformanceData}
            onChange={(event) => setIncludeAnonymousPerformanceData(event.target.checked)}
            data-testid="about-anonymous-performance"
          />
          {t('diag.includeAnonymousPerformance')}
        </label>
        <button
          type="button"
          onClick={() => onExportDiagnostics(includeAnonymousPerformanceData)}
          disabled={diagnosticsBusy}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs disabled:opacity-50"
          style={{ backgroundColor: 'var(--bg-hover)', color: 'var(--text-secondary)' }}
          data-testid="about-export-diagnostics"
        >
          <Download size={13} />{diagnosticsBusy ? t('diag.exporting') : t('diag.exportButton')}
        </button>
        {diagnosticsError ? <p role="alert" className="mt-2 text-xs" style={{ color: 'var(--error)' }}>{diagnosticsError}</p> : null}
      </section>

      <section>
        <SectionTitle>{t('about.license')}</SectionTitle>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg p-3" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('about.missingLicense')}</span>
          <button
            type="button"
            disabled
            data-testid="open-license"
            className="rounded-lg px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40"
            style={{ backgroundColor: 'var(--bg-hover)', color: 'var(--text-secondary)' }}
          >
            {t('about.openLicense')}
          </button>
        </div>
      </section>
    </div>
  );
}
