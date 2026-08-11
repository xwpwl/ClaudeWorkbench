import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ClaudeInstallationInfo } from "../../../shared/types/claude";
import type {
  ModelTier,
  ModelTierScope,
  SetModelTierBindingRequest,
} from "../../../shared/types/modelTiers";
import type { RuntimeProviderDescriptor, AgentRuntime } from "../AgentRuntime";
import { AgentRuntimeRegistry } from "../AgentRuntimeRegistry";
import {
  ModelTierService,
  ModelTierServiceError,
  type EffectiveSyntheticTierSelection,
  type ModelTierRepository,
  type SyntheticIdentityHmacPort,
} from "../ModelTierService";
import type {
  ModelTierBindingRecord,
  ProjectModelTierBindingRecord,
} from "../ModelProviderRepository";
import type {
  StoredModelProvider,
  StoredProviderModel,
} from "../ModelProviderService";

const GLOBAL_SCOPE = { type: "global" } as const;
const PROJECT_SCOPE = { type: "project", projectId: "project-1" } as const;

function capabilities(
  overrides: Partial<StoredModelProvider["capabilities"]> = {},
): StoredModelProvider["capabilities"] {
  return {
    supportsClaudeCode: true,
    supportsAgentWorkflow: true,
    supportsTools: true,
    supportsMCP: true,
    supportsStreaming: true,
    supportsVision: false,
    ...overrides,
  };
}

