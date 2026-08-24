import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');

function occurrences(pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

function sourceBetween(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

function expectOrder(text: string, markers: readonly string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const current = text.indexOf(marker);
    expect(current, `missing source marker: ${marker}`).toBeGreaterThan(previous);
    previous = current;
  }
}

describe('main Claude runtime composition', () => {
  it('shares exactly one resolver and gate with the adapter, system IPC, and update manager', () => {
    expect(occurrences(/new ClaudeInvocationResolver\s*\(/gu)).toBe(1);
    expect(occurrences(/new ClaudeRuntimeMutationGate\s*\(/gu)).toBe(1);

    const adapter = sourceBetween(
      'const realAdapter = new ClaudeCliAdapter({',
      'const baseAdapter:',
    );
    expect(adapter).toContain('invocationResolver: claudeInvocationResolver');
    expect(adapter).toContain('runtimeGate: claudeRuntimeGate');

    const manager = sourceBetween(
      'claudeCodeUpdateManager = new ClaudeCodeUpdateManager({',
      'checkpointManager = new CheckpointManager(',
    );
    expect(manager).toContain('resolver: claudeInvocationResolver');
    expect(manager).toContain('runtimeGate: claudeRuntimeGate');

    const system = sourceBetween(
      'registerSystemIPC(publicIpcMain, {',
      'registerFileChangesIPC(',
    );
    expect(system).toContain('resolver: claudeInvocationResolver');
    expect(system).toContain('gate: claudeRuntimeGate');
  });

  it('captures fake mode and installs the task guard before checkpoint preflight', () => {
    expect(occurrences(/const forceFake\s*=\s*process\.env\.FORCE_FAKE === '1'/gu)).toBe(1);
    expect(source).toContain('forceFake,\n    realAdapter');

    expectOrder(source, [
      'taskManager = new TaskManager(',
      'registerClaudeRuntimeTaskGuard(taskManager, claudeRuntimeGate)',
      'new SupervisedClaudeUpdateCommandRunner(processSupervisor, process.env)',
      'claudeCodeUpdateManager = new ClaudeCodeUpdateManager({',
      'isFakeRuntime: () => forceFake',
      'unsubscribeCheckpointStarts = taskManager.subscribeBeforeRuns(',
    ]);
  });

  it('registers trusted update IPC and owns its disposer before generic IPC removal', () => {
    expectOrder(source, [
      'const trustedRenderer = {',
      'disposeClaudeUpdatesIPC = registerClaudeUpdatesIPC(publicIpcMain, {',
    ]);
    const registration = sourceBetween(
      'disposeClaudeUpdatesIPC = registerClaudeUpdatesIPC(publicIpcMain, {',
      'registerProjectIPC(',
    );
    expect(registration).toContain('updates: claudeCodeUpdateManager');
    expect(registration).toContain('...trustedRenderer');

    const stopAcceptingWork = sourceBetween(
      'stopAcceptingWork: () => {',
      'closePermissions:',
    );
    expectOrder(stopAcceptingWork, [
      'disposeClaudeUpdatesIPC?.()',
      'for (const channel of Object.values(IPC_CHANNELS))',
    ]);
  });

  it('keeps the update guard installed through manager disposal and retains process cleanup', () => {
    const stopTasks = sourceBetween(
      'stopTasks: async () => {',
      'stopTerminals:',
    );
    expectOrder(stopTasks, [
      'await taskManager?.stopAll()',
      'await claudeCodeUpdateManager?.dispose()',
      'unsubscribeClaudeRuntimeTaskGuard?.()',
      'taskManager?.dispose()',
    ]);
    expect(source).toContain('await processSupervisor?.terminateAll()');
  });

  it('keeps legacy and automatic Claude update paths unreachable', () => {
    expect(source).not.toMatch(/EnvironmentChecker/gu);
    expect(source).not.toMatch(/claudeCodeUpdateManager(?:\?|)\.updateNow\s*\(/gu);
  });
});
