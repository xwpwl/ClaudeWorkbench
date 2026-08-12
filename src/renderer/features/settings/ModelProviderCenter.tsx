import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  CirclePlus,
  Pencil,
  Power,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import {
  AGENT_MODEL_RECONFIGURATION_MESSAGE,
  POLICY_RATINGS,
  type AgentModelPolicyAssignment,
  type CreateProviderInput,
  type DeleteProviderInput,
  type ModelApiFormat,
  type ModelProviderType,
  type PolicyRating,
  type ProviderDraftInput,
  type ProviderModel,
  type ProviderValidationResult,
  type PublicAgentModelPolicy,
  type PublicAgentModelPolicyReference,
  type PublicModelProvider,
  type PublicProjectModelPolicy,
  type ProjectModelPolicyAgentType,
  type SetAgentModelPolicyRequest,
  type SetProjectModelPolicyRequest,
  type UpdateProviderInput,
} from '../../../shared/types/modelProviders';
import type { ModelTier } from '../../../shared/types/modelTiers';
import { EmptyState } from '../../components/EmptyState';
import {
  capabilityPresentations,
  connectionErrorLabel,
  healthPresentation,
  providerTypeLabel,
  runtimeTypeLabel,
  selectableWorkflowProviders,
  supportedUseLabels,
} from './modelProviderPresentation';
import { t } from '../../i18n';
import { computeVirtualWindow } from '../../performance/virtualization';

const PAGE_SIZE = 25;
const MODEL_ROW_HEIGHT = 36;
const MODEL_LIST_HEIGHT = 216;

export function filterProviderModels(models: ProviderModel[], query: string): ProviderModel[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return models;
  return models.filter((model) => (
    model.modelId.toLocaleLowerCase().includes(normalized)
    || model.displayName?.toLocaleLowerCase().includes(normalized)
  ));
}

type ProviderBusyAction = 'load' | 'test' | 'refresh_models' | 'default' | 'enabled' | 'delete' | null;

export interface ModelProviderCenterViewProps {
  providers: PublicModelProvider[];
  total: number;
  offset: number;
  limit: number;
  selectedProviderId: string | null;
  selectedProvider: PublicModelProvider | null;
  models: ProviderModel[];
  loading: boolean;
  busyAction: ProviderBusyAction;
  error: string | null;
  editor?: React.ReactNode;
  policyEditor?: React.ReactNode;
  onSelectProvider(providerId: string): void;
  onAdd(): void;
  onEdit(): void;
  onTest(): void;
  onRefreshModels(): void;
  onSetEnabled(): void;
  onSetDefault(): void;
  onDelete(): void;
  onPageChange(offset: number): void;
}

