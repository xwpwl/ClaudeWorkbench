import type { SessionStatus } from './types/session';

const ALLOWED_TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  idle: ['running'],
  loading_history: ['idle', 'failed'],
  running: ['waiting_permission', 'completed', 'failed', 'cancelled'],
  waiting_permission: ['running', 'completed', 'failed', 'cancelled'],
  completed: ['running'],
  failed: ['running'],
  cancelled: ['running'],
};

const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

const BUSY_STATUSES: ReadonlySet<SessionStatus> = new Set([
  'loading_history',
  'running',
  'waiting_permission',
]);

/** Returns whether the requested state transition is explicitly allowed. */
export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Applies a legal transition, or preserves the current state when it is illegal. */
export function transitionSessionStatus(
  current: SessionStatus,
  next: SessionStatus,
): SessionStatus {
  return canTransition(current, next) ? next : current;
}

/** Returns whether the status represents a finished session. */
export function isTerminal(status: SessionStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Returns whether the status represents work or history loading in progress. */
export function isBusy(status: SessionStatus): boolean {
  return BUSY_STATUSES.has(status);
}
