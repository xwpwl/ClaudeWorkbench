# Claude Workbench Phase 8.5 Product Experience & Beta Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a beta-ready first-run and settings experience with user-bound model tiers, atomic Agent templates, trusted runtime selection, restart persistence, and credential-safe diagnostics.

**Architecture:** Persist immutable logical tier keys and scoped user bindings in SQLite v7, keep role policies as either direct model references or tier references, and resolve the winning policy through the existing `ModelSelectionResolver`. Main-process services recompute Provider capabilities, installation health, synthetic-source fingerprints, and runtime eligibility; Renderer code receives safe projections only. Workflow creation freezes concrete selections, including execution source and tier provenance, so settings edits affect future calls only.

**Tech Stack:** Electron, React, TypeScript, Zod, SQLite/better-sqlite3, Vitest, Testing Library, existing `ClaudeCliAdapter`, `AgentRuntimeRegistry`, `FileMutationManager`, and production Electron acceptance automation.

## Global Constraints

- `ClaudeCliAdapter` remains the only implemented Agent Runtime; do not add an OpenAI Agent Runtime or protocol gateway.
- Never infer a tier from Provider name, model name, price, capability labels, or quality/speed/cost notes.
- Keep the exact selection priority: task override → project role policy → project default → global role policy → global default Provider → environment → Claude Code.
- Provider capability, runtime, health, model ownership, source, and installation status are recomputed in the main process.
- API keys, plaintext credentials, `credential_ref`, encrypted blobs, vault paths, child-process environment values, and raw URLs containing authentication material never enter Renderer DTOs, logs, events, or diagnostic ZIPs. The existing normalized Provider Base URL remains visible because Provider management explicitly requires it; validation must continue to reject URL credentials, query strings, and fragments before persistence/projection.
- Existing user changes and staged files are preserved. This repository has no safe initial commit boundary, so workers must not create commits; each task ends with focused tests and a scoped diff review.
- Every production behavior begins with a focused test that is run once to observe the intended failure.
- Use existing semantic CSS tokens, components, Lucide icons, and zh-CN/en-US typed dictionaries; do not introduce a new visual system.

---

### Task 1: Shared model-tier and preset contracts

**Files:**
- Create: `src/shared/types/modelTiers.ts`
- Create: `src/shared/types/__tests__/modelTiers.test.ts`
- Modify: `src/shared/types/modelProviders.ts`
- Modify: `src/shared/types/index.ts`
- Modify: `src/shared/types/ipc.ts`

**Interfaces:**
- Produces: `ModelTier`, `ModelTierBinding`, `ModelTierDisplayMetadata`, `ModelTierCandidatePublic`, `ModelTierResolutionPublic`, `AgentPresetId`, `AgentPresetPreview`, and strict request/response DTOs.
- Consumes: existing `AgentType`, `ProviderRuntimeType`, `ModelSelectionSource`, and Renderer-safe Provider/model projections.

- [x] **Step 1: Write failing contract tests**

```ts
expect(MODEL_TIERS).toEqual(['high_quality', 'balanced', 'fast']);
expect(AGENT_PRESETS.software_development.roles).toEqual({
  planner: 'high_quality', coder: 'balanced', tester: 'fast',
  reviewer: 'high_quality', fixer: 'balanced',
});
expect(AGENT_PRESETS.quick_change.roles).toEqual({
  planner: 'fast', coder: 'fast', tester: 'fast', reviewer: 'balanced', fixer: 'fast',
});
expect(AGENT_PRESETS.high_quality_review.roles).toEqual({
  planner: 'high_quality', coder: 'balanced', tester: 'balanced',
  reviewer: 'high_quality', fixer: 'high_quality',
});
expect(JSON.stringify(publicCandidate)).not.toMatch(/credential|secret|vault|api.?key/i);
```

- [x] **Step 2: Run the focused test and observe module/contract failures**

Run: `npx vitest run src/shared/types/__tests__/modelTiers.test.ts`

Expected: FAIL because the tier module and preset mappings do not exist.

- [x] **Step 3: Add immutable keys, mappings, and safe DTOs**

