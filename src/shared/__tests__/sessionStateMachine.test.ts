import { describe, expect, it } from 'vitest';
import {
  canTransition,
  isBusy,
  isTerminal,
  transitionSessionStatus,
} from '../sessionStateMachine';

describe('sessionStateMachine', () => {
  it('allows loading history to become idle', () => {
    expect(canTransition('loading_history', 'idle')).toBe(true);
  });

  it('allows loading history to fail', () => {
    expect(canTransition('loading_history', 'failed')).toBe(true);
  });

  it('allows an idle session to start running', () => {
    expect(canTransition('idle', 'running')).toBe(true);
  });

  it('allows a completed session to run again', () => {
    expect(canTransition('completed', 'running')).toBe(true);
  });

  it('allows a failed session to run again', () => {
    expect(canTransition('failed', 'running')).toBe(true);
  });

  it('allows a cancelled session to run again', () => {
    expect(canTransition('cancelled', 'running')).toBe(true);
  });

  it('allows a running session to wait for permission', () => {
    expect(canTransition('running', 'waiting_permission')).toBe(true);
  });

  it('allows a permission-blocked session to resume running', () => {
    expect(canTransition('waiting_permission', 'running')).toBe(true);
  });

  it('allows a running session to enter every terminal state', () => {
    expect(canTransition('running', 'completed')).toBe(true);
    expect(canTransition('running', 'failed')).toBe(true);
    expect(canTransition('running', 'cancelled')).toBe(true);
  });

  it('allows a permission-blocked session to enter every terminal state', () => {
    expect(canTransition('waiting_permission', 'completed')).toBe(true);
    expect(canTransition('waiting_permission', 'failed')).toBe(true);
    expect(canTransition('waiting_permission', 'cancelled')).toBe(true);
  });

  it('rejects an illegal transition', () => {
    expect(canTransition('idle', 'completed')).toBe(false);
  });

  it('rejects implicit self-transitions', () => {
    expect(canTransition('running', 'running')).toBe(false);
  });

  it('preserves the current state for an illegal transition', () => {
    expect(transitionSessionStatus('idle', 'completed')).toBe('idle');
  });

  it('returns the destination state for a legal transition', () => {
    expect(transitionSessionStatus('running', 'completed')).toBe('completed');
  });

  it('identifies only completed, failed, and cancelled as terminal', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('idle')).toBe(false);
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('waiting_permission')).toBe(false);
    expect(isTerminal('loading_history')).toBe(false);
  });

  it('identifies loading, running, and permission waiting as busy', () => {
    expect(isBusy('loading_history')).toBe(true);
    expect(isBusy('running')).toBe(true);
    expect(isBusy('waiting_permission')).toBe(true);
    expect(isBusy('idle')).toBe(false);
    expect(isBusy('completed')).toBe(false);
    expect(isBusy('failed')).toBe(false);
    expect(isBusy('cancelled')).toBe(false);
  });
});
