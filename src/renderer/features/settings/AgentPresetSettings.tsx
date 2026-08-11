import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Layers3 } from 'lucide-react';
import {
  AGENT_PRESET_IDS,
  MODEL_TIERS,
  type AgentPresetApplyResult,
  type AgentPresetId,
  type AgentPresetPrepareResult,
  type AgentPresetPreview,
  type AgentPresetStatus,
  type ApplyAgentPresetRequest,
  type GetAgentPresetStatusRequest,
  type ModelTier,
  type ModelTierCandidatePublic,
  type ModelTierInvalidReason,
  type ModelTierScope,
  type PrepareAgentPresetRequest,
  type PreviewAgentPresetRequest,
} from '../../../shared/types/modelTiers';
import {
  MODEL_POLICY_AGENT_TYPES,
  type ListAgentModelPolicyReferencesRequest,
  type ModelPolicyAgentType,
  type PublicAgentModelPolicyReference,
} from '../../../shared/types/modelProviders';
import { getLocale, t, type LocaleKey } from '../../i18n';
import {
  AgentSettingsModal,
  TierBindingWizard,
  invalidReasonLabel,
  localizedTierLabel,
  localizedTierSourceLabel,
  modelTierScopeIdentity,
  type AgentTierSettingsApi,
} from './AgentModelTierSettings';

export interface AgentPresetSettingsApi extends AgentTierSettingsApi {
  prepareAgentPreset(input: PrepareAgentPresetRequest): Promise<AgentPresetPrepareResult>;
  previewAgentPreset(input: PreviewAgentPresetRequest): Promise<AgentPresetPreview>;
  applyAgentPreset(input: ApplyAgentPresetRequest): Promise<AgentPresetApplyResult>;
  getAgentPresetStatus(input: GetAgentPresetStatusRequest): Promise<AgentPresetStatus>;
  listAgentModelPolicyReferences(
    input: ListAgentModelPolicyReferencesRequest,
  ): Promise<PublicAgentModelPolicyReference[]>;
}

export interface AgentPresetSettingsProps {
  scope: ModelTierScope;
  api?: AgentPresetSettingsApi;
  onOpenProviderCenter(): void;
  manualPolicyControls?: React.ReactNode;
  refreshToken?: number;
}

interface SafeRolePreview {
  role: ModelPolicyAgentType;
  tier: ModelTier;
  source: 'global' | 'project' | 'none';
  candidate: ModelTierCandidatePublic | null;
  validity: 'valid' | 'needs_reconfiguration' | 'unbound';
  invalidReason: ModelTierInvalidReason | null;
}

interface SafePresetPreview {
  presetId: AgentPresetId;
  revision: string;
  roles: Readonly<Record<ModelPolicyAgentType, SafeRolePreview>>;
}

interface SafePolicyReference {
  agentType: ModelPolicyAgentType;
  reference: PublicAgentModelPolicyReference['reference'];
  providerName: string | null;
}

interface SafePersistedTier {
  tier: ModelTier;
  source: 'global' | 'project' | 'none';
  candidate: ModelTierCandidatePublic | null;
  validity: 'valid' | 'needs_reconfiguration' | 'unbound';
  invalidReason: ModelTierInvalidReason | null;
}

type ActionableError = {
  message: string;
  action: 'repreview' | 'configure' | 'retry';
  presetId: AgentPresetId | null;
};

function fallbackApi(): AgentPresetSettingsApi {
  return window.api;
}

function safeCandidate(value: ModelTierCandidatePublic): ModelTierCandidatePublic {
  return {
    providerId: value.providerId,
    providerName: value.providerName,
    modelId: value.modelId,
    modelDisplayName: value.modelDisplayName,
    runtimeType: value.runtimeType,
    executionSource: value.executionSource,
    health: { state: value.health.state, lastTestedAt: value.health.lastTestedAt },
  };
}

