# Claude Workbench Phase 8.5 Product Experience & Beta Readiness Design

> Date: 2026-08-09  
> Status: approved for TDD implementation  
> Runtime boundary: `ClaudeCliAdapter` remains the only implemented Agent Runtime

## 1. Outcome and non-goals

Phase 8.5 turns the existing v1.0 RC into a beta-ready desktop product without adding a new model runtime or weakening any established trust boundary. It adds a first-run journey, model-tier-driven Agent presets, clearer Provider and project configuration, actionable empty states, reorganized settings, diagnostics controls, and zh-CN/en-US coverage for every touched surface.

This phase does not implement an OpenAI Agent Runtime, an OpenAI-to-Anthropic gateway, cloud synchronization, team collaboration, or a plugin marketplace. It does not replace `TaskManager`, `PermissionBroker`, `FileMutationManager`, Workflow snapshots, Checkpoints, Git, Sessions, or the existing Provider credential system.

## 2. Chosen approach and rejected alternatives

The chosen approach persists role-to-tier references in the existing Agent policy tables. A built-in template writes `high_quality`, `balanced`, or `fast` into each role policy. The main process resolves that tier through project override then global binding immediately before a future call, and Workflow creation freezes the resulting `ResolvedModelSelection` for every stage.

Two alternatives are rejected:

1. **One-shot materialization:** copying Provider/model IDs into every role when a template is applied loses the role-to-tier relationship. A later tier change would either do nothing or require hidden bulk rewrites, and identical tier bindings make template detection ambiguous.
2. **Runtime-only preset overlay:** applying an unpersisted overlay outside `agent_model_policy` would create a parallel precedence system and break restart persistence and existing policy tooling.

The selected design preserves the current policy priority while making template state explicit and deterministic. No model, Provider, price, or name heuristic is used.

## 3. Reuse decisions

- Reuse `src/main/model-providers/ProviderCapabilityResolver.ts` and `AgentRuntimeRegistry.ts` as the final capability ceiling and runtime gate.
- Adapt `AgentModelPolicyService.ts`, `ModelSelectionResolver.ts`, `ModelProviderRepository.ts`, and `src/main/ipc/model-providers.ts` instead of creating a parallel model-routing service.
- Reuse `ModelSelectionResolver.snapshotWorkflowPolicy()` and the existing pinned Workflow policy so running Planner/Coder/Tester/Reviewer/Fixer stages remain immutable.
- Reuse `src/renderer/features/settings/ModelProviderCenter.tsx`, `features/models/ModelQuickSwitcher.tsx`, `ProjectModelPolicySettings`, `EnvironmentCheck.tsx`, `SettingsDialog.AboutSection`, `DiagnosticsExporter.ts`, and the current semantic CSS tokens.
- Reuse `AppDatabase.getSetting/setSetting` and the strict settings IPC for `firstRunCompletedVersion`; do not create a wizard-state table.
- Create focused tier/preset services and v7 tables because no existing contract owns global/project tier bindings or role-to-tier policy references.
- Create a narrow first-run project service because `src/main/ipc/projects.ts` currently opens and registers existing directories but does not create one.

The rejected similarly named `src/main/security/EnvironmentChecker.ts` is not reused: it uses string-based `execSync`, contains unconditional status fields, and duplicates the safer active checks in `src/main/ipc/system.ts`.

## 4. Domain model

```ts
export const MODEL_TIERS = ['high_quality', 'balanced', 'fast'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export interface ModelTierBinding {
  tier: ModelTier;
  providerId: string | null;
  modelId: string | null;
  updatedAt: number;
}

export interface ModelTierDisplayMetadata {
  tier: ModelTier;
  displayName: string | null;
  quality: 'low' | 'medium' | 'high' | null;
  speed: 'low' | 'medium' | 'high' | null;
  cost: 'low' | 'medium' | 'high' | null;
}

export type ModelTierScope =
  | { type: 'global' }
  | { type: 'project'; projectId: string };

export type PersistedModelPolicyReference =
  | { kind: 'model'; providerId: string; modelId: string }
  | { kind: 'tier'; tier: ModelTier };

export type BuiltInAgentPresetId =
  | 'software_development'
  | 'quick_change'
  | 'high_quality_review';
```

