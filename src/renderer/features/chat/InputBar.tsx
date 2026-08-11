import React, { useEffect, useRef, useState } from 'react';
import { FolderOpen, Send, Square } from 'lucide-react';
import { canonicalProjectKey } from '../../../shared/sessionIdentity';
import { isBusy, isTerminal } from '../../../shared/sessionStateMachine';
import { PERMISSION_MODE_MAP } from '../../../shared/types/claude';
import type { CliPermissionMode, UIPermissionMode } from '../../../shared/types/claude';
import type { SessionMetadataPatch, SessionSummary } from '../../../shared/types/session';
import type { Project } from '../../../shared/types/project';
import type {
  CreateWorkflowRequest,
  Workflow,
  WorkflowStatus,
} from '../../../shared/types/workflow';
import { ModelQuickSwitcher } from '../models/ModelQuickSwitcher';
import type { UseModelProviderToolbarResult } from '../models/useModelProviderToolbar';
import { useAppStore } from '../../stores/appStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';

export interface InputBarProps {
  onOpenProject: () => void;
  onSwitchProjectForPrompt?: (project: Project, prompt: string) => Promise<void>;
  workflowStatus?: WorkflowStatus | null;
  workflowLookupPending?: boolean;
  onWorkflowChanged?: (workflow: Workflow) => void;
  modelProviderState?: UseModelProviderToolbarResult | null;
}

type InputAgentMode = 'normal' | 'plan' | 'develop' | 'review';

const TERMINAL_WORKFLOW_STATUSES = new Set<WorkflowStatus>(['completed', 'failed', 'cancelled']);

function promptPathKey(value: string): string {
  return value.replaceAll('\\', '/').toLocaleLowerCase('en-US');
}

export function registeredPromptTargetProjects(
  prompt: string,
  selectedProject: Pick<Project, 'id' | 'path'>,
  projects: readonly Project[],
): Project[] {
  const normalizedPrompt = promptPathKey(prompt);
  return projects
    .filter((project) => project.id !== selectedProject.id)
    .filter((project) => normalizedPrompt.includes(promptPathKey(project.path)))
    .sort((left, right) => right.path.length - left.path.length)
    .filter((project, index, matches) => (
      matches.findIndex((candidate) => candidate.id === project.id) === index
    ));
}

export function executionProjectMismatch(
  selected: { id: string; path: string },
  runtimeIdentity: { projectId: string; projectPath: string },
): string | null {
  if (
    selected.id !== runtimeIdentity.projectId
    || canonicalProjectKey(selected.path) !== canonicalProjectKey(runtimeIdentity.projectPath)
  ) {
    return '当前选择项目与任务绑定项目不一致。请重新选择任务或项目后再运行。';
  }
  return null;
}

export function isWorkflowPlanMode(agentMode: InputAgentMode): boolean {
  return agentMode === 'plan';
}

export function workflowUsesActiveAgent(status: WorkflowStatus | null | undefined): boolean {
  return Boolean(status && !TERMINAL_WORKFLOW_STATUSES.has(status));
}

export function workflowPermissionMode(permissionMode: UIPermissionMode): CliPermissionMode {
  return PERMISSION_MODE_MAP[permissionMode];
}

export function workflowSessionPatch(
  summary: Pick<SessionSummary, 'title' | 'titleSource'>,
  prompt: string,
  permissionMode: CliPermissionMode,
): SessionMetadataPatch {
  const defaultTitle = summary.titleSource === 'default'
    || summary.title === 'New Task'
    || summary.title === '新任务';
  return {
    ...(defaultTitle ? {
      title: prompt.slice(0, 40),
      titleSource: 'first_prompt' as const,
    } : {}),
    permissionMode,
  };
}

export interface WorkflowPlanSubmission {
  taskId: string;
  prompt: string;
  userMessageId: string;
  currentModel?: string;
  currentPermissionMode: CliPermissionMode;
  sessionPatch: SessionMetadataPatch;
}

