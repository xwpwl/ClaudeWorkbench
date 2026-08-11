// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentCheckResult } from '../../../../shared/types/ipc';
import type { PublicModelProvider } from '../../../../shared/types/modelProviders';
import type { Project } from '../../../../shared/types/project';
import type { Workflow } from '../../../../shared/types/workflow';
import { setLocale } from '../../../i18n';
import {
  FIRST_RUN_READ_ONLY_PROMPT,
  FirstRunWizard,
  startFirstRunPlanner,
  type FirstRunPlannerDependencies,
  type FirstRunPlannerInput,
  type FirstRunWizardPort,
} from '../FirstRunWizard';

const NOW = '2026-08-09T08:00:00.000Z';
const project: Project = {
  id: 'project-1',
  name: 'Fixture',
  path: 'C:\\Projects\\Fixture',
  createdAt: NOW,
  lastOpenedAt: NOW,
};

const projectB: Project = {
  ...project,
  id: 'project-2',
  name: 'Replacement',
  path: 'C:\\Projects\\Replacement',
};

const environment: EnvironmentCheckResult = {
  node: { ok: true, version: 'v24.1.0', path: 'C:\\Node\\node.exe' },
  claude: { ok: false, version: null, path: null, installType: null },
  git: { ok: true, version: 'git 2.50.0', path: 'C:\\Git\\git.exe' },
  gitBash: { ok: false, path: null, configured: false },
  shell: { ok: true, name: 'PowerShell', path: 'powershell.exe' },
  projectDir: { ok: true, readable: true, writable: true },
};

const provider: PublicModelProvider = {
  id: 'mimo',
  name: 'MiMo',
  type: 'anthropic-compatible',
  apiFormat: 'anthropic-messages',
  runtimeType: 'claude-code',
  baseUrl: 'https://gateway.example',
  baseUrlPathRedacted: true,
  enabled: true,
  isDefault: true,
  configured: true,
  credentialSource: 'credential_store',
  capabilities: {
    supportsClaudeCode: true,
    supportsAgentWorkflow: true,
    supportsTools: true,
    supportsMCP: true,
    supportsStreaming: true,
    supportsVision: false,
  },
  supportedUses: ['chat', 'agent_task', 'claude_code', 'mcp_tools'],
  health: {
    state: 'connected',
    lastTestedAt: Date.UTC(2026, 7, 9),
    lastErrorType: null,
    latencyMs: 42,
  },
  defaultModelId: 'mimo-v2.5-pro',
  createdAt: 1,
  updatedAt: 2,
};