```ts
export const MODEL_TIERS = ['high_quality', 'balanced', 'fast'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
export const AGENT_PRESETS = {
  software_development: { roles: { planner: 'high_quality', coder: 'balanced', tester: 'fast', reviewer: 'high_quality', fixer: 'balanced' } },
  quick_change: { roles: { planner: 'fast', coder: 'fast', tester: 'fast', reviewer: 'balanced', fixer: 'fast' } },
  high_quality_review: { roles: { planner: 'high_quality', coder: 'balanced', tester: 'balanced', reviewer: 'high_quality', fixer: 'high_quality' } },
} as const;
```

Define invalid reasons as a closed union and define `executionSource: 'database_provider' | 'environment' | 'claude_code'` separately from policy source.

- [x] **Step 4: Run contract tests, typecheck, and scoped lint**

Run: `npx vitest run src/shared/types/__tests__/modelTiers.test.ts src/shared/types/__tests__/modelProviders.test.ts`

Run: `npm run typecheck`

Run: `npx eslint src/shared/types/modelTiers.ts src/shared/types/modelProviders.ts src/shared/types/ipc.ts`

- [x] **Step 5: Review the scoped diff**

Run: `git diff --check -- src/shared/types`

Verify no Provider/model names are present in template constants.

---

### Task 2: SQLite v7 migration and tier persistence

**Files:**
- Modify: `src/main/database/Database.ts`
- Create: `src/main/database/__tests__/ModelTierMigration.test.ts`
- Modify: `src/main/database/__tests__/Migration.test.ts`
- Modify: migration tests that assert the current/future schema version
- Modify: `src/main/model-providers/ModelProviderRepository.ts`
- Modify: `src/main/model-providers/__tests__/ModelProviderRepository.test.ts`

**Interfaces:**
- Produces: v7 schema, `get/upsert/deleteModelTierBinding`, project equivalents, policy-reference CRUD, and `applyAgentPolicyReferencesAtomically`.
- Consumes: `ModelTier`, direct/tier policy unions, existing `runInTransaction()`, projects, Providers, and models.

- [x] **Step 1: Write failing migration and repository tests**

```ts
expect(db.pragma('user_version', { simple: true })).toBe(7);
expect(() => insertTier({ providerId: 'bad\0id', modelId: 'm' })).toThrow();
expect(() => insertProjectDefaultWithTier()).toThrow();
expect(upgradedPolicy).toMatchObject({ tier: null, providerId: oldProvider, modelId: oldModel });
expect(deletedProviderTier).toMatchObject({ providerId: oldProvider, validity: 'unresolved' });
```

Add rollback injection, exact index/FK checks, v6 data-copy checks, nullable composite FK checks, one-model-for-three-tiers persistence, and restart tests.

- [x] **Step 2: Run focused tests and observe schema-version/table failures**

Run: `npx vitest run src/main/database/__tests__/ModelTierMigration.test.ts src/main/model-providers/__tests__/ModelProviderRepository.test.ts`

Expected: FAIL at schema 6 and missing tier/policy-reference methods.

- [x] **Step 3: Implement v7 inside the existing migration transaction**

Create `model_tier_bindings` and `project_model_tier_bindings` with immutable keys, paired-null binding checks, bounded trimmed NUL-free IDs, bounded display metadata, nonnegative integer timestamps, and project cascade only. Rebuild both policy tables so exactly one of direct model or tier is present; enforce project `default` as direct-only in SQL; restore all prior indexes and composite foreign keys.

- [x] **Step 4: Add repository methods without exposing raw database handles**

```ts
type PolicyReference =
  | { kind: 'model'; providerId: string; modelId: string }
  | { kind: 'tier'; tier: ModelTier };

applyAgentPolicyReferencesAtomically(input: {
  scope: ModelTierScope;
  deriveReferencesInTransaction: () => Readonly<Record<AgentRole, PolicyReference>>;
  now: number;
}): void;
```

The repository owns transactionality and immutable reference copying only. `AgentPresetService` recomputes and compares `expectedRevision` inside `deriveReferencesInTransaction` before deriving the references; the repository API does not claim to validate a caller-supplied revision. Preserve `created_at` and existing display notes while replacing references and `updated_at`.

- [x] **Step 5: Run database suites and integrity checks**

Run: `npx vitest run src/main/database/__tests__ src/main/model-providers/__tests__/ModelProviderRepository.test.ts`

Run: `npm run typecheck`

Run: `git diff --check -- src/main/database src/main/model-providers/ModelProviderRepository.ts`

---

### Task 3: Trusted candidate construction and synthetic identity

