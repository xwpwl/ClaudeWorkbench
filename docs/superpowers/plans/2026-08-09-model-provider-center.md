# Model Provider Center Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: use `superpowers:test-driven-development` for every behavior slice and `superpowers:verification-before-completion` before reporting completion.

**Goal:** Add a secure, capability-aware Model Provider Center while keeping `ClaudeCliAdapter` as the only implemented Agent Runtime and preserving existing MiMo/DeepSeek configuration behavior.

**Architecture:** The Renderer talks through strict Provider-specific preload methods to a main-process `ModelProviderService`. Provider metadata and policy live in SQLite v6, credentials live in a `safeStorage`-encrypted file vault, and a main-process resolver validates capabilities before the existing Claude runtime starts. Raw OpenAI-compatible Providers can be managed, probed, and discovered, but never reach `ClaudeCliAdapter`.

**Tech stack:** Electron 35, React 19, TypeScript 5.8, Zod, better-sqlite3, Vitest, existing Claude/Task/Workflow infrastructure.

**Constraints:** Do not implement protocol translation or `OpenAIAgentRuntime`. Do not expose credentials, credential references, raw HTTP failures, or provider-bound environment values to Renderer/logs/diagnostics. Do not mutate global `process.env`. Preserve current environment and Claude Code fallbacks.

---

## Task 1: Shared contracts and trusted capability projection

**Files:**

- Create: `src/shared/types/modelProviders.ts`
- Create: `src/shared/types/__tests__/modelProviders.test.ts`
- Modify: `src/shared/types/index.ts`

**Step 1 — write failing contract tests:** Cover all Provider/API combinations, exact six capability fields, runtime discriminator reservation, health/error enums, user-facing use projection, source labels, policy note ratings, and serialization that omits secret/ref fields.

**Step 2 — prove red:** Run `npx vitest run src/shared/types/__tests__/modelProviders.test.ts`; expected failure is the missing module/exports.

**Step 3 — implement minimally:** Add Provider, model, health, resolved-selection, policy-note, pagination, connection-result, create/update DTOs, and pure `supportedUsesForCapabilities`/`effectiveSourceLabel` helpers. The chat label requires a runnable Claude Code capability in this phase.

**Step 4 — prove green:** Re-run the focused test and `npm run typecheck`.

## Task 2: Capability resolver and runtime gate

**Files:**

- Create: `src/main/model-providers/ProviderCapabilityResolver.ts`
- Create: `src/main/model-providers/AgentRuntime.ts`
- Create: `src/main/model-providers/AgentRuntimeRegistry.ts`
- Create: `src/main/model-providers/ClaudeCodeAgentRuntime.ts`
- Create: `src/main/model-providers/__tests__/ProviderCapabilityResolver.test.ts`
- Create: `src/main/model-providers/__tests__/AgentRuntimeRegistry.test.ts`

**Step 1 — write failing tests:** Assert Anthropic and Anthropic-compatible map to `claude-code`; OpenAI-compatible maps to `none`; user input may narrow but never elevate; custom format is conservative; the exact unsupported message is returned; registry blocks before invoking a runtime; Anthropic invokes the existing adapter; MiMo-style Anthropic-compatible configuration remains runnable; `openai-agent` exists only as a type/discriminator.

**Step 2 — prove red:** Run both focused suites and capture the expected missing implementation failures.

**Step 3 — implement minimally:** Derive trusted maximum capabilities and runtime in main, add the runtime interface/registry, and wrap the existing adapter without changing its behavior.

**Step 4 — prove green:** Re-run focused suites and typecheck.

## Task 3: Transactional SQLite v6 migration and provider repository

**Files:**

- Modify: `src/main/database/Database.ts`
- Create: `src/main/database/__tests__/ModelProviderMigration.test.ts`
- Create: `src/main/model-providers/ModelProviderRepository.ts`
- Create: `src/main/model-providers/__tests__/ModelProviderRepository.test.ts`

**Step 1 — write failing migration/repository tests:** Cover fresh v6, v5 upgrade, rollback after late DDL failure, future-version rejection, restart persistence, foreign keys, JSON/check constraints, one enabled global default, credential-ref scheme, pagination, cascade behavior, model ownership, health fields, cleanup tombstones, role/project/task policies, and `quality/speed/cost` constraints.

**Step 2 — prove red:** Run the two focused suites; expected schema version/table failures.

**Step 3 — implement minimally:** Add v6 tables `model_providers`, `model_provider_models`, `agent_model_policy`, `project_model_policy`, `task_model_overrides`, and `credential_cleanup_jobs`, plus indexes and typed repository operations. Keep the existing outer migration transaction, foreign-key check, and integrity check.

**Step 4 — prove green:** Re-run focused suites plus all database migration suites to update legitimate v5 expectations to v6.

