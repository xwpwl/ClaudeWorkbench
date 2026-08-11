import { describe, expect, it, vi } from 'vitest';
import type { ClaudeEvent, ClaudeEventEnvelope, ClaudeRunOptions } from '../../../shared/types/claude';
import type { AgentStageRequest } from '../contracts';
import {
  TaskManagerAgentStageRunner,
  taskManagerStageRunnerInternals,
} from '../TaskManagerAgentStageRunner';

function request(stage: AgentStageRequest['stage']): AgentStageRequest {
  const agentMode = stage === 'planner' ? 'plan' : stage === 'reviewer' ? 'review' : 'normal';
  return {
    operationId: `workflow-1:${stage}:1`,
    workflowId: 'workflow-1',
    taskId: 'task-1',
    projectId: 'project-1',
    projectPath: 'C:\\project',
    projectKey: 'C:\\project',
    sessionKey: 'C:\\project::task-1',
    stage,
    agentType: stage,
    agentMode,
    permissionMode: stage === 'planner' || stage === 'reviewer' ? 'plan' : 'default',
    model: 'model-1',
    prompt: 'Improve database performance',
    systemPrompt: `Return ${stage} JSON.`,
    reviewRound: stage === 'planner' ? 0 : 1,
    workflowContext: { workflowId: 'workflow-1', stage, reviewRound: stage === 'planner' ? 0 : 1 },
    input: stage === 'planner'
      ? {
          kind: 'planner',
          goal: 'Improve database performance',
          projectPath: 'C:\\project',
          git: { kind: 'repository', head: 'abc', branch: 'main', files: [] },
          previousPlan: null,
          feedback: null,
        }
      : stage === 'coder'
        ? {
            kind: 'coder',
            goal: 'Improve database performance',
            projectPath: 'C:\\project',
            plan: {
              title: 'Improve database performance', summary: 'Tune queries', steps: [],
              filesExpected: [], estimatedChanges: '2 files', riskLevel: 'medium',
            },
            review: null,
            git: { kind: 'repository', head: 'abc', branch: 'main', files: [] },
            fixRound: 1,
          }
        : stage === 'tester'
          ? {
              kind: 'tester',
              goal: 'Improve database performance',
              projectPath: 'C:\\project',
              plan: {
                title: 'Improve database performance', summary: 'Tune queries', steps: [],
                filesExpected: [], estimatedChanges: '2 files', riskLevel: 'medium',
              },
              coder: { summary: 'done', filesChanged: [], testsSuggested: [] },
              git: { kind: 'repository', head: 'abc', branch: 'main', files: [] },
              fixRound: 1,
            }
          : {
              kind: 'reviewer',
              goal: 'Improve database performance',
              projectPath: 'C:\\project',
              plan: {
                title: 'Improve database performance', summary: 'Tune queries', steps: [],
                filesExpected: [], estimatedChanges: '2 files', riskLevel: 'medium',
              },
              coder: { summary: 'done', filesChanged: [], testsSuggested: [] },
              tests: { summary: 'pass', passed: 10, failed: 0, skipped: 0, commands: ['npm test'] },
              git: { kind: 'repository', head: 'abc', branch: 'main', files: [] },
              reviewRound: 1,
            },
  };
}

class TaskStub {
  listeners = new Set<(event: ClaudeEventEnvelope) => void>();
  options: ClaudeRunOptions | null = null;
  runPrompt = vi.fn(async (options: ClaudeRunOptions) => {
    this.options = options;
    return { runId: options.runId, pid: 1 };
  });
  stopRun = vi.fn(async () => true);
  waitForRunCompletion = vi.fn(async () => undefined);
  subscribe = vi.fn((listener: (event: ClaudeEventEnvelope) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  });

  emit(event: ClaudeEvent): void {
    if (!this.options) throw new Error('runPrompt was not called');
    const envelope: ClaudeEventEnvelope = {
      runId: this.options.runId,
      projectKey: this.options.projectKey,
      sessionKey: this.options.sessionKey,
      event,
    };
    for (const listener of this.listeners) listener(envelope);
  }
}

function completed(result?: string): ClaudeEvent {
  return { type: 'session_completed', sessionId: 'claude-1', duration: 10, result, timestamp: 10 };
}

