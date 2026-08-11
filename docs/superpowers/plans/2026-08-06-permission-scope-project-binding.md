# Permission Scope and Project Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make “本任务允许此类操作” a real task/workflow-scoped grant while preserving fail-closed command, path, bypass, Git, and mutation boundaries.

**Architecture:** Keep per-process broker credentials isolated, but move reusable authorization out of `RegisteredRun` into an in-memory `TaskPermissionContext` keyed by task/workflow/canonical project identity. Classify Bash requests into structured capabilities, persist only explicitly safe project rules in SQLite, and bind every permission/Git/checkpoint/diff operation to the same canonical project root. Cross-project commands never inherit ordinary rules and require a scoped external-root grant or a safe project switch/restart flow.

**Tech Stack:** Electron 35, TypeScript 5.8, React 19, Vitest, better-sqlite3, zod, Claude Code permission MCP.

## Global Constraints

- Do not add Agent roles, installer, updater, plugin, cloud, or collaboration features.
- Do not enable `bypassPermissions` by default or expose a renderer bypass path.
- Preserve Permission MCP, PermissionBroker, PermissionAudit, TaskManager, AgentWorkflowManager, FileMutationManager, Checkpoint, Git Workspace, and Session history contracts.
- High-risk, destructive, credential, arbitrary-shell, outside-project unrestricted, publish/push, system-directory, and elevation requests are never auto-allowed by ordinary rules.
- Project rules are main-process owned; renderer IPC receives schema-validated DTOs and never writes SQLite directly.
- The repository currently has no initial commit and all existing files are staged; do not commit, reset, unstage, or overwrite unrelated files.
- Production changes follow RED → GREEN → REFACTOR, with the failing command and expected failure recorded before implementation.

---

## Reuse Report

已有实现：`PermissionBroker.registerRun/decide/completeRun`, `PermissionAudit`, `canonicalizeProjectPath`, `SafePathPolicy`, `TaskManager` terminal finalization, `AgentWorkflowManager.finalizeTerminal`, project settings IPC, `GitWorkspaceService`, permission settlement persistence.

文件：`src/main/permissions/PermissionBroker.ts`, `src/main/permissions/PermissionAudit.ts`, `src/main/projects/ProjectService.ts`, `src/main/file-changes/SafePathPolicy.ts`, `src/main/tasks/TaskManager.ts`, `src/main/workflows/AgentWorkflowManager.ts`, `src/main/ipc/projects.ts`, `src/main/database/Database.ts`, `src/main/git/GitWorkspaceService.ts`.

可复用：loopback bearer-token isolation remains per run; canonical realpath/case folding remains the path identity; TaskManager/Workflow terminal hooks own task-rule cleanup; project settings IPC provides the validated main-process management pattern; permission settlements remain the task/audit source.

选择：改造。

理由：The broken behavior is caused by authorization state living at the wrong lifetime and matching the wrong unit. Replacing the broker or adding a second model/tool invocation system would duplicate trusted boundaries. The smallest complete fix keeps transport isolation and changes only rule evaluation, lifecycle, persistence, and renderer semantics.

搜索范围：permission decisions/fingerprints/run registration, workflow stage run IDs, Claude process spawning, project path canonicalization, SQLite permissions/recovery tables, settings IPC, Git status rendering, checkpoint path handling, and related tests.

其他候选：Claude native `--permission-mode` and global bypass were rejected because they weaken or bypass Workbench policy; process/session-only caches were rejected because stages create new processes/runs; full command hashes remain useful only as audit evidence, not task capability matching.

---

### Task 1: Structured permission analysis and safe rule contracts

**Files:**
- Create: `src/main/permissions/PermissionRuleEngine.ts`
- Create: `src/main/permissions/__tests__/PermissionRuleEngine.test.ts`
- Modify: `src/shared/types/permissionBroker.ts`

**Interfaces:**
- Produces: `PermissionCapability`, `PermissionRuleScope`, `PermissionAnalysis`, `PermissionRule`, `analyzePermissionRequest()`, `canPersistProjectRule()`, `permissionRuleMatches()`.
- Consumes: `canonicalizeProjectPath()` and `SafePathPolicy` realpath semantics.