The three logical keys are immutable, while each scope may customize its localized display name and `quality`, `speed`, and `cost` notes. These values are presentation metadata only. They never participate in selection, validation, capability elevation, or routing. Existing role-policy notes remain readable for backward compatibility and are preserved when a template changes the role reference; new tier-oriented UI edits the tier metadata instead.

The built-in mappings are fixed product behavior:

| Role | Software development | Quick change | High-quality review |
| --- | --- | --- | --- |
| Planner | `high_quality` | `fast` | `high_quality` |
| Coder | `balanced` | `fast` | `balanced` |
| Tester | `fast` | `fast` | `balanced` |
| Reviewer | `high_quality` | `balanced` | `high_quality` |
| Fixer | `balanced` | `fast` | `high_quality` |

The templates contain no Provider ID or model ID.

## 5. SQLite v7

Schema version 7 is required because role policies must support tier references and tier bindings need global and project scopes.

New tables:

```sql
CREATE TABLE model_tier_bindings (
  tier TEXT PRIMARY KEY CHECK (tier IN ('high_quality','balanced','fast')),
  provider_id TEXT,
  model_id TEXT,
  display_name TEXT,
  quality TEXT CHECK (quality IS NULL OR quality IN ('low','medium','high')),
  speed TEXT CHECK (speed IS NULL OR speed IN ('low','medium','high')),
  cost TEXT CHECK (cost IS NULL OR cost IN ('low','medium','high')),
  updated_at INTEGER NOT NULL,
  CHECK ((provider_id IS NULL) = (model_id IS NULL)),
  CHECK (provider_id IS NULL OR (
    length(provider_id) BETWEEN 1 AND 192
    AND provider_id = trim(provider_id)
    AND instr(provider_id, char(0)) = 0
  )),
  CHECK (model_id IS NULL OR (
    length(model_id) BETWEEN 1 AND 256
    AND model_id = trim(model_id)
    AND instr(model_id, char(0)) = 0
  )),
  CHECK (display_name IS NULL OR (
    length(display_name) BETWEEN 1 AND 80
    AND display_name = trim(display_name)
    AND instr(display_name, char(0)) = 0
  )),
  CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0)
);

CREATE TABLE project_model_tier_bindings (
  project_id TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('high_quality','balanced','fast')),
  provider_id TEXT,
  model_id TEXT,
  display_name TEXT,
  quality TEXT CHECK (quality IS NULL OR quality IN ('low','medium','high')),
  speed TEXT CHECK (speed IS NULL OR speed IN ('low','medium','high')),
  cost TEXT CHECK (cost IS NULL OR cost IN ('low','medium','high')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, tier),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CHECK ((provider_id IS NULL) = (model_id IS NULL)),
  CHECK (provider_id IS NULL OR (
    length(provider_id) BETWEEN 1 AND 192
    AND provider_id = trim(provider_id)
    AND instr(provider_id, char(0)) = 0
  )),
  CHECK (model_id IS NULL OR (
    length(model_id) BETWEEN 1 AND 256
    AND model_id = trim(model_id)
    AND instr(model_id, char(0)) = 0
  )),
  CHECK (display_name IS NULL OR (
    length(display_name) BETWEEN 1 AND 80
    AND display_name = trim(display_name)
    AND instr(display_name, char(0)) = 0
  )),
  CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0)
);
```

Tier bindings intentionally do not foreign-key Provider/model IDs. Application Providers live in v6 tables, while valid inherited sources use reserved trusted IDs such as `environment:anthropic` and `claude-code:default`. Every read and write is therefore revalidated by the main-process tier service. Keeping a deleted application Provider ID as a tombstone also lets the UI report “Provider deleted” and prevents a project binding from silently falling back to the global tier.

`agent_model_policy` and `project_model_policy` are transactionally rebuilt to add nullable `tier`, make `provider_id/model_id` nullable, and enforce exactly one reference form:

```sql
CHECK (
  (tier IS NOT NULL AND provider_id IS NULL AND model_id IS NULL)
  OR
  (tier IS NULL AND provider_id IS NOT NULL AND model_id IS NOT NULL)
)
```

