# Task 14 Beta Experience Gap-Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining first-run, settings, model-switching, large-model-list, i18n, and production-acceptance gaps without replacing the existing Provider, tier, preset, policy, credential, or runtime architecture.

**Architecture:** Persist only a closed first-run resume-step enum in the existing `settings` table through dedicated trusted IPC; keep credentials in `CredentialStore` and Provider facts in `ModelProviderService`. Extend existing DTOs and existing UI components for runtime facts and switcher context, and keep all selection/capability decisions authoritative in the main process.

**Tech Stack:** Electron 35, React 19, TypeScript 5.8, Zod 4, better-sqlite3 13, Vitest 3, existing typed i18n and public IPC envelope.

## Global Constraints

- Work only in `C:\Users\zrcxw\Projects\ClaudeWorkbench-task14` on branch `task14`; never change the stable `main` worktree.
- Keep `ClaudeCliAdapter` as the only implemented Agent Runtime.
- Reuse `ModelProviderService`, `CredentialStore`, `ModelTierService`, `AgentPresetService`, `ModelSelectionResolver`, and schema v7.
- Never return or persist API keys, credential references, vault paths, authenticated URLs, raw network responses, or child environments in the new public state.
- Preserve selection priority and frozen Workflow model snapshots.
- All new user-visible text must exist in both `zh-CN` and `en-US` dictionaries.

---

### Task 1: Resumable First Run and explicit welcome/reopen flow

**Files:**
- Modify: `src/shared/types/ipc.ts`
- Modify: `src/main/ipc/settings.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/public-api-facade.ts`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/features/first-run/FirstRunWizard.tsx`
- Modify: `src/renderer/features/settings/SettingsDialog.tsx`
- Modify: `src/renderer/i18n/zh-CN.ts`
- Modify: `src/renderer/i18n/en-US.ts`
- Test: existing first-run, settings IPC, preload, public API, App, and Settings tests

**Interfaces:**
- Produces: `FirstRunResumeStep = 'welcome' | 'environment' | 'provider' | 'project' | 'first_task'`.
- Produces: `getFirstRunResumeStep(): Promise<FirstRunResumeStep>` and `setFirstRunResumeStep(step): Promise<void>`.
- Consumes: existing `firstRunCompletedVersion`; completion remains version `1` and no schema migration is added.

- [ ] **Step 1: Write failing tests**

```ts
it('restores only a closed non-secret resume step after restart', async () => {
  await invoke(IPC_CHANNELS.FIRST_RUN_SET_RESUME_STEP, 'provider');
  await expect(invoke(IPC_CHANNELS.FIRST_RUN_GET_RESUME_STEP)).resolves.toBe('provider');
  expect(database.getSetting('firstRunResumeStep')).toBe('provider');
});