- [ ] **Step 1: Write failing classifier and path-boundary tests**

```ts
expect(analyzePermissionRequest('Bash', { command: 'npm test' }, root).capability)
  .toBe('shell.test');
expect(analyzePermissionRequest('Bash', { command: 'npm install' }, root).capability)
  .toBe('shell.package_install');
expect(analyzePermissionRequest('Bash', { command: `cd "${other}" && npm test` }, root))
  .toMatchObject({ capability: 'shell.test', outsideProject: true, effectiveCwd: canonicalOther });
expect(canPersistProjectRule(destructiveAnalysis)).toBe(false);
```

- [ ] **Step 2: Run RED**

```powershell
npx vitest run src/main/permissions/__tests__/PermissionRuleEngine.test.ts
```

Expected: fail because the structured rule engine and types do not exist.

- [ ] **Step 3: Implement conservative classification**

```ts
export interface PermissionAnalysis {
  capability: PermissionCapability;
  risk: PermissionRisk;
  canonicalProjectPath: string;
  effectiveCwd: string;
  targetPaths: string[];
  externalRoot: string | null;
  outsideProject: boolean;
  cacheableForTask: boolean;
  persistableForProject: boolean;
  normalizedRule: string;
}
```

Use precedence `destructive/credential/system/elevation/publish/high-risk-git` → `unknown` → write/network/install/git mutation → test/build/run/read. Any parse ambiguity or path-resolution failure is fail-closed and non-cacheable. Resolve existing targets through realpath so symlink/junction escape cannot appear project-local.

- [ ] **Step 4: Run GREEN and mutation-check capability boundaries**

```powershell
npx vitest run src/main/permissions/__tests__/PermissionRuleEngine.test.ts
```

Expected: tests cover Windows case/slashes, test vs install, build vs destructive, risk escalation, external roots, credentials, bypass, Git force/reset, publish, and unknown commands.

---

### Task 2: TaskPermissionContext across Claude runs and workflow stages

**Files:**
- Modify: `src/main/permissions/PermissionBroker.ts`
- Modify: `src/main/claude/ClaudeCliAdapter.ts`
- Modify: `src/main/tasks/TaskManager.ts`
- Modify: `src/main/workflows/TaskManagerAgentStageRunner.ts`
- Modify: `src/main/workflows/contracts.ts`
- Modify: `src/main/workflows/AgentWorkflowManager.ts`
- Modify: `src/main/index.ts`
- Modify: `src/shared/types/claude.ts`
- Test: `src/main/permissions/__tests__/PermissionBroker.test.ts`
- Test: `src/main/workflows/__tests__/TaskManagerAgentStageRunner.test.ts`
- Test: `src/main/tasks/__tests__/TaskManager.test.ts`
- Test: `src/main/workflows/__tests__/AgentWorkflowManager.test.ts`

**Interfaces:**
- Produces: `TaskPermissionIdentity`, `TaskPermissionContext`, `PermissionBroker.completeTask()`, and run registration containing task/workflow/project identity.
- Consumes: Task 1 rule analysis and existing per-run bearer tokens.

- [ ] **Step 1: Replace the old cross-run-negative characterization with failing task-scope tests**

```ts
broker.registerRun(run('coder-1', taskIdentity));
await approveFirst('allow_for_task', { command: 'npm test' });
broker.completeRun('coder-1');
broker.registerRun(run('tester-1', taskIdentity));
expect(await request({ command: 'npx vitest' })).toMatchObject({ behavior: 'allow' });
expect(rendererRequests).toHaveLength(1);
```

