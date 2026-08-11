import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AGENT_PRESETS,
  MODEL_EXECUTION_SOURCES,
  MODEL_TIERS,
} from "../modelTiers";
import { AGENT_PRESETS as presetsFromBarrel } from "..";
import type {
  ApplyAgentPresetRequest,
  AgentPresetRolePreview,
  AgentPresetPreview,
  ModelTierBinding,
  ModelTierCandidatePublic,
  ModelTierDisplayMetadata,
  ModelTierResolutionPublic,
} from "../modelTiers";
import type {
  ImplementedAgentRuntimeType,
  ResolvedModelSelection,
  TrustedResolvedModelSelection,
} from "../modelProviders";

type CandidatePublicKeys =
  | "providerId"
  | "providerName"
  | "modelId"
  | "modelDisplayName"
  | "runtimeType"
  | "executionSource"
  | "health";

type ResolutionPublicKeys =
  | "scope"
  | "tier"
  | "source"
  | "binding"
  | "display"
  | "candidate"
  | "validity"
  | "invalidReason";

type ForbiddenPublicFieldToken =
  "credential" | "secret" | "vault" | "apikey" | "blob" | "rawenv" | "baseurl";

type ForbiddenPublicKey<Key> = Key extends string
  ? Lowercase<Key> extends `${string}${ForbiddenPublicFieldToken}${string}`
    ? Key
    : never
  : never;

/** Distributes through every union branch before inspecting every nested DTO field. */
type DeepForbiddenPublicKeys<Value> = Value extends readonly (infer Item)[]
  ? DeepForbiddenPublicKeys<Item>
  : Value extends object
    ? {
        [Key in keyof Value]-?:
          ForbiddenPublicKey<Key> | DeepForbiddenPublicKeys<Value[Key]>;
      }[keyof Value]
    : never;

type AssertNever<Value extends never> = Value;

type RendererSafeTierPresetDto =
  | ModelTierCandidatePublic
  | ModelTierBinding
  | ModelTierDisplayMetadata
  | ModelTierResolutionPublic
  | AgentPresetRolePreview
  | AgentPresetPreview;

type _RendererSafeTierPresetDtoHasNoForbiddenKeys = AssertNever<
  DeepForbiddenPublicKeys<RendererSafeTierPresetDto>
>;