## Task 4: Encrypted CredentialStore with compensation lifecycle

**Files:**

- Create: `src/main/model-providers/CredentialStore.ts`
- Create: `src/main/model-providers/__tests__/CredentialStore.test.ts`
- Modify: `src/main/diagnostics/DiagnosticsExporter.ts`
- Modify: `src/main/diagnostics/__tests__/DiagnosticsExporter.test.ts`

**Step 1 — write failing security tests:** Cover `safeStorage` unavailable/basic-text fail-closed, atomic create/read/replace/delete, opaque UUID references, traversal/absolute/symlink/oversize rejection, missing/corrupt blobs, no plaintext at rest, cleanup retry, and diagnostics vault exclusion/redaction.

**Step 2 — prove red:** Run CredentialStore and diagnostics suites.

**Step 3 — implement minimally:** Inject a safe-storage facade for tests, persist only encrypted bytes under the dedicated vault, validate references before I/O, use atomic temporary-file replacement, and expose secrets only to a short-lived main-process callback/read.

**Step 4 — prove green:** Re-run focused tests and typecheck.

## Task 5: Real connection testing, discovery, health, and validation tokens

**Files:**

- Create: `src/main/model-providers/ProviderConnectionTester.ts`
- Create: `src/main/model-providers/ModelProviderService.ts`
- Create: `src/main/model-providers/__tests__/ProviderConnectionTester.test.ts`
- Create: `src/main/model-providers/__tests__/ModelProviderService.test.ts`

**Step 1 — write failing tests:** Use bounded local HTTP servers/fetch doubles for Anthropic `/v1/messages`, OpenAI `/models`, chat fallback with manual model, timeout, retry-only categories, 401/403/404/429/5xx/network/invalid-response mapping, response limits, manual redirects, base-URL SSRF/credential validation, latency and last-test persistence, discovered/manual models, single-use/expiry/draft-binding tokens, failed-config save refusal, credential replacement compensation, deletion confirmation, active-task mutation refusal, and pagination.

**Step 2 — prove red:** Run the connection/service suites.

**Step 3 — implement minimally:** Build sanitized requests, safe public errors, injectable clock/fetch, in-memory validation-token vault, CRUD orchestration, health updates, model cache, and credential compensation. Never log request/response objects.

**Step 4 — prove green:** Re-run focused suites and typecheck.

## Task 6: Selection resolver, policies, task overrides, and per-child environment isolation

**Files:**

- Create: `src/main/model-providers/ModelSelectionResolver.ts`
- Create: `src/main/model-providers/ProviderEnvironmentResolver.ts`
- Create: `src/main/model-providers/__tests__/ModelSelectionResolver.test.ts`
- Create: `src/main/model-providers/__tests__/ProviderEnvironmentResolver.test.ts`
- Modify: `src/main/claude/ClaudeCliAdapter.ts`
- Modify: `src/main/claude/__tests__/ClaudeCliAdapter.test.ts`
- Modify: `src/main/workflows/TaskManagerAgentStageRunner.ts`
- Modify: `src/main/workflows/__tests__/TaskManagerAgentStageRunner.test.ts`
- Modify: `src/shared/types/workflow.ts`
- Modify: `src/main/workflows/AgentModelPolicy.ts`

**Step 1 — write failing tests:** Cover priority `task > project role/default > global role > global default > environment > Claude Code`, immutable source snapshots, policy note round-trip without routing effects, Tester/Fixer fallback, disabled/unconfigured/model-mismatch rejection, Workflow capability/tool/MCP checks, running-task switch refusal, idle future-call warning, no adapter call for OpenAI-compatible selections, per-child removal/injection of the three Anthropic env keys, global-env immutability, concurrent provider isolation, and existing no-provider behavior.

**Step 2 — prove red:** Run resolver, adapter, and stage-runner suites.

**Step 3 — implement minimally:** Resolve trusted Provider/model identities in main, gate before TaskManager/run creation, pass an immutable selection/provider ID to the Claude runtime, and build a fresh environment for each child. Keep `ClaudeCliAdapter` as the sole runtime.

**Step 4 — prove green:** Re-run focused tests plus all Workflow/Claude suites.

## Task 7: Strict IPC and preload surface

**Files:**

- Create: `src/main/ipc/model-providers.ts`
- Create: `src/main/ipc/__tests__/model-providers.test.ts`
- Modify: `src/shared/types/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/__tests__/index.test.ts`
- Modify: `src/main/ipc/settings.ts`
- Modify: `src/main/ipc/__tests__/settings.test.ts`
- Modify: `src/main/index.ts`