Add failures for a new task, different project, risk escalation, task completion, stop, parallel projects, rapid switching, bypass, and external-root containment.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run src/main/permissions/__tests__/PermissionBroker.test.ts src/main/workflows/__tests__/TaskManagerAgentStageRunner.test.ts src/main/tasks/__tests__/TaskManager.test.ts src/main/workflows/__tests__/AgentWorkflowManager.test.ts
```

Expected: fail because decisions only support `allow_for_session`, cache state lives inside `RegisteredRun`, and stage registrations omit task/workflow identity.

- [ ] **Step 3: Implement task-scoped rule lookup**

```ts
export interface TaskPermissionContext {
  taskId: string;
  workflowId?: string;
  projectPath: string;
  allowedRules: PermissionRule[];
  externalRoots: string[];
  createdAt: number;
}
```

Keep `token` and HTTP credentials in `RegisteredRun`; remove `sessionAllowFingerprints`. Evaluate task rules, then project rules, then non-cacheable/risk/path escalation. `completeRun()` removes only process credentials. `completeTask()` clears the task context. Workflow terminal states call `completeTask`; standalone TaskManager terminals call it directly. App restart restores no task rules.

- [ ] **Step 4: Bind process evidence and emit auto-allow settlements**

```ts
permissionBroker.bindProcess(runId, child.pid ?? null);
```

Every request/audit projection includes workflowId, taskId, runId, sessionId, processId, capability, normalized rule, canonical project, effective cwd, target paths, risk, cache key, and miss reason without secrets. Auto hits emit `permission_auto_allowed` evidence without sending a renderer request.

- [ ] **Step 5: Run GREEN**

```powershell
npx vitest run src/main/permissions/__tests__/PermissionBroker.test.ts src/main/workflows/__tests__/TaskManagerAgentStageRunner.test.ts src/main/tasks/__tests__/TaskManager.test.ts src/main/workflows/__tests__/AgentWorkflowManager.test.ts
```

---

### Task 3: Persistent project rules, audit records, and permission statistics

**Files:**
- Modify: `src/main/database/Database.ts`
- Create: `src/main/permissions/DatabasePermissionRuleStore.ts`
- Modify: `src/main/permissions/PermissionAudit.ts`
- Modify: `src/main/tasks/TaskEventRecorder.ts`
- Modify: `src/main/tasks/TaskQueryService.ts`
- Modify: `src/shared/types/workbench.ts`
- Modify: `src/shared/types/ipc.ts`
- Modify: `src/main/ipc/permissions.ts`
- Modify: `src/preload/index.ts`
- Test: `src/main/database/__tests__/DatabaseReleaseMigration.test.ts`
- Test: `src/main/permissions/__tests__/PermissionAudit.test.ts`
- Test: `src/main/ipc/__tests__/permissions.test.ts`
- Test: `src/main/tasks/__tests__/TaskQueryService.persistence.test.ts`

**Interfaces:**
- Produces: schema v5 `project_permission_rules`; richer `permission_requests`; CRUD/page APIs; `PermissionStats`.
- Consumes: Task 1 project-rule allowlist and Task 2 auto-allow settlements.

- [ ] **Step 1: Write failing migration/store/audit/stat tests**

```ts
expect(db.listProjectPermissionRules(projectId, { limit: 50, offset: 0 }).items)
  .toEqual([expect.objectContaining({ capability: 'shell.test', enabled: true })]);