describe("model tier and Agent preset contracts", () => {
  it("requires distinct preview and overwrite confirmations for preset application", () => {
    const request: ApplyAgentPresetRequest = {
      scope: { type: "global" },
      presetId: "software_development",
      expectedRevision: `agent-preset:v1:${"a".repeat(64)}`,
      previewConfirmed: true,
      overwriteConfirmed: false,
    };

    expect(request).toMatchObject({
      previewConfirmed: true,
      overwriteConfirmed: false,
    });
    // @ts-expect-error The ambiguous legacy confirmation field is not part of the request.
    const legacy: ApplyAgentPresetRequest = { ...request, confirmed: true };
    void legacy;
  });

  it("exposes the immutable tier keys in product order", () => {
    expect(MODEL_TIERS).toEqual(["high_quality", "balanced", "fast"]);
  });

  it("keeps trusted execution sources separate from policy sources", () => {
    expect(MODEL_EXECUTION_SOURCES).toEqual([
      "database_provider",
      "environment",
      "claude_code",
    ]);
  });

  it("maps the software development preset to the intended role tiers", () => {
    expect(AGENT_PRESETS.software_development.roles).toEqual({
      planner: "high_quality",
      coder: "balanced",
      tester: "fast",
      reviewer: "high_quality",
      fixer: "balanced",
    });
  });

  it("maps the quick change preset to the intended role tiers", () => {
    expect(AGENT_PRESETS.quick_change.roles).toEqual({
      planner: "fast",
      coder: "fast",
      tester: "fast",
      reviewer: "balanced",
      fixer: "fast",
    });
  });

  it("maps the high quality review preset to the intended role tiers", () => {
    expect(AGENT_PRESETS.high_quality_review.roles).toEqual({
      planner: "high_quality",
      coder: "balanced",
      tester: "balanced",
      reviewer: "high_quality",
      fixer: "high_quality",
    });
  });

  it("keeps renderer candidate and resolution DTOs free of credential material", () => {
    const publicCandidate: ModelTierCandidatePublic = {
      providerId: "provider-1",
      providerName: "Configured provider",
      modelId: "model-1",
      modelDisplayName: "Configured model",
      runtimeType: "claude-code",
      executionSource: "database_provider",
      health: { state: "connected", lastTestedAt: 1_786_291_200_000 },
    };
    const resolution: ModelTierResolutionPublic = {
      scope: { type: "global" },
      tier: "balanced",
      source: "global",
      binding: {
        tier: "balanced",
        providerId: publicCandidate.providerId,
        modelId: publicCandidate.modelId,
        updatedAt: 1_786_291_200_000,
      },
      display: {
        tier: "balanced",
        displayName: "Balanced",
        quality: "medium",
        speed: "medium",
        cost: "medium",
      },
      candidate: publicCandidate,
      validity: "valid",
      invalidReason: null,
    };
    const preview: AgentPresetPreview = {
      scope: { type: "global" },
      presetId: "software_development",
      revision: "safe-revision",
      roles: {
        planner: { role: "planner", tier: "high_quality", resolution },
        coder: { role: "coder", tier: "balanced", resolution },
        tester: { role: "tester", tier: "fast", resolution },
        reviewer: { role: "reviewer", tier: "high_quality", resolution },
        fixer: { role: "fixer", tier: "balanced", resolution },
      },
    };

    expect(
      JSON.stringify({ publicCandidate, resolution, preview }),
    ).not.toMatch(/credential|secret|vault|api.?key|blob|raw.?env|base.?url/i);
  });

  it("keeps tier DTO keys and execution runtime contracts exact", () => {
    expectTypeOf<
      ModelTierCandidatePublic["runtimeType"]
    >().toEqualTypeOf<ImplementedAgentRuntimeType>();
    expectTypeOf<
      TrustedResolvedModelSelection["runtimeType"]
    >().toEqualTypeOf<ImplementedAgentRuntimeType>();
    expectTypeOf<
      keyof ModelTierCandidatePublic
    >().toEqualTypeOf<CandidatePublicKeys>();
    expectTypeOf<
      keyof ModelTierResolutionPublic
    >().toEqualTypeOf<ResolutionPublicKeys>();
  });

  it("rejects impossible binding, resolution, and trusted provenance states", () => {
    // @ts-expect-error A binding must be fully bound or fully unbound.
    const halfBound: ModelTierBinding = {
      tier: "fast",
      providerId: "provider-1",
      modelId: null,
      updatedAt: 1,
    };
    const validWithReason: ModelTierResolutionPublic = {
      scope: { type: "global" },
      tier: "fast",
      source: "global",
      binding: {
        tier: "fast",
        providerId: "provider-1",
        modelId: "model-1",
        updatedAt: 1,
      },
      display: {
        tier: "fast",
        displayName: null,
        quality: null,
        speed: null,
        cost: null,
      },
      candidate: {
        providerId: "provider-1",
        providerName: "Configured provider",
        modelId: "model-1",
        modelDisplayName: null,
        runtimeType: "claude-code",
        executionSource: "database_provider",
        health: { state: "connected", lastTestedAt: 1 },
      },
      validity: "valid",
      // @ts-expect-error A valid resolution cannot contain an invalid reason.
      invalidReason: "provider_deleted",
    };
    // @ts-expect-error A missing binding cannot claim a global or project source.
    const missingBindingWithSource: ModelTierResolutionPublic = {
      scope: { type: "global" },
      tier: "fast",
      source: "global",
      binding: null,
      display: {
        tier: "fast",
        displayName: null,
        quality: null,
        speed: null,
        cost: null,
      },
      candidate: null,
      validity: "unbound",
      invalidReason: "tier_unbound",
    };
    const baseSelection: ResolvedModelSelection = {
      providerId: "provider-1",
      providerName: "Configured provider",
      modelId: "model-1",
      runtimeType: "claude-code",
      capabilities: {
        supportsClaudeCode: true,
        supportsAgentWorkflow: true,
        supportsTools: true,
        supportsMCP: true,
        supportsStreaming: true,
        supportsVision: false,
      },
      source: "project_policy",
    };
    // @ts-expect-error A trusted resolved selection always has a verified execution source.
    const missingExecutionSource: TrustedResolvedModelSelection = baseSelection;
    // @ts-expect-error Tier provenance is paired and cannot omit its source.
    const missingTierSource: TrustedResolvedModelSelection = {
      ...baseSelection,
      executionSource: "database_provider",
      tier: "fast",
    };
    const trustedWithImplementedRuntime: TrustedResolvedModelSelection = {
      ...baseSelection,
      runtimeType: "claude-code",
      executionSource: "database_provider",
    };
    const unimplementedTrustedRuntime: TrustedResolvedModelSelection = {
      ...baseSelection,
      // @ts-expect-error Trusted selections only permit an implemented runtime.
      runtimeType: "none",
      executionSource: "database_provider",
    };

    void halfBound;
    void validWithReason;
    void missingBindingWithSource;
    void missingExecutionSource;
    void missingTierSource;
    void trustedWithImplementedRuntime;
    void unimplementedTrustedRuntime;
  });

  it("exports preset mappings through the shared barrel", () => {
    expect(presetsFromBarrel.quick_change.roles.coder).toBe("fast");
  });
});