export interface WorkflowPlanSubmissionDependencies {
  saveUserMessage: (taskId: string, prompt: string, messageId: string) => Promise<void>;
  updateSession: (taskId: string, patch: SessionMetadataPatch) => Promise<void>;
  createWorkflow: (input: CreateWorkflowRequest) => Promise<Workflow>;
  startWorkflowPlanning: (workflowId: string) => Promise<Workflow>;
  onWorkflowChanged?: (workflow: Workflow) => void;
}

/** Persists the user-visible task metadata before the main process starts any Agent. */
export async function submitWorkflowPlan(
  submission: WorkflowPlanSubmission,
  dependencies: WorkflowPlanSubmissionDependencies,
): Promise<Workflow> {
  await Promise.all([
    dependencies.saveUserMessage(
      submission.taskId,
      submission.prompt,
      submission.userMessageId,
    ),
    dependencies.updateSession(submission.taskId, submission.sessionPatch),
  ]);
  const created = await dependencies.createWorkflow({
    taskId: submission.taskId,
    prompt: submission.prompt,
    ...(submission.currentModel ? { currentModel: submission.currentModel } : {}),
    currentPermissionMode: submission.currentPermissionMode,
  });
  dependencies.onWorkflowChanged?.(created);
  const planned = await dependencies.startWorkflowPlanning(created.id);
  dependencies.onWorkflowChanged?.(planned);
  return planned;
}

export interface TaskComposerModelSwitcherViewProps {
  modelProviderState: UseModelProviderToolbarResult;
  busy: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
}

export function TaskComposerModelSwitcherView({
  modelProviderState,
  busy,
  open,
  onOpenChange,
}: TaskComposerModelSwitcherViewProps) {
  return (
    <div className="min-w-0 shrink-0" data-testid="task-composer-model-switcher">
      <ModelQuickSwitcher
        selection={modelProviderState.selection}
        options={modelProviderState.options}
        error={modelProviderState.error}
        isTaskRunning={busy}
        open={open}
        placement="up"
        onOpenChange={onOpenChange}
        onSwitch={modelProviderState.onSwitch}
        onClearOverride={modelProviderState.onClearOverride}
      />
    </div>
  );
}

