import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Settings2, X } from 'lucide-react';
import type {
  BindAllModelTiersRequest,
  ClearProjectModelTierBindingRequest,
  GetModelTierBindingsRequest,
  ListModelTierCandidatesRequest,
  ModelTier,
  ModelTierCandidatePublic,
  ModelTierDisplayMetadata,
  ModelTierInvalidReason,
  ModelTierResolutionPublic,
  ModelTierScope,
  SetModelTierBindingRequest,
  UpdateModelTierDisplayMetadataRequest,
} from '../../../shared/types/modelTiers';
import { MODEL_TIERS } from '../../../shared/types/modelTiers';
import type { PolicyRating } from '../../../shared/types/modelProviders';
import { EmptyState } from '../../components/EmptyState';
import { getLocale, t, type LocaleKey } from '../../i18n';

export interface AgentTierSettingsApi {
  listModelTierCandidates(input: ListModelTierCandidatesRequest): Promise<ModelTierCandidatePublic[]>;
  listModelTierBindings(input: GetModelTierBindingsRequest): Promise<ModelTierResolutionPublic[]>;
  setModelTierBinding(input: SetModelTierBindingRequest): Promise<ModelTierResolutionPublic>;
  bindAllModelTiers(input: BindAllModelTiersRequest): Promise<ModelTierResolutionPublic[]>;
  updateModelTierDisplayMetadata(input: UpdateModelTierDisplayMetadataRequest): Promise<ModelTierResolutionPublic>;
  clearProjectModelTierBinding(input: ClearProjectModelTierBindingRequest): Promise<boolean>;
}

export interface AgentModelTierSettingsProps {
  scope: ModelTierScope;
  api?: AgentTierSettingsApi;
  onOpenProviderCenter(): void;
}

export interface TierBindingWizardProps extends AgentModelTierSettingsProps {
  tiers: ModelTier[];
  onComplete(): void;
  onCancel(): void;
}

interface SafeTierView {
  scope: ModelTierScope;
  tier: ModelTier;
  display: ModelTierDisplayMetadata;
  source: 'global' | 'project' | 'none';
  candidate: ModelTierCandidatePublic | null;
  validity: ModelTierResolutionPublic['validity'];
  invalidReason: ModelTierInvalidReason | null;
}

