import React, { useCallback, useEffect, useId, useRef } from 'react';
import { ChevronDown, Cpu, LockKeyhole } from 'lucide-react';
import {
  type ModelSelectionSource,
  type ProviderModelRef,
  type ResolvedModelSelection,
} from '../../../shared/types/modelProviders';
import type { TaskModelSwitchOptionPublic } from '../../../shared/types/projectAi';
import {
  capabilityPresentations,
  runtimeTypeLabel,
} from '../settings/modelProviderPresentation';
import { t, type LocaleKey } from '../../i18n';

const SOURCE_LABEL_KEYS: Readonly<Record<ModelSelectionSource, LocaleKey>> = {
  task_override: 'model.switch.source.taskOverride',
  project_policy: 'model.switch.source.projectPolicy',
  global_agent_policy: 'model.switch.source.globalAgentPolicy',
  global_default: 'model.switch.source.globalDefault',
  environment: 'model.switch.source.environment',
  claude_code: 'model.switch.source.claudeCode',
};

function sourceLabel(source: ModelSelectionSource): string {
  return t(SOURCE_LABEL_KEYS[source]);
}

export async function confirmFutureModelSwitch(
  next: ProviderModelRef,
  isTaskRunning: boolean,
  confirm: (message: string) => boolean,
  switchModel: (next: ProviderModelRef) => Promise<void>,
): Promise<boolean> {
  if (isTaskRunning) return false;
  if (!confirm(t('model.switch.confirm'))) return false;
  await switchModel(next);
  return true;
}

export async function confirmFutureModelReset(
  isTaskRunning: boolean,
  confirm: (message: string) => boolean,
  clearOverride: () => Promise<void>,
): Promise<boolean> {
  if (isTaskRunning) return false;
  if (!confirm(t('model.switch.confirm'))) return false;
  await clearOverride();
  return true;
}

export interface ModelQuickSwitcherProps {
  selection: ResolvedModelSelection | null;
  options: TaskModelSwitchOptionPublic[];
  isTaskRunning: boolean;
  error?: string | null;
  open: boolean;
  placement?: 'up' | 'down';
  onOpenChange(open: boolean): void;
  onSwitch(next: ProviderModelRef): Promise<void> | void;
  onClearOverride?(): Promise<void> | void;
  confirmSwitch?: (message: string) => boolean;
}

