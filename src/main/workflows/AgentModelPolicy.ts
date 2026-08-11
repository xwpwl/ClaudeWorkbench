import type { AgentModelPolicy, AgentType } from '../../shared/types/workflow';

const POLICY_KEYS = [
  'plannerModel',
  'coderModel',
  'testerModel',
  'reviewerModel',
  'fixerModel',
] as const satisfies readonly (keyof AgentModelPolicy)[];

function normalizedName(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

/** Keeps only supported model overrides. Empty fields preserve inheritance. */
export function normalizeAgentModelPolicy(policy: AgentModelPolicy | undefined): AgentModelPolicy {
  const normalized: AgentModelPolicy = {};
  for (const key of POLICY_KEYS) {
    const value = normalizedName(policy?.[key]);
    if (value) normalized[key] = value;
  }
  return normalized;
}

export function resolveAgentModel(
  policy: AgentModelPolicy,
  stage: AgentType,
  currentModel: string | null | undefined,
  isFix = false,
): string | undefined {
  const inherited = normalizedName(currentModel ?? undefined);
  if (stage === 'planner') return normalizedName(policy.plannerModel) ?? inherited;
  if (stage === 'reviewer') return normalizedName(policy.reviewerModel) ?? inherited;
  if (stage === 'tester') {
    return normalizedName(policy.testerModel) ?? normalizedName(policy.coderModel) ?? inherited;
  }
  if (isFix) {
    return normalizedName(policy.fixerModel) ?? normalizedName(policy.coderModel) ?? inherited;
  }
  return normalizedName(policy.coderModel) ?? inherited;
}

export const agentModelPolicyInternals = { normalizedName, POLICY_KEYS };