**Files:**
- Create: `src/main/model-providers/ModelTierService.ts`
- Create: `src/main/model-providers/__tests__/ModelTierService.test.ts`
- Modify: `src/main/model-providers/ProviderCapabilityResolver.ts`
- Modify: `src/main/model-providers/AgentRuntimeRegistry.ts`
- Modify: `src/main/model-providers/ModelSelectionResolver.ts`

**Interfaces:**
- Produces: `listCandidates(scope)`, `getBindings(scope)`, `setBinding(input)`, `clearProjectBinding(projectId,tier)`, `resolveTier(scope,tier)`, and versioned non-secret synthetic IDs.
- Consumes: repository, runtime registry, capability resolver, Provider health, effective environment/Claude selection, and Claude installation status.

- [x] **Step 1: Write failing security and validity tests**

```ts
expect(await service.listCandidates()).not.toContainEqual(expect.objectContaining({ providerId: deepSeekId }));
await expect(service.setBinding(forgedOpenAiCapabilityInput)).rejects.toMatchObject({ code: 'TIER_CANDIDATE_INVALID' });
expect(await service.listCandidates()).toContainEqual(expect.objectContaining({ providerId: mimoId, runtimeType: 'claude-code' }));
expect(fingerprintInput).not.toContain(apiKey);
expect(await service.resolveTier(projectScope, 'fast')).toMatchObject({ source: 'project' });
```

Cover disabled, deleted, unconfigured, failed-health, missing-model, runtime mismatch, registry rejection, unavailable Claude CLI, synthetic source change, explicit project unbound row, and global fallback only when the project row is absent.

- [x] **Step 2: Run focused tests and observe missing service failures**

Run: `npx vitest run src/main/model-providers/__tests__/ModelTierService.test.ts`

- [x] **Step 3: Implement candidate recomputation and binding validation**

Use `ProviderCapabilityResolver.resolve()` and `AgentRuntimeRegistry.assertRunnable(descriptor, 'agent-workflow')` for every application Provider. Require enabled, configured, `health.state === 'connected'`, `lastTestedAt`, model ownership, `runtimeType === 'claude-code'`, `supportsClaudeCode`, and `supportsAgentWorkflow`.

Synthetic IDs use `synthetic:v1:<kind>:<64 lowercase hex HMAC-SHA-256>`. A required main-process key provider reads a stable random key from the existing encrypted credential store; no default or per-process fallback is permitted. Canonical input is bounded and closed to source kind, normalized endpoint identity, and model, while API key, credential reference, vault identity, raw environment/error data, and volatile CLI version/path output are excluded.

- [x] **Step 4: Implement typed invalidation without fallback**

Return `needs_reconfiguration` with exact reasons. Preserve deleted Provider IDs as tombstones. A project row, including an explicitly unbound row, blocks global fallback until the user selects Follow global.

- [x] **Step 5: Run candidate, registry, capability, and repository suites**

Run: `npx vitest run src/main/model-providers/__tests__/ModelTierService.test.ts src/main/model-providers/__tests__/ProviderCapabilityResolver.test.ts src/main/model-providers/__tests__/AgentRuntimeRegistry.test.ts src/main/model-providers/__tests__/ModelSelectionResolver.test.ts`

Run: `npm run typecheck`

---

### Task 4: Preset preview, atomic application, and custom status

**Files:**
- Create: `src/main/model-providers/AgentPresetService.ts`
- Create: `src/main/model-providers/__tests__/AgentPresetService.test.ts`
- Modify: `src/main/model-providers/AgentModelPolicyService.ts`
- Modify: `src/main/model-providers/__tests__/AgentModelPolicyService.test.ts`

**Interfaces:**
- Produces: `previewPreset(scope,presetId)`, `applyPreset(scope,presetId,expectedRevision,previewConfirmed,overwriteConfirmed)`, and `getPresetStatus(scope)`.
- Consumes: `AGENT_PRESETS`, `ModelTierService`, repository atomic transaction, and existing role-policy notes.

- [x] **Step 1: Write failing preset tests**

```ts
expect(await service.preparePreset(globalScope, 'software_development')).toMatchObject({ step: 'bind_tiers' });
expect((await service.previewPreset(globalScope, 'software_development')).roles.coder.tier).toBe('balanced');
await expect(service.applyPreset(scope, preset, staleRevision, true)).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
expect(await service.getPresetStatus(scope)).toEqual({ kind: 'preset', presetId: 'software_development' });
```

