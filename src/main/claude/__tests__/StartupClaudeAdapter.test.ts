import { describe, expect, it, vi } from 'vitest';
import type {
  ClaudeAdapter,
  ClaudeEventEnvelope,
  ClaudeRunOptions,
} from '../../../shared/types/claude';
import * as claudeCliAdapterModule from '../ClaudeCliAdapter';

type SelectStartupClaudeAdapter = (input: {
  forceFake: boolean;
  realAdapter: ClaudeAdapter;
  createFakeAdapter(): ClaudeAdapter;
}) => Promise<ClaudeAdapter>;

function adapterDouble(installed: boolean): ClaudeAdapter {
  return {
    checkInstallation: vi.fn(async () => ({
      installed,
      path: installed ? 'claude' : null,
      version: installed ? '2.1.218' : null,
    })),
    runPrompt: vi.fn(async (options: ClaudeRunOptions) => ({ runId: options.runId, pid: 123 })),
    stopRun: vi.fn(async () => true),
    stopAll: vi.fn(async () => undefined),
    subscribe: vi.fn((_listener: (event: ClaudeEventEnvelope) => void) => () => undefined),
  };
}

describe('startup Claude adapter selection', () => {
  it('keeps the real Claude CLI adapter when installation preflight reports unavailable', async () => {
    const selectStartupClaudeAdapter = (
      claudeCliAdapterModule as unknown as {
        selectStartupClaudeAdapter?: SelectStartupClaudeAdapter;
      }
    ).selectStartupClaudeAdapter;
    expect(selectStartupClaudeAdapter).toBeTypeOf('function');
    const realAdapter = adapterDouble(false);

    const selected = await selectStartupClaudeAdapter!({
      forceFake: false,
      realAdapter,
      createFakeAdapter: () => adapterDouble(true),
    });

    expect(selected).toBe(realAdapter);
  });

  it('uses the deterministic adapter only when the explicit test override is enabled', async () => {
    const selectStartupClaudeAdapter = (
      claudeCliAdapterModule as unknown as {
        selectStartupClaudeAdapter?: SelectStartupClaudeAdapter;
      }
    ).selectStartupClaudeAdapter;
    expect(selectStartupClaudeAdapter).toBeTypeOf('function');
    const realAdapter = adapterDouble(true);
    const fakeAdapter = adapterDouble(true);
    const createFakeAdapter = vi.fn(() => fakeAdapter);

    const selected = await selectStartupClaudeAdapter!({
      forceFake: true,
      realAdapter,
      createFakeAdapter,
    });

    expect(selected).toBe(fakeAdapter);
    expect(createFakeAdapter).toHaveBeenCalledOnce();
    expect(realAdapter.checkInstallation).not.toHaveBeenCalled();
  });
});