expect(snapshot.permissionStats).toEqual({
  total: 12, userAllowed: 1, autoAllowed: 9, denied: 1,
  timedOut: 0, unsupported: 0, policyBlocked: 1,
});
```

- [ ] **Step 2: Run RED**

```powershell
npx vitest run src/main/database/__tests__/DatabaseReleaseMigration.test.ts src/main/permissions/__tests__/PermissionAudit.test.ts src/main/ipc/__tests__/permissions.test.ts src/main/tasks/__tests__/TaskQueryService.persistence.test.ts
```

- [ ] **Step 3: Add transactional v5 migration and store**

Project rules bind `project_id + canonical_project_path + tool_name + capability + command_pattern + risk_ceiling`; include enabled, source, created/updated/last-hit timestamps, and hit count. Reject unsafe persisted rules again at the store boundary. Migration performs foreign-key and integrity checks inside the existing transaction.

- [ ] **Step 4: Add main-process CRUD and audit pagination**

```ts
listProjectPermissionRules(projectId, page)
setProjectPermissionRuleEnabled(projectId, ruleId, enabled)
deleteProjectPermissionRule(projectId, ruleId)
clearProjectPermissionRules(projectId)
listPermissionAudit(projectId, page)
```

Every handler reloads the project by ID, re-canonicalizes its stored path, validates IDs/page/schema, and never accepts a renderer-supplied canonical root.

- [ ] **Step 5: Run GREEN**

```powershell
npx vitest run src/main/database/__tests__/DatabaseReleaseMigration.test.ts src/main/permissions/__tests__/PermissionAudit.test.ts src/main/ipc/__tests__/permissions.test.ts src/main/tasks/__tests__/TaskQueryService.persistence.test.ts
```

---

### Task 4: Permission dialog semantics and project-rule management UI

**Files:**
- Modify: `src/renderer/features/permissions/PermissionDialog.tsx`
- Modify: `src/renderer/features/permissions/__tests__/PermissionDialog.test.ts`
- Modify: `src/renderer/features/projects/ProjectSettingsDialog.tsx`
- Create: `src/renderer/features/projects/ProjectPermissionRules.tsx`
- Create: `src/renderer/features/projects/__tests__/ProjectPermissionRules.test.tsx`
- Modify: `src/renderer/features/chat/TaskResultCard.tsx`
- Modify: `src/renderer/App.tsx`

**Interfaces:**
- Consumes: enriched `PermissionRequest`, four decisions, project rule/audit IPC, and `PermissionStats`.
- Produces: exact labels and scope explanations; no direct persistence.

- [ ] **Step 1: Write failing renderer behavior tests**

```tsx
expect(screen.getByRole('button', { name: '本任务允许此类操作' })).toBeEnabled();
expect(screen.queryByRole('button', { name: '此项目始终允许此规则' })).not.toBeInTheDocument();
expect(screen.getByText('跨项目访问')).toBeInTheDocument();
expect(screen.getByText(/当前项目/)).toHaveTextContent(projectA);
expect(screen.getByText(/实际工作目录/)).toHaveTextContent(projectB);
```

- [ ] **Step 2: Run RED**

```powershell
npx vitest run src/renderer/features/permissions/__tests__/PermissionDialog.test.ts src/renderer/features/projects/__tests__/ProjectPermissionRules.test.tsx src/renderer/features/chat/__tests__/TaskResultCard.test.ts
```

- [ ] **Step 3: Implement exact scope choices**

Normal requests show 允许一次 / 本任务允许此类操作 / 此项目始终允许此规则 / 拒绝. Hide or disable project persistence with a reason when analysis says non-persistable. Cross-project requests replace the ordinary task button with a task-scoped external-root grant and expose a safe “切换目标项目并停止当前任务” action when the target is registered. Bypass remains the independent native high-risk flow.

- [ ] **Step 4: Implement rule/audit settings and statistics**

Project Settings lists tool, capability, pattern, ceiling, created/last-hit/hit count/source with pause/delete/clear actions. Task results display total, user allow, auto allow, deny, timeout, unsupported, and policy-blocked counts; individual denials remain inspectable rather than collapsing to “权限未授予 Bash”.

- [ ] **Step 5: Run GREEN**

```powershell
npx vitest run src/renderer/features/permissions/__tests__/PermissionDialog.test.ts src/renderer/features/projects/__tests__/ProjectPermissionRules.test.tsx src/renderer/features/chat/__tests__/TaskResultCard.test.ts
```

---

### Task 5: Canonical project preflight and Git non-repository state

**Files:**
- Create: `src/main/projects/ProjectExecutionContext.ts`
- Modify: `src/main/ipc/projects.ts`
- Modify: `src/renderer/features/chat/InputBar.tsx`
- Create: `src/renderer/features/projects/ProjectPathMismatchDialog.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/features/git/WorkspaceRightDrawer.tsx`
- Modify: `src/renderer/features/git/gitPanelModel.ts`
- Test: `src/main/projects/__tests__/ProjectExecutionContext.test.ts`
- Test: `src/main/ipc/__tests__/workflows.test.ts`
- Test: `src/renderer/features/chat/__tests__/WorkflowIntegration.test.ts`
- Test: `src/renderer/features/git/__tests__/gitPanelModel.test.ts`

**Interfaces:**
- Produces: `assertExecutionProjectIdentity()` and prompt-target preflight for registered project roots.
- Consumes: selected project, task/session/project rows, workflow path, Claude cwd, Git/checkpoint/diff/mutation paths.

- [ ] **Step 1: Write failing identity and Git-state tests**

```ts
expect(() => assertExecutionProjectIdentity({
  selectedProjectPath: projectA,
  taskProjectPath: projectA,
  workflowProjectPath: projectA,
  claudeCwd: projectB,
})).toThrow(/canonical project root/);
expect(gitPanelState({ status: null, errorCode: 'NOT_A_REPOSITORY' }).kind)
  .toBe('not_repository');