function safePreview(value: AgentPresetPreview): SafePresetPreview {
  const roles = Object.fromEntries(MODEL_POLICY_AGENT_TYPES.map((role) => {
    const row = value.roles[role];
    return [role, {
      role,
      tier: row.tier,
      source: row.resolution.source,
      candidate: row.resolution.candidate ? safeCandidate(row.resolution.candidate) : null,
      validity: row.resolution.validity,
      invalidReason: row.resolution.invalidReason,
    } satisfies SafeRolePreview];
  })) as Readonly<Record<ModelPolicyAgentType, SafeRolePreview>>;
  return { presetId: value.presetId, revision: value.revision, roles };
}

function safeStatus(value: AgentPresetStatus): AgentPresetStatus {
  if (value.kind === 'preset' && AGENT_PRESET_IDS.includes(value.presetId)) {
    return { kind: 'preset', presetId: value.presetId };
  }
  return { kind: 'custom' };
}

function safePolicyReference(value: PublicAgentModelPolicyReference): SafePolicyReference {
  return {
    agentType: value.agentType,
    reference: value.reference.kind === 'tier'
      ? { kind: 'tier', tier: value.reference.tier }
      : { kind: 'model', providerId: value.reference.providerId, modelId: value.reference.modelId },
    providerName: typeof value.providerName === 'string' ? value.providerName : null,
  };
}

function safePersistedTier(value: import('../../../shared/types/modelTiers').ModelTierResolutionPublic): SafePersistedTier {
  return {
    tier: value.tier,
    source: value.source,
    candidate: value.candidate ? safeCandidate(value.candidate) : null,
    validity: value.validity,
    invalidReason: value.invalidReason,
  };
}

function presetLabel(presetId: AgentPresetId): string {
  const keys: Record<AgentPresetId, LocaleKey> = {
    software_development: 'agent.preset.softwareDevelopment',
    quick_change: 'agent.preset.quickChange',
    high_quality_review: 'agent.preset.highQualityReview',
  };
  return t(keys[presetId]);
}

function applyButtonLabel(presetId: AgentPresetId): string {
  const label = presetLabel(presetId);
  return getLocale() === 'en-US' ? `${t('agent.preset.apply')} ${label} template` : `${t('agent.preset.apply')}${label}模板`;
}

function roleLabel(role: ModelPolicyAgentType): string {
  return t(`agent.role.${role}` as LocaleKey);
}

function errorCode(reason: unknown): string | null {
  if (typeof reason === 'object' && reason !== null && 'code' in reason && typeof reason.code === 'string') {
    return reason.code;
  }
  if (!(reason instanceof Error)) return null;
  const knownMessages: Readonly<Record<string, string>> = {
    'The Agent template preview is out of date.': 'PREVIEW_STALE',
    'One or more Agent roles need a valid model tier binding.': 'PRESET_ROLE_UNAVAILABLE',
    'Provider is disabled.': 'PROVIDER_DISABLED',
  };
  return knownMessages[reason.message] ?? null;
}

function safeApplyError(reason: unknown, presetId: AgentPresetId): ActionableError {
  switch (errorCode(reason)) {
    case 'PREVIEW_STALE':
      return { message: t('agent.preset.previewStale'), action: 'repreview', presetId };
    case 'PRESET_ROLE_UNAVAILABLE':
      return { message: t('agent.preset.roleUnavailable'), action: 'configure', presetId };
    case 'PROVIDER_DISABLED':
      return { message: t('agent.preset.providerDisabled'), action: 'configure', presetId };
    default:
      return { message: t('agent.preset.applyFailed'), action: 'retry', presetId };
  }
}

