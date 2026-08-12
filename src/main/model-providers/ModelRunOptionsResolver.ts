import type { ClaudeRunOptions } from '../../shared/types/claude';
import type { ResolvedModelSelection } from '../../shared/types/modelProviders';
import type {
  ModelSelectionRequest,
} from './ModelSelectionResolver';
import type { ModelPolicyAgentType } from '../../shared/types/modelProviders';
import type { SessionModelBinding } from '../database/Database';

export interface ModelSelectionResolverPort {
  resolve(request: ModelSelectionRequest): ResolvedModelSelection | Promise<ResolvedModelSelection>;
  revalidatePinnedSelection(
    selection: ResolvedModelSelection,
    request: ModelSelectionRequest,
  ): ResolvedModelSelection | Promise<ResolvedModelSelection>;
}

export interface ModelSessionBindingStorePort {
  getSessionModelBinding(sessionId: string): SessionModelBinding | null;
}

export class ModelRunOptionsResolver {
  constructor(
    private readonly selections: ModelSelectionResolverPort,
    private readonly sessionBindings: ModelSessionBindingStorePort,
  ) {}

  async resolve(options: Readonly<ClaudeRunOptions>): Promise<ClaudeRunOptions> {
    const { taskId, projectId } = trustedIdentity(options);

    const workflow = options.workflowContext;
    const selection = await this.selections.resolve({
      taskId,
      projectId,
      ...(workflow ? { agentType: workflowAgentType(workflow) } : {}),
      fallbackModelId: options.model,
      use: workflow ? 'agent-workflow' : 'chat',
    });
    const trustedOptions = workflow
      ? options
      : enforceChatResumeBoundary(options, selection, this.sessionBindings);
    return applySelection(trustedOptions, selection);
  }

  /** Applies only the Workflow-creation snapshot after revalidating live Provider facts. */
  async resolvePinned(
    options: Readonly<ClaudeRunOptions>,
    pinned: ResolvedModelSelection,
  ): Promise<ClaudeRunOptions> {
    const { taskId, projectId } = trustedIdentity(options);
    const workflow = options.workflowContext;
    if (!workflow) throw new Error('Trusted Workflow context is required for pinned model selection.');
    const selection = await this.selections.revalidatePinnedSelection(pinned, {
      taskId,
      projectId,
      agentType: workflowAgentType(workflow),
      use: 'agent-workflow',
    });
    return applySelection(options, selection);
  }

  /** Final TaskManager boundary: revalidate the immutable main-owned selection only. */
  async revalidateResolved(options: Readonly<ClaudeRunOptions>): Promise<ClaudeRunOptions> {
    const { taskId, projectId } = trustedIdentity(options);
    const pinned = options.resolvedModelSelection;
    if (!pinned) throw new Error('Trusted resolved model selection is required before execution.');
    const workflow = options.workflowContext;
    const selection = await this.selections.revalidatePinnedSelection(pinned, {
      taskId,
      projectId,
      ...(workflow ? { agentType: workflowAgentType(workflow) } : {}),
      use: workflow ? 'agent-workflow' : 'chat',
    });
    const trustedOptions = workflow
      ? options
      : enforceChatResumeBoundary(options, selection, this.sessionBindings);
    return applySelection(trustedOptions, selection);
  }
}

function trustedIdentity(options: Readonly<ClaudeRunOptions>): {
  taskId: string;
  projectId: string;
} {
  const taskId = options.taskId?.trim();
  const projectId = options.projectId?.trim();
  if (!taskId) throw new Error('Trusted task identity is required for model selection.');
  if (!projectId) throw new Error('Trusted project identity is required for model selection.');
  return { taskId, projectId };
}

function applySelection(
  options: Readonly<ClaudeRunOptions>,
  selection: ResolvedModelSelection,
): ClaudeRunOptions {
  const snapshot = immutableSelection(selection);
  const useClaudeDefault = snapshot.executionSource === 'claude_code'
    && snapshot.modelId === 'default';
  const untrusted = options as Readonly<ClaudeRunOptions> & {
    modelSessionBinding?: unknown;
  };
  const {
    modelProviderId: _untrustedProviderId,
    resolvedModelSelection: _untrustedSelection,
    model: _untrustedModel,
    modelSessionBinding: _untrustedBinding,
    ...trustedOptions
  } = untrusted;
  return {
    ...trustedOptions,
    ...(useClaudeDefault ? {} : { model: snapshot.modelId }),
    modelProviderId: snapshot.providerId,
    resolvedModelSelection: snapshot,
  };
}

function enforceChatResumeBoundary(
  options: Readonly<ClaudeRunOptions>,
  selection: ResolvedModelSelection,
  bindings: ModelSessionBindingStorePort,
): Readonly<ClaudeRunOptions> {
  if (!options.resumeSessionId) return options;
  const sessionId = sessionIdFromKey(options.sessionKey);
  const binding = sessionId ? bindings.getSessionModelBinding(sessionId) : null;
  if (
    binding
    && binding.claudeSessionId === options.resumeSessionId
    && binding.providerId === selection.providerId
    && binding.modelId === selection.modelId
    && binding.runtimeType === selection.runtimeType
    && binding.executionSource === selection.executionSource
  ) return options;
  const { resumeSessionId: _untrustedResume, ...freshOptions } = options;
  return freshOptions;
}

function sessionIdFromKey(sessionKey: string): string | null {
  const separator = sessionKey.lastIndexOf('::');
  if (separator < 0 || separator === sessionKey.length - 2) return null;
  return sessionKey.slice(separator + 2);
}

function workflowAgentType(
  workflow: NonNullable<ClaudeRunOptions['workflowContext']>,
): ModelPolicyAgentType {
  if (workflow.stage === 'coder' && workflow.reviewRound > 1) return 'fixer';
  return workflow.stage;
}

function immutableSelection(selection: ResolvedModelSelection): ResolvedModelSelection {
  return Object.freeze({
    ...selection,
    capabilities: Object.freeze({ ...selection.capabilities }),
  });
}

export const modelRunOptionsInternals = {
  enforceChatResumeBoundary,
  sessionIdFromKey,
  workflowAgentType,
};