`project_model_policy.agent_type='default'` remains a direct Provider/model reference and is prohibited from using `tier` by a database `CHECK`, not only by service validation. Only the five Agent role rows may reference tiers, so the established “project default model” meaning does not change.

Direct model rows retain their existing composite Provider/model foreign key. Tier rows contain only the logical tier. Existing v6 direct policies migrate unchanged with `tier = NULL`.

The migration uses the existing outer transaction, rollback path, future-version guard, exact column/index/FK/check validation, `foreign_key_check`, and `integrity_check`. Rebuilt policy tables restore every existing index and foreign key, including the nullable composite direct-model foreign key. It includes fresh-install, v6-upgrade with exact row preservation, failure rollback, restart persistence, malformed-value rejection, and old/future database compatibility tests.

## 6. Trusted tier candidates and validation

`AgentModelTierService.listCandidates()` constructs Renderer-safe candidates in the main process. An application Provider/model is included only when all conditions hold:

- the Provider exists, is enabled, and has a usable credential reference;
- persisted health is `connected` with a successful test timestamp;
- the model belongs to that Provider;
- `ProviderCapabilityResolver` recomputes the trusted capability ceiling;
- runtime is `claude-code`;
- `supportsClaudeCode` and `supportsAgentWorkflow` are true;
- `AgentRuntimeRegistry.assertRunnable(..., 'agent-workflow')` succeeds.

The current inherited environment or Claude Code selection may also be included when it is the main process’s current effective, runnable selection and the existing installation check confirms that the Claude CLI is available. Each synthetic `providerId` contains a versioned HMAC-SHA-256 identity. The HMAC key is generated in the main process, persisted through the existing encrypted credential store, and never exposed to the Renderer, logs, events, diagnostics, or tier tables. Canonical input is bounded and closed to source kind, normalized execution endpoint identity, and selected model; API keys, credential references, vault paths, raw environment objects, raw errors, and volatile CLI version/path output are excluded. Keyed identity prevents offline enumeration of low-entropy environment facts while remaining stable across restart and ordinary CLI upgrades. A changed effective source identity invalidates the old binding instead of silently retargeting it. Renderer-supplied Provider type, runtime, health, capabilities, source, credential state, or model ownership are ignored.

OpenAI-compatible Providers with `runtimeType='none'` never appear. A Provider merely declaring Agent support cannot elevate itself. Coder/Tester/Fixer execution continues to enforce Tools and MCP requirements at the existing stage gate even if a tier candidate is valid for Planner/Reviewer.

Preset preview and application also perform this role-specific check. A tier may be a valid general Agent candidate yet still be rejected for a Coder/Tester/Fixer assignment with a concrete role and missing Tools/MCP reason.

Binding writes accept only `{scope,tier,providerId,modelId}` intent, locate that exact reference in a freshly recomputed candidate set, and reject anything absent. The public DTO exposes Provider/model display names, runtime, health, last test time, binding source, validity, and a safe invalid-reason enum; it never exposes API keys, `credential_ref`, encrypted data, vault paths, base URLs containing secrets, or raw connection errors.

## 7. Tier resolution and invalidation

Tier resolution is:

```text
project binding row, if one exists
  -> global binding row
```

An existing project row is authoritative even when invalid. It never silently falls through to global. Deleting the project row is the explicit “follow global” action.

A binding becomes `needs_reconfiguration` when its Provider/model is missing, disabled, not configured, not connected, no longer owned by the Provider, fails the recomputed capability/runtime gate, or no longer matches the current inherited source. Resolution returns a typed reason such as `provider_deleted`, `provider_disabled`, `connection_unavailable`, `model_missing`, `runtime_incompatible`, or `workflow_capability_missing`.

No replacement is selected automatically. Template preview and Workflow snapshot creation fail with the affected tiers and roles. The UI offers a deliberate rebind action.

## 8. Preset preview and transactional application

First application checks every tier referenced by the chosen template. If any required tier is unbound, Agent Settings opens the tier wizard before preview. With one candidate, “Use this model for all tiers” writes all three bindings in one transaction; duplicate bindings are valid.

