import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeInstallationInfo } from "../../../shared/types/claude";
import {
  AGENT_PRESETS,
  MODEL_TIERS,
  type AgentPresetId,
  type ModelTier,
  type PersistedModelPolicyReference,
} from "../../../shared/types/modelTiers";
import type { ModelPolicyAgentType } from "../../../shared/types/modelProviders";
import { AppDatabase } from "../../database/Database";
import type { AgentRuntime, RuntimeProviderDescriptor } from "../AgentRuntime";
import { AgentRuntimeRegistry } from "../AgentRuntimeRegistry";
import { AgentModelPolicyService } from "../AgentModelPolicyService";
import {
  AgentPresetService,
  AgentPresetServiceError,
  type AgentPresetRepository,
} from "../AgentPresetService";
import {
  ModelProviderRepository,
  type ModelTierBindingRecord,
} from "../ModelProviderRepository";
import type {
  StoredModelProvider,
  StoredProviderModel,
} from "../ModelProviderService";
import { ModelTierService } from "../ModelTierService";

const GLOBAL_SCOPE = { type: "global" } as const;
const PROJECT_SCOPE = { type: "project", projectId: "project-1" } as const;
const ROOT_PREFIX = "workbench-agent-preset-";
const CREDENTIAL_REF = "safe-storage://v1/7de5fe22-e45c-4ae0-9904-618379303d0b";
const CREDENTIAL_TWO = "safe-storage://v1/a80a4be6-0e1f-4207-ac29-0db955b4c997";

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
    credentialRef: CREDENTIAL_REF,
    defaultModelId: "mimo-v2",
    enabled: true,
    isDefault: false,
    capabilities: {
      supportsClaudeCode: true,
      supportsAgentWorkflow: true,
      supportsTools: true,
      supportsMCP: true,
      supportsStreaming: true,
      supportsVision: false,
    },
    health: {
      state: "connected",
      lastTestedAt: 1_725_000_000_000,
      lastErrorType: null,
      latencyMs: 42,
    },
    metadata: {},
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function model(
  overrides: Partial<StoredProviderModel> = {},
): StoredProviderModel {
  return {
    providerId: "provider-mimo",
    modelId: "mimo-v2",
    displayName: "MiMo V2",
    source: "manual",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function runtime(): AgentRuntime {
  const installed: ClaudeInstallationInfo = {
    installed: true,
    path: "C:/Program Files/Claude/claude.exe",
    version: "2.1.218",
  };
  return {
    type: "claude-code",
    implemented: true,
    supports: (_descriptor: RuntimeProviderDescriptor) => true,
    checkInstallation: vi.fn(async () => installed),
    runPrompt: vi.fn(async (options) => ({ runId: options.runId, pid: 1 })),
    stopRun: vi.fn(async () => true),
    stopAll: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
  };
}

function bindAllTiers(
  repository: ModelProviderRepository,
  input: { providerId?: string; modelId?: string; updatedAt?: number } = {},
): void {
  for (const [index, tier] of MODEL_TIERS.entries()) {
    repository.upsertModelTierBinding({
      tier,
      providerId: input.providerId ?? "provider-mimo",
      modelId: input.modelId ?? "mimo-v2",
      displayName: tier.replace("_", " "),
      quality: tier === "high_quality" ? "high" : "medium",
      speed: tier === "fast" ? "high" : "medium",
      cost: tier === "high_quality" ? "high" : "medium",
      updatedAt: (input.updatedAt ?? 2_000) + index,
    });
  }
}

function atomicProxy(
  repository: ModelProviderRepository,
  apply: AgentPresetRepository["applyAgentPolicyReferencesAtomically"],
): AgentPresetRepository {
  return new Proxy(repository, {
    get(target, property, receiver) {
      if (property === "applyAgentPolicyReferencesAtomically") return apply;
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AgentPresetRepository;
}

describe("AgentPresetService", () => {
  let root: string;
  let databasePath: string;
  let database: AppDatabase;
  let repository: ModelProviderRepository;
  let tierService: ModelTierService;
  let service: AgentPresetService;
  let credentialReferences: Set<string>;

  function rebuild(
    presetRepository: AgentPresetRepository = repository,
    now = 5_000,
  ): void {
    tierService = new ModelTierService({
      repository,
      runtimeRegistry: new AgentRuntimeRegistry([runtime()]),
      syntheticIdentityHmac: {
        digestSha256: (canonical) =>
          createHmac("sha256", "test-installation-key")
            .update(canonical)
            .digest("hex"),
      },
      credentialExists: (reference) => credentialReferences.has(reference),
      projectExists: (projectId) => Boolean(database.getProject(projectId)),
      resolveEffectiveSyntheticSelection: () => null,
      now: () => now,
    });
    service = new AgentPresetService({
      repository: presetRepository,
      tierService,
      now: () => now,
    });
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), ROOT_PREFIX));
    databasePath = path.join(root, "workbench.sqlite");
    database = new AppDatabase(databasePath);
    repository = new ModelProviderRepository(database);
    database.createProject("project-1", "One", path.join(root, "one"));
    database.createSession("task-1", "project-1", "Task");
    database.ensureTask("task-1", "project-1");
    credentialReferences = new Set([CREDENTIAL_REF]);
    repository.createProvider(provider(), [model()]);
    rebuild();
  });

  afterEach(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("routes unbound or invalid referenced tiers to the bind wizard", async () => {
    await expect(
      service.preparePreset(GLOBAL_SCOPE, "software_development"),
    ).resolves.toEqual({
      step: "bind_tiers",
      missingTiers: ["high_quality", "balanced", "fast"],
    });

    bindAllTiers(repository);
    repository.updateProviderHealth("provider-mimo", {
      state: "error",
      lastTestedAt: 2_500,
      lastErrorType: "network",
      latencyMs: null,
    });
    await expect(
      service.preparePreset(GLOBAL_SCOPE, "high_quality_review"),
    ).resolves.toEqual({
      step: "bind_tiers",
      missingTiers: ["high_quality", "balanced"],
    });
  });

  it("allows one trusted candidate to back all three tiers and returns a safe role preview", async () => {
    bindAllTiers(repository);

    const prepared = await service.preparePreset(
      GLOBAL_SCOPE,
      "software_development",
    );
    expect(prepared.step).toBe("preview");
    if (prepared.step !== "preview") throw new Error("Expected preview.");
    expect(prepared.preview.roles.coder).toMatchObject({
      role: "coder",
      tier: "balanced",
      resolution: {
        source: "global",
        validity: "valid",
        invalidReason: null,
        candidate: {
          providerId: "provider-mimo",
          providerName: "MiMo",
          modelId: "mimo-v2",
          modelDisplayName: "MiMo V2",
          runtimeType: "claude-code",
          executionSource: "database_provider",
        },
      },
    });
    expect(JSON.stringify(prepared.preview)).not.toMatch(
      /credential|safe-storage|baseUrl|rawError|lastErrorType|latencyMs/iu,
    );
  });

  it("keeps canonical ordering independent from locale collation for non-ASCII identities", async () => {
    const unicodeProviderId = "供应商-ß";
    const unicodeModelId = "模型-é";
    credentialReferences.add(CREDENTIAL_TWO);
    repository.createProvider(
      provider({
        id: unicodeProviderId,
        name: "供应商",
        credentialRef: CREDENTIAL_TWO,
        defaultModelId: unicodeModelId,
      }),
      [model({ providerId: unicodeProviderId, modelId: unicodeModelId })],
    );
    bindAllTiers(repository);
    repository.upsertModelTierBinding({
      ...(repository.getModelTierBinding("fast") as ModelTierBindingRecord),
      providerId: unicodeProviderId,
      modelId: unicodeModelId,
      updatedAt: 3_000,
    });
    const baseline = await service.previewPreset(
      GLOBAL_SCOPE,
      "software_development",
    );
    const localeCompare = vi
      .spyOn(String.prototype, "localeCompare")
      .mockImplementation(() => {
        throw new Error("locale collation must not be used");
      });
    try {
      await expect(
        service.previewPreset(GLOBAL_SCOPE, "software_development"),
      ).resolves.toMatchObject({ revision: baseline.revision });
    } finally {
      localeCompare.mockRestore();
    }
  });

  it.each([
    ["preparePreset", "PRESET_PREVIEW_FAILED"],
    ["previewPreset", "PRESET_PREVIEW_FAILED"],
    ["applyPreset", "PRESET_APPLY_FAILED"],
  ] as const)(
    "maps raw dependency failures from %s to a closed error",
    async (method, code) => {
      const sentinel = "SQLITE secret=sk-raw-internal";
      const brokenTierService = new Proxy(tierService, {
        get(target, property, receiver) {
          if (
            property === "prepareTrustedSnapshot" ||
            property === "getBindings"
          ) {
            return async () => {
              throw new Error(sentinel);
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      service = new AgentPresetService({
        repository,
        tierService: brokenTierService,
        now: () => 5_000,
      });
      const operation =
        method === "preparePreset"
          ? service.preparePreset(GLOBAL_SCOPE, "software_development")
          : method === "previewPreset"
            ? service.previewPreset(GLOBAL_SCOPE, "software_development")
            : service.applyPreset(
                GLOBAL_SCOPE,
                "software_development",
                `agent-preset:v1:${"a".repeat(64)}`,
                true,
                false,
              );

      const error = await operation.then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(AgentPresetServiceError);
      expect(error).toMatchObject({ code });
      expect((error as Error).message).not.toContain(sentinel);
    },
  );

  it("maps raw repository failures from getPresetStatus to a closed error", async () => {
    const sentinel = "SQLITE_CORRUPT credential=raw-secret";
    const brokenRepository = new Proxy(repository, {
      get(target, property, receiver) {
        if (property === "listAgentModelPolicyReferences") {
          return () => {
            throw new Error(sentinel);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AgentPresetRepository;
    rebuild(brokenRepository);

    const error = await service.getPresetStatus(GLOBAL_SCOPE).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(AgentPresetServiceError);
    expect(error).toMatchObject({ code: "PRESET_STATUS_FAILED" });
    expect((error as Error).message).not.toContain(sentinel);
  });

  it("maps raw repository write failures from applyPreset to a closed error", async () => {
    const sentinel = "SQLITE_IOERR vault=raw-secret";
    bindAllTiers(repository);
    const preview = await service.previewPreset(
      GLOBAL_SCOPE,
      "software_development",
    );
    const brokenRepository = atomicProxy(repository, () => {
      throw new Error(sentinel);
    });
    rebuild(brokenRepository);

    const error = await service
      .applyPreset(
        GLOBAL_SCOPE,
        "software_development",
        preview.revision,
        true,
        false,
      )
      .then(
        () => null,
        (reason: unknown) => reason,
      );
    expect(error).toBeInstanceOf(AgentPresetServiceError);
    expect(error).toMatchObject({ code: "PRESET_APPLY_FAILED" });
    expect((error as Error).message).not.toContain(sentinel);
    expect(repository.listAgentModelPolicyReferences()).toEqual([]);
  });

  it.each(
    Object.entries(AGENT_PRESETS) as [
      AgentPresetId,
      (typeof AGENT_PRESETS)[AgentPresetId],
    ][],
  )("applies the exact shared mapping for %s", async (presetId, definition) => {
    bindAllTiers(repository);
    const preview = await service.previewPreset(GLOBAL_SCOPE, presetId);
    await expect(
      service.applyPreset(
        GLOBAL_SCOPE,
        presetId,
        preview.revision,
        true,
        false,
      ),
    ).resolves.toEqual({ presetId, appliedAt: 5_000 });

    const references = Object.fromEntries(
      repository
        .listAgentModelPolicyReferences()
        .map((row) => [row.agentType, row.reference]),
    );
    expect(references).toEqual(
      Object.fromEntries(
        Object.entries(definition.roles).map(([role, tier]) => [
          role,
          { kind: "tier", tier },
        ]),
      ),
    );
    await expect(service.getPresetStatus(GLOBAL_SCOPE)).resolves.toEqual({
      kind: "preset",
      presetId,
    });
  });

  it("uses trusted Tools/MCP facts for coding roles while keeping Reviewer read-only-compatible", async () => {
    repository.updateProvider(
      provider({
        capabilities: {
          ...provider().capabilities,
          supportsTools: false,
          supportsMCP: false,
        },
      }),
      [model()],
      provider(),
    );
    bindAllTiers(repository);

    const preview = await service.previewPreset(
      GLOBAL_SCOPE,
      "software_development",
    );
    expect(preview.roles.coder.resolution).toMatchObject({
      validity: "needs_reconfiguration",
      invalidReason: "workflow_capability_missing",
    });
    expect(preview.roles.tester.resolution.validity).toBe(
      "needs_reconfiguration",
    );
    expect(preview.roles.fixer.resolution.validity).toBe(
      "needs_reconfiguration",
    );
    expect(preview.roles.reviewer.resolution.validity).toBe("valid");
    await expect(
      service.applyPreset(
        GLOBAL_SCOPE,
        "software_development",
        preview.revision,
        true,
        false,
      ),
    ).rejects.toMatchObject({ code: "PRESET_ROLE_UNAVAILABLE" });
  });

  it("rejects a stale revision after trusted Provider health changes", async () => {
    bindAllTiers(repository);
    const preview = await service.previewPreset(
      GLOBAL_SCOPE,
      "software_development",
    );
    repository.updateProviderHealth("provider-mimo", {
      state: "connected",
      lastTestedAt: 9_999,
      lastErrorType: null,
      latencyMs: 12,
    });

    await expect(
      service.applyPreset(
        GLOBAL_SCOPE,
        "software_development",
        preview.revision,
        true,
        false,
      ),
    ).rejects.toMatchObject({ code: "PREVIEW_STALE" });
    expect(repository.listAgentModelPolicyReferences()).toEqual([]);
  });

  it("includes current role-policy references in the trusted revision", async () => {
    bindAllTiers(repository);
    const preview = await service.previewPreset(
      GLOBAL_SCOPE,
      "software_development",
    );
    repository.setAgentModelPolicyReference({
      agentType: "planner",
      reference: {
        kind: "model",
        providerId: "provider-mimo",
        modelId: "mimo-v2",
      },
      quality: null,
      speed: null,
      cost: null,
      createdAt: 4_000,
      updatedAt: 4_000,
    });

    await expect(
      service.applyPreset(
        GLOBAL_SCOPE,
        "software_development",
        preview.revision,
        true,
        true,
      ),
    ).rejects.toMatchObject({ code: "PREVIEW_STALE" });
    expect(repository.listAgentModelPolicyReferences()).toHaveLength(1);
  });

  it("owns the fresh revision comparison inside the transaction callback", async () => {
    bindAllTiers(repository);
    const preview = await service.previewPreset(
      GLOBAL_SCOPE,
      "software_development",
    );
    const proxied = atomicProxy(repository, (input) => {
      expect(input).not.toHaveProperty("expectedRevision");
      repository.applyAgentPolicyReferencesAtomically({
        ...input,
        deriveReferencesInTransaction: () => {
          repository.upsertModelTierBinding({
            ...(repository.getModelTierBinding(
              "balanced",
            ) as ModelTierBindingRecord),
            updatedAt: 9_999,
          });
          return input.deriveReferencesInTransaction();
        },
      });
    });
    rebuild(proxied);

    await expect(
      service.applyPreset(
        GLOBAL_SCOPE,
        "software_development",
        preview.revision,
        true,
        false,
      ),
    ).rejects.toMatchObject({ code: "PREVIEW_STALE" });
    expect(repository.getModelTierBinding("balanced")?.updatedAt).toBe(2_001);
    expect(repository.listAgentModelPolicyReferences()).toEqual([]);
  });

  it.each([
    [
      "credential removal",
      () => {
        repository.updateProvider(
          provider({ credentialRef: CREDENTIAL_TWO, updatedAt: 9_901 }),
          [model()],
          provider(),
        );
      },
      "PREVIEW_STALE",
    ],
    [
      "failed health",
      () => {
        repository.updateProviderHealth("provider-mimo", {
          state: "error",
          lastTestedAt: 9_902,
          lastErrorType: "network",
          latencyMs: null,
        });
      },
      "PREVIEW_STALE",
    ],
    [
      "disabled Provider",
      () => {
        repository.setProviderEnabled("provider-mimo", false, 9_903);
      },
      "PREVIEW_STALE",
    ],
    [
      "Provider persisted update",
      () => {
        repository.updateProvider(
          provider({ updatedAt: 9_904 }),
          [model()],
          provider(),
        );
      },
      "PREVIEW_STALE",
    ],
    [
      "model metadata update",
      () => {
        repository.upsertModels("provider-mimo", [
          model({ displayName: "MiMo V2 changed", updatedAt: 9_905 }),
        ]);
      },
      "PREVIEW_STALE",
    ],
  ] as const)(
    "synchronously re-resolves %s inside the write transaction",
    async (_label, mutate, expectedCode) => {
      bindAllTiers(repository);
      const preview = await service.previewPreset(
        GLOBAL_SCOPE,
        "software_development",
      );
      const proxied = atomicProxy(repository, (input) => {
        repository.applyAgentPolicyReferencesAtomically({
          ...input,
          deriveReferencesInTransaction: () => {
            mutate();
            return input.deriveReferencesInTransaction();
          },
        });
      });
      rebuild(proxied);

      await expect(
        service.applyPreset(
          GLOBAL_SCOPE,
          "software_development",
          preview.revision,
          true,
          false,
        ),
      ).rejects.toMatchObject({ code: expectedCode });
      expect(repository.listAgentModelPolicyReferences()).toEqual([]);
    },
  );

  it("synchronously includes model source changes in the transaction revision", async () => {
    credentialReferences.add(CREDENTIAL_TWO);
    repository.createProvider(
      provider({
        id: "provider-source",
        credentialRef: CREDENTIAL_TWO,
        defaultModelId: "source-model",
      }),
      [
        model({
          providerId: "provider-source",
          modelId: "source-model",
          source: "discovered",
        }),
      ],
    );
    for (const [index, tier] of MODEL_TIERS.entries()) {
      repository.upsertModelTierBinding({
        tier,
        providerId: "provider-source",
        modelId: "source-model",
        displayName: null,
        quality: null,
        speed: null,
        cost: null,
        updatedAt: 7_000 + index,
      });
    }
    const preview = await service.previewPreset(
      GLOBAL_SCOPE,
      "software_development",
    );
    const proxied = atomicProxy(repository, (input) => {
      repository.applyAgentPolicyReferencesAtomically({
        ...input,
        deriveReferencesInTransaction: () => {
          repository.upsertModels("provider-source", [
            model({
              providerId: "provider-source",
              modelId: "source-model",
              source: "manual",
            }),
          ]);
          return input.deriveReferencesInTransaction();
        },
      });
    });
    rebuild(proxied);

    await expect(
      service.applyPreset(
        GLOBAL_SCOPE,
        "software_development",
        preview.revision,
        true,
        false,
      ),
    ).rejects.toMatchObject({ code: "PREVIEW_STALE" });
    expect(
      repository
        .listModels("provider-source")
        .find((item) => item.modelId === "source-model")?.source,
    ).toBe("discovered");
    expect(repository.listAgentModelPolicyReferences()).toEqual([]);
  });

  it("rolls back the first four roles when the fifth role write fails", async () => {
    bindAllTiers(repository);
    const preview = await service.previewPreset(
      GLOBAL_SCOPE,
      "software_development",
    );
    const proxied = atomicProxy(repository, (input) => {
      repository.applyAgentPolicyReferencesAtomically({
        ...input,
        deriveReferencesInTransaction: () => {
          const baseReferences = input.deriveReferencesInTransaction();
          const references = {
            ...baseReferences,
            fixer: { kind: "tier", tier: "not-a-tier" as ModelTier },
          } satisfies Readonly<
            Record<ModelPolicyAgentType, PersistedModelPolicyReference>
          >;
          return references;
        },
      });
    });
    rebuild(proxied);

    await expect(
      service.applyPreset(
        GLOBAL_SCOPE,
        "software_development",
        preview.revision,
        true,
        false,
      ),
    ).rejects.toBeInstanceOf(AgentPresetServiceError);
    expect(repository.listAgentModelPolicyReferences()).toEqual([]);
  });

  it("keeps project default, task override, and the other policy scope isolated", async () => {
    bindAllTiers(repository);
    repository.setAgentModelPolicyReference({
      agentType: "planner",
      reference: {
        kind: "model",
        providerId: "provider-mimo",
        modelId: "mimo-v2",
      },
      quality: "high",
      speed: "low",
      cost: "medium",
      createdAt: 111,
      updatedAt: 111,
    });
    repository.setProjectModelPolicy({
      projectId: "project-1",
      agentType: "default",
      providerId: "provider-mimo",
      modelId: "mimo-v2",
      createdAt: 222,
      updatedAt: 222,
    });
    repository.setTaskModelOverride({
      taskId: "task-1",
      providerId: "provider-mimo",
      modelId: "mimo-v2",
      createdAt: 333,
      updatedAt: 333,
    });
    const globalBefore = repository.getAgentModelPolicyReference("planner");
    const defaultBefore = repository.getProjectModelPolicy(
      "project-1",
      "default",
    );
    const taskBefore = repository.getTaskModelOverride("task-1");

    const preview = await service.previewPreset(PROJECT_SCOPE, "quick_change");
    await service.applyPreset(
      PROJECT_SCOPE,
      "quick_change",
      preview.revision,
      true,
      false,
    );

    expect(repository.getAgentModelPolicyReference("planner")).toEqual(
      globalBefore,
    );
    expect(repository.getProjectModelPolicy("project-1", "default")).toEqual(
      defaultBefore,
    );
    expect(repository.getTaskModelOverride("task-1")).toEqual(taskBefore);
    expect(
      repository.listProjectModelPolicyReferences("project-1"),
    ).toHaveLength(6);

    const projectBeforeGlobalApply =
      repository.listProjectModelPolicyReferences("project-1");
    const globalPreview = await service.previewPreset(
      GLOBAL_SCOPE,
      "high_quality_review",
    );
    await service.applyPreset(
      GLOBAL_SCOPE,
      "high_quality_review",
      globalPreview.revision,
      true,
      true,
    );
    expect(repository.listProjectModelPolicyReferences("project-1")).toEqual(
      projectBeforeGlobalApply,
    );
    expect(repository.getProjectModelPolicy("project-1", "default")).toEqual(
      defaultBefore,
    );
    expect(repository.getTaskModelOverride("task-1")).toEqual(taskBefore);
  });

  it("marks a manual direct model override custom and preserves preset status for note-only edits", async () => {
    bindAllTiers(repository);
    const preview = await service.previewPreset(
      GLOBAL_SCOPE,
      "software_development",
    );
    await service.applyPreset(
      GLOBAL_SCOPE,
      "software_development",
      preview.revision,
      true,
      false,
    );

    const policyService = new AgentModelPolicyService({
      store: repository,
      runtimeGate: new AgentRuntimeRegistry([runtime()]),
      now: () => 6_000,
    });
    policyService.updateAgentPolicyNotes({
      agentType: "planner",
      quality: "high",
      speed: "medium",
      cost: "low",
    });
    await expect(service.getPresetStatus(GLOBAL_SCOPE)).resolves.toEqual({
      kind: "preset",
      presetId: "software_development",
    });

    policyService.setAgentPolicy({
      agentType: "coder",
      providerId: "provider-mimo",
      modelId: "mimo-v2",
      quality: null,
      speed: null,
      cost: null,
    });
    await expect(service.getPresetStatus(GLOBAL_SCOPE)).resolves.toEqual({
      kind: "custom",
    });
  });

  it("rejects preset status for a deleted project scope", async () => {
    database.deleteProject("project-1");

    await expect(service.getPresetStatus(PROJECT_SCOPE)).rejects.toMatchObject({
      code: "PRESET_STATUS_FAILED",
    });
  });

  it.each([
    [
      "unknown role",
      [
        {
          agentType: "intruder",
          reference: { kind: "tier", tier: "fast" },
          quality: null,
          speed: null,
          cost: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    ],
    [
      "duplicate role",
      [
        {
          agentType: "planner",
          reference: { kind: "tier", tier: "high_quality" },
          quality: null,
          speed: null,
          cost: null,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          agentType: "planner",
          reference: {
            kind: "model",
            providerId: "provider-mimo",
            modelId: "mimo-v2",
          },
          quality: null,
          speed: null,
          cost: null,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    ],
    [
      "conflicting reference",
      [
        {
          agentType: "planner",
          reference: {
            kind: "tier",
            tier: "high_quality",
            providerId: "provider-mimo",
            modelId: "mimo-v2",
          },
          quality: null,
          speed: null,
          cost: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    ],
  ] as const)(
    "fails closed on %s rows from the repository seam",
    async (_label, rows) => {
      const inconsistentRepository = new Proxy(repository, {
        get(target, property, receiver) {
          if (property === "listAgentModelPolicyReferences") return () => rows;
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as AgentPresetRepository;
      rebuild(inconsistentRepository);

      await expect(service.getPresetStatus(GLOBAL_SCOPE)).rejects.toMatchObject(
        {
          code: "PRESET_STATUS_FAILED",
        },
      );
    },
  );

  it("requires preview confirmation for every apply and an additional overwrite confirmation", async () => {
    bindAllTiers(repository);
    const first = await service.previewPreset(
      GLOBAL_SCOPE,
      "software_development",
    );
    await expect(
      service.applyPreset(
        GLOBAL_SCOPE,
        "software_development",
        first.revision,
        false,
        false,
      ),
    ).rejects.toMatchObject({ code: "PREVIEW_CONFIRMATION_REQUIRED" });
    expect(repository.listAgentModelPolicyReferences()).toEqual([]);
    await expect(
      service.applyPreset(
        GLOBAL_SCOPE,
        "software_development",
        first.revision,
        true,
        false,
      ),
    ).resolves.toMatchObject({ presetId: "software_development" });

    const second = await service.previewPreset(GLOBAL_SCOPE, "quick_change");
    await expect(
      service.applyPreset(
        GLOBAL_SCOPE,
        "quick_change",
        second.revision,
        true,
        false,
      ),
    ).rejects.toMatchObject({ code: "OVERWRITE_CONFIRMATION_REQUIRED" });
    await expect(
      service.applyPreset(
        GLOBAL_SCOPE,
        "quick_change",
        second.revision,
        false,
        true,
      ),
    ).rejects.toMatchObject({ code: "PREVIEW_CONFIRMATION_REQUIRED" });
    await expect(
      service.applyPreset(
        GLOBAL_SCOPE,
        "quick_change",
        second.revision,
        true,
        true,
      ),
    ).resolves.toMatchObject({ presetId: "quick_change" });
  });

  it("derives exact tier-reference status from repository facts after restart", async () => {
    bindAllTiers(repository);
    const preview = await service.previewPreset(
      GLOBAL_SCOPE,
      "high_quality_review",
    );
    await service.applyPreset(
      GLOBAL_SCOPE,
      "high_quality_review",
      preview.revision,
      true,
      false,
    );
    const persistedPreview = await service.previewPreset(
      GLOBAL_SCOPE,
      "high_quality_review",
    );
    database.close();
    database = new AppDatabase(databasePath);
    repository = new ModelProviderRepository(database);
    rebuild();

    await expect(service.getPresetStatus(GLOBAL_SCOPE)).resolves.toEqual({
      kind: "preset",
      presetId: "high_quality_review",
    });
    const restartedPreview = await service.previewPreset(
      GLOBAL_SCOPE,
      "high_quality_review",
    );
    expect(restartedPreview.revision).toBe(persistedPreview.revision);
  });
});