Cover all three exact mappings, one candidate bound to all tiers, role-specific Tools/MCP rejection, failure on role five with zero partial writes, manual direct-model edit producing `custom`, note-only edit preserving mapping status, and reapply requiring confirmation.

- [x] **Step 2: Run focused tests and observe missing-service failures**

Run: `npx vitest run src/main/model-providers/__tests__/AgentPresetService.test.ts`

- [x] **Step 3: Implement bind → preview → confirm flow**

Create a stable revision from canonical tier rows, trusted resolved candidates, Provider health/capability facts, and current policy references. Never place secrets or raw errors in the revision input or preview DTO.

- [x] **Step 4: Apply all five roles in one explicit transaction**

Inside `AppDatabase.runInTransaction()`, re-read the same facts, compare revision, revalidate role requirements, then write five tier references. Project application leaves the project default untouched; global application leaves task and project policies untouched.

- [x] **Step 5: Run preset, policy, repository, and rollback tests**

Run: `npx vitest run src/main/model-providers/__tests__/AgentPresetService.test.ts src/main/model-providers/__tests__/AgentModelPolicyService.test.ts src/main/model-providers/__tests__/ModelProviderRepository.test.ts`

Run: `git diff --check -- src/main/model-providers`

---

### Task 5: Tier-aware model resolution and immutable Workflow snapshots

**Files:**
- Modify: `src/shared/types/modelProviders.ts`
- Modify: `src/shared/types/workflow.ts`
- Modify: `src/main/model-providers/ModelSelectionResolver.ts`
- Modify: `src/main/model-providers/ModelRunOptionsResolver.ts`
- Modify: `src/main/workflows/WorkflowInfrastructure.ts`
- Modify: `src/main/workflows/AgentWorkflowManager.ts`
- Modify: `src/main/tasks/TaskEventRecorder.ts`
- Modify: related tests in `src/main/model-providers/__tests__`, `src/main/workflows/__tests__`, and `src/main/tasks/__tests__`

**Interfaces:**
- Produces: concrete `ResolvedModelSelection` with policy `source`, trusted `executionSource`, optional `tier/tierSource`, and strict snapshot serialization.
- Consumes: tier resolver, existing priority chain, pinned `WorkflowModelSelectionPolicy`, and Claude run-option resolution.

- [x] **Step 1: Write failing precedence and freeze tests**

```ts
expect(taskOverride.source).toBe('task_override');
expect(projectTier.source).toBe('project_policy');
expect(projectTier.tierSource).toBe('project');
expect(syntheticGlobal.executionSource).toBe('environment');
expect(stageAfterTierEdit.modelId).toBe(stageBeforeTierEdit.modelId);
expect(nextWorkflowStage.modelId).toBe(newTierModelId);
```

Add restart round-trip and Stage-event assertions for Provider/model/runtime/source/tierSource, plus corruption/future-field fail-closed tests.

- [x] **Step 2: Run focused suites and observe union/serialization failures**

Run: `npx vitest run src/main/model-providers/__tests__/ModelSelectionResolver.test.ts src/main/model-providers/__tests__/ModelRunOptionsResolver.test.ts src/main/workflows/__tests__/WorkflowInfrastructure.test.ts src/main/workflows/__tests__/AgentWorkflowManager.test.ts`

- [x] **Step 3: Resolve tier references inside the winning policy layer**

Do not insert a tier layer into precedence. Dispatch credentials and Claude default-model behavior by `executionSource`, not policy `source` or Renderer data.

- [x] **Step 4: Preserve frozen provenance through restart and events**

Update strict allowlists and safe event projection for `tier`, `tierSource`, and `executionSource`. Pinned revalidation checks the same concrete identity and never reads the current tier row.

- [x] **Step 5: Run resolver, Workflow, recorder, typecheck, and lint gates**

Run: `npx vitest run src/main/model-providers/__tests__ src/main/workflows/__tests__ src/main/tasks/__tests__/TaskEventRecorder.workflow.test.ts`

Run: `npm run typecheck`

---

### Task 6: Strict tier and preset IPC/preload integration