function projectWorkflow(
  targetProject: Project,
  status: Workflow['status'] = 'waiting_plan_confirmation',
  id = 'workflow-1',
): Workflow {
  return {
    id,
    taskId: 'task-1',
    projectId: targetProject.id,
    projectPath: targetProject.path,
    prompt: FIRST_RUN_READ_ONLY_PROMPT,
    status,
    currentStage: status === 'planning' ? 'planner' : null,
    modelPolicy: {},
    plan: null,
    latestReview: null,
    reviewRound: 0,
    maxReviewRounds: 3,
    fixRound: 0,
    maxFixRounds: 3,
    revision: 1,
    pausedFrom: null,
    failure: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function workflow(status: Workflow['status'] = 'waiting_plan_confirmation'): Workflow {
  return projectWorkflow(project, status);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function port(overrides: Partial<FirstRunWizardPort> = {}): FirstRunWizardPort {
  return {
    checkEnvironment: vi.fn(async () => environment),
    listModelProviders: vi.fn(async () => ({ items: [provider], total: 1, limit: 25, offset: 0 })),
    onModelProviderChanged: vi.fn(() => () => undefined),
    createFirstRunTestProject: vi.fn(async () => project),
    setFirstRunCompletedVersion: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderWizard(options: {
  api?: FirstRunWizardPort;
  completionReadFailed?: boolean;
  initialProject?: Project | null;
  onOpenProviderCenter?: () => void;
  onOpenProject?: () => Promise<Project | null>;
  onSelectProject?: (value: Project) => Promise<void>;
  onStartPlanner?: (value: Project) => Promise<Workflow>;
  onDone?: () => void;
  projectIncarnation?: number;
} = {}) {
  const IncarnationAwareWizard = FirstRunWizard as React.ComponentType<
    React.ComponentProps<typeof FirstRunWizard> & { projectIncarnation?: number }
  >;
  const props = {
    api: options.api ?? port(),
    completionReadFailed: options.completionReadFailed ?? false,
    initialProject: options.initialProject ?? null,
    onOpenProviderCenter: options.onOpenProviderCenter ?? vi.fn(),
    onOpenProject: options.onOpenProject ?? vi.fn(async () => null),
    onSelectProject: options.onSelectProject ?? vi.fn(async () => undefined),
    onStartPlanner: options.onStartPlanner ?? vi.fn(async () => workflow()),
    onDone: options.onDone ?? vi.fn(),
    projectIncarnation: options.projectIncarnation ?? 0,
  };
  return { ...render(<IncarnationAwareWizard {...props} />), props };
}

async function advanceToProvider(user = userEvent.setup()) {
  await screen.findByRole('dialog', { name: '欢迎使用 Claude Workbench' });
  await screen.findByText('Git Bash');
  await user.click(screen.getByRole('button', { name: '继续' }));
  return user;
}

async function advanceToProject(user = userEvent.setup()) {
  await advanceToProvider(user);
  await user.click(await screen.findByRole('button', { name: '继续' }));
  return user;
}

async function advanceToProviderEnglish(user = userEvent.setup()) {
  await screen.findByRole('dialog', { name: 'Welcome to Claude Workbench' });
  await screen.findByText('Default shell');
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  return user;
}

async function advanceToProjectEnglish(user = userEvent.setup()) {
  await advanceToProviderEnglish(user);
  await user.click(await screen.findByRole('button', { name: 'Continue' }));
  return user;
}

afterEach(cleanup);

beforeEach(() => setLocale('zh-CN'));

describe('FirstRunWizard', () => {
  it('does not present an unresolved Planner result after project A -> B -> A incarnation changes', async () => {
    setLocale('en-US');
    const pending = deferred<Workflow>();
    const api = port();
    const onStartPlanner = vi.fn(() => pending.promise);
    const IncarnationAwareWizard = FirstRunWizard as React.ComponentType<
      React.ComponentProps<typeof FirstRunWizard> & { projectIncarnation: number }
    >;
    const baseProps = {
      api,
      onOpenProviderCenter: vi.fn(),
      onOpenProject: vi.fn(async () => null),
      onSelectProject: vi.fn(async () => undefined),
      onStartPlanner,
      onDone: vi.fn(),
    };
    const view = render(
      <IncarnationAwareWizard {...baseProps} initialProject={project} projectIncarnation={1} />,
    );
    const user = await advanceToProjectEnglish();
    await user.click(screen.getByRole('button', { name: 'Continue with Fixture' }));
    await user.click(await screen.findByRole('button', { name: 'Generate read-only plan' }));

    view.rerender(
      <IncarnationAwareWizard {...baseProps} initialProject={project} projectIncarnation={2} />,
    );
    await act(async () => Promise.resolve());
    view.rerender(
      <IncarnationAwareWizard {...baseProps} initialProject={project} projectIncarnation={3} />,
    );
    await act(async () => pending.resolve(workflow()));

    expect(screen.queryByText('Plan generated and waiting for your confirmation.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Generate read-only plan' })).not.toBeNull();
    expect(onStartPlanner).toHaveBeenCalledOnce();
  });

  it('fails closed into a recoverable environment step when completion read failed', async () => {
    renderWizard({ completionReadFailed: true });
    expect((await screen.findByRole('alert')).textContent).toContain('无法读取首次设置状态');
    expect(await screen.findByText('Git Bash')).not.toBeNull();
    expect(screen.getByText('默认 Shell')).not.toBeNull();
  });

  it('keeps environment failures non-blocking and never completes when continuing', async () => {
    const api = port({ checkEnvironment: vi.fn(async () => environment) });
    renderWizard({ api });
    const user = await advanceToProvider();
    expect(screen.getByRole('heading', { name: '模型与连接' })).not.toBeNull();
    expect(api.setFirstRunCompletedVersion).not.toHaveBeenCalled();
    expect(user).toBeTruthy();
  });

  it('refreshes the environment on A -> B -> A and ignores the first incarnation', async () => {
    const first = deferred<EnvironmentCheckResult>();
    const api = port({
      checkEnvironment: vi.fn()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce({ ...environment, shell: { ok: true, name: 'Current Shell', path: null } }),
    });
    renderWizard({ api });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '继续' }));
    await user.click(screen.getByRole('button', { name: '返回' }));
    expect(await screen.findByText('Current Shell')).not.toBeNull();
    await act(async () => first.resolve({ ...environment, shell: { ok: true, name: 'Stale Shell', path: null } }));
    expect(screen.queryByText('Stale Shell')).toBeNull();
  });

  it('opens the existing Provider Center and keeps the wizard on the Provider step', async () => {
    const onOpenProviderCenter = vi.fn();
    renderWizard({ onOpenProviderCenter });
    const user = await advanceToProvider();
    await user.click(screen.getByRole('button', { name: '配置模型' }));
    expect(onOpenProviderCenter).toHaveBeenCalledOnce();
    expect(screen.getByRole('heading', { name: '模型与连接' })).not.toBeNull();
  });

  it('keeps a Provider-step completion write failure visible and retryable', async () => {
    setLocale('en-US');
    const api = port({
      setFirstRunCompletedVersion: vi.fn(async () => {
        throw new Error('private database path');
      }),
    });
    const onDone = vi.fn();
    renderWizard({ api, onDone });
    const user = await advanceToProviderEnglish();

    await user.click(screen.getByRole('button', { name: 'Complete later' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'The first-run setup status could not be saved. Try again.',
    );
    expect(screen.getByRole('heading', { name: 'Models & Connections' })).not.toBeNull();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('shows a distinct safe Provider load failure and retries without pretending the list is empty', async () => {
    setLocale('en-US');
    const api = port({
      listModelProviders: vi.fn()
        .mockRejectedValueOnce(new Error('https://private.example/token'))
        .mockResolvedValueOnce({ items: [provider], total: 1, limit: 25, offset: 0 }),
    });
    renderWizard({ api });
    const user = await advanceToProviderEnglish();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Providers could not be loaded. Try again.');
    expect(alert.textContent).not.toContain('private.example');
    expect(screen.queryByText('No Provider is configured yet. You can continue and finish configuration later.')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('MiMo')).not.toBeNull();
    await waitFor(() => expect(screen.queryByText('Providers could not be loaded. Try again.')).toBeNull());
  });

  it('renders a configured Provider with failed health as a connection failure', async () => {
    setLocale('en-US');
    const failedProvider: PublicModelProvider = {
      ...provider,
      health: {
        state: 'error',
        lastTestedAt: Date.UTC(2026, 7, 9),
        lastErrorType: 'network',
        latencyMs: null,
      },
    };
    renderWizard({ api: port({
      listModelProviders: vi.fn(async () => ({ items: [failedProvider], total: 1, limit: 25, offset: 0 })),
    }) });
    await advanceToProviderEnglish();

    expect(await screen.findByText(/Connection failed.*Runtime: claude-code/iu)).not.toBeNull();
    expect(screen.queryByText(/Configured.*Runtime: claude-code/iu)).toBeNull();
  });

  it('uses latest-request-wins when a Provider refresh overtakes the initial page', async () => {
    const initial = deferred<Awaited<ReturnType<FirstRunWizardPort['listModelProviders']>>>();
    let notify = () => undefined;
    const api = port({
      listModelProviders: vi.fn()
        .mockReturnValueOnce(initial.promise)
        .mockResolvedValueOnce({ items: [{ ...provider, name: 'Current Provider' }], total: 1, limit: 25, offset: 0 }),
      onModelProviderChanged: vi.fn((listener) => {
        notify = listener;
        return () => undefined;
      }),
    });
    renderWizard({ api });
    await advanceToProvider();
    act(() => notify());
    expect(await screen.findByText('Current Provider')).not.toBeNull();
    await act(async () => initial.resolve({ items: [{ ...provider, name: 'Stale Provider' }], total: 1, limit: 25, offset: 0 }));
    expect(screen.queryByText('Stale Provider')).toBeNull();
    expect(screen.getByText('Current Provider')).not.toBeNull();
  });

  it('rejects a late Provider result across a synchronous A -> B -> A step incarnation', async () => {
    const first = deferred<Awaited<ReturnType<FirstRunWizardPort['listModelProviders']>>>();
    const api = port({
      listModelProviders: vi.fn()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce({ items: [{ ...provider, name: 'Current Provider' }], total: 1, limit: 25, offset: 0 }),
    });
    renderWizard({ api });
    const user = await advanceToProvider();
    await user.click(screen.getByRole('button', { name: '返回' }));
    await user.click(screen.getByRole('button', { name: '继续' }));
    expect(await screen.findByText('Current Provider')).not.toBeNull();
    await act(async () => first.resolve({ items: [{ ...provider, name: 'Stale Provider' }], total: 1, limit: 25, offset: 0 }));
    expect(screen.queryByText('Stale Provider')).toBeNull();
  });

  it('treats native picker cancellation as no-op and writes no completion state', async () => {
    const api = port();
    const onOpenProject = vi.fn(async () => null);
    renderWizard({ api, onOpenProject });
    const user = await advanceToProject();
    await user.click(screen.getByRole('button', { name: '打开项目' }));
    expect(onOpenProject).toHaveBeenCalledOnce();
    expect(screen.getByRole('heading', { name: '选择项目' })).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(api.setFirstRunCompletedVersion).not.toHaveBeenCalled();
  });

  it('does not duplicate the native open-project registration and selection path', async () => {
    const onSelectProject = vi.fn(async () => undefined);
    renderWizard({ onOpenProject: vi.fn(async () => project), onSelectProject });
    const user = await advanceToProject();
    await user.click(screen.getByRole('button', { name: '打开项目' }));
    expect(await screen.findByText('Fixture')).not.toBeNull();
    expect(onSelectProject).not.toHaveBeenCalled();
  });

  it('calls contained test-project creation with zero arguments and selects the trusted result', async () => {
    const api = port();
    const onSelectProject = vi.fn(async () => undefined);
    renderWizard({ api, onSelectProject });
    const user = await advanceToProject();
    await user.click(screen.getByRole('button', { name: '创建测试项目' }));
    await waitFor(() => expect(onSelectProject).toHaveBeenCalledWith(project));
    expect(api.createFirstRunTestProject).toHaveBeenCalledWith();
    expect(screen.getByText('Fixture')).not.toBeNull();
  });

  it('shows only a safe localized project failure without raw path or error sentinels', async () => {
    const api = port({
      createFirstRunTestProject: vi.fn(async () => {
        throw new Error('EACCES C:\\Users\\secret-owner mutation-123 vault-secret');
      }),
    });
    renderWizard({ api });
    const user = await advanceToProject();
    await user.click(screen.getByRole('button', { name: '创建测试项目' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('无法创建测试项目');
    expect(alert.textContent).not.toMatch(/Users|secret-owner|mutation-123|vault-secret|EACCES/iu);
  });

  it('visibly skips the first task when project selection is skipped', async () => {
    const onStartPlanner = vi.fn(async () => workflow());
    renderWizard({ onStartPlanner });
    const user = await advanceToProject();
    await user.click(screen.getByRole('button', { name: '跳过项目' }));
    expect(await screen.findByText('未选择项目，已跳过只读示例任务。')).not.toBeNull();
    expect(onStartPlanner).not.toHaveBeenCalled();
  });

  it('stops after the read-only Planner reaches plan confirmation', async () => {
    const onStartPlanner = vi.fn(async () => workflow('waiting_plan_confirmation'));
    renderWizard({ initialProject: project, onStartPlanner });
    const user = await advanceToProject();
    await user.click(screen.getByRole('button', { name: '继续使用 Fixture' }));
    await user.click(await screen.findByRole('button', { name: '生成只读计划' }));
    await waitFor(() => expect(onStartPlanner).toHaveBeenCalledWith(project));
    expect(await screen.findByText('计划已生成，正在等待你的确认。')).not.toBeNull();
    expect(screen.getByText(/Plan.*Timeline.*Review/iu)).not.toBeNull();
  });

  it('invalidates a ready plan when the selected project changes', async () => {
    setLocale('en-US');
    const onStartPlanner = vi.fn(async (selected: Project) => projectWorkflow(selected));
    renderWizard({
      initialProject: project,
      onOpenProject: vi.fn(async () => projectB),
      onStartPlanner,
    });
    const user = await advanceToProjectEnglish();
    await user.click(screen.getByRole('button', { name: 'Continue with Fixture' }));
    await user.click(await screen.findByRole('button', { name: 'Generate read-only plan' }));
    expect(await screen.findByText('The plan is ready and waiting for your confirmation.')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Open project' }));
    expect(await screen.findByText('Replacement')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Continue with Replacement' }));

    expect(screen.queryByText('The plan is ready and waiting for your confirmation.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Generate read-only plan' })).not.toBeNull();
  });

  it('invalidates a ready plan synchronously when the project is skipped', async () => {
    setLocale('en-US');
    renderWizard({ initialProject: project });
    const user = await advanceToProjectEnglish();
    await user.click(screen.getByRole('button', { name: 'Continue with Fixture' }));
    await user.click(await screen.findByRole('button', { name: 'Generate read-only plan' }));
    expect(await screen.findByText('The plan is ready and waiting for your confirmation.')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Skip project' }));

    expect(await screen.findByText('No project was selected, so the read-only example task was skipped.')).not.toBeNull();
    expect(screen.queryByText('The plan is ready and waiting for your confirmation.')).toBeNull();
  });

  it('keeps Planner failure retryable and never writes completion', async () => {
    const api = port();
    const onStartPlanner = vi.fn()
      .mockRejectedValueOnce(new Error('C:\\secret\\raw-provider-error'))
      .mockResolvedValueOnce(workflow());
    renderWizard({ api, initialProject: project, onStartPlanner });
    const user = await advanceToProject();
    await user.click(screen.getByRole('button', { name: '继续使用 Fixture' }));
    await user.click(await screen.findByRole('button', { name: '生成只读计划' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('无法生成只读计划');
    expect(alert.textContent).not.toContain('raw-provider-error');
    expect(api.setFirstRunCompletedVersion).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '重试生成计划' }));
    expect(await screen.findByText('计划已生成，正在等待你的确认。')).not.toBeNull();
  });

  it('locks Complete later while a project operation is busy', async () => {
    const pending = deferred<Project>();
    const api = port({ createFirstRunTestProject: vi.fn(() => pending.promise) });
    renderWizard({ api });
    const user = await advanceToProject();
    await user.click(screen.getByRole('button', { name: '创建测试项目' }));
    expect(screen.getByRole('button', { name: '稍后完成' }).hasAttribute('disabled')).toBe(true);
    expect(api.setFirstRunCompletedVersion).not.toHaveBeenCalled();
    await act(async () => pending.resolve(project));
  });

  it('writes version 1 only after explicit Complete later and stays open on write failure', async () => {
    const api = port({ setFirstRunCompletedVersion: vi.fn(async () => { throw new Error('database path sentinel'); }) });
    const onDone = vi.fn();
    renderWizard({ api, onDone });
    const user = userEvent.setup();
    await screen.findByRole('dialog', { name: '欢迎使用 Claude Workbench' });
    await user.click(screen.getByRole('button', { name: '稍后完成' }));
    expect(api.setFirstRunCompletedVersion).toHaveBeenCalledWith(1);
    expect((await screen.findByRole('alert')).textContent).toContain('无法保存首次设置状态');
    expect(screen.getByRole('dialog', { name: '欢迎使用 Claude Workbench' })).not.toBeNull();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('completes only after explicit Finish setup and returns focus to the opener', async () => {
    const api = port();
    function Harness() {
      const [open, setOpen] = React.useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>打开首次设置</button>
        {open ? <FirstRunWizard
          api={api}
          initialProject={null}
          onOpenProviderCenter={vi.fn()}
          onOpenProject={vi.fn(async () => null)}
          onSelectProject={vi.fn(async () => undefined)}
          onStartPlanner={vi.fn(async () => workflow())}
          onDone={() => setOpen(false)}
        /> : null}
      </>;
    }
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: '打开首次设置' });
    await user.click(opener);
    await advanceToProject(user);
    await user.click(screen.getByRole('button', { name: '跳过项目' }));
    await user.click(await screen.findByRole('button', { name: '完成设置' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '欢迎使用 Claude Workbench' })).toBeNull());
    expect(api.setFirstRunCompletedVersion).toHaveBeenCalledWith(1);
    expect(document.activeElement).toBe(opener);
  });

  it('does not dismiss or complete on Escape and keeps focus trapped', async () => {
    const api = port();
    renderWizard({ api });
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: '欢迎使用 Claude Workbench' });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: '欢迎使用 Claude Workbench' })).not.toBeNull();
    expect(api.setFirstRunCompletedVersion).not.toHaveBeenCalled();
  });

  it('is StrictMode-safe and completes exactly once from an explicit action', async () => {
    const api = port();
    const onDone = vi.fn();
    render(
      <React.StrictMode>
        <FirstRunWizard
          api={api}
          initialProject={null}
          onOpenProviderCenter={vi.fn()}
          onOpenProject={vi.fn(async () => null)}
          onSelectProject={vi.fn(async () => undefined)}
          onStartPlanner={vi.fn(async () => workflow())}
          onDone={onDone}
        />
      </React.StrictMode>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '稍后完成' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(api.setFirstRunCompletedVersion).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape ownership to a nested Provider Settings dialog', async () => {
    const api = port();
    function Harness() {
      const [nested, setNested] = React.useState(false);
      return <>
        <FirstRunWizard
          api={api}
          initialProject={null}
          onOpenProviderCenter={() => setNested(true)}
          onOpenProject={vi.fn(async () => null)}
          onSelectProject={vi.fn(async () => undefined)}
          onStartPlanner={vi.fn(async () => workflow())}
          onDone={vi.fn()}
        />
        {nested ? <div role="dialog" aria-modal="true" aria-label="Provider Settings"><button type="button" onClick={() => setNested(false)}>Close settings</button></div> : null}
      </>;
    }
    render(<Harness />);
    const user = await advanceToProvider();
    await user.click(screen.getByRole('button', { name: '配置模型' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Provider Settings' })).not.toBeNull();
    expect(screen.getByRole('dialog', { name: '欢迎使用 Claude Workbench' })).not.toBeNull();
    expect(api.setFirstRunCompletedVersion).not.toHaveBeenCalled();
  });

  it('keeps a long Provider name accessible inside the bounded narrow-safe shell', async () => {
    const name = 'A very long trusted Provider display name that must stay complete for assistive technology';
    renderWizard({ api: port({
      listModelProviders: vi.fn(async () => ({ items: [{ ...provider, name }], total: 1, limit: 25, offset: 0 })),
    }) });
    await advanceToProvider();
    const label = await screen.findByText(name);
    expect(label.getAttribute('title')).toBe(name);
    expect(screen.getByRole('dialog').className).toContain('max-w-2xl');
    expect(label.className).toContain('truncate');
  });

  it('renders the touched surface fully in English', async () => {
    setLocale('en-US');
    renderWizard();
    expect(await screen.findByRole('dialog', { name: 'Welcome to Claude Workbench' })).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Environment check' })).not.toBeNull();
    expect(screen.getByText('Default shell')).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/欢迎|继续|稍后完成|环境检查/u);
  });
});

describe('startFirstRunPlanner', () => {
  it('rejects unresolved Planner work after selection incarnation A -> B -> A and never adopts', async () => {
    type IncarnationIdentity = ReturnType<FirstRunPlannerDependencies['currentIdentity']> & {
      selectionIncarnation: number;
    };
    type IncarnationInput = FirstRunPlannerInput & { selectionIncarnation: number };
    type IncarnationDependencies = Omit<FirstRunPlannerDependencies, 'currentIdentity'> & {
      currentIdentity(): IncarnationIdentity;
    };
    const planner = startFirstRunPlanner as unknown as (
      input: IncarnationInput,
      dependencies: IncarnationDependencies,
    ) => Promise<Workflow>;
    const pending = deferred<Workflow>();
    const adopt = vi.fn();
    let selectionIncarnation = 1;
    const operation = planner({
      project,
      task: {
        id: 'task-1', projectId: project.id, projectPath: project.path,
        title: 'New Task', titleSource: 'default',
      },
      selectionIncarnation: 1,
    }, {
      currentIdentity: () => ({
        taskId: 'task-1',
        projectId: project.id,
        projectPath: project.path,
        selectionIncarnation,
      }),
      randomUUID: () => 'message-1',
      saveUserMessage: async () => undefined,
      updateSession: async () => undefined,
      createWorkflow: async () => workflow('idle'),
      startWorkflowPlanning: () => pending.promise,
      onWorkflowChanged: adopt,
    });

    selectionIncarnation = 2;
    selectionIncarnation = 3;
    pending.resolve(workflow());

    await expect(operation).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' });
    expect(adopt).not.toHaveBeenCalled();
  });

  it('uses the exact prompt, Plan permission, and stops at confirmation', async () => {
    const calls: string[] = [];
    const result = await startFirstRunPlanner({
      project,
      task: {
        id: 'task-1',
        projectId: project.id,
        projectPath: project.path,
        title: '新任务',
        titleSource: 'default',
      },
      selectionIncarnation: 1,
      currentModel: 'mimo-v2.5-pro',
    }, {
      currentIdentity: () => ({
        taskId: 'task-1', projectId: project.id, projectPath: project.path,
        selectionIncarnation: 1,
      }),
      randomUUID: () => 'message-1',
      saveUserMessage: async (_taskId, content) => { calls.push(`message:${content}`); },
      updateSession: async (_taskId, patch) => { calls.push(`session:${patch.permissionMode}`); },
      createWorkflow: async (input) => {
        calls.push(`create:${input.currentPermissionMode}:${input.prompt}`);
        return workflow('idle');
      },
      startWorkflowPlanning: async () => {
        calls.push('planning');
        return workflow('waiting_plan_confirmation');
      },
    });

    expect(result.status).toBe('waiting_plan_confirmation');
    expect(calls).toEqual([
      `message:${FIRST_RUN_READ_ONLY_PROMPT}`,
      'session:plan',
      `create:plan:${FIRST_RUN_READ_ONLY_PROMPT}`,
      'planning',
    ]);
  });

  it('rejects a stale project/task identity before adopting a completed Planner result', async () => {
    let current = true;
    await expect(startFirstRunPlanner({
      project,
      task: {
        id: 'task-1', projectId: project.id, projectPath: project.path,
        title: '新任务', titleSource: 'default',
      },
      selectionIncarnation: 1,
    }, {
      currentIdentity: () => current
        ? { taskId: 'task-1', projectId: project.id, projectPath: project.path, selectionIncarnation: 1 }
        : { taskId: 'task-2', projectId: project.id, projectPath: project.path, selectionIncarnation: 1 },
      randomUUID: () => 'message-1',
      saveUserMessage: async () => undefined,
      updateSession: async () => undefined,
      createWorkflow: async () => workflow('idle'),
      startWorkflowPlanning: async () => {
        current = false;
        return workflow();
      },
    })).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' });
  });

  it('adopts only the exact validated final Workflow once', async () => {
    const created = { ...workflow('idle'), revision: 1 };
    const planned = { ...workflow('waiting_plan_confirmation'), revision: 2 };
    const adopt = vi.fn();

    const result = await startFirstRunPlanner({
      project,
      task: {
        id: 'task-1', projectId: project.id, projectPath: project.path,
        title: 'New Task', titleSource: 'default',
      },
      selectionIncarnation: 1,
    }, {
      currentIdentity: () => ({
        taskId: 'task-1', projectId: project.id, projectPath: project.path,
        selectionIncarnation: 1,
      }),
      randomUUID: () => 'message-1',
      saveUserMessage: async () => undefined,
      updateSession: async () => undefined,
      createWorkflow: async () => created,
      startWorkflowPlanning: async () => planned,
      onWorkflowChanged: adopt,
    });

    expect(result).toBe(planned);
    expect(adopt).toHaveBeenCalledOnce();
    expect(adopt).toHaveBeenCalledWith(planned);
  });

  it.each([
    {
      name: 'planning rejection',
      plan: async () => { throw new Error('planner failed'); },
      code: undefined,
    },
    {
      name: 'non-confirmation status',
      plan: async () => workflow('planning'),
      code: 'PLAN_NOT_READY',
    },
    {
      name: 'changed canonical project path',
      plan: async () => ({ ...workflow(), projectPath: 'C:\\Projects\\Other' }),
      code: 'IDENTITY_CHANGED',
    },
  ])('does not adopt created or final Workflow after $name', async ({ plan, code }) => {
    const adopt = vi.fn();
    const operation = startFirstRunPlanner({
      project,
      task: {
        id: 'task-1', projectId: project.id, projectPath: project.path,
        title: 'New Task', titleSource: 'default',
      },
      selectionIncarnation: 1,
    }, {
      currentIdentity: () => ({
        taskId: 'task-1', projectId: project.id, projectPath: project.path,
        selectionIncarnation: 1,
      }),
      randomUUID: () => 'message-1',
      saveUserMessage: async () => undefined,
      updateSession: async () => undefined,
      createWorkflow: async () => workflow('idle'),
      startWorkflowPlanning: plan,
      onWorkflowChanged: adopt,
    });

    if (code) await expect(operation).rejects.toMatchObject({ code });
    else await expect(operation).rejects.toThrow('planner failed');
    expect(adopt).not.toHaveBeenCalled();
  });
});
