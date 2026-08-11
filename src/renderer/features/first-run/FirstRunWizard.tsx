import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot,
  CheckCircle2,
  ChevronRight,
  FolderOpen,
  Loader2,
  Settings2,
  Sparkles,
} from 'lucide-react';
import { canonicalProjectKey } from '../../../shared/sessionIdentity';
import type { EnvironmentCheckResult } from '../../../shared/types/ipc';
import type { PublicModelProvider } from '../../../shared/types/modelProviders';
import type { Project } from '../../../shared/types/project';
import type { Workflow } from '../../../shared/types/workflow';
import { t } from '../../i18n';
import { EnvironmentStatusList } from '../settings/EnvironmentCheck';
import { submitWorkflowPlan, workflowSessionPatch } from '../chat/InputBar';

export const FIRST_RUN_READ_ONLY_PROMPT = 'Analyze this project structure without modifying files.';

type FirstRunStep = 'environment' | 'provider' | 'project' | 'first_task' | 'completing';

interface ProviderPage {
  items: PublicModelProvider[];
  total: number;
  limit: number;
  offset: number;
}

interface ReadyPlan {
  projectId: string;
  projectPath: string;
  workflowId: string;
}

export interface FirstRunWizardPort {
  checkEnvironment(): Promise<EnvironmentCheckResult>;
  listModelProviders(): Promise<ProviderPage>;
  onModelProviderChanged(listener: () => void): () => void;
  createFirstRunTestProject(): Promise<Project>;
  setFirstRunCompletedVersion(version: 1): Promise<void>;
}

interface FirstRunWizardProps {
  api: FirstRunWizardPort;
  completionReadFailed?: boolean;
  initialProject: Project | null;
  projectIncarnation?: number;
  onOpenProviderCenter(): void;
  onOpenProject(): Promise<Project | null>;
  onSelectProject(project: Project): Promise<void>;
  onStartPlanner(project: Project): Promise<Workflow>;
  onDone(): void;
}

interface PlannerTaskIdentity {
  id: string;
  projectId: string;
  projectPath: string;
  title: string;
  titleSource?: 'default' | 'first_prompt' | 'manual' | 'custom' | 'summary';
}

interface CurrentPlannerIdentity {
  taskId: string;
  projectId: string;
  projectPath: string;
  selectionIncarnation: number;
}

export interface FirstRunPlannerInput {
  project: Project;
  task: PlannerTaskIdentity;
  selectionIncarnation: number;
  currentModel?: string;
}

export interface FirstRunPlannerDependencies {
  currentIdentity(): CurrentPlannerIdentity | null;
  randomUUID(): string;
  saveUserMessage(taskId: string, content: string, messageId: string): Promise<void>;
  updateSession(taskId: string, patch: ReturnType<typeof workflowSessionPatch>): Promise<void>;
  createWorkflow: Parameters<typeof submitWorkflowPlan>[1]['createWorkflow'];
  startWorkflowPlanning: Parameters<typeof submitWorkflowPlan>[1]['startWorkflowPlanning'];
  onWorkflowChanged?: Parameters<typeof submitWorkflowPlan>[1]['onWorkflowChanged'];
}

class FirstRunPlannerError extends Error {
  constructor(public readonly code: 'IDENTITY_CHANGED' | 'PLAN_NOT_READY') {
    super(code);
    this.name = 'FirstRunPlannerError';
  }
}

function identityMatches(
  expected: FirstRunPlannerInput,
  current: CurrentPlannerIdentity | null,
): boolean {
  return Boolean(
    current
    && current.taskId === expected.task.id
    && current.projectId === expected.project.id
    && current.selectionIncarnation === expected.selectionIncarnation
    && expected.task.projectId === expected.project.id
    && canonicalProjectKey(current.projectPath) === canonicalProjectKey(expected.project.path)
    && canonicalProjectKey(expected.task.projectPath) === canonicalProjectKey(expected.project.path),
  );
}

function projectIdentityMatches(
  left: Pick<Project, 'id' | 'path'> | null,
  right: Pick<Project, 'id' | 'path'> | null,
): boolean {
  return Boolean(
    left
    && right
    && left.id === right.id
    && canonicalProjectKey(left.path) === canonicalProjectKey(right.path),
  );
}

