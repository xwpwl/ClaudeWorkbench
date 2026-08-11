import React, { useId } from 'react';
import type { LucideIcon } from 'lucide-react';

interface EmptyStateAction {
  label: string;
  onClick(): void;
  disabled?: boolean;
}

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  compact?: boolean;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
  compact = false,
}: EmptyStateProps) {
  const titleId = useId();

  return (
    <section
      role="region"
      aria-labelledby={titleId}
      data-compact={compact ? 'true' : undefined}
      className={`flex min-w-0 max-w-full flex-col items-center overflow-hidden text-center ${compact ? 'gap-2 px-2 py-3' : 'gap-3 px-6 py-10'}`}
    >
      <span
        className={`flex shrink-0 items-center justify-center rounded-xl ${compact ? 'h-9 w-9' : 'h-12 w-12'}`}
        style={{ color: 'var(--accent)', background: 'var(--accent-light)' }}
      >
        <Icon size={compact ? 18 : 23} aria-hidden="true" focusable="false" />
      </span>
      <div className="min-w-0 max-w-md">
        <h3 id={titleId} className={`${compact ? 'text-xs' : 'text-sm'} break-words font-semibold`} style={{ color: 'var(--text-primary)' }}>
          {title}
        </h3>
        <p className="mt-1 break-words text-xs leading-5" style={{ color: 'var(--text-tertiary)' }}>
          {description}
        </p>
      </div>
      {action || secondaryAction ? (
        <div className="flex max-w-full flex-wrap items-center justify-center gap-2">
          {action ? (
            <button
              type="button"
              disabled={action.disabled}
              onClick={action.onClick}
              className="max-w-full rounded-lg px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40"
              style={{ color: 'var(--accent-text)', background: 'var(--accent)' }}
            >
              <span className="block truncate">{action.label}</span>
            </button>
          ) : null}
          {secondaryAction ? (
            <button
              type="button"
              disabled={secondaryAction.disabled}
              onClick={secondaryAction.onClick}
              className="max-w-full rounded-lg px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40"
              style={{ color: 'var(--text-secondary)', background: 'var(--bg-hover)' }}
            >
              <span className="block truncate">{secondaryAction.label}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
