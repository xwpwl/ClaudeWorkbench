import { describe, expect, it, vi } from 'vitest';
import type { ClaudeEventEnvelope } from '../../../shared/types/claude';
import { finalizeStandalonePermissions } from '../StandalonePermissionLifecycle';

function terminal(patch: Partial<ClaudeEventEnvelope> = {}): ClaudeEventEnvelope {
  return {
    runId: 'run-1',
    projectId: 'project-1',
    projectKey: 'project-key',
    projectPath: 'C:\\project',
    sessionKey: 'project-key::session-1',
    taskId: 'task-1',
    event: {
      type: 'session_completed',
      sessionId: 'claude-session',
      duration: 20,
      timestamp: 1,
    },
    ...patch,
  };
}

describe('finalizeStandalonePermissions', () => {
  it('clears the exact trusted standalone task context after terminal dependencies settle', async () => {
    const order: string[] = [];
    const completeTask = vi.fn(() => { order.push('permissions'); });

    await finalizeStandalonePermissions(
      terminal(),
      async () => { order.push('checkpoint'); },
      { completeTask },
    );

    expect(order).toEqual(['checkpoint', 'permissions']);
    expect(completeTask).toHaveBeenCalledWith({
      taskId: 'task-1',
      projectPath: 'C:\\project',
    });
  });

  it('still clears the exact task context when another terminal dependency fails', async () => {
    const completeTask = vi.fn();

    await expect(finalizeStandalonePermissions(
      terminal(),
      async () => { throw new Error('checkpoint finalization failed'); },
      { completeTask },
    )).rejects.toThrow('checkpoint finalization failed');

    expect(completeTask).toHaveBeenCalledWith({
      taskId: 'task-1',
      projectPath: 'C:\\project',
    });
  });

  it('does not mis-clean a workflow or an envelope missing trusted project identity', async () => {
    const completeTask = vi.fn();

    await finalizeStandalonePermissions(
      terminal({ workflowId: 'workflow-1' }),
      async () => undefined,
      { completeTask },
    );
    await finalizeStandalonePermissions(
      terminal({ projectId: undefined }),
      async () => undefined,
      { completeTask },
    );

    expect(completeTask).not.toHaveBeenCalled();
  });
});
