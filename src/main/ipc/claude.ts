import type { ClaudeAdapter, ClaudeRunOptions } from '../../shared/types/claude';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { canonicalProjectKey } from '../../shared/sessionIdentity';
import type { AppDatabase } from '../database/Database';
import { getMainWindow } from '../index';
import { canonicalizeProjectPath } from '../projects/ProjectService';
import type { PublicIpcRegistrar } from './public-invoke-boundary';

interface ClaudeIPCDependencies {
  database: Pick<AppDatabase, 'getProject' | 'getSession' | 'getTask'>;
  beforeRun?: (options: ClaudeRunOptions) => Promise<void>;
  resolveDisallowedTools?: (projectId: string) => readonly string[];
  resolveRunOptions?: (options: ClaudeRunOptions) => ClaudeRunOptions | Promise<ClaudeRunOptions>;
}

function validatedRunOptions(
  options: ClaudeRunOptions,
  database: ClaudeIPCDependencies['database'],
  resolveDisallowedTools?: ClaudeIPCDependencies['resolveDisallowedTools'],
): ClaudeRunOptions {
  const separator = options.sessionKey.lastIndexOf('::');
  if (separator <= 0 || separator === options.sessionKey.length - 2) {
    throw new Error('Invalid sessionKey');
  }
  const sessionId = options.sessionKey.slice(separator + 2);
  const claimedSessionProject = options.sessionKey.slice(0, separator);
  const session = database.getSession(sessionId);
  const project = session ? database.getProject(session.project_id) : null;
  if (!session || !project) throw new Error('Session project is not registered in Workbench.');
  const task = database.getTask(session.id);
  if (
    !task
    || task.session_id !== session.id
    || task.project_id !== session.project_id
    || task.project_id !== project.id
  ) {
    throw new Error('Task does not belong to the registered session project.');
  }

  const registeredProject = canonicalizeProjectPath(project.path).canonicalPath;
  for (const [label, candidate] of [
    ['projectPath', options.projectPath],
    ['projectKey', options.projectKey],
    ['sessionKey', claimedSessionProject],
  ] as const) {
    if (canonicalizeProjectPath(candidate).canonicalPath !== registeredProject) {
      throw new Error(`${label} does not match the registered session project.`);
    }
  }

  if (
    options.resumeSessionId
    && options.resumeSessionId !== session.claude_session_id
    && options.resumeSessionId !== session.id
  ) {
    throw new Error('resumeSessionId does not belong to the registered session.');
  }

  const projectKey = canonicalProjectKey(project.path);
  const readOnlyAgent = options.agentMode === 'plan' || options.agentMode === 'review';
  const {
    workflowContext: _untrustedWorkflow,
    modelProviderId: _untrustedModelProviderId,
    resolvedModelSelection: _untrustedModelSelection,
    allowedTools: _untrustedAllowedTools,
    disallowedTools: _untrustedDisallowedTools,
    ...rendererOptions
  } = options;
  const disallowedTools = [...new Set(
    (resolveDisallowedTools?.(project.id) ?? [])
      .map((tool) => tool.trim())
      .filter(Boolean),
  )];
  return {
    ...rendererOptions,
    projectId: project.id,
    taskId: task.id,
    projectPath: project.path,
    projectKey,
    sessionKey: `${projectKey}::${session.id}`,
    permissionMode: readOnlyAgent ? 'plan' : options.permissionMode,
    ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
    // Workflow routing is main-process authority. Omitting a renderer-supplied
    // value keeps standalone completion on the standalone grant lifecycle.
  };
}

/** Registers the one-prompt/one-process Claude execution bridge. */
export function registerClaudeIPC(
  ipcMain: PublicIpcRegistrar,
  adapter: ClaudeAdapter,
  dependencies: ClaudeIPCDependencies,
): () => void {
  ipcMain.handle(IPC_CHANNELS.CLAUDE_CHECK_INSTALL, () => adapter.checkInstallation());

  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_RUN_PROMPT,
    async (_event, options: ClaudeRunOptions) => {
      if (!options || typeof options !== 'object') throw new Error('Invalid run options');
      for (const field of ['runId', 'projectKey', 'sessionKey', 'projectPath', 'prompt'] as const) {
        if (typeof options[field] !== 'string' || !options[field].trim()) {
          throw new Error(`Invalid ${field}`);
        }
      }
      const validated = validatedRunOptions(
        options,
        dependencies.database,
        dependencies.resolveDisallowedTools,
      );
      const resolved = dependencies.resolveRunOptions
        ? await dependencies.resolveRunOptions(validated)
        : validated;
      await dependencies.beforeRun?.(resolved);
      return adapter.runPrompt(resolved);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_STOP_RUN,
    async (_event, runId: string) => adapter.stopRun(runId),
  );

  const unsubscribe = adapter.subscribe((envelope) => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.CLAUDE_EVENT, envelope);
    }
  });

  return unsubscribe;
}

export const claudeIPCInternals = { validatedRunOptions };
