import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ProviderModelRef,
  ResolvedModelSelection,
  TaskModelSwitchResult,
} from '../../../shared/types/modelProviders';
import { AGENT_MODEL_RECONFIGURATION_MESSAGE as RECONFIGURE_AGENT_MODEL } from '../../../shared/types/modelProviders';
import type { TaskModelSwitchOptionPublic } from '../../../shared/types/projectAi';
import { t } from '../../i18n';

export interface TaskModelToolbarPort {
  getEffectiveModelSelection(input: { taskId: string }): Promise<ResolvedModelSelection>;
  listTaskModelSwitchOptions(input: { taskId: string }): Promise<TaskModelSwitchOptionPublic[]>;
  setTaskModelOverride(input: { taskId: string; providerId: string; modelId: string }): Promise<TaskModelSwitchResult>;
  clearTaskModelOverride(input: { taskId: string }): Promise<TaskModelSwitchResult>;
}

export interface TaskModelToolbarData {
  selection: ResolvedModelSelection | null;
  options: TaskModelSwitchOptionPublic[];
  error: string | null;
}

export function createLatestTaskModelToolbarLoader<T>(
  load: () => Promise<T>,
  apply: (value: T) => void,
  clear: () => void,
): { refresh(): Promise<void>; deactivate(): void } {
  let active = true;
  let revision = 0;
  return {
    async refresh(): Promise<void> {
      const requestRevision = ++revision;
      try {
        const next = await load();
        if (active && requestRevision === revision) apply(next);
      } catch {
        if (active && requestRevision === revision) clear();
      }
    },
    deactivate(): void {
      active = false;
      revision += 1;
    },
  };
}

export interface LatestTaskModelMutationController<T> {
  run(taskId: string, operation: () => Promise<T>): Promise<T>;
  deactivate(): void;
}

/**
 * Reconciles concurrent mutation results without trusting settlement order.
 * A later successful request wins; if every later request fails, the newest
 * earlier success becomes visible once those failures have settled.
 */
export function createLatestTaskModelMutationController<T>(
  getCurrentTaskId: () => string | null,
  apply: (value: T) => void,
): LatestTaskModelMutationController<T> {
  let active = true;
  let revision = 0;
  let appliedRevision = 0;
  let highestSuccessful: { revision: number; taskId: string; value: T } | null = null;
  const pending = new Set<number>();

  const applySettledSuccess = (): void => {
    const candidate = highestSuccessful;
    if (!active || !candidate || candidate.revision <= appliedRevision) return;
    for (const pendingRevision of pending) {
      if (pendingRevision > candidate.revision) return;
    }
    if (getCurrentTaskId() !== candidate.taskId) return;
    appliedRevision = candidate.revision;
    apply(candidate.value);
  };

  return {
    async run(taskId: string, operation: () => Promise<T>): Promise<T> {
      const requestRevision = ++revision;
      pending.add(requestRevision);
      try {
        const value = await operation();
        if (!highestSuccessful || requestRevision > highestSuccessful.revision) {
          highestSuccessful = { revision: requestRevision, taskId, value };
        }
        return value;
      } finally {
        pending.delete(requestRevision);
        applySettledSuccess();
      }
    },
    deactivate(): void {
      active = false;
      revision += 1;
      pending.clear();
      highestSuccessful = null;
    },
  };
}

function safeTaskOption(value: TaskModelSwitchOptionPublic): TaskModelSwitchOptionPublic {
  return {
    providerId: value.providerId,
    providerName: value.providerName,
    modelId: value.modelId,
    modelDisplayName: value.modelDisplayName,
    runtimeType: value.runtimeType,
    purpose: value.purpose ?? 'task_agent_override',
    source: value.source ?? 'configured_provider',
  };
}

export async function loadTaskModelToolbar(
  api: TaskModelToolbarPort,
  taskId: string,
): Promise<TaskModelToolbarData> {
  const [selectionResult, options] = await Promise.all([
    api.getEffectiveModelSelection({ taskId })
      .then((selection) => ({ selection, error: null }))
      .catch((error: unknown) => {
        if (!isAgentConfigurationFailure(error)) throw error;
        return { selection: null, error: RECONFIGURE_AGENT_MODEL };
      }),
    api.listTaskModelSwitchOptions({ taskId }),
  ]);
  return {
    selection: selectionResult.selection,
    options: options.map(safeTaskOption),
    error: selectionResult.error,
  };
}

function isAgentConfigurationFailure(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : null;
  return typeof code === 'string' && [
    'TIER_UNBOUND',
    'PROVIDER_DELETED',
    'PROVIDER_DISABLED',
    'PROVIDER_UNCONFIGURED',
    'CONNECTION_UNAVAILABLE',
    'MODEL_MISSING',
    'RUNTIME_INCOMPATIBLE',
    'WORKFLOW_CAPABILITY_MISSING',
    'SOURCE_CHANGED',
    'CLAUDE_CLI_UNAVAILABLE',
    'SELECTION_UNAVAILABLE',
  ].includes(code);
}