it('starts with product disclosure and reopens from About at welcome', async () => {
  render(<FirstRunWizard initialStep="welcome" {...props} />);
  expect(screen.getByText('Claude Workbench 是一个本地优先的多模型 Agent 开发工作台')).toBeVisible();
});
```

- [ ] **Step 2: Run focused tests and observe expected missing-contract failures**

Run: `npm exec vitest -- run src/main/ipc/__tests__/settings.test.ts src/preload/__tests__/index.test.ts src/preload/__tests__/transport-surface.test.ts src/renderer/features/first-run/__tests__/FirstRunWizard.test.tsx src/renderer/features/settings/__tests__/SettingsNavigation.test.tsx`

- [ ] **Step 3: Implement the minimal closed state and welcome page**

```ts
const firstRunResumeStepSchema = z.enum(['welcome', 'environment', 'provider', 'project', 'first_task']);
// Persist only this enum. Provider credentials remain owned by CredentialStore.
```

Every forward/back transition persists the destination step before presenting it. Completion persists version `1`; “rerun setup” writes `welcome`, closes Settings, and reopens the existing wizard.

- [ ] **Step 4: Re-run the focused tests and confirm green**

- [ ] **Step 5: Inspect the public surface for secret-shaped fields and duplicate wizard/provider components**

---

### Task 2: Environment summary, settings information architecture, and About runtime facts

**Files:**
- Modify: `src/shared/types/ipc.ts`
- Modify: `src/main/ipc/system.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/release/VersionInfo.ts`
- Modify: `src/renderer/features/first-run/FirstRunWizard.tsx`
- Modify: `src/renderer/features/settings/SettingsDialog.tsx`
- Modify: `src/renderer/i18n/zh-CN.ts`
- Modify: `src/renderer/i18n/en-US.ts`
- Test: system IPC, release/version, first-run, About, and settings-navigation tests

**Interfaces:**
- Extends `EnvironmentCheckResult` with data-directory, SQLite, runnable-Provider, and conditional build-tools facts computed in main.
- Extends `ReleaseVersionInfo` with `nodeVersion`, `sqliteSchemaVersion`, and `agentRuntime`; About reads the data directory from existing `AppSettings.dataPath` so private paths never enter diagnostic version metadata.

- [ ] **Step 1: Write failing tests for fail-closed facts and exact settings categories**

```ts
expect(result.sqlite).toEqual({ ok: true, schemaVersion: 7 });
expect(result.agentProviders.runnableCount).toBe(1);
expect(result.buildTools.required).toBe(false);
expect(screen.getByRole('button', { name: '终端与工具' })).toBeVisible();
expect(screen.getByText('claude-code')).toBeVisible();
```

- [ ] **Step 2: Run focused tests and verify red**

Run: `npm exec vitest -- run src/main/ipc/__tests__/system.test.ts src/main/release/__tests__/VersionInfo.test.ts src/renderer/features/settings/__tests__/SettingsNavigation.test.tsx src/renderer/features/first-run/__tests__/FirstRunWizard.test.tsx`

- [ ] **Step 3: Add read-only main-process facts and split existing settings sections**

Use callbacks passed at startup for `db.getDiagnosticsSummary()`, runnable Provider count, `dataRoot`, and `app.isPackaged`. Add `project` and `terminal_tools` categories by moving existing project/Git/terminal sections; do not duplicate their controls.

- [ ] **Step 4: Re-run focused tests and verify zh-CN/en-US parity**

- [ ] **Step 5: Confirm no About DTO contains credential/vault/source-path lists**

---

### Task 3: Quick Switcher context and localized fail-closed presentation

**Files:**
- Modify: `src/shared/types/projectAi.ts`
- Modify: `src/main/model-providers/ProjectAiConfigurationService.ts`
- Modify: `src/main/ipc/model-providers.ts`
- Modify: `src/renderer/features/models/ModelQuickSwitcher.tsx`
- Modify: `src/renderer/features/models/useModelProviderToolbar.ts`
- Modify: `src/renderer/i18n/zh-CN.ts`
- Modify: `src/renderer/i18n/en-US.ts`
- Test: Project AI, model-provider IPC, toolbar loader, and switcher tests

**Interfaces:**
- Extends task switcher data with trusted connection state, whether the current source is a task override, and a safe project-policy summary.
- Keeps mutation input restricted to `{taskId, providerId, modelId}`.

- [ ] **Step 1: Write failing tests for Provider/Model/Runtime/capabilities/source/override/project-policy/connection details and no OpenAI candidate**

- [ ] **Step 2: Run focused tests and verify red**

- [ ] **Step 3: Extend the existing safe projection and remove hard-coded Chinese/English from the component**

```ts
interface TaskModelSwitcherContextPublic {
  taskOverrideActive: boolean;
  projectPolicyConfigured: boolean;
  connectionState: 'connected' | 'not_tested' | 'error' | 'inherited';
}
```

- [ ] **Step 4: Re-run switcher, IPC, and selection tests**

- [ ] **Step 5: Reconfirm active tasks remain main-process blocked and frozen**

---

### Task 4: Searchable bounded model list without Provider duplication

**Files:**
- Modify: `src/renderer/features/settings/ModelProviderCenter.tsx`
- Modify: `src/renderer/i18n/zh-CN.ts`
- Modify: `src/renderer/i18n/en-US.ts`
- Test: Provider Center renderer tests

**Interfaces:**
- Consumes the existing lazy `listModelProviderModels(providerId)` result.
- Produces only local search/filter state and a fixed-height windowed list; no new credential or Provider API.

- [ ] **Step 1: Write failing tests for search, stable keys, bounded rendered rows, keyboard focus, and late Provider response isolation**

- [ ] **Step 2: Run Provider Center tests and verify red**

- [ ] **Step 3: Implement memoized filtering and fixed-row virtualization inside existing Provider details**

```ts
const filteredModels = useMemo(
  () => models.filter((model) => `${model.displayName ?? ''}\n${model.modelId}`.toLocaleLowerCase().includes(query)),
  [models, query],
);
```

- [ ] **Step 4: Re-run Provider Center, i18n, and accessibility tests**

---

### Task 5: Verification, production Electron acceptance, and exact commit

**Files:**
- Modify if required by new UI contract: `scripts/electron-beta-readiness-acceptance.mjs`
- Keep generated reports/screenshots under ignored `dist/`; do not stage them.

- [ ] **Step 1: Run all focused First Run, Provider, tier, preset, Project AI, runtime, IPC, credential, and security suites**
- [ ] **Step 2: Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` in that order**
- [ ] **Step 3: Run `npm run test:electron:beta-readiness -- --skip-build` with isolated user data and inspect renderer-error/privacy evidence**
- [ ] **Step 4: Run `git diff --check`, credential scans, `git status --short`, and `git diff --stat`; verify the stable `main` worktree is unchanged**
- [ ] **Step 5: Stage only source/tests/docs and commit exactly `feat(onboarding): complete beta model setup experience` without push or merge**