**Files:**
- Modify: `src/main/ipc/model-providers.ts`
- Modify: `src/main/ipc/__tests__/model-providers.test.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/__tests__/index.test.ts`
- Modify: `src/shared/types/ipc.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Produces named methods for candidate listing, scoped binding reads/writes, Follow global, preset prepare/preview/apply/status, and safe change events.
- Consumes tier/preset services and existing trusted WebContents/main-frame/stable-URL checks.

- [x] **Step 1: Write failing IPC trust-boundary tests**

```ts
await expect(invokeFromUntrustedFrame('model-tier:list-candidates', {})).rejects.toThrow();
expect(service.setBinding).toHaveBeenCalledWith({ scope, tier, providerId, modelId });
expect(service.setBinding).not.toHaveBeenCalledWith(expect.objectContaining({ capabilities: expect.anything() }));
expect(JSON.stringify(rendererReply)).not.toMatch(/credential_ref|vault|api.?key|secret/i);
```

Cover unknown keys, oversized/control-character input, forged project ID, stale revision, missing confirmation, event payload redaction, and dispose behavior.

- [x] **Step 2: Run IPC/preload tests and observe missing-channel failures**

Run: `npx vitest run src/main/ipc/__tests__/model-providers.test.ts src/preload/__tests__/index.test.ts`

- [x] **Step 3: Add strict Zod handlers and named preload methods**

The Renderer sends only scope, tier, Provider/model IDs, preset ID, expected revision, confirmation, and display metadata. Main derives current project/task facts and revalidates all capabilities.

- [x] **Step 4: Wire services once in `main/index.ts`**

Reuse the existing repository, capability resolver, runtime registry, health service, selection resolver, and trusted renderer URL closure. Do not create a second runtime or selection stack.

- [x] **Step 5: Run all IPC/preload suites and inspect public payloads**

Run: `npx vitest run src/main/ipc/__tests__ src/preload/__tests__/index.test.ts`

Run: `npm run typecheck`

---

### Task 7: Agent tier wizard, preset preview, and accessible settings UI

**Files:**
- Create: `src/renderer/features/settings/AgentModelTierSettings.tsx`
- Create: `src/renderer/features/settings/AgentPresetSettings.tsx`
- Create: `src/renderer/features/settings/__tests__/AgentModelTierSettings.test.tsx`
- Create: `src/renderer/features/settings/__tests__/AgentPresetSettings.test.tsx`
- Modify: `src/renderer/features/settings/SettingsDialog.tsx`
- Modify: `src/renderer/styles/globals.css`
- Modify: `src/renderer/i18n/zh-CN.ts`
- Modify: `src/renderer/i18n/en-US.ts`

**Interfaces:**
- Produces the Agent settings category, three scoped tier cards, bind-all wizard, preview dialog, custom/reapply state, and actionable invalid state.
- Consumes preload tier/preset methods and existing semantic UI tokens/components.

- [ ] **Step 1: Write failing interaction tests**

```tsx
await user.click(screen.getByRole('button', { name: '应用软件开发模板' }));
expect(screen.getByRole('dialog', { name: '配置模型档位' })).toBeVisible();
await user.click(screen.getByRole('button', { name: '将此模型用于全部档位' }));
expect(screen.getByRole('dialog', { name: '应用模板预览' })).toHaveTextContent('Coder');
expect(screen.queryByText('DeepSeek')).not.toBeInTheDocument();
```

Cover already-bound direct preview, all five mappings, invalid rebind, project/global source labels, successful future-calls message, cancel with zero writes, custom state, and reapply warning.

- [ ] **Step 2: Run focused UI tests and observe missing-component failures**

Run: `npx vitest run src/renderer/features/settings/__tests__/AgentModelTierSettings.test.tsx src/renderer/features/settings/__tests__/AgentPresetSettings.test.tsx`

- [ ] **Step 3: Build the controlled bind and preview flow**

Use password-free safe DTOs, existing modal/focus patterns, Lucide icons, keyboard navigation, focus return, and localized names. Show Provider/model/runtime/health/last test/source and the exact disclaimer that tier names and notes are user-defined and not guaranteed capabilities.

- [ ] **Step 4: Integrate Agent settings without duplicating Provider logic**

Candidate refresh calls the tier service; Provider management opens the existing Model Provider Center. Manual direct-role editing uses the existing policy methods and immediately displays Custom.

- [ ] **Step 5: Run renderer settings/i18n suites and visual overflow checks**

Run: `npx vitest run src/renderer/features/settings/__tests__ src/renderer/i18n/__tests__/i18n.test.ts`

Run: `npm run build:renderer`

---

### Task 8: Project AI configuration, Provider cards, and Quick Switch polish

**Files:**
- Modify: `src/renderer/features/projects/ProjectSettingsDialog.tsx`
- Create: `src/renderer/features/projects/__tests__/ProjectAiConfiguration.test.tsx`
- Modify: `src/renderer/features/settings/ModelProviderCenter.tsx`
- Modify: `src/renderer/features/settings/modelProviderPresentation.ts`
- Modify: `src/renderer/features/models/ModelQuickSwitcher.tsx`
- Modify: `src/renderer/features/models/useModelProviderToolbar.ts`
- Modify: existing Provider/Quick Switch tests and styles/i18n dictionaries

**Interfaces:**
- Produces project tier overrides, template/source/effective-role summary, friendly Provider cards, and accessible switching feedback.
- Consumes existing project policy, Provider, model selection, permission, Git, Checkpoint, MCP, and Skills projections.

- [ ] **Step 1: Write failing project and switcher tests**

```tsx
expect(screen.getByText('档位来源：项目')).toBeVisible();
expect(screen.getByText('Planner')).toHaveAccessibleDescription('MiMo / mimo-v2.5-pro');
await user.click(screen.getByRole('button', { name: '跟随全局' }));
expect(api.clearProjectTierBinding).toHaveBeenCalledWith({ projectId, tier: 'fast' });
expect(screen.getByRole('alert')).toHaveTextContent('当前任务正在运行');
```

Cover active-task main/UI block, source display, keyboard navigation, mutation errors, Provider friendly capability copy, and narrow settings width without horizontal overflow.

- [ ] **Step 2: Run focused renderer tests and observe expected failures**

Run: `npx vitest run src/renderer/features/projects/__tests__/ProjectAiConfiguration.test.tsx src/renderer/features/models/__tests__ src/renderer/features/settings/__tests__/ModelProviderCenter.test.tsx`

- [ ] **Step 3: Integrate project overrides and factual status**

Show current template/custom status, effective models, permission mode, and read-only Git/Checkpoint facts. Do not add fake enable toggles where no persisted setting exists.

- [ ] **Step 4: Polish Provider cards and Quick Switch using existing components**

Keep one shared switcher state in `App.tsx`; do not convert global default changes into task overrides or vice versa. Display friendly unavailable-for-Agent copy while keeping the precise runtime warning in details.

- [ ] **Step 5: Run the complete renderer suite and build**

Run: `npx vitest run src/renderer`

Run: `npm run build:renderer`

---

### Task 9: Safe first-run backend and project/session hardening

**Files:**
- Create: `src/main/first-run/FirstRunService.ts`
- Create: `src/main/first-run/__tests__/FirstRunService.test.ts`
- Modify: `src/main/file-mutations/FileMutationManager.ts`
- Modify: `src/main/ipc/projects.ts`
- Create: `src/main/ipc/__tests__/projects.test.ts`
- Modify: `src/main/ipc/sessions.ts`
- Modify: `src/main/ipc/settings.ts`
- Modify: related IPC, FileMutationManager, ProjectService, and session tests
- Modify: `src/preload/index.ts`
- Modify: `src/shared/types/ipc.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Produces first-run completion version reads/writes, no-argument contained test-project creation, and project-confirmed Session creation.
- Consumes existing system environment checks, settings KV, ProjectService, FileMutationManager, TaskManager conflict rules, and Session persistence.