After binding, `previewPreset(scope,presetId)` resolves every role and returns a safe preview plus a revision fingerprint derived from the current tier rows, Provider/model health facts, trusted runtime/capabilities, and existing role policies. The UI shows role, tier label, Provider/model, runtime, source, and invalid reason.

`applyPreset(scope,presetId,expectedRevision,previewConfirmed,overwriteConfirmed)` recomputes everything in the main process. `previewConfirmed` is required for every application. When any role policy already exists, the separate `overwriteConfirmed` flag is also required for the explicit reapply warning. A changed fingerprint yields `PREVIEW_STALE` and requires another preview. Otherwise `AppDatabase.runInTransaction()` re-reads and revalidates the tier, Provider/model, health, and existing role-policy rows before writing all five role policies as tier references. Any validation or write failure rolls back every role. The transaction preserves each role's existing `created_at` and display-only `quality/speed/cost` notes and updates only the reference plus `updated_at`.

Global application writes `agent_model_policy`; project application writes the five role rows in `project_model_policy` and leaves project `default` unchanged. Existing task overrides and project default policies are never modified.

Preset status is derived from the persisted role-to-tier references, so it survives restart and remains unambiguous even when all tiers point to one model. A manual role edit writes a direct model reference and immediately makes the scope `custom`. Reapplying a template over any existing role configuration requires the explicit warning: “Reapplying this template will overwrite the current Agent role model configuration.”

## 9. Model resolution and running work

The selection priority remains exactly:

1. task override;
2. project role policy;
3. project default model;
4. global Agent role policy;
5. global default Provider;
6. environment variables;
7. Claude Code default configuration.

When the winning role policy is a tier reference, `ModelSelectionResolver` resolves the project/global tier inside that same policy level and validates it again. It does not introduce a new priority level. `ResolvedModelSelection.source` remains the existing task/project/global policy source and adds optional informational `tier` and `tierSource` fields. A separate trusted `executionSource` (`database_provider`, `environment`, or `claude_code`) controls credential/environment construction and frozen revalidation. Synthetic reserved IDs are never routed through the database-Provider lookup merely because the policy source is project/global.

Workflow creation resolves and freezes all Planner/Coder/Tester/Reviewer/Fixer selections in the existing `WorkflowModelSelectionPolicy`. Every later stage uses the pinned concrete Provider/model/runtime/execution identity and revalidates only that same identity; it never re-reads the current tier binding. Settings edits cannot replace the stage environment. Normal future calls resolve the new configuration. Successful tier or preset edits show: “Model configuration updated; it only affects subsequent Agent calls.”

Workflow strict serialization/deserialization, `WorkflowInfrastructure`, `attachWorkflowStepModelSelection()`, and event projection all explicitly whitelist and preserve `tier`, `tierSource`, and `executionSource`. Stage records persist the concrete Provider, model, runtime, effective policy source, and optional tier source. They never persist credentials or child environment values.

## 10. First-run experience

`FirstRunWizard` is an App-level state machine shown only when `firstRunCompletedVersion < 1`:

```text
booting -> environment -> provider -> project -> first_task -> completing -> done
```

Per-step errors are recoverable and do not write completion state. Only explicit “Finish” or “Complete later” writes version `1` through the strict settings IPC.

Environment and Provider steps offer “Configure later.” Project and first-task steps may also be skipped; without a registered project, the first task is visibly skipped rather than creating hidden state. Cancelling a directory picker or closing the window does not mark first run complete.

1. **Environment:** reuse the active `system.ts` environment check for Claude Code, Git, Node, Git Bash/default shell, and real Provider health. Missing tools warn but do not trap the user. The obsolete string-`execSync` checker is not used.
2. **Model:** show trusted Provider cards and current source. “Configure” opens the existing Provider Center at the model category; credential creation/testing is not duplicated.
3. **Project:** reuse the native open-directory flow, or create a fixed test project.
4. **First task:** create/reuse one Workbench task, prefill “Analyze this project structure without modifying files,” and run Planner with both Agent mode and permission mode set to `plan`. Success stops at plan confirmation; it never enters Coder automatically. The wizard points out Plan, Timeline, and Review without changing their behavior.