function PersistedRoleMapping({
  references,
  tiers,
}: {
  references: SafePolicyReference[];
  tiers: SafePersistedTier[];
}) {
  const referenceByRole = new Map(references.map((reference) => [reference.agentType, reference]));
  const tierById = new Map(tiers.map((tier) => [tier.tier, tier]));
  return (
    <section className="agent-persisted-mapping" aria-labelledby="agent-persisted-mapping-title">
      <h3 id="agent-persisted-mapping-title">{t('agent.preset.persistedMapping')}</h3>
      <div className="agent-preset-role-list">
        {MODEL_POLICY_AGENT_TYPES.map((role) => {
          const persisted = referenceByRole.get(role);
          const reference = persisted?.reference;
          const tier = reference?.kind === 'tier' ? tierById.get(reference.tier) : null;
          return (
            <div key={role} className="agent-preset-role-row" data-testid="persisted-agent-role">
              <strong>{roleLabel(role)}</strong>
              <span aria-hidden="true">→</span>
              {!reference ? <span>{t('agent.preset.unassigned')}</span> : null}
              {reference?.kind === 'model' ? (
                <span className="agent-preview-model">
                  {t('agent.preset.directModel')}
                  <small>{persisted?.providerName ?? t('agent.preset.providerUnavailable')} / {reference.modelId}</small>
                </span>
              ) : null}
              {reference?.kind === 'tier' ? <span>{localizedTierLabel(reference.tier)}</span> : null}
              {reference?.kind === 'tier' ? <span aria-hidden="true">→</span> : null}
              {reference?.kind === 'tier' && tier?.candidate ? (
                <span className="agent-preview-model" title={`${tier.candidate.providerName} / ${tier.candidate.modelId}`}>
                  {tier.candidate.providerName} / {tier.candidate.modelId}
                  <small>{tier.candidate.runtimeType} · {localizedTierSourceLabel(tier.source)}</small>
                </span>
              ) : null}
              {reference?.kind === 'tier' && !tier?.candidate ? (
                <span className="agent-invalid-preview">
                  {t('agent.tiers.needsReconfiguration')}：{invalidReasonLabel(tier?.invalidReason ?? 'tier_unbound')}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function PreviewDialog({
  preview,
  busy,
  onApply,
  onModify,
  onCancel,
}: {
  preview: SafePresetPreview;
  busy: boolean;
  onApply(): void;
  onModify(): void;
  onCancel(): void;
}) {
  const invalid = MODEL_POLICY_AGENT_TYPES.some((role) => preview.roles[role].validity !== 'valid');
  return (
    <AgentSettingsModal title={t('agent.preset.previewTitle')} onCancel={onCancel} closeDisabled={busy}>
      <div className="agent-settings-modal-body">
        <p className="agent-tier-disclaimer">{t('agent.tiers.disclaimer')}</p>
        <div className="agent-preset-role-list">
          {MODEL_POLICY_AGENT_TYPES.map((role) => {
            const row = preview.roles[role];
            const candidate = row.candidate;
            return (
              <div key={role} className="agent-preset-role-row" data-testid="preset-role-preview">
                <strong>{roleLabel(role)}</strong>
                <span aria-hidden="true">→</span>
                <span>{localizedTierLabel(row.tier)}</span>
                <span aria-hidden="true">→</span>
                {candidate ? (
                  <span className="agent-preview-model" title={`${candidate.providerName} / ${candidate.modelId}`}>
                    {candidate.providerName} / {candidate.modelId}
                    <small>{candidate.runtimeType} · {localizedTierSourceLabel(row.source)}</small>
                  </span>
                ) : (
                  <span className="agent-invalid-preview">
                    {t('agent.tiers.needsReconfiguration')}：{invalidReasonLabel(row.invalidReason)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <footer className="agent-settings-modal-actions">
        <button type="button" className="agent-secondary-button" disabled={busy} onClick={onCancel}>{t('common.cancel')}</button>
        <button type="button" className="agent-secondary-button" disabled={busy} onClick={onModify}>{t('agent.preset.modifyTiers')}</button>
        <button type="button" className="agent-primary-button" disabled={busy || invalid} onClick={onApply}>{t('agent.preset.apply')}</button>
      </footer>
    </AgentSettingsModal>
  );
}

function OverwriteDialog({ busy, onConfirm, onCancel }: { busy: boolean; onConfirm(): void; onCancel(): void }) {
  return (
    <AgentSettingsModal title={t('agent.preset.overwriteTitle')} onCancel={onCancel} closeDisabled={busy}>
      <div className="agent-settings-modal-body agent-warning-copy">
        <AlertTriangle size={20} aria-hidden="true" />
        <p>{t('agent.preset.overwriteWarning')}</p>
      </div>
      <footer className="agent-settings-modal-actions">
        <button type="button" className="agent-secondary-button" disabled={busy} onClick={onCancel}>{t('common.cancel')}</button>
        <button type="button" className="agent-primary-button" disabled={busy} onClick={onConfirm}>{t('agent.preset.confirmOverwrite')}</button>
      </footer>
    </AgentSettingsModal>
  );
}

export function AgentPresetSettings({ scope, api, onOpenProviderCenter, manualPolicyControls, refreshToken = 0 }: AgentPresetSettingsProps) {
  const port = api ?? fallbackApi();
  const scopeProjectId = scope.type === 'project' ? scope.projectId : null;
  const scopeIdentity = scopeProjectId === null ? 'global' : `project:${scopeProjectId}`;
  const scopeIdentityRef = useRef(scopeIdentity);
  const scopeIncarnationRef = useRef({ identity: scopeIdentity, value: 0 });
  const applyEpochRef = useRef(0);
  if (scopeIncarnationRef.current.identity !== scopeIdentity) {
    scopeIncarnationRef.current = {
      identity: scopeIdentity,
      value: scopeIncarnationRef.current.value + 1,
    };
    applyEpochRef.current += 1;
  }
  scopeIdentityRef.current = scopeIdentity;
  const scopeIncarnation = scopeIncarnationRef.current.value;
  const mountedRef = useRef(true);
  const statusEpochRef = useRef(0);
  const prepareEpochRef = useRef(0);
  const [status, setStatus] = useState<AgentPresetStatus | null>(null);
  const [statusScopeIdentity, setStatusScopeIdentity] = useState<string | null>(null);
  const [references, setReferences] = useState<SafePolicyReference[]>([]);
  const [persistedTiers, setPersistedTiers] = useState<SafePersistedTier[]>([]);
  const [previewState, setPreviewState] = useState<{ scopeIdentity: string; value: SafePresetPreview } | null>(null);
  const [wizard, setWizard] = useState<{ scopeIdentity: string; presetId: AgentPresetId; tiers: ModelTier[] } | null>(null);
  const [overwriteOpen, setOverwriteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statusError, setStatusError] = useState<ActionableError | null>(null);
  const [mutationError, setMutationError] = useState<ActionableError | null>(null);
  const [success, setSuccess] = useState(false);

  const loadStatus = useCallback(async () => {
    const requestScope: ModelTierScope = scopeProjectId === null
      ? { type: 'global' }
      : { type: 'project', projectId: scopeProjectId };
    const requestScopeIdentity = modelTierScopeIdentity(requestScope);
    const requestEpoch = ++statusEpochRef.current;
    setStatusError(null);
    try {
      const [nextStatus, nextReferences, nextTiers] = await Promise.all([
        port.getAgentPresetStatus({ scope: requestScope }),
        port.listAgentModelPolicyReferences({ scope: requestScope }),
        port.listModelTierBindings({ scope: requestScope }),
      ]);
      if (!mountedRef.current || scopeIdentityRef.current !== requestScopeIdentity || statusEpochRef.current !== requestEpoch) return;
      setStatus(safeStatus(nextStatus));
      setStatusScopeIdentity(requestScopeIdentity);
      setReferences(nextReferences.map(safePolicyReference));
      setPersistedTiers(nextTiers.map(safePersistedTier));
      setStatusError(null);
    } catch {
      if (mountedRef.current && scopeIdentityRef.current === requestScopeIdentity && statusEpochRef.current === requestEpoch) {
        setStatusError({ message: t('agent.preset.loadFailed'), action: 'retry', presetId: null });
      }
    }
  }, [port, scopeProjectId]);

  useEffect(() => {
    setStatus(null);
    setStatusScopeIdentity(null);
    setReferences([]);
    setPersistedTiers([]);
    setPreviewState(null);
    setWizard(null);
    setOverwriteOpen(false);
    setBusy(false);
    setStatusError(null);
    setMutationError(null);
    setSuccess(false);
    prepareEpochRef.current += 1;
    void loadStatus();
    return () => {
      statusEpochRef.current += 1;
      prepareEpochRef.current += 1;
    };
  }, [loadStatus, refreshToken, scopeIdentity]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const prepare = useCallback(async (presetId: AgentPresetId) => {
    const requestScope: ModelTierScope = scopeProjectId === null
      ? { type: 'global' }
      : { type: 'project', projectId: scopeProjectId };
    const requestScopeIdentity = modelTierScopeIdentity(requestScope);
    const requestEpoch = ++prepareEpochRef.current;
    setBusy(true);
    setMutationError(null);
    setSuccess(false);
    try {
      const result = await port.prepareAgentPreset({ scope: requestScope, presetId });
      if (!mountedRef.current || scopeIdentityRef.current !== requestScopeIdentity || prepareEpochRef.current !== requestEpoch) return;
      if (result.step === 'bind_tiers') {
        setPreviewState(null);
        setWizard({
          scopeIdentity: requestScopeIdentity,
          presetId,
          tiers: MODEL_TIERS.filter((tier) => result.missingTiers.includes(tier)),
        });
      } else {
        setWizard(null);
        setPreviewState({ scopeIdentity: requestScopeIdentity, value: safePreview(result.preview) });
      }
    } catch {
      if (mountedRef.current && scopeIdentityRef.current === requestScopeIdentity && prepareEpochRef.current === requestEpoch) {
        setMutationError({ message: t('agent.preset.prepareFailed'), action: 'retry', presetId });
      }
    } finally {
      if (mountedRef.current && scopeIdentityRef.current === requestScopeIdentity && prepareEpochRef.current === requestEpoch) setBusy(false);
    }
  }, [port, scopeProjectId]);

  const apply = async () => {
    if (!previewState || previewState.scopeIdentity !== scopeIdentity) return;
    const preview = previewState.value;
    const requestScope: ModelTierScope = scopeProjectId === null
      ? { type: 'global' }
      : { type: 'project', projectId: scopeProjectId };
    const requestScopeIdentity = scopeIdentity;
    const requestScopeIncarnation = scopeIncarnation;
    const requestEpoch = ++applyEpochRef.current;
    const acceptsApply = () => mountedRef.current
      && scopeIdentityRef.current === requestScopeIdentity
      && scopeIncarnationRef.current.value === requestScopeIncarnation
      && applyEpochRef.current === requestEpoch;
    setBusy(true);
    setMutationError(null);
    try {
      await port.applyAgentPreset({
        scope: requestScope,
        presetId: preview.presetId,
        expectedRevision: preview.revision,
        previewConfirmed: true,
        overwriteConfirmed: true,
      });
      if (!acceptsApply()) return;
      setPreviewState(null);
      setOverwriteOpen(false);
      setSuccess(true);
      setStatus({ kind: 'preset', presetId: preview.presetId });
      setStatusScopeIdentity(requestScopeIdentity);
      await loadStatus();
    } catch (reason) {
      if (acceptsApply()) {
        setPreviewState(null);
        setOverwriteOpen(false);
        setMutationError(safeApplyError(reason, preview.presetId));
      }
    } finally {
      if (acceptsApply()) setBusy(false);
    }
  };

  const visibleStatus = statusScopeIdentity === scopeIdentity ? status : null;
  const visiblePreview = previewState?.scopeIdentity === scopeIdentity ? previewState.value : null;
  const visibleWizard = wizard?.scopeIdentity === scopeIdentity ? wizard : null;
  const currentStatus = visibleStatus?.kind === 'preset' ? presetLabel(visibleStatus.presetId) : visibleStatus?.kind === 'custom' ? t('agent.preset.custom') : t('common.loading');

  return (
    <section className="agent-settings-section agent-preset-settings" aria-labelledby="agent-preset-settings-title">
      <header className="agent-preset-header">
        <div>
          <h2 id="agent-preset-settings-title">{t('agent.preset.title')}</h2>
          <p className="agent-tier-disclaimer">{t('agent.tiers.disclaimer')}</p>
        </div>
        <p className="agent-preset-status"><span>{t('agent.preset.current')}</span><strong>{currentStatus}</strong></p>
      </header>
      <div className="agent-preset-card-list">
        {AGENT_PRESET_IDS.map((presetId) => (
          <article key={presetId} className="agent-preset-card">
            <Layers3 size={18} aria-hidden="true" />
            <h3>{presetLabel(presetId)}</h3>
            <button type="button" className="agent-primary-button" disabled={busy} onClick={() => void prepare(presetId)} aria-label={applyButtonLabel(presetId)}>
              {t('agent.preset.applyTemplate')}
            </button>
          </article>
        ))}
      </div>
      {statusScopeIdentity === scopeIdentity ? <PersistedRoleMapping references={references} tiers={persistedTiers} /> : null}
      {manualPolicyControls}
      {success ? <p role="status" aria-live="polite" className="agent-success-text"><CheckCircle2 size={15} aria-hidden="true" />{t('agent.preset.success')}</p> : null}
      {statusError ? (
        <div className="agent-actionable-error">
          <p role="alert">{statusError.message}</p>
          <button type="button" className="agent-secondary-button" onClick={() => void loadStatus()}>{t('common.recheck')}</button>
        </div>
      ) : null}
      {mutationError ? (
        <div className="agent-actionable-error">
          <p role="alert">{mutationError.message}</p>
          {mutationError.action === 'repreview' && mutationError.presetId ? <button type="button" className="agent-secondary-button" onClick={() => void prepare(mutationError.presetId!)}>{t('agent.preset.repreview')}</button> : null}
          {mutationError.action === 'configure' ? <button type="button" className="agent-secondary-button" onClick={() => {
            setMutationError(null);
            setWizard({ scopeIdentity, presetId: mutationError.presetId ?? 'software_development', tiers: [...MODEL_TIERS] });
          }}>{t('agent.preset.configureTiers')}</button> : null}
          {mutationError.action === 'retry' && mutationError.presetId ? <button type="button" className="agent-secondary-button" onClick={() => void prepare(mutationError.presetId!)}>{t('common.recheck')}</button> : null}
        </div>
      ) : null}
      {visiblePreview && !overwriteOpen ? <PreviewDialog
        preview={visiblePreview}
        busy={busy}
        onCancel={() => setPreviewState(null)}
        onModify={() => {
          setPreviewState(null);
          setWizard({ scopeIdentity, presetId: visiblePreview.presetId, tiers: [...MODEL_TIERS] });
        }}
        onApply={() => setOverwriteOpen(true)}
      /> : null}
      {visiblePreview && overwriteOpen ? <OverwriteDialog
        busy={busy}
        onCancel={() => setOverwriteOpen(false)}
        onConfirm={() => void apply()}
      /> : null}
      {visibleWizard ? <TierBindingWizard
        scope={scope}
        tiers={visibleWizard.tiers}
        api={port}
        onOpenProviderCenter={onOpenProviderCenter}
        onCancel={() => setWizard(null)}
        onComplete={() => {
          if (scopeIdentityRef.current !== visibleWizard.scopeIdentity) return;
          const presetId = visibleWizard.presetId;
          setWizard(null);
          void prepare(presetId);
        }}
      /> : null}
    </section>
  );
}
