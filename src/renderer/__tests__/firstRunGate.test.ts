import { describe, expect, it, vi } from 'vitest';
import {
  loadFirstRunGate,
  shouldShowLegacyEnvironmentCheck,
} from '../firstRunGate';

describe('App first-run completion gate', () => {
  it.each([0, -1])('shows the mandatory wizard for completion version %s', async (version) => {
    const read = vi.fn(async () => version);
    await expect(loadFirstRunGate(read)).resolves.toBe('required');
    expect(read).toHaveBeenCalledOnce();
  });

  it.each([1, 2, 99])('skips the wizard for completion version %s', async (version) => {
    await expect(loadFirstRunGate(async () => version)).resolves.toBe('done');
  });

  it('fails closed when completion state cannot be read', async () => {
    await expect(loadFirstRunGate(async () => { throw new Error('private database path'); }))
      .resolves.toBe('read_failed');
  });

  it('suppresses the legacy environment modal while the first-run gate owns focus', () => {
    expect(shouldShowLegacyEnvironmentCheck(false, 'required')).toBe(false);
    expect(shouldShowLegacyEnvironmentCheck(false, 'read_failed')).toBe(false);
    expect(shouldShowLegacyEnvironmentCheck(false, 'done')).toBe(true);
    expect(shouldShowLegacyEnvironmentCheck(true, 'done')).toBe(false);
  });
});