function publicError(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

export async function validateDraftAndClearCredential(
  draft: ProviderDraftInput,
  credential: string,
  validate: (input: ProviderDraftInput) => Promise<ProviderValidationResult>,
  clearCredential: () => void,
): Promise<ProviderValidationResult> {
  try {
    return await validate({
      ...draft,
      credential: credential.length > 0 ? credential : null,
    });
  } finally {
    clearCredential();
  }
}

export async function confirmAndDeleteProvider(
  provider: PublicModelProvider,
  confirm: (message: string) => boolean,
  remove: (input: DeleteProviderInput) => Promise<void>,
): Promise<boolean> {
  const accepted = confirm(
    t('provider.center.deleteConfirm').replace('{name}', () => provider.name),
  );
  if (!accepted) return false;
  await remove({ providerId: provider.id, confirmCredentialDeletion: true });
  return true;
}

export async function deleteProviderFromCenter(
  provider: PublicModelProvider,
  confirm: (message: string) => boolean,
  remove: (input: DeleteProviderInput) => Promise<void>,
  refresh: () => Promise<void>,
  reportError: (message: string) => void,
): Promise<boolean> {
  try {
    const deleted = await confirmAndDeleteProvider(provider, confirm, remove);
    if (!deleted) return false;
    await refresh();
    return true;
  } catch (reason) {
    reportError(publicError(reason, t('provider.center.deleteFailed')));
    return false;
  }
}

export interface AgentPolicyMutationPort {
  setPolicy(input: SetAgentModelPolicyRequest): Promise<unknown>;
  deletePolicy(input: { agentType: AgentModelPolicyAssignment['agentType'] }): Promise<unknown>;
}

export async function persistAgentPolicyChange(
  agentType: AgentModelPolicyAssignment['agentType'],
  assignment: AgentModelPolicyAssignment | null,
  api: AgentPolicyMutationPort,
): Promise<void> {
  if (!assignment) {
    await api.deletePolicy({ agentType });
    return;
  }
  await api.setPolicy({
    agentType,
    providerId: assignment.providerId,
    modelId: assignment.modelId,
    quality: assignment.notes.quality,
    speed: assignment.notes.speed,
    cost: assignment.notes.cost,
  });
}

export interface AgentPolicyEditorLoadPort {
  listPolicies(): Promise<PublicAgentModelPolicy[]>;
  getProvider(providerId: string): Promise<PublicModelProvider>;
  listModels(providerId: string): Promise<ProviderModel[]>;
}

export async function loadAgentPolicyEditorData(
  pageProviders: PublicModelProvider[],
  api: AgentPolicyEditorLoadPort,
): Promise<{
  policies: PublicAgentModelPolicy[];
  providers: PublicModelProvider[];
  modelsByProvider: Record<string, ProviderModel[]>;
}> {
  const policies = await api.listPolicies();
  const providerMap = new Map(pageProviders.map((provider) => [provider.id, provider]));
  for (const providerId of new Set(policies.map((policy) => policy.providerId))) {
    if (!providerMap.has(providerId)) providerMap.set(providerId, await api.getProvider(providerId));
  }
  const providers = [...providerMap.values()];
  const modelEntries = await Promise.all(
    selectableWorkflowProviders(providers).map(async (provider) => (
      [provider.id, await api.listModels(provider.id)] as const
    )),
  );
  return { policies, providers, modelsByProvider: Object.fromEntries(modelEntries) };
}

export interface ProjectPolicyMutationPort {
  setPolicy(input: SetProjectModelPolicyRequest): Promise<unknown>;
  deletePolicy(input: { projectId: string; agentType: ProjectModelPolicyAgentType }): Promise<unknown>;
}

export async function persistProjectPolicyChange(
  projectId: string,
  agentType: ProjectModelPolicyAgentType,
  policy: PublicProjectModelPolicy | null,
  api: ProjectPolicyMutationPort,
): Promise<void> {
  if (!policy) {
    await api.deletePolicy({ projectId, agentType });
    return;
  }
  await api.setPolicy({
    projectId,
    agentType,
    providerId: policy.providerId,
    modelId: policy.modelId,
  });
}

export interface ProviderPageSyncDependencies {
  loadPage(offset: number, preferredId?: string | null): Promise<void>;
  getCurrent(): { offset: number; selectedProviderId: string | null };
  subscribe(listener: () => void): () => void;
}

export function startProviderPageSync({
  loadPage,
  getCurrent,
  subscribe,
}: ProviderPageSyncDependencies): () => void {
  void loadPage(0);
  return subscribe(() => {
    const current = getCurrent();
    void loadPage(current.offset, current.selectedProviderId);
  });
}

export function ModelProviderCenter() {
  const [providers, setProviders] = useState<PublicModelProvider[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<PublicModelProvider | null>(null);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<ProviderBusyAction>('load');
  const [error, setError] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<'create' | 'edit' | null>(null);
  const pageSyncStateRef = useRef({ offset: 0, selectedProviderId: null as string | null });
  const mountedRef = useRef(false);
  const pageEpochRef = useRef(0);
  const detailEpochRef = useRef(0);
  const actionEpochRef = useRef(0);
  const selectionSequenceRef = useRef(0);
  const explicitSelectionEpochRef = useRef(0);
  const selectionIncarnationRef = useRef({
    providerId: selectedProviderId,
    sequence: selectionSequenceRef.current,
  });
  if (selectionIncarnationRef.current.providerId !== selectedProviderId) {
    selectionSequenceRef.current += 1;
    selectionIncarnationRef.current = {
      providerId: selectedProviderId,
      sequence: selectionSequenceRef.current,
    };
    detailEpochRef.current += 1;
    actionEpochRef.current += 1;
  }
  const selectionIncarnation = selectionIncarnationRef.current;
  pageSyncStateRef.current = { offset, selectedProviderId };
  const visibleSelectedProvider = selectedProvider?.id === selectedProviderId
    ? selectedProvider
    : null;
  const updateSelectedProviderId = useCallback((nextProviderId: string | null) => {
    if (selectionIncarnationRef.current.providerId !== nextProviderId) {
      selectionSequenceRef.current += 1;
      selectionIncarnationRef.current = {
        providerId: nextProviderId,
        sequence: selectionSequenceRef.current,
      };
      detailEpochRef.current += 1;
      actionEpochRef.current += 1;
    }
    setSelectedProviderId(nextProviderId);
  }, []);
  const selectProviderExplicitly = useCallback((nextProviderId: string) => {
    explicitSelectionEpochRef.current += 1;
    updateSelectedProviderId(nextProviderId);
  }, [updateSelectedProviderId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pageEpochRef.current += 1;
      detailEpochRef.current += 1;
      actionEpochRef.current += 1;
    };
  }, []);

  const loadPage = useCallback(async (nextOffset: number, preferredId?: string | null) => {
    const requestEpoch = ++pageEpochRef.current;
    const explicitSelectionEpoch = explicitSelectionEpochRef.current;
    setLoading(true);
    setBusyAction('load');
    setError(null);
    try {
      const page = await window.api.listModelProviders({
        limit: PAGE_SIZE,
        offset: nextOffset,
      });
      if (!mountedRef.current || pageEpochRef.current !== requestEpoch) return;
      setProviders(page.items);
      setTotal(page.total);
      setOffset(page.offset);
      if (explicitSelectionEpochRef.current === explicitSelectionEpoch) {
        const requested = preferredId === undefined
          ? pageSyncStateRef.current.selectedProviderId
          : preferredId;
        const nextProviderId = requested && page.items.some((provider) => provider.id === requested)
          ? requested
          : page.items[0]?.id ?? null;
        updateSelectedProviderId(nextProviderId);
      }
    } catch (reason) {
      if (mountedRef.current && pageEpochRef.current === requestEpoch) {
        setError(publicError(reason, t('provider.center.loadFailed')));
      }
    } finally {
      if (mountedRef.current && pageEpochRef.current === requestEpoch) {
        setLoading(false);
        setBusyAction(null);
      }
    }
  }, [updateSelectedProviderId]);

  const loadDetails = useCallback(async (
    providerId: string,
    incarnation: { providerId: string | null; sequence: number },
  ) => {
    const requestEpoch = ++detailEpochRef.current;
    try {
      const [provider, nextModels] = await Promise.all([
        window.api.getModelProvider(providerId),
        window.api.listModelProviderModels(providerId),
      ]);
      if (
        !mountedRef.current
        || detailEpochRef.current !== requestEpoch
        || selectionIncarnationRef.current !== incarnation
        || incarnation.providerId !== providerId
      ) return;
      setSelectedProvider(provider);
      setModels(nextModels);
    } catch (reason) {
      if (
        !mountedRef.current
        || detailEpochRef.current !== requestEpoch
        || selectionIncarnationRef.current !== incarnation
        || incarnation.providerId !== providerId
      ) return;
      setSelectedProvider(null);
      setModels([]);
      setError(publicError(reason, t('provider.center.detailLoadFailed')));
    }
  }, []);

  useEffect(() => {
    return startProviderPageSync({
      loadPage,
      getCurrent: () => pageSyncStateRef.current,
      subscribe: (listener) => window.api.onModelProviderChanged(listener),
    });
  }, [loadPage]);

  useEffect(() => {
    const incarnation = selectionIncarnation;
    setSelectedProvider(null);
    setModels([]);
    setError(null);
    setBusyAction((current) => current === 'load' ? current : null);
    if (!selectedProviderId) {
      return;
    }
    void loadDetails(selectedProviderId, incarnation);
    return () => {
      detailEpochRef.current += 1;
    };
  }, [loadDetails, selectedProviderId, selectionIncarnation]);

  const runSelectedAction = useCallback(async (
    action: Exclude<ProviderBusyAction, 'load' | null>,
    operation: (provider: PublicModelProvider) => Promise<void>,
  ) => {
    const provider = visibleSelectedProvider;
    const incarnation = selectionIncarnation;
    if (!provider || selectionIncarnationRef.current !== incarnation) return;
    const operationEpoch = ++actionEpochRef.current;
    const isCurrentOperation = () => (
      mountedRef.current
      && actionEpochRef.current === operationEpoch
      && selectionIncarnationRef.current === incarnation
      && incarnation.providerId === provider.id
    );
    setBusyAction(action);
    setError(null);
    try {
      await operation(provider);
      if (!isCurrentOperation()) return;
      await loadPage(offset, provider.id);
      if (!isCurrentOperation()) return;
      if (action !== 'delete') await loadDetails(provider.id, incarnation);
    } catch (reason) {
      if (isCurrentOperation()) {
        setError(publicError(reason, t('provider.center.actionFailed')));
      }
    } finally {
      if (isCurrentOperation()) setBusyAction(null);
    }
  }, [loadDetails, loadPage, offset, selectionIncarnation, visibleSelectedProvider]);

  const editor = editorMode ? (
    <ProviderEditor
      mode={editorMode}
      initialProvider={editorMode === 'edit' ? visibleSelectedProvider : null}
      busy={busyAction !== null}
      onCancel={() => setEditorMode(null)}
      onSaved={(provider) => {
        setEditorMode(null);
        void loadPage(0, provider.id);
      }}
    />
  ) : undefined;

  return (
    <ModelProviderCenterView
      providers={providers}
      total={total}
      offset={offset}
      limit={PAGE_SIZE}
      selectedProviderId={selectedProviderId}
      selectedProvider={visibleSelectedProvider}
      models={visibleSelectedProvider ? models : []}
      loading={loading}
      busyAction={busyAction}
      error={error}
      editor={editor}
      onSelectProvider={selectProviderExplicitly}
      onAdd={() => setEditorMode('create')}
      onEdit={() => setEditorMode('edit')}
      onTest={() => void runSelectedAction('test', async (provider) => {
        await window.api.testModelProviderConnection(provider.id);
      })}
      onRefreshModels={() => void runSelectedAction('refresh_models', async (provider) => {
        await window.api.testModelProviderConnection(provider.id);
      })}
      onSetEnabled={() => void runSelectedAction('enabled', async (provider) => {
        await window.api.setModelProviderEnabled({
          providerId: provider.id,
          enabled: !provider.enabled,
        });
      })}
      onSetDefault={() => void runSelectedAction('default', async (provider) => {
        await window.api.setDefaultModelProvider(provider.id);
      })}
      onDelete={() => {
        const provider = visibleSelectedProvider;
        const incarnation = selectionIncarnationRef.current;
        if (!provider || incarnation.providerId !== provider.id) return;
        const operationEpoch = ++actionEpochRef.current;
        const isCurrentOperation = () => (
          mountedRef.current
          && actionEpochRef.current === operationEpoch
          && selectionIncarnationRef.current === incarnation
          && incarnation.providerId === provider.id
        );
        setBusyAction('delete');
        setError(null);
        void deleteProviderFromCenter(
          provider,
          window.confirm,
          window.api.deleteModelProvider,
          async () => {
            if (!isCurrentOperation()) return;
            updateSelectedProviderId(null);
            await loadPage(offset, null);
          },
          (nextError) => {
            if (isCurrentOperation()) setError(nextError);
          },
        ).finally(() => {
          if (isCurrentOperation()) setBusyAction(null);
        });
      }}
      onPageChange={(nextOffset) => void loadPage(nextOffset)}
    />
  );
}

export function ModelProviderCenterView({
  providers,
  total,
  offset,
  limit,
  selectedProviderId,
  selectedProvider,
  models,
  loading,
  busyAction,
  error,
  editor,
  policyEditor,
  onSelectProvider,
  onAdd,
  onEdit,
  onTest,
  onRefreshModels,
  onSetEnabled,
  onSetDefault,
  onDelete,
  onPageChange,
}: ModelProviderCenterViewProps) {
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(pageCount, Math.floor(offset / limit) + 1);
  const busy = busyAction !== null;

  return (
    <div className="space-y-5" data-testid="model-provider-center">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('provider.center.title')}</h3>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {t('provider.center.subtitle')}
          </p>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs"
          style={{ color: 'var(--accent-text)', background: 'var(--accent)' }}
          data-testid="add-provider"
        >
          <CirclePlus size={13} />{t('provider.center.add')}
        </button>
      </div>

      {error ? (
        <div className="rounded-lg border px-3 py-2 text-xs" style={{ color: 'var(--error)', borderColor: 'var(--error)' }} role="alert">
          {error}
        </div>
      ) : null}

      {editor ?? (
        <div
          className="min-w-0 overflow-hidden rounded-xl border"
          data-narrow-safe="true"
          style={{ borderColor: 'var(--border-primary)' }}
        >
          <div
            className="space-y-2 p-2"
            data-testid="provider-card-list"
          >
            <div data-testid="model-provider-list">
              {loading ? (
                <p className="px-2 py-5 text-center text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('provider.center.loading')}</p>
              ) : providers.length === 0 ? (
                <EmptyState
                  icon={Server}
                  title={t('provider.center.empty')}
                  description={t('provider.center.subtitle')}
                  action={{ label: t('provider.center.add'), onClick: onAdd, disabled: busy }}
                  compact
                />
              ) : providers.map((provider) => {
                const health = healthPresentation(provider);
                const uses = supportedUseLabels(provider);
                const selected = selectedProviderId === provider.id;
                const runtimeCapable = provider.runtimeType === 'claude-code'
                  && provider.capabilities.supportsClaudeCode;
                return (
                  <article
                    key={provider.id}
                    className="min-w-0 overflow-hidden rounded-lg border"
                    style={{ borderColor: selected ? 'var(--accent)' : 'var(--border-secondary)' }}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectProvider(provider.id)}
                      className="block w-full min-w-0 px-3 py-3 text-left text-xs"
                      style={{
                        color: 'var(--text-primary)',
                        background: selected ? 'var(--accent-light)' : 'var(--bg-secondary)',
                      }}
                      aria-current={selected ? 'true' : undefined}
                      aria-expanded={selected}
                      data-testid="model-provider-list-item"
                    >
                      <span className="flex min-w-0 items-start justify-between gap-3">
                        <span className="min-w-0">
                          <span className="block truncate font-semibold">{provider.name}</span>
                          <span className="mt-1 block truncate" style={{ color: 'var(--text-tertiary)' }}>
                            {providerTypeLabel(provider.type)} · {runtimeTypeLabel(provider.runtimeType)}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          {provider.isDefault ? <span style={{ color: 'var(--accent)' }}>{t('provider.center.default')}</span> : null}
                          {provider.isDefault && provider.agentModelStatus === 'needs_reconfiguration' ? (
                            <span style={{ color: 'var(--warning)' }}>需要重新配置</span>
                          ) : null}
                          <span style={{ color: health.tone === 'success' ? 'var(--success)' : health.tone === 'danger' ? 'var(--error)' : 'var(--text-tertiary)' }}>
                            <span aria-hidden="true">●</span> {health.label}
                          </span>
                        </span>
                      </span>
                      <span className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1" style={{ color: 'var(--text-secondary)' }}>
                        <span>{provider.configured ? t('provider.cards.configured') : t('provider.cards.notConfigured')}</span>
                        <span>{provider.enabled ? t('provider.cards.enabled') : t('provider.cards.disabled')}</span>
                        <span className="truncate">{provider.defaultModelId ?? t('provider.cards.modelUnset')}</span>
                        <span>{health.latency}</span>
                        <span>{t('provider.cards.lastTested')}: {health.lastTested}</span>
                        {uses.map((use) => <span key={use}>{use}</span>)}
                      </span>
                      {!runtimeCapable ? (
                        <span className="mt-2 block" style={{ color: 'var(--warning)' }}>
                          {t('provider.cards.unsupportedSummary')}
                        </span>
                      ) : null}
                      {provider.isDefault && provider.agentModelStatus === 'needs_reconfiguration' ? (
                        <span className="mt-1 block" role="alert" style={{ color: 'var(--warning)' }}>
                          {AGENT_MODEL_RECONFIGURATION_MESSAGE}
                        </span>
                      ) : null}
                    </button>
                    {selected && selectedProvider ? (
                      <div className="border-t p-3" style={{ borderColor: 'var(--border-secondary)' }}>
                        <ProviderDetails
                          provider={selectedProvider}
                          models={models}
                          busy={busy}
                          onEdit={onEdit}
                          onTest={onTest}
                          onRefreshModels={onRefreshModels}
                          onSetEnabled={onSetEnabled}
                          onSetDefault={onSetDefault}
                          onDelete={onDelete}
                        />
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </div>
          <div className="flex items-center justify-between border-t px-2 py-2 text-[11px]" style={{ borderColor: 'var(--border-primary)', color: 'var(--text-tertiary)' }}>
            <button type="button" aria-label={t('provider.center.previousPage')} disabled={offset === 0 || loading} onClick={() => onPageChange(Math.max(0, offset - limit))} className="rounded p-1 disabled:opacity-30"><ChevronLeft size={13} /></button>
            <span>{t('provider.center.page')
              .replace('{current}', String(currentPage))
              .replace('{total}', String(pageCount))}</span>
            <button type="button" aria-label={t('provider.center.nextPage')} disabled={offset + limit >= total || loading} onClick={() => onPageChange(offset + limit)} className="rounded p-1 disabled:opacity-30"><ChevronRight size={13} /></button>
          </div>
        </div>
      )}

      {policyEditor}
    </div>
  );
}

export interface ProviderDetailsProps {
  provider: PublicModelProvider;
  models: ProviderModel[];
  busy: boolean;
  onEdit(): void;
  onTest(): void;
  onRefreshModels(): void;
  onSetEnabled(): void;
  onSetDefault(): void;
  onDelete(): void;
}

function ProviderModelList({ models }: { models: ProviderModel[] }) {
  const [query, setQuery] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const filtered = useMemo(() => filterProviderModels(models, query), [models, query]);
  const window = computeVirtualWindow({
    itemCount: filtered.length,
    itemHeight: MODEL_ROW_HEIGHT,
    viewportHeight: MODEL_LIST_HEIGHT,
    scrollTop,
    overscan: 3,
  });
  const visible = filtered.slice(window.start, window.end);

  return (
    <div className="space-y-2">
      <label className="relative block">
        <Search size={13} aria-hidden="true" className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-tertiary)' }} />
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setScrollTop(0);
          }}
          aria-label={t('provider.details.searchModels')}
          placeholder={t('provider.details.searchModels')}
          className="w-full rounded-lg border py-2 pl-8 pr-3 text-xs outline-none"
          style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
        />
      </label>
      {filtered.length === 0 ? (
        <p className="rounded-lg border px-3 py-4 text-center text-xs" style={{ borderColor: 'var(--border-secondary)', color: 'var(--text-tertiary)' }}>
          {t('provider.details.noMatchingModels')}
        </p>
      ) : (
        <div
          data-virtualized="true"
          className="overflow-y-auto rounded-lg border text-xs"
          style={{ borderColor: 'var(--border-secondary)', height: MODEL_LIST_HEIGHT }}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <ul className="relative" style={{ height: window.totalHeight }}>
            {visible.map((model, index) => (
              <li
                key={`${model.providerId}:${model.modelId}`}
                data-testid="provider-model-item"
                className="absolute left-0 right-0 flex items-center justify-between gap-3 border-b px-3 py-2"
                style={{ borderColor: 'var(--border-secondary)', height: MODEL_ROW_HEIGHT, top: (window.start + index) * MODEL_ROW_HEIGHT }}
              >
                <span className="min-w-0 truncate">{model.displayName ? `${model.displayName} · ` : ''}{model.modelId}</span>
                <span className="shrink-0" style={{ color: 'var(--text-tertiary)' }}>{model.source === 'manual' ? t('provider.details.manual') : t('provider.details.discovered')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function ProviderDetails({
  provider,
  models,
  busy,
  onEdit,
  onTest,
  onRefreshModels,
  onSetEnabled,
  onSetDefault,
  onDelete,
}: ProviderDetailsProps) {
  const health = healthPresentation(provider);
  const capabilities = capabilityPresentations(provider.capabilities);
  const uses = supportedUseLabels(provider);
  const runtimeCapable = provider.runtimeType === 'claude-code' && provider.capabilities.supportsClaudeCode;
  const runnable = provider.enabled && runtimeCapable;

  return (
    <div className="space-y-4" data-testid="model-provider-details">
      <details data-testid="provider-advanced-details">
        <summary className="cursor-pointer text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
          {t('provider.cards.advanced')}
        </summary>
        <div className="mt-4 space-y-4">
          <header className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h4 className="truncate text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{provider.name}</h4>
              <p className="mt-1 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {providerTypeLabel(provider.type)} · {runtimeTypeLabel(provider.runtimeType)}
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-1.5">
              {provider.enabled ? <SmallAction testId="test-provider" onClick={onTest} disabled={busy} icon={<ShieldCheck size={12} />}>{t('provider.action.test')}</SmallAction> : null}
              {provider.enabled ? <SmallAction testId="refresh-provider-models" onClick={onRefreshModels} disabled={busy} icon={<RefreshCw size={12} />}>{t('provider.action.refreshModels')}</SmallAction> : null}
              <SmallAction testId="edit-provider" onClick={onEdit} disabled={busy} icon={<Pencil size={12} />}>{t('provider.action.edit')}</SmallAction>
              {runnable && !provider.isDefault ? <SmallAction testId="set-default-provider" onClick={onSetDefault} disabled={busy} icon={<Check size={12} />}>{t('provider.action.setDefault')}</SmallAction> : null}
              <SmallAction
                testId={provider.enabled ? 'disable-provider' : 'enable-provider'}
                onClick={onSetEnabled}
                disabled={busy}
                icon={<Power size={12} />}
              >
                {provider.enabled ? t('provider.action.disable') : t('provider.action.enable')}
              </SmallAction>
              <SmallAction testId="delete-provider" onClick={onDelete} disabled={busy} danger icon={<Trash2 size={12} />}>{t('provider.action.delete')}</SmallAction>
            </div>
          </header>

          {!runtimeCapable ? (
            <div className="flex items-start gap-2 rounded-lg border px-3 py-2 text-xs" style={{ color: 'var(--warning)', borderColor: 'var(--warning)', background: 'var(--warning-light)' }} role="status">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{t('provider.details.unsupportedRuntime')}。{t('provider.details.unsupportedMore')}</span>
            </div>
          ) : null}

          <dl className="grid grid-cols-2 gap-x-5 gap-y-2 rounded-lg border p-3 text-xs" style={{ borderColor: 'var(--border-secondary)', background: 'var(--bg-hover)' }}>
            <InfoCell label={t('provider.details.providerType')} value={providerTypeLabel(provider.type)} />
            <InfoCell label={t('provider.details.runtimeType')} value={runtimeTypeLabel(provider.runtimeType)} />
            <InfoCell label={t('provider.details.apiFormat')} value={provider.apiFormat === 'anthropic-messages' ? 'Anthropic Messages' : 'OpenAI Chat Completions'} />
            <InfoCell label={t('provider.details.defaultModel')} value={provider.defaultModelId ?? t('provider.cards.modelUnset')} />
            <InfoCell label={t('provider.details.baseUrl')} value={provider.baseUrl ?? t('provider.details.officialDefault')} wide />
            <InfoCell label={t('provider.details.authentication')} value={provider.configured ? t('provider.details.credentialStored') : t('provider.cards.notConfigured')} wide />
          </dl>
          {provider.baseUrlPathRedacted ? (
            <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{t('provider.cards.pathHidden')}</p>
          ) : null}

          <section>
            <h5 className="mb-2 text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{t('provider.details.connectionStatus')}</h5>
            <div className="grid grid-cols-3 gap-2 rounded-lg border p-3 text-xs" style={{ borderColor: 'var(--border-secondary)' }}>
              <InfoCell label={t('provider.details.status')} value={health.label} />
              <InfoCell label={t('provider.cards.lastTested')} value={health.lastTested} />
              <InfoCell label={t('provider.details.latency')} value={health.latency} />
              {health.error ? <InfoCell label={t('provider.details.lastError')} value={health.error} wide /> : null}
            </div>
          </section>

          <section>
            <h5 className="mb-2 text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{t('provider.details.capabilities')}</h5>
            <div className="flex flex-wrap gap-1.5">
              {capabilities.map((capability) => (
                <span
                  key={capability.key}
                  data-testid="provider-capability"
                  className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px]"
                  style={{
                    borderColor: capability.supported ? 'var(--success)' : 'var(--border-secondary)',
                    color: capability.supported ? 'var(--success)' : 'var(--text-tertiary)',
                  }}
                >
                  {capability.supported ? '✓' : '—'} {capability.label}
                </span>
              ))}
            </div>
          </section>

          <section>
            <h5 className="mb-2 text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{t('provider.details.supportedUses')}</h5>
            {uses.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {uses.map((use) => <span key={use} className="rounded-md px-2 py-1 text-[11px]" style={{ color: 'var(--accent)', background: 'var(--accent-light)' }}>{use}</span>)}
              </div>
            ) : <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('provider.details.noRunnableUses')}</p>}
          </section>

          <section>
            <h5 className="mb-2 text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{t('provider.details.modelList')}</h5>
            {models.length === 0 ? <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('provider.details.noModels')}</p> : (
              <ProviderModelList models={models} />
            )}
          </section>
        </div>
      </details>
    </div>
  );
}

function SmallAction({
  children,
  icon,
  disabled,
  danger = false,
  testId,
  onClick,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  disabled: boolean;
  danger?: boolean;
  testId: string;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] disabled:opacity-40"
      style={{ color: danger ? 'var(--error)' : 'var(--text-secondary)', background: 'var(--bg-hover)' }}
    >
      {icon}{children}
    </button>
  );
}

function InfoCell({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2 min-w-0' : 'min-w-0'}>
      <dt style={{ color: 'var(--text-tertiary)' }}>{label}</dt>
      <dd className="mt-0.5 truncate" title={value} style={{ color: 'var(--text-primary)' }}>{value}</dd>
    </div>
  );
}

export interface ProviderEditorProps {
  mode: 'create' | 'edit';
  initialProvider: PublicModelProvider | null;
  busy: boolean;
  onCancel(): void;
  onSaved(provider: PublicModelProvider): void;
}

export function draftFromProvider(provider: PublicModelProvider | null): ProviderDraftInput {
  if (provider) {
    const common = {
      providerId: provider.id,
      name: provider.name,
      type: provider.type,
      apiFormat: provider.apiFormat,
      credential: null,
      defaultModelId: provider.defaultModelId,
    } as const;
    return provider.baseUrlPathRedacted
      ? { ...common, baseUrlIntent: { mode: 'preserve_existing' } }
      : { ...common, baseUrlIntent: { mode: 'replace', value: provider.baseUrl } };
  }
  return {
    name: '',
    type: 'anthropic',
    apiFormat: 'anthropic-messages',
    baseUrlIntent: { mode: 'replace', value: null },
    credential: null,
    defaultModelId: null,
  };
}

export function replaceProviderBaseUrl(
  draft: ProviderDraftInput,
  value: string | null,
): ProviderDraftInput {
  return { ...draft, baseUrlIntent: { mode: 'replace', value } };
}

function defaultApiFormat(type: ModelProviderType): ModelApiFormat {
  return type === 'openai-compatible' ? 'openai-chat-completions' : 'anthropic-messages';
}

export function ProviderEditor({ mode, initialProvider, busy, onCancel, onSaved }: ProviderEditorProps) {
  const [draft, setDraft] = useState<ProviderDraftInput>(() => draftFromProvider(initialProvider));
  const [credential, setCredentialState] = useState('');
  const credentialRef = useRef('');
  const [validation, setValidation] = useState<ProviderValidationResult | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setCredential = useCallback((value: string) => {
    credentialRef.current = value;
    setCredentialState(value);
  }, []);

  const clearCredential = useCallback(() => {
    credentialRef.current = '';
    setCredentialState('');
  }, []);

  useEffect(() => () => {
    credentialRef.current = '';
  }, []);

  const updateDraft = useCallback(<K extends keyof ProviderDraftInput>(
    key: K,
    value: ProviderDraftInput[K],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setValidation(null);
  }, []);

  const testConnection = useCallback(async () => {
    setWorking(true);
    setError(null);
    setValidation(null);
    try {
      const result = await validateDraftAndClearCredential(
        draft,
        credentialRef.current,
        window.api.validateModelProviderDraft,
        clearCredential,
      );
      setValidation(result);
      if (!result.connection.ok) setError(connectionErrorLabel(result.connection.error.type));
    } catch {
      setError(t('provider.editor.testFailed'));
    } finally {
      setWorking(false);
    }
  }, [clearCredential, draft]);

  const save = useCallback(async () => {
    if (!validation?.connection.ok || !validation.validationToken) return;
    setWorking(true);
    setError(null);
    try {
      const token = validation.validationToken;
      const saved = mode === 'create'
        ? await window.api.createModelProvider({ validationToken: token } satisfies CreateProviderInput)
        : await window.api.updateModelProvider({
          providerId: initialProvider?.id ?? '',
          validationToken: token,
        } satisfies UpdateProviderInput);
      onSaved(saved);
    } catch {
      setError(t('provider.editor.saveFailed'));
      setValidation(null);
    } finally {
      clearCredential();
      setWorking(false);
    }
  }, [clearCredential, initialProvider?.id, mode, onSaved, validation]);

  const canTest = draft.name.trim().length > 0
    && (mode === 'edit' || credential.length > 0)
    && (draft.type === 'anthropic'
      || draft.baseUrlIntent.mode === 'preserve_existing'
      || Boolean(draft.baseUrlIntent.value));
  const canSave = Boolean(validation?.connection.ok && validation.validationToken);

  return (
    <section className="rounded-xl border" style={{ borderColor: 'var(--border-primary)' }} data-testid="provider-editor">
      <header className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--border-primary)' }}>
        <Server size={15} style={{ color: 'var(--accent)' }} />
        <h4 className="flex-1 text-sm font-semibold">
          {mode === 'create'
            ? t('provider.editor.addTitle')
            : t('provider.editor.editTitle').replace('{name}', () => initialProvider?.name ?? 'Provider')}
        </h4>
        <button type="button" onClick={onCancel} aria-label={t('provider.editor.close')}><X size={15} /></button>
      </header>
      <ol className="grid grid-cols-3 gap-2 border-b px-4 py-3 text-[11px]" style={{ borderColor: 'var(--border-primary)' }} data-testid="provider-editor-steps">
        {[
          { label: t('provider.editor.stepType'), complete: true },
          { label: t('provider.editor.stepConnection'), complete: canTest },
          { label: t('provider.editor.stepTestSave'), complete: Boolean(validation?.connection.ok) },
        ].map((step) => (
          <li key={step.label} data-testid="provider-editor-step" className="rounded-md px-2 py-1 text-center" style={{ color: step.complete ? 'var(--success)' : 'var(--text-tertiary)', background: step.complete ? 'var(--success-light)' : 'var(--bg-hover)' }}>
            {step.complete ? '✓ ' : ''}{step.label}
          </li>
        ))}
      </ol>
      <div className="grid grid-cols-2 gap-3 p-4 text-xs">
        <EditorField label={t('provider.editor.name')}>
          <input value={draft.name} onChange={(event) => updateDraft('name', event.target.value)} placeholder={t('provider.editor.namePlaceholder')} className="provider-input" />
        </EditorField>
        <EditorField label={t('provider.editor.providerType')}>
          <select
            value={draft.type}
            onChange={(event) => {
              const type = event.target.value as ModelProviderType;
              setDraft((current) => ({ ...current, type, apiFormat: defaultApiFormat(type) }));
              setValidation(null);
            }}
            className="provider-input"
          >
            <option value="anthropic">{providerTypeLabel('anthropic')}</option>
            <option value="anthropic-compatible">{providerTypeLabel('anthropic-compatible')}</option>
            <option value="openai-compatible">{providerTypeLabel('openai-compatible')}</option>
            <option value="custom">{providerTypeLabel('custom')}</option>
          </select>
        </EditorField>
        <EditorField label={t('provider.editor.apiFormat')}>
          <select value={draft.apiFormat} onChange={(event) => updateDraft('apiFormat', event.target.value as ModelApiFormat)} className="provider-input">
            <option value="anthropic-messages">Anthropic Messages</option>
            <option value="openai-chat-completions">OpenAI Chat Completions</option>
          </select>
        </EditorField>
        <EditorField label={t('provider.details.baseUrl')}>
          <input
            value={draft.baseUrlIntent.mode === 'preserve_existing'
              ? initialProvider?.baseUrl ?? ''
              : draft.baseUrlIntent.value ?? ''}
            onChange={(event) => {
              setDraft((current) => replaceProviderBaseUrl(
                current,
                event.target.value || null,
              ));
              setValidation(null);
            }}
            placeholder={draft.type === 'anthropic' ? t('provider.editor.officialBaseUrlPlaceholder') : 'https://api.example.com'}
            className="provider-input"
          />
          {initialProvider?.baseUrlPathRedacted ? (
            <span className="mt-1 block" style={{ color: 'var(--text-tertiary)' }}>
              {draft.baseUrlIntent.mode === 'preserve_existing'
                ? t('provider.editor.hiddenPathPreserved')
                : t('provider.editor.hiddenPathReplaced')}
            </span>
          ) : null}
        </EditorField>
        <EditorField label={t('provider.editor.modelId')}>
          <input value={draft.defaultModelId ?? ''} onChange={(event) => updateDraft('defaultModelId', event.target.value || null)} placeholder={t('provider.editor.modelIdPlaceholder')} className="provider-input" />
        </EditorField>
        <EditorField label={mode === 'edit' ? t('provider.editor.replaceApiKey') : t('provider.editor.apiKey')}>
          <input
            type="password"
            autoComplete="new-password"
            value={credential}
            onChange={(event) => {
              setCredential(event.target.value);
              setValidation(null);
            }}
            placeholder={mode === 'edit' ? t('provider.editor.apiKeyEditPlaceholder') : t('provider.editor.apiKeyCreatePlaceholder')}
            className="provider-input"
          />
          {mode === 'edit' ? <span className="mt-1 block" style={{ color: 'var(--text-tertiary)' }}>{t('provider.editor.credentialReplaceOnly')}</span> : null}
        </EditorField>
      </div>
      <div className="space-y-2 border-t px-4 py-3" style={{ borderColor: 'var(--border-primary)' }}>
        {validation?.connection.ok ? (
          <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--success)' }} role="status">
            <ShieldCheck size={14} />
            {t('provider.editor.connectionSucceeded').replace('{latency}', String(validation.connection.latencyMs))}
            {validation.connection.discoveredModelIds.length > 0
              ? ` · ${t('provider.editor.modelsDiscovered').replace('{count}', String(validation.connection.discoveredModelIds.length))}`
              : ''}
          </div>
        ) : <p className="text-xs" style={{ color: error ? 'var(--error)' : 'var(--text-tertiary)' }}>{error ?? t('provider.editor.connectionRequired')}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-xs" style={{ background: 'var(--bg-hover)' }}>{t('common.cancel')}</button>
          <button type="button" onClick={() => void testConnection()} disabled={!canTest || working || busy} data-testid="validate-provider" className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs disabled:opacity-40" style={{ background: 'var(--bg-hover)' }}><RefreshCw size={12} />{working ? t('provider.editor.testing') : t('provider.action.test')}</button>
          <button type="button" onClick={() => void save()} disabled={!canSave || working || busy} data-testid="save-provider" className="rounded-lg px-3 py-1.5 text-xs disabled:opacity-40" style={{ color: 'var(--accent-text)', background: 'var(--accent)' }}>{t('provider.editor.save')}</button>
        </div>
      </div>
    </section>
  );
}

function EditorField({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block" style={{ color: 'var(--text-secondary)' }}>{label}</span>{children}</label>;
}

const AGENT_ROLE_KEYS: Readonly<Record<AgentModelPolicyAssignment['agentType'], Parameters<typeof t>[0]>> = {
  planner: 'agent.role.planner', coder: 'agent.role.coder', tester: 'agent.role.tester', reviewer: 'agent.role.reviewer', fixer: 'agent.role.fixer',
};
const AGENT_ROLE_LABELS: Readonly<Record<AgentModelPolicyAssignment['agentType'], string>> = {
  planner: 'Planner', coder: 'Coder', tester: 'Tester', reviewer: 'Reviewer', fixer: 'Fixer',
};
const AGENT_ROLES = Object.keys(AGENT_ROLE_KEYS) as AgentModelPolicyAssignment['agentType'][];

export interface AgentModelPolicyEditorProps {
  providers: PublicModelProvider[];
  modelsByProvider: Readonly<Record<string, ProviderModel[]>>;
  assignments: AgentModelPolicyAssignment[];
  references?: PublicAgentModelPolicyReference[];
  busy?: boolean;
  onChange(agentType: AgentModelPolicyAssignment['agentType'], assignment: AgentModelPolicyAssignment | null): void;
}

function pairValue(providerId: string, modelId: string): string {
  return `${encodeURIComponent(providerId)}:${encodeURIComponent(modelId)}`;
}

function parsePairValue(value: string): { providerId: string; modelId: string } | null {
  const separator = value.indexOf(':');
  if (separator < 0) return null;
  return {
    providerId: decodeURIComponent(value.slice(0, separator)),
    modelId: decodeURIComponent(value.slice(separator + 1)),
  };
}

function tierValue(tier: ModelTier): string {
  return `tier:${tier}`;
}

function localizedRole(role: AgentModelPolicyAssignment['agentType']): string {
  return t(AGENT_ROLE_KEYS[role]);
}

export function AgentModelPolicyEditor({
  providers,
  modelsByProvider,
  assignments,
  references = [],
  busy = false,
  onChange,
}: AgentModelPolicyEditorProps) {
  const assignmentByRole = new Map(assignments.map((assignment) => [assignment.agentType, assignment]));
  const referenceByRole = new Map(references.map((reference) => [reference.agentType, reference]));

  const updateRating = (
    role: AgentModelPolicyAssignment['agentType'],
    field: keyof AgentModelPolicyAssignment['notes'],
    rating: PolicyRating | null,
  ) => {
    const current = assignmentByRole.get(role);
    if (!current) return;
    onChange(role, { ...current, notes: { ...current.notes, [field]: rating } });
  };

  return (
    <section className="space-y-3 rounded-xl border p-4" style={{ borderColor: 'var(--border-primary)' }} data-testid="agent-model-policy-editor">
      <div>
        <h4 className="text-sm font-semibold">{t('agent.manual.title')}</h4>
        <p className="mt-1 text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('agent.manual.disclaimer')}</p>
      </div>
      <div className="space-y-2">
        {AGENT_ROLES.map((role) => {
          const current = assignmentByRole.get(role);
          const persisted = referenceByRole.get(role);
          const tier = persisted?.reference.kind === 'tier' ? persisted.reference.tier : null;
          const notes = current?.notes ?? persisted?.notes;
          const roleName = localizedRole(role);
          const runnable = selectableWorkflowProviders(providers, role);
          const invalidCurrent = Boolean(current) && !runnable.some(
            (provider) => provider.id === current?.providerId,
          );
          return (
            <div key={role} className="grid grid-cols-[72px_minmax(160px,1fr)_92px_92px_92px] items-center gap-2 text-xs" data-testid="agent-policy-row">
              <strong>{roleName}</strong>
              <div>
                <select
                  aria-label={t('agent.manual.modelAria').replace('{role}', roleName)}
                  disabled={busy}
                  value={tier ? tierValue(tier) : current ? pairValue(current.providerId, current.modelId) : ''}
                  onChange={(event) => {
                    const pair = parsePairValue(event.target.value);
                    onChange(role, pair ? {
                      agentType: role,
                      ...pair,
                      notes: current?.notes ?? { quality: null, speed: null, cost: null },
                    } : null);
                  }}
                  className="provider-input"
                >
                  <option value="">{t('agent.manual.followDefault')}</option>
                  {tier ? <option value={tierValue(tier)}>{t('agent.manual.tierValue').replace('{tier}', t(`agent.tiers.${tier === 'high_quality' ? 'highQuality' : tier}`))}</option> : null}
                  {invalidCurrent && current ? (
                    <option value={pairValue(current.providerId, current.modelId)} disabled>{AGENT_MODEL_RECONFIGURATION_MESSAGE}</option>
                  ) : null}
                  {runnable.flatMap((provider) => (modelsByProvider[provider.id] ?? []).map((model) => (
                    <option key={`${provider.id}:${model.modelId}`} value={pairValue(provider.id, model.modelId)}>{provider.name} / {model.modelId}</option>
                  )))}
                </select>
                {invalidCurrent ? <span role="alert" className="mt-1 block text-[10px]" style={{ color: 'var(--warning)' }}>{AGENT_MODEL_RECONFIGURATION_MESSAGE}</span> : null}
              </div>
              {(['quality', 'speed', 'cost'] as const).map((field) => (
                <label key={field}>
                  <span className="mb-1 block text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{t(`agent.tiers.${field}`)}</span>
                  <select aria-label={`${roleName} ${t(`agent.tiers.${field}`)}`} value={notes?.[field] ?? ''} disabled={!current || busy} onChange={(event) => updateRating(role, field, (event.target.value || null) as PolicyRating | null)} className="provider-input">
                    <option value="">—</option>
                    {POLICY_RATINGS.map((rating) => <option key={rating} value={rating}>{t(`agent.tiers.note.${rating}`)}</option>)}
                  </select>
                </label>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function GlobalAgentModelPolicySettings({ onChanged }: { onChanged?(): void }) {
  const [providers, setProviders] = useState<PublicModelProvider[]>([]);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, ProviderModel[]>>({});
  const [policies, setPolicies] = useState<PublicAgentModelPolicy[]>([]);
  const [references, setReferences] = useState<PublicAgentModelPolicyReference[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [page, referenceRows] = await Promise.all([
      window.api.listModelProviders({ limit: 100, offset: 0, enabled: true }),
      window.api.listAgentModelPolicyReferences({ scope: { type: 'global' } }),
    ]);
    const data = await loadAgentPolicyEditorData(page.items, {
      listPolicies: window.api.listAgentModelPolicies,
      getProvider: window.api.getModelProvider,
      listModels: window.api.listModelProviderModels,
    });
    setProviders(data.providers);
    setModelsByProvider(data.modelsByProvider);
    setPolicies(data.policies);
    setReferences(referenceRows.map((row) => ({
      scope: row.scope.type === 'global' ? { type: 'global' } : { type: 'project', projectId: row.scope.projectId },
      agentType: row.agentType,
      reference: row.reference.kind === 'tier'
        ? { kind: 'tier', tier: row.reference.tier }
        : { kind: 'model', providerId: row.reference.providerId, modelId: row.reference.modelId },
      providerName: typeof row.providerName === 'string' ? row.providerName : null,
      notes: { quality: row.notes.quality, speed: row.notes.speed, cost: row.notes.cost },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })));
  }, []);

  useEffect(() => {
    let active = true;
    void load().catch(() => {
      if (active) setError(t('agent.manual.loadFailed'));
    });
    const unsubscribe = window.api.onModelProviderChanged?.(() => {
      if (active) void load().catch(() => setError(t('agent.manual.loadFailed')));
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [load]);

  const assignments: AgentModelPolicyAssignment[] = policies.map((policy) => ({
    agentType: policy.agentType,
    providerId: policy.providerId,
    modelId: policy.modelId,
    notes: { ...policy.notes },
  }));

  return (
    <div className="space-y-2 agent-manual-policy-settings">
      <AgentModelPolicyEditor
        providers={providers}
        modelsByProvider={modelsByProvider}
        assignments={assignments}
        references={references}
        busy={busy}
        onChange={(agentType, assignment) => {
          setBusy(true);
          setError(null);
          void persistAgentPolicyChange(agentType, assignment, {
            setPolicy: window.api.setAgentModelPolicy,
            deletePolicy: window.api.deleteAgentModelPolicy,
          }).then(load)
            .then(() => onChanged?.())
            .catch(() => setError(t('agent.manual.saveFailed')))
            .finally(() => setBusy(false));
        }}
      />
      {error ? <p className="text-xs" style={{ color: 'var(--error)' }} role="alert">{error}</p> : null}
    </div>
  );
}

const PROJECT_ROLE_LABELS: Readonly<Record<ProjectModelPolicyAgentType, string>> = {
  default: '项目默认',
  ...AGENT_ROLE_LABELS,
};
const PROJECT_ROLES = Object.keys(PROJECT_ROLE_LABELS) as ProjectModelPolicyAgentType[];

export interface ProjectModelPolicyEditorProps {
  providers: PublicModelProvider[];
  modelsByProvider: Readonly<Record<string, ProviderModel[]>>;
  policies: PublicProjectModelPolicy[];
  busy?: boolean;
  onChange(agentType: ProjectModelPolicyAgentType, policy: PublicProjectModelPolicy | null): void;
}

export function ProjectModelPolicyEditor({
  providers,
  modelsByProvider,
  policies,
  busy = false,
  onChange,
}: ProjectModelPolicyEditorProps) {
  const policyByRole = new Map(policies.map((policy) => [policy.agentType, policy]));

  return (
    <section className="space-y-3 rounded-lg border p-3" style={{ borderColor: 'var(--border-secondary)' }} data-testid="project-model-policy-editor">
      <div>
        <h3 className="text-xs font-semibold">模型策略</h3>
        <p className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>项目策略优先于全局 Agent 策略，仅显示支持 Agent Workflow 的 Provider。</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {PROJECT_ROLES.map((role) => {
          const policy = policyByRole.get(role);
          const runnable = selectableWorkflowProviders(providers, role);
          const invalidCurrent = Boolean(policy) && !runnable.some(
            (provider) => provider.id === policy?.providerId,
          );
          return (
            <label key={role} className="block text-xs" data-testid="project-policy-row">
              <span className="mb-1 block" style={{ color: 'var(--text-secondary)' }}>{PROJECT_ROLE_LABELS[role]}</span>
              <select
                aria-label={`${PROJECT_ROLE_LABELS[role]} 模型`}
                className="provider-input"
                disabled={busy}
                value={policy ? pairValue(policy.providerId, policy.modelId) : ''}
                onChange={(event) => {
                  const pair = parsePairValue(event.target.value);
                  onChange(role, pair ? {
                    projectId: policy?.projectId ?? '',
                    agentType: role,
                    ...pair,
                    createdAt: policy?.createdAt ?? 0,
                    updatedAt: policy?.updatedAt ?? 0,
                  } : null);
                }}
              >
                <option value="">跟随上级策略</option>
                {invalidCurrent && policy ? (
                  <option value={pairValue(policy.providerId, policy.modelId)} disabled>{AGENT_MODEL_RECONFIGURATION_MESSAGE}</option>
                ) : null}
                {runnable.flatMap((provider) => (modelsByProvider[provider.id] ?? []).map((model) => (
                  <option key={`${provider.id}:${model.modelId}`} value={pairValue(provider.id, model.modelId)}>{provider.name} / {model.modelId}</option>
                )))}
              </select>
              {invalidCurrent ? <span role="alert" className="mt-1 block text-[10px]" style={{ color: 'var(--warning)' }}>{AGENT_MODEL_RECONFIGURATION_MESSAGE}</span> : null}
            </label>
          );
        })}
      </div>
    </section>
  );
}

export function ProjectModelPolicySettings({ projectId }: { projectId: string }) {
  const [providers, setProviders] = useState<PublicModelProvider[]>([]);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, ProviderModel[]>>({});
  const [policies, setPolicies] = useState<PublicProjectModelPolicy[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [page, nextPolicies] = await Promise.all([
      window.api.listModelProviders({ limit: 100, offset: 0, enabled: true }),
      window.api.listProjectModelPolicies({ projectId }),
    ]);
    const providerMap = new Map(page.items.map((provider) => [provider.id, provider]));
    for (const providerId of new Set(nextPolicies.map((policy) => policy.providerId))) {
      if (!providerMap.has(providerId)) {
        providerMap.set(providerId, await window.api.getModelProvider(providerId));
      }
    }
    const nextProviders = [...providerMap.values()];
    const modelEntries = await Promise.all(
      selectableWorkflowProviders(nextProviders).map(async (provider) => (
        [provider.id, await window.api.listModelProviderModels(provider.id)] as const
      )),
    );
    setProviders(nextProviders);
    setModelsByProvider(Object.fromEntries(modelEntries));
    setPolicies(nextPolicies);
  }, [projectId]);

  useEffect(() => {
    let active = true;
    void load().catch((reason) => {
      if (active) setError(publicError(reason, '无法读取项目模型策略。'));
    });
    const unsubscribe = window.api.onModelProviderChanged(() => {
      if (active) void load().catch(() => {});
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [load]);

  return (
    <div className="space-y-2">
      <ProjectModelPolicyEditor
        providers={providers}
        modelsByProvider={modelsByProvider}
        policies={policies}
        busy={busy}
        onChange={(agentType, policy) => {
          setBusy(true);
          setError(null);
          const normalized = policy ? { ...policy, projectId } : null;
          void persistProjectPolicyChange(projectId, agentType, normalized, {
            setPolicy: window.api.setProjectModelPolicy,
            deletePolicy: window.api.deleteProjectModelPolicy,
          }).then(load)
            .catch((reason) => setError(publicError(reason, '项目模型策略保存失败。')))
            .finally(() => setBusy(false));
        }}
      />
      {error ? <p className="text-xs" style={{ color: 'var(--error)' }} role="alert">{error}</p> : null}
    </div>
  );
}

export const modelProviderCenterInternals = {
  defaultApiFormat,
  draftFromProvider,
  pairValue,
  parsePairValue,
};
