import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClaudeEvent, ClaudeEventEnvelope, ClaudeRunOptions } from '../../../shared/types/claude';
import { AppDatabase } from '../../database/Database';
import { AgentWorkflowManager } from '../../workflows/AgentWorkflowManager';
import type {
  AgentStageRequest,
  AgentStageResult,
  AgentStageRunner,
} from '../../workflows/contracts';
import { AppDatabaseWorkflowPersistence } from '../../workflows/WorkflowInfrastructure';
import { TaskEventRecorder } from '../TaskEventRecorder';

const TEMP_PREFIX = 'claude-workbench-workflow-recorder-';
const PROJECT_ID = 'project-1';
const SESSION_ID = 'session-1';

function removeFixture(directory: string): void {
  const target = path.resolve(directory);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith(TEMP_PREFIX)) {
    throw new Error(`Refusing to remove unexpected fixture: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function options(projectPath: string, workflow = true): ClaudeRunOptions {
  return {
    runId: workflow ? 'workflow-1:1:planner:0:transport' : 'ordinary-run',
    projectKey: projectPath,
    sessionKey: `${projectPath}::${SESSION_ID}`,
    projectPath,
    prompt: workflow ? 'Structured workflow input: {"secret":"must-not-persist"}' : 'ordinary prompt',
    permissionMode: workflow ? 'plan' : 'default',
    agentMode: workflow ? 'plan' : 'normal',
    ...(workflow ? {
      workflowContext: { workflowId: 'workflow-1', stage: 'planner' as const, reviewRound: 0 },
    } : {}),
  };
}

function resolvedModel() {
  return {
    providerId: 'provider-mimo', providerName: 'MiMo', modelId: 'mimo-v2.5-pro',
    runtimeType: 'claude-code' as const, source: 'global_agent_policy' as const,
    executionSource: 'environment' as const,
    tier: 'balanced' as const,
    tierSource: 'project' as const,
    capabilities: {
      supportsClaudeCode: true, supportsAgentWorkflow: true, supportsTools: true,
      supportsMCP: true, supportsStreaming: true, supportsVision: false,
    },
  };
}

function envelope(run: ClaudeRunOptions, event: ClaudeEvent): ClaudeEventEnvelope {
  return {
    runId: run.runId,
    projectKey: run.projectKey,
    sessionKey: run.sessionKey,
    event,
  };
}

describe('TaskEventRecorder workflow transport isolation', () => {
  let directory: string;
  let databasePath: string;
  let projectPath: string;
  let database: AppDatabase;
  let recorder: TaskEventRecorder;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    projectPath = path.join(directory, 'project');
    fs.mkdirSync(projectPath);
    databasePath = path.join(directory, 'workbench.sqlite');
    database = new AppDatabase(databasePath);
    database.createProject(PROJECT_ID, 'Project', projectPath);
    database.createSession(SESSION_ID, PROJECT_ID, 'Workflow task', 'initial-model', 'default');
    recorder = new TaskEventRecorder(database);
  });

  afterEach(() => {
    database.close();
    removeFixture(directory);
  });

  function managerWithRecordedStage(
    run: (request: AgentStageRequest) => AgentStageResult | Promise<AgentStageResult>,
  ): {
    manager: AgentWorkflowManager;
    persistence: AppDatabaseWorkflowPersistence;
    requests: AgentStageRequest[];
  } {
    const requests: AgentStageRequest[] = [];
    const runner: AgentStageRunner = {
      runStage: async (request) => {
        requests.push(request);
        recorder.recordStart({
          runId: `${request.operationId}:transport`,
          projectKey: request.projectKey,
          sessionKey: request.sessionKey,
          projectPath: request.projectPath,
          prompt: request.prompt,
          permissionMode: request.permissionMode,
          agentMode: request.agentMode,
          model: resolvedModel().modelId,
          modelProviderId: resolvedModel().providerId,
          resolvedModelSelection: resolvedModel(),
          workflowContext: request.workflowContext,
        });
        return run(request);
      },
    };
    const persistence = new AppDatabaseWorkflowPersistence(database);
    return {
      manager: new AgentWorkflowManager({
        persistence,
        runner,
        git: {
          readContext: () => ({
            kind: 'repository',
            head: 'a'.repeat(40),
            branch: 'main',
            files: [],
          }),
        },
      }),
      persistence,
      requests,
    };
  }

  it('does not persist the structured workflow transport prompt', () => {
    recorder.recordStart(options(projectPath));
    expect(database.listEvents(SESSION_ID)).toEqual([]);
  });

  it('attaches the safe resolved Provider snapshot to the persisted workflow stage', () => {
    database.ensureTask(SESSION_ID, PROJECT_ID, 'running', 'plan');
    database.createWorkflow({
      id: 'workflow-1', task_id: SESSION_ID, status: 'planning', current_stage: 'planner',
      created_at: '2026-08-09T00:00:00.000Z', updated_at: '2026-08-09T00:00:00.000Z',
      metadata_json: '{}',
    });
    database.upsertWorkflowStep({
      id: 'workflow-1:1:planner:0', workflow_id: 'workflow-1', agent_type: 'planner',
      review_round: 0, status: 'running', input: '{"kind":"planner"}', output: null,
      error: null, started_at: '2026-08-09T00:00:00.000Z', completed_at: null,
    });
    recorder.recordStart({
      ...options(projectPath),
      model: 'mimo-v2.5-pro',
      modelProviderId: 'provider-mimo',
      resolvedModelSelection: resolvedModel(),
    });
    const input = JSON.parse(
      database.getWorkflowStep('workflow-1:1:planner:0')?.input ?? '{}',
    ) as Record<string, unknown>;
    expect(input.modelSelection).toEqual(resolvedModel());
    expect(input.modelSelection).toMatchObject({
      providerId: 'provider-mimo', modelId: 'mimo-v2.5-pro', runtimeType: 'claude-code',
      source: 'global_agent_policy', executionSource: 'environment',
      tier: 'balanced', tierSource: 'project',
    });
    expect(JSON.stringify(input)).not.toMatch(/credential_ref|baseUrl|vault|api.?key|secret/iu);
  });

  it('keeps the trusted Provider snapshot when a running stage completes and is reloaded', async () => {
    const fixture = managerWithRecordedStage(async (request) => ({
      runId: `${request.operationId}:transport`,
      output: {
        title: 'Recorded plan',
        summary: 'Preserve the main-process model provenance.',
        steps: [{ id: 1, title: 'Persist provenance', risk: 'low' }],
        filesExpected: [],
        estimatedChanges: 'No file changes',
        riskLevel: 'low',
      },
    }));
    await fixture.manager.createWorkflow({
      id: 'workflow-completed-provenance',
      taskId: SESSION_ID,
      projectId: PROJECT_ID,
      projectPath,
      prompt: 'Create a plan',
      currentPermissionMode: 'plan',
    });

    const waiting = await fixture.manager.startPlanning('workflow-completed-provenance');
    const repeated = await fixture.manager.startPlanning('workflow-completed-provenance');

    expect(waiting.status).toBe('waiting_plan_confirmation');
    expect(repeated).toEqual(waiting);
    expect(fixture.requests).toHaveLength(1);
    const completed = fixture.persistence.listStageRecords('workflow-completed-provenance')[0];
    expect(completed).toMatchObject({
      status: 'completed',
      error: null,
      outputJson: expect.stringContaining('Recorded plan'),
    });
    expect((JSON.parse(completed.inputJson) as Record<string, unknown>).modelSelection)
      .toEqual(resolvedModel());

    database.close();
    database = new AppDatabase(databasePath);
    const reloaded = new AppDatabaseWorkflowPersistence(database)
      .listStageRecords('workflow-completed-provenance')[0];
    expect(reloaded).toMatchObject({
      status: 'completed',
      error: null,
      outputJson: completed.outputJson,
    });
    expect((JSON.parse(reloaded.inputJson) as Record<string, unknown>).modelSelection)
      .toEqual(resolvedModel());
  });

  it('keeps the trusted Provider snapshot when a running stage fails its workflow', async () => {
    const fixture = managerWithRecordedStage(async () => {
      throw new Error('stage transport failed');
    });
    await fixture.manager.createWorkflow({
      id: 'workflow-failed-provenance',
      taskId: SESSION_ID,
      projectId: PROJECT_ID,
      projectPath,
      prompt: 'Create a plan',
      currentPermissionMode: 'plan',
    });

    const failedWorkflow = await fixture.manager.startPlanning('workflow-failed-provenance');

    expect(failedWorkflow).toMatchObject({
      status: 'failed',
      failure: { stage: 'planner', code: 'AGENT_STAGE_FAILED', message: 'Agent stage failed.' },
    });
    expect(fixture.requests).toHaveLength(1);
    const failedStage = fixture.persistence.listStageRecords('workflow-failed-provenance')[0];
    expect(failedStage).toMatchObject({
      status: 'failed',
      error: 'AGENT_STAGE_FAILED',
      outputJson: null,
    });
    expect((JSON.parse(failedStage.inputJson) as Record<string, unknown>).modelSelection)
      .toEqual(resolvedModel());
  });

  it('keeps ordinary task_started persistence unchanged', () => {
    recorder.recordStart(options(projectPath, false));
    const events = database.listEvents(SESSION_ID);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('task_started');
    expect(events[0].payload_json).toContain('ordinary prompt');
  });

  it('records Provider, model, Runtime, capabilities, and source for an ordinary task', () => {
    recorder.recordStart({
      ...options(projectPath, false),
      model: 'mimo-v2.5-pro',
      modelProviderId: 'provider-mimo',
      resolvedModelSelection: resolvedModel(),
    });
    const payload = JSON.parse(database.listEvents(SESSION_ID)[0].payload_json) as Record<string, unknown>;
    expect(payload.modelSelection).toEqual(resolvedModel());
    expect(JSON.stringify(payload)).not.toMatch(/credential_ref|baseUrl|vault|api.?key|secret/iu);
  });

  it('persists the main-process Provider binding on the matching Claude system_init event', () => {
    const run = {
      ...options(projectPath, false),
      model: 'mimo-v2.5-pro',
      modelProviderId: 'provider-mimo',
      resolvedModelSelection: resolvedModel(),
    };
    recorder.recordStart(run);
    recorder.recordEvent(envelope(run, {
      type: 'system_init', sessionId: 'claude-session-1', model: 'mimo-v2.5-pro', timestamp: 10,
    }));

    const init = database.listEvents(SESSION_ID)
      .find((event) => event.event_type === 'system_init');
    const payload = JSON.parse(init?.payload_json ?? '{}') as Record<string, unknown>;
    expect(payload.modelSessionBinding).toEqual({
      claudeSessionId: 'claude-session-1',
      providerId: 'provider-mimo',
      modelId: 'mimo-v2.5-pro',
      runtimeType: 'claude-code',
      executionSource: 'environment',
    });
    expect(JSON.stringify(payload.modelSessionBinding))
      .not.toMatch(/credentialRef|credential_ref|baseUrl|vault|api.?key|secret/iu);
    expect(database.getSessionModelBinding(SESSION_ID)).toEqual({
      claudeSessionId: 'claude-session-1', providerId: 'provider-mimo',
      modelId: 'mimo-v2.5-pro', runtimeType: 'claude-code', executionSource: 'environment',
    });
  });

  it('marks a workflow transport as running without resetting its aggregate identity', () => {
    database.updateTask(SESSION_ID, { started_at: '2025-01-01T00:00:00.000Z' });
    recorder.recordStart(options(projectPath));
    expect(database.getTask(SESSION_ID)).toMatchObject({
      status: 'running',
      agent_mode: 'plan',
      started_at: '2025-01-01T00:00:00.000Z',
    });
  });

  it('updates the existing Session identity from workflow system_init without recording raw init', () => {
    const run = options(projectPath);
    recorder.recordStart(run);
    recorder.recordEvent(envelope(run, {
      type: 'system_init', sessionId: 'claude-workflow', model: 'workflow-model', timestamp: 10,
    }));
    expect(database.getSession(SESSION_ID)).toMatchObject({
      claude_session_id: 'claude-workflow', model: 'workflow-model', status: 'running',
    });
    expect(database.listEvents(SESSION_ID)).toEqual([]);
  });

  it('accumulates usage across Agent stages instead of overwriting it', () => {
    for (const [index, totals] of [[1, [2, 3, 5]], [2, [7, 11, 18]]] as const) {
      const run = { ...options(projectPath), runId: `workflow-1:${index}:tester:1` };
      recorder.recordStart(run);
      recorder.recordEvent(envelope(run, {
        type: 'usage_updated',
        inputTokens: totals[0], outputTokens: totals[1], totalTokens: totals[2], timestamp: index,
      }));
      recorder.recordEvent(envelope(run, {
        type: 'session_completed', sessionId: `claude-${index}`, duration: 10, result: '{}', timestamp: index + 10,
      }));
    }
    expect(database.getTask(SESSION_ID)).toMatchObject({
      input_tokens: 9, output_tokens: 14, total_tokens: 23,
    });
  });

  it.each([
    { type: 'session_completed', sessionId: 'claude', duration: 20, result: '{}', timestamp: 20 },
    { type: 'session_failed', error: 'stage failed', duration: 20, timestamp: 20 },
  ] as const)('does not treat $type as the whole workflow terminal', (terminal) => {
    const run = options(projectPath);
    recorder.recordStart(run);
    recorder.recordEvent(envelope(run, terminal));
    expect(database.getTask(SESSION_ID)?.status).toBe('running');
    expect(database.getSession(SESSION_ID)?.status).toBe('running');
  });

  it('still completes an ordinary task on its terminal event', () => {
    const run = options(projectPath, false);
    recorder.recordStart(run);
    recorder.recordEvent(envelope(run, {
      type: 'session_completed', sessionId: 'ordinary-claude', duration: 25, timestamp: 25,
    }));
    expect(database.getTask(SESSION_ID)).toMatchObject({ status: 'completed', duration_ms: 25 });
    expect(database.getSession(SESSION_ID)?.status).toBe('completed');
  });

  it.each(['assistant_text', 'thinking_content', 'stderr'] as const)(
    'does not persist workflow %s transport noise',
    (type) => {
      const run = options(projectPath);
      recorder.recordStart(run);
      const event: ClaudeEvent = type === 'assistant_text'
        ? { type, text: '{"raw":true}', timestamp: 1 }
        : type === 'thinking_content'
          ? { type, text: 'private chain', timestamp: 1 }
          : { type, text: 'diagnostic', level: 'info', timestamp: 1 };
      recorder.recordEvent(envelope(run, event));
      expect(database.listEvents(SESSION_ID)).toEqual([]);
    },
  );

  it('releases workflow transport bookkeeping at a stage terminal', () => {
    const run = options(projectPath);
    recorder.recordStart(run);
    recorder.recordEvent(envelope(run, {
      type: 'session_completed', sessionId: 'claude', duration: 5, result: '{}', timestamp: 5,
    }));
    // A later envelope with the same run id is now handled as a legacy event,
    // proving that the workflow-only marker did not leak indefinitely.
    recorder.recordEvent(envelope(run, {
      type: 'usage_updated', inputTokens: 1, outputTokens: 1, totalTokens: 2, timestamp: 6,
    }));
    expect(database.listEvents(SESSION_ID).map((event) => event.event_type)).toEqual(['usage_updated']);
  });

  it('ignores a workflow run whose Session no longer exists', () => {
    database.deleteSession(SESSION_ID);
    expect(() => recorder.recordStart(options(projectPath))).not.toThrow();
    expect(database.listEvents(SESSION_ID)).toEqual([]);
  });
});
