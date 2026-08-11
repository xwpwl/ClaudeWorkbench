import path from 'path';
import type { IpcMain } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalProjectKey } from '../../../shared/sessionIdentity';
import type { ClaudeRunOptions } from '../../../shared/types/claude';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import { TaskManager } from '../../tasks/TaskManager';
import { registerClaudeIPC } from '../claude';

vi.mock('../../index', () => ({ getMainWindow: () => null }));

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const PROJECT_PATH = path.resolve('fixtures', 'claude-project');
const PROJECT_KEY = canonicalProjectKey(PROJECT_PATH);

function runOptions(patch: Partial<ClaudeRunOptions> = {}): ClaudeRunOptions {
  return {
    runId: 'run-1',
    projectKey: PROJECT_KEY,
    sessionKey: `${PROJECT_KEY}::session-1`,
    projectPath: PROJECT_PATH,
    prompt: 'Implement the task',
    permissionMode: 'default',
    ...patch,
  };
}

function harness(
  sessionPatch: Record<string, unknown> = {},
  options: {
    useTaskManager?: boolean;
    disallowedTools?: string[];
    resolveRunOptions?: (options: ClaudeRunOptions) => ClaudeRunOptions;
  } = {},
) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
  } as unknown as IpcMain;
  const adapter = {
    checkInstallation: vi.fn(async () => ({ installed: true, path: 'claude', version: '2.1.218' })),
    runPrompt: vi.fn(async (options: ClaudeRunOptions) => ({ runId: options.runId, pid: 1 })),
    stopRun: vi.fn(async () => true),
    stopAll: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
  };
  const project = { id: 'project-1', path: PROJECT_PATH };
  const session = {
    id: 'session-1',
    project_id: project.id,
    claude_session_id: 'claude-session-1',
    ...sessionPatch,
  };
  const task = {
    id: 'task-1',
    session_id: session.id,
    project_id: project.id,
  };
  const database = {
    getSession: vi.fn((id: string) => id === session.id ? session : null),
    getProject: vi.fn((id: string) => id === project.id ? project : null),
    getTask: vi.fn((sessionId: string) => sessionId === session.id ? task : null),
  };
  const beforeRun = vi.fn(async () => undefined);
  const boundaryAdapter = options.useTaskManager
    ? new TaskManager(adapter as never)
    : adapter;
  registerClaudeIPC(ipcMain, boundaryAdapter as never, {
    database: database as never,
    beforeRun,
    resolveDisallowedTools: () => options.disallowedTools ?? [],
    ...(options.resolveRunOptions ? { resolveRunOptions: options.resolveRunOptions } : {}),
  });
  const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing handler: ${channel}`);
    return await handler({}, ...args) as T;
  };
  return { adapter, beforeRun, database, invoke, project, session, task };
}

describe('registerClaudeIPC run identity validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('normalizes a valid run to the registered project and session identity', async () => {
    const test = harness();
    await expect(test.invoke(IPC_CHANNELS.CLAUDE_RUN_PROMPT, runOptions({
      resumeSessionId: 'claude-session-1',
    }))).resolves.toEqual({ runId: 'run-1', pid: 1 });

    const normalized = test.adapter.runPrompt.mock.calls[0][0];
    expect(normalized).toMatchObject({
      projectId: test.project.id,
      taskId: test.task.id,
      projectPath: PROJECT_PATH,
      projectKey: PROJECT_KEY,
      sessionKey: `${PROJECT_KEY}::session-1`,
    });
    expect(test.beforeRun).toHaveBeenCalledWith(normalized);
  });

  it('rejects a projectKey forged to split the project lock', async () => {
    const test = harness();
    await expect(test.invoke(
      IPC_CHANNELS.CLAUDE_RUN_PROMPT,
      runOptions({ projectKey: path.resolve('fixtures', 'forged-project') }),
    )).rejects.toThrow('projectKey does not match');
    expect(test.adapter.runPrompt).not.toHaveBeenCalled();
  });

  it('rejects a projectPath outside the registered session project', async () => {
    const test = harness();
    await expect(test.invoke(
      IPC_CHANNELS.CLAUDE_RUN_PROMPT,
      runOptions({ projectPath: path.resolve('fixtures', 'other-project') }),
    )).rejects.toThrow('projectPath does not match');
  });

  it('rejects a forged sessionKey project prefix', async () => {
    const test = harness();
    const forged = canonicalProjectKey(path.resolve('fixtures', 'other-project'));
    await expect(test.invoke(
      IPC_CHANNELS.CLAUDE_RUN_PROMPT,
      runOptions({ sessionKey: `${forged}::session-1` }),
    )).rejects.toThrow('sessionKey does not match');
  });

  it('rejects a session id that is not registered', async () => {
    const test = harness();
    await expect(test.invoke(
      IPC_CHANNELS.CLAUDE_RUN_PROMPT,
      runOptions({ sessionKey: `${PROJECT_KEY}::missing-session` }),
    )).rejects.toThrow('Session project is not registered');
  });

  it.each(['session-1', 'prefix-only::', ''])('rejects malformed sessionKey %s', async (sessionKey) => {
    const test = harness();
    await expect(test.invoke(
      IPC_CHANNELS.CLAUDE_RUN_PROMPT,
      runOptions({ sessionKey }),
    )).rejects.toThrow('Invalid sessionKey');
  });

  it('rejects a resume transcript owned by another session', async () => {
    const test = harness();
    await expect(test.invoke(
      IPC_CHANNELS.CLAUDE_RUN_PROMPT,
      runOptions({ resumeSessionId: 'claude-session-other' }),
    )).rejects.toThrow('resumeSessionId does not belong');
  });

  it('allows an imported Claude session to resume by its Workbench session id', async () => {
    const test = harness({ claude_session_id: null });
    await expect(test.invoke(
      IPC_CHANNELS.CLAUDE_RUN_PROMPT,
      runOptions({ resumeSessionId: 'session-1' }),
    )).resolves.toMatchObject({ runId: 'run-1' });
  });

  it.each(['plan', 'review'] as const)(
    'forces %s agent mode through the CLI-enforced plan permission boundary',
    async (agentMode) => {
      const test = harness();
      await test.invoke(
        IPC_CHANNELS.CLAUDE_RUN_PROMPT,
        runOptions({ agentMode, permissionMode: 'bypassPermissions' }),
      );
      expect(test.adapter.runPrompt.mock.calls[0][0].permissionMode).toBe('plan');
    },
  );

  it('intercepts a renderer-supplied bypass before the underlying adapter can spawn', async () => {
    const test = harness({}, { useTaskManager: true });

    await expect(test.invoke(
      IPC_CHANNELS.CLAUDE_RUN_PROMPT,
      runOptions({ permissionMode: 'bypassPermissions' }),
    )).rejects.toThrow(/bypass permissions.*authorization/i);
    expect(test.adapter.runPrompt).not.toHaveBeenCalled();
  });

  it('strips renderer-supplied workflow routing authority', async () => {
    const test = harness();
    await test.invoke(
      IPC_CHANNELS.CLAUDE_RUN_PROMPT,
      runOptions({
        workflowContext: {
          workflowId: 'forged-workflow',
          stage: 'reviewer',
          reviewRound: 3,
        },
      }),
    );
    expect(test.adapter.runPrompt.mock.calls[0][0].workflowContext).toBeUndefined();
  });

  it('strips Renderer Provider claims, then applies the main-process model resolver', async () => {
    const resolveRunOptions = vi.fn((trusted: ClaudeRunOptions): ClaudeRunOptions => ({
      ...trusted,
      model: 'mimo-v2.5-pro',
      modelProviderId: 'provider-mimo',
    }));
    const test = harness({}, { resolveRunOptions });
    await test.invoke(
      IPC_CHANNELS.CLAUDE_RUN_PROMPT,
      runOptions({
        modelProviderId: 'renderer-forged',
        resolvedModelSelection: {
          providerId: 'renderer-forged', providerName: 'Forged', modelId: 'forged',
          runtimeType: 'none', source: 'task_override',
          capabilities: {
            supportsClaudeCode: false, supportsAgentWorkflow: false, supportsTools: false,
            supportsMCP: false, supportsStreaming: false, supportsVision: false,
          },
        },
      }),
    );
    expect(resolveRunOptions.mock.calls[0][0].modelProviderId).toBeUndefined();
    expect(resolveRunOptions.mock.calls[0][0].resolvedModelSelection).toBeUndefined();
    expect(test.adapter.runPrompt).toHaveBeenCalledWith(expect.objectContaining({
      model: 'mimo-v2.5-pro', modelProviderId: 'provider-mimo',
    }));
  });

  it('does not start TaskManager when model resolution rejects the selection', async () => {
    const test = harness({}, {
      resolveRunOptions: () => { throw new Error('unsupported Provider'); },
    });
    await expect(test.invoke(IPC_CHANNELS.CLAUDE_RUN_PROMPT, runOptions()))
      .rejects.toThrow('unsupported Provider');
    expect(test.beforeRun).not.toHaveBeenCalled();
    expect(test.adapter.runPrompt).not.toHaveBeenCalled();
  });

  it('strips renderer-supplied allowedTools before the CLI can pre-authorize tools', async () => {
    const test = harness();
    await test.invoke(
      IPC_CHANNELS.CLAUDE_RUN_PROMPT,
      runOptions({ allowedTools: ['Bash(*)', 'Write(*)'] }),
    );

    expect(test.adapter.runPrompt.mock.calls[0][0].allowedTools).toBeUndefined();
  });

  it('strips renderer-supplied disallowedTools instead of letting it re-enable disabled MCP tools', async () => {
    const test = harness();
    await test.invoke(
      IPC_CHANNELS.CLAUDE_RUN_PROMPT,
      runOptions({ disallowedTools: [] }),
    );

    expect(test.adapter.runPrompt.mock.calls[0][0].disallowedTools).toBeUndefined();
  });

  it('re-derives disabled MCP tools from the main-process project settings boundary', async () => {
    const test = harness({}, { disallowedTools: [' mcp__disabled__* ', 'mcp__disabled__*'] });
    await test.invoke(
      IPC_CHANNELS.CLAUDE_RUN_PROMPT,
      runOptions({ disallowedTools: [] }),
    );

    expect(test.adapter.runPrompt.mock.calls[0][0].disallowedTools)
      .toEqual(['mcp__disabled__*']);
  });

  it('overwrites renderer-supplied task and project permission identities from the database', async () => {
    const test = harness();
    await test.invoke(
      IPC_CHANNELS.CLAUDE_RUN_PROMPT,
      runOptions({
        taskId: 'victim-task',
        projectId: 'victim-project',
        workflowContext: {
          workflowId: 'victim-workflow',
          stage: 'coder',
          reviewRound: 9,
        },
      }),
    );

    expect(test.adapter.runPrompt.mock.calls[0][0]).toMatchObject({
      taskId: test.task.id,
      projectId: test.project.id,
    });
    expect(test.adapter.runPrompt.mock.calls[0][0].workflowContext).toBeUndefined();
  });

  it('rejects a task record that does not belong to the registered session project', async () => {
    const test = harness();
    test.database.getTask.mockReturnValueOnce({
      ...test.task,
      project_id: 'other-project',
    });

    await expect(test.invoke(
      IPC_CHANNELS.CLAUDE_RUN_PROMPT,
      runOptions(),
    )).rejects.toThrow('Task does not belong to the registered session project');
    expect(test.adapter.runPrompt).not.toHaveBeenCalled();
  });

  it('does not call preflight when identity validation fails', async () => {
    const test = harness();
    await expect(test.invoke(
      IPC_CHANNELS.CLAUDE_RUN_PROMPT,
      runOptions({ projectKey: 'forged' }),
    )).rejects.toThrow();
    expect(test.beforeRun).not.toHaveBeenCalled();
  });
});