function pinnedSelection() {
  return {
    providerId: 'provider-pinned', providerName: 'Pinned Provider', modelId: 'pinned-model',
    runtimeType: 'claude-code' as const, source: 'project_policy' as const,
    capabilities: {
      supportsClaudeCode: true, supportsAgentWorkflow: true, supportsTools: true,
      supportsMCP: true, supportsStreaming: true, supportsVision: false,
    },
  };
}

function structuredInputFromPrompt(prompt: string): Record<string, unknown> {
  const prefix = 'Structured workflow stage input:\n';
  const suffix = '\n\nReturn only the structured JSON requested by the system instruction;';
  const start = prompt.indexOf(prefix);
  const end = prompt.indexOf(suffix, start + prefix.length);
  if (start < 0 || end < 0) throw new Error('Structured stage input is missing from prompt.');
  return JSON.parse(prompt.slice(start + prefix.length, end)) as Record<string, unknown>;
}

function expectPromptToExcludePrivatePath(prompt: string, privateProjectPath: string): void {
  const nativePrompt = prompt.replace(/\\\\/gu, '\\');
  const forwardPrompt = nativePrompt.replace(/\\/gu, '/');
  expect(nativePrompt.toLocaleLowerCase('en-US'))
    .not.toContain(privateProjectPath.toLocaleLowerCase('en-US'));
  expect(forwardPrompt.toLocaleLowerCase('en-US'))
    .not.toContain(privateProjectPath.replace(/\\/gu, '/').toLocaleLowerCase('en-US'));
}

describe('TaskManagerAgentStageRunner prompt policy', () => {
  it.each(['planner', 'reviewer'] as const)('%s system prompt is explicitly read-only', (stage) => {
    expect(taskManagerStageRunnerInternals.safeSystemPrompt(request(stage))).toContain('read-only');
  });

  it.each(['coder', 'tester'] as const)('%s system prompt preserves permission enforcement', (stage) => {
    expect(taskManagerStageRunnerInternals.safeSystemPrompt(request(stage)))
      .toContain('existing Claude Code permission policy');
  });

  it.each(['planner', 'coder', 'tester', 'reviewer'] as const)(
    '%s prompt carries the structured stage input and user goal',
    (stage) => {
      const prompt = taskManagerStageRunnerInternals.stagePrompt(request(stage));
      expect(prompt).toContain('Improve database performance');
      expect(prompt).toContain(`"kind": "${stage}"`);
      expect(prompt).toContain('do not wrap it in Markdown');
    },
  );

  it('rejects a structured stage input above the byte cap', () => {
    const value = request('planner');
    value.input.goal = 'x'.repeat(taskManagerStageRunnerInternals.MAX_STAGE_INPUT_BYTES + 1);
    expect(() => taskManagerStageRunnerInternals.stagePrompt(value)).toThrow('256 KiB');
  });

  it('prefers a terminal result over streamed assistant blocks', () => {
    expect(taskManagerStageRunnerInternals.outputText(new Map([['a', 'stream']]), ' result ')).toBe('result');
  });

  it('combines and trims assistant blocks when the terminal has no result', () => {
    expect(taskManagerStageRunnerInternals.outputText(new Map([['a', ' one '], ['b', 'two ']]), undefined))
      .toBe('one \ntwo');
  });
});

