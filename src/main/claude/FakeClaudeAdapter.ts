import { EventEmitter } from 'events';
import crypto from 'crypto';
import type {
  ClaudeAdapter,
  ClaudeEvent,
  ClaudeEventEnvelope,
  ClaudeInstallationInfo,
  ClaudeRunDescriptor,
  ClaudeRunOptions,
} from '../../shared/types/claude';

export const FAKE_WORKFLOW_TARGET_PATH = 'src/phase6-target.ts';

type WorkflowContext = NonNullable<ClaudeRunOptions['workflowContext']>;

export interface FakeWorkflowStageResponse {
  result: string;
  fileChangedPath: string | null;
}

/** Pure deterministic workflow response used by FORCE_FAKE acceptance runs. */
export function buildFakeWorkflowStageResponse(
  context: WorkflowContext,
): FakeWorkflowStageResponse {
  if (context.stage === 'planner') {
    return {
      result: JSON.stringify({
        title: 'Implement the Phase 6 workflow target',
        summary: 'Create one deterministic fake workflow change and verify it.',
        steps: [
          { id: 1, title: 'Update the workflow target', risk: 'medium' },
          { id: 2, title: 'Run deterministic tests', risk: 'low' },
        ],
        filesExpected: [FAKE_WORKFLOW_TARGET_PATH],
        estimatedChanges: 'One small TypeScript change with focused tests',
        riskLevel: 'medium',
      }),
      fileChangedPath: null,
    };
  }
  if (context.stage === 'coder') {
    return {
      result: JSON.stringify({
        summary: `Completed workflow coder round ${Math.max(1, context.reviewRound)}.`,
        filesChanged: [FAKE_WORKFLOW_TARGET_PATH],
        testsSuggested: ['npm test'],
      }),
      fileChangedPath: FAKE_WORKFLOW_TARGET_PATH,
    };
  }
  if (context.stage === 'tester') {
    return {
      result: JSON.stringify({
        summary: 'Deterministic fake tests passed.',
        passed: 1,
        failed: 0,
        skipped: 0,
        commands: ['npm test'],
      }),
      fileChangedPath: null,
    };
  }

  const round = Math.max(1, context.reviewRound);
  const needsFix = round === 1;
  return {
    result: JSON.stringify({
      round,
      score: needsFix ? 6 : 10,
      summary: needsFix
        ? 'The first fake review requests one deterministic fix.'
        : 'The fake review is clean after the fix round.',
      issues: needsFix ? [{
        severity: 'high',
        file: FAKE_WORKFLOW_TARGET_PATH,
        line: 1,
        title: 'Exercise the workflow fix loop',
        recommendation: 'Run one coder/tester/reviewer fix round.',
      }] : [],
      tests: { passed: 1, failed: 0, skipped: 0 },
    }),
    fileChangedPath: null,
  };
}

/** Deterministic adapter used only by the explicit FORCE_FAKE test harness. */
export class FakeClaudeAdapter extends EventEmitter implements ClaudeAdapter {
  private timers = new Map<string, ReturnType<typeof setTimeout>[]>();
  private runs = new Map<string, ClaudeRunOptions>();

  async checkInstallation(): Promise<ClaudeInstallationInfo> {
    return { installed: true, path: 'fake-claude', version: '2.0.0-demo' };
  }

  async runPrompt(options: ClaudeRunOptions): Promise<ClaudeRunDescriptor> {
    if (this.runs.has(options.runId)) throw new Error('Duplicate run id');
    this.runs.set(options.runId, options);
    const claudeSessionId = options.resumeSessionId || crypto.randomUUID();
    const workflowResponse = options.workflowContext
      ? buildFakeWorkflowStageResponse(options.workflowContext)
      : null;
    const assistantText = workflowResponse?.result ?? `已收到任务：${options.prompt}`;
    this.schedule(options, {
      type: 'session_started',
      sessionId: claudeSessionId,
      timestamp: Date.now(),
    }, 10);
    this.schedule(options, {
      type: 'system_init',
      sessionId: claudeSessionId,
      model: options.model || 'fake-model',
      timestamp: Date.now(),
    }, 20);
    if (workflowResponse?.fileChangedPath) {
      this.schedule(options, {
        type: 'file_changed',
        filePath: workflowResponse.fileChangedPath,
        toolUseId: `fake-workflow:${options.runId}:coder`,
        timestamp: Date.now(),
      }, 60);
    }
    this.schedule(options, {
      type: 'assistant_text',
      messageId: `fake-message:${options.runId}`,
      blockIndex: 0,
      isSnapshot: true,
      text: assistantText,
      timestamp: Date.now(),
    }, 80);
    this.schedule(options, {
      type: 'usage_updated',
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      timestamp: Date.now(),
    }, 100);
    this.schedule(options, {
      type: 'session_completed',
      sessionId: claudeSessionId,
      duration: 140,
      ...(workflowResponse ? { result: workflowResponse.result } : {}),
      timestamp: Date.now(),
    }, 140, true);
    return { runId: options.runId, pid: null };
  }

  async stopRun(runId: string): Promise<boolean> {
    if (!this.runs.has(runId)) return false;
    for (const timer of this.timers.get(runId) ?? []) clearTimeout(timer);
    this.timers.delete(runId);
    this.runs.delete(runId);
    return true;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runs.keys()].map((runId) => this.stopRun(runId)));
  }

  subscribe(listener: (envelope: ClaudeEventEnvelope) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }

  private schedule(
    options: ClaudeRunOptions,
    event: ClaudeEvent,
    delay: number,
    terminal = false,
  ): void {
    const timer = setTimeout(() => {
      if (!this.runs.has(options.runId)) return;
      this.emit('event', {
        runId: options.runId,
        projectKey: options.projectKey,
        sessionKey: options.sessionKey,
        event,
      } satisfies ClaudeEventEnvelope);
      if (terminal) {
        this.runs.delete(options.runId);
        this.timers.delete(options.runId);
      }
    }, delay);
    const timers = this.timers.get(options.runId) ?? [];
    timers.push(timer);
    this.timers.set(options.runId, timers);
  }
}