**Step 1 — write failing tests:** Cover named channels only, Zod validation/size limits, main-frame sender authentication, strict public response projection, secret/ref/blob absence, validation-token save, transient secret never echoed, pagination, delete-with-credential confirmation, active-task switch blocking, OpenAI capability blocking, event subscription disposal, and generic settings rejection of secret-shaped/unknown keys.

**Step 2 — prove red:** Run IPC/preload/settings suites.

**Step 3 — implement minimally:** Register/unregister Provider IPC, expose explicit preload calls, wire service/runtime dependencies at startup, retry cleanup tombstones, and harden generic settings without changing known settings behavior.

**Step 4 — prove green:** Re-run all IPC/preload suites and typecheck.

## Task 8: Provider Center, policy editor, and safe credential UX

**Files:**

- Create: `src/renderer/features/settings/ModelProviderCenter.tsx`
- Create: `src/renderer/features/settings/modelProviderPresentation.ts`
- Create: `src/renderer/features/settings/__tests__/ModelProviderCenter.test.ts`
- Create: `src/renderer/features/settings/__tests__/modelProviderPresentation.test.ts`
- Modify: `src/renderer/features/settings/SettingsDialog.tsx`
- Modify: `src/renderer/i18n/zh-CN.ts`
- Modify: `src/renderer/i18n/en-US.ts`
- Modify: `src/renderer/styles/globals.css`

**Step 1 — write failing UI tests:** Cover Provider list/detail/pagination, type/runtime/capability/use labels, exact unsupported warning, health/last-test/error/latency, password input, clear-on-settlement/unmount, no reveal/prefill/copy, replace wording, failed-test save disabled, delete credential confirmation/cancel, discovered/manual models, default action, role policy and `quality/speed/cost` display, and disabled OpenAI Workflow controls.

**Step 2 — prove red:** Run the two focused Renderer suites.

**Step 3 — implement minimally:** Add accessible settings navigation, Provider wizard/detail, health/status cards, policy selectors filtered by trusted capabilities, replace-only credential UI, and confirmation copy.

**Step 4 — prove green:** Re-run focused UI tests, typecheck, and lint affected files.

## Task 9: Top model switcher and task override

**Files:**

- Create: `src/renderer/features/models/ModelQuickSwitcher.tsx`
- Create: `src/renderer/features/models/__tests__/ModelQuickSwitcher.test.ts`
- Modify: `src/renderer/components/TopToolbar.tsx`
- Modify: `src/renderer/features/chat/InputBar.tsx`
- Modify: `src/renderer/hooks/useWorkspaceController.ts`
- Modify: related existing Renderer tests

**Step 1 — write failing tests:** Assert `MiMo / mimo-v2.5-pro`, Provider/Runtime/capabilities/source details, exact source labels, only runtime-compatible choices, active-task disabled state, idle confirmation that changes only future calls, task-only override persistence, and no global policy mutation.

**Step 2 — prove red:** Run quick-switcher, InputBar, and workspace-controller tests.

**Step 3 — implement minimally:** Load the effective selection through preload, render the quick switcher, bind current task state, and send trusted IDs as intent for main re-resolution.

**Step 4 — prove green:** Re-run affected Renderer suites, typecheck, and lint.

## Task 10: Security regression, full verification, and production Electron acceptance

**Files:**

- Create: `scripts/electron-model-provider-acceptance.mjs`
- Create/modify focused security tests under `src/main/model-providers/__tests__`, `src/main/ipc/__tests__`, and diagnostics tests
- Modify: `package.json`

**Step 1 — complete the requested test matrix:** Count Provider CRUD, Credential, Connection, Migration, Agent Policy, Task Override, Security, and UI cases; add boundary cases until each requested category is represented without empty parametrized padding.

**Step 2 — run focused security verification:** Assert sentinel credentials are absent from DTOs, logs, SQLite text columns, diagnostics, process arguments, task/workflow events, and rendered text; assert raw OpenAI selections never call `ClaudeCliAdapter`.

**Step 3 — run all gates:** `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`. Fix root causes, then repeat all four from clean process state.

**Step 4 — run production Electron acceptance:** Start the built `dist/main/index.js` through Electron; navigate settings; add/test/save MiMo and a local deterministic OpenAI-compatible fixture; inspect capabilities/health/models; set defaults/policies/task override; verify stage selections; block DeepSeek-style OpenAI Workflow selection; restart; verify persistence; delete with credential confirmation; export diagnostics; scan UI/logs/database/diagnostics/arguments for the sentinel.

**Step 5 — bind evidence:** Record production artifact paths, SHA-256 hashes, sizes, modification times, acceptance timestamps, scenario results, and sanitized failure categories in the report. Never include provider secrets.

**Step 6 — final review:** Run `git diff --check`, inspect only relevant diffs against the dirty baseline, search for `secret|apiKey|credential_ref|Authorization` flows, and use `superpowers:verification-before-completion` before any passing/completion claim.