- [ ] **Step 1: Write failing safety tests**

```ts
await expect(service.createTestProject()).resolves.toMatchObject({ path: expect.stringContaining('first-run-projects') });
expect(fileMutationRequest.kind).toBe('first_run_project');
await expect(createSession({ projectId: forgedId })).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
expect(await settings.getFirstRunCompletedVersion()).toBe(0);
```

Cover exclusive directory creation, junction/reparse rejection, mutation conflict, write rollback, registration rollback, exact-owned-directory cleanup only, picker cancel, and completion state written only on explicit Finish/Complete later.

- [ ] **Step 2: Run focused tests and observe missing-service/kind failures**

Run: `npx vitest run src/main/first-run/__tests__/FirstRunService.test.ts src/main/ipc/__tests__/sessions.test.ts src/main/ipc/__tests__/settings.test.ts`

- [ ] **Step 3: Implement the contained project ownership sequence**

Exclusively create a UUID root under `dataRoot/first-run-projects`, verify canonical containment and no reparse escape, acquire `first_run_project` lease, register, and write a fixed allowlisted template through mutation context. Compensate only the exact owned row/root while the ownership context remains active.

- [ ] **Step 4: Add strict IPC and project-confirmed Session creation**

The create-test-project method accepts no Renderer path/name/content. Session creation resolves the registered project in main before writing Session/Task rows.

