import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppDatabase,
  type ModelProviderDatabaseRow,
} from "../../database/Database";
import {
  ModelProviderRepository,
  type AgentModelPolicyRecord,
  type AgentModelPolicyReferenceRecord,
  type ModelTierBindingRecord,
  type ProjectModelPolicyReferenceRecord,
  type ProjectModelPolicyRecord,
  type TaskModelOverrideRecord,
} from "../ModelProviderRepository";
import {
  ModelProviderService,
  type CredentialStorePort,
  type CredentialCleanupJob,
  type StoredModelProvider,
  type StoredProviderModel,
} from "../ModelProviderService";
import type { ModelPolicyAgentType } from "../../../shared/types/modelProviders";
import type { PersistedModelPolicyReference } from "../../../shared/types/modelTiers";

const ROOT_PREFIX = "workbench-model-provider-repository-";
const CREDENTIAL_ONE = "safe-storage://v1/7de5fe22-e45c-4ae0-9904-618379303d0b";
const CREDENTIAL_TWO = "safe-storage://v1/a80a4be6-0e1f-4207-ac29-0db955b4c997";

function provider(
  overrides: Partial<StoredModelProvider> = {},
): StoredModelProvider {
  return {
    id: "provider-1",
    name: "MiMo",
    type: "anthropic-compatible",
    apiFormat: "anthropic-messages",
    runtimeType: "claude-code",
    baseUrl: "https://mimo.example/anthropic",
    credentialRef: CREDENTIAL_ONE,
    defaultModelId: "mimo-v2.5-pro",
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
      lastTestedAt: 2_000,
      lastErrorType: null,
      latencyMs: 42,
    },
    metadata: { label: "gateway" },
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

function model(
  overrides: Partial<StoredProviderModel> = {},
): StoredProviderModel {
  return {
    providerId: "provider-1",
    modelId: "mimo-v2.5-pro",
    displayName: "MiMo Pro",
    source: "manual",
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

function cleanup(
  overrides: Partial<CredentialCleanupJob> = {},
): CredentialCleanupJob {
  return {
    id: "cleanup-1",
    providerId: null,
    credentialRef: CREDENTIAL_TWO,
    attempts: 0,
    nextAttemptAt: null,
    lastAttemptAt: null,
    lastErrorType: null,
    createdAt: 2_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

function presetReferences(): Record<
  ModelPolicyAgentType,
  PersistedModelPolicyReference
> {
  return {
    planner: { kind: "tier", tier: "high_quality" },
    coder: { kind: "tier", tier: "balanced" },
    tester: { kind: "tier", tier: "fast" },
    reviewer: { kind: "tier", tier: "high_quality" },
    fixer: { kind: "tier", tier: "balanced" },
  };
}

describe("ModelProviderRepository", () => {
  let root: string;
  let databasePath: string;
  let database: AppDatabase;
  let repository: ModelProviderRepository;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), ROOT_PREFIX));
    databasePath = path.join(root, "workbench.sqlite");
    database = new AppDatabase(databasePath);
    repository = new ModelProviderRepository(database);
  });

  afterEach(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("creates and reads a Provider with trusted fields intact", () => {
    repository.createProvider(provider(), [model()]);
    expect(repository.getProvider("provider-1")).toEqual(provider());
    expect(repository.listModels("provider-1")).toEqual([model()]);
  });

  it("rejects the reserved synthetic Provider namespace at the persistence boundary", () => {
    const reservedId = `synthetic:v1:environment:${"a".repeat(64)}`;

    expect(() =>
      repository.createProvider(
        provider({ id: reservedId, defaultModelId: "env-model" }),
        [model({ providerId: reservedId, modelId: "env-model" })],
      ),
    ).toThrow(/reserved/iu);
    expect(repository.getProvider(reservedId)).toBeNull();
  });

  it("persists across a database restart", () => {
    repository.createProvider(provider(), [model()]);
    database.close();
    database = new AppDatabase(databasePath);
    repository = new ModelProviderRepository(database);
    expect(repository.getProvider("provider-1")).toEqual(provider());
  });

  it("derives a legacy management-only default as needs-reconfiguration after restart without fallback", () => {
    const deepSeek = provider({
      id: "provider-deepseek",
      name: "DeepSeek",
      type: "openai-compatible",
      apiFormat: "openai-chat-completions",
      runtimeType: "none",
      credentialRef: CREDENTIAL_ONE,
      defaultModelId: "deepseek-chat",
      isDefault: true,
      capabilities: {
        supportsClaudeCode: false,
        supportsAgentWorkflow: false,
        supportsTools: true,
        supportsMCP: false,
        supportsStreaming: true,
        supportsVision: false,
      },
    });
    const anthropic = provider({
      id: "provider-anthropic",
      credentialRef: CREDENTIAL_TWO,
      isDefault: false,
    });
    repository.createProvider(deepSeek, [model({
      providerId: deepSeek.id,
      modelId: deepSeek.defaultModelId as string,
    })]);
    repository.createProvider(anthropic, [model({ providerId: anthropic.id })]);

    database.close();
    database = new AppDatabase(databasePath);
    repository = new ModelProviderRepository(database);
    const credentialStore: CredentialStorePort = {
      create: vi.fn(), read: vi.fn(), delete: vi.fn(),
    };
    const service = new ModelProviderService({
      persistence: repository,
      credentialStore,
      connectionTester: { test: vi.fn() },
    });

    expect(service.getProvider(deepSeek.id)).toMatchObject({
      isDefault: true,
      runtimeType: "none",
      agentModelStatus: "needs_reconfiguration",
    });
    expect(repository.getDefaultProvider()?.id).toBe(deepSeek.id);
    expect(repository.getProvider(deepSeek.id)?.credentialRef).toBe(CREDENTIAL_ONE);
    expect(repository.getProvider(anthropic.id)?.isDefault).toBe(false);
  });

  it("returns deterministic paginated pages and filters enabled state", () => {
    repository.createProvider(
      provider({ id: "old", defaultModelId: "old-model", updatedAt: 2_000 }),
      [model({ providerId: "old", modelId: "old-model" })],
    );
    repository.createProvider(
      provider({
        id: "new",
        defaultModelId: "new-model",
        updatedAt: 3_000,
        enabled: false,
        credentialRef: CREDENTIAL_TWO,
      }),
      [model({ providerId: "new", modelId: "new-model", updatedAt: 3_000 })],
    );
    expect(repository.listProviders({ limit: 1, offset: 0 }).items[0].id).toBe(
      "old",
    );
    expect(repository.listProviders({ limit: 5, offset: 0 }).total).toBe(2);
    expect(
      repository.listProviders({ limit: 5, offset: 0, enabled: false }).items,
    ).toHaveLength(1);
    expect(
      repository.listProviders({ limit: 5, offset: 0, enabled: false }).items[0]
        .id,
    ).toBe("new");
  });

  it("keeps a 1,000+ Provider history paginated with a bounded page query", () => {
    for (let index = 0; index < 1_005; index += 1) {
      const id = `provider-${index.toString().padStart(4, "0")}`;
      const modelId = `model-${index}`;
      repository.createProvider(
        provider({
          id,
          name: `Provider ${index}`,
          defaultModelId: modelId,
          createdAt: 1_000 + index,
          updatedAt: 2_000 + index,
        }),
        [
          model({
            providerId: id,
            modelId,
            createdAt: 1_000 + index,
            updatedAt: 2_000 + index,
          }),
        ],
      );
    }

    const startedAt = performance.now();
    const page = repository.listProviders({ limit: 25, offset: 975 });
    const elapsedMs = performance.now() - startedAt;

    expect(page.total).toBe(1_005);
    expect(page.items).toHaveLength(25);
    expect(elapsedMs).toBeLessThan(250);
  }, 20_000);

  it("returns null and an empty model list for unknown identities", () => {
    expect(repository.getProvider("missing")).toBeNull();
    expect(repository.listModels("missing")).toEqual([]);
  });

  it("updates metadata, health, capabilities, models, and name transactionally", () => {
    repository.createProvider(provider(), [model()]);
    const updated = provider({
      name: "MiMo Updated",
      capabilities: { ...provider().capabilities, supportsVision: true },
      health: {
        state: "error",
        lastTestedAt: 3_000,
        lastErrorType: "timeout",
        latencyMs: 9_999,
      },
      metadata: { quality: "high" },
      updatedAt: 3_000,
    });
    repository.updateProvider(updated, [
      model({ updatedAt: 3_000 }),
      model({
        modelId: "mimo-fast",
        displayName: null,
        source: "discovered",
        updatedAt: 3_000,
      }),
    ], provider());
    expect(repository.getProvider("provider-1")).toEqual(updated);
    expect(
      repository.listModels("provider-1").map((entry) => entry.modelId),
    ).toEqual(["mimo-fast", "mimo-v2.5-pro"]);
  });

  it.each([
    ["name", { name: "Concurrent name" }],
    ["default model", { default_model_id: null }],
    ["capabilities", { supports_vision: 1 }],
    ["origin", { base_url: "https://concurrent.example/tenant-b" }],
    ["credential", { credential_ref: CREDENTIAL_TWO }],
  ] satisfies Array<[string, Partial<ModelProviderDatabaseRow>]>)
  ("atomically rejects a same-timestamp stale update after a concurrent %s change", (_field, patch) => {
    const expected = provider();
    repository.createProvider(expected, [model()]);
    const current = database.getModelProviderRow(expected.id);
    expect(current).not.toBeNull();
    database.updateModelProviderRow({ ...current as ModelProviderDatabaseRow, ...patch });

    let staleError: unknown;
    try {
      repository.updateProvider(
        provider({ name: "Stale write", updatedAt: 3_000 }),
        [model({ modelId: "stale-model", source: "discovered", updatedAt: 3_000 })],
        expected,
        cleanup({ credentialRef: CREDENTIAL_ONE }),
      );
    } catch (error) {
      staleError = error;
    }

    expect(staleError).toMatchObject({ code: "PROVIDER_STALE" });
    expect(repository.getProvider(expected.id)).toMatchObject(
      patch.name ? { name: patch.name } :
        patch.default_model_id === null ? { defaultModelId: null } :
          patch.supports_vision === 1 ? { capabilities: expect.objectContaining({ supportsVision: true }) } :
            patch.base_url ? { baseUrl: patch.base_url } :
              { credentialRef: patch.credential_ref },
    );
    expect(repository.listModels(expected.id)).toEqual([model()]);
    expect(repository.listCredentialCleanupJobs()).toEqual([]);
  });

  it("accepts a validation snapshot when the persisted Provider is unchanged", () => {
    const expected = provider();
    repository.createProvider(expected, [model()]);
    const next = provider({ name: "Current write", updatedAt: 3_000 });

    repository.updateProvider(next, [model({ updatedAt: 3_000 })], expected);

    expect(repository.getProvider(expected.id)).toEqual(next);
  });

  it("rolls back Provider creation when a model violates a constraint", () => {
    expect(() =>
      repository.createProvider(provider(), [model({ modelId: "" })]),
    ).toThrow();
    expect(repository.getProvider("provider-1")).toBeNull();
  });

  it("rejects a model that belongs to another Provider in the same create call", () => {
    expect(() =>
      repository.createProvider(provider(), [
        model({ providerId: "provider-other" }),
      ]),
    ).toThrow(/Provider/iu);
    expect(repository.getProvider("provider-1")).toBeNull();
  });

  it("updates health without writing raw connection errors", () => {
    repository.createProvider(provider(), [model()]);
    repository.updateProviderHealth("provider-1", {
      state: "error",
      lastTestedAt: 4_000,
      lastErrorType: "invalid_key",
      latencyMs: 12,
    });
    expect(repository.getProvider("provider-1")?.health).toEqual({
      state: "error",
      lastTestedAt: 4_000,
      lastErrorType: "invalid_key",
      latencyMs: 12,
    });
  });

  it("upserts discovered models while preserving manual model source and creation time", () => {
    repository.createProvider(provider(), [model()]);
    repository.upsertModels("provider-1", [
      model({ source: "discovered", createdAt: 3_000, updatedAt: 3_000 }),
      model({
        modelId: "remote",
        displayName: null,
        source: "discovered",
        createdAt: 3_000,
        updatedAt: 3_000,
      }),
    ]);
    expect(repository.listModels("provider-1")).toEqual([
      model({
        modelId: "remote",
        displayName: null,
        source: "discovered",
        createdAt: 3_000,
        updatedAt: 3_000,
      }),
      model({ updatedAt: 3_000 }),
    ]);
  });

  it("synchronizes discovered models while preserving manual and default entries", () => {
    repository.createProvider(provider(), [
      model({ source: "discovered" }),
      model({ modelId: "manual-model", source: "manual" }),
      model({
        modelId: "stale-model",
        displayName: null,
        source: "discovered",
      }),
      model({
        modelId: "current-model",
        displayName: null,
        source: "discovered",
      }),
    ]);

    repository.synchronizeDiscoveredModels("provider-1", [
      model({
        modelId: "current-model",
        displayName: "Current",
        source: "discovered",
        createdAt: 3_000,
        updatedAt: 3_000,
      }),
      model({
        modelId: "new-model",
        displayName: null,
        source: "discovered",
        createdAt: 3_000,
        updatedAt: 3_000,
      }),
    ]);

    expect(
      repository
        .listModels("provider-1")
        .map(({ modelId, source }) => [modelId, source]),
    ).toEqual([
      ["current-model", "discovered"],
      ["mimo-v2.5-pro", "discovered"],
      ["new-model", "discovered"],
      ["manual-model", "manual"],
    ]);
  });

  it("retains stale discovered models that are referenced by any model policy or task override", () => {
    database.createProject("project-1", "One", path.join(root, "one"));
    database.createSession("task-1", "project-1", "Task");
    database.ensureTask("task-1", "project-1");
    repository.createProvider(provider(), [
      model(),
      model({
        modelId: "agent-model",
        displayName: null,
        source: "discovered",
      }),
      model({
        modelId: "project-model",
        displayName: null,
        source: "discovered",
      }),
      model({ modelId: "task-model", displayName: null, source: "discovered" }),
      model({
        modelId: "unreferenced-model",
        displayName: null,
        source: "discovered",
      }),
    ]);
    repository.setAgentModelPolicy({
      agentType: "planner",
      providerId: "provider-1",
      modelId: "agent-model",
      quality: null,
      speed: null,
      cost: null,
      createdAt: 3_000,
      updatedAt: 3_000,
    });
    repository.setProjectModelPolicy({
      projectId: "project-1",
      agentType: "default",
      providerId: "provider-1",
      modelId: "project-model",
      createdAt: 3_000,
      updatedAt: 3_000,
    });
    repository.setTaskModelOverride({
      taskId: "task-1",
      providerId: "provider-1",
      modelId: "task-model",
      createdAt: 3_000,
      updatedAt: 3_000,
    });

    repository.synchronizeDiscoveredModels("provider-1", []);

    expect(
      repository.listModels("provider-1").map((entry) => entry.modelId),
    ).toEqual(["agent-model", "project-model", "task-model", "mimo-v2.5-pro"]);
    expect(repository.getAgentModelPolicy("planner")?.modelId).toBe(
      "agent-model",
    );
    expect(
      repository.getProjectModelPolicy("project-1", "default")?.modelId,
    ).toBe("project-model");
    expect(repository.getTaskModelOverride("task-1")?.modelId).toBe(
      "task-model",
    );
  });

  it("sets exactly one enabled global default", () => {
    repository.createProvider(provider(), [model()]);
    repository.createProvider(
      provider({
        id: "provider-2",
        defaultModelId: "model-2",
        credentialRef: CREDENTIAL_TWO,
      }),
      [model({ providerId: "provider-2", modelId: "model-2" })],
    );
    repository.setDefaultProvider("provider-1", 3_000);
    repository.setDefaultProvider("provider-2", 4_000);
    expect(repository.getProvider("provider-1")?.isDefault).toBe(false);
    expect(repository.getProvider("provider-2")?.isDefault).toBe(true);
  });

  it("reads only an enabled global default Provider", () => {
    repository.createProvider(provider({ enabled: false, isDefault: true }), [
      model(),
    ]);
    expect(repository.getDefaultProvider()).toBeNull();

    repository.createProvider(
      provider({
        id: "provider-2",
        defaultModelId: "model-2",
        credentialRef: CREDENTIAL_TWO,
      }),
      [model({ providerId: "provider-2", modelId: "model-2" })],
    );
    repository.setDefaultProvider("provider-2", 3_000);
    expect(repository.getDefaultProvider()?.id).toBe("provider-2");
  });

  it("rejects setting a disabled Provider as default", () => {
    repository.createProvider(provider({ enabled: false }), [model()]);
    expect(() => repository.setDefaultProvider("provider-1", 3_000)).toThrow(
      /enabled/iu,
    );
  });

  it("toggles Provider enabled state and clears default when disabling", () => {
    repository.createProvider(provider({ isDefault: true }), [model()]);
    repository.setProviderEnabled("provider-1", false, 3_000);
    expect(repository.getProvider("provider-1")).toMatchObject({
      enabled: false,
      isDefault: false,
      credentialRef: CREDENTIAL_ONE,
      updatedAt: 3_000,
    });
    expect(repository.listModels("provider-1")).toEqual([model()]);

    repository.setProviderEnabled("provider-1", true, 4_000);
    expect(repository.getProvider("provider-1")).toMatchObject({
      enabled: true,
      isDefault: false,
      updatedAt: 4_000,
    });
  });

  it("rejects toggling an unknown Provider without changing other rows", () => {
    repository.createProvider(provider(), [model()]);
    expect(() =>
      repository.setProviderEnabled("missing", false, 3_000),
    ).toThrow(/not found/iu);
    expect(repository.getProvider("provider-1")).toEqual(provider());
  });

  it("commits an old-credential cleanup tombstone with Provider update", () => {
    repository.createProvider(provider(), [model()]);
    const job = cleanup();
    repository.updateProvider(
      provider({ credentialRef: CREDENTIAL_TWO, updatedAt: 3_000 }),
      [model()],
      provider(),
      job,
    );
    expect(repository.listCredentialCleanupJobs()).toEqual([job]);
    expect(repository.getProvider("provider-1")?.credentialRef).toBe(
      CREDENTIAL_TWO,
    );
  });

  it("rolls back Provider update if its cleanup tombstone conflicts", () => {
    repository.createProvider(provider(), [model()]);
    const job = cleanup();
    repository.enqueueCredentialCleanup(job);
    expect(() =>
      repository.updateProvider(
        provider({
          name: "should rollback",
          credentialRef: CREDENTIAL_TWO,
          updatedAt: 3_000,
        }),
        [model()],
        provider(),
        { ...job, id: "other-job" },
      ),
    ).toThrow();
    expect(repository.getProvider("provider-1")?.name).toBe("MiMo");
  });

  it("begins deletion by disabling the Provider and persisting a tombstone", () => {
    repository.createProvider(provider(), [model()]);
    const job = cleanup({
      providerId: "provider-1",
      credentialRef: CREDENTIAL_ONE,
    });
    repository.beginProviderDeletion(job);
    expect(repository.getProvider("provider-1")?.enabled).toBe(false);
    expect(repository.listCredentialCleanupJobs()).toEqual([job]);
  });

  it("completes deletion only for a Provider-bound tombstone", () => {
    repository.createProvider(provider(), [model()]);
    const job = cleanup({
      providerId: "provider-1",
      credentialRef: CREDENTIAL_ONE,
    });
    repository.beginProviderDeletion(job);
    repository.completeCredentialCleanup(job.id, "provider-1");
    expect(repository.getProvider("provider-1")).toBeNull();
    expect(repository.listCredentialCleanupJobs()).toEqual([]);
  });

  it("completes an orphan cleanup without deleting an active Provider", () => {
    repository.createProvider(provider(), [model()]);
    const job = cleanup();
    repository.enqueueCredentialCleanup(job);
    repository.completeCredentialCleanup(job.id, null);
    expect(repository.getProvider("provider-1")).not.toBeNull();
    expect(repository.listCredentialCleanupJobs()).toEqual([]);
  });

  it("records bounded retry metadata for a failed cleanup", () => {
    const job = cleanup();
    repository.enqueueCredentialCleanup(job);
    repository.markCredentialCleanupFailed("cleanup-1", "io", 4_000);
    expect(repository.listCredentialCleanupJobs()[0]).toEqual({
      ...job,
      attempts: 1,
      nextAttemptAt: 9_000,
      lastAttemptAt: 4_000,
      lastErrorType: "io",
      updatedAt: 4_000,
    });
  });

  it("does not complete a cleanup using a mismatched Provider identity", () => {
    repository.createProvider(provider(), [model()]);
    const job = cleanup({
      providerId: "provider-1",
      credentialRef: CREDENTIAL_ONE,
    });
    repository.beginProviderDeletion(job);
    expect(() =>
      repository.completeCredentialCleanup(job.id, "provider-other"),
    ).toThrow(/identity/iu);
    expect(repository.getProvider("provider-1")).not.toBeNull();
  });

  it("stores and reads global Agent policy annotations without routing them", () => {
    repository.createProvider(provider(), [model()]);
    const policy: AgentModelPolicyRecord = {
      agentType: "planner",
      providerId: "provider-1",
      modelId: "mimo-v2.5-pro",
      quality: "high",
      speed: "medium",
      cost: "low",
      createdAt: 3_000,
      updatedAt: 3_000,
    };
    repository.setAgentModelPolicy(policy);
    expect(repository.getAgentModelPolicy("planner")).toEqual(policy);
    expect(repository.listAgentModelPolicies()).toEqual([policy]);
    repository.deleteAgentModelPolicy("planner");
    expect(repository.getAgentModelPolicy("planner")).toBeNull();
  });

  it("stores project role/default policy and isolates projects", () => {
    database.createProject("project-1", "One", path.join(root, "one"));
    database.createProject("project-2", "Two", path.join(root, "two"));
    repository.createProvider(provider(), [model()]);
    const policy: ProjectModelPolicyRecord = {
      projectId: "project-1",
      agentType: "default",
      providerId: "provider-1",
      modelId: "mimo-v2.5-pro",
      createdAt: 3_000,
      updatedAt: 3_000,
    };
    repository.setProjectModelPolicy(policy);
    expect(repository.getProjectModelPolicy("project-1", "default")).toEqual(
      policy,
    );
    expect(repository.listProjectModelPolicies("project-2")).toEqual([]);
  });

  it("stores a task-only override and cascades it when the task is deleted", () => {
    database.createProject("project-1", "One", path.join(root, "one"));
    database.createSession("task-1", "project-1", "Task");
    database.ensureTask("task-1", "project-1");
    repository.createProvider(provider(), [model()]);
    const override: TaskModelOverrideRecord = {
      taskId: "task-1",
      providerId: "provider-1",
      modelId: "mimo-v2.5-pro",
      createdAt: 3_000,
      updatedAt: 3_000,
    };
    repository.setTaskModelOverride(override);
    expect(repository.getTaskModelOverride("task-1")).toEqual(override);
    database.deleteSession("task-1");
    expect(repository.getTaskModelOverride("task-1")).toBeNull();
  });

  it("persists global and project tier bindings, including explicit unbound project rows", () => {
    database.createProject("project-1", "One", path.join(root, "one"));
    const globalBinding: ModelTierBindingRecord = {
      tier: "high_quality",
      providerId: "provider-1",
      modelId: "shared-model",
      displayName: "High quality",
      quality: "high",
      speed: "medium",
      cost: "high",
      updatedAt: 3_000,
    };
    repository.upsertModelTierBinding(globalBinding);
    repository.upsertProjectModelTierBinding({
      projectId: "project-1",
      tier: "balanced",
      providerId: null,
      modelId: null,
      displayName: "Balanced",
      quality: "medium",
      speed: "medium",
      cost: "medium",
      updatedAt: 3_001,
    });

    expect(repository.getModelTierBinding("high_quality")).toEqual(
      globalBinding,
    );
    expect(repository.listModelTierBindings()).toEqual([globalBinding]);
    expect(
      repository.getProjectModelTierBinding("project-1", "balanced"),
    ).toEqual({
      projectId: "project-1",
      tier: "balanced",
      providerId: null,
      modelId: null,
      displayName: "Balanced",
      quality: "medium",
      speed: "medium",
      cost: "medium",
      updatedAt: 3_001,
    });
    expect(
      repository.deleteProjectModelTierBinding("project-1", "balanced"),
    ).toBe(true);
    expect(repository.deleteModelTierBinding("high_quality")).toBe(true);
  });

  it("allows one model identity to back all three tiers and persists it across restart", () => {
    for (const [index, tier] of [
      "high_quality",
      "balanced",
      "fast",
    ].entries()) {
      repository.upsertModelTierBinding({
        tier: tier as ModelTierBindingRecord["tier"],
        providerId: "provider-1",
        modelId: "same-model",
        displayName: null,
        quality: null,
        speed: null,
        cost: null,
        updatedAt: 4_000 + index,
      });
    }
    database.close();
    database = new AppDatabase(databasePath);
    repository = new ModelProviderRepository(database);

    expect(
      repository
        .listModelTierBindings()
        .map(({ tier, providerId, modelId }) => ({
          tier,
          providerId,
          modelId,
        })),
    ).toEqual([
      { tier: "balanced", providerId: "provider-1", modelId: "same-model" },
      { tier: "fast", providerId: "provider-1", modelId: "same-model" },
      { tier: "high_quality", providerId: "provider-1", modelId: "same-model" },
    ]);
  });

  it("atomically binds one trusted model to all three global tiers while preserving notes", () => {
    repository.upsertModelTierBinding({
      tier: "balanced",
      providerId: null,
      modelId: null,
      displayName: "Balanced",
      quality: "medium",
      speed: "high",
      cost: "low",
      updatedAt: 1_000,
    });

    const rows = repository.bindAllModelTiersAtomically({
      scope: { type: "global" },
      now: 4_000,
      deriveCandidateInTransaction: () => ({
        providerId: "provider-1",
        modelId: "same-model",
      }),
    });

    expect(rows.map(({ tier, providerId, modelId }) => ({ tier, providerId, modelId })))
      .toEqual([
        { tier: "high_quality", providerId: "provider-1", modelId: "same-model" },
        { tier: "balanced", providerId: "provider-1", modelId: "same-model" },
        { tier: "fast", providerId: "provider-1", modelId: "same-model" },
      ]);
    expect(repository.getModelTierBinding("balanced")).toMatchObject({
      displayName: "Balanced",
      quality: "medium",
      speed: "high",
      cost: "low",
      updatedAt: 4_000,
    });
  });

  it("rolls back all three bind-all writes when the final tier write fails", () => {
    repository.upsertModelTierBinding({
      tier: "high_quality",
      providerId: "old-provider",
      modelId: "old-model",
      displayName: null,
      quality: null,
      speed: null,
      cost: null,
      updatedAt: 1_000,
    });
    const original = database.upsertModelTierBindingRow.bind(database);
    const write = vi.spyOn(database, "upsertModelTierBindingRow")
      .mockImplementation((row) => {
        if (row.tier === "fast") throw new Error("late raw database failure");
        original(row);
      });

    expect(() => repository.bindAllModelTiersAtomically({
      scope: { type: "global" },
      now: 4_000,
      deriveCandidateInTransaction: () => ({
        providerId: "provider-1",
        modelId: "same-model",
      }),
    })).toThrow();

    write.mockRestore();
    expect(repository.listModelTierBindings()).toEqual([{
      tier: "high_quality",
      providerId: "old-provider",
      modelId: "old-model",
      displayName: null,
      quality: null,
      speed: null,
      cost: null,
      updatedAt: 1_000,
    }]);
  });

  it("stores and reads direct and tier policy references without ambiguity", () => {
    database.createProject("project-1", "One", path.join(root, "one"));
    repository.createProvider(provider(), [model()]);
    const direct: AgentModelPolicyReferenceRecord = {
      agentType: "planner",
      reference: {
        kind: "model",
        providerId: "provider-1",
        modelId: "mimo-v2.5-pro",
      },
      quality: "high",
      speed: "medium",
      cost: "low",
      createdAt: 3_000,
      updatedAt: 3_000,
    };
    const tier: ProjectModelPolicyReferenceRecord = {
      projectId: "project-1",
      agentType: "reviewer",
      reference: { kind: "tier", tier: "high_quality" },
      createdAt: 3_001,
      updatedAt: 3_001,
    };

    repository.setAgentModelPolicyReference(direct);
    repository.setProjectModelPolicyReference(tier);

    expect(repository.getAgentModelPolicyReference("planner")).toEqual(direct);
    expect(repository.listAgentModelPolicyReferences()).toEqual([direct]);
    expect(
      repository.getProjectModelPolicyReference("project-1", "reviewer"),
    ).toEqual(tier);
    expect(repository.listProjectModelPolicyReferences("project-1")).toEqual([
      tier,
    ]);
  });

  it("atomically replaces all five global references while preserving creation times and notes", () => {
    repository.createProvider(provider(), [model()]);
    repository.setAgentModelPolicy({
      agentType: "planner",
      providerId: "provider-1",
      modelId: "mimo-v2.5-pro",
      quality: "high",
      speed: "low",
      cost: "medium",
      createdAt: 111,
      updatedAt: 222,
    });
    repository.applyAgentPolicyReferencesAtomically({
      scope: { type: "global" },
      now: 5_000,
      deriveReferencesInTransaction: () => presetReferences(),
    });

    expect(repository.getAgentModelPolicyReference("planner")).toEqual({
      agentType: "planner",
      reference: { kind: "tier", tier: "high_quality" },
      quality: "high",
      speed: "low",
      cost: "medium",
      createdAt: 111,
      updatedAt: 5_000,
    });
    expect(repository.listAgentModelPolicyReferences()).toHaveLength(5);
  });

  it("atomically replaces project roles without touching default and rolls back a late failure", () => {
    database.createProject("project-1", "One", path.join(root, "one"));
    repository.createProvider(provider(), [model()]);
    repository.setProjectModelPolicy({
      projectId: "project-1",
      agentType: "default",
      providerId: "provider-1",
      modelId: "mimo-v2.5-pro",
      createdAt: 100,
      updatedAt: 100,
    });
    repository.setProjectModelPolicyReference({
      projectId: "project-1",
      agentType: "planner",
      reference: { kind: "tier", tier: "fast" },
      createdAt: 200,
      updatedAt: 200,
    });

    expect(() =>
      repository.applyAgentPolicyReferencesAtomically({
        scope: { type: "project", projectId: "project-1" },
        now: 6_000,
        deriveReferencesInTransaction: () => ({
          ...presetReferences(),
          fixer: { kind: "tier", tier: "not-a-tier" as "fast" },
        }),
      }),
    ).toThrow(/constraint/i);

    expect(
      repository.getProjectModelPolicyReference("project-1", "planner"),
    ).toEqual({
      projectId: "project-1",
      agentType: "planner",
      reference: { kind: "tier", tier: "fast" },
      createdAt: 200,
      updatedAt: 200,
    });
    expect(
      repository.listProjectModelPolicyReferences("project-1"),
    ).toHaveLength(2);
    expect(
      repository.getProjectModelPolicy("project-1", "default"),
    ).toMatchObject({
      providerId: "provider-1",
      modelId: "mimo-v2.5-pro",
      createdAt: 100,
      updatedAt: 100,
    });
  });

  it("requires a synchronous derivation callback at runtime", () => {
    if (false) {
      // @ts-expect-error deriveReferencesInTransaction is required by the atomic API.
      repository.applyAgentPolicyReferencesAtomically({
        scope: { type: "global" },
        now: 7_000,
      });
      repository.applyAgentPolicyReferencesAtomically({
        scope: { type: "global" },
        now: 7_000,
        // @ts-expect-error a no-op callback cannot satisfy the derivation contract.
        deriveReferencesInTransaction: () => undefined,
      });
      repository.applyAgentPolicyReferencesAtomically({
        scope: { type: "global" },
        now: 7_000,
        deriveReferencesInTransaction: () => presetReferences(),
        // @ts-expect-error revision self-attestation is not a repository input.
        expectedRevision: "preview-revision",
      });
      repository.applyAgentPolicyReferencesAtomically({
        scope: { type: "global" },
        now: 7_000,
        // @ts-expect-error the callback returns references only, never a claimed revision.
        deriveReferencesInTransaction: () => ({
          currentRevision: "preview-revision",
          references: presetReferences(),
        }),
      });
    }
    expect(() =>
      repository.applyAgentPolicyReferencesAtomically({
        scope: { type: "global" },
        now: 7_000,
      } as never),
    ).toThrow(/derivation/iu);
    expect(() =>
      repository.applyAgentPolicyReferencesAtomically({
        scope: { type: "global" },
        now: 7_000,
        deriveReferencesInTransaction: (() => undefined) as never,
      }),
    ).toThrow(/derivation/iu);
    expect(() =>
      repository.applyAgentPolicyReferencesAtomically({
        scope: { type: "global" },
        now: 7_000,
        deriveReferencesInTransaction: (() => ({
          currentRevision: "preview-revision",
          references: presetReferences(),
        })) as never,
      }),
    ).toThrow(/derivation/iu);
    expect(repository.listAgentModelPolicyReferences()).toEqual([]);
  });

  it("runs derivation inside the transaction and rolls back its writes when it throws", () => {
    expect(() =>
      repository.applyAgentPolicyReferencesAtomically({
        scope: { type: "global" },
        now: 7_000,
        deriveReferencesInTransaction: () => {
          repository.setAgentModelPolicyReference({
            agentType: "planner",
            reference: { kind: "tier", tier: "fast" },
            quality: null,
            speed: null,
            cost: null,
            createdAt: 1,
            updatedAt: 1,
          });
          throw new Error("derive failed");
        },
      }),
    ).toThrow("derive failed");
    expect(repository.listAgentModelPolicyReferences()).toEqual([]);
  });

  it("writes a repository-owned reference snapshot immune to callback object mutation", async () => {
    const references = presetReferences();
    repository.applyAgentPolicyReferencesAtomically({
      scope: { type: "global" },
      now: 7_000,
      deriveReferencesInTransaction: () => references,
    });
    references.planner = {
      kind: "model",
      providerId: "provider-1",
      modelId: "mimo-v2.5-pro",
    };
    await Promise.resolve();

    expect(repository.getAgentModelPolicyReference("fixer")?.reference).toEqual(
      {
        kind: "tier",
        tier: "balanced",
      },
    );
    expect(
      repository.getAgentModelPolicyReference("planner")?.reference,
    ).toEqual({
      kind: "tier",
      tier: "high_quality",
    });
  });

  it("uses a repository-owned scope snapshot after the callback mutates its input", () => {
    database.createProject("project-1", "One", path.join(root, "one"));
    database.createProject("project-2", "Two", path.join(root, "two"));
    const scope = { type: "project", projectId: "project-1" } as const;

    repository.applyAgentPolicyReferencesAtomically({
      scope,
      now: 8_000,
      deriveReferencesInTransaction: () => {
        (scope as { projectId: string }).projectId = "project-2";
        return presetReferences();
      },
    });

    expect(
      repository.listProjectModelPolicyReferences("project-1"),
    ).toHaveLength(5);
    expect(repository.listProjectModelPolicyReferences("project-2")).toEqual(
      [],
    );
  });
});
