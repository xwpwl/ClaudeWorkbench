import React, { useState, useEffect, useCallback } from 'react';
import {
  X,
  CheckCircle,
  XCircle,
  RefreshCw,
  ExternalLink,
  AlertTriangle,
} from 'lucide-react';
import { t } from '../../i18n';
import type { EnvironmentCheckResult } from '../../../shared/types/ipc';

interface EnvironmentCheckProps {
  onClose: () => void;
}

export interface EnvironmentStatusListProps {
  result: EnvironmentCheckResult;
  compact?: boolean;
  showInstallLinks?: boolean;
}

/** Shared, non-modal projection of the trusted environment check. */
export function EnvironmentStatusList({ result, compact = false, showInstallLinks = false }: EnvironmentStatusListProps) {
  const rows = [
    { key: 'node', label: t('env.node'), ok: result.node.ok, detail: result.node.version, installUrl: 'https://nodejs.org/' },
    { key: 'claude', label: t('env.claude'), ok: result.claude.ok, detail: result.claude.version, installUrl: 'https://docs.anthropic.com/en/docs/claude-code/overview' },
    { key: 'git', label: t('env.git'), ok: result.git.ok, detail: result.git.version, installUrl: 'https://git-scm.com/' },
    {
      key: 'git-bash',
      label: t('env.gitBash'),
      ok: result.gitBash.ok,
      detail: result.gitBash.configured
        ? t('settings.gitBashConfigured')
        : result.gitBash.ok
          ? t('settings.gitBashAutoDetected')
          : null,
      installUrl: null,
    },
    { key: 'shell', label: t('env.defaultShell'), ok: result.shell.ok, detail: result.shell.name, installUrl: null },
  ];

  return (
    <div className="space-y-2" data-testid="environment-status-list">
      {rows.map((row) => (
        <div
          key={row.key}
          className={`flex min-w-0 items-center justify-between gap-3 rounded-lg ${compact ? 'px-3 py-2' : 'p-3'}`}
          style={{ backgroundColor: 'var(--bg-tertiary)' }}
        >
          <div className="flex min-w-0 items-center gap-3">
            {row.ok ? (
              <CheckCircle size={18} aria-hidden="true" style={{ color: 'var(--success)', flexShrink: 0 }} />
            ) : (
              <XCircle size={18} aria-hidden="true" style={{ color: 'var(--warning)', flexShrink: 0 }} />
            )}
            <div className="min-w-0">
              <div className="truncate text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{row.label}</div>
              <div className="truncate text-xs" style={{ color: 'var(--text-tertiary)' }} title={row.detail ?? t('env.notFound')}>
                {row.detail ?? t('env.notFound')}
              </div>
            </div>
          </div>
          {!row.ok && showInstallLinks && row.installUrl ? (
            <a
              href={row.installUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex shrink-0 items-center gap-1 text-xs"
              style={{ color: 'var(--accent)' }}
            >
              {t('common.install')}<ExternalLink size={12} aria-hidden="true" />
            </a>
          ) : null}
          <span className="sr-only">{row.ok ? t('settings.claudeAvailable') : t('settings.claudeUnavailable')}</span>
        </div>
      ))}
    </div>
  );
}

export function EnvironmentCheck({ onClose }: EnvironmentCheckProps) {
  const [result, setResult] = useState<EnvironmentCheckResult | null>(null);
  const [loading, setLoading] = useState(true);

  const checkEnv = useCallback(async () => {
    setLoading(true);
    try {
      const r = await window.api.checkEnvironment();
      setResult(r);
    } catch (err) {
      console.error('Environment check failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkEnv();
  }, [checkEnv]);

  const allOk =
    result &&
    result.node.ok &&
    result.claude.ok &&
    result.git.ok &&
    result.gitBash.ok &&
    result.shell.ok;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in" style={{ backgroundColor: 'var(--bg-overlay)' }}>
      <div
        className="w-[480px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="environment-check-title"
        style={{
          backgroundColor: 'var(--bg-card)',
          border: '1px solid var(--border-primary)',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 flex-shrink-0" style={{ borderBottom: '1px solid var(--border-primary)' }}>
          <h2 id="environment-check-title" className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{t('env.title')}</h2>
          <button
            onClick={onClose}
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

        {/* Content */}
        <div className="p-4 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw size={24} className="animate-spin" style={{ color: 'var(--accent)' }} />
              <span className="ml-3 text-sm" style={{ color: 'var(--text-secondary)' }}>{t('env.checking')}</span>
            </div>
          ) : result ? (
            <>
              <div
                className="flex items-center gap-2 p-3 rounded-lg"
                style={{
                  backgroundColor: allOk ? 'rgba(22, 163, 74, 0.1)' : 'rgba(220, 38, 38, 0.1)',
                }}
              >
                {allOk ? (
                  <>
                    <CheckCircle size={18} style={{ color: 'var(--success)' }} />
                    <span className="text-sm" style={{ color: 'var(--success)' }}>{t('env.allPassed')}</span>
                  </>
                ) : (
                  <>
                    <AlertTriangle size={18} style={{ color: 'var(--warning)' }} />
                    <span className="text-sm" style={{ color: 'var(--warning)' }}>{t('env.someFailed')}</span>
                  </>
                )}
              </div>

              <EnvironmentStatusList result={result} showInstallLinks />

              <div className="text-xs space-y-1" style={{ color: 'var(--text-tertiary)' }}>
                <p>• {t('env.note1')}</p>
                <p>• {t('env.note2')}</p>
                <p>• {t('env.note3')}</p>
              </div>
            </>
          ) : (
            <div className="text-center py-8 text-sm" style={{ color: 'var(--text-tertiary)' }}>
              {t('env.failedCheck')}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end p-4 gap-2 flex-shrink-0" style={{ borderTop: '1px solid var(--border-primary)' }}>
          <button
            onClick={checkEnv}
            className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors"
            style={{ color: 'var(--text-secondary)', backgroundColor: 'var(--bg-hover)' }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-active)')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-hover)')}
          >
            <RefreshCw size={14} />
            {t('common.recheck')}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg transition-colors font-medium"
            style={{ color: 'var(--accent-text)', backgroundColor: 'var(--accent)' }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--accent-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'var(--accent)')}
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