```

- [ ] **Step 2: Run RED**

```powershell
npx vitest run src/main/projects/__tests__/ProjectExecutionContext.test.ts src/main/ipc/__tests__/workflows.test.ts src/renderer/features/chat/__tests__/WorkflowIntegration.test.ts src/renderer/features/git/__tests__/gitPanelModel.test.ts
```

- [ ] **Step 3: Enforce one canonical root before spawn**

Main-process preflight reloads project/session/task/workflow identities and asserts Claude cwd, Git, Checkpoint, Diff, and FileMutation roots match. Renderer-supplied fields are claims only. A prompt that clearly names another registered root is blocked before workflow creation and shown in a switch dialog; confirming selects the target project before creating the task. An unanticipated external `cd` remains a permission-time scoped external-root decision.

- [ ] **Step 4: Render mutually exclusive Git states**

`not_repository` shows only 当前项目不是 Git 仓库, open-in-Explorer, close panel, and a controlled initialize-Git action if implemented through TaskManager/FileMutationManager. `detached` is rendered only when a valid repository status has `detached === true`. Git accept/commit/checkpoint actions remain disabled for non-repositories; file-only checkpoint wording must not claim Git semantics.

- [ ] **Step 5: Run GREEN**

```powershell
npx vitest run src/main/projects/__tests__/ProjectExecutionContext.test.ts src/main/ipc/__tests__/workflows.test.ts src/renderer/features/chat/__tests__/WorkflowIntegration.test.ts src/renderer/features/git/__tests__/gitPanelModel.test.ts
```

---

### Task 6: Production Electron reproduction and acceptance A-F

**Files:**
- Create: `scripts/electron-permission-scope-acceptance.mjs`
- Modify: `package.json`
- Create runtime artifact: `release-validation/electron-permission-scope-before.json`
- Create runtime artifact: `release-validation/electron-permission-scope-final.json`

**Interfaces:**
- Consumes: production `dist`, real PermissionBroker, real Agent stage process creation, project rules, audit IPC, Git/checkpoint/diff UI.
- Produces: bounded JSON evidence with no secrets or full sensitive arguments.

- [ ] **Step 1: Add the pre-fix production reproducer before production changes**

The harness records workflowId/taskId/runId/sessionId/processId/requestId/tool/capability/project/cwd/target/risk/cache key and miss reason. First Bash uses `allow_for_task`; subsequent same-stage and new-stage safe test commands must currently create new dialogs, proving the bug.

- [ ] **Step 2: Run the pre-fix reproducer and save failure evidence**

```powershell
npm run build
node scripts/electron-permission-scope-acceptance.mjs --baseline
```

Expected: nonzero acceptance result with evidence that per-run deletion and exact-input fingerprints caused repeated prompts.

- [ ] **Step 3: Run focused security closure and bypass review**

```powershell
npx vitest run src/main/permissions src/main/ipc/__tests__/permissions.test.ts src/main/ipc/__tests__/workflows.test.ts src/main/projects src/renderer/features/permissions src/renderer/features/git
```

- [ ] **Step 4: Run production scenarios A-F**

```powershell
npm run build
node scripts/electron-permission-scope-acceptance.mjs
```

Expected: task grant removes same-task Coder/Tester/Fix repeated prompts; new task asks; persisted project test rule survives restart and deletion restores prompting; install/destructive risk escalation asks; external root B does not authorize root C; selected project/Git/checkpoint/diff remain aligned; non-Git never shows Detached HEAD.

- [ ] **Step 5: Run full final gates**

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

- [ ] **Step 6: Inspect artifacts and final changed-file scope**

Confirm the original reproducer no longer reproduces, legitimate one-shot and safe project-rule behavior remains, bypass still requires trusted native confirmation, task contexts disappear on terminal/restart, and no user project or unrelated staged file was changed.