The test-project IPC accepts no path, name, or file content. It exclusively creates a UUID directory only under `dataRoot/first-run-projects`, immediately verifies its real path and rejects symlink/junction/reparse escapes, then acquires a new `first_run_project` mutation lease for that canonical root before registration is exposed or any file is written. Registration and the small allowlisted template write occur inside that single ownership context through `FileMutationManager`. Exclusive creation prevents overwrite. Failure compensates only the exact newly owned project row and directory while the same ownership context is held; it never scans or removes another path.

The existing session-create IPC is tightened to require a main-process-confirmed project row before creating a Session/Task, preventing an orphan identity from being used by the wizard or a forged Renderer call.

## 11. Product UI

The existing visual language remains authoritative: current semantic colors, spacing, radii, borders, shadows, Lucide icons, and focus treatment are reused.

### Provider Center

Provider summaries become compact single-column cards suited to the current settings width. Cards show name/default, friendly health, default model, latency, last test, and user-facing support chips. API format, raw capability fields, sanitized Base URL, and advanced actions move into details. Errors use product copy, including: “This Provider can be managed and tested, but cannot run Claude Code Agent tasks.” The exact security warning that the Provider does not support Claude Code Agent Runtime remains available in details and errors.

### Quick Model Switcher

The existing shared switcher remains the sole top/composer implementation. It shows the effective Provider/model and source (task override, project policy, global default, environment, or Claude Code), adds visible mutation failures, keyboard navigation, Escape/focus return, external-click close, and correct dialog/listbox ARIA. Active work cannot change selection; the main process remains the authoritative blocker.

### Agent Settings

The new Agent category contains:

1. **Model tiers:** High quality, Balanced, Fast. Each row shows Provider/model, runtime, health, last test, source, validity, notes that tier labels are subjective, and Change/Rebind.
2. **Agent templates:** Software development, Quick change, High-quality review, and Custom. Applying follows bind -> preview -> confirm -> atomic write. The role mapping and effective model are visible before confirmation.
3. **Manual role policies:** existing direct assignment and quality/speed/cost notes. Editing one role changes template status to Custom.

### Project AI configuration

Project Settings groups the current project default model policy, optional project tier overrides, current template/custom status, each role’s effective model, permission mode, Checkpoint integration status, Git detection status, MCP/Skills summary, and permission rules. Checkpoint and Git are truthful read-only status in this phase; no fake toggle is added where no persisted setting exists. Immediate-save sections explicitly say so, avoiding a Cancel button that suggests rollback.

### Settings, empty states, About, and i18n

Settings categories become General, Models & Connections, Agent, Permissions, Git, MCP, Skills, Data, and About. Appearance and terminal preferences live under General; Claude Code environment inheritance is advanced content under Models & Connections.

The legacy free-text `defaultModel` remains only as an advanced Claude CLI fallback. It is not presented beside Provider-backed global/project defaults as a second primary model system.

One small `EmptyState` component is extracted from existing patterns and used by the no-project, no-task, no-Provider, and no-runnable-model states. Every state explains the next outcome and offers the appropriate action.

About shows app version, build, commit/channel, Electron, Claude Code version, update actions, diagnostics export, privacy copy, and license entry. All new and touched user-facing copy moves into the existing strongly typed zh-CN/en-US dictionaries; names such as Claude, MCP, Git, Agent, and Checkpoint remain untranslated.

The repository currently contains neither a root license file nor a `package.json` license declaration. The About page must not invent legal terms: it shows “No bundled license information” and disables the open action until an actual release license is supplied.

## 12. Diagnostics privacy

Diagnostics export keeps the existing explicit user action, allowlisted files, recursive redaction, credential-vault exclusion, and sentinel scans. A per-export “Include anonymous performance data” checkbox is always off when the panel opens and is passed as a strict boolean. It is not telemetry and sends nothing over the network.

When selected, a dedicated main-process projector may add only aggregate operation/result counts and coarse duration buckets from existing task/workflow data. It excludes prompts, messages, source code, paths, project/task/session identifiers, Provider/model names or IDs, URLs, credentials and references, MCP/tool names or arguments, permission commands/rules/audit data, Git metadata, Checkpoint file metadata, raw database rows, logs, stacks, and exact hardware identity. Unknown fields fail closed. The ZIP manifest records whether the optional aggregate was included.

