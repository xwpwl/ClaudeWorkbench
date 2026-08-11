import type { ClaudeEventEnvelope } from '../../shared/types/claude';

export interface StandalonePermissionLifecycle {
  completeTask(identity: { taskId: string; projectPath: string }): void;
}

export async function finalizeStandalonePermissions(
  envelope: ClaudeEventEnvelope,
  waitForTerminalDependencies: () => void | Promise<void>,
  lifecycle: StandalonePermissionLifecycle,
): Promise<void> {
  const taskId = envelope.taskId?.trim();
  const projectId = envelope.projectId?.trim();
  const projectPath = envelope.projectPath?.trim();
  try {
    await waitForTerminalDependencies();
  } finally {
    if (!envelope.workflowId && projectId && taskId && projectPath) {
      lifecycle.completeTask({ taskId, projectPath });
    }
  }
}
