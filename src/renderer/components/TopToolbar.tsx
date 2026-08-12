import React, { useState, useRef, useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { t, type LocaleKey } from '../i18n';
import { PERMISSION_MODES } from '../../shared/types/claude';
import type {
  ProviderModelRef,
  ResolvedModelSelection,
} from '../../shared/types/modelProviders';
import type { TaskModelSwitchOptionPublic } from '../../shared/types/projectAi';
import { ModelQuickSwitcher } from '../features/models/ModelQuickSwitcher';
import {
  PanelLeft,
  FileText,
  Terminal,
  Settings,
  FolderOpen,
  ChevronDown,
  Cpu,
  Shield,
  Bot,
} from 'lucide-react';

export interface TopToolbarModelProviderState {
  selection: ResolvedModelSelection | null;
  options: TaskModelSwitchOptionPublic[];
  error: string | null;
  onSwitch(next: ProviderModelRef): Promise<void> | void;
  onClearOverride?(): Promise<void> | void;
}

interface TopToolbarProps {
  onOpenProject: () => void;
  modelProviderState?: TopToolbarModelProviderState | null;
  modelSwitchBlocked?: boolean;
}

export function TopToolbar({
  onOpenProject,
  modelProviderState,
  modelSwitchBlocked = false,
}: TopToolbarProps) {
  const {
    showSidebar,
    toggleSidebar,
    showTerminal,
    toggleTerminal,
    showFileDrawer,
    toggleFileDrawer,
    setShowSettings,
    currentModel,
    setCurrentModel,
    detectedModel,
    permissionMode,
    setPermissionMode,
    showDangerousPermissions,
    agentMode,
    setAgentMode,
    setCurrentProjectSettings,
  } = useAppStore();
  const currentProject = useWorkspaceStore((state) => state.currentProject);
  const sessionStatus = useWorkspaceStore((state) =>
    state.currentSessionKey
      ? state.runtimes[state.currentSessionKey]?.summary.status ?? 'idle'
      : 'idle',
  );
  const sessionModel = useWorkspaceStore((state) =>
    state.currentSessionKey
      ? state.runtimes[state.currentSessionKey]?.summary.model ?? null
      : null,
  );

  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showPermissionDropdown, setShowPermissionDropdown] = useState(false);
  const modelRef = useRef<HTMLDivElement>(null);
  const permissionRef = useRef<HTMLDivElement>(null);

  // Close dropdowns on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
      if (permissionRef.current && !permissionRef.current.contains(e.target as Node)) {
        setShowPermissionDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const getStatusText = () => {
    switch (sessionStatus) {
      case 'running':
        return t('chat.claudeWorking');
      case 'waiting_permission':
        return '等待你的授权';
      case 'loading_history':
        return '正在加载历史';
      case 'completed':
        return t('status.completed');
      case 'failed':
        return t('status.failed');
      case 'cancelled':
        return t('status.cancelled');
      default:
        return '';
    }
  };

  // Resolve display model name
  const effectiveDetectedModel = sessionModel || detectedModel;
  const displayModel = currentModel || effectiveDetectedModel || t('model.default');
  const modelLabel = currentModel
    ? currentModel
    : effectiveDetectedModel
      ? effectiveDetectedModel
      : t('model.followClaude');

  // Filter permission modes based on showDangerousPermissions
  const visiblePermissionModes = PERMISSION_MODES.filter(
    (m) => showDangerousPermissions || !m.dangerous,
  );

  // Get current permission mode info
  const currentPermInfo = PERMISSION_MODES.find((m) => m.uiValue === permissionMode);

  return (
    <div
      className="h-11 flex items-center px-3 gap-2 flex-shrink-0 select-none"
      style={{
        backgroundColor: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border-primary)',
      }}
    >
      {/* Left: sidebar toggle + project info */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={toggleSidebar}
          className="p-1.5 rounded-md transition-colors"
          style={{
            color: showSidebar ? 'var(--accent)' : 'var(--text-tertiary)',
            backgroundColor: showSidebar ? 'var(--accent-light)' : 'transparent',
          }}
          onMouseEnter={(e) => {
            if (!showSidebar) e.currentTarget.style.backgroundColor = 'var(--bg-hover)';
          }}
          onMouseLeave={(e) => {
            if (!showSidebar) e.currentTarget.style.backgroundColor = 'transparent';
          }}
          title={t('toolbar.project') + ' (Ctrl+B)'}
        >
          <PanelLeft size={16} />
        </button>

        {currentProject ? (
          <button
            onClick={onOpenProject}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-sm transition-colors"
            style={{ color: 'var(--text-primary)' }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            <FolderOpen size={14} style={{ color: 'var(--accent)' }} />
            <span className="font-medium">{currentProject.name}</span>
          </button>
        ) : (
          <button
            onClick={onOpenProject}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-sm transition-colors"
            style={{
              color: 'var(--accent)',
              backgroundColor: 'var(--accent-light)',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.8')}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
          >
            <FolderOpen size={14} />
            <span>{t('project.open')}</span>
          </button>
        )}
      </div>

      {/* Center: status */}
      <div className="flex-1 flex items-center justify-center min-w-0">
        {['running', 'waiting_permission', 'loading_history'].includes(sessionStatus) && (
          <div className="flex items-center gap-2 text-sm" style={{ color: sessionStatus === 'waiting_permission' ? 'var(--warning)' : 'var(--accent)' }}>
            <div className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: 'var(--accent)' }} />
            <span>{getStatusText()}</span>
          </div>
        )}
      </div>

      {/* Right: model + permission + action buttons */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <label className="flex items-center gap-1 rounded-md px-1.5 text-xs" style={{ color: 'var(--text-secondary)' }} title="应用层 Agent 策略，不绕过 Claude Code 权限">
          <Bot size={13} style={{ color: 'var(--accent)' }} />
          <span>模式</span>
          <select
            value={agentMode}
            onChange={(event) => {
              const next = event.target.value as 'normal' | 'plan' | 'develop' | 'review';
              setAgentMode(next);
              if (currentProject) {
                void window.api.setProjectSettings(currentProject.id, { agentMode: next })
                  .then(setCurrentProjectSettings)
                  .catch((error) => console.error('Unable to save Agent mode:', error));
              }
            }}
            className="rounded border bg-transparent px-1 py-0.5 text-xs focus:outline-none"
            style={{ borderColor: 'var(--border-secondary)', color: 'var(--text-primary)' }}
            aria-label="Agent 模式"
          >
            <option value="normal">普通</option>
            <option value="plan">规划</option>
            <option value="develop">开发</option>
            <option value="review">审查</option>
          </select>
        </label>

        {/* Model selector */}
        {modelProviderState ? (
          <div ref={modelRef}>
            <ModelQuickSwitcher
              selection={modelProviderState.selection}
              options={modelProviderState.options}
              error={modelProviderState.error}
              isTaskRunning={modelSwitchBlocked
                || ['running', 'waiting_permission', 'loading_history'].includes(sessionStatus)}
              open={showModelDropdown}
              onOpenChange={(open) => {
                setShowModelDropdown(open);
                if (open) setShowPermissionDropdown(false);
              }}
              onSwitch={modelProviderState.onSwitch}
              onClearOverride={modelProviderState.onClearOverride}
            />
          </div>
        ) : (
        <div ref={modelRef} className="relative">
          <button
            data-model-selector
            onClick={() => {
              setShowModelDropdown(!showModelDropdown);
              setShowPermissionDropdown(false);
            }}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors"
            style={{
              color: 'var(--text-secondary)',
              backgroundColor: showModelDropdown ? 'var(--bg-hover)' : 'transparent',
              minWidth: 130,
              maxWidth: 220,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-hover)')}
            onMouseLeave={(e) => {
              if (!showModelDropdown) e.currentTarget.style.backgroundColor = 'transparent';
            }}
            title={t('toolbar.currentModel') + ': ' + displayModel}
          >
            <Cpu size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />
            <span
              className="truncate"
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {modelLabel}
            </span>
            <ChevronDown size={12} style={{ flexShrink: 0 }} />
          </button>
          {showModelDropdown && (
            <div
              className="absolute right-0 mt-1 rounded-lg py-1 z-50 animate-fade-in"
              style={{
                backgroundColor: 'var(--bg-card)',
                border: '1px solid var(--border-primary)',
                boxShadow: 'var(--shadow-lg)',
                minWidth: 200,
                top: '100%',
              }}
            >
              {/* Follow Claude Code default */}
              <button
                onClick={() => {
                  setCurrentModel('');
                  setShowModelDropdown(false);
                }}
                className="w-full text-left px-3 py-2 text-xs transition-colors"
                style={{
                  color: currentModel === '' ? 'var(--accent)' : 'var(--text-primary)',
                  backgroundColor: currentModel === '' ? 'var(--accent-light)' : 'transparent',
                }}
                onMouseEnter={(e) => {
                  if (currentModel !== '') e.currentTarget.style.backgroundColor = 'var(--bg-hover)';
                }}
                onMouseLeave={(e) => {
                  if (currentModel !== '') e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                <div className="font-medium">{t('model.followClaude')}</div>
                {effectiveDetectedModel && (
                  <div style={{ color: 'var(--text-tertiary)', marginTop: 2 }}>
                    {effectiveDetectedModel}
                  </div>
                )}
              </button>

              <div className="h-px my-1" style={{ backgroundColor: 'var(--border-secondary)' }} />

              {/* Custom model input */}
              <div className="px-3 py-2">
                <div className="text-xs mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
                  {t('model.custom')}
                </div>
                <input
                  type="text"
                  value={currentModel}
                  onChange={(e) => setCurrentModel(e.target.value)}
                  placeholder={t('model.customPlaceholder')}
                  className="w-full rounded px-2 py-1 text-xs focus:outline-none"
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    border: '1px solid var(--border-secondary)',
                    color: 'var(--text-primary)',
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            </div>
          )}
        </div>
        )}

        {/* Permission mode selector */}
        <div ref={permissionRef} className="relative">
          <button
            data-permission-selector
            onClick={() => {
              setShowPermissionDropdown(!showPermissionDropdown);
              setShowModelDropdown(false);
            }}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors"
            style={{
              color: 'var(--text-secondary)',
              backgroundColor: showPermissionDropdown ? 'var(--bg-hover)' : 'transparent',
              minWidth: 100,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-hover)')}
            onMouseLeave={(e) => {
              if (!showPermissionDropdown) e.currentTarget.style.backgroundColor = 'transparent';
            }}
            title={t('toolbar.permissionMode') + ': ' + (currentPermInfo ? t(currentPermInfo.nameKey as LocaleKey) : permissionMode)}
          >
            <Shield size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {currentPermInfo ? t(currentPermInfo.nameKey as LocaleKey) : permissionMode}
            </span>
            <ChevronDown size={12} style={{ flexShrink: 0 }} />
          </button>
          {showPermissionDropdown && (
            <div
              className="absolute right-0 mt-1 rounded-lg py-1 z-50 animate-fade-in"
              style={{
                backgroundColor: 'var(--bg-card)',
                border: '1px solid var(--border-primary)',
                boxShadow: 'var(--shadow-lg)',
                minWidth: 180,
                top: '100%',
              }}
            >
              {visiblePermissionModes.map((mode) => (
                <button
                  key={mode.uiValue}
                  onClick={() => {
                    if (mode.dangerous) {
                      if (window.confirm(t('permission.dangerousWarning'))) {
                        setPermissionMode(mode.uiValue);
                      }
                    } else {
                      setPermissionMode(mode.uiValue);
                    }
                    setShowPermissionDropdown(false);
                  }}
                  className="w-full text-left px-3 py-2 text-xs transition-colors"
                  style={{
                    color: permissionMode === mode.uiValue
                      ? mode.dangerous ? 'var(--error)' : 'var(--accent)'
                      : 'var(--text-primary)',
                    backgroundColor: permissionMode === mode.uiValue ? 'var(--accent-light)' : 'transparent',
                  }}
                  onMouseEnter={(e) => {
                    if (permissionMode !== mode.uiValue) e.currentTarget.style.backgroundColor = 'var(--bg-hover)';
                  }}
                  onMouseLeave={(e) => {
                    if (permissionMode !== mode.uiValue) e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                >
                  <div className="font-medium">{t(mode.nameKey as LocaleKey)}</div>
                  <div style={{ color: 'var(--text-tertiary)', marginTop: 2 }}>
                    {t(mode.descKey as LocaleKey)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="w-px h-4 mx-0.5" style={{ backgroundColor: 'var(--border-primary)' }} />

        <button
          onClick={toggleFileDrawer}
          className="p-1.5 rounded-md transition-colors relative"
          style={{
            color: showFileDrawer ? 'var(--accent)' : 'var(--text-tertiary)',
            backgroundColor: showFileDrawer ? 'var(--accent-light)' : 'transparent',
          }}
          onMouseEnter={(e) => {
            if (!showFileDrawer) e.currentTarget.style.backgroundColor = 'var(--bg-hover)';
          }}
          onMouseLeave={(e) => {
            if (!showFileDrawer) e.currentTarget.style.backgroundColor = 'transparent';
          }}
          title={t('toolbar.files')}
        >
          <FileText size={16} />
        </button>

        <button
          onClick={toggleTerminal}
          className="p-1.5 rounded-md transition-colors"
          style={{
            color: showTerminal ? 'var(--accent)' : 'var(--text-tertiary)',
            backgroundColor: showTerminal ? 'var(--accent-light)' : 'transparent',
          }}
          onMouseEnter={(e) => {
            if (!showTerminal) e.currentTarget.style.backgroundColor = 'var(--bg-hover)';
          }}
          onMouseLeave={(e) => {
            if (!showTerminal) e.currentTarget.style.backgroundColor = 'transparent';
          }}
          title={t('toolbar.terminal') + ' (Ctrl+J)'}
        >
          <Terminal size={16} />
        </button>

        <div className="w-px h-4 mx-0.5" style={{ backgroundColor: 'var(--border-primary)' }} />

        <button
          onClick={() => setShowSettings(true)}
          className="p-1.5 rounded-md transition-colors"
          style={{ color: 'var(--text-tertiary)' }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-hover)')}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
          title={t('toolbar.settings') + ' (Ctrl+,)'}
        >
          <Settings size={16} />
        </button>
      </div>
    </div>
  );
}