## 13. IPC and trust boundaries

New tier, preset, first-run project, and diagnostic-option IPC uses named preload methods, strict Zod DTOs, bounded strings/page sizes, trusted `WebContents` + main-frame + stable renderer URL checks, and main-process project/task lookups. The Renderer can express intent only.

No tier, preset, project summary, event, log, diagnostic, or public error may contain a secret, `credential_ref`, encrypted blob, vault filename/path, authenticated header, raw network response, or child-process environment. Provider deletion leaves tier references invalid rather than silently deleting them into fallback behavior.

## 14. TDD and verification

Every production behavior begins with a focused failing test and an observed expected failure. The implementation is divided into independently reviewable slices:

1. shared tier/preset contracts and v7 migration;
2. repository, trusted candidates, binding resolution, invalidation, and atomic preset service;
3. policy reference resolution, task precedence, Workflow snapshot/stage recording, and IPC/preload;
4. Agent/project UI and Provider/Quick Switch experience;
5. first-run wizard, safe test project, empty states, settings/About/i18n, and optional diagnostics aggregate;
6. production Electron acceptance and security scans.

Tests cover every case explicitly listed in the approved request, including one-model bulk binding, Renderer capability forgery, OpenAI exclusion, all three mappings, transaction rollback, project override, task precedence, frozen stages, invalid/deleted Providers, custom-state detection, restart persistence, secret/ref/vault exclusion, and stage Provider/model/source records.

The Phase 8.5 test target is at least the requested matrix: First Run 40, Provider UI 40, Model Switch 30, Preset/tier behavior 30, Project Config 20, Empty State 20, Settings 30, i18n 20, and Security 20. Existing tests count only when they are expanded to assert a new Phase 8.5 behavior; the final report separates new/expanded cases from the full suite total.

Final gates are focused tests after each slice, then full typecheck, lint, all tests, production build, fresh-user production Electron acceptance, diagnostic ZIP inspection, and an independent security/code review. Electron acceptance uses two runnable loopback Anthropic-compatible Providers plus an OpenAI-compatible DeepSeek fixture; it never implements or invokes an OpenAI Agent Runtime.

Production Electron acceptance uses a fresh user-data directory and verifies this combined flow:

1. launch into First Run and complete the non-blocking environment step;
2. create/test two Claude-runtime Providers and one OpenAI-compatible DeepSeek Provider;
3. confirm DeepSeek is manageable but absent from tier candidates;
4. bind High quality, Balanced, and Fast, including the one-model-for-all control;
5. preview and atomically apply Software development, then verify all five role mappings;
6. open an existing project or create the contained test project;
7. run the first read-only Planner task and inspect Plan, Timeline, and Review guidance;
8. exercise top/composer model switching and the active-task UI/main-process block;
9. create a Workflow and verify every recorded stage Provider/model/source matches its frozen selection;
10. change a tier during the Workflow and prove the current snapshot is unchanged;
11. create a later Workflow and prove the new tier binding is used;
12. disable a bound Provider and prove preview/start is blocked with a reconfiguration reason;
13. exercise project tier override and task-override precedence;
14. restart and verify first-run completion, bindings, policies, template/custom state, and Provider health persist;
15. export diagnostics with anonymous performance data both off and explicitly on. Renderer state, logs, events, ZIP, stdout/stderr, and process arguments must contain no API key, plaintext credential, `credential_ref`, or vault path/name. SQLite/WAL/SHM may contain the intentionally persisted opaque `credential_ref`, but must contain no API key, plaintext credential, or real vault file path/name.

## 15. Deliberate limitations

- Tier labels and notes are subjective user organization, not model benchmarking or guarantees.
- Provider health uses the most recent persisted successful test; this phase does not introduce background polling or an automatic freshness TTL.
- Changing a tier affects future resolution but never mutates a Workflow snapshot already created.
- No automatic replacement occurs for invalid bindings.
- Checkpoint and Git project status are displayed from current runtime facts; per-project enable/disable switches require a separate future design.
- Anonymous performance data is optional local diagnostic content only, not remote telemetry.