export function InputBar({
  onOpenProject,
  onSwitchProjectForPrompt,
  workflowStatus = null,
  workflowLookupPending = false,
  onWorkflowChanged,
  modelProviderState,
}: InputBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [workflowStarting, setWorkflowStarting] = useState(false);
  const [modelSwitcherOpen, setModelSwitcherOpen] = useState(false);
  const [pendingProjectSwitch, setPendingProjectSwitch] = useState<{
    project: Project;
    prompt: string;
  } | null>(null);
  const [projectSwitching, setProjectSwitching] = useState(false);
  const currentProject = useWorkspaceStore((state) => state.currentProject);
  const projects = useWorkspaceStore((state) => state.projects);
  const sessionKey = useWorkspaceStore((state) => state.currentSessionKey);
  const runtime = useWorkspaceStore((state) =>
    state.currentSessionKey ? state.runtimes[state.currentSessionKey] : undefined,
  );
  const currentModel = useAppStore((state) => state.currentModel);
  const permissionMode = useAppStore((state) => state.permissionMode);
  const agentMode = useAppStore((state) => state.agentMode);
  const projectSettings = useAppStore((state) => state.currentProjectSettings);
  const runtimeBusy = runtime
    ? isBusy(runtime.summary.status) && runtime.summary.status !== 'loading_history'
    : false;
  const workflowBusy = workflowUsesActiveAgent(workflowStatus);
  const busy = runtimeBusy || workflowBusy || workflowLookupPending || workflowStarting;

  useEffect(() => {
    if (!runtime || runtime.summary.status === 'loading_history') return;
    textareaRef.current?.focus();
  }, [sessionKey, runtime?.summary.status]);

  useEffect(() => {
    if (runtime && isTerminal(runtime.summary.status)) textareaRef.current?.focus();
  }, [runtime?.summary.status]);

  const send = async (modeOverride?: 'plan') => {
    if (!runtime || !sessionKey || !currentProject || busy) return;
    const prompt = runtime.draft.trim();
    if (!prompt) return;
    const userMessageId = crypto.randomUUID();
    const store = useWorkspaceStore.getState();
    const projectMismatch = executionProjectMismatch(currentProject, {
      projectId: runtime.summary.projectId,
      projectPath: runtime.projectPath,
    });
    if (projectMismatch) {
      store.setSessionError(sessionKey, projectMismatch);
      return;
    }
    const promptTargets = registeredPromptTargetProjects(prompt, currentProject, projects);
    if (promptTargets.length > 1) {
      store.setSessionError(
        sessionKey,
        '需求中包含多个已注册项目路径。请先明确选择一个目标项目，再开始任务。',
      );
      return;
    }
    if (promptTargets.length === 1) {
      if (!onSwitchProjectForPrompt) {
        store.setSessionError(sessionKey, '检测到另一个目标项目，但项目切换功能当前不可用。');
        return;
      }
      setPendingProjectSwitch({ project: promptTargets[0], prompt });
      return;
    }
    const effectiveAgentMode = modeOverride ?? agentMode;
    if (isWorkflowPlanMode(effectiveAgentMode)) {
      if (runtime.summary.source !== 'workbench') {
        store.setSessionError(sessionKey, 'Workflow 规划模式仅支持 Workbench 任务');
        return;
      }
      if (workflowStatus || workflowLookupPending) {
        store.setSessionError(
          sessionKey,
          workflowLookupPending ? '正在检查当前任务的 Workflow，请稍候' : '当前任务已经存在 Workflow',
        );
        return;
      }
      const selectedPermissionMode = workflowPermissionMode(permissionMode);
      const summary = runtime.summary;
      const sessionPatch = workflowSessionPatch(summary, prompt, selectedPermissionMode);
      const workflowMessageRunId = `workflow:${userMessageId}`;
      store.appendUserMessage(sessionKey, userMessageId, prompt, workflowMessageRunId);
      store.updateSessionSummary(sessionKey, sessionPatch);
      setWorkflowStarting(true);
      try {
        await submitWorkflowPlan({
          taskId: summary.id,
          prompt,
          userMessageId,
          ...(currentModel ? { currentModel } : {}),
          currentPermissionMode: selectedPermissionMode,
          sessionPatch,
        }, {
          saveUserMessage: async (taskId, content, messageId) => {
            await window.api.saveMessage(taskId, 'user', content, messageId);
          },
          updateSession: async (taskId, patch) => {
            await window.api.updateSession(taskId, patch);
          },
          createWorkflow: (input) => window.api.createWorkflow(input),
          startWorkflowPlanning: (workflowId) => window.api.startWorkflowPlanning(workflowId),
          onWorkflowChanged,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Workflow 规划启动失败';
        store.setSessionError(sessionKey, message);
      } finally {
        setWorkflowStarting(false);
      }
      return;
    }

    const runId = crypto.randomUUID();
    const cliPermissionMode = effectiveAgentMode === 'plan' || effectiveAgentMode === 'review'
      ? PERMISSION_MODE_MAP.plan
      : PERMISSION_MODE_MAP[permissionMode];
    const systemPrompt = effectiveAgentMode === 'plan'
      ? 'Workbench 规划模式：只分析、检查和制定执行计划，不得修改文件或执行会改变项目状态的命令。'
      : effectiveAgentMode === 'review'
        ? 'Workbench 审查模式：只审查现有代码并报告问题，不得修改文件或执行会改变项目状态的命令。'
        : effectiveAgentMode === 'develop'
          ? 'Workbench 开发模式：围绕用户目标实现并验证代码修改；所有工具调用仍须遵守 Claude Code 权限策略。'
          : undefined;
    const disallowedTools = (projectSettings?.disabledMcpServers ?? [])
      .map((name) => name.replace(/[^a-zA-Z0-9_-]/g, ''))
      .filter(Boolean)
      .map((name) => `mcp__${name}__*`);
    if (!store.tryStartRun(sessionKey, runId, {
      prompt,
      agentMode: effectiveAgentMode,
      userMessageId,
      model: currentModel || undefined,
    })) return;
    store.appendUserMessage(sessionKey, userMessageId, prompt, runId);

    const summary = useWorkspaceStore.getState().runtimes[sessionKey]?.summary ?? runtime.summary;
    try {
      if (summary.source === 'workbench') {
        await window.api.saveMessage(summary.id, 'user', prompt, userMessageId);
        if (summary.titleSource === 'default' || summary.title === 'New Task' || summary.title === '新任务') {
          const title = prompt.slice(0, 40);
          await window.api.updateSession(summary.id, {
            title,
            titleSource: 'first_prompt',
            status: 'running',
            permissionMode: cliPermissionMode,
          });
          store.updateSessionSummary(sessionKey, {
            title,
            titleSource: 'first_prompt',
            status: 'running',
            permissionMode: cliPermissionMode,
          });
        } else {
          await window.api.updateSession(summary.id, {
            status: 'running',
            permissionMode: cliPermissionMode,
          });
        }
      }

      await window.api.runPrompt({
        runId,
        projectKey: canonicalProjectKey(runtime.projectPath),
        sessionKey,
        projectPath: runtime.projectPath,
        prompt,
        resumeSessionId: summary.claudeSessionId
          || (summary.source === 'claude-code' ? summary.id : undefined),
        model: currentModel || undefined,
        permissionMode: cliPermissionMode,
        agentMode: effectiveAgentMode,
        systemPrompt,
        disallowedTools,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Claude Code 启动失败';
      store.finishTask(sessionKey, runId, { status: 'failed', message });
      store.updateSessionSummary(sessionKey, { error: message });
      if (summary.source === 'workbench') {
        await window.api.updateSession(summary.id, { status: 'failed' }).catch(() => undefined);
      }
    }
  };

  const sendTaskRef = useRef(send);
  sendTaskRef.current = send;
  useEffect(() => {
    const listener = (event: Event) => {
      const plan = (event as CustomEvent<{ plan?: boolean }>).detail?.plan;
      void sendTaskRef.current(plan ? 'plan' : undefined);
    };
    window.addEventListener('workbench:send-task', listener);
    return () => window.removeEventListener('workbench:send-task', listener);
  }, []);

  const stop = async () => {
    if (!runtime?.activeRunId || !sessionKey) return;
    const runId = runtime.activeRunId;
    const stopped = await window.api.stopRun(runId);
    if (!stopped) return;
    const store = useWorkspaceStore.getState();
    store.finishTask(sessionKey, runId, {
      status: 'cancelled',
      message: '用户停止了任务',
    });
    store.clearPermissionRequestsForRun(runId);
    if (runtime.summary.source === 'workbench') {
      await window.api.updateSession(runtime.summary.id, { status: 'cancelled' });
    }
  };

  if (!currentProject) {
    return (
      <div className="p-4" style={{ borderTop: '1px solid var(--border-primary)' }}>
        <button
          onClick={onOpenProject}
          className="mx-auto flex items-center gap-2 px-4 py-2 rounded-lg text-sm"
          style={{ background: 'var(--accent)', color: 'var(--accent-text)' }}
        >
          <FolderOpen size={15} /> 打开项目
        </button>
      </div>
    );
  }

  return (
    <>
    <div className="px-4 pb-4 pt-2" style={{ background: 'var(--bg-primary)' }}>
      <div className="max-w-[850px] mx-auto rounded-xl border shadow-sm" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-primary)' }}>
        <textarea
          key={sessionKey || 'no-session'}
          ref={textareaRef}
          value={runtime?.draft ?? ''}
          disabled={!runtime || runtime.summary.status === 'loading_history' || busy}
          onChange={(event) => {
            if (sessionKey) useWorkspaceStore.getState().setDraft(sessionKey, event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              event.stopPropagation();
              void send(event.shiftKey ? 'plan' : undefined);
            }
          }}
          placeholder={
            runtime?.summary.status === 'loading_history'
              ? '正在加载本会话…'
              : busy
                ? runtime?.summary.status === 'waiting_permission'
                  ? '请先处理权限请求，或停止任务'
                  : 'Claude 正在工作，可切换项目继续浏览'
                : '告诉 Claude 你想完成什么…'
          }
          rows={3}
          className="w-full resize-none bg-transparent px-4 pt-3 text-sm focus:outline-none disabled:opacity-60 selectable"
          style={{ color: 'var(--text-primary)' }}
        />
        <div className="flex items-center justify-between gap-2 px-3 pb-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
              Ctrl+Enter 发送 · Ctrl+Shift+Enter 规划模式 · Shift+Enter 换行
            </span>
            {modelProviderState ? (
              <TaskComposerModelSwitcherView
                modelProviderState={modelProviderState}
                busy={busy}
                open={modelSwitcherOpen}
                onOpenChange={setModelSwitcherOpen}
              />
            ) : null}
          </div>
          {runtimeBusy ? (
            <button
              onClick={() => void stop()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs"
              style={{ background: 'var(--error)', color: 'white' }}
              title="停止当前运行进程"
            >
              <Square size={11} fill="currentColor" /> 停止
            </button>
          ) : workflowBusy || workflowLookupPending || workflowStarting ? (
            <span className="px-2 py-1 text-[10px]" style={{ color: 'var(--text-tertiary)' }} data-testid="workflow-input-status">
              {workflowLookupPending
                ? '正在检查 Workflow…'
                : workflowStarting
                  ? '正在创建 Workflow…'
                  : '请在 Workflow 面板继续、暂停或取消'}
            </span>
          ) : (
            <button
              onClick={() => void send()}
              disabled={!runtime?.draft.trim() || runtime?.summary.status === 'loading_history'}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs disabled:opacity-40"
              style={{ background: 'var(--accent)', color: 'var(--accent-text)' }}
              title="发送 (Ctrl+Enter)"
            >
              <Send size={12} /> 发送
            </button>
          )}
        </div>
      </div>
    </div>
    {pendingProjectSwitch ? (
      <div className="fixed inset-0 z-[90] flex items-center justify-center p-6" style={{ background: 'var(--bg-overlay)' }}>
        <div className="w-full max-w-lg rounded-2xl border p-5 shadow-lg" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }} role="dialog" aria-modal="true" aria-label="确认切换目标项目" data-testid="prompt-project-switch-dialog">
          <h2 className="text-base font-semibold">需求指向另一个已注册项目</h2>
          <p className="mt-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
            Workbench 不会只改变 Claude 的工作目录。确认后将整体切换项目；Git、Checkpoint、Diff、文件监控和权限绑定会一起切换。
          </p>
          <div className="mt-4 space-y-2 rounded-xl border p-3 text-xs" style={{ borderColor: 'var(--border-secondary)' }}>
            <div className="break-all"><span style={{ color: 'var(--text-tertiary)' }}>当前项目：</span>{currentProject.path}</div>
            <div className="break-all"><span style={{ color: 'var(--text-tertiary)' }}>目标项目：</span>{pendingProjectSwitch.project.path}</div>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <button type="button" disabled={projectSwitching} onClick={() => setPendingProjectSwitch(null)} className="rounded-lg px-3 py-2 text-xs disabled:opacity-50" style={{ background: 'var(--bg-hover)' }} data-testid="prompt-project-switch-cancel">取消</button>
            <button
              type="button"
              disabled={projectSwitching}
              onClick={() => {
                const pending = pendingProjectSwitch;
                setProjectSwitching(true);
                void onSwitchProjectForPrompt?.(pending.project, pending.prompt)
                  .then(() => setPendingProjectSwitch(null))
                  .catch((error) => {
                    const state = useWorkspaceStore.getState();
                    if (state.currentSessionKey) {
                      state.setSessionError(
                        state.currentSessionKey,
                        error instanceof Error ? error.message : '切换目标项目失败',
                      );
                    }
                  })
                  .finally(() => setProjectSwitching(false));
              }}
              className="rounded-lg px-3 py-2 text-xs text-white disabled:opacity-50"
              style={{ background: 'var(--accent)' }}
              data-testid="prompt-project-switch-confirm"
            >
              {projectSwitching ? '切换中…' : '切换项目（不执行）'}
            </button>
          </div>
        </div>
      </div>
    ) : null}
    </>
  );
}