describe('TaskManagerAgentStageRunner TaskManager bridge', () => {
  it.each(['planner', 'coder', 'tester', 'reviewer'] as const)(
    '%s keeps the authoritative cwd but projects the private project path out of both prompts',
    async (stage) => {
      const privateProjectPath = 'C:\\Users\\Private-Profile\\Projects\\Sensitive-Workspace';
      const value = request(stage);
      value.projectPath = privateProjectPath;
      value.input.projectPath = privateProjectPath;
      const originalInput = JSON.stringify(value.input);
      const directPrompt = taskManagerStageRunnerInternals.stagePrompt(value);
      const tasks = new TaskStub();
      const runner = new TaskManagerAgentStageRunner(tasks as never);

      const running = runner.runStage(value);
      await vi.waitFor(() => expect(tasks.options).not.toBeNull());
      tasks.emit(completed('{}'));
      await running;

      for (const prompt of [directPrompt, tasks.options?.prompt ?? '']) {
        expectPromptToExcludePrivatePath(prompt, privateProjectPath);
        expect(structuredInputFromPrompt(prompt)).toEqual({
          ...value.input,
          projectPath: '.',
        });
      }
      expect(tasks.options?.projectPath).toBe(privateProjectPath);
      expect(JSON.stringify(value.input)).toBe(originalInput);
    },
  );

  it.each([
    ['planner', 'default', 'plan'],
    ['reviewer', 'default', 'review'],
    ['coder', 'default', 'develop'],
    ['tester', 'default', 'develop'],
  ] as const)('routes %s through permission=%s and agentMode=%s', async (stage, permission, agentMode) => {
    const tasks = new TaskStub();
    const runner = new TaskManagerAgentStageRunner(tasks as never, { randomUUID: () => 'run-token' });
    const running = runner.runStage(request(stage));
    await vi.waitFor(() => expect(tasks.options).not.toBeNull());
    tasks.emit(completed('{"ok":true}'));
    await running;
    expect(tasks.options).toMatchObject({
      taskId: 'task-1',
      projectId: 'project-1',
      permissionMode: permission,
      agentMode,
      workflowContext: request(stage).workflowContext,
      model: 'model-1',
    });
    expect(tasks.options?.runId).toBe(`workflow-1:${stage}:1:run-token`);
    expect(tasks.options?.structuredOutputSchema).toMatchObject({ type: 'object' });
  });

  it('forces reviewer read-only even if the request claims a writable permission', async () => {
    const tasks = new TaskStub();
    const runner = new TaskManagerAgentStageRunner(tasks as never);
    const value = request('reviewer');
    value.permissionMode = 'bypassPermissions';
    const running = runner.runStage(value);
    await vi.waitFor(() => expect(tasks.options).not.toBeNull());
    tasks.emit(completed('{}'));
    await running;
    expect(tasks.options?.permissionMode).toBe('default');
    expect(tasks.options?.disallowedTools).toEqual(expect.arrayContaining([
      'Bash', 'Edit', 'Write', 'NotebookEdit', 'Task', 'Agent', 'mcp__*',
    ]));
  });

  it('carries project-disabled MCP tools into every workflow stage', async () => {
    const tasks = new TaskStub();
    const runner = new TaskManagerAgentStageRunner(tasks as never, {
      resolveDisallowedTools: () => ['mcp__disabled__*'],
    });
    const running = runner.runStage(request('coder'));
    await vi.waitFor(() => expect(tasks.options).not.toBeNull());
    tasks.emit(completed('{}'));
    await running;
    expect(tasks.options?.disallowedTools).toEqual(['mcp__disabled__*']);
  });

  it('normalizes, deduplicates, and drops unsafe disabled-tool entries', async () => {
    const tasks = new TaskStub();
    const runner = new TaskManagerAgentStageRunner(tasks as never, {
      resolveDisallowedTools: () => [
        ' mcp__disabled__* ',
        'mcp__disabled__*',
        '',
        'bad\0tool',
        'x'.repeat(501),
      ],
    });
    const running = runner.runStage(request('reviewer'));
    await vi.waitFor(() => expect(tasks.options).not.toBeNull());
    tasks.emit(completed('{}'));
    await running;
    expect(tasks.options?.disallowedTools).toEqual([
      'mcp__disabled__*', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'Task', 'Agent', 'mcp__*',
    ]);
  });

  it('omits disallowedTools for a writable stage when the project has no disabled MCP servers', async () => {
    const tasks = new TaskStub();
    const runner = new TaskManagerAgentStageRunner(tasks as never, {
      resolveDisallowedTools: () => [],
    });
    const running = runner.runStage(request('coder'));
    await vi.waitFor(() => expect(tasks.options).not.toBeNull());
    tasks.emit(completed('{}'));
    await running;
    expect(tasks.options).not.toHaveProperty('disallowedTools');
  });

  it('uses the terminal result as structured output', async () => {
    const tasks = new TaskStub();
    const runner = new TaskManagerAgentStageRunner(tasks as never);
    const running = runner.runStage(request('planner'));
    await vi.waitFor(() => expect(tasks.options).not.toBeNull());
    tasks.emit(completed('{"title":"plan"}'));
    await expect(running).resolves.toMatchObject({ output: '{"title":"plan"}' });
  });

  it('applies the main-process Provider resolver before TaskManager starts the stage', async () => {
    const tasks = new TaskStub();
    const resolveRunOptions = vi.fn((options: ClaudeRunOptions): ClaudeRunOptions => ({
      ...options,
      model: 'review-model',
      modelProviderId: 'provider-review',
      resolvedModelSelection: {
        providerId: 'provider-review', providerName: 'Review Provider', modelId: 'review-model',
        runtimeType: 'claude-code', source: 'global_agent_policy',
        capabilities: {
          supportsClaudeCode: true, supportsAgentWorkflow: true, supportsTools: true,
          supportsMCP: true, supportsStreaming: true, supportsVision: false,
        },
      },
    }));
    const runner = new TaskManagerAgentStageRunner(tasks as never, { resolveRunOptions });
    const running = runner.runStage(request('reviewer'));
    await vi.waitFor(() => expect(tasks.options).not.toBeNull());
    tasks.emit(completed('{}'));
    await expect(running).resolves.toMatchObject({
      modelSelection: { providerId: 'provider-review', modelId: 'review-model' },
    });
    expect(resolveRunOptions).toHaveBeenCalledWith(expect.objectContaining({
      workflowContext: request('reviewer').workflowContext,
    }));
    expect(tasks.options).toMatchObject({
      model: 'review-model', modelProviderId: 'provider-review',
    });
  });

  it('uses the pinned workflow resolver instead of re-reading mutable policy', async () => {
    const tasks = new TaskStub();
    const value = request('coder');
    value.modelSelection = pinnedSelection();
    const resolveRunOptions = vi.fn(() => {
      throw new Error('mutable policy must not be read');
    });
    const resolvePinnedRunOptions = vi.fn((options: ClaudeRunOptions): ClaudeRunOptions => ({
      ...options,
      model: 'pinned-model',
      modelProviderId: 'provider-pinned',
      resolvedModelSelection: pinnedSelection(),
    }));
    const runner = new TaskManagerAgentStageRunner(tasks as never, {
      resolveRunOptions,
      resolvePinnedRunOptions,
    });

    const running = runner.runStage(value);
    await vi.waitFor(() => expect(tasks.options).not.toBeNull());
    tasks.emit(completed('{}'));
    await running;

    expect(resolvePinnedRunOptions).toHaveBeenCalledWith(
      expect.objectContaining({ workflowContext: value.workflowContext }),
      value.modelSelection,
    );
    expect(resolveRunOptions).not.toHaveBeenCalled();
    expect(tasks.options).toMatchObject({
      model: 'pinned-model', modelProviderId: 'provider-pinned',
    });
  });

  it('revalidates pinned capabilities before TaskManager can spawn a stage', async () => {
    const tasks = new TaskStub();
    const value = request('coder');
    value.modelSelection = pinnedSelection();
    const runner = new TaskManagerAgentStageRunner(tasks as never, {
      resolvePinnedRunOptions: () => { throw new Error('pinned Provider lost MCP capability'); },
    });

    await expect(runner.runStage(value)).rejects.toThrow('lost MCP capability');
    expect(tasks.runPrompt).not.toHaveBeenCalled();
  });

  it('fails closed when a pinned stage has no pinned Provider resolver', async () => {
    const tasks = new TaskStub();
    const value = request('planner');
    value.modelSelection = pinnedSelection();
    const runner = new TaskManagerAgentStageRunner(tasks as never, {
      resolveRunOptions: (options) => options,
    });

    await expect(runner.runStage(value)).rejects.toThrow(/pinned Provider resolver/iu);
    expect(tasks.runPrompt).not.toHaveBeenCalled();
  });

  it('fails before TaskManager when Provider resolution rejects a workflow model', async () => {
    const tasks = new TaskStub();
    const runner = new TaskManagerAgentStageRunner(tasks as never, {
      resolveRunOptions: () => { throw new Error('unsupported Provider'); },
    });
    await expect(runner.runStage(request('coder'))).rejects.toThrow('unsupported Provider');
    expect(tasks.runPrompt).not.toHaveBeenCalled();
  });

  it('reconstructs snapshot and delta assistant blocks', async () => {
    const tasks = new TaskStub();
    const runner = new TaskManagerAgentStageRunner(tasks as never);
    const running = runner.runStage(request('planner'));
    await vi.waitFor(() => expect(tasks.options).not.toBeNull());
    tasks.emit({ type: 'assistant_text', messageId: 'm', blockIndex: 0, isSnapshot: true, text: '{"a":', timestamp: 1 });
    tasks.emit({ type: 'assistant_text', messageId: 'm', blockIndex: 0, isSnapshot: false, text: '1}', timestamp: 2 });
    tasks.emit(completed());
    await expect(running).resolves.toMatchObject({ output: '{"a":1}' });
  });

  it('returns sorted unique file_changed paths', async () => {
    const tasks = new TaskStub();
    const runner = new TaskManagerAgentStageRunner(tasks as never);
    const running = runner.runStage(request('coder'));
    await vi.waitFor(() => expect(tasks.options).not.toBeNull());
    for (const filePath of ['z.ts', 'a.ts', 'z.ts']) {
      tasks.emit({ type: 'file_changed', filePath, toolUseId: filePath, timestamp: 1 });
    }
    tasks.emit(completed('{}'));
    await expect(running).resolves.toMatchObject({ modifiedFiles: ['a.ts', 'z.ts'] });
  });

  it('waits for TaskManager terminal finalizers before resolving', async () => {
    const tasks = new TaskStub();
    let release!: () => void;
    tasks.waitForRunCompletion.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const runner = new TaskManagerAgentStageRunner(tasks as never);
    let settled = false;
    const running = runner.runStage(request('tester')).then((value) => { settled = true; return value; });
    await vi.waitFor(() => expect(tasks.options).not.toBeNull());
    tasks.emit(completed('{}'));
    await vi.waitFor(() => expect(tasks.waitForRunCompletion).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    release();
    await running;
    expect(settled).toBe(true);
  });

  it('throws a sanitized stage failure after TaskManager releases the run', async () => {
    const tasks = new TaskStub();
    const runner = new TaskManagerAgentStageRunner(tasks as never);
    const running = runner.runStage(request('reviewer'));
    await vi.waitFor(() => expect(tasks.options).not.toBeNull());
    tasks.emit({ type: 'session_failed', error: 'review failed', timestamp: 2 });
    await expect(running).rejects.toThrow('review failed');
    expect(tasks.waitForRunCompletion).toHaveBeenCalledOnce();
    expect(tasks.stopRun).not.toHaveBeenCalled();
  });

  it('rejects a successful terminal event with no structured output', async () => {
    const tasks = new TaskStub();
    const runner = new TaskManagerAgentStageRunner(tasks as never);
    const running = runner.runStage(request('planner'));
    await vi.waitFor(() => expect(tasks.options).not.toBeNull());
    tasks.emit(completed('   '));
    await expect(running).rejects.toThrow('returned no structured output');
  });

  it('unsubscribes when TaskManager rejects the run', async () => {
    const tasks = new TaskStub();
    tasks.runPrompt.mockRejectedValueOnce(new Error('busy'));
    const runner = new TaskManagerAgentStageRunner(tasks as never);
    await expect(runner.runStage(request('coder'))).rejects.toThrow('busy');
    expect(tasks.listeners.size).toBe(0);
    expect(tasks.stopRun).toHaveBeenCalledOnce();
  });

  it('stops a timed-out run and waits for lock release', async () => {
    vi.useFakeTimers();
    try {
      const tasks = new TaskStub();
      const runner = new TaskManagerAgentStageRunner(tasks as never, { timeoutMs: 1_000 });
      const running = runner.runStage(request('coder'));
      const rejection = expect(running).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
      expect(tasks.stopRun).toHaveBeenCalledOnce();
      expect(tasks.waitForRunCompletion).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([0, 999, Number.NaN])('rejects invalid timeout %s', (timeoutMs) => {
    expect(() => new TaskManagerAgentStageRunner(new TaskStub() as never, { timeoutMs }))
      .toThrow('at least one second');
  });
});