export async function switchTaskModel(
  api: Pick<TaskModelToolbarPort, 'setTaskModelOverride'>,
  taskId: string,
  next: ProviderModelRef,
): Promise<ResolvedModelSelection> {
  const result = await api.setTaskModelOverride({
    taskId,
    providerId: next.providerId,
    modelId: next.modelId,
  });
  return result.selection;
}

export async function clearTaskModel(
  api: Pick<TaskModelToolbarPort, 'clearTaskModelOverride'>,
  taskId: string,
): Promise<ResolvedModelSelection> {
  const result = await api.clearTaskModelOverride({ taskId });
  return result.selection;
}

export interface UseModelProviderToolbarResult extends TaskModelToolbarData {
  onSwitch(next: ProviderModelRef): Promise<void>;
  onClearOverride(): Promise<void>;
}

export function useModelProviderToolbar(
  taskId: string | null,
): UseModelProviderToolbarResult | null {
  const [state, setState] = useState<{
    incarnation: { taskId: string | null; sequence: number };
    data: TaskModelToolbarData;
  } | null>(null);
  const currentTaskId = useRef<string | null>(taskId);
  const mutationEpoch = useRef(0);
  const taskSequence = useRef(0);
  const taskIncarnationRef = useRef({ taskId, sequence: taskSequence.current });
  if (taskIncarnationRef.current.taskId !== taskId) {
    taskSequence.current += 1;
    taskIncarnationRef.current = { taskId, sequence: taskSequence.current };
    mutationEpoch.current += 1;
  }
  const taskIncarnation = taskIncarnationRef.current;
  const mutations = useRef<LatestTaskModelMutationController<ResolvedModelSelection> | null>(null);
  currentTaskId.current = taskId;

  useEffect(() => {
    if (!taskId) {
      mutations.current?.deactivate();
      mutations.current = null;
      setState(null);
      return;
    }
    const incarnation = taskIncarnation;
    const mutationController = createLatestTaskModelMutationController<ResolvedModelSelection>(
      () => currentTaskId.current,
      (selection) => {
        if (taskIncarnationRef.current !== incarnation) return;
        setState((current) => current?.incarnation === incarnation
          ? { ...current, data: { ...current.data, selection, error: null } }
          : current);
      },
    );
    mutations.current = mutationController;
    const loader = createLatestTaskModelToolbarLoader(
      () => loadTaskModelToolbar(window.api, taskId),
      (data) => {
        if (taskIncarnationRef.current === incarnation) {
          setState({ incarnation, data });
        }
      },
      () => {
        if (taskIncarnationRef.current === incarnation) setState(null);
      },
    );
    void loader.refresh();
    const unsubscribe = window.api.onModelProviderChanged(() => {
      void loader.refresh();
    });
    return () => {
      loader.deactivate();
      mutationController.deactivate();
      if (mutations.current === mutationController) mutations.current = null;
      unsubscribe();
    };
  }, [taskId, taskIncarnation]);

  const onSwitch = useCallback(async (next: ProviderModelRef) => {
    const controller = mutations.current;
    const incarnation = taskIncarnation;
    if (!taskId || !controller || taskIncarnationRef.current !== incarnation) return;
    const epoch = ++mutationEpoch.current;
    setState((current) => current?.incarnation === incarnation
      ? { ...current, data: { ...current.data, error: null } }
      : current);
    try {
      await controller.run(taskId, () => switchTaskModel(window.api, taskId, next));
    } catch {
      if (
        currentTaskId.current === taskId
        && taskIncarnationRef.current === incarnation
        && mutationEpoch.current === epoch
      ) {
        setState((current) => current?.incarnation === incarnation ? {
          ...current,
          data: { ...current.data, error: t('model.switch.failed') },
        } : current);
      }
      throw new Error('Task model switch failed.');
    }
  }, [taskId, taskIncarnation]);

  const onClearOverride = useCallback(async () => {
    const controller = mutations.current;
    const incarnation = taskIncarnation;
    if (!taskId || !controller || taskIncarnationRef.current !== incarnation) return;
    const epoch = ++mutationEpoch.current;
    setState((current) => current?.incarnation === incarnation
      ? { ...current, data: { ...current.data, error: null } }
      : current);
    try {
      await controller.run(taskId, () => clearTaskModel(window.api, taskId));
    } catch {
      if (
        currentTaskId.current === taskId
        && taskIncarnationRef.current === incarnation
        && mutationEpoch.current === epoch
      ) {
        setState((current) => current?.incarnation === incarnation ? {
          ...current,
          data: { ...current.data, error: t('model.switch.resetFailed') },
        } : current);
      }
      throw new Error('Task model policy reset failed.');
    }
  }, [taskId, taskIncarnation]);

  return state?.incarnation === taskIncarnation
    ? { ...state.data, onSwitch, onClearOverride }
    : null;
}
