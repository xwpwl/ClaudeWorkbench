import type { TaskManager } from '../tasks/TaskManager';
import {
  ClaudeRuntimeBusyError,
  type ClaudeRuntimeMutationGate,
} from './ClaudeRuntimeMutationGate';

export function registerClaudeRuntimeTaskGuard(
  tasks: Pick<TaskManager, 'subscribeBeforeRuns'>,
  gate: ClaudeRuntimeMutationGate,
): () => void {
  return tasks.subscribeBeforeRuns(async () => {
    if (gate.isUpdateActive()) throw new ClaudeRuntimeBusyError();
  });
}