export function ModelQuickSwitcher({
  selection,
  options,
  isTaskRunning,
  error = null,
  open,
  placement = 'down',
  onOpenChange,
  onSwitch,
  onClearOverride,
  confirmSwitch,
}: ModelQuickSwitcherProps) {
  const capabilities = selection?.capabilities ?? null;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const requestConfirmation = confirmSwitch ?? ((message: string) => (
    typeof window !== 'undefined' ? window.confirm(message) : false
  ));
  const label = selection
    ? `${selection.providerName} / ${selection.modelId}`
    : `Claude Code / ${t('model.switch.defaultModel')}`;
  const closeAndFocus = useCallback(() => {
    onOpenChange(false);
    queueMicrotask(() => triggerRef.current?.focus());
  }, [onOpenChange]);
  const selectOption = (option: TaskModelSwitchOptionPublic) => {
    if (isTaskRunning) return;
    if (option.providerId === selection?.providerId && option.modelId === selection.modelId) return;
    void confirmFutureModelSwitch(
      { providerId: option.providerId, modelId: option.modelId },
      false,
      requestConfirmation,
      async (next) => { await onSwitch(next); },
    ).then((changed) => {
      if (changed) closeAndFocus();
    }).catch(() => undefined);
  };

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event: MouseEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) closeAndFocus();
    };
    document.addEventListener('mousedown', closeOutside);
    return () => document.removeEventListener('mousedown', closeOutside);
  }, [closeAndFocus, open]);

  const focusOption = (index: number) => {
    if (options.length === 0 || isTaskRunning) return;
    const normalized = (index + options.length) % options.length;
    optionRefs.current[normalized]?.focus();
  };
  const selectedOptionIndex = options.findIndex((option) => (
    option.providerId === selection?.providerId && option.modelId === selection.modelId
  ));

  return (
    <div ref={rootRef} className="relative" data-testid="model-quick-switcher">
      <button
        ref={triggerRef}
        type="button"
        data-model-selector
        aria-disabled={isTaskRunning}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open && options.length > 0 ? listboxId : undefined}
        aria-label={label}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) onOpenChange(true);
            const initialIndex = selectedOptionIndex >= 0
              ? selectedOptionIndex
              : event.key === 'ArrowDown' ? 0 : options.length - 1;
            queueMicrotask(() => focusOption(initialIndex));
          } else if (event.key === 'Escape' && open) {
            event.preventDefault();
            closeAndFocus();
          }
        }}
        className="flex min-w-0 max-w-[260px] items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors"
        style={{ color: 'var(--text-secondary)', backgroundColor: open ? 'var(--bg-hover)' : 'transparent' }}
        title={`${t('model.switch.currentModel')}: ${label}`}
      >
        <Cpu size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />
        <span className="min-w-0 truncate">{selection?.providerName ?? 'Claude Code'}</span>
        <span style={{ color: 'var(--text-tertiary)' }}>/</span>
        <span className="min-w-0 truncate">{selection?.modelId ?? t('model.switch.defaultModel')}</span>
        <ChevronDown size={12} className="shrink-0" />
      </button>

      {open ? (
        <div
          className={`absolute right-0 z-50 w-[min(330px,calc(100vw-16px))] max-w-[calc(100vw-16px)] overflow-hidden rounded-xl border shadow-lg ${placement === 'up' ? 'mb-1' : 'mt-1'}`}
          style={{
            background: 'var(--bg-card)',
            borderColor: 'var(--border-primary)',
            ...(placement === 'up' ? { bottom: '100%' } : { top: '100%' }),
          }}
          data-testid="model-quick-switcher-panel"
          data-narrow-safe="true"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              closeAndFocus();
            }
          }}
        >
          <div className="space-y-2 border-b p-3 text-xs" style={{ borderColor: 'var(--border-primary)' }}>
            <div className="grid grid-cols-[72px_1fr] gap-x-2 gap-y-1">
              <span style={{ color: 'var(--text-tertiary)' }}>{t('model.switch.provider')}</span>
              <strong>{selection?.providerName ?? 'Claude Code'}</strong>
              <span style={{ color: 'var(--text-tertiary)' }}>{t('model.switch.runtime')}</span>
              <span>{runtimeTypeLabel(selection?.runtimeType ?? 'claude-code')}</span>
              <span style={{ color: 'var(--text-tertiary)' }}>{t('model.switch.source')}</span>
              <span>{sourceLabel(selection?.source ?? 'claude_code')}</span>
            </div>
            {capabilities ? (
              <div className="grid grid-cols-[72px_1fr] gap-x-2 pt-1">
                <span style={{ color: 'var(--text-tertiary)' }}>{t('model.switch.capabilities')}</span>
                <div className="flex flex-wrap gap-1">
                  {capabilityPresentations(capabilities)
                    .filter((capability) => capability.supported)
                    .map((capability) => (
                      <span key={capability.key} className="rounded-full px-1.5 py-0.5 text-[10px]" style={{ color: 'var(--accent)', background: 'var(--accent-light)' }}>
                        {capability.label}
                      </span>
                    ))}
                </div>
              </div>
            ) : null}
          </div>

          {isTaskRunning ? (
            <div role="alert" className="flex items-center gap-2 border-b px-3 py-2 text-xs" style={{ color: 'var(--warning)', borderColor: 'var(--border-primary)' }}>
              <LockKeyhole size={13} />{t('model.switch.active')}
              {error ? <span>{error}</span> : null}
            </div>
          ) : error ? (
            <div role="alert" className="flex items-center gap-2 border-b px-3 py-2 text-xs" style={{ color: 'var(--error)', borderColor: 'var(--border-primary)' }}>
              <LockKeyhole size={13} />{error}
            </div>
          ) : (
            <p className="border-b px-3 py-2 text-[11px]" style={{ color: 'var(--text-tertiary)', borderColor: 'var(--border-primary)' }}>
              {t('model.switch.futureOnly')}
            </p>
          )}

          {selection?.source === 'task_override' && onClearOverride ? (
              <button
                type="button"
                data-testid="follow-model-policy"
                disabled={isTaskRunning}
                onClick={() => {
                  void confirmFutureModelReset(
                    isTaskRunning,
                    requestConfirmation,
                    async () => { await onClearOverride(); },
                  ).then((changed) => {
                    if (changed) closeAndFocus();
                  }).catch(() => undefined);
                }}
                className="w-full border-b px-3 py-2 text-left text-xs disabled:opacity-50"
                style={{ color: 'var(--accent)', borderColor: 'var(--border-primary)' }}
              >
                {t('model.switch.restorePolicy')}
              </button>
          ) : null}
          {options.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('model.switch.empty')}</p>
          ) : (
            <div
              id={listboxId}
              role="listbox"
              aria-label={t('model.switch.options')}
              className="max-h-64 overflow-y-auto py-1"
            >
              {options.map((option, index) => {
              const selected = option.providerId === selection?.providerId && option.modelId === selection.modelId;
              return (
                <button
                  ref={(node) => { optionRefs.current[index] = node; }}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-label={`${option.providerName} / ${option.modelId}`}
                  key={`${option.providerId}:${option.modelId}`}
                  data-testid="model-switch-option"
                  disabled={isTaskRunning}
                  onClick={() => selectOption(option)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      focusOption(index + 1);
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      focusOption(index - 1);
                    } else if (event.key === 'Home') {
                      event.preventDefault();
                      focusOption(0);
                    } else if (event.key === 'End') {
                      event.preventDefault();
                      focusOption(options.length - 1);
                    } else if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      selectOption(option);
                    }
                  }}
                  className="w-full min-w-0 px-3 py-2 text-left text-xs disabled:opacity-50"
                  style={{ color: selected ? 'var(--accent)' : 'var(--text-primary)', background: selected ? 'var(--accent-light)' : 'transparent' }}
                >
                  <span
                    className="block min-w-0 truncate"
                    title={`${option.providerName} / ${option.modelId}`}
                  >
                    <span className="font-medium">{option.providerName}</span>
                    <span style={{ color: 'var(--text-tertiary)' }}> / {option.modelId}</span>
                  </span>
                </button>
              );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