function provider(
  overrides: Partial<StoredModelProvider> = {},
): StoredModelProvider {
  return {
    id: "provider-mimo",
    name: "MiMo",
    type: "anthropic-compatible",
    apiFormat: "anthropic-messages",
    runtimeType: "claude-code",
    baseUrl: "https://api.mimo.example/v1",
    credentialRef: "safe-storage://v1/provider-mimo",
    defaultModelId: "mimo-v2",
    enabled: true,
    isDefault: false,
    capabilities: capabilities(),
    health: {
      state: "connected",
      lastTestedAt: 1_725_000_000_000,
      lastErrorType: null,
      latencyMs: 42,
    },
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function model(
  providerId = "provider-mimo",
  modelId = "mimo-v2",
  displayName: string | null = "MiMo V2",
): StoredProviderModel {
  return {
    providerId,
    modelId,
    displayName,
    source: "manual",
    createdAt: 1,
    updatedAt: 1,
  };
}

function binding(
  tier: ModelTier,
  providerId: string | null,
  modelId: string | null,
): ModelTierBindingRecord {
  return {
    tier,
    providerId,
    modelId,
    displayName: null,
    quality: null,
    speed: null,
    cost: null,
    updatedAt: 10,
  } as ModelTierBindingRecord;
}

class MemoryTierRepository implements ModelTierRepository {
  readonly providers = new Map<string, StoredModelProvider>();
  readonly models = new Map<string, StoredProviderModel[]>();
  readonly globalBindings = new Map<ModelTier, ModelTierBindingRecord>();
  readonly projectBindings = new Map<string, ProjectModelTierBindingRecord>();
  projectUpsertError: Error | null = null;
  projectDeleteError: Error | null = null;
  bindAllLateError: Error | null = null;
  bindAllDerivations = 0;

  listProviders(input: { limit: number; offset: number; enabled?: boolean }) {
    const all = [...this.providers.values()].filter(
      (item) => input.enabled === undefined || item.enabled === input.enabled,
    );
    return {
      items: all.slice(input.offset, input.offset + input.limit),
      total: all.length,
      limit: input.limit,
      offset: input.offset,
    };
  }

  getProvider(providerId: string) {
    return this.providers.get(providerId) ?? null;
  }

  listModels(providerId: string) {
    return this.models.get(providerId) ?? [];
  }

  upsertModelTierBinding(value: ModelTierBindingRecord) {
    this.globalBindings.set(value.tier, { ...value });
  }

  getModelTierBinding(tier: ModelTier) {
    return this.globalBindings.get(tier) ?? null;
  }

  listModelTierBindings() {
    return [...this.globalBindings.values()];
  }

  deleteModelTierBinding(tier: ModelTier) {
    return this.globalBindings.delete(tier);
  }

  upsertProjectModelTierBinding(value: ProjectModelTierBindingRecord) {
    if (this.projectUpsertError) throw this.projectUpsertError;
    this.projectBindings.set(`${value.projectId}:${value.tier}`, { ...value });
  }

  getProjectModelTierBinding(projectId: string, tier: ModelTier) {
    return this.projectBindings.get(`${projectId}:${tier}`) ?? null;
  }

  listProjectModelTierBindings(projectId: string) {
    return [...this.projectBindings.values()].filter(
      (value) => value.projectId === projectId,
    );
  }

  deleteProjectModelTierBinding(projectId: string, tier: ModelTier) {
    if (this.projectDeleteError) throw this.projectDeleteError;
    return this.projectBindings.delete(`${projectId}:${tier}`);
  }

  bindAllModelTiersAtomically(input: {
    scope: ModelTierScope;
    now: number;
    deriveCandidateInTransaction: () => { providerId: string; modelId: string };
  }): Array<ModelTierBindingRecord | ProjectModelTierBindingRecord> {
    const globalBefore = new Map(this.globalBindings);
    const projectBefore = new Map(this.projectBindings);
    try {
      this.bindAllDerivations += 1;
      const candidate = input.deriveCandidateInTransaction();
      return (["high_quality", "balanced", "fast"] as const).map((tier) => {
        if (tier === "fast" && this.bindAllLateError) throw this.bindAllLateError;
        if (input.scope.type === "global") {
          const previous = this.globalBindings.get(tier);
          const row: ModelTierBindingRecord = {
            tier,
            providerId: candidate.providerId,
            modelId: candidate.modelId,
            displayName: previous?.displayName ?? null,
            quality: previous?.quality ?? null,
            speed: previous?.speed ?? null,
            cost: previous?.cost ?? null,
            updatedAt: input.now,
          };
          this.globalBindings.set(tier, row);
          return row;
        }
        const previous = this.projectBindings.get(`${input.scope.projectId}:${tier}`);
        const row: ProjectModelTierBindingRecord = {
          projectId: input.scope.projectId,
          tier,
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          displayName: previous?.displayName ?? null,
          quality: previous?.quality ?? null,
          speed: previous?.speed ?? null,
          cost: previous?.cost ?? null,
          updatedAt: input.now,
        };
        this.projectBindings.set(`${input.scope.projectId}:${tier}`, row);
        return row;
      });
    } catch (error) {
      this.globalBindings.clear();
      this.projectBindings.clear();
      for (const [key, value] of globalBefore) this.globalBindings.set(key, value);
      for (const [key, value] of projectBefore) this.projectBindings.set(key, value);
      throw error;
    }
  }
}

interface RuntimeControl {
  installed: ClaudeInstallationInfo;
  rejectedProviderIds: Set<string>;
  seen: RuntimeProviderDescriptor[];
  checkInstallation: () => Promise<ClaudeInstallationInfo>;
}

function controlledRuntime(control: RuntimeControl): AgentRuntime {
  return {
    type: "claude-code",
    implemented: true,
    supports(descriptor) {
      control.seen.push(descriptor);
      return !control.rejectedProviderIds.has(descriptor.id);
    },
    checkInstallation: vi.fn(() => control.checkInstallation()),
    runPrompt: vi.fn(async (options) => ({ runId: options.runId, pid: 1 })),
    stopRun: vi.fn(async () => true),
    stopAll: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
  };
}

function harness(
  input: {
    synthetic?: EffectiveSyntheticTierSelection | null;
    installed?: ClaudeInstallationInfo;
    rejectedProviderIds?: readonly string[];
    hmacKey?: string;
    hmac?: SyntheticIdentityHmacPort;
    resolveSynthetic?: (
      scope: ModelTierScope,
    ) =>
      | EffectiveSyntheticTierSelection
      | null
      | Promise<EffectiveSyntheticTierSelection | null>;
    checkInstallation?: () => Promise<ClaudeInstallationInfo>;
    credentialExists?: (reference: string) => boolean;
    projectExists?: (projectId: string) => boolean;
  } = {},
) {
  const repository = new MemoryTierRepository();
  const mimo = provider();
  repository.providers.set(mimo.id, mimo);
  repository.models.set(mimo.id, [model()]);

  const installed = input.installed ?? {
    installed: true,
    path: "C:/Program Files/Claude/claude.exe",
    version: "2.1.218",
  };
  const control: RuntimeControl = {
    installed,
    rejectedProviderIds: new Set(input.rejectedProviderIds ?? []),
    seen: [],
    checkInstallation:
      input.checkInstallation ?? (async () => ({ ...control.installed })),
  };
  let synthetic = input.synthetic ?? null;
  const credentialReferences = new Set(["safe-storage://v1/provider-mimo"]);
  const projects = new Set(["project-1"]);
  const hmacInputs: string[] = [];
  const hmacKey = input.hmacKey ?? "test-machine-key-alpha";
  const hmac = input.hmac ?? {
    digestSha256: (canonicalIdentity: string) => {
      hmacInputs.push(canonicalIdentity);
      return createHmac("sha256", hmacKey)
        .update(canonicalIdentity)
        .digest("hex");
    },
  };
  const runtime = controlledRuntime(control);
  const service = new ModelTierService({
    repository,
    runtimeRegistry: new AgentRuntimeRegistry([runtime]),
    syntheticIdentityHmac: hmac,
    credentialExists:
      input.credentialExists ??
      ((reference: string) => credentialReferences.has(reference)),
    projectExists:
      input.projectExists ?? ((projectId: string) => projects.has(projectId)),
    resolveEffectiveSyntheticSelection: (input.resolveSynthetic ??
      ((_scope: ModelTierScope) => synthetic)) as never,
    now: () => 2_000,
  });

  return {
    service,
    repository,
    control,
    runtime,
    credentialReferences,
    projects,
    hmacInputs,
    setSynthetic(value: EffectiveSyntheticTierSelection | null) {
      synthetic = value;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function environmentSelection(
  overrides: Partial<
    Extract<EffectiveSyntheticTierSelection, { kind: "environment" }>
  > = {},
): Extract<EffectiveSyntheticTierSelection, { kind: "environment" }> {
  return {
    kind: "environment",
    providerName: "Environment",
    modelId: "env-model",
    baseUrl: "https://gateway.example/v1/",
    authenticationMode: "auth_token",
    ...overrides,
  };
}

function claudeSelection(
  overrides: Partial<
    Extract<EffectiveSyntheticTierSelection, { kind: "claude_code" }>
  > = {},
): Extract<EffectiveSyntheticTierSelection, { kind: "claude_code" }> {
  return {
    kind: "claude_code",
    providerName: "Claude Code",
    modelId: "default",
    ...overrides,
  };
}

async function bindGlobalToMimo(
  test: ReturnType<typeof harness>,
  tier: ModelTier = "fast",
) {
  await test.service.setBinding({
    scope: GLOBAL_SCOPE,
    tier,
    providerId: "provider-mimo",
    modelId: "mimo-v2",
  });
}

describe("ModelTierService trusted candidates", () => {
  it("includes a healthy MiMo Anthropic-compatible model with the implemented runtime", async () => {
    const test = harness();

    await expect(
      test.service.listCandidates(GLOBAL_SCOPE),
    ).resolves.toContainEqual({
      providerId: "provider-mimo",
      providerName: "MiMo",
      modelId: "mimo-v2",
      modelDisplayName: "MiMo V2",
      runtimeType: "claude-code",
      executionSource: "database_provider",
      health: { state: "connected", lastTestedAt: 1_725_000_000_000 },
    });
    expect(test.control.seen).toContainEqual(
      expect.objectContaining({
        id: "provider-mimo",
        runtimeType: "claude-code",
        configured: true,
      }),
    );
  });

  it("excludes forged OpenAI-compatible, disabled, unconfigured, and unhealthy Providers", async () => {
    const test = harness();
    const variants = [
      provider({
        id: "deepseek",
        name: "DeepSeek",
        type: "openai-compatible",
        apiFormat: "openai-chat-completions",
        runtimeType: "claude-code",
        capabilities: capabilities(),
      }),
      provider({ id: "disabled", enabled: false }),
      provider({ id: "unconfigured", credentialRef: null }),
      provider({
        id: "failed-health",
        health: {
          state: "error",
          lastTestedAt: 9,
          lastErrorType: "invalid_key",
          latencyMs: null,
        },
      }),
      provider({
        id: "untested",
        health: {
          state: "connected",
          lastTestedAt: null,
          lastErrorType: null,
          latencyMs: null,
        },
      }),
    ];
    for (const item of variants) {
      test.repository.providers.set(item.id, item);
      test.repository.models.set(item.id, [model(item.id, `${item.id}-model`)]);
    }

    const ids = (await test.service.listCandidates(GLOBAL_SCOPE)).map(
      (item) => item.providerId,
    );
    expect(ids).toContain("provider-mimo");
    expect(ids).not.toEqual(
      expect.arrayContaining(variants.map((item) => item.id)),
    );
  });

  it("requires model ownership and runtime-registry acceptance", async () => {
    const test = harness({ rejectedProviderIds: ["registry-rejected"] });
    const wrongOwner = provider({ id: "wrong-owner" });
    const registryRejected = provider({ id: "registry-rejected" });
    test.repository.providers.set(wrongOwner.id, wrongOwner);
    test.repository.providers.set(registryRejected.id, registryRejected);
    test.repository.models.set(wrongOwner.id, [
      model("someone-else", "orphan"),
    ]);
    test.repository.models.set(registryRejected.id, [
      model(registryRejected.id, "rejected-model"),
    ]);

    const ids = (await test.service.listCandidates(GLOBAL_SCOPE)).map(
      (item) => item.providerId,
    );
    expect(ids).not.toContain("wrong-owner");
    expect(ids).not.toContain("registry-rejected");
  });

  it("requires the credential vault entry to exist without reading or returning the secret", async () => {
    const test = harness();
    test.credentialReferences.delete("safe-storage://v1/provider-mimo");
    test.repository.globalBindings.set(
      "fast",
      binding("fast", "provider-mimo", "mimo-v2"),
    );

    expect(await test.service.listCandidates(GLOBAL_SCOPE)).not.toContainEqual(
      expect.objectContaining({ providerId: "provider-mimo" }),
    );
    await expect(
      test.service.resolveTier(GLOBAL_SCOPE, "fast"),
    ).resolves.toMatchObject({
      validity: "needs_reconfiguration",
      invalidReason: "provider_unconfigured",
    });
  });

  it("fails closed when credential existence cannot be verified", async () => {
    const rawVaultError = "vault backend secret diagnostic";
    const test = harness({
      credentialExists: () => {
        throw new Error(rawVaultError);
      },
    });
    test.repository.globalBindings.set(
      "fast",
      binding("fast", "provider-mimo", "mimo-v2"),
    );

    expect(await test.service.listCandidates(GLOBAL_SCOPE)).not.toContainEqual(
      expect.objectContaining({ providerId: "provider-mimo" }),
    );
    const resolution = await test.service.resolveTier(GLOBAL_SCOPE, "fast");
    expect(resolution).toMatchObject({
      invalidReason: "provider_unconfigured",
    });
    expect(JSON.stringify(resolution)).not.toContain(rawVaultError);
  });

  it("creates only the current effective synthetic candidate when Claude CLI is available", async () => {
    const test = harness({ synthetic: environmentSelection() });

    const synthetic = (await test.service.listCandidates(GLOBAL_SCOPE)).find(
      (item) => item.executionSource === "environment",
    );
    expect(synthetic).toMatchObject({
      providerId: expect.stringMatching(
        /^synthetic:v1:environment:[a-f0-9]{64}$/u,
      ),
      providerName: "Environment",
      modelId: "env-model",
      runtimeType: "claude-code",
      executionSource: "environment",
      health: { state: "connected", lastTestedAt: null },
    });
    expect(
      (await test.service.listCandidates(GLOBAL_SCOPE)).some(
        (item) => item.executionSource === "claude_code",
      ),
    ).toBe(false);
  });

  it("excludes synthetic selections when Claude CLI is unavailable", async () => {
    const test = harness({
      synthetic: claudeSelection(),
      installed: { installed: false, path: null, version: null },
    });

    expect(
      (await test.service.listCandidates(GLOBAL_SCOPE)).some((item) =>
        item.providerId.startsWith("synthetic:"),
      ),
    ).toBe(false);
  });

  it("uses keyed HMAC over canonical identity and never exposes raw inputs", async () => {
    const apiKey = "sk-ant-secret-sentinel";
    const credentialRef = "safe-storage://v1/private-ref";
    const vaultPath = "C:/vault/private-key";
    const rawError = "401 key=raw-error-secret";
    const test = harness({
      synthetic: {
        ...environmentSelection({ baseUrl: "https://GATEWAY.example/v1///" }),
        apiKey,
        credentialRef,
        vaultPath,
        rawEnvironment: { ANTHROPIC_API_KEY: apiKey },
        rawError,
      } as EffectiveSyntheticTierSelection,
    });

    const candidates = await test.service.listCandidates(GLOBAL_SCOPE);
    const fingerprintInput =
      '{"version":1,"sourceKind":"environment","sourceIdentity":"https://gateway.example/v1","model":"env-model","authenticationMode":"auth_token"}';
    const expectedFingerprint = createHmac("sha256", "test-machine-key-alpha")
      .update(fingerprintInput)
      .digest("hex");
    expect(test.hmacInputs).toEqual([fingerprintInput]);
    expect(candidates).toContainEqual(
      expect.objectContaining({
        providerId: `synthetic:v1:environment:${expectedFingerprint}`,
      }),
    );
    for (const forbidden of [
      apiKey,
      credentialRef,
      vaultPath,
      rawError,
      "ANTHROPIC_API_KEY",
    ]) {
      expect(fingerprintInput).not.toContain(forbidden);
      expect(JSON.stringify(candidates)).not.toContain(forbidden);
    }
    expect(JSON.stringify(candidates)).not.toMatch(
      /credentialRef|vaultPath|rawEnvironment|rawError|baseUrl/iu,
    );
    expect(JSON.stringify(candidates)).not.toContain("test-machine-key-alpha");
  });

  it("keeps identity stable across restart and ordinary Claude CLI upgrades", async () => {
    const first = harness({
      synthetic: claudeSelection(),
      hmacKey: "stable-machine-key",
      installed: {
        installed: true,
        path: "C:/Claude/claude.exe",
        version: "2.1.218",
      },
    });
    const restarted = harness({
      synthetic: claudeSelection(),
      hmacKey: "stable-machine-key",
      installed: {
        installed: true,
        path: "D:/Apps/Claude/claude.exe",
        version: "2.2.0",
      },
    });

    const firstId = (await first.service.listCandidates(GLOBAL_SCOPE)).find(
      (item) => item.executionSource === "claude_code",
    )!.providerId;
    const restartedId = (
      await restarted.service.listCandidates(GLOBAL_SCOPE)
    ).find((item) => item.executionSource === "claude_code")!.providerId;
    expect(restartedId).toBe(firstId);
  });

  it("uses a machine-held key so public SHA-256 guesses and other machines cannot reproduce the ID", async () => {
    const canonical =
      '{"version":1,"sourceKind":"claude_code","sourceIdentity":"claude-code:default","model":"default","authenticationMode":"claude_code"}';
    const first = harness({
      synthetic: claudeSelection(),
      hmacKey: "machine-key-one",
    });
    const otherMachine = harness({
      synthetic: claudeSelection(),
      hmacKey: "machine-key-two",
    });

    const firstId = (await first.service.listCandidates(GLOBAL_SCOPE)).find(
      (item) => item.executionSource === "claude_code",
    )!.providerId;
    const otherId = (
      await otherMachine.service.listCandidates(GLOBAL_SCOPE)
    ).find((item) => item.executionSource === "claude_code")!.providerId;
    expect(first.hmacInputs).toEqual([canonical]);
    expect(firstId).not.toBe(otherId);
    expect(firstId).not.toBe(
      `synthetic:v1:claude_code:${createHash("sha256").update(canonical).digest("hex")}`,
    );
  });

  it("requires a trusted stable HMAC provider instead of defaulting to a public or random digest", () => {
    const repository = new MemoryTierRepository();
    const runtimeRegistry = new AgentRuntimeRegistry([]);
    expect(
      () =>
        new ModelTierService({
          repository,
          runtimeRegistry,
          credentialExists: () => true,
          projectExists: () => true,
        } as never),
    ).toThrow(/HMAC/iu);
  });

  it("fails closed before hashing a non-allowlisted synthetic configuration discriminator", async () => {
    const apiKey = "sk-ant-must-not-enter-fingerprint";
    const test = harness({
      synthetic: environmentSelection({
        authenticationMode: apiKey as "api_key",
      }),
    });

    expect(
      (await test.service.listCandidates(GLOBAL_SCOPE)).some(
        (item) => item.executionSource === "environment",
      ),
    ).toBe(false);
  });

  it("normalizes equivalent Base URLs to one ID and changes identity with source facts", async () => {
    const test = harness({
      synthetic: environmentSelection({
        baseUrl: "https://GATEWAY.example/v1///",
      }),
    });
    const first = (await test.service.listCandidates(GLOBAL_SCOPE)).find(
      (item) => item.executionSource === "environment",
    )!;

    test.setSynthetic(
      environmentSelection({ baseUrl: "https://gateway.example/v1" }),
    );
    const equivalent = (await test.service.listCandidates(GLOBAL_SCOPE)).find(
      (item) => item.executionSource === "environment",
    )!;
    test.setSynthetic(
      environmentSelection({ baseUrl: "https://other.example/v1" }),
    );
    const changed = (await test.service.listCandidates(GLOBAL_SCOPE)).find(
      (item) => item.executionSource === "environment",
    )!;

    expect(equivalent.providerId).toBe(first.providerId);
    expect(changed.providerId).not.toBe(first.providerId);
  });

  it("changes identity and invalidates the old binding when a legal authentication mode changes", async () => {
    const test = harness({
      synthetic: environmentSelection({ authenticationMode: "api_key" }),
    });
    const apiKeyCandidate = (
      await test.service.listCandidates(GLOBAL_SCOPE)
    ).find((item) => item.executionSource === "environment")!;
    await test.service.setBinding({
      scope: GLOBAL_SCOPE,
      tier: "fast",
      providerId: apiKeyCandidate.providerId,
      modelId: apiKeyCandidate.modelId,
    });

    test.setSynthetic(
      environmentSelection({ authenticationMode: "auth_token" }),
    );
    const authTokenCandidate = (
      await test.service.listCandidates(GLOBAL_SCOPE)
    ).find((item) => item.executionSource === "environment")!;

    expect(authTokenCandidate.providerId).not.toBe(apiKeyCandidate.providerId);
    await expect(
      test.service.resolveTier(GLOBAL_SCOPE, "fast"),
    ).resolves.toMatchObject({
      validity: "needs_reconfiguration",
      invalidReason: "source_changed",
      binding: { providerId: apiKeyCandidate.providerId },
    });
    expect(test.hmacInputs).toContain(
      '{"version":1,"sourceKind":"environment","sourceIdentity":"https://gateway.example/v1","model":"env-model","authenticationMode":"api_key"}',
    );
    expect(test.hmacInputs).toContain(
      '{"version":1,"sourceKind":"environment","sourceIdentity":"https://gateway.example/v1","model":"env-model","authenticationMode":"auth_token"}',
    );
  });

  it("keeps endpoint paths and installation details inside HMAC and out of the public DTO", async () => {
    const privatePath = "/tenant/private-source-id";
    const installPath = "C:/Users/private-user/bin/claude.exe";
    const test = harness({
      synthetic: environmentSelection({
        baseUrl: `https://gateway.example${privatePath}`,
      }),
      installed: {
        installed: true,
        path: installPath,
        version: "private-build-label",
      },
    });

    const publicJson = JSON.stringify(
      await test.service.listCandidates(GLOBAL_SCOPE),
    );
    expect(test.hmacInputs[0]).toContain(privatePath);
    expect(test.hmacInputs[0]).not.toContain(installPath);
    expect(publicJson).not.toContain(privatePath);
    expect(publicJson).not.toContain(installPath);
    expect(publicJson).not.toContain("private-build-label");
  });

  it("does not enumerate application identities that tier bindings can never persist", async () => {
    const test = harness();
    const longProviderId = "p".repeat(193);
    const longModelProvider = provider({ id: "long-model-provider" });
    const controlProvider = provider({ id: "control-provider\u0001" });
    test.repository.providers.set(
      longProviderId,
      provider({ id: longProviderId }),
    );
    test.repository.models.set(longProviderId, [
      model(longProviderId, "valid-model"),
    ]);
    test.repository.providers.set(longModelProvider.id, longModelProvider);
    test.repository.models.set(longModelProvider.id, [
      model(longModelProvider.id, "m".repeat(257)),
    ]);
    test.repository.providers.set(controlProvider.id, controlProvider);
    test.repository.models.set(controlProvider.id, [
      model(controlProvider.id, "valid-model"),
    ]);

    const ids = (await test.service.listCandidates(GLOBAL_SCOPE)).map(
      (item) => item.providerId,
    );
    expect(ids).not.toContain(longProviderId);
    expect(ids).not.toContain(longModelProvider.id);
    expect(ids).not.toContain(controlProvider.id);
  });
});

describe("ModelTierService binding validation and invalidation", () => {
  it("accepts only an exact reference from a freshly recomputed candidate set", async () => {
    const test = harness();
    const candidate = (await test.service.listCandidates(GLOBAL_SCOPE))[0];
    test.repository.providers.get(candidate.providerId)!.enabled = false;
    const forged = {
      scope: GLOBAL_SCOPE,
      tier: "fast",
      providerId: candidate.providerId,
      modelId: candidate.modelId,
      runtimeType: "claude-code",
      capabilities: capabilities(),
      credentialRef: "forged-ref",
    } as SetModelTierBindingRequest;

    await expect(test.service.setBinding(forged)).rejects.toMatchObject({
      name: "ModelTierServiceError",
      code: "TIER_CANDIDATE_INVALID",
    });
    expect(test.repository.getModelTierBinding("fast")).toBeNull();
  });

  it("persists a valid intent while preserving existing display-only tier metadata", async () => {
    const test = harness();
    test.repository.globalBindings.set("balanced", {
      ...binding("balanced", null, null),
      displayName: "My balanced tier",
      quality: "high",
    });

    await expect(
      test.service.setBinding({
        scope: GLOBAL_SCOPE,
        tier: "balanced",
        providerId: "provider-mimo",
        modelId: "mimo-v2",
      }),
    ).resolves.toMatchObject({ validity: "valid", source: "global" });
    expect(test.repository.getModelTierBinding("balanced")).toEqual({
      tier: "balanced",
      providerId: "provider-mimo",
      modelId: "mimo-v2",
      displayName: "My balanced tier",
      quality: "high",
      speed: null,
      cost: null,
      updatedAt: 2_000,
    });
  });

  it.each([
    [
      "provider_deleted",
      (test: ReturnType<typeof harness>) => {
        test.repository.projectBindings.set("project-1:fast", {
          projectId: "project-1",
          ...binding("fast", "provider-deleted", "gone-model"),
        });
      },
    ],
    [
      "provider_disabled",
      (test: ReturnType<typeof harness>) => {
        test.repository.providers.get("provider-bad")!.enabled = false;
      },
    ],
    [
      "provider_unconfigured",
      (test: ReturnType<typeof harness>) => {
        test.repository.providers.get("provider-bad")!.credentialRef = null;
      },
    ],
    [
      "connection_unavailable",
      (test: ReturnType<typeof harness>) => {
        test.repository.providers.get("provider-bad")!.health = {
          state: "error",
          lastTestedAt: 8,
          lastErrorType: "network",
          latencyMs: null,
        };
      },
    ],
    [
      "model_missing",
      (test: ReturnType<typeof harness>) => {
        test.repository.projectBindings.set("project-1:fast", {
          projectId: "project-1",
          ...binding("fast", "provider-bad", "missing-model"),
        });
      },
    ],
    [
      "runtime_incompatible",
      (test: ReturnType<typeof harness>) => {
        test.repository.providers.get("provider-bad")!.runtimeType = "none";
      },
    ],
    [
      "workflow_capability_missing",
      (test: ReturnType<typeof harness>) => {
        test.repository.providers.get(
          "provider-bad",
        )!.capabilities.supportsAgentWorkflow = false;
      },
    ],
  ] as const)(
    "returns %s for an invalid project row without falling back to a valid global row",
    async (reason, mutate) => {
      const test = harness();
      const bad = provider({ id: "provider-bad", name: "Bad Provider" });
      test.repository.providers.set(bad.id, bad);
      test.repository.models.set(bad.id, [model(bad.id, "bad-model")]);
      test.repository.globalBindings.set(
        "fast",
        binding("fast", "provider-mimo", "mimo-v2"),
      );
      test.repository.projectBindings.set("project-1:fast", {
        projectId: "project-1",
        ...binding("fast", "provider-bad", "bad-model"),
      });
      mutate(test);

      await expect(
        test.service.resolveTier(PROJECT_SCOPE, "fast"),
      ).resolves.toMatchObject({
        source: "project",
        validity: "needs_reconfiguration",
        invalidReason: reason,
        candidate: null,
      });
    },
  );

  it("maps runtime-registry rejection to a safe typed reason without exposing its error", async () => {
    const test = harness({ rejectedProviderIds: ["provider-mimo"] });
    test.repository.globalBindings.set(
      "fast",
      binding("fast", "provider-mimo", "mimo-v2"),
    );

    const resolved = await test.service.resolveTier(GLOBAL_SCOPE, "fast");
    expect(resolved).toMatchObject({
      source: "global",
      validity: "needs_reconfiguration",
      invalidReason: "runtime_incompatible",
    });
    expect(JSON.stringify(resolved)).not.toContain("registry");
  });

  it("invalidates a synthetic binding when its non-secret source identity changes", async () => {
    const test = harness({ synthetic: environmentSelection() });
    const synthetic = (await test.service.listCandidates(GLOBAL_SCOPE)).find(
      (item) => item.executionSource === "environment",
    )!;
    await test.service.setBinding({
      scope: GLOBAL_SCOPE,
      tier: "fast",
      providerId: synthetic.providerId,
      modelId: synthetic.modelId,
    });

    test.setSynthetic(
      environmentSelection({ baseUrl: "https://new-gateway.example/v1" }),
    );
    await expect(
      test.service.resolveTier(GLOBAL_SCOPE, "fast"),
    ).resolves.toMatchObject({
      source: "global",
      binding: { providerId: synthetic.providerId, modelId: "env-model" },
      validity: "needs_reconfiguration",
      invalidReason: "source_changed",
    });
  });

  it("uses a distinct CLI-unavailable reason for the same current synthetic source", async () => {
    const test = harness({ synthetic: claudeSelection() });
    const synthetic = (await test.service.listCandidates(GLOBAL_SCOPE)).find(
      (item) => item.executionSource === "claude_code",
    )!;
    await test.service.setBinding({
      scope: GLOBAL_SCOPE,
      tier: "balanced",
      providerId: synthetic.providerId,
      modelId: synthetic.modelId,
    });

    test.control.installed = { installed: false, path: null, version: null };
    await expect(
      test.service.resolveTier(GLOBAL_SCOPE, "balanced"),
    ).resolves.toMatchObject({
      validity: "needs_reconfiguration",
      invalidReason: "claude_cli_unavailable",
    });
  });

  it("reports source_changed before CLI availability when the current source identity changed", async () => {
    const test = harness({ synthetic: environmentSelection() });
    const synthetic = (await test.service.listCandidates(GLOBAL_SCOPE)).find(
      (item) => item.executionSource === "environment",
    )!;
    test.repository.globalBindings.set(
      "fast",
      binding("fast", synthetic.providerId, synthetic.modelId),
    );

    test.setSynthetic(
      environmentSelection({ baseUrl: "https://changed.example/v1" }),
    );
    test.control.installed = { installed: false, path: null, version: null };
    await expect(
      test.service.resolveTier(GLOBAL_SCOPE, "fast"),
    ).resolves.toMatchObject({
      invalidReason: "source_changed",
    });
  });

  it.each([
    [
      "invalid auth",
      (test: ReturnType<typeof harness>) => {
        test.setSynthetic(
          environmentSelection({ authenticationMode: "forged" as "api_key" }),
        );
      },
      "source_changed",
    ],
    [
      "invalid URL",
      (test: ReturnType<typeof harness>) => {
        test.setSynthetic(
          environmentSelection({
            baseUrl: "https://user:secret@gateway.example/v1",
          }),
        );
      },
      "source_changed",
    ],
    [
      "runtime registry rejection",
      (test: ReturnType<typeof harness>) => {
        test.control.rejectedProviderIds.add("synthetic-current:environment");
      },
      "runtime_incompatible",
    ],
  ] as const)(
    "maps %s to a closed reason instead of pretending the CLI is unavailable",
    async (_label, mutate, reason) => {
      const test = harness({ synthetic: environmentSelection() });
      const synthetic = (await test.service.listCandidates(GLOBAL_SCOPE)).find(
        (item) => item.executionSource === "environment",
      )!;
      test.repository.globalBindings.set(
        "fast",
        binding("fast", synthetic.providerId, synthetic.modelId),
      );
      mutate(test);

      await expect(
        test.service.resolveTier(GLOBAL_SCOPE, "fast"),
      ).resolves.toMatchObject({
        validity: "needs_reconfiguration",
        invalidReason: reason,
      });
    },
  );

  it("fails closed when a legacy application row occupies the current synthetic ID", async () => {
    const test = harness({ synthetic: environmentSelection() });
    const synthetic = (await test.service.listCandidates(GLOBAL_SCOPE)).find(
      (item) => item.executionSource === "environment",
    )!;
    const collision = provider({
      id: synthetic.providerId,
      name: "Legacy collision",
      defaultModelId: synthetic.modelId,
    });
    test.repository.providers.set(collision.id, collision);
    test.repository.models.set(collision.id, [
      model(collision.id, synthetic.modelId),
    ]);
    test.repository.globalBindings.set(
      "fast",
      binding("fast", synthetic.providerId, synthetic.modelId),
    );

    expect(await test.service.listCandidates(GLOBAL_SCOPE)).not.toContainEqual(
      expect.objectContaining({
        providerId: synthetic.providerId,
        modelId: synthetic.modelId,
      }),
    );
    await expect(
      test.service.resolveTier(GLOBAL_SCOPE, "fast"),
    ).resolves.toMatchObject({
      validity: "needs_reconfiguration",
      invalidReason: "source_changed",
    });
  });
});

describe("ModelTierService end-of-await snapshots", () => {
  it.each([
    [
      "disabled",
      (test: ReturnType<typeof harness>) => {
        test.repository.providers.get("provider-mimo")!.enabled = false;
      },
    ],
    [
      "deleted",
      (test: ReturnType<typeof harness>) => {
        test.repository.providers.delete("provider-mimo");
      },
    ],
    [
      "model removed",
      (test: ReturnType<typeof harness>) => {
        test.repository.models.set("provider-mimo", []);
      },
    ],
    [
      "health failed",
      (test: ReturnType<typeof harness>) => {
        test.repository.providers.get("provider-mimo")!.health = {
          state: "error",
          lastTestedAt: 5,
          lastErrorType: "network",
          latencyMs: null,
        };
      },
    ],
  ] as const)(
    "does not write a stale application binding when the Provider becomes %s during await",
    async (_label, mutate) => {
      const installation = deferred<ClaudeInstallationInfo>();
      const test = harness({
        synthetic: environmentSelection(),
        checkInstallation: () => installation.promise,
      });
      const pending = test.service.setBinding({
        scope: GLOBAL_SCOPE,
        tier: "fast",
        providerId: "provider-mimo",
        modelId: "mimo-v2",
      });

      await vi.waitFor(() =>
        expect(test.runtime.checkInstallation).toHaveBeenCalledOnce(),
      );
      mutate(test);
      installation.resolve({
        installed: true,
        path: "C:/Claude/claude.exe",
        version: "2.1.218",
      });

      await expect(pending).rejects.toMatchObject({
        code: "TIER_CANDIDATE_INVALID",
      });
      expect(test.repository.getModelTierBinding("fast")).toBeNull();
    },
  );

  it("re-reads the effective synthetic source after installation before writing", async () => {
    const test = harness({ synthetic: environmentSelection() });
    const candidate = (await test.service.listCandidates(GLOBAL_SCOPE)).find(
      (item) => item.executionSource === "environment",
    )!;
    const installation = deferred<ClaudeInstallationInfo>();
    test.control.checkInstallation = () => installation.promise;

    const pending = test.service.setBinding({
      scope: GLOBAL_SCOPE,
      tier: "fast",
      providerId: candidate.providerId,
      modelId: candidate.modelId,
    });
    await vi.waitFor(() => {
      expect(test.runtime.checkInstallation).toHaveBeenCalledTimes(2);
    });
    test.setSynthetic(
      environmentSelection({ baseUrl: "https://changed.example/v1" }),
    );
    installation.resolve({
      installed: true,
      path: "C:/Program Files/Claude/claude.exe",
      version: "2.1.218",
    });

    await expect(pending).rejects.toMatchObject({
      code: "TIER_CANDIDATE_INVALID",
    });
    expect(test.repository.getModelTierBinding("fast")).toBeNull();
  });

  it("fails closed instead of accepting an installed result before a delayed final selection", async () => {
    const selection = environmentSelection();
    const delayedFinalSelection =
      deferred<EffectiveSyntheticTierSelection | null>();
    let selectionReads = 0;
    const test = harness({
      installed: {
        installed: true,
        path: "C:/Claude/claude.exe",
        version: "2.1.218",
      },
      resolveSynthetic: () => {
        selectionReads += 1;
        return selectionReads === 1 ? selection : delayedFinalSelection.promise;
      },
    });

    const pending = test.service.listCandidates(GLOBAL_SCOPE);
    await vi.waitFor(() => expect(selectionReads).toBe(2));
    test.control.installed = { installed: false, path: null, version: null };
    delayedFinalSelection.resolve(selection);

    await expect(pending).resolves.not.toContainEqual(
      expect.objectContaining({ executionSource: "environment" }),
    );
  });

  it("selects a project row inserted while the installation check is pending", async () => {
    const installation = deferred<ClaudeInstallationInfo>();
    const test = harness({
      synthetic: environmentSelection(),
      checkInstallation: () => installation.promise,
    });
    test.repository.globalBindings.set(
      "fast",
      binding("fast", "provider-mimo", "mimo-v2"),
    );

    const pending = test.service.resolveTier(PROJECT_SCOPE, "fast");
    await vi.waitFor(() =>
      expect(test.runtime.checkInstallation).toHaveBeenCalledOnce(),
    );
    test.repository.projectBindings.set("project-1:fast", {
      projectId: "project-1",
      ...binding("fast", null, null),
    });
    installation.resolve({
      installed: true,
      path: "C:/Claude/claude.exe",
      version: "2.1.218",
    });

    await expect(pending).resolves.toMatchObject({
      source: "project",
      validity: "unbound",
      binding: { providerId: null, modelId: null },
    });
  });

  it("rejects a project deleted while the installation check is pending", async () => {
    const installation = deferred<ClaudeInstallationInfo>();
    const test = harness({
      synthetic: environmentSelection(),
      checkInstallation: () => installation.promise,
    });
    const pending = test.service.resolveTier(PROJECT_SCOPE, "fast");

    await vi.waitFor(() =>
      expect(test.runtime.checkInstallation).toHaveBeenCalledOnce(),
    );
    test.projects.delete("project-1");
    installation.resolve({
      installed: true,
      path: "C:/Claude/claude.exe",
      version: "2.1.218",
    });

    await expect(pending).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });
});

describe("ModelTierService scope authority", () => {
  it("falls back to the global row only when the project row is absent", async () => {
    const test = harness();
    await bindGlobalToMimo(test);

    await expect(
      test.service.resolveTier(PROJECT_SCOPE, "fast"),
    ).resolves.toMatchObject({
      source: "global",
      validity: "valid",
      binding: { providerId: "provider-mimo", modelId: "mimo-v2" },
    });
  });

  it("treats an explicit project unbound row as authoritative", async () => {
    const test = harness();
    await bindGlobalToMimo(test);
    test.repository.projectBindings.set("project-1:fast", {
      projectId: "project-1",
      ...binding("fast", null, null),
    });

    await expect(
      test.service.resolveTier(PROJECT_SCOPE, "fast"),
    ).resolves.toMatchObject({
      source: "project",
      validity: "unbound",
      invalidReason: "tier_unbound",
      binding: { providerId: null, modelId: null },
    });
  });

  it("deletes the project row to follow global and returns all three resolutions", async () => {
    const test = harness();
    await bindGlobalToMimo(test);
    test.repository.projectBindings.set("project-1:fast", {
      projectId: "project-1",
      ...binding("fast", null, null),
    });

    await expect(
      test.service.clearProjectBinding("project-1", "fast"),
    ).resolves.toBe(true);
    await expect(
      test.service.resolveTier(PROJECT_SCOPE, "fast"),
    ).resolves.toMatchObject({
      source: "global",
      validity: "valid",
    });
    const bindings = await test.service.getBindings(PROJECT_SCOPE);
    expect(bindings.map(({ tier }) => tier)).toEqual([
      "high_quality",
      "balanced",
      "fast",
    ]);
    expect(bindings.find(({ tier }) => tier === "fast")).toMatchObject({
      source: "global",
      validity: "valid",
    });
  });

  it("returns a typed unbound result when neither scope has a row", async () => {
    const test = harness();

    await expect(
      test.service.resolveTier(PROJECT_SCOPE, "high_quality"),
    ).resolves.toEqual({
      scope: PROJECT_SCOPE,
      tier: "high_quality",
      display: {
        tier: "high_quality",
        displayName: null,
        quality: null,
        speed: null,
        cost: null,
      },
      source: "none",
      binding: null,
      candidate: null,
      validity: "unbound",
      invalidReason: "tier_unbound",
    });
  });

  it.each([
    [
      "listCandidates",
      (test: ReturnType<typeof harness>) =>
        test.service.listCandidates({
          type: "project",
          projectId: "ghost-project",
        }),
    ],
    [
      "getBindings",
      (test: ReturnType<typeof harness>) =>
        test.service.getBindings({
          type: "project",
          projectId: "ghost-project",
        }),
    ],
    [
      "setBinding",
      (test: ReturnType<typeof harness>) =>
        test.service.setBinding({
          scope: { type: "project", projectId: "ghost-project" },
          tier: "fast",
          providerId: "provider-mimo",
          modelId: "mimo-v2",
        }),
    ],
    [
      "clearProjectBinding",
      (test: ReturnType<typeof harness>) =>
        test.service.clearProjectBinding("ghost-project", "fast"),
    ],
    [
      "resolveTier",
      (test: ReturnType<typeof harness>) =>
        test.service.resolveTier(
          { type: "project", projectId: "ghost-project" },
          "fast",
        ),
    ],
  ] as const)(
    "rejects ghost projects before %s can read or write fallback state",
    async (_name, run) => {
      const test = harness();
      test.repository.globalBindings.set(
        "fast",
        binding("fast", "provider-mimo", "mimo-v2"),
      );

      await expect(run(test)).rejects.toMatchObject({
        name: "ModelTierServiceError",
        code: "PROJECT_NOT_FOUND",
      });
      expect(test.repository.projectBindings.size).toBe(0);
    },
  );

  it("maps project upsert failures to a safe typed error", async () => {
    const rawDatabaseError = "FOREIGN KEY failed: internal-path secret-ref";
    const test = harness();
    test.repository.projectUpsertError = new Error(rawDatabaseError);

    const failure = test.service.setBinding({
      scope: PROJECT_SCOPE,
      tier: "fast",
      providerId: "provider-mimo",
      modelId: "mimo-v2",
    });
    await expect(failure).rejects.toMatchObject({
      code: "TIER_BINDING_WRITE_FAILED",
    });
    await expect(failure).rejects.not.toThrow(rawDatabaseError);
  });

  it("maps project clear failures to a safe typed error", async () => {
    const rawDatabaseError = "database raw delete secret";
    const test = harness();
    test.repository.projectDeleteError = new Error(rawDatabaseError);

    const failure = test.service.clearProjectBinding("project-1", "fast");
    await expect(failure).rejects.toMatchObject({
      code: "TIER_BINDING_CLEAR_FAILED",
    });
    await expect(failure).rejects.not.toThrow(rawDatabaseError);
  });

  it("rebuilds a closed safe scope before callbacks, queries, and public projection", async () => {
    const secret = "scope-secret-sentinel";
    const seenScopes: ModelTierScope[] = [];
    const test = harness({
      resolveSynthetic: async (scope) => {
        seenScopes.push(scope);
        return null;
      },
    });
    test.repository.globalBindings.set(
      "fast",
      binding("fast", "provider-mimo", "mimo-v2"),
    );
    const unsafeScope = {
      type: "global",
      credentialRef: `safe-storage://${secret}`,
      vaultPath: `C:/vault/${secret}`,
      rawEnvironment: { ANTHROPIC_API_KEY: secret },
      baseUrl: `https://${secret}.internal`,
      rawError: secret,
    } as ModelTierScope;

    const resolution = await test.service.resolveTier(unsafeScope, "fast");
    expect(seenScopes).toEqual([{ type: "global" }, { type: "global" }]);
    expect(resolution.scope).toEqual({ type: "global" });
    expect(JSON.stringify(resolution)).not.toContain(secret);
    expect(JSON.stringify(resolution.scope)).toBe('{"type":"global"}');
  });
});

describe("ModelTierService prepared trusted snapshots", () => {
  it("uses a prepared CLI fact but synchronously rechecks credential existence", async () => {
    const test = harness();
    test.repository.globalBindings.set(
      "balanced",
      binding("balanced", "provider-mimo", "mimo-v2"),
    );
    const prepared = await test.service.prepareTrustedSnapshot(GLOBAL_SCOPE);
    test.credentialReferences.delete("safe-storage://v1/provider-mimo");

    expect(
      test.service.resolvePreparedBindings(GLOBAL_SCOPE, prepared),
    ).toContainEqual(
      expect.objectContaining({
        tier: "balanced",
        validity: "needs_reconfiguration",
        invalidReason: "provider_unconfigured",
      }),
    );
  });

  it("synchronously rejects a synthetic source changed after preparation", async () => {
    const test = harness({ synthetic: environmentSelection() });
    const candidate = (await test.service.listCandidates(GLOBAL_SCOPE)).find(
      (item) => item.executionSource === "environment",
    )!;
    test.repository.globalBindings.set(
      "fast",
      binding("fast", candidate.providerId, candidate.modelId),
    );
    const prepared = await test.service.prepareTrustedSnapshot(GLOBAL_SCOPE);
    test.setSynthetic(
      environmentSelection({ baseUrl: "https://changed.example/v1" }),
    );

    expect(
      test.service.resolvePreparedBindings(GLOBAL_SCOPE, prepared),
    ).toContainEqual(
      expect.objectContaining({
        tier: "fast",
        validity: "needs_reconfiguration",
        invalidReason: "source_changed",
      }),
    );
  });

  it("rejects a forged prepared token", () => {
    const test = harness();

    expect(() =>
      test.service.resolvePreparedBindings(GLOBAL_SCOPE, {} as never),
    ).toThrowError(ModelTierServiceError);
  });
});

describe("ModelTierService atomic bind all", () => {
  it("validates one trusted candidate once and binds all three tiers to it", async () => {
    const test = harness();

    const result = await test.service.bindAllTiers({
      scope: GLOBAL_SCOPE,
      providerId: "provider-mimo",
      modelId: "mimo-v2",
    });

    expect(test.repository.bindAllDerivations).toBe(1);
    expect(result.map(({ tier, binding }) => ({
      tier,
      providerId: binding?.providerId,
      modelId: binding?.modelId,
    }))).toEqual([
      { tier: "high_quality", providerId: "provider-mimo", modelId: "mimo-v2" },
      { tier: "balanced", providerId: "provider-mimo", modelId: "mimo-v2" },
      { tier: "fast", providerId: "provider-mimo", modelId: "mimo-v2" },
    ]);
  });

  it("maps a late bind-all failure to a closed error and leaves every tier unchanged", async () => {
    const test = harness();
    test.repository.globalBindings.set(
      "high_quality",
      binding("high_quality", "old-provider", "old-model"),
    );
    test.repository.bindAllLateError = new Error("raw vault path C:/private/key.bin");

    await expect(test.service.bindAllTiers({
      scope: GLOBAL_SCOPE,
      providerId: "provider-mimo",
      modelId: "mimo-v2",
    })).rejects.toMatchObject({
      code: "TIER_BINDING_WRITE_FAILED",
      message: "The model tier bindings could not be saved.",
    });
    expect(test.repository.listModelTierBindings()).toEqual([
      binding("high_quality", "old-provider", "old-model"),
    ]);
  });
});

describe("ModelTierService display metadata", () => {
  it("updates presentation notes without changing the selected model", async () => {
    const test = harness();
    await test.service.setBinding({
      scope: GLOBAL_SCOPE,
      tier: "balanced",
      providerId: "provider-mimo",
      modelId: "mimo-v2",
    });

    const result = await test.service.updateDisplayMetadata({
      scope: GLOBAL_SCOPE,
      metadata: {
        tier: "balanced",
        displayName: "Daily work",
        quality: "medium",
        speed: "high",
        cost: "low",
      },
    });

    expect(result).toMatchObject({
      tier: "balanced",
      binding: { providerId: "provider-mimo", modelId: "mimo-v2" },
      display: {
        displayName: "Daily work",
        quality: "medium",
        speed: "high",
        cost: "low",
      },
    });
  });
});

describe("ModelTierServiceError", () => {
  it("keeps the invalid write reason machine-readable", () => {
    expect(
      new ModelTierServiceError("TIER_CANDIDATE_INVALID", "safe"),
    ).toMatchObject({
      name: "ModelTierServiceError",
      code: "TIER_CANDIDATE_INVALID",
      message: "safe",
    });
  });
});