const focusableSelector = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function AgentSettingsModal({
  title,
  onCancel,
  closeDisabled = false,
  children,
}: {
  title: string;
  onCancel(): void;
  closeDisabled?: boolean;
  children: React.ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    queueMicrotask(() => {
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(focusableSelector);
      focusables?.[0]?.focus();
    });
    return () => origin?.focus();
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')];
    if (dialogs.at(-1) !== panelRef.current) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!closeDisabled) onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = [...(panelRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])];
    if (focusables.length === 0) {
      event.preventDefault();
      panelRef.current?.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="agent-settings-modal-backdrop" onMouseDown={(event) => {
      if (!closeDisabled && event.target === event.currentTarget) onCancel();
    }}>
      <div
        ref={panelRef}
        className="agent-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="agent-settings-modal-header">
          <h3 id={titleId}>{title}</h3>
          <button type="button" disabled={closeDisabled} onClick={onCancel} aria-label={t('common.close')} className="agent-icon-button">
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

function safeCandidate(value: ModelTierCandidatePublic): ModelTierCandidatePublic {
  return {
    providerId: value.providerId,
    providerName: value.providerName,
    modelId: value.modelId,
    modelDisplayName: value.modelDisplayName,
    runtimeType: value.runtimeType,
    executionSource: value.executionSource,
    health: {
      state: value.health.state,
      lastTestedAt: value.health.lastTestedAt,
    },
  };
}

function safeTierView(value: ModelTierResolutionPublic): SafeTierView {
  return {
    scope: value.scope.type === 'global'
      ? { type: 'global' }
      : { type: 'project', projectId: value.scope.projectId },
    tier: value.tier,
    display: {
      tier: value.display.tier,
      displayName: value.display.displayName,
      quality: value.display.quality,
      speed: value.display.speed,
      cost: value.display.cost,
    },
    source: value.source,
    candidate: value.candidate ? safeCandidate(value.candidate) : null,
    validity: value.validity,
    invalidReason: value.invalidReason,
  };
}

function tierLabel(tier: ModelTier): string {
  const key: Record<ModelTier, LocaleKey> = {
    high_quality: 'agent.tiers.highQuality',
    balanced: 'agent.tiers.balanced',
    fast: 'agent.tiers.fast',
  };
  return t(key[tier]);
}

export function modelTierScopeIdentity(scope: ModelTierScope): string {
  return scope.type === 'global' ? 'global' : `project:${scope.projectId}`;
}

function tierActionLabel(action: string, label: string): string {
  return getLocale() === 'en-US' ? `${action} ${label} tier` : `${action}${label}档位`;
}

function tierNoteLabel(label: string, field: string): string {
  return getLocale() === 'en-US' ? `${label} ${field} note` : `${label}${field}备注`;
}

function saveTierNotesLabel(label: string): string {
  return getLocale() === 'en-US' ? `Save ${label} tier notes` : `保存${label}档位备注`;
}

export function localizedTierLabel(tier: ModelTier): string {
  return tierLabel(tier);
}

export function invalidReasonLabel(reason: ModelTierInvalidReason | null): string {
  return t(`agent.tiers.reason.${reason ?? 'tier_unbound'}` as LocaleKey);
}

export function localizedTierSourceLabel(source: SafeTierView['source']): string {
  return t(`agent.tiers.source.${source}` as LocaleKey);
}

function healthLabel(candidate: ModelTierCandidatePublic | null): string {
  if (!candidate) return '—';
  if (candidate.health.state === 'connected') return t('agent.tiers.connected');
  if (candidate.health.state === 'configured') return t('agent.tiers.unknownHealth');
  return t('agent.tiers.disconnected');
}

function lastTestLabel(candidate: ModelTierCandidatePublic | null): string {
  const timestamp = candidate?.health.lastTestedAt;
  if (timestamp === null || timestamp === undefined) return t('agent.tiers.neverTested');
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

function fallbackApi(): AgentTierSettingsApi {
  return window.api;
}

function safeTierError(): string {
  return t('agent.tiers.saveFailed');
}

export function TierBindingWizard({
  scope,
  tiers,
  api,
  onComplete,
  onCancel,
  onOpenProviderCenter,
}: TierBindingWizardProps) {
  const port = api ?? fallbackApi();
  const [candidates, setCandidates] = useState<ModelTierCandidatePublic[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [tierIndex, setTierIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const currentScopeIdentity = modelTierScopeIdentity(scope);
  const scopeIdentityRef = useRef(currentScopeIdentity);
  scopeIdentityRef.current = currentScopeIdentity;
  const uniqueTiers = MODEL_TIERS.filter((tier) => tiers.includes(tier));
  const currentTier = uniqueTiers[tierIndex] ?? uniqueTiers[0] ?? 'balanced';

  useEffect(() => {
    let active = true;
    setLoading(true);
    port.listModelTierCandidates({ scope })
      .then((values) => {
        if (active) setCandidates(values.map(safeCandidate));
      })
      .catch(() => {
        if (active) setError(t('agent.tiers.loadFailed'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [port, scope]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const selected = candidates[selectedIndex] ?? null;

  const saveCurrent = async () => {
    if (!selected) return;
    const mutationScopeIdentity = currentScopeIdentity;
    setBusy(true);
    setError(null);
    try {
      await port.setModelTierBinding({
        scope,
        tier: currentTier,
        providerId: selected.providerId,
        modelId: selected.modelId,
      });
      if (!mountedRef.current || scopeIdentityRef.current !== mutationScopeIdentity) return;
      if (tierIndex + 1 < uniqueTiers.length) setTierIndex((value) => value + 1);
      else onComplete();
    } catch {
      if (mountedRef.current && scopeIdentityRef.current === mutationScopeIdentity) setError(safeTierError());
    } finally {
      if (mountedRef.current && scopeIdentityRef.current === mutationScopeIdentity) setBusy(false);
    }
  };

  const bindAll = async () => {
    if (!selected) return;
    const mutationScopeIdentity = currentScopeIdentity;
    setBusy(true);
    setError(null);
    try {
      await port.bindAllModelTiers({ scope, providerId: selected.providerId, modelId: selected.modelId });
      if (mountedRef.current && scopeIdentityRef.current === mutationScopeIdentity) onComplete();
    } catch {
      if (mountedRef.current && scopeIdentityRef.current === mutationScopeIdentity) setError(safeTierError());
    } finally {
      if (mountedRef.current && scopeIdentityRef.current === mutationScopeIdentity) setBusy(false);
    }
  };

  return (
    <AgentSettingsModal title={t('agent.tiers.wizardTitle')} onCancel={onCancel} closeDisabled={busy}>
      <div className="agent-settings-modal-body">
        <p className="agent-help-text">{t('agent.tiers.wizardDescription')}</p>
        <p className="agent-tier-disclaimer">{t('agent.tiers.disclaimer')}</p>
        {loading ? <p role="status" aria-live="polite">{t('common.loading')}</p> : null}
        {!loading && candidates.length === 0 ? (
          <EmptyState
            icon={AlertTriangle}
            title={t('agent.tiers.noCandidates')}
            description={t('agent.tiers.wizardDescription')}
            action={{
              label: t('agent.tiers.openProviderCenter'),
              onClick: () => {
                onCancel();
                onOpenProviderCenter();
              },
            }}
            compact
          />
        ) : null}
        {!loading && candidates.length > 0 ? (
          <fieldset className="agent-candidate-list" disabled={busy}>
            <legend>{t('agent.tiers.selectCandidate')} · {tierLabel(currentTier)}</legend>
            {candidates.map((candidate, index) => (
              <label key={`${candidate.providerId}:${candidate.modelId}`} className="agent-candidate-option">
                <input
                  type="radio"
                  name="agent-tier-candidate"
                  disabled={busy}
                  checked={selectedIndex === index}
                  onChange={() => setSelectedIndex(index)}
                />
                <span className="agent-candidate-copy">
                  <strong title={candidate.providerName}>{candidate.providerName}</strong>
                  <span title={candidate.modelId}>{candidate.modelDisplayName ?? candidate.modelId}</span>
                  {candidate.modelDisplayName ? <span className="agent-sr-only">{candidate.modelId}</span> : null}
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
        {error ? <p role="alert" className="agent-error-text">{error}</p> : null}
        {busy ? <p role="status" aria-label={t('agent.tiers.saving')} aria-live="polite">{t('agent.tiers.saving')}</p> : null}
      </div>
      <footer className="agent-settings-modal-actions">
        <button type="button" className="agent-secondary-button" disabled={busy} onClick={onCancel}>{t('common.cancel')}</button>
        {candidates.length === 1 ? (
          <button type="button" className="agent-secondary-button" disabled={busy} onClick={() => void bindAll()}>
            {t('agent.tiers.useAll')}
          </button>
        ) : null}
        {candidates.length > 0 ? (
          <button type="button" className="agent-primary-button" disabled={busy || !selected} onClick={() => void saveCurrent()}>
            {t('agent.tiers.saveBinding')}
          </button>
        ) : null}
      </footer>
    </AgentSettingsModal>
  );
}

function NoteSelect({
  ariaLabel,
  value,
  onChange,
}: {
  ariaLabel: string;
  value: PolicyRating | null;
  onChange(value: PolicyRating | null): void;
}) {
  return (
    <select aria-label={ariaLabel} value={value ?? ''} onChange={(event) => onChange((event.target.value || null) as PolicyRating | null)}>
      <option value="">{t('agent.tiers.note.none')}</option>
      {(['low', 'medium', 'high'] as const).map((rating) => (
        <option key={rating} value={rating}>{t(`agent.tiers.note.${rating}` as LocaleKey)}</option>
      ))}
    </select>
  );
}

function TierCard({
  view,
  busy,
  onModify,
  onSaveNotes,
  onFollowGlobal,
}: {
  view: SafeTierView;
  busy: boolean;
  onModify(): void;
  onSaveNotes(metadata: ModelTierDisplayMetadata): void;
  onFollowGlobal?: () => void;
}) {
  const label = tierLabel(view.tier);
  const [notes, setNotes] = useState(view.display);
  useEffect(() => setNotes(view.display), [view.display]);
  const candidate = view.candidate;
  const invalid = view.validity !== 'valid';
  return (
    <article className="agent-tier-card">
      <div className="agent-tier-card-heading">
        <div className="agent-min-w-0">
          <h3>{view.display.displayName ?? label}</h3>
          <p>{t('agent.tiers.sourcePrefix')}{getLocale() === 'en-US' ? ': ' : '：'}{localizedTierSourceLabel(view.source)}</p>
        </div>
        <button
          type="button"
          className="agent-secondary-button"
          onClick={onModify}
          aria-label={tierActionLabel(invalid ? t('agent.tiers.reconfigure') : t('agent.tiers.modify'), label)}
        >
          <Settings2 size={13} aria-hidden="true" />
          {invalid ? t('agent.tiers.reconfigure') : t('agent.tiers.modify')}
        </button>
        {onFollowGlobal ? <button
          type="button"
          className="agent-secondary-button"
          disabled={busy}
          aria-label={t('project.ai.followGlobalAria').replace('{tier}', label)}
          onClick={onFollowGlobal}
        >{t('project.ai.followGlobal')}</button> : null}
      </div>
      {invalid ? (
        <div className="agent-invalid-state" role="status">
          <AlertTriangle size={15} aria-hidden="true" />
          <strong>{t('agent.tiers.needsReconfiguration')}</strong>
          <span>{invalidReasonLabel(view.invalidReason)}</span>
        </div>
      ) : (
        <div className="agent-valid-state"><CheckCircle2 size={15} aria-hidden="true" />{t('agent.tiers.connected')}</div>
      )}
      <dl className="agent-tier-facts">
        <div><dt>{t('agent.tiers.provider')}</dt><dd title={candidate?.providerName}>{candidate?.providerName ?? '—'}</dd></div>
        <div><dt>{t('agent.tiers.model')}</dt><dd title={candidate?.modelId}>{candidate ? (candidate.modelDisplayName ?? candidate.modelId) : '—'}</dd></div>
        <div><dt>{t('agent.tiers.runtime')}</dt><dd>{candidate?.runtimeType ?? '—'}</dd></div>
        <div><dt>{t('agent.tiers.connection')}</dt><dd>{healthLabel(candidate)}</dd></div>
        <div><dt>{t('agent.tiers.lastTested')}</dt><dd>{lastTestLabel(candidate)}</dd></div>
      </dl>
      <div className="agent-tier-notes">
        {(['quality', 'speed', 'cost'] as const).map((field) => (
          <label key={field}>
            <span>{t(`agent.tiers.${field}` as LocaleKey)}</span>
            <NoteSelect
              ariaLabel={tierNoteLabel(label, t(`agent.tiers.${field}` as LocaleKey))}
              value={notes[field]}
              onChange={(value) => setNotes((current) => ({ ...current, [field]: value }))}
            />
          </label>
        ))}
        <button
          type="button"
          className="agent-secondary-button"
          disabled={busy}
          aria-label={saveTierNotesLabel(label)}
          onClick={() => onSaveNotes(notes)}
        >{t('agent.tiers.saveNotes')}</button>
      </div>
    </article>
  );
}

export function AgentModelTierSettings({ scope, api, onOpenProviderCenter }: AgentModelTierSettingsProps) {
  const port = api ?? fallbackApi();
  const scopeProjectId = scope.type === 'project' ? scope.projectId : null;
  const scopeIdentity = scopeProjectId === null ? 'global' : `project:${scopeProjectId}`;
  const scopeIdentityRef = useRef(scopeIdentity);
  const scopeIncarnationRef = useRef({ identity: scopeIdentity, value: 0 });
  const noteMutationEpochRef = useRef(0);
  if (scopeIncarnationRef.current.identity !== scopeIdentity) {
    scopeIncarnationRef.current = {
      identity: scopeIdentity,
      value: scopeIncarnationRef.current.value + 1,
    };
    noteMutationEpochRef.current += 1;
  }
  scopeIdentityRef.current = scopeIdentity;
  const scopeIncarnation = scopeIncarnationRef.current.value;
  const loadEpochRef = useRef(0);
  const mountedRef = useRef(true);
  const [views, setViews] = useState<SafeTierView[]>([]);
  const [loadedScopeIdentity, setLoadedScopeIdentity] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyTier, setBusyTier] = useState<ModelTier | null>(null);
  const [wizard, setWizard] = useState<{ scopeIdentity: string; tiers: ModelTier[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const requestScope: ModelTierScope = scopeProjectId === null
      ? { type: 'global' }
      : { type: 'project', projectId: scopeProjectId };
    const requestScopeIdentity = modelTierScopeIdentity(requestScope);
    const requestEpoch = ++loadEpochRef.current;
    setLoading(true);
    setError(null);
    try {
      const values = await port.listModelTierBindings({ scope: requestScope });
      if (!mountedRef.current || scopeIdentityRef.current !== requestScopeIdentity || loadEpochRef.current !== requestEpoch) return;
      setViews(values.map(safeTierView));
      setLoadedScopeIdentity(requestScopeIdentity);
    } catch {
      if (mountedRef.current && scopeIdentityRef.current === requestScopeIdentity && loadEpochRef.current === requestEpoch) {
        setError(t('agent.tiers.loadFailed'));
      }
    } finally {
      if (mountedRef.current && scopeIdentityRef.current === requestScopeIdentity && loadEpochRef.current === requestEpoch) {
        setLoading(false);
      }
    }
  }, [port, scopeProjectId]);

  useEffect(() => {
    setViews([]);
    setLoadedScopeIdentity(null);
    setWizard(null);
    setBusyTier(null);
    setError(null);
    void load();
    return () => { loadEpochRef.current += 1; };
  }, [load, scopeIdentity]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const visibleViews = loadedScopeIdentity === scopeIdentity ? views : [];

  return (
    <section className="agent-settings-section agent-tier-settings" aria-labelledby="agent-tier-settings-title">
      <header>
        <h2 id="agent-tier-settings-title">{t('agent.tiers.title')}</h2>
        <p className="agent-tier-disclaimer">{t('agent.tiers.disclaimer')}</p>
      </header>
      {loading ? <p role="status" aria-live="polite">{t('common.loading')}</p> : null}
      {error ? <p role="alert" className="agent-error-text">{error}</p> : null}
      <div className="agent-tier-card-list">
        {MODEL_TIERS.map((tier) => {
          const view = visibleViews.find((item) => item.tier === tier);
          return view ? <TierCard
            key={tier}
            view={view}
            busy={busyTier === tier}
            onModify={() => setWizard({ scopeIdentity, tiers: [tier] })}
            onFollowGlobal={scopeProjectId !== null && view.source === 'project' ? () => {
              const requestScopeIdentity = scopeIdentity;
              setBusyTier(tier);
              setError(null);
              void port.clearProjectModelTierBinding({
                projectId: scopeProjectId,
                tier,
              }).then(() => {
                if (mountedRef.current && scopeIdentityRef.current === requestScopeIdentity) return load();
                return undefined;
              }).catch(() => {
                if (mountedRef.current && scopeIdentityRef.current === requestScopeIdentity) setError(safeTierError());
              }).finally(() => {
                if (mountedRef.current && scopeIdentityRef.current === requestScopeIdentity) setBusyTier(null);
              });
            } : undefined}
            onSaveNotes={(metadata) => {
              if (loadedScopeIdentity !== scopeIdentity) return;
              const mutationScope: ModelTierScope = scopeProjectId === null
                ? { type: 'global' }
                : { type: 'project', projectId: scopeProjectId };
              const mutationScopeIdentity = scopeIdentity;
              const mutationScopeIncarnation = scopeIncarnation;
              const mutationEpoch = ++noteMutationEpochRef.current;
              const acceptsMutation = () => mountedRef.current
                && scopeIdentityRef.current === mutationScopeIdentity
                && scopeIncarnationRef.current.value === mutationScopeIncarnation
                && noteMutationEpochRef.current === mutationEpoch;
              setBusyTier(tier);
              setError(null);
              void port.updateModelTierDisplayMetadata({ scope: mutationScope, metadata })
                .then(() => {
                  if (acceptsMutation()) return load();
                  return undefined;
                })
                .catch(() => {
                  if (acceptsMutation()) setError(safeTierError());
                })
                .finally(() => {
                  if (acceptsMutation()) setBusyTier(null);
                });
            }}
          /> : null;
        })}
      </div>
      {wizard?.scopeIdentity === scopeIdentity ? <TierBindingWizard
        scope={scope}
        tiers={wizard.tiers}
        api={port}
        onOpenProviderCenter={onOpenProviderCenter}
        onCancel={() => setWizard(null)}
        onComplete={() => {
          setWizard(null);
          void load();
        }}
      /> : null}
    </section>
  );
}