- [ ] **Step 5: Run first-run, project, session, mutation, IPC, and preload tests**

Run: `npx vitest run src/main/first-run src/main/projects src/main/file-mutations src/main/ipc/__tests__/projects.test.ts src/main/ipc/__tests__/sessions.test.ts src/preload/__tests__/index.test.ts`

Run: `npm run typecheck`

---

### Task 10: FirstRunWizard, actionable empty states, settings, About, and i18n

**Files:**
- Create: `src/renderer/features/first-run/FirstRunWizard.tsx`
- Create: `src/renderer/features/first-run/__tests__/FirstRunWizard.test.tsx`
- Create: `src/renderer/components/EmptyState.tsx`
- Create: `src/renderer/components/__tests__/EmptyState.test.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/features/settings/EnvironmentCheck.tsx`
- Modify: `src/renderer/features/settings/SettingsDialog.tsx`
- Modify: `src/renderer/features/settings/__tests__/SettingsRelease.test.ts`
- Modify: `src/renderer/features/projects/ProjectSidebar.tsx`
- Modify: chat/task empty surfaces, i18n dictionaries, and `globals.css`

**Interfaces:**
- Produces environment → Provider → project → first-task wizard, reusable actionable empty state, reorganized settings, and truthful About actions.
- Consumes existing environment/provider/project/session/workflow APIs and new first-run methods.

- [ ] **Step 1: Write failing wizard and empty-state tests**

```tsx
expect(screen.getByRole('dialog', { name: '欢迎使用 Claude Workbench' })).toBeVisible();
await user.click(screen.getByRole('button', { name: '稍后配置' }));
expect(api.setFirstRunCompletedVersion).not.toHaveBeenCalled();
await user.click(screen.getByRole('button', { name: '完成设置' }));
expect(api.setFirstRunCompletedVersion).toHaveBeenCalledWith(1);
expect(screen.getByRole('button', { name: '打开项目' })).toBeVisible();
```

Cover non-blocking environment failures, Provider Center reuse, picker cancel, safe test project, read-only Planner prompt with Agent+permission plan, stopping at plan confirmation, restart skip, Complete later, settings categories, missing-license disabled action, and both locales.

- [ ] **Step 2: Run focused UI tests and observe missing components**

Run: `npx vitest run src/renderer/features/first-run/__tests__/FirstRunWizard.test.tsx src/renderer/components/__tests__/EmptyState.test.tsx src/renderer/features/settings/__tests__/SettingsRelease.test.ts src/renderer/i18n/__tests__/i18n.test.ts`

- [ ] **Step 3: Implement the controlled wizard state machine**

Use `booting → environment → provider → project → first_task → completing → done`. Never set completion on picker cancel, dialog close, or a failed step. The first sample task uses the exact read-only prompt and `permissionMode: 'plan'`.

- [ ] **Step 4: Reuse product patterns for empty/settings/About surfaces**

Use semantic tokens and the existing settings dialog shell. Show app/build/runtime/Claude version, diagnostics, update actions, privacy copy, and a disabled license action with “No bundled license information” until a real license exists.

- [ ] **Step 5: Run renderer tests, typecheck, lint, and renderer build**

Run: `npx vitest run src/renderer`

Run: `npm run typecheck`

Run: `npm run lint`

Run: `npm run build:renderer`

---

### Task 11: Optional anonymous diagnostic aggregate

**Files:**
- Modify: `src/main/diagnostics/DiagnosticsExporter.ts`
- Modify: `src/main/diagnostics/__tests__/DiagnosticsExporter.test.ts`
- Modify: `src/main/ipc/diagnostics.ts`
- Modify: `src/main/ipc/__tests__/diagnostics.test.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/shared/types/ipc.ts`
- Modify: diagnostics UI in `SettingsDialog.tsx` and its tests

**Interfaces:**
- Produces per-export `includeAnonymousPerformanceData` default-off control and an allowlisted aggregate projector.
- Consumes existing diagnostic redaction/export, aggregate task/workflow counters, and native save flow.