/** Starts only Planner and adopts the result only after identity and status revalidation. */
export async function startFirstRunPlanner(
  input: FirstRunPlannerInput,
  dependencies: FirstRunPlannerDependencies,
): Promise<Workflow> {
  if (!identityMatches(input, dependencies.currentIdentity())) {
    throw new FirstRunPlannerError('IDENTITY_CHANGED');
  }

  const permissionMode = 'plan' as const;
  const sessionPatch = workflowSessionPatch(input.task, FIRST_RUN_READ_ONLY_PROMPT, permissionMode);
  const planned = await submitWorkflowPlan({
    taskId: input.task.id,
    prompt: FIRST_RUN_READ_ONLY_PROMPT,
    userMessageId: dependencies.randomUUID(),
    ...(input.currentModel ? { currentModel: input.currentModel } : {}),
    currentPermissionMode: permissionMode,
    sessionPatch,
  }, {
    saveUserMessage: dependencies.saveUserMessage,
    updateSession: dependencies.updateSession,
    createWorkflow: dependencies.createWorkflow,
    startWorkflowPlanning: dependencies.startWorkflowPlanning,
  });

  if (!identityMatches(input, dependencies.currentIdentity())
    || planned.taskId !== input.task.id
    || planned.projectId !== input.project.id
    || canonicalProjectKey(planned.projectPath) !== canonicalProjectKey(input.project.path)) {
    throw new FirstRunPlannerError('IDENTITY_CHANGED');
  }
  if (planned.status !== 'waiting_plan_confirmation') {
    throw new FirstRunPlannerError('PLAN_NOT_READY');
  }
  dependencies.onWorkflowChanged?.(planned);
  return planned;
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function providerStatus(provider: PublicModelProvider): string {
  switch (provider.health.state) {
    case 'connected': return t('provider.health.connected');
    case 'error': return t('provider.health.failed');
    case 'configured': return t('provider.health.configured');
    case 'not_configured': return t('provider.health.unconfigured');
  }
}

function providerStatusColor(provider: PublicModelProvider): string {
  if (provider.health.state === 'connected') return 'var(--success)';
  if (provider.health.state === 'error') return 'var(--error)';
  return 'var(--warning)';
}

export function FirstRunWizard({
  api,
  completionReadFailed = false,
  initialProject,
  projectIncarnation = 0,
  onOpenProviderCenter,
  onOpenProject,
  onSelectProject,
  onStartPlanner,
  onDone,
}: FirstRunWizardProps) {
  const [step, setStep] = useState<FirstRunStep>('environment');
  const [environment, setEnvironment] = useState<EnvironmentCheckResult | null>(null);
  const [environmentFailed, setEnvironmentFailed] = useState(false);
  const [providers, setProviders] = useState<PublicModelProvider[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providersLoadFailed, setProvidersLoadFailed] = useState(false);
  const [selectedProject, setSelectedProject] = useState<Project | null>(initialProject);
  const [projectSkipped, setProjectSkipped] = useState(false);
  const [readyPlan, setReadyPlan] = useState<ReadyPlan | null>(null);
  const [plannerFailed, setPlannerFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const stepRef = useRef<FirstRunStep>('environment');
  const stepScopeRef = useRef(0);
  const operationEpochRef = useRef(0);
  const providerEpochRef = useRef(0);
  const environmentEpochRef = useRef(0);
  const incomingProjectIdentity = initialProject
    ? `${projectIncarnation}\u0000${initialProject.id}\u0000${canonicalProjectKey(initialProject.path)}`
    : `${projectIncarnation}\u0000`;
  const incomingProjectIdentityRef = useRef(incomingProjectIdentity);
  const appliedProjectIdentityRef = useRef(incomingProjectIdentity);
  if (incomingProjectIdentityRef.current !== incomingProjectIdentity) {
    incomingProjectIdentityRef.current = incomingProjectIdentity;
    operationEpochRef.current += 1;
    stepScopeRef.current += 1;
  }
  const completionFromRef = useRef<Exclude<FirstRunStep, 'completing'>>('environment');
  const focusOriginRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  const goToStep = useCallback((next: FirstRunStep) => {
    stepScopeRef.current += 1;
    stepRef.current = next;
    setError(null);
    setStep(next);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    queueMicrotask(() => dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus());
    return () => {
      mountedRef.current = false;
      queueMicrotask(() => {
        if (!mountedRef.current) focusOriginRef.current?.focus();
      });
    };
  }, []);

  const loadEnvironment = useCallback(async () => {
    const epoch = ++environmentEpochRef.current;
    const scope = stepScopeRef.current;
    setEnvironment(null);
    setEnvironmentFailed(false);
    try {
      const result = await api.checkEnvironment();
      if (mountedRef.current
        && environmentEpochRef.current === epoch
        && stepScopeRef.current === scope
        && stepRef.current === 'environment') setEnvironment(result);
    } catch {
      if (mountedRef.current
        && environmentEpochRef.current === epoch
        && stepScopeRef.current === scope
        && stepRef.current === 'environment') setEnvironmentFailed(true);
    }
  }, [api]);

  useEffect(() => {
    if (step === 'environment') void loadEnvironment();
  }, [loadEnvironment, step]);

  useEffect(() => {
    if (appliedProjectIdentityRef.current === incomingProjectIdentity) return;
    appliedProjectIdentityRef.current = incomingProjectIdentity;
    setSelectedProject(initialProject);
    setProjectSkipped(false);
    setReadyPlan(null);
    setPlannerFailed(false);
    setError(null);
    setBusy(false);
  }, [incomingProjectIdentity, initialProject]);

  const loadProviders = useCallback(async () => {
    const epoch = ++providerEpochRef.current;
    const scope = stepScopeRef.current;
    setProvidersLoading(true);
    setProvidersLoadFailed(false);
    try {
      const page = await api.listModelProviders();
      if (mountedRef.current
        && providerEpochRef.current === epoch
        && stepScopeRef.current === scope
        && stepRef.current === 'provider') {
        setProviders(page.items);
        setProvidersLoadFailed(false);
      }
    } catch {
      if (mountedRef.current
        && providerEpochRef.current === epoch
        && stepScopeRef.current === scope
        && stepRef.current === 'provider') {
        setProvidersLoadFailed(true);
      }
    } finally {
      if (mountedRef.current
        && providerEpochRef.current === epoch
        && stepScopeRef.current === scope
        && stepRef.current === 'provider') setProvidersLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (step === 'provider') void loadProviders();
  }, [loadProviders, step]);

  useEffect(() => api.onModelProviderChanged(() => {
    if (stepRef.current === 'provider') void loadProviders();
  }), [api, loadProviders]);

  const runProjectAction = useCallback(async (
    action: () => Promise<Project | null>,
    failureMessage: string,
    selectResult: boolean,
  ) => {
    const epoch = ++operationEpochRef.current;
    const scope = stepScopeRef.current;
    setBusy(true);
    setError(null);
    try {
      const project = await action();
      if (!project) return;
      if (selectResult) await onSelectProject(project);
      if (mountedRef.current
        && operationEpochRef.current === epoch
        && stepScopeRef.current === scope
        && stepRef.current === 'project') {
        setReadyPlan(null);
        setPlannerFailed(false);
        setSelectedProject(project);
        setProjectSkipped(false);
      }
    } catch {
      if (mountedRef.current
        && operationEpochRef.current === epoch
        && stepScopeRef.current === scope
        && stepRef.current === 'project') setError(failureMessage);
    } finally {
      if (mountedRef.current && operationEpochRef.current === epoch) setBusy(false);
    }
  }, [onSelectProject]);

  const complete = useCallback(async () => {
    const epoch = ++operationEpochRef.current;
    const scope = stepScopeRef.current;
    setBusy(true);
    setError(null);
    completionFromRef.current = step === 'completing' ? completionFromRef.current : step;
    stepRef.current = 'completing';
    setStep('completing');
    try {
      await api.setFirstRunCompletedVersion(1);
      if (mountedRef.current && operationEpochRef.current === epoch && stepScopeRef.current === scope) onDone();
    } catch {
      if (mountedRef.current && operationEpochRef.current === epoch && stepScopeRef.current === scope) {
        stepRef.current = step;
        setStep(step);
        setError(t('firstRun.completionWriteFailed'));
      }
    } finally {
      if (mountedRef.current && operationEpochRef.current === epoch) setBusy(false);
    }
  }, [api, onDone, step]);

  const startPlanner = useCallback(async () => {
    if (!selectedProject) return;
    const projectAtStart = selectedProject;
    const epoch = ++operationEpochRef.current;
    const scope = stepScopeRef.current;
    setBusy(true);
    setPlannerFailed(false);
    setError(null);
    try {
      const result = await onStartPlanner(projectAtStart);
      if (result.status !== 'waiting_plan_confirmation'
        || result.projectId !== projectAtStart.id
        || canonicalProjectKey(result.projectPath) !== canonicalProjectKey(projectAtStart.path)) {
        throw new FirstRunPlannerError('PLAN_NOT_READY');
      }
      if (mountedRef.current
        && operationEpochRef.current === epoch
        && stepScopeRef.current === scope
        && stepRef.current === 'first_task') {
        setReadyPlan({
          projectId: projectAtStart.id,
          projectPath: projectAtStart.path,
          workflowId: result.id,
        });
      }
    } catch {
      if (mountedRef.current
        && operationEpochRef.current === epoch
        && stepScopeRef.current === scope
        && stepRef.current === 'first_task') {
        setPlannerFailed(true);
        setError(t('firstRun.task.failed'));
      }
    } finally {
      if (mountedRef.current && operationEpochRef.current === epoch) setBusy(false);
    }
  }, [onStartPlanner, selectedProject]);

  const planReady = Boolean(
    readyPlan
    && readyPlan.workflowId
    && !projectSkipped
    && projectIdentityMatches(selectedProject, {
      id: readyPlan.projectId,
      path: readyPlan.projectPath,
    }),
  );

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const modalDialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')];
    if (modalDialogs.at(-1) !== dialogRef.current) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])];
    if (focusables.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  const renderStep = () => {
    const visibleStep = step === 'completing' ? completionFromRef.current : step;
    if (visibleStep === 'environment') {
      return (
        <>
          <StepHeading title={t('firstRun.environment.title')} description={t('firstRun.environment.description')} />
          {completionReadFailed ? <SafeAlert>{t('firstRun.completionReadFailed')}</SafeAlert> : null}
          {error ? <SafeAlert>{error}</SafeAlert> : null}
          {environment ? <EnvironmentStatusList result={environment} compact /> : environmentFailed ? (
            <SafeAlert>{t('env.failedCheck')}</SafeAlert>
          ) : (
            <div className="flex items-center justify-center gap-2 py-10 text-sm" style={{ color: 'var(--text-tertiary)' }}>
              <Loader2 size={18} className="animate-spin" aria-hidden="true" />{t('env.checking')}
            </div>
          )}
          <div className="mt-5 flex justify-end">
            <PrimaryButton disabled={busy} onClick={() => goToStep('provider')}>
              {t('firstRun.continue')}<ChevronRight size={15} aria-hidden="true" />
            </PrimaryButton>
          </div>
        </>
      );
    }
    if (visibleStep === 'provider') {
      return (
        <>
          <StepHeading title={t('firstRun.provider.title')} description={t('firstRun.provider.description')} />
          {error ? <SafeAlert>{error}</SafeAlert> : null}
          {providersLoadFailed ? (
            <div className="mb-3">
              <SafeAlert>{t('firstRun.provider.loadFailed')}</SafeAlert>
              <SecondaryButton disabled={busy || providersLoading} onClick={() => void loadProviders()}>
                {t('firstRun.provider.retry')}
              </SecondaryButton>
            </div>
          ) : null}
          {providers.length > 0 ? (
            <div className="space-y-2">
              {providers.map((provider) => (
                <div key={provider.id} className="flex min-w-0 items-center gap-3 rounded-lg border p-3" style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-tertiary)' }}>
                  <CheckCircle2 size={17} aria-hidden="true" style={{ color: providerStatusColor(provider), flexShrink: 0 }} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium" title={provider.name}>{provider.name}</div>
                    <div className="truncate text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      {providerStatus(provider)} · {t('firstRun.provider.runtime')}: {provider.runtimeType}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : providersLoading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm" style={{ color: 'var(--text-tertiary)' }}>
              <Loader2 size={18} className="animate-spin" aria-hidden="true" />{t('common.loading')}
            </div>
          ) : providersLoadFailed ? null : (
            <p className="rounded-lg p-3 text-sm" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>{t('firstRun.provider.none')}</p>
          )}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              <SecondaryButton disabled={busy} onClick={() => goToStep('environment')}>{t('firstRun.back')}</SecondaryButton>
              <SecondaryButton disabled={busy} onClick={onOpenProviderCenter}>
                <Settings2 size={15} aria-hidden="true" />{t('firstRun.provider.configure')}
              </SecondaryButton>
            </div>
            <PrimaryButton disabled={busy} onClick={() => goToStep('project')}>
              {t('firstRun.continue')}<ChevronRight size={15} aria-hidden="true" />
            </PrimaryButton>
          </div>
        </>
      );
    }
    if (visibleStep === 'project') {
      return (
        <>
          <StepHeading title={t('firstRun.project.title')} description={t('firstRun.project.description')} />
          {error ? <SafeAlert>{error}</SafeAlert> : null}
          {selectedProject ? (
            <div className="mb-4 min-w-0 rounded-lg border p-3" style={{ borderColor: 'var(--accent)', background: 'var(--accent-light)' }}>
              <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('firstRun.project.selected')}</div>
              <div className="truncate text-sm font-medium" title={selectedProject.name}>{selectedProject.name}</div>
            </div>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-2">
            <SecondaryButton disabled={busy} onClick={() => void runProjectAction(onOpenProject, t('firstRun.project.openFailed'), false)}>
              <FolderOpen size={15} aria-hidden="true" />{t('firstRun.project.open')}
            </SecondaryButton>
            <SecondaryButton disabled={busy} onClick={() => void runProjectAction(() => api.createFirstRunTestProject(), t('firstRun.project.createFailed'), true)}>
              <Sparkles size={15} aria-hidden="true" />{t('firstRun.project.createTest')}
            </SecondaryButton>
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              <SecondaryButton disabled={busy} onClick={() => goToStep('provider')}>{t('firstRun.back')}</SecondaryButton>
              <SecondaryButton disabled={busy} onClick={() => {
                setReadyPlan(null);
                setPlannerFailed(false);
                setSelectedProject(null);
                setProjectSkipped(true);
                goToStep('first_task');
              }}>{t('firstRun.project.skip')}</SecondaryButton>
            </div>
            {selectedProject ? (
              <PrimaryButton disabled={busy} onClick={() => {
                setProjectSkipped(false);
                goToStep('first_task');
              }}>
                {t('firstRun.project.continueWith')} {selectedProject.name}
              </PrimaryButton>
            ) : null}
          </div>
        </>
      );
    }
    return (
      <>
        <StepHeading title={t('firstRun.task.title')} description={t('firstRun.task.description')} />
        {projectSkipped || !selectedProject ? (
          <p className="rounded-lg p-3 text-sm" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>{t('firstRun.task.skipped')}</p>
        ) : (
          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-tertiary)' }}>
            <div className="flex items-center gap-2 text-sm font-medium"><Bot size={16} aria-hidden="true" />Planner</div>
            <code className="mt-2 block whitespace-pre-wrap break-words text-xs" style={{ color: 'var(--text-secondary)' }}>{FIRST_RUN_READ_ONLY_PROMPT}</code>
          </div>
        )}
        {error ? <SafeAlert>{error}</SafeAlert> : null}
        {planReady ? (
          <div className="mt-4 rounded-lg border p-3" style={{ borderColor: 'var(--success)', background: 'var(--bg-tertiary)' }}>
            <p className="text-sm font-medium" style={{ color: 'var(--success)' }}>{t('firstRun.task.ready')}</p>
            <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>{t('firstRun.task.guidance')}</p>
          </div>
        ) : selectedProject ? (
          <div className="mt-4">
            <PrimaryButton disabled={busy} onClick={() => void startPlanner()}>
              {busy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Sparkles size={15} aria-hidden="true" />}
              {plannerFailed ? t('firstRun.task.retry') : t('firstRun.task.generate')}
            </PrimaryButton>
          </div>
        ) : null}
        <div className="mt-5 flex justify-between gap-2">
          <SecondaryButton disabled={busy} onClick={() => goToStep('project')}>{t('firstRun.back')}</SecondaryButton>
          <PrimaryButton disabled={busy} onClick={() => void complete()}>{t('firstRun.finish')}</PrimaryButton>
        </div>
      </>
    );
  };

  return (
    <div className="fixed inset-0 z-[45] flex items-center justify-center overflow-y-auto p-4" style={{ background: 'var(--bg-overlay)' }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-run-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="flex max-h-[92vh] w-full max-w-2xl min-w-0 flex-col overflow-hidden rounded-xl border shadow-xl"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}
      >
        <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4" style={{ borderColor: 'var(--border-primary)' }}>
          <div className="min-w-0">
            <h1 id="first-run-title" className="truncate text-base font-semibold">{t('firstRun.title')}</h1>
            <div className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              {['environment', 'provider', 'project', 'first_task'].indexOf(step === 'completing' ? completionFromRef.current : step) + 1} / 4
            </div>
          </div>
          <SecondaryButton disabled={busy} onClick={() => void complete()}>{t('firstRun.completeLater')}</SecondaryButton>
        </header>
        <main className="min-w-0 flex-1 overflow-y-auto p-5">{renderStep()}</main>
      </div>
    </div>
  );
}

function StepHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>{description}</p>
    </div>
  );
}

function SafeAlert({ children }: { children: React.ReactNode }) {
  return <p role="alert" className="mb-3 rounded-lg px-3 py-2 text-sm" style={{ color: 'var(--error)', background: 'var(--error-bg)' }}>{children}</p>;
}

function PrimaryButton({ children, disabled, onClick }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className="inline-flex min-w-0 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50" style={{ color: 'var(--accent-text)', background: 'var(--accent)' }}>
      {children}
    </button>
  );
}

function SecondaryButton({ children, disabled, onClick }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className="inline-flex min-w-0 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50" style={{ color: 'var(--text-secondary)', background: 'var(--bg-hover)' }}>
      {children}
    </button>
  );
}
