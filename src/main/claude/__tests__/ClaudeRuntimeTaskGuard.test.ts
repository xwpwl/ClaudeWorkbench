import { describe, expect, it, vi } from 'vitest';
import type {
  ClaudeAdapter,
  ClaudeEventEnvelope,
  ClaudeRunOptions,
} from '../../../shared/types/claude';
import { TaskManager } from '../../tasks/TaskManager';
import { ClaudeRuntimeMutationGate } from '../ClaudeRuntimeMutationGate';
import { registerClaudeRuntimeTaskGuard } from '../ClaudeRuntimeTaskGuard';

function runOptions(): ClaudeRunOptions {
  return {
    runId: 'run-1',
    projectId: 'project-a',
    taskId: 'task-1',
    projectKey: 'C:\\project-a',
    sessionKey: 'C:\\project-a::session-1',
    projectPath: 'C:\\project-a',
    prompt: 'test',
    permissionMode: 'default',
  };
}

class AdapterStub implements ClaudeAdapter {
  runPrompt = vi.fn(async (options: ClaudeRunOptions) => ({
    runId: options.runId,
    pid: 10,
  }));
  stopRun = vi.fn(async () => true);
  stopAll = vi.fn(async () => undefined);
  checkInstallation = vi.fn(async () => ({
    installed: true,
    path: 'claude',
    version: '2.1.218',
  }));

  subscribe(_listener: (envelope: ClaudeEventEnvelope) => void): () => void {
    return () => undefined;
  }
}

function taskManagerHarness(): {
  adapter: AdapterStub;
  tasks: TaskManager;
} {
  const adapter = new AdapterStub();
  return {
    adapter,
    tasks: new TaskManager(adapter),
  };
}

describe('registerClaudeRuntimeTaskGuard', () => {
  it('rejects before adapter execution while an update is active', async () => {
    const gate = new ClaudeRuntimeMutationGate();
    const lease = gate.tryAcquireUpdate();
    const test = taskManagerHarness();
    const unsubscribe = registerClaudeRuntimeTaskGuard(test.tasks, gate);

    try {
      await expect(test.tasks.runPrompt(runOptions())).rejects.toMatchObject({
        code: 'CLAUDE_RUNTIME_BUSY',
      });
      expect(test.adapter.runPrompt).not.toHaveBeenCalled();
      expect(test.tasks.getActiveTasks()).toEqual([]);
    } finally {
      unsubscribe();
      lease?.release();
      test.tasks.dispose();
    }
  });

  it('removes only its before-run guard when unsubscribed', async () => {
    const gate = new ClaudeRuntimeMutationGate();
    const lease = gate.tryAcquireUpdate();
    const test = taskManagerHarness();
    const unsubscribe = registerClaudeRuntimeTaskGuard(test.tasks, gate);
    unsubscribe();

    try {
      await expect(test.tasks.runPrompt(runOptions())).resolves.toMatchObject({
        runId: 'run-1',
      });
      expect(test.adapter.runPrompt).toHaveBeenCalledOnce();
    } finally {
      lease?.release();
      test.tasks.dispose();
    }
  });
});