- [ ] **Step 1: Write failing privacy tests**

```ts
expect(defaultExportRequest.includeAnonymousPerformanceData).toBe(false);
expect(zipEntries).not.toContain('anonymous-performance.json');
expect(enabledAggregate).toEqual({ schemaVersion: 1, operations: expect.any(Object), durationBuckets: expect.any(Object) });
expect(JSON.stringify(enabledAggregate)).not.toMatch(/prompt|path|provider|model|task|session|credential|permission|git|checkpoint/i);
```

Cover panel reopen resets false, unknown aggregate fields fail closed, no network calls, manifest flag, and sentinel scanning of ZIP/log/event/stdout/stderr/public DTOs.

- [ ] **Step 2: Run diagnostics suites and observe missing-option failures**

Run: `npx vitest run src/main/diagnostics/__tests__ src/main/ipc/__tests__/diagnostics.test.ts src/renderer/features/settings/__tests__/SettingsRelease.test.ts`

- [ ] **Step 3: Add the strict aggregate projector**

Project only operation/result counts and coarse duration buckets. Exclude all identifiers, names, paths, prompts, messages, URLs, raw errors, rules, arguments, Git/Checkpoint facts, and hardware identity.

- [ ] **Step 4: Wire strict IPC and default-off UI**

Accept one boolean, reset it every time the diagnostics panel opens, and record inclusion in the ZIP manifest. Do not send data over the network.

- [ ] **Step 5: Run diagnostics, IPC, preload, Renderer, and security tests**

Run: `npx vitest run src/main/diagnostics src/main/ipc/__tests__/diagnostics.test.ts src/preload/__tests__/index.test.ts src/renderer/features/settings/__tests__/SettingsRelease.test.ts`

---

### Task 12: Integrated production Electron acceptance and final gates

**Files:**
- Create: `scripts/electron-beta-readiness-acceptance.mjs`
- Modify: `package.json`
- Produce at runtime: `dist/beta-readiness-acceptance-report.json`
- Produce at runtime: `dist/beta-readiness-acceptance-screenshots/`

**Interfaces:**
- Produces a fresh-profile 15-step production acceptance report with artifact hashes and secret scans.
- Consumes the production build, two loopback Anthropic-compatible fixtures, one OpenAI-compatible DeepSeek fixture, and existing safe native diagnostics dialog automation.

- [x] **Step 1: Write static acceptance self-tests before the long run**

```js
assert.equal(runtimeName, 'ClaudeCliAdapter');
assert.equal(fakeClaudeRuntime, false);
assert.equal(gatewayConversionUsed, false);
assert.equal(deepSeekTierCandidateVisible, false);
assert.equal(diagnosticsSecretScan.present, false);
```

Add checks for fresh user data, exact five-role mappings, one-model-for-all, frozen-current/new-next Workflow behavior, disabled-binding block, project/global tier source, task override precedence, restart persistence, diagnostic off/on manifests, and cleanup ownership.

- [x] **Step 2: Run script syntax and self-tests**

Run: `node --check scripts/electron-beta-readiness-acceptance.mjs`

Run: `node scripts/electron-beta-readiness-acceptance.mjs --self-test`

- [x] **Step 3: Run all code-quality and test gates**

Run: `npm run typecheck`

Run: `npm run lint`

Run: `npm test`

Run: `npm run build`

- [x] **Step 4: Run real production Electron acceptance**

Run: `npm run test:electron:beta-readiness`

Require every acceptance step to pass, no Renderer error, no fake runtime, no billed external model task, and no lingering Electron/CDP/native dialog process.

- [x] **Step 5: Inspect privacy and artifact evidence**

Verify diagnostic ZIPs and public outputs contain no API key, plaintext credential, `credential_ref`, or vault identity. Verify SQLite/WAL/SHM contain no API key, plaintext credential, or real vault path/name while allowing the intentionally persisted opaque `credential_ref`. Bind the report to main/preload/Renderer/script/package SHA-256 hashes.

- [x] **Step 6: Perform final independent review and scoped diff check**

Run: `git diff --check`

Review every changed file for direct project writes, Renderer secret exposure, capability trust, silent tier fallback, partial preset writes, priority drift, and unpinned Workflow selection.

Document the accepted same-user pathname unlink micro-race in the acceptance utility as a tool limitation; do not expand Phase 8.5 into a Windows handle-based deletion subsystem.
