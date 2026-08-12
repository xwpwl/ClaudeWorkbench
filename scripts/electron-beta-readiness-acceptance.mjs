import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import electron from 'electron';
import extract from 'extract-zip';
import { CdpClient, waitForCdpPage } from './lib/cdp-client.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(SCRIPT_DIR, '..');
const SCREENSHOT_ROOT = path.join(WORKSPACE_ROOT, 'dist', 'beta-readiness-acceptance-screenshots');
const REPORT_PATH = path.join(WORKSPACE_ROOT, 'dist', 'beta-readiness-acceptance-report.json');
const TEMP_PREFIX = 'claude-workbench-beta-readiness-acceptance-';
const DIAGNOSTICS_TITLE = 'Export Claude Workbench diagnostics';
const STEP_TIMEOUT_MS = 60_000;
const ROLES = Object.freeze(['planner', 'coder', 'tester', 'reviewer', 'fixer']);
const TIERS = Object.freeze(['high_quality', 'balanced', 'fast']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const OWNED_TEMP_ROOTS = new Set();
const BACKEND_ENVIRONMENT_KEYS = Object.freeze([
  'FORCE_FAKE',
  'WORKBENCH_FORCE_FAKE_CLAUDE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ROLE_ARN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_API_KEY',
  'VERTEX_API_KEY',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_VERTEX_REGION',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'AZURE_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_TENANT_ID',
]);
const ROLE_MAP = Object.freeze({
  planner: 'high_quality',
  coder: 'balanced',
  tester: 'fast',
  reviewer: 'high_quality',
  fixer: 'balanced',
});
const DIAGNOSTICS_FILE_PATTERN = /^ClaudeWorkbench-diagnostics-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.zip$/u;
const NATIVE_SAVE_NAME_PATTERN = /^(?:Save|保存)(?:\([^)]*\))?$/u;
const DATA_SCREENSHOT_PATH_MASK = '[private data path hidden for screenshot]';

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32'
    ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US')
    : a === b;
}

function assertOrdinaryExistingPath(target) {
  const stat = fs.lstatSync(target);
  assert(!stat.isSymbolicLink(), `Path must be ordinary, not symbolic/reparse: ${target}`);
  assert(stat.isDirectory(), `Path must be an ordinary directory: ${target}`);
}

function resolveNativeDialogUserProfile(base = process.env) {
  const candidate = path.resolve(base.USERPROFILE || os.homedir());
  assertOrdinaryExistingPath(candidate);
  return candidate;
}

function validateScreenshotRoot(workspaceRoot, candidate) {
  const workspace = path.resolve(workspaceRoot);
  const expected = path.join(workspace, 'dist', 'beta-readiness-acceptance-screenshots');
  const target = path.resolve(candidate);
  assert(samePath(target, expected), 'Screenshot output is not the exact fixed owned directory.');
  assert(path.basename(target) === 'beta-readiness-acceptance-screenshots', 'Screenshot basename is not exact.');
  assert(samePath(path.dirname(path.dirname(target)), workspace), 'Screenshot workspace parent is not exact.');
  assertOrdinaryExistingPath(workspace);
  assertOrdinaryExistingPath(path.dirname(target));
  if (fs.existsSync(target)) assertOrdinaryExistingPath(target);
  return true;
}

function removeScreenshotRoot(workspaceRoot, candidate) {
  validateScreenshotRoot(workspaceRoot, candidate);
  if (!fs.existsSync(candidate)) return true;
  fs.rmSync(path.resolve(candidate), { recursive: true, force: false, maxRetries: 5, retryDelay: 50 });
  assert(!fs.existsSync(candidate), 'Exact screenshot directory still exists after cleanup.');
  return true;
}

function createIsolatedFixture(parent = os.tmpdir()) {
  const container = path.resolve(parent);
  assertOrdinaryExistingPath(container);
  const root = fs.mkdtempSync(path.join(container, TEMP_PREFIX));
  const dataRoot = path.join(root, 'workbench-data');
  const browserRoot = path.join(root, 'chromium-user-data');
  const claudeConfigRoot = path.join(root, 'claude-config');
  const isolatedHome = path.join(root, 'isolated-home');
  const appData = path.join(root, 'app-data');
  const localAppData = path.join(root, 'local-app-data');
  const runtimeTemp = path.join(root, 'runtime-temp');
  const projectParent = path.join(root, 'projects');
  const nativeDialogUserProfile = resolveNativeDialogUserProfile();
  for (const directory of [dataRoot, browserRoot, claudeConfigRoot, isolatedHome, appData, localAppData, runtimeTemp, projectParent]) {
    fs.mkdirSync(directory);
    assertOrdinaryExistingPath(directory);
  }
  OWNED_TEMP_ROOTS.add(root);
  return { root, dataRoot, browserRoot, claudeConfigRoot, isolatedHome, appData, localAppData, runtimeTemp,
    projectParent, nativeDialogUserProfile };
}

function buildChildEnvironment(base, fixture) {
  const environment = {
    ...base,
    NODE_ENV: 'production',
    WORKBENCH_DATA_DIR: fixture.dataRoot,
    HOME: fixture.isolatedHome ?? fixture.root,
    USERPROFILE: fixture.isolatedHome ?? fixture.root,
    APPDATA: fixture.appData ?? fixture.root,
    LOCALAPPDATA: fixture.localAppData ?? fixture.root,
    TEMP: fixture.runtimeTemp ?? fixture.root,
    TMP: fixture.runtimeTemp ?? fixture.root,
    XDG_CONFIG_HOME: path.join(fixture.isolatedHome ?? fixture.root, '.config'),
    CLAUDE_CONFIG_DIR: fixture.claudeConfigRoot,
  };
  for (const key of [
    ...BACKEND_ENVIRONMENT_KEYS,
    'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'VITE_DEV_SERVER_URL', 'WORKBENCH_OPEN_DEVTOOLS',
  ]) delete environment[key];
  return environment;
}

function buildElectronChildEnvironment(base, fixture) {
  const environment = buildChildEnvironment(base, fixture);
  const nativeDialogUserProfile = fixture.nativeDialogUserProfile ?? resolveNativeDialogUserProfile(base);
  assertOrdinaryExistingPath(nativeDialogUserProfile);
  environment.HOME = nativeDialogUserProfile;
  environment.USERPROFILE = nativeDialogUserProfile;
  return environment;
}

function runtimeFacts() {
  return { runtime: 'ClaudeCliAdapter', gatewayConversion: false };
}

function exactPresetFacts() {
  return { ...ROLE_MAP };
}

function bindOneModelForAllTiers(candidate) {
  assert(typeof candidate?.providerId === 'string' && candidate.providerId.length > 0, 'Provider identity is missing.');
  assert(typeof candidate?.modelId === 'string' && candidate.modelId.length > 0, 'Model identity is missing.');
  return ['high_quality', 'balanced', 'fast'].map((tier) => [tier, candidate.providerId, candidate.modelId]);
}

function eligibleTierCandidates(candidates) {
  return candidates.filter((candidate) => candidate.runtimeType === 'claude-code');
}

function assertSoleTierCandidate(candidates, providerId, modelId) {
  assert(Array.isArray(candidates) && candidates.length === 1, 'Tier wizard does not have exactly one candidate.');
  assert(candidates[0].providerId === providerId && candidates[0].modelId === modelId,
    'The sole tier candidate is not Provider A.');
  return true;
}

function assertWorkflowSelectionFacts(facts) {
  assert(facts?.currentBefore?.coder === 'B' && facts.currentBefore.fixer === 'B', 'Workflow A did not start on B.');
  assert(facts.currentAfterGlobalChange?.coder === 'B' && facts.currentAfterGlobalChange.fixer === 'B', 'Workflow A selection was not frozen.');
  assert(facts.next?.coder === 'A' && facts.next.fixer === 'A', 'Workflow B did not use changed global A.');
  assert(facts.uiFutureCallsOnly === true, 'Future-calls-only UI fact is missing.');
  assert(facts.runningSwitchBlockedUi === true && facts.runningSwitchBlockedMain === true,
    'Running model switch was not blocked by both UI and main.');
  return true;
}

function assertPrecedenceFacts(facts) {
  assert(JSON.stringify(facts?.roles) === JSON.stringify({
    planner: 'A', coder: 'B', tester: 'A', reviewer: 'A', fixer: 'B',
  }), 'Five-role resolution does not match the preset/tier facts.');
  assert(JSON.stringify(facts.sequence) === JSON.stringify([
    ['global_agent_policy', 'A'],
    ['project_policy', 'B'],
    ['task_override', 'A'],
    ['project_policy', 'B'],
    ['global_agent_policy', 'A'],
  ]), 'Global/project/task precedence sequence drifted.');
  assert(JSON.stringify(facts.tierSources) === JSON.stringify(['global', 'project']), 'Tier source evidence is incomplete.');
  return true;
}

function tierSourceFact(selection) {
  const hasTier = typeof selection?.tier === 'string';
  const hasSource = selection?.tierSource === 'global' || selection?.tierSource === 'project';
  assert(hasTier === hasSource, 'Tier and tierSource presence diverged.');
  return hasSource ? selection.tierSource : null;
}

function assertDisabledBindingFacts(facts) {
  assert(facts?.validity === 'needs_reconfiguration', 'Disabled binding did not require reconfiguration.');
  assert(facts.reason === 'provider_disabled', 'Disabled binding reason drifted.');
  assert(facts.previewBlocked === true && facts.templateApplyBlocked === true && facts.workflowBlocked === true,
    'Invalid binding did not block preview, template apply, and Workflow start.');
  assert(facts.fallbackUsed === false, 'Invalid binding silently fell back.');
  assert(facts.partialWrite === false, 'Invalid binding caused a partial write.');
  return true;
}

function closedDisabledBindingDiagnosticFact(bindings, evidence) {
  const exact = Array.isArray(bindings) && bindings.length === 3
    && bindings.every((item) => item?.validity === 'needs_reconfiguration'
      && item?.invalidReason === 'provider_disabled');
  return {
    bindingCount: Array.isArray(bindings) ? bindings.length : 0,
    validity: exact ? 'needs_reconfiguration' : 'unknown',
    reason: exact ? 'provider_disabled' : 'unknown',
    previewBlocked: evidence?.previewBlocked === true,
    templateApplyBlocked: evidence?.templateApplyBlocked === true,
    workflowBlocked: evidence?.workflowBlocked === true,
    fallbackUsed: evidence?.fallbackUsed === true,
    partialWrite: evidence?.workflowsUnchanged !== true,
  };
}

function assertDisabledTemplatePreviewFacts(prepare, preview) {
  assert(prepare?.step === 'bind_tiers', 'Disabled Provider did not block template preview preparation.');
  assert(JSON.stringify(prepare.missingTiers) === JSON.stringify(TIERS), 'Disabled template did not require all exact tiers.');
  assert(preview?.roles && JSON.stringify(Object.keys(preview.roles)) === JSON.stringify(ROLES),
    'Disabled template preview roles are incomplete.');
  for (const role of ROLES) {
    const resolution = preview.roles[role]?.resolution;
    assert(resolution?.validity === 'needs_reconfiguration' && resolution.invalidReason === 'provider_disabled'
      && resolution.candidate === null, `Disabled template role retained a fallback candidate: ${role}`);
  }
  return true;
}

function assertFirstRunPlanEvidence(facts) {
  assert(facts.workflowStatus === 'waiting_plan_confirmation', 'First Run Main workflow did not reach plan confirmation.');
  assert(facts.currentPermissionMode && facts.currentPermissionMode !== 'default', 'First Run workflow did not use a read-only permission mode.');
  assert(facts.uiReady === true, 'First Run owned dialog did not expose the plan-ready state.');
  return true;
}

function assertFirstRunGitInitializationFacts(facts) {
  assert(facts.firstRunStatus === 'waiting_plan_confirmation', 'First Run did not stop at plan confirmation.');
  assert(facts.permissionMode === 'plan', 'First Run persisted permission mode was not plan.');
  assert(facts.gitContextKind === 'not_repository', 'First Run Planner was not proven against a non-Git project.');
  assert(Array.isArray(facts.gitCheckpointTypes) && facts.gitCheckpointTypes.length === 0,
    'Non-Git First Run created a Git-backed checkpoint.');
  assert(facts.initializationMethod === 'visible_ui' && facts.repositoryUiTrusted === true,
    'Git initialization was not proven through the trusted visible UI.');
  const required = ['first_run_plan', 'first_run_finish', 'drawer_open', 'git_tab', 'git_initialize',
    'repository_ready', 'workflow_a_create'];
  let previous = -1;
  for (const phase of required) {
    const index = facts.phases.indexOf(phase);
    assert(index > previous, `Acceptance phase is missing or out of order: ${phase}`);
    previous = index;
  }
  return true;
}

function assertPersistedSelection(selection, expected, description) {
  assert(selection?.providerId === expected.providerId, `${description} Provider identity drifted.`);
  assert(selection.modelId === expected.modelId, `${description} model identity drifted.`);
  assert(selection.runtimeType === 'claude-code', `${description} runtime drifted.`);
  assert(selection.source === expected.source, `${description} policy source drifted.`);
  assert(selection.executionSource === expected.executionSource, `${description} execution source drifted.`);
  assert(selection.tier === expected.tier && selection.tierSource === expected.tierSource,
    `${description} tier provenance drifted.`);
  return true;
}

function closedSelectionDiagnosticFact(selection, identities) {
  const closed = (value, allowed) => allowed.includes(value) ? value : 'unknown';
  const identity = (value, a, b) => value === a ? 'A' : value === b ? 'B' : 'unknown';
  return {
    provider: identity(selection?.providerId, identities.providerA, identities.providerB),
    model: identity(selection?.modelId, identities.modelA, identities.modelB),
    runtimeType: closed(selection?.runtimeType, ['claude-code']),
    source: closed(selection?.source, ['task_override', 'project_policy', 'global_agent_policy', 'global_default', 'environment', 'claude_code']),
    executionSource: closed(selection?.executionSource, ['database_provider', 'environment', 'claude_code']),
    tier: closed(selection?.tier, ['high_quality', 'balanced', 'fast']),
    tierSource: closed(selection?.tierSource, ['global', 'project']),
  };
}

function exactKeys(value, expected, description) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${description} is not an object.`);
  assert(JSON.stringify(Object.keys(value)) === JSON.stringify(expected), `${description} keys are not closed.`);
}

function assertOperationCounts(value, description) {
  exactKeys(value, ['total', 'completed', 'failed', 'cancelled', 'interrupted'], description);
  for (const key of Object.keys(value)) {
    assert(Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 2_147_483_647, `${description}.${key} is invalid.`);
  }
  assert(value.completed + value.failed + value.cancelled + value.interrupted <= value.total,
    `${description} terminal counts exceed total.`);
}

function assertDiagnosticsFacts(facts) {
  exactKeys(facts?.off?.manifest, ['includeAnonymousPerformanceData'], 'Disabled manifest');
  assert(facts.off.manifest.includeAnonymousPerformanceData === false, 'Disabled manifest flag is not false.');
  assert(Array.isArray(facts.off.entryNames) && !facts.off.entryNames.includes('anonymous-performance.json'),
    'Disabled archive contains anonymous-performance.json.');
  exactKeys(facts?.on?.manifest, ['includeAnonymousPerformanceData'], 'Enabled manifest');
  assert(facts.on.manifest.includeAnonymousPerformanceData === true, 'Enabled manifest flag is not true.');
  const aggregate = facts.on.aggregate;
  exactKeys(aggregate, ['schemaVersion', 'operations', 'durationBuckets'], 'Anonymous aggregate');
  assert(aggregate.schemaVersion === 1, 'Anonymous aggregate schemaVersion is not 1.');
  exactKeys(aggregate.operations, ['direct', 'orchestrated'], 'Anonymous operations');
  assertOperationCounts(aggregate.operations.direct, 'Anonymous direct operations');
  assertOperationCounts(aggregate.operations.orchestrated, 'Anonymous orchestrated operations');
  exactKeys(aggregate.durationBuckets, [
    'underOneSecond', 'oneToTenSeconds', 'tenToSixtySeconds', 'oneToTenMinutes', 'tenMinutesOrMore',
  ], 'Anonymous duration buckets');
  for (const value of Object.values(aggregate.durationBuckets)) {
    assert(Number.isInteger(value) && value >= 0 && value <= 2_147_483_647, 'Anonymous duration bucket is invalid.');
  }
  return true;
}

function bindNativeDialogCandidate(input) {
  assert(Number.isInteger(input?.expectedPid) && input.expectedPid > 0, 'Expected Electron PID is invalid.');
  assert(input.knownFolderSource === 'SHGetKnownFolderPath(FOLDERID_Documents)', 'Documents was not resolved by the exact known-folder API.');
  assert(input.targetExisted === false, 'Diagnostics target existed before export.');
  const dialogs = (input.dialogs ?? []).filter((dialog) => dialog.pid === input.expectedPid
    && dialog.className === '#32770' && dialog.title === DIAGNOSTICS_TITLE && Number(dialog.hwnd) > 0);
  assert(dialogs.length === 1, 'Verified native diagnostics dialog is ambiguous or missing.');
  const dialog = dialogs[0];
  const controls = selectNativeDialogControlsFact([
    ...(dialog.filenameControls ?? []), ...(dialog.saveControls ?? []),
  ], input.expectedPid);
  const filenameControl = controls.filename;
  const filename = filenameControl.value;
  assert(typeof filename === 'string', 'Diagnostics filename is unavailable.');
  const match = DIAGNOSTICS_FILE_PATTERN.exec(filename);
  assert(match, 'Diagnostics filename is not canonical.');
  const timestamp = Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]),
    Number(match[5]), Number(match[6]), Number(match[7]),
  );
  const canonical = `ClaudeWorkbench-diagnostics-${new Date(timestamp).toISOString().replace(/[:.]/gu, '-')}.zip`;
  assert(canonical === filename, 'Diagnostics filename date is not canonical.');
  assert(Number.isFinite(input.requestedAt) && Number.isFinite(input.now), 'Diagnostics request freshness bounds are unavailable.');
  assert(timestamp >= input.requestedAt - 2_000 && timestamp <= input.now + 2_000,
    'Diagnostics filename is not fresh for this export.');
  assert(path.basename(filename) === filename && !/[\\/:]/u.test(filename), 'Diagnostics filename contains a path component.');
  return {
    pid: input.expectedPid,
    dialogHwnd: Number(dialog.hwnd),
    saveHwnd: Number(controls.save.hwnd),
    filename,
    knownFolderSource: input.knownFolderSource,
  };
}

function selectNativeDialogControlsFact(controls, expectedPid) {
  assert(Number.isInteger(expectedPid) && expectedPid > 0, 'Expected Electron PID is invalid for native controls.');
  const filenames = (controls ?? []).filter((control) => control?.pid === expectedPid
    && control.controlType === 'Edit' && control.supportsValuePattern === true && control.automationId === '1001');
  const saves = (controls ?? []).filter((control) => control?.pid === expectedPid
    && control.controlType === 'Button' && control.automationId === '1'
    && Number.isInteger(control.hwnd) && control.hwnd > 0
    && typeof control.name === 'string' && NATIVE_SAVE_NAME_PATTERN.test(control.name));
  assert(filenames.length === 1, 'Filename Edit is ambiguous or missing.');
  assert(saves.length === 1, 'Verified Save control is ambiguous or missing.');
  return { filename: filenames[0], save: saves[0] };
}

function bindNativePreActionCandidateFact(input) {
  assert(Number.isInteger(input?.expectedPid) && input.expectedPid > 0,
    'Expected Electron PID is invalid for the native save operation.');
  assert(Number.isFinite(input.requestedAt) && Number.isFinite(input.now),
    'Native save-operation freshness bounds are unavailable.');
  assert(input.knownFolderSource === 'SHGetKnownFolderPath(FOLDERID_Documents)',
    'Native save operation did not use the exact Documents known-folder API.');
  assert(input.targetExisted === false, 'Native save-operation target existed before export.');
  const dialog = selectExactVisibleNativeWindowFact(input.dialogs, input.expectedPid, DIAGNOSTICS_TITLE);
  const edits = (dialog.editControls ?? []).filter((control) => control?.pid === input.expectedPid
    && Number.isInteger(control.hwnd) && control.hwnd > 0 && control.controlId === 1001
    && control.nativeClass === 'Edit' && control.visible === true && control.enabled === true
    && control.contained === true && control.preRevalidated === true && control.boundedTextRead === true
    && control.postRevalidated === true && control.beforeActionRevalidated === true
    && control.targetAbsent === true);
  assert(edits.length === 1, 'Exact native filename Edit operation target is ambiguous or missing.');
  const rawSaves = dialog.saveControls ?? [];
  assert(rawSaves.length === 1, 'Native ID1 Save collection is ambiguous or missing.');
  const saves = rawSaves.filter((control) => control?.pid === input.expectedPid
    && Number.isInteger(control.hwnd) && control.hwnd > 0 && control.controlId === 1
    && control.nativeClass === 'Button' && control.visible === true && control.enabled === true
    && control.contained === true && typeof control.nativeText === 'string'
    && NATIVE_SAVE_NAME_PATTERN.test(control.nativeText)
    && control.preRevalidated === true && control.beforeActionRevalidated === true);
  assert(saves.length === 1, 'Exact native Save operation target is ambiguous or missing.');
  validateNativePreClickBasename(edits[0].value, input.requestedAt, input.now);
  return { pid: input.expectedPid, dialogHwnd: dialog.hwnd, editHwnd: edits[0].hwnd,
    saveHwnd: saves[0].hwnd, filename: edits[0].value,
    knownFolderSource: input.knownFolderSource };
}

function bindNativeSaveOperationFact(input) {
  const bound = bindNativePreActionCandidateFact(input);
  const action = input.action;
  exactKeys(action, ['dialogBeforeActionRevalidated', 'boundedBmClick', 'fallback',
    'fallbackRevalidated', 'boundedWmCommand', 'dialogClosed'], 'Native save action');
  assert(action.dialogBeforeActionRevalidated === true && action.boundedBmClick === true,
    'Native save action was not fully revalidated and bounded.');
  if (action.fallback === 'not_needed') {
    assert(action.fallbackRevalidated === null && action.boundedWmCommand === null,
      'Unused native save fallback retained unexpected action facts.');
  } else {
    assert(action.fallback === 'same_dialog_wm_command' && action.fallbackRevalidated === true
      && action.boundedWmCommand === true,
    'Native save fallback was not bound to the same revalidated dialog.');
  }
  assert(action.dialogClosed === true, 'Exact native diagnostics dialog did not close.');
  return { ...bound, fallback: action.fallback };
}

function selectExactVisibleNativeWindowFact(windows, expectedPid, expectedTitle) {
  const matches = (windows ?? []).filter((candidate) => candidate?.visible === true
    && candidate.pid === expectedPid && candidate.className === '#32770'
    && candidate.title === expectedTitle && Number.isInteger(candidate.hwnd) && candidate.hwnd > 0);
  assert(matches.length === 1, 'Exact visible native diagnostics window is ambiguous or missing.');
  return matches[0];
}

function selectSameHwndRootDialogFact(rootChildren, bound, win32Windows) {
  assert(Number.isInteger(bound?.pid) && bound.pid > 0 && Number.isInteger(bound?.hwnd) && bound.hwnd > 0
    && bound.className === '#32770' && bound.title === DIAGNOSTICS_TITLE,
  'Bound native dialog identity is invalid for UIA provider projection.');
  const win32 = selectExactVisibleNativeWindowFact(win32Windows, bound.pid, bound.title);
  assert(win32.hwnd === bound.hwnd, 'Native dialog HWND changed during UIA provider projection.');
  const matches = (rootChildren ?? []).filter((candidate) => candidate?.pid === bound.pid
    && candidate.hwnd === bound.hwnd && candidate.className === bound.className && candidate.title === bound.title);
  assert(matches.length === 1, 'Same-HWND UIA Root dialog is ambiguous or missing.');
  return matches[0];
}

function closedNativeWindowDiscoveryFact(value) {
  const groups = ['topLevel', 'children'];
  assert(value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(groups.slice().sort()),
  'Native window diagnostic has unexpected fields.');
  const countKeys = ['visible', 'class32770', 'exactTitle', 'exactBoth'];
  const result = {};
  for (const group of groups) {
    const counts = value[group];
    assert(counts && typeof counts === 'object' && !Array.isArray(counts)
      && JSON.stringify(Object.keys(counts).sort()) === JSON.stringify(countKeys.slice().sort()),
    'Native window diagnostic count group has unexpected fields.');
    result[group] = {};
    for (const key of countKeys) {
      assert(Number.isSafeInteger(counts[key]) && counts[key] >= 0, 'Native window diagnostic count is invalid.');
      result[group][key] = counts[key];
    }
  }
  return result;
}

function closedTaggedElectronRoleFact(value) {
  const keys = ['taggedRoots', 'main', 'renderer', 'utility', 'other', 'expectedLaunchPidIsMain'];
  assert(value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys.slice().sort()),
  'Tagged Electron role diagnostic has unexpected fields.');
  const result = {};
  for (const key of keys.slice(0, -1)) {
    assert(Number.isSafeInteger(value[key]) && value[key] >= 0, 'Tagged Electron role count is invalid.');
    result[key] = value[key];
  }
  assert(typeof value.expectedLaunchPidIsMain === 'boolean', 'Tagged Electron expected-main fact is invalid.');
  result.expectedLaunchPidIsMain = value.expectedLaunchPidIsMain;
  return result;
}

function closedNativeControlDiscoveryFact(value) {
  const keys = ['totalDescendants', 'expectedPidDescendants', 'edit', 'save'];
  assert(value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys.slice().sort()),
  'Native control diagnostic has unexpected fields.');
  const editKeys = ['total', 'id1001', 'id1001Value', 'id1001ValueVisible',
    'expectedPidTotal', 'expectedPidId1001', 'expectedPidId1001Value', 'expectedPidId1001ValueVisible'];
  const saveKeys = ['button', 'buttonId1', 'buttonId1AnchoredName', 'buttonId1AnchoredNamePositiveHwnd',
    'expectedPidButton', 'expectedPidButtonId1', 'expectedPidButtonId1AnchoredName',
    'expectedPidButtonId1AnchoredNamePositiveHwnd'];
  const result = { totalDescendants: value.totalDescendants, expectedPidDescendants: value.expectedPidDescendants,
    edit: {}, save: {} };
  for (const key of ['totalDescendants', 'expectedPidDescendants']) {
    assert(Number.isSafeInteger(value[key]) && value[key] >= 0, 'Native control diagnostic count is invalid.');
  }
  for (const [group, groupKeys] of [['edit', editKeys], ['save', saveKeys]]) {
    assert(value[group] && typeof value[group] === 'object' && !Array.isArray(value[group])
      && JSON.stringify(Object.keys(value[group]).sort()) === JSON.stringify(groupKeys.slice().sort()),
    'Native control diagnostic group has unexpected fields.');
    for (const key of groupKeys) {
      assert(Number.isSafeInteger(value[group][key]) && value[group][key] >= 0,
        'Native control diagnostic count is invalid.');
      result[group][key] = value[group][key];
    }
  }
  return result;
}

function closedNativeControlIdDiscoveryFact(value) {
  const groups = ['id1001', 'id1'];
  const keys = ['id', 'visible', 'expectedPid', 'contained'];
  assert(value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(groups.slice().sort()),
  'Native control-ID diagnostic has unexpected fields.');
  const result = {};
  for (const group of groups) {
    assert(value[group] && typeof value[group] === 'object' && !Array.isArray(value[group])
      && JSON.stringify(Object.keys(value[group]).sort()) === JSON.stringify(keys.slice().sort()),
    'Native control-ID diagnostic group has unexpected fields.');
    result[group] = {};
    for (const key of keys) {
      assert(Number.isSafeInteger(value[group][key]) && value[group][key] >= 0,
        'Native control-ID diagnostic count is invalid.');
      result[group][key] = value[group][key];
    }
  }
  return result;
}

function closedNativeJointControlDiscoveryFact(value) {
  const groups = ['id1001', 'id1'];
  const groupKeys = {
    id1001: ['nativeCandidates', 'uiaNonnull', 'nativeRevalidated', 'edit', 'valuePattern',
      'visibleEnabled', 'canonicalBasename', 'freshRoundTrip', 'targetAbsent'],
    id1: ['nativeCandidates', 'uiaNonnull', 'nativeRevalidated', 'button', 'anchoredName', 'positiveHwnd'],
  };
  assert(value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(groups.slice().sort()),
  'Native/UIA joint diagnostic has unexpected fields.');
  const result = {};
  for (const group of groups) {
    const keys = groupKeys[group];
    assert(value[group] && typeof value[group] === 'object' && !Array.isArray(value[group])
      && JSON.stringify(Object.keys(value[group]).sort()) === JSON.stringify(keys.slice().sort()),
    'Native/UIA joint diagnostic group has unexpected fields.');
    result[group] = {};
    for (const key of keys) {
      assert(Number.isSafeInteger(value[group][key]) && value[group][key] >= 0,
        'Native/UIA joint diagnostic count is invalid.');
      result[group][key] = value[group][key];
    }
  }
  return result;
}

function closedNativeWin32JointDiscoveryFact(value) {
  const groups = ['direct1001', 'descendant1001', 'mergedFilename', 'id1'];
  const groupKeys = {
    direct1001: ['nativeCandidates', 'visibleEnabled', 'classEdit', 'canonicalFreshText'],
    descendant1001: ['containers', 'nativeDescendants', 'expectedPidContained', 'classEdit',
      'visibleEnabled', 'canonicalFreshText'],
    mergedFilename: ['canonicalFreshCandidates'],
    id1: ['nativeCandidates', 'visibleEnabled', 'classButton', 'anchoredText'],
  };
  assert(value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(groups.slice().sort()),
  'Pure Win32 joint diagnostic has unexpected fields.');
  const result = {};
  for (const group of groups) {
    const keys = groupKeys[group];
    assert(value[group] && typeof value[group] === 'object' && !Array.isArray(value[group])
      && JSON.stringify(Object.keys(value[group]).sort()) === JSON.stringify(keys.slice().sort()),
    'Pure Win32 joint diagnostic group has unexpected fields.');
    result[group] = {};
    for (const key of keys) {
      assert(Number.isSafeInteger(value[group][key]) && value[group][key] >= 0,
        'Pure Win32 joint diagnostic count is invalid.');
      result[group][key] = value[group][key];
    }
  }
  return result;
}

function closedNativeBoundedTextDiscoveryFact(value) {
  const keys = ['nativeEditCandidates', 'preRevalidated', 'lengthRead', 'lengthWithinBound',
    'textRead', 'postRevalidated', 'canonicalBasename', 'freshRoundTrip', 'targetAbsent'];
  assert(value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys.slice().sort()),
  'Bounded native-text diagnostic has unexpected fields.');
  const result = {};
  for (const key of keys) {
    assert(Number.isSafeInteger(value[key]) && value[key] >= 0,
      'Bounded native-text diagnostic count is invalid.');
    result[key] = value[key];
  }
  return result;
}

function closedArchiveInspectionFailureFact(value) {
  const stages = new Set(['archive_open', 'identity_before_preflight', 'header_preflight', 'header_contract',
    'identity_before_extract', 'extract', 'extracted_contract', 'identity_after_extract',
    'extracted_tree', 'manifest_read', 'aggregate_read', 'identity_after_read', 'unknown']);
  exactKeys(value, ['stage', 'acceptedEntries', 'expandedBytes'], 'Archive inspection failure');
  assert(stages.has(value.stage), 'Archive inspection failure stage is invalid.');
  assert(Number.isSafeInteger(value.acceptedEntries) && value.acceptedEntries >= 0
    && value.acceptedEntries <= DIAGNOSTICS_ARCHIVE_MAX_ENTRIES,
  'Archive inspection accepted-entry count is invalid.');
  assert(Number.isSafeInteger(value.expandedBytes) && value.expandedBytes >= 0
    && value.expandedBytes <= DIAGNOSTICS_ARCHIVE_MAX_TOTAL_BYTES,
  'Archive inspection expanded-byte count is invalid.');
  return { stage: value.stage, acceptedEntries: value.acceptedEntries, expandedBytes: value.expandedBytes };
}

function archiveInspectionError(stage, policyOrResult = null) {
  const acceptedEntries = policyOrResult?.names instanceof Set
    ? policyOrResult.names.size : Array.isArray(policyOrResult?.entryNames) ? policyOrResult.entryNames.length : 0;
  const expandedBytes = Number.isSafeInteger(policyOrResult?.totalBytes) ? policyOrResult.totalBytes : 0;
  const error = new Error('Diagnostics archive failed a fixed bounded inspection gate.');
  error.archiveInspectionFailure = closedArchiveInspectionFailureFact({ stage, acceptedEntries, expandedBytes });
  return error;
}

function validateNativePreClickBasename(filename, requestedAt, now) {
  assert(typeof filename === 'string' && path.basename(filename) === filename && !/[\\/:]/u.test(filename),
    'Diagnostics filename contains a path component.');
  const match = DIAGNOSTICS_FILE_PATTERN.exec(filename);
  assert(match, 'Diagnostics filename is not canonical.');
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]),
    Number(match[5]), Number(match[6]), Number(match[7]));
  const canonical = `ClaudeWorkbench-diagnostics-${new Date(timestamp).toISOString().replace(/[:.]/gu, '-')}.zip`;
  assert(canonical === filename, 'Diagnostics filename date does not round-trip canonically.');
  assert(timestamp >= requestedAt - 2_000 && timestamp <= now + 2_000, 'Diagnostics filename is stale.');
  return true;
}

function selectExactDialogForClose(dialogs, expected) {
  const matches = dialogs.filter((item) => item.pid === expected.pid && item.className === expected.className
    && item.title === expected.title && item.hwnd === expected.hwnd && Number(item.hwnd) > 0);
  assert(matches.length === 1, 'Exact verified dialog close target is ambiguous or missing.');
  return matches[0];
}

function assertAutomationPolicy(policy) {
  exactKeys(policy, [
    'documentsEnumerated', 'documentsDiffed', 'guessDeleted', 'filenameWritten', 'pathWritten',
    'sendKeysUsed', 'clipboardUsed', 'physicalMouseUsed',
  ], 'Native automation policy');
  for (const [key, value] of Object.entries(policy)) assert(value === false, `Forbidden native automation operation: ${key}.`);
  return true;
}

function fileIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    nlink: stat.nlink,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    birthtimeMs: stat.birthtimeMs,
  };
}

function snapshotBoundFile(target, maxBytes = Number.MAX_SAFE_INTEGER) {
  const before = fs.lstatSync(target);
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1,
    'Bound diagnostics path is not a single-link ordinary file.');
  assert(Number.isSafeInteger(maxBytes) && maxBytes >= 0 && before.size <= maxBytes,
    'Bound diagnostics file exceeds its read/hash size bound.');
  const bytes = fs.readFileSync(target);
  const after = fs.lstatSync(target);
  const beforeIdentity = fileIdentity(before);
  const afterIdentity = fileIdentity(after);
  assert(sameFileIdentity(beforeIdentity, afterIdentity), 'Bound diagnostics identity changed while hashing.');
  return { ...afterIdentity, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function snapshotFreshBoundFile(target, requestedAt, now) {
  assert(Number.isFinite(requestedAt) && Number.isFinite(now) && now >= requestedAt,
    'Bound diagnostics freshness bounds are invalid.');
  const identity = snapshotBoundFile(target, DIAGNOSTICS_ARCHIVE_MAX_PHYSICAL_BYTES);
  for (const key of ['birthtimeMs', 'ctimeMs', 'mtimeMs']) {
    assert(Number.isFinite(identity[key]) && identity[key] >= requestedAt - 2_000 && identity[key] <= now + 2_000,
      'Bound diagnostics candidate is not fresh for the exact export.');
  }
  return identity;
}

function assertExactKnownFolderCandidatePath({ documents, target, filename }) {
  assert(typeof documents === 'string' && path.isAbsolute(documents),
    'Documents known-folder result is not absolute.');
  assert(typeof target === 'string' && path.isAbsolute(target), 'Diagnostics target is not absolute.');
  assert(typeof filename === 'string' && path.basename(filename) === filename && !/[\\/:]/u.test(filename),
    'Diagnostics candidate filename is not a basename.');
  const expected = path.join(documents, filename);
  assert(samePath(target, expected) && samePath(path.dirname(target), documents),
    'Diagnostics target is not the exact known-folder and read-basename join.');
  return true;
}

async function waitForFreshExactCandidate(target, requestedAt, timeoutMs = 10_000) {
  assert(typeof target === 'string' && path.isAbsolute(target), 'Exact diagnostics target is invalid.');
  assert(Number.isFinite(requestedAt), 'Exact diagnostics request time is invalid.');
  assert(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10_000,
    'Exact diagnostics wait bound is invalid.');
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    if (fs.existsSync(target)) {
      try {
        return { path: target, identity: snapshotFreshBoundFile(target, requestedAt, Date.now()), ambiguous: false };
      } catch (error) {
        lastError = error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (lastError) throw new Error('Exact diagnostics candidate could not bind a stable fresh identity.');
  throw new Error('Exact diagnostics candidate was not created.');
}

async function recoverReturnedNativeCandidate(returned, expectedPid, requestedAt, timeoutMs = 2_000) {
  assert(returned?.expectedPid === expectedPid, 'Returned native candidate PID does not match the owned Electron process.');
  assert(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 5_000,
    'Returned native candidate recovery bound is invalid.');
  const rebound = bindNativePreActionCandidateFact({ ...returned, requestedAt, now: Date.now() });
  assertExactKnownFolderCandidatePath({ documents: returned.documents, target: returned.target,
    filename: rebound.filename });
  const deadline = Date.now() + timeoutMs;
  let appeared = false;
  let lastError = null;
  while (Date.now() <= deadline) {
    if (fs.existsSync(returned.target)) {
      appeared = true;
      try {
        const candidate = { path: returned.target,
          identity: snapshotFreshBoundFile(returned.target, requestedAt, Date.now()), ambiguous: false };
        deleteBoundFile(candidate);
        return { appeared: true, deleted: true };
      } catch (error) {
        lastError = error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (appeared || lastError) throw new Error('Returned exact diagnostics candidate could not bind a safe stable identity.');
  return { appeared: false, deleted: false };
}

async function recoverRejectedNativeHelperCandidate(reason, expectedPid, requestedAt, timeoutMs = 2_000) {
  assert(reason?.nativeCandidate, 'Rejected native helper did not return an exact candidate marker.');
  return recoverReturnedNativeCandidate(reason.nativeCandidate, expectedPid, requestedAt, timeoutMs);
}

async function recoverFulfilledNativeHelperOutput(output, expectedPid, requestedAt, timeoutMs = 2_000) {
  const returned = nativeCandidateFromOutput(output);
  assert(returned, 'Fulfilled native helper output did not retain its exact candidate marker.');
  return recoverReturnedNativeCandidate(returned, expectedPid, requestedAt, timeoutMs);
}

const DIAGNOSTICS_REQUIRED_ARCHIVE_ENTRIES = Object.freeze([
  'manifest.json', 'version.json', 'system.json', 'database-summary.json', 'error-summary.json',
]);
const DIAGNOSTICS_ALLOWED_LOG_ENTRIES = new Set([
  'logs/app.log', 'logs/agent.log', 'logs/permission.log', 'logs/git.log',
  'logs/database.log', 'logs/error.log',
]);
const DIAGNOSTICS_ARCHIVE_MAX_ENTRIES = 16;
const DIAGNOSTICS_ARCHIVE_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const DIAGNOSTICS_ARCHIVE_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const DIAGNOSTICS_ARCHIVE_MAX_PHYSICAL_BYTES = 12 * 1024 * 1024;
const DIAGNOSTICS_CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32Buffer(content) {
  let crc = 0xffffffff;
  for (const byte of content) crc = DIAGNOSTICS_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildStoredDiagnosticsZipFixture(entries) {
  assert(Array.isArray(entries) && entries.length > 0 && entries.length <= DIAGNOSTICS_ARCHIVE_MAX_ENTRIES,
    'Stored diagnostics ZIP fixture entries are invalid.');
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    assert(typeof entry?.name === 'string' && Buffer.isBuffer(entry.content),
      'Stored diagnostics ZIP fixture entry is invalid.');
    const name = Buffer.from(entry.name, 'utf8');
    const checksum = crc32Buffer(entry.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.content.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, entry.content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.versionMadeBy ?? 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.content.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(Number(entry.externalFileAttributes ?? 0) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + entry.content.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function createDiagnosticsArchivePolicy(includeAnonymousPerformanceData) {
  assert(typeof includeAnonymousPerformanceData === 'boolean', 'Diagnostics archive mode is invalid.');
  return { includeAnonymousPerformanceData, names: new Set(), totalBytes: 0 };
}

function acceptDiagnosticsArchiveEntry(policy, entry) {
  assert(policy?.names instanceof Set && Number.isSafeInteger(policy.totalBytes),
    'Diagnostics archive policy state is invalid.');
  const fileName = entry?.fileName;
  assert(typeof fileName === 'string' && fileName.length > 0 && fileName.length <= 128,
    'Diagnostics archive entry name is invalid.');
  assert(!fileName.includes('\\') && !fileName.includes('\0') && !fileName.startsWith('/')
    && !/^[A-Za-z]:/u.test(fileName), 'Diagnostics archive entry path is unsafe.');
  const segments = fileName.split('/');
  assert(segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
    'Diagnostics archive entry path is unsafe.');
  const allowed = DIAGNOSTICS_REQUIRED_ARCHIVE_ENTRIES.includes(fileName)
    || fileName === 'anonymous-performance.json' || DIAGNOSTICS_ALLOWED_LOG_ENTRIES.has(fileName);
  assert(allowed, 'Diagnostics archive entry is not allowlisted.');
  assert(policy.includeAnonymousPerformanceData || fileName !== 'anonymous-performance.json',
    'Disabled diagnostics archive contains anonymous performance data.');
  assert(!policy.names.has(fileName), 'Diagnostics archive contains a duplicate entry.');
  const attributes = Number(entry.externalFileAttributes) >>> 0;
  const unixType = ((attributes >>> 16) & 0xffff) & 0xf000;
  assert(unixType !== 0xa000 && unixType !== 0x4000 && (attributes & 0x0410) === 0,
    'Diagnostics archive entry is symbolic, directory, or reparse-like.');
  assert(Number.isSafeInteger(entry.uncompressedSize) && entry.uncompressedSize >= 0
    && entry.uncompressedSize <= DIAGNOSTICS_ARCHIVE_MAX_ENTRY_BYTES,
  'Diagnostics archive entry exceeds its expanded-size bound.');
  assert(policy.names.size + 1 <= DIAGNOSTICS_ARCHIVE_MAX_ENTRIES
    && policy.totalBytes + entry.uncompressedSize <= DIAGNOSTICS_ARCHIVE_MAX_TOTAL_BYTES,
  'Diagnostics archive exceeds its bounded entry or expanded-size budget.');
  policy.names.add(fileName);
  policy.totalBytes += entry.uncompressedSize;
  return true;
}

function finalizeDiagnosticsArchivePolicy(policy) {
  for (const required of DIAGNOSTICS_REQUIRED_ARCHIVE_ENTRIES) {
    assert(policy.names.has(required), 'Diagnostics archive is missing a required entry.');
  }
  assert(policy.names.has('anonymous-performance.json') === policy.includeAnonymousPerformanceData,
    'Diagnostics archive anonymous performance entry does not match the requested mode.');
  return { entryNames: [...policy.names].sort(), totalBytes: policy.totalBytes };
}

function assertExtractedDiagnosticsTree(root, expectedEntryNames) {
  assert(typeof root === 'string' && path.isAbsolute(root), 'Extracted diagnostics root is invalid.');
  assertOrdinaryExistingPath(root);
  const actual = [];
  const visit = (directory, relative) => {
    for (const name of fs.readdirSync(directory)) {
      const target = path.join(directory, name);
      const stat = fs.lstatSync(target);
      assert(!stat.isSymbolicLink(), 'Extracted diagnostics entry is symbolic/reparse-like.');
      const child = relative ? `${relative}/${name}` : name;
      if (stat.isDirectory()) {
        assert(child === 'logs', 'Extracted diagnostics contains an unexpected directory.');
        visit(target, child);
      } else {
        assert(stat.isFile() && stat.nlink === 1, 'Extracted diagnostics entry is not a single-link ordinary file.');
        actual.push(child);
      }
    }
  };
  visit(root, '');
  const expected = [...new Set(expectedEntryNames)].sort();
  assert(expected.length === expectedEntryNames.length && JSON.stringify(actual.sort()) === JSON.stringify(expected),
    'Extracted diagnostics entries do not exactly match the preflight archive.');
  return true;
}

function sameFileIdentity(left, right) {
  return Object.keys(left).every((key) => Object.hasOwn(right, key) && left[key] === right[key])
    && Object.keys(right).every((key) => Object.hasOwn(left, key));
}

function deleteBoundFile(candidate) {
  assert(candidate?.ambiguous === false, 'Ambiguous diagnostics candidate is preserved.');
  assert(typeof candidate.path === 'string' && path.isAbsolute(candidate.path), 'Bound diagnostics path is invalid.');
  assert(typeof candidate.identity?.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(candidate.identity.sha256),
    'Bound diagnostics hash is unavailable.');
  const before = fs.lstatSync(candidate.path);
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1,
    'Bound diagnostics path is not a single-link ordinary file before deletion.');
  const { sha256: expectedHash, ...expectedFileIdentity } = candidate.identity;
  assert(typeof expectedHash === 'string' && sameFileIdentity(fileIdentity(before), expectedFileIdentity),
    'Bound diagnostics identity changed before bounded hashing.');
  const current = snapshotBoundFile(candidate.path, candidate.identity.size);
  assert(sameFileIdentity(current, candidate.identity), 'Bound diagnostics identity/hash changed before deletion.');
  fs.unlinkSync(candidate.path);
  assert(!fs.existsSync(candidate.path), 'Bound diagnostics path was repopulated during deletion.');
  return true;
}

async function expectRejectWithBoundCleanup(operation, candidate) {
  let failure = null;
  try { await operation(); } catch (error) { failure = error; }
  assert(failure instanceof Error, 'Expected a post-save operation failure.');
  deleteBoundFile(candidate);
  return failure;
}

function safeRemoveFixture(root) {
  const target = path.resolve(root);
  assert(OWNED_TEMP_ROOTS.has(target), 'Refusing to remove an unowned temp root.');
  assert(path.basename(target).startsWith(TEMP_PREFIX), 'Refusing to remove a temp root with an unexpected basename.');
  const stat = fs.lstatSync(target);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Owned temp root is no longer an ordinary directory.');
  fs.rmSync(target, { recursive: true, force: false, maxRetries: 20, retryDelay: 100 });
  OWNED_TEMP_ROOTS.delete(target);
  assert(!fs.existsSync(target), 'Owned temp root remains after cleanup.');
  return true;
}

function readRequestBody(request, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Loopback request body exceeded the safety limit.'));
        request.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.once('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('Loopback request body was not valid JSON.'));
      }
    });
    request.once('error', reject);
  });
}

function anthropicMessage(model, payload) {
  const toolUse = payload && typeof payload === 'object' && Object.hasOwn(payload, 'structured');
  return {
    id: `msg_${crypto.randomUUID().replace(/-/gu, '')}`,
    type: 'message',
    role: 'assistant',
    model,
    content: toolUse
      ? [{ type: 'tool_use', id: `toolu_${crypto.randomUUID().replace(/-/gu, '')}`, name: 'StructuredOutput', input: payload.structured }]
      : [{ type: 'text', text: String(payload) }],
    stop_reason: toolUse ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 11, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

function diagnosticRequestFact(body, payload) {
  const schemas = [
    ...(Array.isArray(body?.tools) ? body.tools.map((tool) => tool?.input_schema) : []),
    body?.output_config?.format?.schema,
    body?.output_format?.schema,
  ].filter((schema) => schema && typeof schema === 'object');
  const outputSchemaKeys = [...new Set(schemas.flatMap((schema) => Object.keys(schema.properties ?? {})))].sort();
  const structuredKeys = payload?.structured && typeof payload.structured === 'object'
    ? Object.keys(payload.structured) : [];
  const responseFixtureBranch = structuredKeys.includes('ok') ? 'protocol_probe'
    : structuredKeys.includes('filesExpected') ? 'planner'
      : structuredKeys.includes('filesChanged') ? 'coder'
        : structuredKeys.includes('commands') ? 'tester'
          : structuredKeys.includes('issues') ? 'reviewer' : 'text';
  return {
    topLevelKeys: Object.keys(body ?? {}).sort(),
    toolNames: Array.isArray(body?.tools)
      ? body.tools.map((tool) => typeof tool?.name === 'string' ? tool.name : null).filter(Boolean) : [],
    toolChoiceType: typeof body?.tool_choice?.type === 'string' ? body.tool_choice.type : null,
    toolChoiceName: typeof body?.tool_choice?.name === 'string' ? body.tool_choice.name : null,
    outputSchemaKeys,
    responseFixtureBranch,
  };
}

function closedErrorType(error) {
  const value = String(error || '');
  if (/no structured output|returned no structured output/iu.test(value)) return 'missing_structured_output';
  if (/schema|structured output|invalid json|parse/iu.test(value)) return 'structured_output_invalid';
  if (/code\s*=|exit(?:ed)?[^a-z]+code|non.?zero/iu.test(value)) return 'cli_nonzero_exit';
  if (/timed?\s*out|timeout/iu.test(value)) return 'timeout';
  if (/permission|denied|not allowed/iu.test(value)) return 'permission_denied';
  if (/connect|network|socket|provider|credential|auth/iu.test(value)) return 'provider_or_connection';
  if (/cancel|interrupt|stopp/iu.test(value)) return 'cancelled_or_interrupted';
  return 'unknown';
}

function closedWorkflowFailureCode(value) {
  const allowed = new Set([
    'NOT_FOUND', 'INVALID_INPUT', 'INVALID_TRANSITION', 'PLAN_REQUIRED', 'READ_ONLY_PERMISSION',
    'PERSISTENCE_CONFLICT', 'USER_ACTION_REQUIRED', 'INVALID_STRUCTURED_OUTPUT', 'AGENT_STAGE_FAILED',
  ]);
  return allowed.has(value) ? value : 'unknown';
}

function closedWorkflowTerminalFact(workflow) {
  const allowedStatuses = new Set(['idle', 'planning', 'waiting_plan_confirmation', 'executing', 'testing',
    'reviewing', 'paused', 'completed', 'failed', 'cancelled']);
  const closedRound = (value) => Number.isInteger(value) && value >= 0 && value <= 3 ? value : null;
  return {
    status: allowedStatuses.has(workflow?.status) ? workflow.status : 'unknown',
    reviewRound: closedRound(workflow?.reviewRound),
    fixRound: closedRound(workflow?.fixRound),
    failureCode: closedWorkflowFailureCode(workflow?.failure?.code),
  };
}

const STEP7_WORKFLOW_STATUSES = new Set(['idle', 'planning', 'waiting_plan_confirmation', 'executing', 'testing',
  'reviewing', 'paused', 'completed', 'failed', 'cancelled', 'unknown']);
const STEP7_STAGES = new Set([...ROLES, null, 'unknown']);
const STEP7_FAILURE_CODES = new Set(['NOT_FOUND', 'INVALID_INPUT', 'INVALID_TRANSITION', 'PLAN_REQUIRED',
  'READ_ONLY_PERMISSION', 'PERSISTENCE_CONFLICT', 'USER_ACTION_REQUIRED', 'INVALID_STRUCTURED_OUTPUT',
  'AGENT_STAGE_FAILED', 'unknown']);

function closedStep7PlanResultFact(workflow, expected) {
  assert(expected && typeof expected.workflowId === 'string' && expected.workflowId.length > 0
    && typeof expected.taskId === 'string' && expected.taskId.length > 0,
  'Expected Step 7 Workflow identity is invalid.');
  const stage = (value) => value === null || ROLES.includes(value) ? value : 'unknown';
  return {
    identityMatch: workflow?.id === expected.workflowId && workflow?.taskId === expected.taskId,
    status: STEP7_WORKFLOW_STATUSES.has(workflow?.status) ? workflow.status : 'unknown',
    currentStage: stage(workflow?.currentStage),
    activeStage: stage(workflow?.activeStage),
    hasPlan: Boolean(workflow?.plan && typeof workflow.plan === 'object' && !Array.isArray(workflow.plan)),
    failureCode: closedWorkflowFailureCode(workflow?.failure?.code),
  };
}

function validateClosedStep7PlanFact(fact) {
  exactKeys(fact, ['identityMatch', 'status', 'currentStage', 'activeStage', 'hasPlan', 'failureCode'],
    'Step 7 plan result');
  assert(typeof fact.identityMatch === 'boolean' && STEP7_WORKFLOW_STATUSES.has(fact.status)
    && STEP7_STAGES.has(fact.currentStage) && STEP7_STAGES.has(fact.activeStage)
    && typeof fact.hasPlan === 'boolean' && STEP7_FAILURE_CODES.has(fact.failureCode),
  'Step 7 plan result contains an invalid closed value.');
  return fact;
}

function assertStep7PlanReadyFact(fact) {
  validateClosedStep7PlanFact(fact);
  assert(fact.identityMatch && fact.status === 'waiting_plan_confirmation' && fact.hasPlan,
    'Workflow A did not return an exact ready plan result.');
  return true;
}

function closedStep7RequestDeltaFact(fact) {
  exactKeys(fact, ['providerA', 'providerB'], 'Step 7 Provider request delta');
  assert(Number.isSafeInteger(fact.providerA) && fact.providerA >= 0
    && Number.isSafeInteger(fact.providerB) && fact.providerB >= 0,
  'Step 7 Provider request delta is invalid.');
  return { providerA: fact.providerA, providerB: fact.providerB };
}

function validateClosedStep7UiFact(fact) {
  exactKeys(fact, ['taskCurrentVisibleUnique', 'workflowListItemVisibleUnique', 'workflowListItemAriaCurrent',
    'workflowPanelVisibleUnique', 'planTabSelectedUnique', 'startButtonCount', 'enabledStartButtonCount'],
  'Step 7 UI identity');
  for (const key of ['taskCurrentVisibleUnique', 'workflowListItemVisibleUnique', 'workflowListItemAriaCurrent',
    'workflowPanelVisibleUnique', 'planTabSelectedUnique']) {
    assert(typeof fact[key] === 'boolean', 'Step 7 UI identity boolean is invalid.');
  }
  assert(Number.isSafeInteger(fact.startButtonCount) && fact.startButtonCount >= 0 && fact.startButtonCount <= 16
    && Number.isSafeInteger(fact.enabledStartButtonCount) && fact.enabledStartButtonCount >= 0
    && fact.enabledStartButtonCount <= fact.startButtonCount,
  'Step 7 UI identity button count is invalid.');
  return fact;
}

function assertStep7UiReadyFact(fact) {
  validateClosedStep7UiFact(fact);
  assert(fact.taskCurrentVisibleUnique && fact.workflowListItemVisibleUnique
    && fact.workflowListItemAriaCurrent && fact.workflowPanelVisibleUnique && fact.planTabSelectedUnique
    && fact.startButtonCount === 1 && fact.enabledStartButtonCount === 1,
  'Workflow A exact Plan execution UI is not ready.');
  return true;
}

function step7UiIdentityScript(taskId, workflowId, click) {
  assert(typeof taskId === 'string' && taskId.length > 0 && typeof workflowId === 'string' && workflowId.length > 0,
    'Step 7 DOM identity is invalid.');
  return `(() => {
    const visible = (item) => {
      if (!item) return false;
      const rect = item.getBoundingClientRect(); const style = getComputedStyle(item);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const taskMatches = Array.from(document.querySelectorAll('[data-session-key]')).filter((item) =>
      item.getAttribute('data-session-key')?.endsWith(${js(`::${taskId}`)}) && visible(item));
    const currentRoots = Array.from(document.querySelectorAll('[data-testid="current-workflow"]')).filter(visible);
    const panels = currentRoots.length === 1
      ? Array.from(currentRoots[0].querySelectorAll('[data-testid="workflow-panel"]')).filter(visible) : [];
    const workflowItems = panels.length === 1
      ? Array.from(panels[0].querySelectorAll('[data-testid="workflow-list-item"]')).filter((item) =>
        item.getAttribute('data-workflow-id') === ${js(workflowId)} && visible(item)) : [];
    const planTabs = panels.length === 1
      ? Array.from(panels[0].querySelectorAll('[data-testid="workflow-tab"][data-tab="plan"]')).filter((item) =>
        visible(item) && item.getAttribute('aria-selected') === 'true') : [];
    const startButtons = panels.length === 1
      ? Array.from(panels[0].querySelectorAll('[data-testid="workflow-start-execution"]')) : [];
    const enabledStartButtons = startButtons.filter((item) => visible(item) && !item.disabled
      && item.getAttribute('aria-disabled') !== 'true');
    const fact = {
      taskCurrentVisibleUnique: taskMatches.length === 1
        && taskMatches[0].style.backgroundColor === 'var(--bg-active)',
      workflowListItemVisibleUnique: workflowItems.length === 1,
      workflowListItemAriaCurrent: workflowItems.length === 1
        && workflowItems[0].getAttribute('aria-current') === 'true',
      workflowPanelVisibleUnique: panels.length === 1,
      planTabSelectedUnique: planTabs.length === 1,
      startButtonCount: startButtons.length,
      enabledStartButtonCount: enabledStartButtons.length,
    };
    ${click ? `const ready = fact.taskCurrentVisibleUnique && fact.workflowListItemVisibleUnique
      && fact.workflowListItemAriaCurrent && fact.workflowPanelVisibleUnique && fact.planTabSelectedUnique
      && fact.startButtonCount === 1 && fact.enabledStartButtonCount === 1;
    if (!ready) return false; enabledStartButtons[0].click(); return true;` : 'return fact;'}
  })()`;
}

function step7UiIdentityFactExpression(taskId, workflowId) {
  return step7UiIdentityScript(taskId, workflowId, false);
}

function step7ExactStartClickExpression(taskId, workflowId) {
  return step7UiIdentityScript(taskId, workflowId, true);
}

const CHILD_ARGV_PHASES = Object.freeze([
  'child_argv_descendant_presence',
  'child_argv_record_cardinality',
  'child_argv_record_schema',
  'child_argv_authoritative_files',
  'child_argv_observed_executable',
  'child_argv_command_line_parse',
  'child_argv_argv0',
  'child_argv_flag_layout',
  'child_argv_mcp_closed_config',
  'child_argv_privacy',
]);

function noteChildArgvPhase(setPhase, value) {
  assert(typeof setPhase === 'function' && CHILD_ARGV_PHASES.includes(value),
    'Child argv diagnostic phase is invalid.');
  setPhase(value);
}

function createChildArgvPhaseSetter(setPhase) {
  assert(typeof setPhase === 'function', 'Child argv diagnostic phase sink is invalid.');
  let next = 0;
  return (value) => {
    assert(value === CHILD_ARGV_PHASES[next], 'Child argv diagnostic phase is missing or out of order.');
    next += 1;
    noteChildArgvPhase(setPhase, value);
  };
}

async function runStep7PhaseSequence(operations) {
  exactKeys(operations, ['setPhase', 'planCall', 'planResult', 'uiIdentityWait', 'clickStart', 'waitExecuting',
    'waitProviderBHold', 'childArgv', 'switchBlock'], 'Step 7 phase operations');
  for (const operation of Object.values(operations)) assert(typeof operation === 'function',
    'Step 7 phase operation is invalid.');
  operations.setPhase('step7_plan_call');
  const planned = await operations.planCall();
  operations.setPhase('plan_result');
  await operations.planResult(planned);
  operations.setPhase('ui_identity_wait');
  await operations.uiIdentityWait();
  operations.setPhase('click_start');
  await operations.clickStart();
  operations.setPhase('wait_executing');
  await operations.waitExecuting();
  operations.setPhase('wait_provider_b_hold');
  await operations.waitProviderBHold();
  operations.setPhase('child_argv');
  await operations.childArgv();
  operations.setPhase('switch_block');
  await operations.switchBlock();
  return true;
}

const POST_STEP15_GATES = Object.freeze([
  'owned_runtime_identity',
  'credential_privacy_facts',
  'owned_child_arguments_privacy',
  'settings_close',
  'public_capture',
  'public_dto_privacy',
  'persisted_event_privacy',
  'database_file_privacy',
  'retained_file_privacy',
  'privacy_evidence_initialize',
  'request_evidence',
  'artifact_build',
  'artifact_metadata_privacy',
  'electron_stop_close_drain',
  'electron_output_cardinality',
  'child_output_privacy',
  'retained_report_pre_cleanup',
  'loopback_close_a',
  'loopback_close_b',
  'loopback_close_deepseek',
  'diagnostics_delete',
  'owned_process_listener_zero',
  'owned_temp_remove',
  'retained_report_final',
  'report_write',
]);

const POST_STEP15_ERROR_TYPES = new Set([
  'missing_structured_output', 'structured_output_invalid', 'cli_nonzero_exit', 'timeout',
  'permission_denied', 'provider_or_connection', 'cancelled_or_interrupted', 'unknown',
]);

const CHILD_OUTPUT_STREAM_ROLES = Object.freeze([
  'first_stdout', 'first_stderr', 'second_stdout', 'second_stderr',
]);
const CHILD_OUTPUT_MATCH_FAMILIES = Object.freeze([
  'provider_secret', 'diagnostic_full', 'diagnostic_basename', 'diagnostic_parent', 'credential_ref',
  'vault_filename', 'vault_directory', 'fixture_root', 'data_root', 'real_profile',
]);
const CHILD_OUTPUT_ENCODING_FORMS = Object.freeze(['literal_utf8', 'json_escaped_utf8']);
const CHILD_OUTPUT_PRODUCER_HINTS = Object.freeze(['product', 'platform', 'runtime', 'unknown']);
const CHILD_OUTPUT_LINE_SHAPES = Object.freeze([
  'stack_frame', 'header', 'platform', 'runtime_warning', 'plain',
]);
const CHILD_OUTPUT_DISTANCE_BUCKETS = Object.freeze(['same', '1', '2_4', '5_8', '9_16', 'none']);
const CHILD_OUTPUT_COMPONENTS = Object.freeze([
  'ipc_task_model_override', 'ipc_agent_preset_apply', 'ipc_workflow_create', 'ipc_other',
  'claude_cli_adapter', 'permission_broker', 'checkpoint_manager', 'checkpoint_lifecycle_coordinator',
  'claude_local_session_adapter', 'file_mutation_manager', 'task_manager', 'generic_product',
  'platform', 'runtime', 'unknown',
]);
const CHILD_OUTPUT_MATCH_COUNT_LIMIT = 4_096;
const CHILD_OUTPUT_CONTEXT_LINE_LIMIT = 16;
const CHILD_OUTPUT_CONTEXT_BYTE_LIMIT = 8 * 1_024;

function closedOrderedEnumValues(values, allowed, description) {
  assert(Array.isArray(values) && values.length <= allowed.length
    && values.every((value) => allowed.includes(value))
    && new Set(values).size === values.length
    && values.every((value, index) => index === 0
      || allowed.indexOf(values[index - 1]) < allowed.indexOf(value)),
  `${description} is invalid.`);
  return [...values];
}

function closedChildOutputMatchFact(input) {
  exactKeys(input, ['firstMatchStreamRole', 'streamMask', 'families', 'encodingForms', 'producerHints',
    'lineShapes', 'distanceBuckets', 'componentCounts', 'markerGroupCount', 'attributedCount',
    'unattributedCount', 'totalCount', 'saturated'], 'Child-output private-match fact');
  const firstRoleIndex = input.firstMatchStreamRole === null
    ? -1 : CHILD_OUTPUT_STREAM_ROLES.indexOf(input.firstMatchStreamRole);
  const families = closedOrderedEnumValues(input.families, CHILD_OUTPUT_MATCH_FAMILIES,
    'Child-output match families');
  const encodingForms = closedOrderedEnumValues(input.encodingForms, CHILD_OUTPUT_ENCODING_FORMS,
    'Child-output encoding forms');
  const producerHints = closedOrderedEnumValues(input.producerHints, CHILD_OUTPUT_PRODUCER_HINTS,
    'Child-output producer hints');
  const lineShapes = closedOrderedEnumValues(input.lineShapes, CHILD_OUTPUT_LINE_SHAPES,
    'Child-output line shapes');
  const distanceBuckets = closedOrderedEnumValues(input.distanceBuckets, CHILD_OUTPUT_DISTANCE_BUCKETS,
    'Child-output marker distance buckets');
  assert(Array.isArray(input.componentCounts) && input.componentCounts.length <= CHILD_OUTPUT_COMPONENTS.length,
    'Child-output component counts are invalid.');
  let componentTotal = 0;
  let unknownComponentCount = 0;
  const componentCounts = input.componentCounts.map((entry, index) => {
    exactKeys(entry, ['component', 'matchCount'], 'Child-output component count');
    const componentIndex = CHILD_OUTPUT_COMPONENTS.indexOf(entry.component);
    assert(componentIndex >= 0 && Number.isSafeInteger(entry.matchCount) && entry.matchCount > 0
      && entry.matchCount <= CHILD_OUTPUT_MATCH_COUNT_LIMIT
      && (index === 0
        || CHILD_OUTPUT_COMPONENTS.indexOf(input.componentCounts[index - 1].component) < componentIndex),
    'Child-output component count is invalid or out of order.');
    componentTotal += entry.matchCount;
    if (entry.component === 'unknown') unknownComponentCount = entry.matchCount;
    return { component: entry.component, matchCount: entry.matchCount };
  });
  assert(Number.isSafeInteger(input.streamMask) && input.streamMask >= 0 && input.streamMask <= 0b1111
    && Number.isSafeInteger(input.totalCount) && input.totalCount >= 0
    && input.totalCount <= CHILD_OUTPUT_MATCH_COUNT_LIMIT && typeof input.saturated === 'boolean'
    && Number.isSafeInteger(input.markerGroupCount) && input.markerGroupCount >= 0
    && input.markerGroupCount <= CHILD_OUTPUT_MATCH_COUNT_LIMIT
    && Number.isSafeInteger(input.attributedCount) && input.attributedCount >= 0
    && input.attributedCount <= CHILD_OUTPUT_MATCH_COUNT_LIMIT
    && Number.isSafeInteger(input.unattributedCount) && input.unattributedCount >= 0
    && input.unattributedCount <= CHILD_OUTPUT_MATCH_COUNT_LIMIT,
  'Child-output private-match fact contains an invalid bounded value.');
  assert(componentTotal === input.totalCount
    && input.attributedCount + input.unattributedCount === input.totalCount
    && unknownComponentCount === input.unattributedCount
    && input.markerGroupCount <= input.attributedCount
    && (input.attributedCount === 0 ? input.markerGroupCount === 0 : input.markerGroupCount > 0),
  'Child-output context counts do not conserve the private-match total.');
  if (input.totalCount === 0) {
    assert(firstRoleIndex === -1 && input.streamMask === 0 && families.length === 0
      && encodingForms.length === 0 && producerHints.length === 0 && lineShapes.length === 0
      && distanceBuckets.length === 0 && componentCounts.length === 0 && input.markerGroupCount === 0
      && input.attributedCount === 0 && input.unattributedCount === 0 && !input.saturated,
    'Empty child-output private-match fact is inconsistent.');
  } else {
    assert(firstRoleIndex >= 0 && (input.streamMask & (1 << firstRoleIndex)) !== 0
      && firstRoleIndex === CHILD_OUTPUT_STREAM_ROLES.findIndex((_role, index) => (
        (input.streamMask & (1 << index)) !== 0
      )) && families.length > 0 && encodingForms.length > 0 && producerHints.length > 0
      && lineShapes.length > 0 && distanceBuckets.length > 0
      && distanceBuckets.includes('none') === (input.unattributedCount > 0)
      && distanceBuckets.some((bucket) => bucket !== 'none') === (input.attributedCount > 0)
      && (!input.saturated || input.totalCount === CHILD_OUTPUT_MATCH_COUNT_LIMIT),
    'Non-empty child-output private-match fact is inconsistent.');
  }
  return {
    firstMatchStreamRole: input.firstMatchStreamRole,
    streamMask: input.streamMask,
    families,
    encodingForms,
    producerHints,
    lineShapes,
    distanceBuckets,
    componentCounts,
    markerGroupCount: input.markerGroupCount,
    attributedCount: input.attributedCount,
    unattributedCount: input.unattributedCount,
    totalCount: input.totalCount,
    saturated: input.saturated,
  };
}

const CHILD_OUTPUT_PRODUCT_COMPONENTS = Object.freeze({
  ClaudeCliAdapter: 'claude_cli_adapter',
  PermissionBroker: 'permission_broker',
  CheckpointManager: 'checkpoint_manager',
  CheckpointLifecycleCoordinator: 'checkpoint_lifecycle_coordinator',
  ClaudeLocalSessionAdapter: 'claude_local_session_adapter',
  FileMutationManager: 'file_mutation_manager',
  TaskManager: 'task_manager',
});

function childOutputStrongMarker(line) {
  const product = line.match(/^\[(ClaudeCliAdapter|PermissionBroker|CheckpointManager|CheckpointLifecycleCoordinator|ClaudeLocalSessionAdapter|FileMutationManager|TaskManager)\]/u);
  if (product) return {
    component: CHILD_OUTPUT_PRODUCT_COMPONENTS[product[1]], markerKind: 'product', characterOffset: product.index,
  };
  const ipc = line.match(/^Error occurred in handler for '([^'\r\n]+)':(?:\s.*)?$/u);
  if (ipc) {
    const component = {
      'model-selection:set-task-override': 'ipc_task_model_override',
      'agent-preset:apply': 'ipc_agent_preset_apply',
      'workflow:create': 'ipc_workflow_create',
    }[ipc[1]] ?? 'ipc_other';
    return { component, markerKind: 'ipc', characterOffset: ipc.index };
  }
  const platform = line.match(/DevTools listening on|Electron Security Warning|\[[^\]]*:(?:ERROR|WARNING):[^\]]*\.cc\(\d+\)\]/u);
  if (platform) {
    return { component: 'platform', markerKind: 'platform', characterOffset: platform.index };
  }
  const runtime = line.match(/(?:^|\s)(?:\(node:\d+\)|node:|ExperimentalWarning:|DeprecationWarning:|Warning:)/u);
  if (runtime) {
    return {
      component: 'runtime', markerKind: 'runtime',
      characterOffset: runtime.index + (runtime[0].length - runtime[0].trimStart().length),
    };
  }
  const genericProduct = line.match(/(?:^|\s)(?:Workbench initialization failed|Unable to (?:load|save)|Failed to (?:load|create|write|refresh|reset)|Command .* failed:)/u);
  if (genericProduct) {
    return {
      component: 'generic_product', markerKind: 'product',
      characterOffset: genericProduct.index + (genericProduct[0].length - genericProduct[0].trimStart().length),
    };
  }
  return null;
}

function childOutputLineShape(line) {
  if (/^\s*at(?:\s|$)/u.test(line)) return 'stack_frame';
  const marker = childOutputStrongMarker(line);
  if (marker?.component === 'platform') return 'platform';
  if (marker?.component === 'runtime') return 'runtime_warning';
  if (marker || /^\s*(?:Error|TypeError|RangeError|ReferenceError|SyntaxError):(?:\s|$)/u.test(line)) {
    return 'header';
  }
  return 'plain';
}

function childOutputLineBounds(buffer, offset) {
  assert(Buffer.isBuffer(buffer) && Number.isSafeInteger(offset) && offset >= 0 && offset < buffer.length,
    'Child-output line offset is invalid.');
  const newlineBefore = offset === 0 ? -1 : buffer.lastIndexOf(0x0a, offset - 1);
  const newlineAfter = buffer.indexOf(0x0a, offset);
  return { start: newlineBefore < 0 ? 0 : newlineBefore + 1, end: newlineAfter < 0 ? buffer.length : newlineAfter };
}

function childOutputPreviousLineBounds(buffer, current) {
  if (current.start === 0) return null;
  const end = current.start - 1;
  const newlineBefore = end === 0 ? -1 : buffer.lastIndexOf(0x0a, end - 1);
  return { start: newlineBefore < 0 ? 0 : newlineBefore + 1, end };
}

function childOutputLineText(buffer, bounds) {
  let end = bounds.end;
  if (end > bounds.start && buffer[end - 1] === 0x0d) end -= 1;
  return buffer.subarray(bounds.start, end).toString('utf8');
}

function childOutputDistanceBucket(distance) {
  if (distance === 0) return 'same';
  if (distance === 1) return '1';
  if (distance <= 4) return '2_4';
  if (distance <= 8) return '5_8';
  return '9_16';
}

function childOutputMarkerByteOffset(line, bounds, marker) {
  assert(Number.isSafeInteger(marker.characterOffset) && marker.characterOffset >= 0
    && marker.characterOffset <= line.length, 'Child-output marker character offset is invalid.');
  return bounds.start + Buffer.byteLength(line.slice(0, marker.characterOffset), 'utf8');
}

function childOutputMatchContext(buffer, offset) {
  const matched = childOutputLineBounds(buffer, offset);
  const matchedLine = childOutputLineText(buffer, matched);
  const lineShape = childOutputLineShape(matchedLine);
  const sameLineMarker = lineShape === 'stack_frame' ? null : childOutputStrongMarker(matchedLine);
  if (sameLineMarker) {
    const markerOffset = childOutputMarkerByteOffset(matchedLine, matched, sameLineMarker);
    if (markerOffset <= offset && offset - markerOffset <= CHILD_OUTPUT_CONTEXT_BYTE_LIMIT) {
      return {
        lineShape, distanceBucket: 'same', component: sameLineMarker.component, markerStart: markerOffset,
      };
    }
  }
  if (lineShape !== 'stack_frame') {
    return { lineShape, distanceBucket: 'none', component: 'unknown', markerStart: null };
  }
  let current = matched;
  for (let distance = 1; distance <= CHILD_OUTPUT_CONTEXT_LINE_LIMIT; distance += 1) {
    const previous = childOutputPreviousLineBounds(buffer, current);
    if (!previous) break;
    const previousLine = childOutputLineText(buffer, previous);
    const previousShape = childOutputLineShape(previousLine);
    if (previousShape === 'stack_frame') {
      if (offset - previous.start > CHILD_OUTPUT_CONTEXT_BYTE_LIMIT) break;
      current = previous;
      continue;
    }
    const marker = childOutputStrongMarker(previousLine);
    if (marker) {
      const markerOffset = childOutputMarkerByteOffset(previousLine, previous, marker);
      if (markerOffset <= offset && offset - markerOffset <= CHILD_OUTPUT_CONTEXT_BYTE_LIMIT) {
        return {
          lineShape, distanceBucket: childOutputDistanceBucket(distance), component: marker.component,
          markerStart: markerOffset,
        };
      }
    }
    break;
  }
  return { lineShape, distanceBucket: 'none', component: 'unknown', markerStart: null };
}

function childOutputProducerHint(buffer, offset) {
  const lineStartMarker = buffer.lastIndexOf(0x0a, Math.max(0, offset - 1));
  const lineEndMarker = buffer.indexOf(0x0a, offset);
  const lineStart = lineStartMarker < 0 ? 0 : lineStartMarker + 1;
  const lineEnd = lineEndMarker < 0 ? buffer.length : lineEndMarker;
  const line = buffer.subarray(lineStart, lineEnd).toString('utf8');
  if (/\[(?:ClaudeCliAdapter|PermissionBroker|CheckpointManager|CheckpointLifecycleCoordinator|ClaudeLocalSessionAdapter|FileMutationManager|TaskManager)\]/u.test(line)) {
    return 'product';
  }
  if (/DevTools listening on|Electron Security Warning|\[[^\]]*:(?:ERROR|WARNING):[^\]]*\.cc\(\d+\)\]/u.test(line)) {
    return 'platform';
  }
  if (/(?:^|\s)(?:\(node:\d+\)|node:|ExperimentalWarning:|DeprecationWarning:|Warning:)/u.test(line)) {
    return 'runtime';
  }
  if (/(?:^|\s)(?:Workbench initialization failed|Unable to (?:load|save)|Failed to (?:load|create|write|refresh|reset)|Command .* failed:)/u.test(line)) {
    return 'product';
  }
  return 'unknown';
}

function childOutputCandidateForms(value, pathLike) {
  const literalForms = new Set([value]);
  if (pathLike && path.isAbsolute(value)) {
    const resolved = path.resolve(value);
    for (const separatorForm of [resolved, resolved.replace(/\\/gu, '/'), resolved.replace(/\//gu, '\\')]) {
      literalForms.add(separatorForm);
      literalForms.add(separatorForm.toLocaleLowerCase('en-US'));
      literalForms.add(separatorForm.toLocaleUpperCase('en-US'));
    }
  }
  const forms = [];
  for (const literal of literalForms) {
    forms.push({ text: literal, encodingForm: 'literal_utf8' });
    const escaped = JSON.stringify(literal).slice(1, -1);
    if (escaped !== literal) forms.push({ text: escaped, encodingForm: 'json_escaped_utf8' });
  }
  return forms;
}

function scanChildOutputPrivateMatches(buffers, groups) {
  assert(Array.isArray(buffers) && buffers.length === CHILD_OUTPUT_STREAM_ROLES.length
    && buffers.every((buffer) => Buffer.isBuffer(buffer)),
  'Child-output private-match streams are invalid.');
  exactKeys(groups, CHILD_OUTPUT_MATCH_FAMILIES, 'Child-output private-match groups');
  const pathFamilies = new Set([
    'diagnostic_full', 'diagnostic_parent', 'vault_directory', 'fixture_root', 'data_root', 'real_profile',
  ]);
  const candidatesByText = new Map();
  for (const family of CHILD_OUTPUT_MATCH_FAMILIES) {
    const values = groups[family];
    assert(Array.isArray(values) && values.length <= 64
      && values.every((value) => typeof value === 'string' && value.length > 0 && value.length <= 32_768),
    'Child-output private-match group values are invalid.');
    for (const value of values) {
      for (const form of childOutputCandidateForms(value, pathFamilies.has(family))) {
        const bytes = Buffer.from(form.text, 'utf8');
        if (bytes.length === 0) continue;
        const existing = candidatesByText.get(form.text);
        const candidate = { family, encodingForm: form.encodingForm, bytes };
        if (!existing || bytes.length > existing.bytes.length
          || (bytes.length === existing.bytes.length
            && CHILD_OUTPUT_MATCH_FAMILIES.indexOf(family)
              < CHILD_OUTPUT_MATCH_FAMILIES.indexOf(existing.family))
          || (bytes.length === existing.bytes.length && family === existing.family
            && CHILD_OUTPUT_ENCODING_FORMS.indexOf(form.encodingForm)
              < CHILD_OUTPUT_ENCODING_FORMS.indexOf(existing.encodingForm))) {
          candidatesByText.set(form.text, candidate);
        }
      }
    }
  }
  const candidates = [...candidatesByText.values()];
  const families = new Set();
  const encodingForms = new Set();
  const producerHints = new Set();
  const lineShapes = new Set();
  const distanceBuckets = new Set();
  const componentCounts = new Map();
  const markerGroups = new Set();
  let streamMask = 0;
  let observedCount = 0;
  let attributedCount = 0;
  let unattributedCount = 0;
  for (let streamIndex = 0; streamIndex < buffers.length; streamIndex += 1) {
    const buffer = buffers[streamIndex];
    let cursor = 0;
    while (cursor < buffer.length) {
      let best = null;
      for (const candidate of candidates) {
        const index = buffer.indexOf(candidate.bytes, cursor);
        if (index < 0) continue;
        if (!best || index < best.index || (index === best.index && candidate.bytes.length > best.bytes.length)
          || (index === best.index && candidate.bytes.length === best.bytes.length
            && CHILD_OUTPUT_MATCH_FAMILIES.indexOf(candidate.family)
              < CHILD_OUTPUT_MATCH_FAMILIES.indexOf(best.family))) {
          best = { ...candidate, index };
        }
      }
      if (!best) break;
      streamMask |= 1 << streamIndex;
      observedCount += 1;
      if (observedCount <= CHILD_OUTPUT_MATCH_COUNT_LIMIT) {
        families.add(best.family);
        encodingForms.add(best.encodingForm);
        producerHints.add(childOutputProducerHint(buffer, best.index));
        const context = childOutputMatchContext(buffer, best.index);
        lineShapes.add(context.lineShape);
        distanceBuckets.add(context.distanceBucket);
        componentCounts.set(context.component, (componentCounts.get(context.component) ?? 0) + 1);
        if (context.component === 'unknown') {
          unattributedCount += 1;
        } else {
          attributedCount += 1;
          markerGroups.add(`${streamIndex}:${context.markerStart}`);
        }
      }
      cursor = best.index + best.bytes.length;
    }
  }
  const ordered = (values, allowed) => allowed.filter((value) => values.has(value));
  const totalCount = Math.min(observedCount, CHILD_OUTPUT_MATCH_COUNT_LIMIT);
  return closedChildOutputMatchFact({
    firstMatchStreamRole: streamMask === 0 ? null
      : CHILD_OUTPUT_STREAM_ROLES.find((_role, index) => (streamMask & (1 << index)) !== 0),
    streamMask,
    families: ordered(families, CHILD_OUTPUT_MATCH_FAMILIES),
    encodingForms: ordered(encodingForms, CHILD_OUTPUT_ENCODING_FORMS),
    producerHints: ordered(producerHints, CHILD_OUTPUT_PRODUCER_HINTS),
    lineShapes: ordered(lineShapes, CHILD_OUTPUT_LINE_SHAPES),
    distanceBuckets: ordered(distanceBuckets, CHILD_OUTPUT_DISTANCE_BUCKETS),
    componentCounts: CHILD_OUTPUT_COMPONENTS.filter((component) => componentCounts.has(component))
      .map((component) => ({ component, matchCount: componentCounts.get(component) })),
    markerGroupCount: markerGroups.size,
    attributedCount,
    unattributedCount,
    totalCount,
    saturated: observedCount > CHILD_OUTPUT_MATCH_COUNT_LIMIT,
  });
}

function recordChildOutputPrivateMatch(state, fact) {
  assert(state && typeof state === 'object' && !Array.isArray(state),
    'Child-output private-match state is invalid.');
  const closed = closedChildOutputMatchFact(fact);
  if (closed.totalCount === 0) return false;
  const firstIndex = CHILD_OUTPUT_STREAM_ROLES.indexOf(closed.firstMatchStreamRole);
  assert(state.outputStreamCount === CHILD_OUTPUT_STREAM_ROLES.length && firstIndex >= 0,
    'Child-output private-match stream cardinality is invalid.');
  state.childOutputMatch = closed;
  state.childOutputStreamIndex = firstIndex;
  state.outputStreamsScanned = firstIndex;
  return true;
}

function createPostStep15State(input) {
  exactKeys(input, ['diagnosticCandidateCount', 'tempPreserved'], 'Post-Step 15 initial state');
  assert(Number.isSafeInteger(input.diagnosticCandidateCount) && input.diagnosticCandidateCount >= 0
    && input.diagnosticCandidateCount <= 16 && typeof input.tempPreserved === 'boolean',
  'Post-Step 15 initial state is invalid.');
  return {
    gate: null,
    outputStreamCount: 0,
    outputStreamsScanned: 0,
    childOutputStreamIndex: null,
    childOutputMatch: null,
    loopbackClosedCount: 0,
    diagnosticCandidateCount: input.diagnosticCandidateCount,
    diagnosticDeletedCount: 0,
    taggedCount: null,
    listenerCount: null,
    tempRemoveAttempted: false,
    tempPreserved: input.tempPreserved,
  };
}

function closedPostStep15ObservedCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 4_096 ? value : null;
}

function closedPostStep15FailureFact(input) {
  const expectedKeys = [
    'gate', 'errorType', 'outputStreamCount', 'outputStreamsScanned', 'childOutputStreamIndex', 'childOutputMatch',
    'loopbackClosedCount', 'diagnosticCandidateCount', 'diagnosticDeletedCount', 'taggedCount',
    'listenerCount', 'tempRemoveAttempted', 'tempPreserved',
  ];
  assert(input && typeof input === 'object' && !Array.isArray(input)
    && JSON.stringify(Object.keys(input).sort()) === JSON.stringify([...expectedKeys].sort()),
  'Post-Step 15 failure keys are not closed.');
  const boundedCount = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
  const nullableCount = (value, maximum) => value === null || boundedCount(value, maximum);
  assert(POST_STEP15_GATES.includes(input.gate) && POST_STEP15_ERROR_TYPES.has(input.errorType)
    && boundedCount(input.outputStreamCount, 16)
    && boundedCount(input.outputStreamsScanned, input.outputStreamCount)
    && boundedCount(input.loopbackClosedCount, 3)
    && boundedCount(input.diagnosticCandidateCount, 16)
    && boundedCount(input.diagnosticDeletedCount, input.diagnosticCandidateCount)
    && nullableCount(input.taggedCount, 4096) && nullableCount(input.listenerCount, 4096)
    && typeof input.tempRemoveAttempted === 'boolean' && typeof input.tempPreserved === 'boolean',
  'Post-Step 15 failure contains an invalid closed value.');
  if (input.gate === 'child_output_privacy') {
    const activeStream = Number.isSafeInteger(input.childOutputStreamIndex) && input.childOutputStreamIndex >= 0
      && input.childOutputStreamIndex < input.outputStreamCount;
    const postScanMarker = input.childOutputStreamIndex === null && input.outputStreamCount > 0
      && input.outputStreamsScanned === input.outputStreamCount;
    assert(activeStream || postScanMarker,
    'Post-Step 15 child-output stream index is invalid.');
    if (input.childOutputMatch !== null) {
      const match = closedChildOutputMatchFact(input.childOutputMatch);
      const firstIndex = CHILD_OUTPUT_STREAM_ROLES.indexOf(match.firstMatchStreamRole);
      assert(activeStream && match.totalCount > 0 && input.outputStreamCount === CHILD_OUTPUT_STREAM_ROLES.length
        && input.childOutputStreamIndex === firstIndex && input.outputStreamsScanned === firstIndex,
      'Post-Step 15 child-output match evidence is inconsistent with its stream marker.');
    }
  } else {
    assert(input.childOutputStreamIndex === null, 'Post-Step 15 non-child gate retained a stream index.');
    assert(input.childOutputMatch === null, 'Post-Step 15 non-child gate retained child-output match evidence.');
  }
  return {
    gate: input.gate,
    errorType: input.errorType,
    outputStreamCount: input.outputStreamCount,
    outputStreamsScanned: input.outputStreamsScanned,
    childOutputStreamIndex: input.childOutputStreamIndex,
    childOutputMatch: input.childOutputMatch === null ? null : closedChildOutputMatchFact(input.childOutputMatch),
    loopbackClosedCount: input.loopbackClosedCount,
    diagnosticCandidateCount: input.diagnosticCandidateCount,
    diagnosticDeletedCount: input.diagnosticDeletedCount,
    taggedCount: input.taggedCount,
    listenerCount: input.listenerCount,
    tempRemoveAttempted: input.tempRemoveAttempted,
    tempPreserved: input.tempPreserved,
  };
}

async function runPostStep15GateSequence(operations, state) {
  exactKeys(operations, ['setPhase', ...POST_STEP15_GATES], 'Post-Step 15 gate operations');
  assert(Object.values(operations).every((operation) => typeof operation === 'function'),
    'Post-Step 15 gate operation is invalid.');
  assert(state && typeof state === 'object' && !Array.isArray(state), 'Post-Step 15 state is invalid.');
  for (const gate of POST_STEP15_GATES) {
    state.gate = gate;
    operations.setPhase(gate);
    try {
      await operations[gate](state);
    } catch (error) {
      const fact = closedPostStep15FailureFact({ ...state, errorType: closedErrorType(error) });
      const failure = error instanceof Error && Object.isExtensible(error)
        ? error : new Error('Post-Step 15 gate failed.');
      Object.defineProperty(failure, 'postStep15', { value: fact, enumerable: false, configurable: true });
      throw failure;
    }
  }
  return true;
}

async function stopAndRecordPostStep15Electron(state, instance, outputBuffers,
  stop = stopAndRetainOwnedElectron) {
  assert(state && typeof state === 'object' && !Array.isArray(state) && Array.isArray(outputBuffers)
    && typeof stop === 'function', 'Post-Step 15 Electron stop evidence is invalid.');
  state.outputStreamCount = outputBuffers.length;
  try {
    return await stop(instance, outputBuffers);
  } finally {
    state.outputStreamCount = outputBuffers.length;
  }
}

function markPostStep15ChildOutputPrivacyPassed(privacy, instanceCount) {
  assert(privacy && typeof privacy === 'object' && !Array.isArray(privacy)
    && privacy.passed === false && privacy.childOutputPassed === false
    && privacy.preCleanupRetainedReportPassed === false
    && privacy.ownedElectronInstancesOutputScanned === 0 && instanceCount === 2,
  'Post-Step 15 child-output privacy marker is invalid.');
  privacy.childOutputPassed = true;
  privacy.ownedElectronInstancesOutputScanned = instanceCount;
  return privacy;
}

function markPostStep15PreCleanupRetainedReportPrivacyPassed(privacy) {
  assert(privacy && typeof privacy === 'object' && !Array.isArray(privacy)
    && privacy.passed === false && privacy.childOutputPassed === true
    && privacy.preCleanupRetainedReportPassed === false
    && privacy.ownedElectronInstancesOutputScanned === 2,
  'Post-Step 15 pre-cleanup retained-report privacy marker is invalid.');
  privacy.preCleanupRetainedReportPassed = true;
  return privacy;
}

function markPostStep15FinalRetainedReportPrivacyPassed(privacy) {
  assert(privacy && typeof privacy === 'object' && !Array.isArray(privacy)
    && privacy.passed === false && privacy.childOutputPassed === true
    && privacy.preCleanupRetainedReportPassed === true
    && privacy.ownedElectronInstancesOutputScanned === 2,
  'Post-Step 15 final retained-report privacy marker is invalid.');
  privacy.passed = true;
  return privacy;
}

function createPostStep15FailureReportPrivacy(sensitiveValues, privatePathValues) {
  assert(Array.isArray(sensitiveValues) && Array.isArray(privatePathValues)
    && [...sensitiveValues, ...privatePathValues].every((value) => typeof value === 'string' && value.length > 0),
  'Post-Step 15 failure-report privacy values are invalid.');
  return {
    sensitiveValues: [...new Set(sensitiveValues)],
    privatePathValues: [...new Set(privatePathValues)],
  };
}

function extendPostStep15FailureReportPrivacy(privacy, sensitiveValues) {
  exactKeys(privacy, ['sensitiveValues', 'privatePathValues'], 'Post-Step 15 failure-report privacy');
  assert(Array.isArray(privacy.sensitiveValues) && Array.isArray(privacy.privatePathValues)
    && Array.isArray(sensitiveValues)
    && [...privacy.sensitiveValues, ...privacy.privatePathValues, ...sensitiveValues]
      .every((value) => typeof value === 'string' && value.length > 0),
  'Post-Step 15 expanded failure-report privacy values are invalid.');
  privacy.sensitiveValues = [...new Set([...privacy.sensitiveValues, ...sensitiveValues])];
  return privacy;
}

const ACCEPTANCE_CLEANUP_FAILURE_CATEGORIES = new Set([
  'native_dialog', 'electron_tree', 'provider_a_listener', 'provider_b_listener', 'deepseek_listener',
  'bound_diagnostics_identity', 'owned_temp_root',
]);

function createCleanupFailureCollector() {
  const categories = new Set();
  return Object.freeze({
    add(value) {
      assert(ACCEPTANCE_CLEANUP_FAILURE_CATEGORIES.has(value), 'Acceptance cleanup failure category is invalid.');
      categories.add(value);
    },
    values() { return [...categories]; },
  });
}

function serializeFailureReportSafely(report, sensitiveValues, privatePathValues) {
  const serialized = JSON.stringify(report, null, 2);
  try {
    assertAcceptancePrivacyBoundary(serialized, sensitiveValues, privatePathValues, 'retained_report');
    return serialized;
  } catch {
    assert(report?.schemaVersion === 1 && report?.status === 'failed'
      && report?.failure?.category === 'acceptance_assertion_failed'
      && Number.isSafeInteger(report.failure.completedSteps) && report.failure.completedSteps >= 0
      && report.failure.completedSteps <= 15,
    'Failed acceptance report cannot be projected safely.');
    const postStep15 = closedPostStep15FailureFact(report.failure.postStep15);
    assert(report.failure.phase === postStep15.gate, 'Failed acceptance phase does not match its closed gate.');
    exactKeys(report.cleanup, ['failureCategories', 'ownedTempPreserved'], 'Failed acceptance cleanup');
    assert(Array.isArray(report.cleanup.failureCategories)
      && report.cleanup.failureCategories.every((value) => ACCEPTANCE_CLEANUP_FAILURE_CATEGORIES.has(value))
      && new Set(report.cleanup.failureCategories).size === report.cleanup.failureCategories.length
      && typeof report.cleanup.ownedTempPreserved === 'boolean',
    'Failed acceptance cleanup cannot be projected safely.');
    const fallback = {
      schemaVersion: 1,
      status: 'failed',
      failure: { category: 'acceptance_assertion_failed', phase: postStep15.gate,
        completedSteps: report.failure.completedSteps, postStep15 },
      cleanup: { failureCategories: [...report.cleanup.failureCategories],
        ownedTempPreserved: report.cleanup.ownedTempPreserved },
    };
    const closed = JSON.stringify(fallback, null, 2);
    assertAcceptancePrivacyBoundary(closed, sensitiveValues, privatePathValues, 'retained_report');
    return closed;
  }
}

function assertWorkflowACompletionFact(fact) {
  assert(fact.status === 'completed', 'Workflow A did not reach the completed terminal state.');
  assert(fact.reviewRound >= 2 && fact.fixRound >= 2, 'Workflow A did not complete a Review-to-Fix loop.');
  return true;
}

function writeAnthropicStream(response, model, payload) {
  const messageId = `msg_${crypto.randomUUID().replace(/-/gu, '')}`;
  const toolUse = payload && typeof payload === 'object' && Object.hasOwn(payload, 'structured');
  const blockId = `toolu_${crypto.randomUUID().replace(/-/gu, '')}`;
  const contentEvents = toolUse ? [
    ['content_block_start', { type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: blockId, name: 'StructuredOutput', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(payload.structured) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ] : [
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: String(payload) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ];
  const events = [
    ['message_start', { type: 'message_start', message: {
      id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null,
      stop_sequence: null, usage: { input_tokens: 11, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    } }],
    ...contentEvents,
    ['message_delta', { type: 'message_delta', delta: { stop_reason: toolUse ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  response.end();
}

async function startLoopbackFixture({ name, secret, model, responseForRequest }) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'POST' && url.pathname.endsWith('/v1/messages/count_tokens')) {
        const body = await readRequestBody(request);
        requests.push({ kind: 'count_tokens', model: typeof body.model === 'string' ? body.model : null, childObserved: true });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ input_tokens: 11 }));
        return;
      }
      if (request.method === 'POST' && url.pathname.endsWith('/v1/messages')) {
        const body = await readRequestBody(request);
        const suppliedSecret = request.headers['x-api-key'] ?? request.headers.authorization?.replace(/^Bearer\s+/iu, '');
        assert(suppliedSecret === secret, `${name} loopback received the wrong fixture credential.`);
        const evidence = {
          kind: 'messages',
          model: typeof body.model === 'string' ? body.model : null,
          stream: body.stream === true,
          jsonSchemaRequested: body.output_config?.format?.type === 'json_schema'
            || body.output_format?.type === 'json_schema'
            || JSON.stringify(body).includes('json_schema'),
          topLevelKeys: Object.keys(body).sort(),
          toolNames: Array.isArray(body.tools)
            ? body.tools.map((tool) => typeof tool?.name === 'string' ? tool.name : null).filter(Boolean)
            : [],
          toolChoiceType: typeof body.tool_choice?.type === 'string' ? body.tool_choice.type : null,
          toolChoiceName: typeof body.tool_choice?.name === 'string' ? body.tool_choice.name : null,
        };
        requests.push(evidence);
        const payload = await responseForRequest(body, requests.length - 1, evidence);
        const boundaryFact = diagnosticRequestFact(body, payload);
        evidence.outputSchemaKeys = boundaryFact.outputSchemaKeys;
        evidence.responseFixtureBranch = boundaryFact.responseFixtureBranch;
        if (body.stream === true) writeAnthropicStream(response, evidence.model ?? model, payload);
        else {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(anthropicMessage(evidence.model ?? model, payload)));
        }
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'fixture endpoint not found' } }));
    } catch {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'error', error: { type: 'fixture_error', message: 'fixture rejected request' } }));
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object', `${name} loopback address is unavailable.`);
  return {
    name,
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      const closing = new Promise((resolve) => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closing;
    },
  };
}

function resolveClaudeExecutable() {
  if (process.platform !== 'win32') return 'claude';
  const located = spawnSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true, shell: false });
  assert(located.status === 0, 'Installed Claude CLI could not be resolved.');
  const candidates = located.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  const executable = candidates.find((candidate) => /\.exe$/iu.test(candidate)) ?? candidates[0];
  assert(executable && path.isAbsolute(executable), 'Installed Claude CLI path is unavailable.');
  return executable;
}

function boundedChild(command, args, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let totalBytes = 0;
    let settled = false;
    const append = (target, chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > 2 * 1024 * 1024) {
        try { child.kill(); } catch { /* already stopped */ }
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout?.on('data', (chunk) => append(stdout, chunk));
    child.stderr?.on('data', (chunk) => append(stderr, chunk));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* already stopped */ }
      reject(new Error('Bounded Claude CLI protocol probe timed out.'));
    }, timeoutMs);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ pid: child.pid, code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

async function runClaudeProtocolProbe(fixture, server, secret, model) {
  const executable = resolveClaudeExecutable();
  const versionResult = spawnSync(executable, ['--version'], {
    cwd: fixture.root,
    env: buildChildEnvironment(process.env, fixture),
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
  assert(versionResult.status === 0 && versionResult.stdout.trim().length > 0, 'Installed Claude CLI version check failed.');
  const schema = { type: 'object', properties: { ok: { type: 'boolean', const: true } }, required: ['ok'], additionalProperties: false };
  const environment = {
    ...buildChildEnvironment(process.env, fixture),
    ANTHROPIC_API_KEY: secret,
    ANTHROPIC_BASE_URL: server.origin,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
    NO_PROXY: '127.0.0.1,localhost',
  };
  assert(environment.FORCE_FAKE === undefined && environment.WORKBENCH_FORCE_FAKE_CLAUDE === undefined,
    'Protocol probe environment enabled a fake runtime.');
  const args = [
    '-p', 'Return the required JSON object and do not call tools.',
    '--output-format', 'stream-json',
    '--verbose',
    '--json-schema', JSON.stringify(schema),
    '--model', model,
    '--permission-mode', 'plan',
    '--max-turns', '1',
  ];
  const result = await boundedChild(executable, args, { cwd: fixture.root, env: environment }, 45_000);
  if (result.code !== 0) {
    const diagnosticText = result.stderr.toString('utf8');
    const stdoutText = result.stdout.toString('utf8');
    const outputEvents = stdoutText.split(/\r?\n/u).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    const outputTerminal = outputEvents.findLast((event) => event.type === 'result');
    const combinedDiagnostic = `${diagnosticText}\n${typeof outputTerminal?.result === 'string' ? outputTerminal.result : ''}`;
    const categories = {
      authentication: /auth|login|credential|api key/iu.test(combinedDiagnostic),
      connection: /connect|network|ECONN|fetch|socket/iu.test(combinedDiagnostic),
      option: /unknown option|invalid option|unexpected argument/iu.test(combinedDiagnostic),
      schema: /schema|structured/iu.test(combinedDiagnostic),
      model: /model/iu.test(combinedDiagnostic),
      rateLimit: /rate.?limit|429/iu.test(combinedDiagnostic),
      api: /api|http|status|request/iu.test(combinedDiagnostic),
      parse: /parse|json|unexpected token|invalid response/iu.test(combinedDiagnostic),
    };
    throw new Error(`Installed Claude CLI protocol probe exited nonzero: ${JSON.stringify({
      code: result.code,
      signal: result.signal,
      requestCount: server.requests.length,
      stdoutBytes: result.stdout.length,
      stderrBytes: result.stderr.length,
      initObserved: outputEvents.some((event) => event.type === 'system' && event.subtype === 'init'),
      terminalSubtype: typeof outputTerminal?.subtype === 'string' ? outputTerminal.subtype : null,
      terminalIsError: outputTerminal?.is_error === true,
      terminalResultBytes: typeof outputTerminal?.result === 'string' ? Buffer.byteLength(outputTerminal.result, 'utf8') : 0,
      loopbackRequests: server.requests.map((request) => ({ kind: request.kind, stream: request.stream ?? null,
        jsonSchemaRequested: request.jsonSchemaRequested ?? null, topLevelKeys: request.topLevelKeys ?? [],
        toolNames: request.toolNames ?? [], toolChoiceType: request.toolChoiceType ?? null,
        toolChoiceName: request.toolChoiceName ?? null })),
      categories,
    })}`);
  }
  const lines = result.stdout.toString('utf8').split(/\r?\n/u).filter(Boolean);
  const events = lines.map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  const terminal = events.findLast((event) => event.type === 'result');
  assert(events.some((event) => event.type === 'system' && event.subtype === 'init'), 'Protocol probe produced no real CLI init event.');
  assert(terminal && terminal.is_error !== true, 'Protocol probe produced no successful terminal event.');
  const structured = terminal.structured_output ?? (() => {
    try { return JSON.parse(terminal.result); } catch { return null; }
  })();
  assert(structured?.ok === true, 'Protocol probe did not return the required structured result.');
  const messages = server.requests.filter((request) => request.kind === 'messages');
  assert(messages.length >= 1 && messages.some((request) => request.stream), 'Protocol probe did not make a streaming Anthropic messages request.');
  return {
    version: versionResult.stdout.trim(),
    executableKind: path.extname(executable).toLocaleLowerCase('en-US') || 'command',
    childObserved: Number.isInteger(result.pid) && result.pid > 0,
    initObserved: true,
    terminalObserved: true,
    structuredOutputObserved: true,
    streamingRequestCount: messages.filter((request) => request.stream).length,
    requestCount: messages.length,
    stderrBytes: result.stderr.length,
  };
}

async function runProbeOnly() {
  const fixture = createIsolatedFixture();
  const secret = `cw_fixture_${crypto.randomUUID()}`;
  const model = `cw-probe-${crypto.randomUUID()}`;
  let server = null;
  let failure = null;
  let evidence = null;
  try {
    server = await startLoopbackFixture({
      name: 'Protocol probe', secret, model,
      responseForRequest: () => ({ structured: { ok: true } }),
    });
    evidence = await runClaudeProtocolProbe(fixture, server, secret, model);
  } catch (error) {
    failure = error;
  } finally {
    if (server) await server.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      safeRemoveFixture(fixture.root);
    } catch (cleanupError) {
      if (!failure) failure = cleanupError;
      else failure = new Error(`${failure instanceof Error ? failure.message : String(failure)} Cleanup also failed for the exact owned fixture.`);
    }
  }
  if (failure) throw failure;
  console.log(`BETA_READINESS_PROTOCOL_PROBE=${JSON.stringify(evidence)}`);
}

function js(value) {
  return JSON.stringify(value).replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');
}

function assertEvaluationAwaitBoundary(expression) {
  const source = String(expression);
  if (!/\bawait\b/u.test(source)) return true;
  assert(/^\s*\(\s*async\s*\(\s*\)\s*=>/u.test(source),
    'Renderer evaluation containing await must be an async IIFE.');
  return true;
}

function installEvaluationGuard(client) {
  const evaluate = client.evaluate.bind(client);
  client.evaluate = (expression, options) => {
    assertEvaluationAwaitBoundary(expression);
    return evaluate(expression, options);
  };
  return client;
}

function firstRunProviderConfigureLabel() {
  return 'Configure models';
}

function firstRunFlowLabels() {
  return { createProject: 'Create test project', generatePlan: 'Generate read-only plan',
    planReady: 'The plan is ready and waiting for your confirmation.', finish: 'Finish setup' };
}

function visibleTaskCreationContract() {
  return { rootSelector: 'aside:has([data-project-search])', accessibleName: '新建任务' };
}

function bindUniqueNewTaskId(beforeIds, afterIds) {
  assert(Array.isArray(beforeIds) && Array.isArray(afterIds), 'Task identity snapshots are unavailable.');
  const before = new Set(beforeIds);
  const after = new Set(afterIds);
  assert(before.size === beforeIds.length && after.size === afterIds.length, 'Task identity snapshot contains duplicates.');
  assert(beforeIds.every((id) => after.has(id)), 'Existing task identity disappeared during creation.');
  const created = afterIds.filter((id) => !before.has(id));
  assert(created.length === 1, 'Visible task creation did not produce exactly one new identity.');
  return created[0];
}

function firstRunProjectQueryExpression() {
  return `(async () => {
    const projects = await window.api.listProjects();
    return projects.find((item) => item.name.includes('Test')) ?? projects[0] ?? null;
  })()`;
}

function firstRunPlanEvidenceExpression(projectId) {
  return `(async () => {
    const sessions = await window.api.listSessions(${js(projectId)});
    let task = null;
    let workflow = null;
    for (const candidate of [...sessions].reverse()) {
      const candidateWorkflow = await window.api.getWorkflowByTask(candidate.id);
      if (candidateWorkflow) { task = candidate; workflow = candidateWorkflow; break; }
    }
    const dialog = document.querySelector('[role="dialog"][aria-labelledby="first-run-title"]');
    const uiReady = Boolean(dialog && Array.from(dialog.querySelectorAll('p')).some((item) =>
      item.closest('[role="dialog"]') === dialog && item.textContent?.trim() === ${js(firstRunFlowLabels().planReady)}));
    return { taskId: task?.id ?? null, workflowId: workflow?.id ?? null, workflowStatus: workflow?.status ?? null,
      currentPermissionMode: workflow?.currentPermissionMode ?? null,
      failureCode: workflow?.failure?.code ?? null, uiReady };
  })()`;
}

function selectOwnedUiButtonFact(ownerId, buttons, accessibleName, prefix = false) {
  const matches = buttons.filter((button) => button.owner === ownerId
    && (prefix ? button.accessibleName.startsWith(accessibleName) : button.accessibleName === accessibleName));
  assert(matches.length === 1, 'Owned accessible UI button is ambiguous or missing.');
  return matches[0];
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function bindElectronOutputClose(child) {
  assert(child && typeof child.once === 'function', 'Electron output-close binding is invalid.');
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

async function waitForElectronOutputClose(outputClosed, timeoutMs) {
  assert(outputClosed && typeof outputClosed.then === 'function'
    && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30_000,
  'Electron output-close wait is invalid.');
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    outputClosed.then(() => { clearTimeout(timer); resolve(true); }, () => { clearTimeout(timer); resolve(false); });
  });
}

function readElectronProcessIdentity(pid) {
  assert(process.platform === 'win32' && Number.isInteger(pid) && pid > 0,
    'Electron process identity query is invalid.');
  const script = `$process=Get-Process -Id ${pid} -ErrorAction Stop;`
    + `$cim=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop;`
    + `if($null -eq $cim){throw 'missing'};`
    + `[pscustomobject]@{pid=[int]$cim.ProcessId;startTicks=[string]$process.StartTime.ToUniversalTime().Ticks;`
    + `executablePath=[string]$cim.ExecutablePath;commandLine=[string]$cim.CommandLine}|ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script,
  ], { encoding: 'utf8', windowsHide: true, shell: false, maxBuffer: 64 * 1024 });
  assert(result.status === 0 && result.stdout.trim(), 'Electron process identity is unavailable.');
  try { return JSON.parse(result.stdout); } catch { throw new Error('Electron process identity is invalid.'); }
}

function bindElectronProcessIdentity(instance, controls = {}) {
  const pid = instance?.child?.pid;
  assert(Number.isInteger(pid) && pid > 0
    && typeof instance.acceptanceTag === 'string' && /^[0-9a-f-]{36}$/iu.test(instance.acceptanceTag)
    && typeof instance.executablePath === 'string' && path.isAbsolute(instance.executablePath),
  'Preliminary Electron process identity is invalid.');
  const readProcessIdentity = controls.readProcessIdentity ?? readElectronProcessIdentity;
  const tokenize = controls.tokenize ?? parseWindowsCommandLineExact;
  assert(typeof readProcessIdentity === 'function' && typeof tokenize === 'function',
    'Electron process identity controls are invalid.');
  const record = readProcessIdentity(pid);
  exactKeys(record, ['pid', 'startTicks', 'executablePath', 'commandLine'], 'Electron process identity');
  assert(record.pid === pid && typeof record.startTicks === 'string' && /^\d+$/u.test(record.startTicks)
    && typeof record.executablePath === 'string' && path.isAbsolute(record.executablePath)
    && samePath(record.executablePath, instance.executablePath)
    && typeof record.commandLine === 'string' && record.commandLine.length > 0 && !record.commandLine.includes('\0'),
  'Electron process identity does not match the owned child.');
  const tokens = tokenize(record.commandLine);
  const acceptanceToken = `--cw-beta-acceptance=${instance.acceptanceTag}`;
  const acceptanceFlags = Array.isArray(tokens)
    ? tokens.filter((token) => typeof token === 'string'
      && (token === '--cw-beta-acceptance' || token.startsWith('--cw-beta-acceptance='))) : [];
  assert(Array.isArray(tokens) && tokens.length > 0 && tokens.every((token) => typeof token === 'string')
    && samePath(tokens[0], instance.executablePath)
    && acceptanceFlags.length === 1 && acceptanceFlags[0] === acceptanceToken,
  'Electron process command identity does not match the owned child.');
  assert(instance.startTicks === null || instance.startTicks === record.startTicks,
    'Electron process start identity changed.');
  instance.startTicks = record.startTicks;
  return record.startTicks;
}

async function stopElectron(instance, controls = {}) {
  try { await instance?.client?.close(); } catch { /* already closed */ }
  const pid = instance?.child?.pid;
  assert(Number.isInteger(pid) && pid > 0 && instance.outputClosed,
    'Electron process/output identity is unavailable for termination.');
  const closeTimeoutMs = controls.closeTimeoutMs ?? 5_000;
  const alreadyExited = instance.child.exitCode !== null || instance.child.signalCode !== null;
  if (!alreadyExited) {
    if (process.platform === 'win32') {
      if (controls.readStartTicks) {
        const identity = controls.readStartTicks(pid);
        assert(identity === instance.startTicks, 'Electron PID identity changed before tree termination.');
      } else {
        bindElectronProcessIdentity(instance, {
          ...(controls.readProcessIdentity ? { readProcessIdentity: controls.readProcessIdentity } : {}),
          ...(controls.tokenize ? { tokenize: controls.tokenize } : {}),
        });
      }
      const terminateTree = controls.terminateTree ?? ((targetPid) => spawnSync('taskkill.exe',
        ['/PID', String(targetPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false }));
      const termination = terminateTree(pid);
      assert(termination && !termination.error && termination.status === 0, 'Electron tree termination failed.');
    } else {
      let terminated = false;
      try { process.kill(pid, 'SIGTERM'); terminated = true; } catch { /* fixed failure below */ }
      assert(terminated, 'Electron tree termination failed.');
    }
  }
  assert(await waitForElectronOutputClose(instance.outputClosed, closeTimeoutMs),
    'Electron output close confirmation timed out.');
  return true;
}

async function stopAndRetainOwnedElectron(instance, target, stopOwned = stopElectron) {
  assert(typeof stopOwned === 'function', 'Owned Electron stop operation is invalid.');
  assert(await stopOwned(instance) === true, 'Owned Electron stop did not confirm completion.');
  assert(retainOwnedElectronOutputBuffers(target, instance) === 2,
    'Owned Electron complete output streams were not retained.');
  return true;
}

async function runOwnedElectronLaunchReadiness(instance, transferOwnership, readiness, stopOwned = stopElectron,
  bindStartIdentity = bindElectronProcessIdentity) {
  assert(instance && typeof transferOwnership === 'function' && typeof readiness === 'function'
    && typeof stopOwned === 'function' && typeof bindStartIdentity === 'function',
  'Owned Electron launch readiness contract is invalid.');
  transferOwnership(instance);
  try {
    await bindStartIdentity(instance);
    return await readiness(instance);
  } catch (error) {
    await stopOwned(instance);
    throw error;
  }
}

async function launchProductionElectron(fixture, transferOwnership) {
  const executable = electron.default || electron;
  const environment = {
    ...buildElectronChildEnvironment(process.env, fixture),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
    NO_PROXY: '127.0.0.1,localhost',
  };
  assert(environment.FORCE_FAKE === undefined && environment.WORKBENCH_FORCE_FAKE_CLAUDE === undefined,
    'Production Electron environment enabled a fake adapter.');
  const acceptanceTag = crypto.randomUUID();
  const devToolsFile = path.join(fixture.browserRoot, 'DevToolsActivePort');
  if (fs.existsSync(devToolsFile)) fs.unlinkSync(devToolsFile);
  const child = spawn(executable, [
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${fixture.browserRoot}`,
    `--cw-beta-acceptance=${acceptanceTag}`,
    '.',
  ], { cwd: WORKSPACE_ROOT, env: environment, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const outputClosed = bindElectronOutputClose(child);
  const stdout = [];
  const stderr = [];
  child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  const ownedInstance = { child, client: null, port: null, stdout, stderr, outputClosed,
    startTicks: process.platform === 'win32' ? null : String(Date.now()), acceptanceTag, executablePath: executable };
  return runOwnedElectronLaunchReadiness(ownedInstance, transferOwnership, async (owned) => {
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    while (!fs.existsSync(devToolsFile) && Date.now() < deadline
      && child.exitCode === null && child.signalCode === null) await new Promise((resolve) => setTimeout(resolve, 50));
    assert(fs.existsSync(devToolsFile), 'Electron did not publish DevToolsActivePort.');
    const [portText] = fs.readFileSync(devToolsFile, 'utf8').split(/\r?\n/u);
    const port = Number(portText);
    assert(Number.isInteger(port) && port > 0 && port <= 65535, 'Published CDP port is invalid.');
    owned.port = port;
    const page = await waitForCdpPage(port, {
      timeoutMs: STEP_TIMEOUT_MS,
      processExited: () => child.exitCode !== null || child.signalCode !== null,
    });
    const client = installEvaluationGuard(await CdpClient.connect(page.webSocketDebuggerUrl));
    owned.client = client;
    await Promise.all([client.send('Runtime.enable'), client.send('Page.enable'), client.send('Log.enable')]);
    await client.waitFor(`document.readyState === 'complete' && Boolean(window.api)
      && document.getElementById('root')?.children.length > 0`, {
      description: 'production Workbench renderer and preload', timeoutMs: STEP_TIMEOUT_MS,
    });
    return owned;
  });
}

async function clickOwnedAccessibleButton(client, rootSelector, accessibleName, prefix = false) {
  const clicked = await client.evaluate(`(() => {
    const roots = Array.from(document.querySelectorAll(${js(rootSelector)}));
    if (roots.length !== 1) return false;
    const root = roots[0];
    const wanted = ${js(accessibleName)};
    const normalize = (value) => String(value || '').replace(/\\s+/gu, ' ').trim();
    const matches = Array.from(root.querySelectorAll('button, [role="button"]')).filter((element) => {
      const rect = element.getBoundingClientRect();
      const name = normalize(element.getAttribute('aria-label') || element.textContent);
      return rect.width > 0 && rect.height > 0 && !element.disabled
        && element.closest(${js(rootSelector)}) === root
        && (${prefix ? 'name.startsWith(wanted)' : 'name === wanted'});
    });
    if (matches.length !== 1) return false;
    matches[0].click();
    return true;
  })()`);
  assert(clicked, `Owned accessible UI control unavailable: ${accessibleName}`);
}

async function clickFirstRunButton(client, accessibleName, prefix = false) {
  await clickOwnedAccessibleButton(client, '[role="dialog"][aria-labelledby="first-run-title"]', accessibleName, prefix);
}

async function clickSettingsCategory(client, accessibleName) {
  await clickOwnedAccessibleButton(client, '[data-testid="settings-sidebar"]', accessibleName);
}

async function clickTestId(client, testId) {
  const clicked = await client.evaluate(`(() => {
    const root = document.querySelector(${js(`[data-testid="${testId}"]`)});
    const item = root?.matches('button, [role="button"]') ? root : root?.querySelector('button, [role="button"]');
    if (!item || item.disabled) return false;
    item.click();
    return true;
  })()`);
  assert(clicked, `UI control unavailable: ${testId}`);
}

async function clickExactCheckboxTestId(client, testId) {
  const clicked = await client.evaluate(`(() => {
    const item = document.querySelector(${js(`[data-testid="${testId}"]`)});
    if (!item?.matches('input[type="checkbox"]') || item.disabled) return false;
    item.click();
    return true;
  })()`);
  assert(clicked, `Checkbox UI control unavailable: ${testId}`);
}

async function initializeGitViaVisibleUi(client, phases) {
  const drawerOpened = await client.evaluate(`(() => {
    const matches = Array.from(document.querySelectorAll('button[title="File Changes"]')).filter((button) => {
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !button.disabled;
    });
    if (matches.length !== 1) return false; matches[0].click(); return true;
  })()`);
  assert(drawerOpened, 'Visible File Changes toolbar control is ambiguous or unavailable.');
  phases.push('drawer_open');
  await client.waitFor(`Boolean(document.querySelector('[data-testid="workspace-right-drawer"]'))`, {
    description: 'visible workspace right drawer', timeoutMs: STEP_TIMEOUT_MS,
  });
  const gitTabClicked = await client.evaluate(`(() => {
    const drawer = document.querySelector('[data-testid="workspace-right-drawer"]');
    const matches = drawer ? Array.from(drawer.querySelectorAll('[data-testid="right-drawer-tab"][data-tab="git"]')) : [];
    if (matches.length !== 1 || matches[0].disabled) return false; matches[0].click(); return true;
  })()`);
  assert(gitTabClicked, 'Visible Git drawer tab is ambiguous or unavailable.');
  phases.push('git_tab');
  await client.waitFor(`Boolean(document.querySelector('[data-testid="workspace-right-drawer"] [data-testid="git-state-not-repository"]')
    && document.querySelector('[data-testid="workspace-right-drawer"] [data-testid="git-initialize"]'))`, {
    description: 'trusted non-repository Git UI state', timeoutMs: STEP_TIMEOUT_MS,
  });
  await clickTestId(client, 'git-initialize');
  phases.push('git_initialize');
  await client.waitFor(`Boolean(document.querySelector('[data-testid="workspace-right-drawer"] [data-testid="git-status-summary"]'))
    && !document.querySelector('[data-testid="workspace-right-drawer"] [data-testid="git-state-not-repository"]')
    && !document.querySelector('[data-testid="workspace-right-drawer"] [data-testid="git-initialize-error"]')`, {
    description: 'trusted repository Git UI state after visible initialization', timeoutMs: STEP_TIMEOUT_MS,
  });
  phases.push('repository_ready');
  return { initializationMethod: 'visible_ui', repositoryUiTrusted: true };
}

function selectExactDialogButtonFact(dialogs, title, buttonText) {
  const matchingDialogs = dialogs.filter((dialog) => dialog.headings
    .some((heading) => heading.owner === dialog.id && heading.text === title));
  assert(matchingDialogs.length === 1, 'Exact modal dialog is ambiguous or missing.');
  const buttons = matchingDialogs[0].buttons.filter((text) => text === buttonText);
  assert(buttons.length === 1, 'Exact modal button is ambiguous or missing.');
  return buttons[0];
}

function selectReadyExactDialogButtonFact(dialogs, title, buttonText) {
  const matchingDialogs = dialogs.filter((dialog) => dialog.headings
    .some((heading) => heading.owner === dialog.id && heading.text === title));
  assert(matchingDialogs.length === 1, 'Exact ready modal dialog is ambiguous or missing.');
  const buttons = matchingDialogs[0].buttons.filter((button) => button.owner === matchingDialogs[0].id
    && button.text === buttonText && button.disabled === false);
  assert(buttons.length === 1, 'Exact enabled modal-owned button is ambiguous or missing.');
  return buttons[0];
}

function selectExactOwnedAccessibleButtonFact(dialog, accessibleName) {
  const matches = dialog.buttons.filter((button) => button.owner === dialog.id && button.accessibleName === accessibleName);
  assert(matches.length === 1, 'Exact dialog-owned accessible button is ambiguous or missing.');
  return matches[0];
}

async function clickExactDialogButton(client, dialogTitle, buttonText) {
  await client.waitFor(`(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/gu, ' ').trim();
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter((dialog) =>
      Array.from(dialog.querySelectorAll('h1,h2,h3')).some((heading) => heading.closest('[role="dialog"]') === dialog
        && normalize(heading.textContent) === ${js(dialogTitle)}));
    if (dialogs.length !== 1) return false;
    const buttons = Array.from(dialogs[0].querySelectorAll('button')).filter((button) =>
      button.closest('[role="dialog"]') === dialogs[0] && !button.disabled
        && normalize(button.getAttribute('aria-label') || button.textContent) === ${js(buttonText)});
    return buttons.length === 1;
  })()`, { description: `exact modal control ${dialogTitle}/${buttonText}`, timeoutMs: STEP_TIMEOUT_MS });
  const clicked = await client.evaluate(`(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/gu, ' ').trim();
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter((dialog) =>
      Array.from(dialog.querySelectorAll('h1,h2,h3')).some((heading) => heading.closest('[role="dialog"]') === dialog
        && normalize(heading.textContent) === ${js(dialogTitle)}));
    if (dialogs.length !== 1) return false;
    const buttons = Array.from(dialogs[0].querySelectorAll('button')).filter((button) =>
      button.closest('[role="dialog"]') === dialogs[0] && !button.disabled
        && normalize(button.getAttribute('aria-label') || button.textContent) === ${js(buttonText)});
    if (buttons.length !== 1) return false;
    buttons[0].click(); return true;
  })()`);
  assert(clicked, `Exact modal control unavailable: ${dialogTitle}/${buttonText}`);
}

async function openSettingsCategory(client, label) {
  const opened = await client.evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('button')).filter((button) => {
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !button.disabled && String(button.title || '').endsWith(' (Ctrl+,)');
    });
    if (items.length !== 1) return false; items[0].click(); return true;
  })()`);
  assert(opened, 'Settings toolbar control unavailable.');
  await client.waitFor(`Boolean(document.querySelector('[role="dialog"][aria-labelledby="settings-dialog-title"]')
    && document.querySelector('[data-testid="settings-sidebar"]'))`,
  { description: 'Settings dialog' });
  await clickSettingsCategory(client, label);
}

async function closeSettings(client) {
  const closed = await client.evaluate(`(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"][aria-labelledby="settings-dialog-title"]'));
    if (dialogs.length !== 1) return false;
    const dialog = dialogs[0];
    const buttons = Array.from(dialog.querySelectorAll('button')).filter((button) =>
      button.closest('[role="dialog"]') === dialog && button.getAttribute('aria-label') === 'Close' && !button.disabled);
    if (buttons.length !== 1) return false; buttons[0].click(); return true;
  })()`);
  if (!closed) await client.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await client.waitFor(`!document.querySelector('[data-testid="model-provider-center"]')
    && !document.querySelector('[aria-labelledby="settings-dialog-title"]')`,
    { description: 'Settings dialog close' });
}

async function setProviderEditorControl(client, index, value) {
  const changed = await client.evaluate(`(() => {
    const element = Array.from(document.querySelectorAll('[data-testid="provider-editor"] .provider-input'))[${index}];
    if (!element) return false;
    const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, ${js(value)});
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    return element.value === ${js(value)};
  })()`);
  assert(changed, `Provider editor control ${index} could not be set.`);
}

async function addProviderUi(client, input) {
  await clickTestId(client, 'add-provider');
  await client.waitFor(`Boolean(document.querySelector('[data-testid="provider-editor"]'))`, { description: 'Provider editor' });
  for (const [index, value] of [[0, input.name], [1, input.type], [3, input.baseUrl], [4, input.modelId], [5, input.secret]]) {
    await setProviderEditorControl(client, index, value);
  }
  const passwordBefore = await client.evaluate(`document.querySelector('[data-testid="provider-editor"] input[type="password"]')?.value.length ?? -1`);
  assert(passwordBefore === input.secret.length, 'Fixture secret did not reach transient password state.');
  await clickTestId(client, 'validate-provider');
  await client.waitFor(`(() => {
    const editor = document.querySelector('[data-testid="provider-editor"]');
    const save = editor?.querySelector('[data-testid="save-provider"]');
    const password = editor?.querySelector('input[type="password"]');
    return Boolean(save && !save.disabled && password?.value === '');
  })()`, { description: `${input.name} validated and secret cleared`, timeoutMs: STEP_TIMEOUT_MS });
  const rendererSecretCleared = await client.evaluate(`document.querySelector('[data-testid="provider-editor"] input[type="password"]')?.value === ''`);
  await clickTestId(client, 'save-provider');
  await client.waitFor(`!document.querySelector('[data-testid="provider-editor"]')`, { description: `${input.name} saved` });
  const provider = await client.evaluate(`(async () => (await window.api.listModelProviders({ limit: 100, offset: 0 })).items
    .find((item) => item.name === ${js(input.name)}) ?? null)()`);
  assert(provider, `${input.name} was not saved.`);
  return { provider, rendererSecretCleared };
}

async function screenshot(client, name) {
  validateScreenshotRoot(WORKSPACE_ROOT, SCREENSHOT_ROOT);
  fs.mkdirSync(SCREENSHOT_ROOT, { recursive: true });
  const target = path.join(SCREENSHOT_ROOT, name);
  const captured = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(target, Buffer.from(captured.data, 'base64'));
  return { file: path.relative(WORKSPACE_ROOT, target).replace(/\\/gu, '/'), sha256: sha256File(target), bytes: fs.statSync(target).size };
}

async function captureDataSettingsScreenshotMasked(client, name, expectedDataPath, capture = screenshot,
  privatePathValues = privatePathTextVariants([expectedDataPath])) {
  assert(typeof expectedDataPath === 'string' && path.isAbsolute(expectedDataPath),
    'Expected Data screenshot path identity is invalid.');
  assert(Array.isArray(privatePathValues) && privatePathValues.includes(expectedDataPath),
    'Data screenshot private path variants are incomplete.');
  const original = expectedDataPath;
  let screenshotArtifact = null;
  let primaryFailure = null;
  let maskWasActive = false;
  try {
    const mask = await client.evaluate(`(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"][aria-labelledby="settings-dialog-title"]'));
      if (dialogs.length !== 1) return { bound: false, active: false };
      const contents = Array.from(dialogs[0].querySelectorAll('[data-testid="settings-content"]'));
      if (contents.length !== 1) return { bound: false, active: false };
      const content = contents[0];
      const checkboxes = Array.from(content.querySelectorAll('[data-testid="data-anonymous-performance"]'))
        .filter((item) => item.matches('input[type="checkbox"]'));
      const existingMasks = Array.from(content.querySelectorAll('[data-cw-beta-screenshot-mask="data-storage-path"]'));
      const targets = Array.from(content.querySelectorAll('div'))
        .filter((item) => item.children.length === 0 && item.textContent === ${js(expectedDataPath)});
      if (checkboxes.length !== 1 || existingMasks.length !== 0 || targets.length !== 1) {
        return { bound: false, active: false };
      }
      targets[0].setAttribute('data-cw-beta-screenshot-mask', 'data-storage-path');
      targets[0].textContent = ${js(DATA_SCREENSHOT_PATH_MASK)};
      const viewportText = document.body?.innerText ?? '';
      const privatePaths = ${js(privatePathValues)};
      return { bound: true, active: targets[0].textContent === ${js(DATA_SCREENSHOT_PATH_MASK)}
        && targets[0].getAttribute('data-cw-beta-screenshot-mask') === 'data-storage-path',
      privatePathAbsent: privatePaths.every((value) => !viewportText.includes(value)) };
    })()`);
    assert(mask?.bound === true && mask.active === true && mask.privatePathAbsent === true,
      'Exact Data path screenshot mask could not be activated.');
    maskWasActive = true;
    screenshotArtifact = await capture(client, name);
  } catch (error) {
    primaryFailure = error;
  } finally {
    let restored = null;
    try {
      restored = await client.evaluate(`(() => {
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"][aria-labelledby="settings-dialog-title"]'));
        if (dialogs.length !== 1) return { restored: false };
        const contents = Array.from(dialogs[0].querySelectorAll('[data-testid="settings-content"]'));
        if (contents.length !== 1) return { restored: false };
        const content = contents[0];
        const masks = Array.from(content.querySelectorAll('[data-cw-beta-screenshot-mask="data-storage-path"]'));
        if (masks.length === 0) {
          const originals = Array.from(content.querySelectorAll('div'))
            .filter((item) => item.children.length === 0 && item.textContent === ${js(original)});
          return { restored: originals.length === 1 };
        }
        if (masks.length !== 1 || masks[0].textContent !== ${js(DATA_SCREENSHOT_PATH_MASK)}) return { restored: false };
        masks[0].textContent = ${js(original)};
        masks[0].removeAttribute('data-cw-beta-screenshot-mask');
        const remaining = Array.from(content.querySelectorAll('[data-cw-beta-screenshot-mask="data-storage-path"]'));
        return { restored: remaining.length === 0 && masks[0].textContent === ${js(original)} };
      })()`);
    } catch {
      restored = { restored: false };
    }
    if (restored?.restored !== true) {
      const restorationFailure = new Error('Exact Data path screenshot mask was not restored.');
      if (!primaryFailure) primaryFailure = restorationFailure;
      else primaryFailure.screenshotMaskRestoration = 'failed';
    }
  }
  if (primaryFailure) throw primaryFailure;
  assert(maskWasActive && screenshotArtifact, 'Masked Data screenshot did not complete.');
  return { screenshot: screenshotArtifact, mask: { activeAtCapture: true, originalRestored: true,
    screenshotOnly: true, privatePathVariantsAbsentAtCapture: true,
    scope: 'exact-data-storage-path-display' } };
}

function assertRestartScreenshotReadyFact(input) {
  exactKeys(input, ['loadingOverlayCount', 'historyLoadingCount', 'visibleProjectButtonCount',
    'visibleTaskButtonCount', 'visibleCurrentWorkflowCount', 'visibleWorkflowControlsCount',
    'visibleWorkflowPanelCount', 'selectedWorkflowListItemCount', 'workflowStatusLeafCount',
    'workflowIdentityLeafCount', 'authoritativeWorkflowMatch'], 'Restart screenshot readiness');
  assert(input.loadingOverlayCount === 0 && input.historyLoadingCount === 0,
    'Restart screenshot still has a loading overlay.');
  assert(input.visibleProjectButtonCount === 1 && input.visibleTaskButtonCount === 1,
    'Restart screenshot project/task identity is ambiguous or missing.');
  assert(input.visibleCurrentWorkflowCount === 1 && input.visibleWorkflowControlsCount === 1
    && input.visibleWorkflowPanelCount === 1 && input.selectedWorkflowListItemCount === 1
    && input.workflowStatusLeafCount === 1 && input.workflowIdentityLeafCount === 1
    && input.authoritativeWorkflowMatch === true,
  'Restart screenshot persisted Workflow UI is ambiguous, stale, or missing.');
  return true;
}

function restartScreenshotUiFactExpression(projectName, taskId, workflowId, workflowStatus) {
  return `(() => {
    const visible = (item) => {
      if (!item) return false;
      const rect = item.getBoundingClientRect();
      const style = getComputedStyle(item);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const sidebars = Array.from(document.querySelectorAll('aside'))
      .filter((item) => item.querySelectorAll('[data-project-search]').length === 1 && visible(item));
    const projectButtons = sidebars.length === 1 ? Array.from(sidebars[0].querySelectorAll('button'))
      .filter((button) => Array.from(button.children).some((child) => child.children.length === 0
        && child.textContent?.trim() === ${js(projectName)}) && visible(button)) : [];
    const taskButtons = sidebars.length === 1 ? Array.from(sidebars[0].querySelectorAll('[data-session-key]'))
      .filter((button) => button.getAttribute('data-session-key')?.endsWith(${js(`::${taskId}`)})
        && visible(button)) : [];
    const currentWorkflows = Array.from(document.querySelectorAll('[data-testid="current-workflow"]'))
      .filter(visible);
    const controls = currentWorkflows.length === 1
      ? Array.from(currentWorkflows[0].querySelectorAll('[data-testid="workflow-controls"]')).filter(visible) : [];
    const panels = currentWorkflows.length === 1
      ? Array.from(currentWorkflows[0].querySelectorAll('[data-testid="workflow-panel"]')).filter(visible) : [];
    const selectedWorkflowItems = panels.length === 1
      ? Array.from(panels[0].querySelectorAll('[data-testid="workflow-list-item"]'))
        .filter((item) => item.getAttribute('data-workflow-id') === ${js(workflowId)}
          && item.getAttribute('aria-current') === 'true' && visible(item)) : [];
    const statusLeaves = controls.length === 1 ? Array.from(controls[0].querySelectorAll('span'))
      .filter((item) => item.children.length === 0 && item.textContent?.trim() === ${js(workflowStatus)}
        && visible(item)) : [];
    const identityLeaves = panels.length === 1 ? Array.from(panels[0].querySelectorAll('span'))
      .filter((item) => item.children.length === 0 && item.textContent === ${js(workflowId)} && visible(item)) : [];
    return {
      loadingOverlayCount: document.querySelectorAll('[role="status"][aria-live="polite"]').length,
      historyLoadingCount: document.querySelectorAll('[data-testid="history-loading"]').length,
      visibleProjectButtonCount: projectButtons.length,
      visibleTaskButtonCount: taskButtons.length,
      visibleCurrentWorkflowCount: currentWorkflows.length,
      visibleWorkflowControlsCount: controls.length,
      visibleWorkflowPanelCount: panels.length,
      selectedWorkflowListItemCount: selectedWorkflowItems.length,
      workflowStatusLeafCount: statusLeaves.length,
      workflowIdentityLeafCount: identityLeaves.length,
    };
  })()`;
}

async function waitForRestartScreenshotReady(client, projectName, taskId, workflowId, workflowStatus) {
  await selectTaskUi(client, taskId);
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  let fact = null;
  while (Date.now() < deadline) {
    const [ui, byTask] = await Promise.all([
      client.evaluate(restartScreenshotUiFactExpression(projectName, taskId, workflowId, workflowStatus)),
      client.evaluate(`window.api.getWorkflowByTask(${js(taskId)})`),
    ]);
    fact = { ...ui, authoritativeWorkflowMatch: byTask?.id === workflowId && byTask?.status === workflowStatus
      && byTask?.taskId === taskId };
    try {
      assertRestartScreenshotReadyFact(fact);
      return fact;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
  }
  assertRestartScreenshotReadyFact(fact);
  return fact;
}

async function selectTaskUi(client, taskId) {
  await client.waitFor(`(() => {
    const matches = Array.from(document.querySelectorAll(${js(`[data-session-key$="::${taskId}"]`)})).filter((item) => {
      const rect = item.getBoundingClientRect(); const style = getComputedStyle(item);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    });
    return matches.length === 1;
  })()`, {
    description: 'task sidebar identity', timeoutMs: STEP_TIMEOUT_MS,
  });
  const selected = await client.evaluate(`(() => {
    const matches = Array.from(document.querySelectorAll(${js(`[data-session-key$="::${taskId}"]`)})).filter((item) => {
      const rect = item.getBoundingClientRect(); const style = getComputedStyle(item);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    });
    if (matches.length !== 1 || matches[0].disabled) return false;
    matches[0].click(); return true;
  })()`);
  assert(selected, 'Task UI selection failed.');
}

async function createTaskViaVisibleUi(client, projectId) {
  const beforeIds = await client.evaluate(`(async () => (await window.api.listSessions(${js(projectId)})).map((item) => item.id))()`);
  const contract = visibleTaskCreationContract();
  await clickOwnedAccessibleButton(client, contract.rootSelector, contract.accessibleName);
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  let taskId = null;
  while (!taskId && Date.now() < deadline) {
    const afterIds = await client.evaluate(`(async () => (await window.api.listSessions(${js(projectId)})).map((item) => item.id))()`);
    const newIds = afterIds.filter((id) => !beforeIds.includes(id));
    if (newIds.length > 0) taskId = bindUniqueNewTaskId(beforeIds, afterIds);
    else await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert(taskId, 'Visible task creation did not complete.');
  await selectTaskUi(client, taskId);
  return taskId;
}

async function waitForWorkflowTerminalFact(client, workflowId, timeoutMs) {
  const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'paused']);
  const deadline = Date.now() + timeoutMs;
  let workflow = null;
  while (Date.now() < deadline) {
    workflow = await client.evaluate(`window.api.getWorkflow(${js(workflowId)})`);
    if (terminalStatuses.has(workflow?.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  return { workflow, fact: closedWorkflowTerminalFact(workflow) };
}

function requestedStructuredOutputSchema(body) {
  const named = Array.isArray(body?.tools) ? body.tools.filter((tool) => tool?.name === 'StructuredOutput') : [];
  assert(named.length <= 1, 'StructuredOutput tool schema is ambiguous.');
  return named[0]?.input_schema ?? body?.output_config?.format?.schema ?? body?.output_format?.schema ?? null;
}

function stagePayload(body, counters) {
  const schema = requestedStructuredOutputSchema(body);
  const keys = new Set(Object.keys(schema?.properties ?? {}));
  if (keys.has('ok') && schema?.properties?.ok?.const === true) return { structured: { ok: true } };
  if (keys.has('filesExpected')) return { structured: {
    title: 'Read-only project analysis', summary: 'A bounded analysis plan.',
    steps: [{ id: 1, title: 'Inspect the project structure', risk: 'low' }],
    filesExpected: [], estimatedChanges: 'No file changes.', riskLevel: 'low',
  } };
  if (keys.has('filesChanged')) return { structured: {
    summary: 'No project files were modified.', filesChanged: [], testsSuggested: [],
  } };
  if (keys.has('commands') && keys.has('skipped')) return { structured: {
    summary: 'Read-only verification passed.', passed: 1, failed: 0, skipped: 0, commands: [],
  } };
  if (keys.has('issues') && keys.has('score')) {
    counters.reviews += 1;
    return { structured: counters.reviews === 1 ? {
      round: 1, score: 7, summary: 'One bounded issue requires a fix pass.',
      issues: [{ severity: 'low', title: 'Clarify the read-only result', recommendation: 'Run one bounded fix pass.', file: null, line: null }],
      tests: { passed: 1, failed: 0, skipped: 0 },
    } : {
      round: counters.reviews, score: 10, summary: 'Review passed.', issues: [],
      tests: { passed: 1, failed: 0, skipped: 0 },
    } };
  }
  return 'Connection verified by the local acceptance fixture.';
}

async function startDeepSeekFixture(secret, model) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const supplied = request.headers.authorization?.replace(/^Bearer\s+/iu, '') ?? request.headers['x-api-key'];
    assert(supplied === secret, 'DeepSeek fixture received the wrong random credential.');
    const kind = url.pathname.endsWith('/models') ? 'models'
      : url.pathname.endsWith('/chat/completions') ? 'chat' : 'other';
    requests.push({ method: request.method, kind });
    if (request.method === 'GET' && url.pathname.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model' }] }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'fixture endpoint not found' } }));
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert(address && typeof address === 'object', 'DeepSeek fixture address unavailable.');
  return { secret, model, requests, origin: `http://127.0.0.1:${address.port}`, async close() {
    const done = new Promise((resolve) => server.close(resolve)); for (const socket of sockets) socket.destroy(); await done;
  } };
}

function databasePath(fixture) {
  return path.join(fixture.dataRoot, 'claude-workbench.db');
}

function inspectDatabase(fixture, workflowIds = []) {
  const database = new BetterSqlite3(databasePath(fixture), { readonly: true, fileMustExist: true });
  try {
    const integrity = database.pragma('integrity_check', { simple: true });
    const foreignKeys = database.pragma('foreign_key_check');
    const workflows = workflowIds.map((id) => {
      const row = database.prepare('SELECT id, status, metadata_json FROM workflows WHERE id = ?').get(id);
      return row ? { ...row, metadata: JSON.parse(row.metadata_json) } : null;
    });
    const workflowCount = database.prepare('SELECT COUNT(*) AS count FROM workflows').get().count;
    const stages = workflowIds.flatMap((id) => database.prepare(`SELECT workflow_id, agent_type AS stage, review_round, status, input, output
      FROM workflow_steps WHERE workflow_id = ? ORDER BY started_at ASC, id ASC`).all(id).map((row) => ({
      ...row, input: JSON.parse(row.input), output: row.output ? JSON.parse(row.output) : null,
    })));
    return { integrity, foreignKeyViolationCount: foreignKeys.length, workflowCount, workflows, stages };
  } finally { database.close(); }
}

function inspectFirstRunNonGitEvidence(fixture, workflowId, taskId) {
  const database = new BetterSqlite3(databasePath(fixture), { readonly: true, fileMustExist: true });
  try {
    const workflow = database.prepare('SELECT status, metadata_json FROM workflows WHERE id = ? AND task_id = ?').get(workflowId, taskId);
    assert(workflow, 'Persisted First Run workflow identity is unavailable.');
    const metadata = JSON.parse(workflow.metadata_json);
    const planner = database.prepare(`SELECT status, input FROM workflow_steps
      WHERE workflow_id = ? AND agent_type = 'planner' AND review_round = 0 ORDER BY started_at ASC, id ASC`).get(workflowId);
    assert(planner, 'Persisted First Run Planner stage is unavailable.');
    const input = JSON.parse(planner.input);
    const checkpointTypes = database.prepare('SELECT type FROM checkpoints WHERE task_id = ? ORDER BY created_at ASC, id ASC')
      .all(taskId).map((row) => row.type);
    return { firstRunStatus: workflow.status, permissionMode: metadata.currentPermissionMode,
      plannerStageStatus: planner.status, gitContextKind: input.git?.kind ?? null, gitCheckpointTypes: checkpointTypes };
  } finally { database.close(); }
}

function sanitizedLoopbackRequestEvidence(server) {
  return (server?.requests ?? []).map((request) => ({
    kind: request.kind,
    stream: request.stream ?? null,
    topLevelKeys: request.topLevelKeys ?? [],
    toolNames: request.toolNames ?? [],
    toolChoiceType: request.toolChoiceType ?? null,
    toolChoiceName: request.toolChoiceName ?? null,
    outputSchemaKeys: request.outputSchemaKeys ?? [],
    responseFixtureBranch: request.responseFixtureBranch ?? null,
  }));
}

function closedFailureDatabaseEvidence(fixture, taskId) {
  if (!taskId || !fs.existsSync(databasePath(fixture))) return { workflowStatus: null, currentStage: null, steps: [], events: [], childTerminal: null };
  const database = new BetterSqlite3(databasePath(fixture), { readonly: true, fileMustExist: true });
  try {
    const workflow = database.prepare(`SELECT id, status, current_stage, metadata_json FROM workflows
      WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1`).get(taskId);
    let workflowMetadata = {};
    try { workflowMetadata = workflow ? JSON.parse(workflow.metadata_json) : {}; } catch { workflowMetadata = {}; }
    const steps = workflow ? database.prepare(`SELECT agent_type, status, error FROM workflow_steps
      WHERE workflow_id = ? ORDER BY started_at ASC, id ASC`).all(workflow.id).map((step) => ({
      stage: step.agent_type, status: step.status,
      errorType: step.error ? closedWorkflowFailureCode(step.error) : null,
    })) : [];
    const events = database.prepare(`SELECT event_type, payload_json FROM events WHERE session_id = ?
      ORDER BY created_at ASC, id ASC`).all(taskId).map((row) => {
      let payload = {};
      try { payload = JSON.parse(row.payload_json); } catch { payload = {}; }
      const error = typeof payload.error === 'string' ? payload.error
        : typeof payload.message === 'string' ? payload.message : '';
      const failureCode = closedWorkflowFailureCode(payload.failureCode ?? payload.failure?.code);
      return { eventType: row.event_type, status: typeof payload.status === 'string' ? payload.status : null,
        errorType: error ? closedErrorType(error) : failureCode === 'unknown' ? null : failureCode,
        exitCode: Number.isInteger(Number(error.match(/(?:code\s*=|exit(?:ed)?[^a-z]+code\s*)(-?\d+)/iu)?.[1]))
          ? Number(error.match(/(?:code\s*=|exit(?:ed)?[^a-z]+code\s*)(-?\d+)/iu)?.[1]) : null };
    });
    const terminal = events.findLast((event) => event.eventType === 'session_completed' || event.eventType === 'session_failed') ?? null;
    return { workflowStatus: workflow?.status ?? null, currentStage: workflow?.current_stage ?? null,
      failureCode: closedWorkflowFailureCode(workflowMetadata?.failure?.code),
      steps, events, childTerminal: terminal ? { kind: terminal.eventType, exitCode: terminal.exitCode, errorType: terminal.errorType } : null };
  } finally { database.close(); }
}

async function applySoftwarePresetUi(client, expectWizard, setPhase = () => {}) {
  setPhase('preset_initial_apply');
  await clickOwnedAccessibleButton(client, '[role="dialog"][aria-labelledby="settings-dialog-title"]',
    'Apply Software development template');
  if (expectWizard) {
    setPhase('preset_wizard_wait');
    await client.waitFor(`Array.from(document.querySelectorAll('[role="dialog"]')).some((dialog) =>
      Array.from(dialog.querySelectorAll('h1,h2,h3')).some((heading) => heading.closest('[role="dialog"]') === dialog
        && heading.textContent?.trim() === 'Configure model tiers'))`, { description: 'tier binding wizard' });
    setPhase('preset_wizard_bind_all');
    await clickExactDialogButton(client, 'Configure model tiers', 'Use this model for all tiers');
  }
  setPhase('preset_preview_wait');
  await client.waitFor(`Array.from(document.querySelectorAll('[role="dialog"]')).some((dialog) =>
    Array.from(dialog.querySelectorAll('h1,h2,h3')).some((heading) => heading.closest('[role="dialog"]') === dialog
      && heading.textContent?.trim() === 'Apply template preview'))`, { description: 'preset preview' });
  setPhase('preset_preview_roles');
  const previewRoles = await client.evaluate(`(() => {
    const text = Array.from(document.querySelectorAll('[role="dialog"]')).find((dialog) =>
      Array.from(dialog.querySelectorAll('h1,h2,h3')).some((heading) => heading.closest('[role="dialog"]') === dialog
        && heading.textContent?.trim() === 'Apply template preview'))?.innerText ?? '';
    return ['Planner', 'Coder', 'Tester', 'Reviewer', 'Fixer'].filter((role) => text.includes(role));
  })()`);
  assert(previewRoles.length === 5, 'Preset preview omitted one or more roles.');
  setPhase('preset_preview_apply');
  await clickExactDialogButton(client, 'Apply template preview', 'Apply');
  setPhase('preset_overwrite_wait');
  await client.waitFor(`Array.from(document.querySelectorAll('[role="dialog"]')).some((dialog) =>
    Array.from(dialog.querySelectorAll('h1,h2,h3')).some((heading) => heading.closest('[role="dialog"]') === dialog
      && heading.textContent?.trim() === 'Confirm Agent configuration overwrite'))`, { description: 'preset overwrite confirmation' });
  setPhase('preset_overwrite_confirm');
  await clickExactDialogButton(client, 'Confirm Agent configuration overwrite', 'Confirm overwrite and apply');
  setPhase('preset_success_wait');
  await client.waitFor(`Boolean(document.querySelector('[role="dialog"][aria-labelledby="settings-dialog-title"] .agent-preset-settings [role="status"]'))`, {
    description: 'preset future-calls-only status', timeoutMs: STEP_TIMEOUT_MS,
  });
  return { previewRoles, futureCallsOnly: true };
}

function providerLabel(selection, providers) {
  return providers.find((provider) => provider.id === selection.providerId)?.name ?? null;
}

async function roleSelections(client, taskId, providers) {
  const result = {};
  for (const role of ROLES) {
    const selection = await client.evaluate(`window.api.getEffectiveModelSelection({ taskId: ${js(taskId)}, agentType: ${js(role)} })`);
    result[role] = { provider: providerLabel(selection, providers), source: selection.source, tierSource: tierSourceFact(selection),
      validity: selection.validity, invalidReason: selection.invalidReason };
  }
  return result;
}

function assertRoleMap(selections, expected) {
  for (const role of ROLES) assert(selections[role]?.provider === expected[role], `${role} resolved to the wrong Provider.`);
}

function descendantProcesses(rootPid) {
  if (process.platform !== 'win32') return [];
  const script = `$all=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name;`
    + `$owned=New-Object System.Collections.Generic.List[object];$pending=@(${rootPid});`
    + `while($pending.Count -gt 0){$p=[int]$pending[0];if($pending.Count -eq 1){$pending=@()}else{$pending=$pending[1..($pending.Count-1)]};`
    + `$children=@($all|Where-Object ParentProcessId -eq $p);foreach($c in $children){$owned.Add($c);$pending+=@([int]$c.ProcessId)}};`
    + `$owned|ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
    encoding: 'utf8', windowsHide: true, shell: false,
  });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  const parsed = JSON.parse(result.stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function bindOwnedClaudeProcessArgumentEvidence(
  records,
  setPhase = () => undefined,
  cardinalityPhaseSet = false,
) {
  assert(typeof cardinalityPhaseSet === 'boolean', 'Owned Claude record phase state is invalid.');
  if (!cardinalityPhaseSet) noteChildArgvPhase(setPhase, 'child_argv_record_cardinality');
  assert(Array.isArray(records) && records.length === 1,
    'Owned Claude process argument evidence is ambiguous or missing.');
  const record = records[0];
  noteChildArgvPhase(setPhase, 'child_argv_record_schema');
  exactKeys(record, ['executablePath', 'commandLine'], 'Owned Claude process argument evidence');
  assert(typeof record.executablePath === 'string' && path.isAbsolute(record.executablePath)
    && typeof record.commandLine === 'string' && record.commandLine.length > 0
    && !record.commandLine.includes('\0'), 'Owned Claude process argument evidence is invalid.');
  return { observedExecutablePath: record.executablePath, commandLine: Buffer.from(record.commandLine, 'utf8') };
}

// Extracted without changing behavior so the real-child self-test exercises the
// exact generic-list serialization expression used by the production CIM query.
const POWERSHELL_GENERIC_LIST_JSON_ARRAY_EXPRESSION = '$records.ToArray()';

function descendantClaudeArgumentEvidence(rootPid, setPhase = () => undefined, controls = {}) {
  assert(Number.isInteger(rootPid) && rootPid > 0 && process.platform === 'win32',
    'Owned Claude process root identity is invalid.');
  exactKeys(controls, ['runQuery'].filter((key) => Object.hasOwn(controls, key)),
    'Owned Claude process query controls');
  const runQuery = controls.runQuery ?? spawnSync;
  assert(typeof runQuery === 'function', 'Owned Claude process query control is invalid.');
  const script = `$all=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine;`
    + `$records=New-Object System.Collections.Generic.List[object];$pending=@(${rootPid});`
    + `while($pending.Count -gt 0){$p=[int]$pending[0];if($pending.Count -eq 1){$pending=@()}else{$pending=$pending[1..($pending.Count-1)]};`
    + `$children=@($all|Where-Object ParentProcessId -eq $p);foreach($c in $children){`
    + `if($c.CommandLine -and $c.ExecutablePath -and $c.Name -match '^claude(?:-code)?\.exe$'){`
    + `$records.Add([pscustomobject]@{executablePath=[string]$c.ExecutablePath;commandLine=[string]$c.CommandLine})};`
    + `$pending+=@([int]$c.ProcessId)}};`
    + `[Console]::Out.Write((ConvertTo-Json -Compress -InputObject ${POWERSHELL_GENERIC_LIST_JSON_ARRAY_EXPRESSION}))`;
  noteChildArgvPhase(setPhase, 'child_argv_record_cardinality');
  const result = runQuery('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
    encoding: 'utf8', windowsHide: true, shell: false,
  });
  assert(result.status === 0 && result.stdout.trim(), 'Unable to inspect owned child arguments for privacy.');
  let records = null;
  try { records = JSON.parse(result.stdout); } catch { /* fixed failure below */ }
  return bindOwnedClaudeProcessArgumentEvidence(records, setPhase, true);
}

function authoritativeClaudeChildPaths(setPhase = () => undefined, resolveExecutable = resolveClaudeExecutable) {
  noteChildArgvPhase(setPhase, 'child_argv_authoritative_files');
  assert(typeof resolveExecutable === 'function', 'Authoritative Claude executable resolver is invalid.');
  const paths = {
    claudeExecutable: resolveExecutable(),
    electronExecutable: path.resolve(electron.default || electron),
    permissionMcpPath: path.join(WORKSPACE_ROOT, 'dist', 'main', 'permission-mcp.js'),
  };
  for (const target of Object.values(paths)) {
    assert(fs.existsSync(target) && fs.lstatSync(target).isFile() && !fs.lstatSync(target).isSymbolicLink(),
      'Authoritative owned child executable/helper path is unavailable.');
  }
  return paths;
}

function powerShellStdinInvocationFact(script) {
  assert(typeof script === 'string' && script.length > 0, 'PowerShell helper source is unavailable.');
  const decoder = '$cwStream=[Console]::OpenStandardInput();$cwMemory=[IO.MemoryStream]::new();'
    + '$cwStream.CopyTo($cwMemory);$cwScript=[Text.Encoding]::Unicode.GetString($cwMemory.ToArray());'
    + 'Invoke-Expression $cwScript';
  return { args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
    '-OutputFormat', 'Text', '-Command', decoder], stdin: Buffer.from(script, 'utf16le') };
}

function runPowerShellEncoded(script) {
  const invocation = powerShellStdinInvocationFact(script);
  const child = spawn('powershell.exe', invocation.args, {
    windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin?.on('error', () => { /* child close/error remains authoritative */ });
  child.stdin?.end(invocation.stdin);
  return child;
}

async function runPowerShellStdinTransportSelfTest() {
  const script = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Write-Output 'CW_BETA_STDIN_OK=保存'
`;
  const result = await awaitHelper(runPowerShellEncoded(script), 5_000);
  return result.output;
}

async function runBoundedNativeMessageSelfTest() {
  const script = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CwBetaBoundedMessageTest {
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern IntPtr CreateWindowEx(uint exStyle, string className, string windowName, uint style,
    int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, UIntPtr wParam, IntPtr lParam,
    uint flags, uint timeout, out UIntPtr result);
  public static bool[] Run() {
    const uint SMTO_BLOCK_ABORTIFHUNG = 0x0003;
    var parent = CreateWindowEx(0, "STATIC", "", 0, 0, 0, 0, 0, new IntPtr(-3), IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
    if (parent == IntPtr.Zero) throw new InvalidOperationException("owned parent window unavailable");
    var button = IntPtr.Zero;
    try {
      button = CreateWindowEx(0, "BUTTON", "Save", 0x50000000, 0, 0, 40, 20,
        parent, new IntPtr(1), IntPtr.Zero, IntPtr.Zero);
      if (button == IntPtr.Zero) throw new InvalidOperationException("owned button unavailable");
      UIntPtr result;
      var click = SendMessageTimeout(button, 0x00F5, UIntPtr.Zero, IntPtr.Zero,
        SMTO_BLOCK_ABORTIFHUNG, 1000, out result) != IntPtr.Zero;
      var fallback = SendMessageTimeout(parent, 0x0111, (UIntPtr)((ulong)1), button,
        SMTO_BLOCK_ABORTIFHUNG, 1000, out result) != IntPtr.Zero;
      return new [] { click, fallback };
    } finally {
      if (button != IntPtr.Zero) DestroyWindow(button);
      DestroyWindow(parent);
    }
  }
}
'@
$facts=@([CwBetaBoundedMessageTest]::Run())
[pscustomobject]@{bmClick=[bool]$facts[0];wmCommand=[bool]$facts[1]}|ConvertTo-Json -Compress
`;
  const result = await awaitHelper(runPowerShellEncoded(script), 5_000);
  const parsed = JSON.parse(result.output);
  exactKeys(parsed, ['bmClick', 'wmCommand'], 'Bounded native-message self-test');
  assert(parsed.bmClick === true && parsed.wmCommand === true, 'Bounded native-message child failed.');
  return parsed;
}

function closedNativeHelperFailureCategory(value) {
  const text = String(value || '');
  if (/verified diagnostics dialog missing/iu.test(text)) return 'dialog_missing';
  if (/same-HWND UIA Root dialog/iu.test(text)) return 'dialog_projection_ambiguous';
  if (/filename edit ambiguity/iu.test(text)) return 'filename_edit_ambiguous';
  if (/filename edit id mismatch/iu.test(text)) return 'filename_edit_identity';
  if (/verified save ambiguity/iu.test(text)) return 'save_control_ambiguous';
  if (/noncanonical or stale diagnostics basename/iu.test(text)) return 'stale_basename';
  if (/unsafe diagnostics basename/iu.test(text)) return 'unsafe_basename';
  if (/known Documents folder unavailable/iu.test(text)) return 'known_folder_unavailable';
  if (/diagnostics target already exists/iu.test(text)) return 'target_exists';
  if (/verified BM_CLICK failed/iu.test(text)) return 'save_click_failed';
  if (/verified WM_COMMAND failed/iu.test(text)) return 'save_fallback_failed';
  if (/dialog identity changed before WM_COMMAND fallback/iu.test(text)) return 'dialog_identity_changed';
  if (/verified diagnostics dialog did not close/iu.test(text)) return 'dialog_close_failed';
  return 'unknown';
}

function closedNativeExportSettlementFact(settled) {
  const allowedHelper = new Set(['timeout', 'spawn_error', 'dialog_missing', 'dialog_projection_ambiguous', 'filename_edit_ambiguous',
    'filename_edit_identity', 'save_control_ambiguous', 'unsafe_basename', 'stale_basename',
    'known_folder_unavailable', 'target_exists', 'save_click_failed', 'save_fallback_failed', 'dialog_identity_changed',
    'dialog_close_failed', 'unknown']);
  const helperValue = settled?.[0]?.status === 'rejected'
    ? settled[0].reason?.nativeFailureCategory : 'completed';
  const helper = helperValue === 'completed' || allowedHelper.has(helperValue) ? helperValue : 'unknown';
  const api = settled?.[1]?.status === 'rejected' ? 'rejected'
    : settled?.[1]?.value === true ? 'true'
      : settled?.[1]?.value === null ? 'null' : 'unexpected';
  return { helper, api };
}

function closedNativeFailureCleanupFact(value) {
  exactKeys(value, ['dialog', 'candidate'], 'Native failure cleanup');
  for (const key of ['dialog', 'candidate']) {
    assert(value[key] === 'completed' || value[key] === 'failed',
      'Native failure cleanup outcome is invalid.');
  }
  return { dialog: value.dialog, candidate: value.candidate };
}

async function settleIndependentNativeFailureCleanup(dialogCleanup, candidateCleanup) {
  assert(typeof dialogCleanup === 'function' && typeof candidateCleanup === 'function',
    'Native failure cleanup operations are invalid.');
  const settled = await Promise.allSettled([
    Promise.resolve().then(dialogCleanup),
    Promise.resolve().then(candidateCleanup),
  ]);
  const fact = closedNativeFailureCleanupFact({
    dialog: settled[0].status === 'fulfilled' ? 'completed' : 'failed',
    candidate: settled[1].status === 'fulfilled' ? 'completed' : 'failed',
  });
  if (settled.some((item) => item.status === 'rejected')) {
    const error = new Error('Native failure cleanup did not complete every independent exact target.');
    error.nativeFailureCleanup = fact;
    throw error;
  }
  return fact;
}

function closedNativeWindowDiscoveryFromOutput(output) {
  const prefix = 'CW_BETA_NATIVE_DISCOVERY=';
  const lines = String(output || '').split(/\r?\n/u).filter((line) => line.startsWith(prefix));
  if (lines.length === 0) return null;
  assert(lines.length === 1, 'Native discovery diagnostic output is ambiguous.');
  return closedNativeWindowDiscoveryFact(JSON.parse(lines[0].slice(prefix.length)));
}

function closedNativeControlDiscoveryFromOutput(output) {
  const prefix = 'CW_BETA_NATIVE_CONTROLS=';
  const lines = String(output || '').split(/\r?\n/u).filter((line) => line.startsWith(prefix));
  if (lines.length === 0) return null;
  assert(lines.length === 1, 'Native control diagnostic output is ambiguous.');
  return closedNativeControlDiscoveryFact(JSON.parse(lines[0].slice(prefix.length)));
}

function closedNativeControlIdDiscoveryFromOutput(output) {
  const prefix = 'CW_BETA_NATIVE_CONTROL_IDS=';
  const lines = String(output || '').split(/\r?\n/u).filter((line) => line.startsWith(prefix));
  if (lines.length === 0) return null;
  assert(lines.length === 1, 'Native control-ID diagnostic output is ambiguous.');
  return closedNativeControlIdDiscoveryFact(JSON.parse(lines[0].slice(prefix.length)));
}

function closedNativeJointControlDiscoveryFromOutput(output) {
  const prefix = 'CW_BETA_NATIVE_JOINT_CONTROLS=';
  const lines = String(output || '').split(/\r?\n/u).filter((line) => line.startsWith(prefix));
  if (lines.length === 0) return null;
  assert(lines.length === 1, 'Native/UIA joint diagnostic output is ambiguous.');
  return closedNativeJointControlDiscoveryFact(JSON.parse(lines[0].slice(prefix.length)));
}

function closedNativeWin32JointDiscoveryFromOutput(output) {
  const prefix = 'CW_BETA_NATIVE_WIN32_JOINT=';
  const lines = String(output || '').split(/\r?\n/u).filter((line) => line.startsWith(prefix));
  if (lines.length === 0) return null;
  assert(lines.length === 1, 'Pure Win32 joint diagnostic output is ambiguous.');
  return closedNativeWin32JointDiscoveryFact(JSON.parse(lines[0].slice(prefix.length)));
}

function closedNativeBoundedTextDiscoveryFromOutput(output) {
  const prefix = 'CW_BETA_NATIVE_BOUNDED_TEXT=';
  const lines = String(output || '').split(/\r?\n/u).filter((line) => line.startsWith(prefix));
  if (lines.length === 0) return null;
  assert(lines.length === 1, 'Bounded native-text diagnostic output is ambiguous.');
  return closedNativeBoundedTextDiscoveryFact(JSON.parse(lines[0].slice(prefix.length)));
}

function nativeCandidateFromOutput(output) {
  const prefix = 'CW_BETA_NATIVE_CANDIDATE=';
  const lines = String(output || '').split(/\r?\n/u).filter((line) => line.startsWith(prefix));
  if (lines.length === 0) return null;
  assert(lines.length === 1, 'Native candidate helper output is ambiguous.');
  return JSON.parse(lines[0].slice(prefix.length));
}

function nativeResultFromOutput(output) {
  const prefix = 'CW_BETA_NATIVE_RESULT=';
  const lines = String(output || '').split(/\r?\n/u).filter((line) => line.startsWith(prefix));
  assert(lines.length === 1, 'Native result helper output is ambiguous or missing.');
  return JSON.parse(lines[0].slice(prefix.length));
}

async function awaitHelper(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const stdout = []; const stderr = []; let settled = false;
    child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(() => {
      if (settled) return; settled = true; try { child.kill(); } catch { /* stopped */ }
      const failure = new Error('Verified native diagnostics helper failed (timeout).');
      failure.nativeFailureCategory = 'timeout';
      try { failure.nativeCandidate = nativeCandidateFromOutput(Buffer.concat(stdout).toString('utf8')); } catch { failure.nativeCandidate = null; }
      reject(failure);
    }, timeoutMs);
    child.once('error', () => {
      if (!settled) {
        settled = true; clearTimeout(timer);
        const failure = new Error('Verified native diagnostics helper failed (spawn_error).');
        failure.nativeFailureCategory = 'spawn_error';
        try { failure.nativeCandidate = nativeCandidateFromOutput(Buffer.concat(stdout).toString('utf8')); } catch { failure.nativeCandidate = null; }
        reject(failure);
      }
    });
    child.once('close', (code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      const output = Buffer.concat(stdout).toString('utf8').trim();
      const error = Buffer.concat(stderr).toString('utf8').trim();
      if (code === 0) resolve({ output, error });
      else {
        const category = closedNativeHelperFailureCategory(error);
        const failure = new Error(`Verified native diagnostics helper failed (${category}).`);
        failure.nativeFailureCategory = category;
        try { failure.nativeWindowDiscovery = closedNativeWindowDiscoveryFromOutput(output); } catch { failure.nativeWindowDiscovery = null; }
        try { failure.nativeControlDiscovery = closedNativeControlDiscoveryFromOutput(output); } catch { failure.nativeControlDiscovery = null; }
        try { failure.nativeControlIdDiscovery = closedNativeControlIdDiscoveryFromOutput(output); } catch { failure.nativeControlIdDiscovery = null; }
        try { failure.nativeJointControlDiscovery = closedNativeJointControlDiscoveryFromOutput(output); } catch { failure.nativeJointControlDiscovery = null; }
        try { failure.nativeWin32JointDiscovery = closedNativeWin32JointDiscoveryFromOutput(output); } catch { failure.nativeWin32JointDiscovery = null; }
        try { failure.nativeBoundedTextDiscovery = closedNativeBoundedTextDiscoveryFromOutput(output); } catch { failure.nativeBoundedTextDiscovery = null; }
        try { failure.nativeCandidate = nativeCandidateFromOutput(output); } catch { failure.nativeCandidate = null; }
        reject(failure);
      }
    });
  });
}

async function runIndependentDialogCleanup(expectedPid) {
  assert(Number.isInteger(expectedPid) && expectedPid > 0, 'Independent dialog cleanup PID is invalid.');
  const script = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class CwBetaExactDialogCleanup {
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder value, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder value, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp);
  public static IntPtr[] FindExactWindows(int expectedPid, string expectedClass, string expectedTitle) {
    var matches = new List<IntPtr>();
    EnumWindows((hwnd, _) => {
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      if (pid != (uint)expectedPid || !IsWindowVisible(hwnd)) return true;
      var className = new StringBuilder(256);
      var title = new StringBuilder(512);
      GetClassName(hwnd, className, className.Capacity);
      GetWindowText(hwnd, title, title.Capacity);
      if (className.ToString() == expectedClass && title.ToString() == expectedTitle) matches.Add(hwnd);
      return true;
    }, IntPtr.Zero);
    return matches.ToArray();
  }
}
'@
$expectedPid=${expectedPid}
function Find-Exact {
  $exact=New-Object System.Collections.Generic.List[object]
  $handles=@([CwBetaExactDialogCleanup]::FindExactWindows($expectedPid,'#32770','Export Claude Workbench diagnostics'))
  foreach($handleValue in $handles){
    $handle=[IntPtr]$handleValue
    if($handle -eq [IntPtr]::Zero){continue}
    try{$element=[Windows.Automation.AutomationElement]::FromHandle($handle)}catch{continue}
    if($null -ne $element -and [CwBetaExactDialogCleanup]::IsWindowVisible($handle) -and
      $element.Current.NativeWindowHandle -eq $handle.ToInt32() -and $element.Current.ProcessId -eq $expectedPid -and
      $element.Current.ClassName -eq '#32770' -and $element.Current.Name -eq 'Export Claude Workbench diagnostics'){
      $exact.Add([pscustomobject]@{handle=$handle;element=$element})|Out-Null
    }
  }
  @($exact.ToArray())
}
$matches=@(Find-Exact)
if($matches.Count -gt 1){throw 'ambiguous exact cleanup dialog'}
if($matches.Count -eq 0){[pscustomobject]@{matched=0;closed=$true}|ConvertTo-Json -Compress;exit 0}
$handle=[IntPtr]$matches[0].handle
[CwBetaExactDialogCleanup]::PostMessage($handle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null
for($attempt=0;$attempt -lt 100;$attempt++){
  Start-Sleep -Milliseconds 50
  $allExact=@(Find-Exact)
  if($allExact.Count -gt 1){throw 'ambiguous exact cleanup dialog after close'}
  $remaining=@($allExact|Where-Object {$_.handle.ToInt64() -eq $handle.ToInt64()})
  if($remaining.Count -eq 0){[pscustomobject]@{matched=1;closed=$true}|ConvertTo-Json -Compress;exit 0}
}
throw 'exact cleanup dialog did not close'
`;
  const result = await awaitHelper(runPowerShellEncoded(script), 10_000);
  return JSON.parse(result.output);
}

function nativeDialogScript(expectedPid, requestedAt) {
  assert(Number.isInteger(expectedPid) && expectedPid > 0, 'Electron PID unavailable for native diagnostics.');
  assert(Number.isFinite(requestedAt), 'Diagnostics request time unavailable for native pre-click validation.');
  return String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
public static class CwBetaNative {
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder value, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder value, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, UIntPtr wParam, IntPtr lParam,
    uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, UIntPtr wParam, StringBuilder lParam,
    uint flags, uint timeout, out UIntPtr result);
  [DllImport("shell32.dll")] public static extern int SHGetKnownFolderPath([MarshalAs(UnmanagedType.LPStruct)] Guid rfid, uint flags, IntPtr token, out IntPtr path);
  [DllImport("ole32.dll")] public static extern void CoTaskMemFree(IntPtr ptr);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp);
  public static IntPtr[] FindExactWindows(int expectedPid, string expectedClass, string expectedTitle) {
    var matches = new List<IntPtr>();
    EnumWindows((hwnd, _) => {
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      if (pid != (uint)expectedPid || !IsWindowVisible(hwnd)) return true;
      var className = new StringBuilder(256);
      var title = new StringBuilder(512);
      GetClassName(hwnd, className, className.Capacity);
      GetWindowText(hwnd, title, title.Capacity);
      if (className.ToString() == expectedClass && title.ToString() == expectedTitle) matches.Add(hwnd);
      return true;
    }, IntPtr.Zero);
    return matches.ToArray();
  }
  private static void AddExpectedWindowCount(IntPtr hwnd, int expectedPid, string expectedClass, string expectedTitle, int[] counts, int offset) {
    uint pid;
    GetWindowThreadProcessId(hwnd, out pid);
    if (pid != (uint)expectedPid || !IsWindowVisible(hwnd)) return;
    counts[offset]++;
    var className = new StringBuilder(256);
    var title = new StringBuilder(512);
    GetClassName(hwnd, className, className.Capacity);
    GetWindowText(hwnd, title, title.Capacity);
    var classExact = className.ToString() == expectedClass;
    var titleExact = title.ToString() == expectedTitle;
    if (classExact) counts[offset + 1]++;
    if (titleExact) counts[offset + 2]++;
    if (classExact && titleExact) counts[offset + 3]++;
  }
  public static int[] CountExpectedWindows(int expectedPid, string expectedClass, string expectedTitle) {
    var counts = new int[8];
    var roots = new List<IntPtr>();
    EnumWindows((hwnd, _) => {
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      if (pid == (uint)expectedPid) {
        roots.Add(hwnd);
        AddExpectedWindowCount(hwnd, expectedPid, expectedClass, expectedTitle, counts, 0);
      }
      return true;
    }, IntPtr.Zero);
    var children = new HashSet<IntPtr>();
    foreach (var root in roots) EnumChildWindows(root, (hwnd, _) => { children.Add(hwnd); return true; }, IntPtr.Zero);
    foreach (var child in children) AddExpectedWindowCount(child, expectedPid, expectedClass, expectedTitle, counts, 4);
    return counts;
  }
  public static int[] CountNativeControlIds(IntPtr dialog, int expectedPid) {
    var counts = new int[8];
    EnumChildWindows(dialog, (hwnd, _) => {
      var id = GetDlgCtrlID(hwnd);
      var offset = id == 1001 ? 0 : id == 1 ? 4 : -1;
      if (offset < 0) return true;
      counts[offset]++;
      if (!IsWindowVisible(hwnd)) return true;
      counts[offset + 1]++;
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      if (pid != (uint)expectedPid) return true;
      counts[offset + 2]++;
      if (IsChild(dialog, hwnd)) counts[offset + 3]++;
      return true;
    }, IntPtr.Zero);
    return counts;
  }
  public static bool RevalidateNativeControl(IntPtr dialog, IntPtr hwnd, int expectedPid, int expectedId) {
    if (hwnd == IntPtr.Zero || !IsWindowVisible(hwnd) || !IsChild(dialog, hwnd) || GetDlgCtrlID(hwnd) != expectedId) return false;
    uint pid;
    GetWindowThreadProcessId(hwnd, out pid);
    return pid == (uint)expectedPid;
  }
  public static IntPtr[] FindNativeControlId(IntPtr dialog, int expectedPid, int expectedId) {
    var matches = new List<IntPtr>();
    EnumChildWindows(dialog, (hwnd, _) => {
      if (RevalidateNativeControl(dialog, hwnd, expectedPid, expectedId)) matches.Add(hwnd);
      return true;
    }, IntPtr.Zero);
    return matches.ToArray();
  }
  private static string NativeClass(IntPtr hwnd) {
    var value = new StringBuilder(256);
    GetClassName(hwnd, value, value.Capacity);
    return value.ToString();
  }
  private static string NativeText(IntPtr hwnd) {
    var value = new StringBuilder(Math.Max(512, GetWindowTextLength(hwnd) + 1));
    GetWindowText(hwnd, value, value.Capacity);
    return value.ToString();
  }
  private static bool CanonicalFreshDiagnosticsText(IntPtr hwnd, long requestedAt) {
    var value = NativeText(hwnd);
    if (value.IndexOfAny(new [] {'\\', '/', ':'}) >= 0) return false;
    var match = Regex.Match(value, @"^ClaudeWorkbench-diagnostics-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.zip$", RegexOptions.CultureInvariant);
    if (!match.Success) return false;
    var iso = String.Format(CultureInfo.InvariantCulture, "{0}-{1}-{2}T{3}:{4}:{5}.{6}Z",
      match.Groups[1].Value, match.Groups[2].Value, match.Groups[3].Value, match.Groups[4].Value,
      match.Groups[5].Value, match.Groups[6].Value, match.Groups[7].Value);
    DateTimeOffset stamp;
    if (!DateTimeOffset.TryParseExact(iso, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture,
      DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out stamp)) return false;
    var roundTrip = "ClaudeWorkbench-diagnostics-" + stamp.UtcDateTime.ToString("yyyy-MM-dd'T'HH-mm-ss-fff'Z'", CultureInfo.InvariantCulture) + ".zip";
    var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    return roundTrip == value && stamp.ToUnixTimeMilliseconds() >= requestedAt - 2000 && stamp.ToUnixTimeMilliseconds() <= now + 2000;
  }
  public static int[] AnalyzeNativeControlPredicates(IntPtr dialog, int expectedPid, long requestedAt) {
    var counts = new int[15];
    var finalFilenames = new HashSet<IntPtr>();
    var direct = FindNativeControlId(dialog, expectedPid, 1001);
    counts[0] = direct.Length;
    foreach (var hwnd in direct) {
      if (!IsWindowVisible(hwnd) || !IsWindowEnabled(hwnd)) continue;
      counts[1]++;
      if (NativeClass(hwnd) != "Edit") continue;
      counts[2]++;
      if (!CanonicalFreshDiagnosticsText(hwnd, requestedAt)) continue;
      counts[3]++;
      finalFilenames.Add(hwnd);
    }
    counts[4] = direct.Length;
    var descendants = new HashSet<IntPtr>();
    foreach (var container in direct) EnumChildWindows(container, (hwnd, _) => { descendants.Add(hwnd); return true; }, IntPtr.Zero);
    counts[5] = descendants.Count;
    foreach (var hwnd in descendants) {
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      if (pid != (uint)expectedPid || !IsChild(dialog, hwnd)) continue;
      counts[6]++;
      if (NativeClass(hwnd) != "Edit") continue;
      counts[7]++;
      if (!IsWindowVisible(hwnd) || !IsWindowEnabled(hwnd)) continue;
      counts[8]++;
      if (!CanonicalFreshDiagnosticsText(hwnd, requestedAt)) continue;
      counts[9]++;
      finalFilenames.Add(hwnd);
    }
    counts[10] = finalFilenames.Count;
    var save = FindNativeControlId(dialog, expectedPid, 1);
    counts[11] = save.Length;
    foreach (var hwnd in save) {
      if (!IsWindowVisible(hwnd) || !IsWindowEnabled(hwnd)) continue;
      counts[12]++;
      if (NativeClass(hwnd) != "Button") continue;
      counts[13]++;
      if (Regex.IsMatch(NativeText(hwnd), @"^(Save|保存)(\([^)]*\))?$", RegexOptions.CultureInvariant)) counts[14]++;
    }
    return counts;
  }
  private static bool RevalidateNativeFilenameEdit(IntPtr dialog, IntPtr hwnd, int expectedPid) {
    return RevalidateNativeControl(dialog, hwnd, expectedPid, 1001) && IsWindowEnabled(hwnd) && NativeClass(hwnd) == "Edit";
  }
  private static bool TryCanonicalDiagnosticsValue(string value, out DateTimeOffset stamp) {
    stamp = DateTimeOffset.MinValue;
    if (String.IsNullOrEmpty(value) || value.IndexOfAny(new [] {'\\', '/', ':'}) >= 0) return false;
    var match = Regex.Match(value, @"^ClaudeWorkbench-diagnostics-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.zip$", RegexOptions.CultureInvariant);
    if (!match.Success) return false;
    var iso = String.Format(CultureInfo.InvariantCulture, "{0}-{1}-{2}T{3}:{4}:{5}.{6}Z",
      match.Groups[1].Value, match.Groups[2].Value, match.Groups[3].Value, match.Groups[4].Value,
      match.Groups[5].Value, match.Groups[6].Value, match.Groups[7].Value);
    if (!DateTimeOffset.TryParseExact(iso, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture,
      DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out stamp)) return false;
    var roundTrip = "ClaudeWorkbench-diagnostics-" + stamp.UtcDateTime.ToString("yyyy-MM-dd'T'HH-mm-ss-fff'Z'", CultureInfo.InvariantCulture) + ".zip";
    return roundTrip == value;
  }
  public static int[] AnalyzeBoundedNativeEditText(IntPtr dialog, int expectedPid, long requestedAt) {
    const uint WM_GETTEXT = 0x000D;
    const uint WM_GETTEXTLENGTH = 0x000E;
    const uint SMTO_BLOCK_ABORTIFHUNG = 0x0003;
    var counts = new int[9];
    var candidates = new List<IntPtr>();
    foreach (var hwnd in FindNativeControlId(dialog, expectedPid, 1001)) {
      if (RevalidateNativeFilenameEdit(dialog, hwnd, expectedPid)) candidates.Add(hwnd);
    }
    counts[0] = candidates.Count;
    if (candidates.Count != 1) return counts;
    var target = candidates[0];
    if (!RevalidateNativeFilenameEdit(dialog, target, expectedPid)) return counts;
    counts[1]++;
    UIntPtr lengthResult;
    if (SendMessageTimeout(target, WM_GETTEXTLENGTH, UIntPtr.Zero, IntPtr.Zero,
      SMTO_BLOCK_ABORTIFHUNG, 1000, out lengthResult) == IntPtr.Zero) return counts;
    counts[2]++;
    var length = lengthResult.ToUInt64();
    if (length == 0 || length > 512) return counts;
    counts[3]++;
    var value = new StringBuilder((int)length + 1);
    UIntPtr textResult;
    if (SendMessageTimeout(target, WM_GETTEXT, (UIntPtr)((ulong)value.Capacity), value,
      SMTO_BLOCK_ABORTIFHUNG, 1000, out textResult) == IntPtr.Zero || textResult.ToUInt64() == 0) return counts;
    counts[4]++;
    if (!RevalidateNativeFilenameEdit(dialog, target, expectedPid)) return counts;
    counts[5]++;
    DateTimeOffset stamp;
    var text = value.ToString();
    if (!TryCanonicalDiagnosticsValue(text, out stamp)) return counts;
    counts[6]++;
    var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    if (stamp.ToUnixTimeMilliseconds() < requestedAt - 2000 || stamp.ToUnixTimeMilliseconds() > now + 2000) return counts;
    counts[7]++;
    IntPtr folder = IntPtr.Zero;
    try {
      if (SHGetKnownFolderPath(new Guid("FDD39AD0-238F-46AF-ADB4-6C85480369C7"), 0, IntPtr.Zero, out folder) != 0 || folder == IntPtr.Zero) return counts;
      var documents = Marshal.PtrToStringUni(folder);
      if (String.IsNullOrEmpty(documents)) return counts;
      var destination = Path.Combine(documents, text);
      if (!File.Exists(destination) && !Directory.Exists(destination)) counts[8]++;
    } finally {
      if (folder != IntPtr.Zero) CoTaskMemFree(folder);
    }
    return counts;
  }
  private static bool RevalidateExactDialog(IntPtr dialog, int expectedPid) {
    if (dialog == IntPtr.Zero || !IsWindowVisible(dialog)) return false;
    uint pid;
    GetWindowThreadProcessId(dialog, out pid);
    if (pid != (uint)expectedPid || NativeClass(dialog) != "#32770"
      || NativeText(dialog) != "Export Claude Workbench diagnostics") return false;
    var exact = FindExactWindows(expectedPid, "#32770", "Export Claude Workbench diagnostics");
    return exact.Length == 1 && exact[0] == dialog;
  }
  private static bool RevalidateNativeSave(IntPtr dialog, IntPtr hwnd, int expectedPid) {
    return RevalidateNativeControl(dialog, hwnd, expectedPid, 1) && IsWindowEnabled(hwnd)
      && NativeClass(hwnd) == "Button"
      && Regex.IsMatch(NativeText(hwnd), @"^(Save|\u4FDD\u5B58)(\([^)]*\))?$", RegexOptions.CultureInvariant);
  }
  private static string ReadBoundedFilename(IntPtr dialog, IntPtr edit, int expectedPid, long requestedAt,
    out string documents, out string target) {
    const uint WM_GETTEXT = 0x000D;
    const uint WM_GETTEXTLENGTH = 0x000E;
    const uint SMTO_BLOCK_ABORTIFHUNG = 0x0003;
    documents = null;
    target = null;
    if (!RevalidateExactDialog(dialog, expectedPid) || !RevalidateNativeFilenameEdit(dialog, edit, expectedPid))
      throw new InvalidOperationException("filename edit id mismatch");
    UIntPtr lengthResult;
    if (SendMessageTimeout(edit, WM_GETTEXTLENGTH, UIntPtr.Zero, IntPtr.Zero,
      SMTO_BLOCK_ABORTIFHUNG, 1000, out lengthResult) == IntPtr.Zero)
      throw new InvalidOperationException("filename edit id mismatch");
    var length = lengthResult.ToUInt64();
    if (length == 0 || length > 512) throw new InvalidOperationException("unsafe diagnostics basename");
    var value = new StringBuilder((int)length + 1);
    UIntPtr textResult;
    if (SendMessageTimeout(edit, WM_GETTEXT, (UIntPtr)((ulong)value.Capacity), value,
      SMTO_BLOCK_ABORTIFHUNG, 1000, out textResult) == IntPtr.Zero || textResult.ToUInt64() == 0)
      throw new InvalidOperationException("filename edit id mismatch");
    if (!RevalidateExactDialog(dialog, expectedPid) || !RevalidateNativeFilenameEdit(dialog, edit, expectedPid))
      throw new InvalidOperationException("filename edit id mismatch");
    var filename = value.ToString();
    DateTimeOffset stamp;
    if (!TryCanonicalDiagnosticsValue(filename, out stamp) || Path.GetFileName(filename) != filename)
      throw new InvalidOperationException("unsafe diagnostics basename");
    var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    if (stamp.ToUnixTimeMilliseconds() < requestedAt - 2000 || stamp.ToUnixTimeMilliseconds() > now + 2000)
      throw new InvalidOperationException("noncanonical or stale diagnostics basename");
    IntPtr folder = IntPtr.Zero;
    try {
      if (SHGetKnownFolderPath(new Guid("FDD39AD0-238F-46AF-ADB4-6C85480369C7"), 0, IntPtr.Zero, out folder) != 0
        || folder == IntPtr.Zero) throw new InvalidOperationException("known Documents folder unavailable");
      documents = Marshal.PtrToStringUni(folder);
      if (String.IsNullOrEmpty(documents)) throw new InvalidOperationException("known Documents folder unavailable");
    } finally {
      if (folder != IntPtr.Zero) CoTaskMemFree(folder);
    }
    target = Path.Combine(documents, filename);
    if (File.Exists(target) || Directory.Exists(target))
      throw new InvalidOperationException("diagnostics target already exists");
    return filename;
  }
  private static bool WaitForExactDialogClose(IntPtr dialog, int expectedPid) {
    for (var attempt = 0; attempt < 200; attempt++) {
      var exact = FindExactWindows(expectedPid, "#32770", "Export Claude Workbench diagnostics");
      if (exact.Length == 0) return true;
      if (exact.Length != 1 || exact[0] != dialog)
        throw new InvalidOperationException("dialog identity changed before WM_COMMAND fallback");
      Thread.Sleep(50);
    }
    return false;
  }
  private static void RevalidateBoundOperation(IntPtr dialog, IntPtr edit, IntPtr save, int expectedPid,
    long requestedAt, string expectedFilename, string expectedDocuments, string expectedTarget) {
    if (!RevalidateExactDialog(dialog, expectedPid) || !RevalidateNativeFilenameEdit(dialog, edit, expectedPid)
      || !RevalidateNativeSave(dialog, save, expectedPid))
      throw new InvalidOperationException("dialog identity changed before WM_COMMAND fallback");
    string documents;
    string target;
    var filename = ReadBoundedFilename(dialog, edit, expectedPid, requestedAt, out documents, out target);
    if (filename != expectedFilename || documents != expectedDocuments || target != expectedTarget)
      throw new InvalidOperationException("dialog identity changed before WM_COMMAND fallback");
  }
  public static string[] BindNativeSaveOperation(IntPtr dialog, int expectedPid, long requestedAt) {
    if (!RevalidateExactDialog(dialog, expectedPid))
      throw new InvalidOperationException("dialog identity changed before WM_COMMAND fallback");
    var edits = new List<IntPtr>();
    foreach (var hwnd in FindNativeControlId(dialog, expectedPid, 1001))
      if (RevalidateNativeFilenameEdit(dialog, hwnd, expectedPid)) edits.Add(hwnd);
    if (edits.Count != 1) throw new InvalidOperationException("filename edit ambiguity");
    var rawSave = FindNativeControlId(dialog, expectedPid, 1);
    if (rawSave.Length != 1 || !RevalidateNativeSave(dialog, rawSave[0], expectedPid))
      throw new InvalidOperationException("verified save ambiguity");
    var edit = edits[0];
    var save = rawSave[0];
    var saveText = NativeText(save);
    string documents;
    string target;
    var filename = ReadBoundedFilename(dialog, edit, expectedPid, requestedAt, out documents, out target);
    RevalidateBoundOperation(dialog, edit, save, expectedPid, requestedAt, filename, documents, target);
    return new [] {
      filename, documents, target,
      edit.ToInt64().ToString(CultureInfo.InvariantCulture),
      save.ToInt64().ToString(CultureInfo.InvariantCulture),
      saveText
    };
  }
  public static string ExecuteBoundNativeSaveOperation(IntPtr dialog, IntPtr edit, IntPtr save, int expectedPid,
    long requestedAt, string filename, string documents, string target, string saveText) {
    const uint BM_CLICK = 0x00F5;
    const uint WM_COMMAND = 0x0111;
    const uint SMTO_BLOCK_ABORTIFHUNG = 0x0003;
    RevalidateBoundOperation(dialog, edit, save, expectedPid, requestedAt, filename, documents, target);
    if (NativeText(save) != saveText)
      throw new InvalidOperationException("dialog identity changed before WM_COMMAND fallback");
    UIntPtr result;
    if (SendMessageTimeout(save, BM_CLICK, UIntPtr.Zero, IntPtr.Zero,
      SMTO_BLOCK_ABORTIFHUNG, 1000, out result) == IntPtr.Zero)
      throw new InvalidOperationException("verified BM_CLICK failed");
    var fallback = false;
    if (!WaitForExactDialogClose(dialog, expectedPid)) {
      RevalidateBoundOperation(dialog, edit, save, expectedPid, requestedAt, filename, documents, target);
      if (NativeText(save) != saveText)
        throw new InvalidOperationException("dialog identity changed before WM_COMMAND fallback");
      if (SendMessageTimeout(dialog, WM_COMMAND, (UIntPtr)((ulong)1), save,
        SMTO_BLOCK_ABORTIFHUNG, 1000, out result) == IntPtr.Zero)
        throw new InvalidOperationException("verified WM_COMMAND failed");
      fallback = true;
      if (!WaitForExactDialogClose(dialog, expectedPid))
        throw new InvalidOperationException("verified diagnostics dialog did not close");
    }
    return fallback ? "same_dialog_wm_command" : "not_needed";
  }
}
'@
$pidExpected=${expectedPid}
$requestedAt=[Int64]${requestedAt}
function Find-Exact {
  $exact=New-Object System.Collections.Generic.List[object]
  $handles=@([CwBetaNative]::FindExactWindows($pidExpected,'#32770','Export Claude Workbench diagnostics'))
  foreach($handleValue in $handles){
    $handle=[IntPtr]$handleValue
    if($handle -eq [IntPtr]::Zero){continue}
    try{$element=[Windows.Automation.AutomationElement]::FromHandle($handle)}catch{continue}
    if($null -ne $element -and [CwBetaNative]::IsWindowVisible($handle) -and
      $element.Current.NativeWindowHandle -eq $handle.ToInt32() -and $element.Current.ProcessId -eq $pidExpected -and
      $element.Current.ClassName -eq '#32770' -and $element.Current.Name -eq 'Export Claude Workbench diagnostics'){
      $exact.Add([pscustomobject]@{handle=$handle;element=$element})|Out-Null
    }
  }
  @($exact.ToArray())
}
function Get-ExactDialog {
  param([Int64]$Handle)
  if($Handle -le 0){return $null}
  $allExact=@(Find-Exact)
  if($allExact.Count -gt 1){throw 'ambiguous exact diagnostics dialog identity'}
  $matches=@($allExact|Where-Object {$_.handle.ToInt64() -eq $Handle})
  if($matches.Count -gt 1){throw 'ambiguous exact diagnostics dialog identity'}
  if($matches.Count -eq 1){return $matches[0].element}
  return $null
}
function Get-ExactRootProviderDialog {
  param([Int64]$Handle)
  $fromHandle=Get-ExactDialog $Handle
  if($null -eq $fromHandle){return $null}
  $root=[Windows.Automation.AutomationElement]::RootElement
  $matches=@($root.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)|Where-Object {
    $_.Current.NativeWindowHandle -eq $Handle -and $_.Current.ProcessId -eq $pidExpected -and
    $_.Current.ClassName -eq '#32770' -and $_.Current.Name -eq 'Export Claude Workbench diagnostics'
  })
  if($matches.Count -ne 1){throw 'same-HWND UIA Root dialog ambiguous or missing'}
  $handles=@([CwBetaNative]::FindExactWindows($pidExpected,'#32770','Export Claude Workbench diagnostics'))
  if($handles.Count -ne 1 -or ([IntPtr]$handles[0]).ToInt64() -ne $Handle){
    throw 'same-HWND UIA Root dialog failed Win32 revalidation'
  }
  return $matches[0]
}
function Close-ExactDialog {
  param([Int64]$Handle)
  $exact=Get-ExactDialog $Handle
  if($null -ne $exact){[CwBetaNative]::PostMessage([IntPtr]$Handle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null}
}
$completed=$false
$dialogHwnd=[IntPtr]::Zero
try {
$dialog=$null
for($attempt=0;$attempt -lt 300 -and $null -eq $dialog;$attempt++){
  $matches=@(Find-Exact)
  if($matches.Count -gt 1){throw 'ambiguous verified diagnostics dialog'}
  if($matches.Count -eq 1){$dialog=$matches[0].element;break}
  Start-Sleep -Milliseconds 50
}
if($null -eq $dialog){
  $counts=@([CwBetaNative]::CountExpectedWindows($pidExpected,'#32770','Export Claude Workbench diagnostics'))
  $closed=[pscustomobject]@{
    topLevel=[pscustomobject]@{visible=$counts[0];class32770=$counts[1];exactTitle=$counts[2];exactBoth=$counts[3]};
    children=[pscustomobject]@{visible=$counts[4];class32770=$counts[5];exactTitle=$counts[6];exactBoth=$counts[7]}
  }
  Write-Output ('CW_BETA_NATIVE_DISCOVERY='+($closed|ConvertTo-Json -Compress))
  throw 'verified diagnostics dialog missing'
}
$dialogHwnd=[IntPtr]$dialog.Current.NativeWindowHandle
$dialog=Get-ExactRootProviderDialog $dialogHwnd.ToInt64()
if($null -eq $dialog){throw 'same-HWND UIA Root dialog ambiguous or missing'}
$nativeIdCounts=@([CwBetaNative]::CountNativeControlIds($dialogHwnd,$pidExpected))
$closedNativeIds=[pscustomobject]@{
  id1001=[pscustomobject]@{id=$nativeIdCounts[0];visible=$nativeIdCounts[1];expectedPid=$nativeIdCounts[2];contained=$nativeIdCounts[3]};
  id1=[pscustomobject]@{id=$nativeIdCounts[4];visible=$nativeIdCounts[5];expectedPid=$nativeIdCounts[6];contained=$nativeIdCounts[7]}
}
$native1001=@([CwBetaNative]::FindNativeControlId($dialogHwnd,$pidExpected,1001))
$native1=@([CwBetaNative]::FindNativeControlId($dialogHwnd,$pidExpected,1))
$editUia=0;$editNative=0;$editType=0;$editValue=0;$editVisibleEnabled=0;$editCanonical=0;$editFresh=0;$editTargetAbsent=0
$saveUia=0;$saveNative=0;$saveButtonType=0;$saveAnchoredName=0;$savePositiveHwnd=0
$documentsForDiagnostic=$null
$diagnosticFolderPtr=[IntPtr]::Zero
$diagnosticFolderHr=[CwBetaNative]::SHGetKnownFolderPath([Guid]'FDD39AD0-238F-46AF-ADB4-6C85480369C7',0,[IntPtr]::Zero,[ref]$diagnosticFolderPtr)
if($diagnosticFolderHr -eq 0 -and $diagnosticFolderPtr -ne [IntPtr]::Zero){
  try{$documentsForDiagnostic=[Runtime.InteropServices.Marshal]::PtrToStringUni($diagnosticFolderPtr)}
  finally{[CwBetaNative]::CoTaskMemFree($diagnosticFolderPtr)}
}
foreach($handleValue in $native1001){
  $handle=[IntPtr]$handleValue;$element=$null
  try{$element=[Windows.Automation.AutomationElement]::FromHandle($handle)}catch{$element=$null}
  if($null -eq $element){continue};$editUia++
  if(-not [CwBetaNative]::RevalidateNativeControl($dialogHwnd,$handle,$pidExpected,1001) -or
    $element.Current.NativeWindowHandle -ne $handle.ToInt32() -or $element.Current.ProcessId -ne $pidExpected){continue}
  $editNative++
  if($element.Current.ControlType -ne [Windows.Automation.ControlType]::Edit){continue};$editType++
  $pattern=$null
  if(-not $element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)){continue};$editValue++
  if($element.Current.IsOffscreen -or -not $element.Current.IsEnabled){continue};$editVisibleEnabled++
  $candidateValue=[string]$pattern.Current.Value
  $candidateMatch=[regex]::Match($candidateValue,'^ClaudeWorkbench-diagnostics-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.zip$')
  if(-not $candidateMatch.Success -or $candidateValue -match '[\\/:]' -or [IO.Path]::GetFileName($candidateValue) -ne $candidateValue){continue}
  $editCanonical++
  try {
    $candidateIso=('{0}-{1}-{2}T{3}:{4}:{5}.{6}Z' -f $candidateMatch.Groups[1].Value,$candidateMatch.Groups[2].Value,
      $candidateMatch.Groups[3].Value,$candidateMatch.Groups[4].Value,$candidateMatch.Groups[5].Value,
      $candidateMatch.Groups[6].Value,$candidateMatch.Groups[7].Value)
    $candidateStamp=[DateTimeOffset]::ParseExact($candidateIso,'yyyy-MM-ddTHH:mm:ss.fffZ',
      [Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal)
    $candidateRoundTrip='ClaudeWorkbench-diagnostics-'+$candidateStamp.UtcDateTime.ToString('yyyy-MM-ddTHH-mm-ss-fffZ',
      [Globalization.CultureInfo]::InvariantCulture)+'.zip'
    $candidateNow=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if($candidateRoundTrip -ne $candidateValue -or $candidateStamp.ToUnixTimeMilliseconds() -lt ($requestedAt-2000) -or
      $candidateStamp.ToUnixTimeMilliseconds() -gt ($candidateNow+2000)){continue}
    $editFresh++
    if($null -ne $documentsForDiagnostic -and -not (Test-Path -LiteralPath ([IO.Path]::Combine($documentsForDiagnostic,$candidateValue)))){
      $editTargetAbsent++
    }
  } catch { continue }
}
foreach($handleValue in $native1){
  $handle=[IntPtr]$handleValue;$element=$null
  try{$element=[Windows.Automation.AutomationElement]::FromHandle($handle)}catch{$element=$null}
  if($null -eq $element){continue};$saveUia++
  if(-not [CwBetaNative]::RevalidateNativeControl($dialogHwnd,$handle,$pidExpected,1) -or
    $element.Current.NativeWindowHandle -ne $handle.ToInt32() -or $element.Current.ProcessId -ne $pidExpected){continue}
  $saveNative++
  if($element.Current.ControlType -ne [Windows.Automation.ControlType]::Button){continue};$saveButtonType++
  if($element.Current.Name -notmatch '^(Save|保存)(\([^)]*\))?$'){continue};$saveAnchoredName++
  if($element.Current.NativeWindowHandle -gt 0){$savePositiveHwnd++}
}
$closedJointControls=[pscustomobject]@{
  id1001=[pscustomobject]@{nativeCandidates=$native1001.Count;uiaNonnull=$editUia;nativeRevalidated=$editNative;
    edit=$editType;valuePattern=$editValue;visibleEnabled=$editVisibleEnabled;canonicalBasename=$editCanonical;
    freshRoundTrip=$editFresh;targetAbsent=$editTargetAbsent};
  id1=[pscustomobject]@{nativeCandidates=$native1.Count;uiaNonnull=$saveUia;nativeRevalidated=$saveNative;
    button=$saveButtonType;anchoredName=$saveAnchoredName;positiveHwnd=$savePositiveHwnd}
}
$win32JointCounts=@([CwBetaNative]::AnalyzeNativeControlPredicates($dialogHwnd,$pidExpected,$requestedAt))
$closedWin32Joint=[pscustomobject]@{
  direct1001=[pscustomobject]@{nativeCandidates=$win32JointCounts[0];visibleEnabled=$win32JointCounts[1];
    classEdit=$win32JointCounts[2];canonicalFreshText=$win32JointCounts[3]};
  descendant1001=[pscustomobject]@{containers=$win32JointCounts[4];nativeDescendants=$win32JointCounts[5];
    expectedPidContained=$win32JointCounts[6];classEdit=$win32JointCounts[7];visibleEnabled=$win32JointCounts[8];
    canonicalFreshText=$win32JointCounts[9]};
  mergedFilename=[pscustomobject]@{canonicalFreshCandidates=$win32JointCounts[10]};
  id1=[pscustomobject]@{nativeCandidates=$win32JointCounts[11];visibleEnabled=$win32JointCounts[12];
    classButton=$win32JointCounts[13];anchoredText=$win32JointCounts[14]}
}
$boundedTextCounts=@([CwBetaNative]::AnalyzeBoundedNativeEditText($dialogHwnd,$pidExpected,$requestedAt))
$closedBoundedText=[pscustomobject]@{
  nativeEditCandidates=$boundedTextCounts[0];preRevalidated=$boundedTextCounts[1];lengthRead=$boundedTextCounts[2];
  lengthWithinBound=$boundedTextCounts[3];textRead=$boundedTextCounts[4];postRevalidated=$boundedTextCounts[5];
  canonicalBasename=$boundedTextCounts[6];freshRoundTrip=$boundedTextCounts[7];targetAbsent=$boundedTextCounts[8]
}
$nativeBinding=@([CwBetaNative]::BindNativeSaveOperation($dialogHwnd,$pidExpected,$requestedAt))
if($nativeBinding.Count -ne 6){throw 'filename edit ambiguity'}
$editHwnd=[Int64]$nativeBinding[3]
$saveHwnd=[Int64]$nativeBinding[4]
$nativeCandidate=[pscustomobject]@{
  expectedPid=$pidExpected;knownFolderSource='SHGetKnownFolderPath(FOLDERID_Documents)';targetExisted=$false;
  documents=[string]$nativeBinding[1];target=[string]$nativeBinding[2];filename=[string]$nativeBinding[0];
  dialogs=@([pscustomobject]@{
    pid=$pidExpected;hwnd=$dialogHwnd.ToInt64();className='#32770';title='Export Claude Workbench diagnostics';visible=$true;
    editControls=@([pscustomobject]@{pid=$pidExpected;hwnd=$editHwnd;controlId=1001;nativeClass='Edit';
      visible=$true;enabled=$true;contained=$true;preRevalidated=$true;boundedTextRead=$true;
      postRevalidated=$true;beforeActionRevalidated=$true;targetAbsent=$true;value=[string]$nativeBinding[0]});
    saveControls=@([pscustomobject]@{pid=$pidExpected;hwnd=$saveHwnd;controlId=1;nativeClass='Button';
      visible=$true;enabled=$true;contained=$true;nativeText=[string]$nativeBinding[5];
      preRevalidated=$true;beforeActionRevalidated=$true})
  })
}
Write-Output ('CW_BETA_NATIVE_CANDIDATE='+($nativeCandidate|ConvertTo-Json -Depth 8 -Compress))
$fallback=[CwBetaNative]::ExecuteBoundNativeSaveOperation($dialogHwnd,[IntPtr]$editHwnd,[IntPtr]$saveHwnd,
  $pidExpected,$requestedAt,[string]$nativeBinding[0],[string]$nativeBinding[1],[string]$nativeBinding[2],[string]$nativeBinding[5])
$nativeResult=[pscustomobject]@{
  candidate=$nativeCandidate;
  action=[pscustomobject]@{dialogBeforeActionRevalidated=$true;boundedBmClick=$true;fallback=$fallback;
    fallbackRevalidated=$(if($fallback -eq 'same_dialog_wm_command'){$true}else{$null});
    boundedWmCommand=$(if($fallback -eq 'same_dialog_wm_command'){$true}else{$null});dialogClosed=$true}
}
$completed=$true
Write-Output ('CW_BETA_NATIVE_RESULT='+($nativeResult|ConvertTo-Json -Depth 10 -Compress))
} finally {
  if(-not $completed -and $dialogHwnd -ne [IntPtr]::Zero){Close-ExactDialog $dialogHwnd.ToInt64()}
}
`;
}

async function preflightDiagnosticsArchive(zipPath, includeAnonymousPerformanceData) {
  const policy = createDiagnosticsArchivePolicy(includeAnonymousPerformanceData);
  try {
    const bytes = fs.readFileSync(zipPath);
    assert(bytes.length >= 22 && bytes.length <= DIAGNOSTICS_ARCHIVE_MAX_PHYSICAL_BYTES,
      'Diagnostics archive physical size is outside its bound.');
    const searchStart = Math.max(0, bytes.length - 65_557);
    let eocd = -1;
    for (let offset = bytes.length - 22; offset >= searchStart; offset -= 1) {
      if (bytes.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
    }
    assert(eocd >= 0, 'Diagnostics archive end record is missing.');
    const disk = bytes.readUInt16LE(eocd + 4);
    const centralDisk = bytes.readUInt16LE(eocd + 6);
    const diskEntries = bytes.readUInt16LE(eocd + 8);
    const totalEntries = bytes.readUInt16LE(eocd + 10);
    const centralSize = bytes.readUInt32LE(eocd + 12);
    const centralOffset = bytes.readUInt32LE(eocd + 16);
    const commentLength = bytes.readUInt16LE(eocd + 20);
    assert(disk === 0 && centralDisk === 0 && diskEntries === totalEntries
      && totalEntries > 0 && totalEntries <= DIAGNOSTICS_ARCHIVE_MAX_ENTRIES,
    'Diagnostics archive spans disks or has an invalid entry count.');
    assert(eocd + 22 + commentLength === bytes.length && centralOffset + centralSize === eocd,
      'Diagnostics archive central directory bounds are invalid.');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const localRanges = [];
    let cursor = centralOffset;
    for (let index = 0; index < totalEntries; index += 1) {
      assert(cursor + 46 <= eocd && bytes.readUInt32LE(cursor) === 0x02014b50,
        'Diagnostics archive central entry is invalid.');
      const versionMadeBy = bytes.readUInt16LE(cursor + 4);
      const flags = bytes.readUInt16LE(cursor + 8);
      const compression = bytes.readUInt16LE(cursor + 10);
      const checksum = bytes.readUInt32LE(cursor + 16);
      const compressedSize = bytes.readUInt32LE(cursor + 20);
      const uncompressedSize = bytes.readUInt32LE(cursor + 24);
      const nameLength = bytes.readUInt16LE(cursor + 28);
      const extraLength = bytes.readUInt16LE(cursor + 30);
      const entryCommentLength = bytes.readUInt16LE(cursor + 32);
      const startDisk = bytes.readUInt16LE(cursor + 34);
      const externalFileAttributes = bytes.readUInt32LE(cursor + 38);
      const localOffset = bytes.readUInt32LE(cursor + 42);
      const centralEnd = cursor + 46 + nameLength + extraLength + entryCommentLength;
      assert(centralEnd <= eocd && startDisk === 0 && (flags & 0x0009) === 0 && compression === 0,
        'Diagnostics archive entry header is unsupported or unsafe.');
      const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
      const fileName = decoder.decode(nameBytes);
      acceptDiagnosticsArchiveEntry(policy, { fileName, uncompressedSize, externalFileAttributes, versionMadeBy });
      assert(compressedSize === uncompressedSize && localOffset + 30 <= centralOffset
        && bytes.readUInt32LE(localOffset) === 0x04034b50,
      'Diagnostics archive local entry is invalid.');
      const localFlags = bytes.readUInt16LE(localOffset + 6);
      const localCompression = bytes.readUInt16LE(localOffset + 8);
      const localChecksum = bytes.readUInt32LE(localOffset + 14);
      const localCompressedSize = bytes.readUInt32LE(localOffset + 18);
      const localUncompressedSize = bytes.readUInt32LE(localOffset + 22);
      const localNameLength = bytes.readUInt16LE(localOffset + 26);
      const localExtraLength = bytes.readUInt16LE(localOffset + 28);
      const localNameStart = localOffset + 30;
      const localDataStart = localNameStart + localNameLength + localExtraLength;
      const localEnd = localDataStart + localCompressedSize;
      assert(localFlags === flags && localCompression === compression && localChecksum === checksum
        && localCompressedSize === compressedSize && localUncompressedSize === uncompressedSize
        && localNameLength === nameLength && localEnd <= centralOffset
        && bytes.subarray(localNameStart, localNameStart + localNameLength).equals(nameBytes)
        && crc32Buffer(bytes.subarray(localDataStart, localEnd)) === checksum,
      'Diagnostics archive local and central entry identities differ.');
      localRanges.push([localOffset, localEnd]);
      cursor = centralEnd;
    }
    assert(cursor === eocd, 'Diagnostics archive central directory contains trailing data.');
    localRanges.sort((left, right) => left[0] - right[0]);
    for (let index = 0; index < localRanges.length; index += 1) {
      assert(localRanges[index][0] >= 0 && (index === 0 || localRanges[index - 1][1] <= localRanges[index][0]),
        'Diagnostics archive local entries overlap.');
    }
    return finalizeDiagnosticsArchivePolicy(policy);
  } catch (error) {
    if (error?.archiveInspectionFailure) throw error;
    throw archiveInspectionError(policy.names.size === 0 ? 'archive_open' : 'header_preflight', policy);
  }
}

function assertBoundZipIdentity(zipPath, expectedIdentity) {
  assert(Number.isSafeInteger(expectedIdentity?.size)
    && expectedIdentity.size <= DIAGNOSTICS_ARCHIVE_MAX_PHYSICAL_BYTES,
  'Expected bound diagnostics ZIP size is invalid.');
  const current = snapshotBoundFile(zipPath, expectedIdentity.size);
  assert(sameFileIdentity(current, expectedIdentity), 'Bound diagnostics ZIP identity changed during inspection.');
  return true;
}

function readIdentityBoundExtractedJson(target) {
  const before = snapshotBoundFile(target, DIAGNOSTICS_ARCHIVE_MAX_ENTRY_BYTES);
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  const after = snapshotBoundFile(target, DIAGNOSTICS_ARCHIVE_MAX_ENTRY_BYTES);
  assert(sameFileIdentity(before, after), 'Extracted diagnostics JSON identity changed while reading.');
  return parsed;
}

async function inspectDiagnosticsArchiveExact(zipPath, expectedIdentity, extraction, ownedRoot,
  includeAnonymousPerformanceData) {
  let stage = 'identity_before_preflight';
  let counts = null;
  try {
    assert(typeof extraction === 'string' && path.isAbsolute(extraction) && !fs.existsSync(extraction),
      'Diagnostics extraction target is invalid or already exists.');
    const relative = path.relative(ownedRoot, extraction);
    assert(typeof ownedRoot === 'string' && path.isAbsolute(ownedRoot) && relative.length > 0
      && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative),
    'Diagnostics extraction target escaped the owned fixture.');
    assertOrdinaryExistingPath(ownedRoot);
    assertBoundZipIdentity(zipPath, expectedIdentity);
    stage = 'header_preflight';
    const preflight = await preflightDiagnosticsArchive(zipPath, includeAnonymousPerformanceData);
    counts = preflight;
    stage = 'identity_before_extract';
    assertBoundZipIdentity(zipPath, expectedIdentity);
    fs.mkdirSync(extraction);
    const extractionPolicy = createDiagnosticsArchivePolicy(includeAnonymousPerformanceData);
    stage = 'extract';
    await extract(zipPath, { dir: extraction,
      onEntry: (entry) => acceptDiagnosticsArchiveEntry(extractionPolicy, entry) });
    stage = 'extracted_contract';
    const extractedPolicy = finalizeDiagnosticsArchivePolicy(extractionPolicy);
    assert(JSON.stringify(extractedPolicy.entryNames) === JSON.stringify(preflight.entryNames)
      && extractedPolicy.totalBytes === preflight.totalBytes,
    'Diagnostics archive changed between preflight and extraction.');
    stage = 'identity_after_extract';
    assertBoundZipIdentity(zipPath, expectedIdentity);
    stage = 'extracted_tree';
    assertExtractedDiagnosticsTree(extraction, preflight.entryNames);
    stage = 'manifest_read';
    const manifest = readIdentityBoundExtractedJson(path.join(extraction, 'manifest.json'));
    stage = 'aggregate_read';
    const aggregate = includeAnonymousPerformanceData
      ? readIdentityBoundExtractedJson(path.join(extraction, 'anonymous-performance.json')) : null;
    stage = 'identity_after_read';
    assertBoundZipIdentity(zipPath, expectedIdentity);
    return { entryNames: preflight.entryNames, manifest, aggregate, extraction };
  } catch (error) {
    if (error?.archiveInspectionFailure) throw error;
    throw archiveInspectionError(stage, counts);
  }
}

async function exportDiagnosticsExact(client, electronPid, includeAnonymousPerformanceData, fixture, setPhase = () => {}) {
  const requestedAt = Date.now();
  const helper = runPowerShellEncoded(nativeDialogScript(electronPid, requestedAt));
  setPhase('native_and_api_wait');
  const settled = await Promise.allSettled([
    awaitHelper(helper, 45_000),
    client.evaluate(`window.api.exportDiagnostics({ includeAnonymousPerformanceData: ${includeAnonymousPerformanceData ? 'true' : 'false'} })`, { timeoutMs: 45_000 }),
  ]);
  const settlementFact = closedNativeExportSettlementFact(settled);
  if (settled[0].status === 'rejected') {
    setPhase(`native_helper_${settlementFact.helper}_api_${settlementFact.api}`);
    const returned = settled[0].reason?.nativeCandidate;
    await settleIndependentNativeFailureCleanup(
      () => runIndependentDialogCleanup(electronPid),
      () => returned
        ? recoverRejectedNativeHelperCandidate(settled[0].reason, electronPid, requestedAt)
        : Promise.resolve({ appeared: false, deleted: false }));
    throw settled[0].reason;
  }
  setPhase('native_helper_completed');
  const helperResult = settled[0].value;
  let native;
  try {
    native = nativeResultFromOutput(helperResult.output);
  } catch {
    await settleIndependentNativeFailureCleanup(
      () => runIndependentDialogCleanup(electronPid),
      async () => {
        const marker = nativeCandidateFromOutput(helperResult.output);
        return marker ? recoverFulfilledNativeHelperOutput(helperResult.output, electronPid, requestedAt)
          : { appeared: false, deleted: false };
      });
    throw new Error('Native diagnostics helper result failed its fixed contract after exact recovery.');
  }
  setPhase('native_identity_bind');
  const returned = native.candidate;
  let bound;
  try {
    bound = bindNativeSaveOperationFact({ ...returned, requestedAt, now: Date.now(), action: native.action });
    assert(returned.expectedPid === electronPid, 'Native result PID does not match the owned Electron process.');
    assertExactKnownFolderCandidatePath({ documents: returned.documents, target: returned.target,
      filename: bound.filename });
  } catch {
    await settleIndependentNativeFailureCleanup(
      () => runIndependentDialogCleanup(electronPid),
      async () => {
        const marker = nativeCandidateFromOutput(helperResult.output);
        return marker ? recoverFulfilledNativeHelperOutput(helperResult.output, electronPid, requestedAt)
          : { appeared: false, deleted: false };
      });
    throw new Error('Native diagnostics helper result failed its fixed contract after exact recovery.');
  }
  setPhase('exact_candidate_wait');
  const candidate = await waitForFreshExactCandidate(returned.target, requestedAt);
  const identity = candidate.identity;
  if (settled[1].status === 'rejected' || settled[1].value !== true) {
    setPhase(`api_${settlementFact.api}_after_candidate`);
    await settleIndependentNativeFailureCleanup(
      () => runIndependentDialogCleanup(electronPid),
      async () => deleteBoundFile(candidate));
    throw new Error('Diagnostics API failed after exact-candidate cleanup.');
  }
  setPhase('exact_candidate_bound');
  const extraction = path.join(fixture.root, `diagnostics-${includeAnonymousPerformanceData ? 'on' : 'off'}`);
  try {
    setPhase('archive_extract');
    const inspected = await inspectDiagnosticsArchiveExact(returned.target, identity, extraction, fixture.root,
      includeAnonymousPerformanceData);
    setPhase('archive_inspected');
    return { candidate, identity, ...inspected };
  } catch (error) {
    setPhase('archive_inspection_failed');
    await expectRejectWithBoundCleanup(async () => { throw error; }, candidate);
    const failure = new Error('Diagnostics post-save inspection failed after exact-candidate cleanup.');
    failure.archiveInspectionFailure = error?.archiveInspectionFailure
      ? closedArchiveInspectionFailureFact(error.archiveInspectionFailure)
      : closedArchiveInspectionFailureFact({ stage: 'unknown', acceptedEntries: 0, expandedBytes: 0 });
    throw failure;
  }
}

function scanFilesForSecrets(paths, secrets) {
  let files = 0; let bytes = 0;
  const visit = (target) => {
    if (!fs.existsSync(target)) return;
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) { for (const child of fs.readdirSync(target)) visit(path.join(target, child)); return; }
    if (!stat.isFile()) return;
    const value = fs.readFileSync(target); files += 1; bytes += value.length;
    for (const secret of secrets) assert(!value.includes(Buffer.from(secret, 'utf8')), 'Plaintext fixture credential escaped a trusted transient boundary.');
  };
  for (const target of paths) visit(target);
  return { passed: true, files, bytes };
}

function assertPrivateValuesAbsent(buffer, values, description) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), 'utf8');
  for (const value of values) {
    if (value) assert(!bytes.includes(Buffer.from(value, 'utf8')), `${description} contains a private acceptance identity.`);
  }
  return true;
}

function privatePathTextVariants(paths) {
  const variants = new Set();
  for (const value of paths) {
    assert(typeof value === 'string' && value.length > 0 && path.isAbsolute(value),
      'Private textual path identity is invalid.');
    const resolved = path.resolve(value);
    const separatorForms = new Set([resolved, resolved.replace(/\\/gu, '/'), resolved.replace(/\//gu, '\\')]);
    for (const form of separatorForms) {
      for (const caseForm of [form, form.toLocaleLowerCase('en-US'), form.toLocaleUpperCase('en-US')]) {
        variants.add(caseForm);
        variants.add(JSON.stringify(caseForm).slice(1, -1));
      }
    }
  }
  return [...variants];
}

function assertAcceptancePrivacyBoundary(buffer, sensitiveValues, privatePathValues, boundary) {
  const pathRestricted = new Set(['retained_report', 'task_report', 'owned_child_arguments', 'child_output',
    'artifact_metadata', 'screenshot_dom', 'public_workflow_dto', 'public_non_workflow_dto']);
  const pathPermitted = new Set(['persisted_event_payload']);
  assert(pathRestricted.has(boundary) || pathPermitted.has(boundary), 'Privacy boundary is not closed.');
  assert(Array.isArray(sensitiveValues) && Array.isArray(privatePathValues), 'Privacy boundary values are invalid.');
  const values = pathRestricted.has(boundary)
    ? [...sensitiveValues, ...privatePathValues] : sensitiveValues;
  return assertPrivateValuesAbsent(buffer, values, boundary);
}

const PUBLIC_WORKFLOW_DTO_KEYS = Object.freeze([
  'id', 'taskId', 'projectId', 'projectPath', 'prompt', 'status', 'currentStage', 'activeStage', 'modelPolicy', 'plan',
  'latestReview', 'reviewRound', 'maxReviewRounds', 'fixRound', 'maxFixRounds', 'revision', 'pausedFrom',
  'failure', 'createdAt', 'updatedAt',
]);

function assertValidatedWorkflowDtoPrivacy(workflow, expected, sensitiveValues, privatePathValues) {
  assert(workflow && typeof workflow === 'object' && !Array.isArray(workflow)
    && JSON.stringify(Object.keys(workflow).sort()) === JSON.stringify([...PUBLIC_WORKFLOW_DTO_KEYS].sort()),
  'Public Workflow DTO schema is not closed.');
  assert(expected && typeof expected === 'object' && typeof expected.id === 'string' && expected.id.length > 0
    && typeof expected.taskId === 'string' && expected.taskId.length > 0
    && typeof expected.projectId === 'string' && expected.projectId.length > 0
    && typeof expected.projectPath === 'string' && path.isAbsolute(expected.projectPath),
  'Expected public Workflow identity is invalid.');
  assert(workflow.id === expected.id && workflow.taskId === expected.taskId
    && workflow.projectId === expected.projectId && workflow.projectPath === expected.projectPath,
  'Public Workflow DTO identity or projectPath is not authoritative.');
  assert(typeof workflow.prompt === 'string' && typeof workflow.status === 'string'
    && (workflow.currentStage === null || typeof workflow.currentStage === 'string')
    && (workflow.activeStage === null || typeof workflow.activeStage === 'string')
    && workflow.modelPolicy && typeof workflow.modelPolicy === 'object' && !Array.isArray(workflow.modelPolicy)
    && (workflow.plan === null || (typeof workflow.plan === 'object' && !Array.isArray(workflow.plan)))
    && (workflow.latestReview === null || (typeof workflow.latestReview === 'object' && !Array.isArray(workflow.latestReview)))
    && [workflow.reviewRound, workflow.maxReviewRounds, workflow.fixRound, workflow.maxFixRounds, workflow.revision]
      .every((value) => Number.isInteger(value) && value >= 0)
    && (workflow.pausedFrom === null || typeof workflow.pausedFrom === 'string')
    && (workflow.failure === null || (typeof workflow.failure === 'object' && !Array.isArray(workflow.failure)))
    && typeof workflow.createdAt === 'string' && typeof workflow.updatedAt === 'string',
  'Public Workflow DTO field types are invalid.');
  const projected = { ...workflow, projectPath: '[validated-workflow-project-path]' };
  assertAcceptancePrivacyBoundary(JSON.stringify(projected), sensitiveValues, privatePathValues, 'public_workflow_dto');
  return true;
}

function assertPublicDtoCapturePrivacy(capture, expected, sensitiveValues, privatePathValues) {
  exactKeys(capture, ['providers', 'workflowA', 'workflowB', 'stagesA', 'bodyText'], 'Public DTO capture');
  exactKeys(expected, ['workflowA', 'workflowB'], 'Expected public Workflow identities');
  assert(typeof capture.bodyText === 'string', 'Public visible DOM capture is invalid.');
  assertAcceptancePrivacyBoundary(capture.bodyText, sensitiveValues, privatePathValues, 'screenshot_dom');
  assertAcceptancePrivacyBoundary(JSON.stringify(capture.providers), sensitiveValues, privatePathValues,
    'public_non_workflow_dto');
  assertAcceptancePrivacyBoundary(JSON.stringify(capture.stagesA), sensitiveValues, privatePathValues,
    'public_non_workflow_dto');
  assertValidatedWorkflowDtoPrivacy(capture.workflowA, expected.workflowA, sensitiveValues, privatePathValues);
  assertValidatedWorkflowDtoPrivacy(capture.workflowB, expected.workflowB, sensitiveValues, privatePathValues);
  return true;
}

function retainOwnedElectronOutputBuffers(target, instance) {
  assert(Array.isArray(target) && instance && typeof instance === 'object',
    'Owned Electron output retention target is invalid.');
  const streams = [instance.stdout, instance.stderr];
  assert(streams.every((chunks) => Array.isArray(chunks)
    && chunks.every((chunk) => Buffer.isBuffer(chunk))), 'Owned Electron output chunks are invalid.');
  const joined = streams.map((chunks) => Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  target.push(...joined);
  return joined.length;
}

const WINDOWS_COMMAND_LINE_ARGV_SCRIPT = String.raw`$ErrorActionPreference='Stop'
$utf8=New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding=$utf8
[Console]::OutputEncoding=$utf8
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class CwBetaCommandLine {
  [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern IntPtr CommandLineToArgvW(string commandLine, out int argc);

  [DllImport("kernel32.dll")]
  private static extern IntPtr LocalFree(IntPtr value);

  public static string[] Parse(string commandLine) {
    int argc;
    IntPtr native = CommandLineToArgvW(commandLine, out argc);
    if (native == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      string[] result = new string[argc];
      for (int index = 0; index < argc; index++) {
        IntPtr item = Marshal.ReadIntPtr(native, index * IntPtr.Size);
        result[index] = Marshal.PtrToStringUni(item) ?? string.Empty;
      }
      return result;
    } finally {
      LocalFree(native);
    }
  }
}
'@
$line=[Console]::In.ReadToEnd()
if([string]::IsNullOrWhiteSpace($line)){throw 'empty command line'}
$parsed=[CwBetaCommandLine]::Parse($line)
[Console]::Out.Write((ConvertTo-Json -Compress -InputObject @($parsed)))`;

function parseWindowsCommandLineExact(commandLine) {
  assert(process.platform === 'win32' && typeof commandLine === 'string' && commandLine.length > 0
    && Buffer.byteLength(commandLine, 'utf8') <= 1024 * 1024 && !commandLine.includes('\0'),
  'Owned Claude command line cannot be parsed safely.');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
    '-Command', WINDOWS_COMMAND_LINE_ARGV_SCRIPT], {
    input: commandLine,
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 5_000, maxBuffer: 2 * 1024 * 1024,
  });
  assert(!result.error && result.status === 0 && result.signal === null && !result.stderr.trim()
    && result.stdout.trim(), 'Owned Claude command line parsing failed.');
  let argv = null;
  try { argv = JSON.parse(result.stdout); } catch { /* fixed failure below */ }
  assert(Array.isArray(argv) && argv.length > 0 && argv.every((item) => typeof item === 'string'),
    'Owned Claude command line parsing returned invalid arguments.');
  return argv;
}

function assertExactPermissionMcpConfig(value, input) {
  let config = null;
  try { config = JSON.parse(value); } catch { /* fixed failure below */ }
  exactKeys(config, ['mcpServers'], 'Owned Claude MCP config');
  exactKeys(config.mcpServers, ['workbench_permissions'], 'Owned Claude MCP server map');
  const server = config.mcpServers.workbench_permissions;
  exactKeys(server, ['type', 'command', 'args', 'env'], 'Owned Claude permission MCP server');
  assert(server.type === 'stdio' && server.command === input.electronExecutable
    && Array.isArray(server.args) && server.args.length === 1 && server.args[0] === input.permissionMcpPath,
  'Owned Claude permission MCP executable identity is invalid.');
  exactKeys(server.env, ['ELECTRON_RUN_AS_NODE'], 'Owned Claude permission MCP environment');
  assert(server.env.ELECTRON_RUN_AS_NODE === '1', 'Owned Claude permission MCP environment is invalid.');
  return true;
}

function assertOwnedClaudeChildArgumentsPrivacy(buffer, input, setPhase = () => undefined) {
  assert(Buffer.isBuffer(buffer), 'Owned Claude argument buffer is invalid.');
  noteChildArgvPhase(setPhase, 'child_argv_observed_executable');
  for (const key of ['claudeExecutable', 'observedExecutablePath', 'electronExecutable', 'permissionMcpPath']) {
    assert(typeof input?.[key] === 'string' && path.isAbsolute(input[key]),
      'Authoritative owned Claude argument path is invalid.');
  }
  assert(samePath(input.observedExecutablePath, input.claudeExecutable),
    'Observed Claude executable identity is not authoritative.');
  assert(input.promptToolName === 'mcp__workbench_permissions__request_permission',
    'Authoritative permission prompt tool is invalid.');
  noteChildArgvPhase(setPhase, 'child_argv_command_line_parse');
  const argv = parseWindowsCommandLineExact(buffer.toString('utf8'));
  noteChildArgvPhase(setPhase, 'child_argv_argv0');
  assert(argv[0] === 'claude',
    'Owned Claude executable argument identity is not authoritative.');
  const mcpFlag = '--mcp-config';
  const promptFlag = '--permission-prompt-tool';
  noteChildArgvPhase(setPhase, 'child_argv_flag_layout');
  assert(argv.filter((item) => item === mcpFlag).length === 1
    && argv.filter((item) => item === promptFlag).length === 1
    && !argv.some((item) => item.startsWith(`${mcpFlag}=`) || item.startsWith(`${promptFlag}=`)),
  'Owned Claude permission MCP flags are ambiguous or malformed.');
  const mcpIndex = argv.indexOf(mcpFlag);
  const promptIndex = argv.indexOf(promptFlag);
  assert(mcpIndex === argv.length - 4 && promptIndex === argv.length - 2 && promptIndex === mcpIndex + 2
    && argv[promptIndex + 1] === input.promptToolName,
  'Owned Claude permission MCP flags are missing, misplaced, or have the wrong value.');
  noteChildArgvPhase(setPhase, 'child_argv_mcp_closed_config');
  assertExactPermissionMcpConfig(argv[mcpIndex + 1], input);
  noteChildArgvPhase(setPhase, 'child_argv_privacy');
  for (const untrustedArgument of argv.slice(1, mcpIndex)) {
    assertAcceptancePrivacyBoundary(Buffer.from(untrustedArgument, 'utf8'), input.sensitiveValues,
      input.privateProfilePaths, 'owned_child_arguments');
  }
  return true;
}

function credentialPrivacyFacts(fixture) {
  const database = new BetterSqlite3(databasePath(fixture), { readonly: true, fileMustExist: true });
  try {
    const rows = database.prepare('SELECT credential_ref FROM model_providers WHERE credential_ref IS NOT NULL ORDER BY id').all();
    const references = rows.map((row) => row.credential_ref);
    assert(references.length === 3 && new Set(references).size === 3, 'Provider credential references are missing or ambiguous.');
    const vaultFileNames = references.map((reference) => `${reference.slice('safe-storage://v1/'.length)}.bin`);
    for (const fileName of vaultFileNames) {
      const target = path.join(fixture.dataRoot, 'model-credentials', fileName);
      assert(fs.existsSync(target) && fs.lstatSync(target).isFile(), 'Expected encrypted credential blob is unavailable.');
    }
    const eventPayloads = [];
    for (const table of ['task_events', 'workflow_events']) {
      const exists = database.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name=?`).get(table).count;
      if (!exists) continue;
      const columns = database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
      const textColumns = columns.filter((name) => /payload|input|output|error|metadata|details/iu.test(name));
      if (textColumns.length > 0) eventPayloads.push(...database.prepare(`SELECT ${textColumns.join(',')} FROM ${table}`).all());
    }
    return { references, vaultFileNames, eventPayloads };
  } finally { database.close(); }
}

function acceptanceTaggedProcessCount(tag) {
  if (process.platform !== 'win32') return 0;
  const escaped = tag.replace(/'/gu, "''");
  const script = `@((Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${escaped}*' })).Count`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
    encoding: 'utf8', windowsHide: true, shell: false,
  });
  return Number(result.stdout.trim() || '0');
}

function countTaggedProcessRecords(records, tag, inspectingPid) {
  return records.filter((record) => record.ProcessId !== inspectingPid
    && typeof record.CommandLine === 'string' && record.CommandLine.includes(tag)).length;
}

function taggedElectronRoleFact(tag, expectedLaunchPid) {
  assert(typeof tag === 'string' && /^[0-9a-f-]{36}$/iu.test(tag), 'Acceptance process tag is invalid.');
  assert(Number.isInteger(expectedLaunchPid) && expectedLaunchPid > 0, 'Expected Electron launch PID is invalid.');
  if (process.platform !== 'win32') return closedTaggedElectronRoleFact({
    taggedRoots: 1, main: 1, renderer: 0, utility: 0, other: 0, expectedLaunchPidIsMain: true,
  });
  const escaped = tag.replace(/'/gu, "''");
  const script = `$all=@(Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId,Name,CommandLine);`
    + `$roots=@($all|Where-Object {$_.Name -eq 'electron.exe' -and $_.CommandLine -like '*--cw-beta-acceptance=${escaped}*'});`
    + `$owned=New-Object System.Collections.Generic.List[object];$seen=@{};$pending=@($roots);`
    + `while($pending.Count -gt 0){$current=$pending[0];if($pending.Count -eq 1){$pending=@()}else{$pending=$pending[1..($pending.Count-1)]};`
    + `if($seen.ContainsKey([string]$current.ProcessId)){continue};$seen[[string]$current.ProcessId]=$true;$owned.Add($current);`
    + `$pending+=@($all|Where-Object ParentProcessId -eq $current.ProcessId)};`
    + `$main=@($roots|Where-Object {$_.CommandLine -notmatch '(?:^|\\s)--type='}).Count;`
    + `$renderer=@($owned|Where-Object {$_.CommandLine -match '(?:^|\\s)--type=renderer(?:\\s|$)'}).Count;`
    + `$utility=@($owned|Where-Object {$_.CommandLine -match '(?:^|\\s)--type=utility(?:\\s|$)'}).Count;`
    + `$other=$owned.Count-$main-$renderer-$utility;`
    + `$expected=@($roots|Where-Object {$_.ProcessId -eq ${expectedLaunchPid} -and $_.CommandLine -notmatch '(?:^|\\s)--type='}).Count -eq 1;`
    + `[pscustomobject]@{taggedRoots=$roots.Count;main=$main;renderer=$renderer;utility=$utility;other=$other;expectedLaunchPidIsMain=$expected}|ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
    encoding: 'utf8', windowsHide: true, shell: false,
  });
  assert(result.status === 0 && result.stdout.trim(), 'Tagged Electron role diagnostic failed.');
  return closedTaggedElectronRoleFact(JSON.parse(result.stdout));
}

async function runProductionAcceptance(options) {
  assert(process.env.FORCE_FAKE === undefined && process.env.WORKBENCH_FORCE_FAKE_CLAUDE === undefined,
    'Acceptance parent process has a fake-runtime variable.');
  const fixture = createIsolatedFixture();
  const sentinels = {
    providerASecret: `cw_a_${crypto.randomUUID()}`,
    providerBSecret: `cw_b_${crypto.randomUUID()}`,
    deepSeekSecret: `cw_d_${crypto.randomUUID()}`,
    providerAModel: `cw-a-${crypto.randomUUID()}`,
    providerBModel: `cw-b-${crypto.randomUUID()}`,
    deepSeekModel: `cw-d-${crypto.randomUUID()}`,
  };
  const privateProfilePaths = privatePathTextVariants([
    fixture.root, fixture.dataRoot, fixture.nativeDialogUserProfile,
  ]);
  const providerAName = `Provider A ${crypto.randomUUID().slice(0, 8)}`;
  const providerBName = `Provider B ${crypto.randomUUID().slice(0, 8)}`;
  const deepSeekName = `DeepSeek ${crypto.randomUUID().slice(0, 8)}`;
  const counters = { reviews: 0 };
  let releaseCoder;
  const coderHold = new Promise((resolve) => { releaseCoder = resolve; });
  let firstBCoderHeld = false;
  let aServer;
  let bServer;
  let deepServer;
  let instance;
  let ownedClaudeChildArguments = null;
  let authoritativeChildPaths = null;
  let step7TaskId = null;
  let step7WorkflowId = null;
  let step7RequestBaseline = null;
  let step7LastPlanFact = { identityMatch: false, status: 'unknown', currentStage: null,
    activeStage: null, hasPlan: false, failureCode: 'unknown' };
  let step7LastUiFact = { taskCurrentVisibleUnique: false, workflowListItemVisibleUnique: false,
    workflowListItemAriaCurrent: false, workflowPanelVisibleUnique: false, planTabSelectedUnique: false,
    startButtonCount: 0, enabledStartButtonCount: 0 };
  const ownedElectronOutputBuffers = [];
  const screenshots = [];
  const acceptancePhases = [];
  const report = {
    schemaVersion: 1,
    status: 'running',
    runtime: runtimeFacts(),
    cli: null,
    fixture: { freshProfile: true, isolatedWorkbench: true, isolatedChromium: true, isolatedClaudeConfig: true },
    steps: [], screenshots, requestEvidence: {}, artifacts: {}, privacy: {}, cleanup: {},
    limitations: ['Same-user recheck-to-path-unlink micro-race remains for exact diagnostics ZIP cleanup.'],
  };
  let phase = 'preflight';
  const addStep = (number, name, evidence) => {
    report.steps.push({ number, name, status: 'passed', evidence });
    phase = `after_step_${number}`;
  };
  let failure = null;
  let failureReportPrivacy = null;
  const zipCandidates = [];
  try {
    phase = 'output_setup';
    if (fs.existsSync(SCREENSHOT_ROOT)) removeScreenshotRoot(WORKSPACE_ROOT, SCREENSHOT_ROOT);
    validateScreenshotRoot(WORKSPACE_ROOT, SCREENSHOT_ROOT);
    fs.mkdirSync(SCREENSHOT_ROOT);
    phase = 'loopback_setup';
    aServer = await startLoopbackFixture({ name: 'Provider A', secret: sentinels.providerASecret, model: sentinels.providerAModel,
      responseForRequest: (body) => stagePayload(body, counters) });
    bServer = await startLoopbackFixture({ name: 'Provider B', secret: sentinels.providerBSecret, model: sentinels.providerBModel,
      responseForRequest: async (body) => {
        const wire = JSON.stringify(body.tools ?? body.output_config ?? body.output_format ?? {});
        if (/filesChanged/u.test(wire) && !firstBCoderHeld) { firstBCoderHeld = true; await coderHold; }
        return stagePayload(body, counters);
      } });
    deepServer = await startDeepSeekFixture(sentinels.deepSeekSecret, sentinels.deepSeekModel);
    phase = 'protocol_probe';
    report.cli = await runClaudeProtocolProbe(fixture, aServer, sentinels.providerASecret, sentinels.providerAModel);
    phase = 'electron_launch';
    instance = await launchProductionElectron(fixture, (owned) => { instance = owned; });
    const client = instance.client;

    await client.waitFor(`Boolean(document.getElementById('first-run-title'))`, { description: 'First Run dialog' });
    await client.evaluate(`window.api.setSettings({ language: 'en-US' })`);
    await client.send('Page.reload', { ignoreCache: true });
    await client.waitFor(`document.readyState === 'complete' && Boolean(document.getElementById('first-run-title'))`, { description: 'English First Run dialog' });
    screenshots.push(await screenshot(client, '01-first-run.png'));
    addStep(1, 'Fresh production profile shows First Run', { completedVersion: await client.evaluate('window.api.getFirstRunCompletedVersion()') });

    await clickFirstRunButton(client, 'Start setup');
    await clickFirstRunButton(client, 'Continue');
    await clickFirstRunButton(client, firstRunProviderConfigureLabel());
    await client.waitFor(`Boolean(document.querySelector('[data-testid="model-provider-center"]'))`, { description: 'Provider Center' });
    const providerA = await addProviderUi(client, { name: providerAName, type: 'anthropic', baseUrl: aServer.origin,
      modelId: sentinels.providerAModel, secret: sentinels.providerASecret });
    assert(providerA.rendererSecretCleared, 'Provider A secret remained in Renderer state.');
    await client.evaluate(`window.api.setDefaultModelProvider(${js(providerA.provider.id)})`);
    const soleCandidate = await client.evaluate(`window.api.listModelTierCandidates({ scope: { type: 'global' } })`);
    assertSoleTierCandidate(soleCandidate, providerA.provider.id, sentinels.providerAModel);
    addStep(2, 'Provider A added and tested through password UI', { rendererSecretCleared: true,
      health: providerA.provider.health.state, soleTierCandidate: true });

    phase = 'step3_open_agent_category';
    await clickSettingsCategory(client, 'Agent');
    phase = 'step3_apply_preset_ui';
    const initialPreset = await applySoftwarePresetUi(client, true, (value) => { phase = `step3_${value}`; });
    phase = 'step3_verify_preset_api';
    const globalStatus = await client.evaluate(`window.api.getAgentPresetStatus({ scope: { type: 'global' } })`);
    assert(globalStatus.kind === 'preset' && globalStatus.presetId === 'software_development', 'Software Development was not atomically applied.');
    addStep(3, 'First Software Development apply uses tier wizard and preview', { ...initialPreset, exactMap: exactPresetFacts() });

    await clickSettingsCategory(client, 'Models & Connections');
    const providerB = await addProviderUi(client, { name: providerBName, type: 'anthropic', baseUrl: bServer.origin,
      modelId: sentinels.providerBModel, secret: sentinels.providerBSecret });
    const deepSeek = await addProviderUi(client, { name: deepSeekName, type: 'openai-compatible', baseUrl: deepServer.origin,
      modelId: sentinels.deepSeekModel, secret: sentinels.deepSeekSecret });
    const globalCandidates = await client.evaluate(`window.api.listModelTierCandidates({ scope: { type: 'global' } })`);
    assert(globalCandidates.some((candidate) => candidate.providerId === providerA.provider.id)
      && globalCandidates.some((candidate) => candidate.providerId === providerB.provider.id)
      && !globalCandidates.some((candidate) => candidate.providerId === deepSeek.provider.id), 'Runtime-none candidate filtering failed.');
    addStep(4, 'Provider B and management-only DeepSeek added', { deepSeekConnected: deepSeek.provider.health.state === 'connected',
      deepSeekRuntime: deepSeek.provider.runtimeType, deepSeekExcludedFromTiers: true });

    phase = 'step5_set_global_balanced_b';
    await client.evaluate(`window.api.setModelTierBinding({ scope: { type: 'global' }, tier: 'balanced',
      providerId: ${js(providerB.provider.id)}, modelId: ${js(sentinels.providerBModel)} })`);
    phase = 'step5_close_settings';
    await closeSettings(client);
    phase = 'step5_first_run_provider_continue';
    await clickFirstRunButton(client, 'Continue');
    phase = 'step5_first_run_create_project';
    await clickFirstRunButton(client, firstRunFlowLabels().createProject);
    phase = 'step5_first_run_project_wait';
    await client.waitFor(`(() => {
      const dialog = document.querySelector('[role="dialog"][aria-labelledby="first-run-title"]');
      return Boolean(dialog && Array.from(dialog.querySelectorAll('button')).some((button) =>
        button.closest('[role="dialog"]') === dialog && (button.getAttribute('aria-label') || button.textContent || '').trim().startsWith('Continue with')));
    })()`, { description: 'First Run test project' });
    phase = 'step5_project_query';
    const project = await client.evaluate(firstRunProjectQueryExpression());
    assert(project?.id, 'Main-owned First Run project was not created.');
    const seedTask = await client.evaluate(`window.api.createSession(${js(project.id)})`);
    phase = 'step5_role_resolution';
    const providers = [providerA.provider, providerB.provider, deepSeek.provider];
    const initialRoles = await roleSelections(client, seedTask, providers);
    assertRoleMap(initialRoles, { planner: providerAName, coder: providerBName, tester: providerAName, reviewer: providerAName, fixer: providerBName });
    addStep(5, 'Global balanced B resolves exact five-role map', { roles: Object.fromEntries(ROLES.map((role) => [role, initialRoles[role].provider])) });
    phase = 'step6_delete_seed_task';
    await client.evaluate(`window.api.deleteSession(${js(seedTask)})`);

    phase = 'step6_continue_with_project';
    await clickFirstRunButton(client, 'Continue with', true);
    phase = 'step6_generate_plan';
    await clickFirstRunButton(client, firstRunFlowLabels().generatePlan);
    phase = 'step6_wait_plan_ready';
    const firstRunDeadline = Date.now() + STEP_TIMEOUT_MS;
    let firstRunEvidence = null;
    while (Date.now() < firstRunDeadline) {
      firstRunEvidence = await client.evaluate(firstRunPlanEvidenceExpression(project.id));
      if ((firstRunEvidence.workflowStatus === 'waiting_plan_confirmation' && firstRunEvidence.uiReady)
        || ['failed', 'cancelled', 'interrupted'].includes(firstRunEvidence.workflowStatus)) break;
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
    assert(firstRunEvidence?.taskId && firstRunEvidence?.workflowId, 'First Run task/workflow identity is unavailable.');
    const firstRunNonGit = inspectFirstRunNonGitEvidence(fixture, firstRunEvidence.workflowId, firstRunEvidence.taskId);
    report.firstRunGateEvidence = { workflowStatus: firstRunEvidence?.workflowStatus ?? null,
      permissionClass: firstRunNonGit.permissionMode === 'default' ? 'default' : 'non-default',
      failureCode: closedWorkflowFailureCode(firstRunEvidence?.failureCode),
      uiReady: firstRunEvidence?.uiReady === true, gitContextKind: firstRunNonGit.gitContextKind,
      gitCheckpointCount: firstRunNonGit.gitCheckpointTypes.length };
    report.diagnosticBoundaryEvidence = {
      loopback: {
        providerA: sanitizedLoopbackRequestEvidence(aServer),
        providerB: sanitizedLoopbackRequestEvidence(bServer),
        deepSeek: sanitizedLoopbackRequestEvidence(deepServer),
      },
      persistence: closedFailureDatabaseEvidence(fixture, firstRunEvidence?.taskId),
    };
    assertFirstRunPlanEvidence({ ...firstRunEvidence, currentPermissionMode: firstRunNonGit.permissionMode });
    assert(firstRunNonGit.plannerStageStatus === 'completed', 'Non-Git First Run Planner stage did not complete.');
    acceptancePhases.push('first_run_plan');
    const firstRunTask = { id: firstRunEvidence.taskId };
    const firstRunWorkflow = { status: firstRunEvidence.workflowStatus,
      currentPermissionMode: firstRunNonGit.permissionMode };
    phase = 'step6_finish_first_run';
    await clickFirstRunButton(client, firstRunFlowLabels().finish);
    await client.waitFor(`!document.getElementById('first-run-title')`, { description: 'First Run completion' });
    acceptancePhases.push('first_run_finish');
    phase = 'step6_visible_git_initialization';
    const gitInitialization = await initializeGitViaVisibleUi(client, acceptancePhases);

    phase = 'step6_create_workflow_a_task';
    const taskA = await createTaskViaVisibleUi(client, project.id);
    phase = 'step6_create_workflow_a';
    acceptancePhases.push('workflow_a_create');
    const workflowA = await client.evaluate(`window.api.createWorkflow({ taskId: ${js(taskA)}, prompt: 'Local acceptance task A', currentPermissionMode: 'default' })`);
    const firstRunGitFacts = { ...firstRunNonGit, ...gitInitialization, phases: acceptancePhases };
    assertFirstRunGitInitializationFacts(firstRunGitFacts);
    addStep(6, 'Non-Git First Run read-only plan then visible Git initialization', {
      workflowStatus: firstRunWorkflow.status, permissionMode: firstRunWorkflow.currentPermissionMode,
      gitContextKind: firstRunNonGit.gitContextKind, gitCheckpointCount: firstRunNonGit.gitCheckpointTypes.length,
      plannerStageStatus: firstRunNonGit.plannerStageStatus, initializationMethod: gitInitialization.initializationMethod,
      trustedRepositoryUi: gitInitialization.repositoryUiTrusted,
      completionVersion: await client.evaluate('window.api.getFirstRunCompletedVersion()'), workflowACreatedAfterInitialization: true,
    });
    step7TaskId = taskA;
    step7WorkflowId = workflowA.id;
    const providerMessageCount = (server) => server.requests.filter((item) => item.kind === 'messages').length;
    step7RequestBaseline = { providerA: providerMessageCount(aServer), providerB: providerMessageCount(bServer) };
    const step7RequestDelta = () => closedStep7RequestDeltaFact({
      providerA: providerMessageCount(aServer) - step7RequestBaseline.providerA,
      providerB: providerMessageCount(bServer) - step7RequestBaseline.providerB,
    });
    const step7Terminal = new Set(['paused', 'completed', 'failed', 'cancelled']);
    const readStep7PlanFact = async () => {
      const current = await client.evaluate(`window.api.getWorkflow(${js(workflowA.id)})`);
      step7LastPlanFact = closedStep7PlanResultFact(current, { workflowId: workflowA.id, taskId: taskA });
      return step7LastPlanFact;
    };
    const assertStep7NotTerminal = (fact) => {
      validateClosedStep7PlanFact(fact);
      assert(!step7Terminal.has(fact.status), 'Workflow A reached an unexpected terminal state.');
    };
    let switchUi = null;
    let mainBlocked = false;
    await runStep7PhaseSequence({
      setPhase: (value) => { phase = value; },
      planCall: async () => client.evaluate(`window.api.startWorkflowPlanning(${js(workflowA.id)})`),
      planResult: async (planned) => {
        step7LastPlanFact = closedStep7PlanResultFact(planned, { workflowId: workflowA.id, taskId: taskA });
        assertStep7PlanReadyFact(step7LastPlanFact);
        step7RequestDelta();
      },
      uiIdentityWait: async () => {
        const deadline = Date.now() + STEP_TIMEOUT_MS;
        while (Date.now() < deadline) {
          const current = await readStep7PlanFact();
          assertStep7NotTerminal(current);
          step7LastUiFact = validateClosedStep7UiFact(
            await client.evaluate(step7UiIdentityFactExpression(taskA, workflowA.id)));
          try {
            assertStep7PlanReadyFact(current);
            assertStep7UiReadyFact(step7LastUiFact);
            return;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 75));
          }
        }
        assertStep7PlanReadyFact(step7LastPlanFact);
        assertStep7UiReadyFact(step7LastUiFact);
      },
      clickStart: async () => {
        step7LastUiFact = validateClosedStep7UiFact(
          await client.evaluate(step7UiIdentityFactExpression(taskA, workflowA.id)));
        assertStep7UiReadyFact(step7LastUiFact);
        assert(await client.evaluate(step7ExactStartClickExpression(taskA, workflowA.id)),
          'Exact Workflow A execution control was not clicked.');
      },
      waitExecuting: async () => {
        const deadline = Date.now() + STEP_TIMEOUT_MS;
        while (Date.now() < deadline) {
          const current = await readStep7PlanFact();
          step7RequestDelta();
          if (current.status === 'executing') return;
          assertStep7NotTerminal(current);
          await new Promise((resolve) => setTimeout(resolve, 75));
        }
        assert(step7LastPlanFact.status === 'executing', 'Workflow A did not enter executing state.');
      },
      waitProviderBHold: async () => {
        const deadline = Date.now() + STEP_TIMEOUT_MS;
        while (!firstBCoderHeld && Date.now() < deadline) {
          const current = await readStep7PlanFact();
          assertStep7NotTerminal(current);
          step7RequestDelta();
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert(firstBCoderHeld, 'Provider B Coder response was not held.');
      },
      childArgv: async () => {
        const setChildArgvPhase = createChildArgvPhaseSetter((value) => { phase = value; });
        setChildArgvPhase('child_argv_descendant_presence');
        const descendants = descendantProcesses(instance.child.pid);
        assert(descendants.some((processInfo) => /claude/iu.test(processInfo.Name)),
          'A real Claude child process was not observed.');
        const ownedClaudeArgumentEvidence = descendantClaudeArgumentEvidence(instance.child.pid, setChildArgvPhase);
        ownedClaudeChildArguments = ownedClaudeArgumentEvidence.commandLine;
        authoritativeChildPaths = {
          ...authoritativeClaudeChildPaths(setChildArgvPhase),
          observedExecutablePath: ownedClaudeArgumentEvidence.observedExecutablePath,
        };
        assertOwnedClaudeChildArgumentsPrivacy(ownedClaudeChildArguments, {
          ...authoritativeChildPaths,
          promptToolName: 'mcp__workbench_permissions__request_permission',
          sensitiveValues: [sentinels.providerASecret, sentinels.providerBSecret, sentinels.deepSeekSecret],
          privateProfilePaths,
        }, setChildArgvPhase);
      },
      switchBlock: async () => {
        await clickTestId(client, 'model-quick-switcher');
        switchUi = await client.evaluate(`({ disabled: Array.from(document.querySelectorAll('[data-testid="model-switch-option"]')).every((item) => item.disabled || item.getAttribute('aria-disabled') === 'true') })`);
        try { await client.evaluate(`window.api.setTaskModelOverride({ taskId: ${js(taskA)}, providerId: ${js(providerA.provider.id)}, modelId: ${js(sentinels.providerAModel)} })`); }
        catch { mainBlocked = true; }
        assert(switchUi.disabled && mainBlocked, 'Running switch was not blocked in both UI and main.');
      },
    });
    report.diagnosticBoundaryEvidence.step7 = { plan: step7LastPlanFact, ui: step7LastUiFact,
      requestDelta: step7RequestDelta() };
    addStep(7, 'Workflow A holds real Provider B Coder and blocks switching', { realClaudeChildObserved: true,
      providerBRequestObserved: true, runningSwitchBlockedUi: true, runningSwitchBlockedMain: true,
      childArgumentsPrivacyScanned: true });

    await client.evaluate(`window.api.setModelTierBinding({ scope: { type: 'global' }, tier: 'balanced',
      providerId: ${js(providerA.provider.id)}, modelId: ${js(sentinels.providerAModel)} })`);
    const dbWhileHeld = inspectDatabase(fixture, [workflowA.id]);
    const frozenPolicy = dbWhileHeld.workflows[0]?.metadata?.modelSelectionPolicy;
    const expectedB = { providerId: providerB.provider.id, modelId: sentinels.providerBModel,
      source: 'global_agent_policy', executionSource: 'database_provider', tier: 'balanced', tierSource: 'global' };
    assertPersistedSelection(frozenPolicy?.coder, expectedB, 'Held Workflow A Coder snapshot');
    assertPersistedSelection(frozenPolicy?.fixer, expectedB, 'Held Workflow A Fixer snapshot');
    const runningCoder = dbWhileHeld.stages.find((stage) => stage.stage === 'coder' && stage.review_round === 1);
    assertPersistedSelection(runningCoder?.input?.modelSelection, expectedB, 'Held Workflow A Coder stage');
    await openSettingsCategory(client, 'Agent');
    const futureUi = await applySoftwarePresetUi(client, false, (value) => { phase = `step8_${value}`; });
    await closeSettings(client);
    addStep(8, 'Held Workflow remains frozen while global balanced changes to A', { currentCoder: providerBName,
      currentFixer: providerBName, futureBalanced: providerAName, uiFutureCallsOnly: futureUi.futureCallsOnly,
      workflowSnapshotPersisted: true, provenance: { source: expectedB.source, executionSource: expectedB.executionSource,
        tier: expectedB.tier, tierSource: expectedB.tierSource } });

    phase = 'step9_release_workflow_a_coder';
    releaseCoder();
    phase = 'step9_wait_workflow_a_terminal';
    const workflowATerminal = await waitForWorkflowTerminalFact(client, workflowA.id, 240_000);
    report.diagnosticBoundaryEvidence = {
      loopback: {
        providerA: sanitizedLoopbackRequestEvidence(aServer),
        providerB: sanitizedLoopbackRequestEvidence(bServer),
        deepSeek: sanitizedLoopbackRequestEvidence(deepServer),
      },
      persistence: closedFailureDatabaseEvidence(fixture, taskA),
      workflowA: workflowATerminal.fact,
    };
    phase = 'step9_assert_workflow_a_terminal';
    assertWorkflowACompletionFact(workflowATerminal.fact);
    const completedA = workflowATerminal.workflow;
    phase = 'step9_inspect_workflow_a_persistence';
    const persistedA = inspectDatabase(fixture, [workflowA.id]);
    const coderStagesA = persistedA.stages.filter((stage) => stage.stage === 'coder');
    const selectionIdentities = { providerA: providerA.provider.id, modelA: sentinels.providerAModel,
      providerB: providerB.provider.id, modelB: sentinels.providerBModel };
    report.diagnosticBoundaryEvidence.workflowACoderSelections = coderStagesA.map((stage) => ({
      reviewRound: stage.review_round,
      selection: closedSelectionDiagnosticFact(stage.input?.modelSelection, selectionIdentities),
    }));
    phase = 'step9_assert_workflow_a_stage_count';
    assert(coderStagesA.length >= 2, 'Workflow A did not persist both Coder and Fixer-as-Coder stages.');
    phase = 'step9_assert_workflow_a_coder_selection';
    assertPersistedSelection(coderStagesA[0].input.modelSelection, expectedB, 'Workflow A Coder persisted stage');
    phase = 'step9_assert_workflow_a_fixer_selection';
    assertPersistedSelection(coderStagesA[1].input.modelSelection, expectedB, 'Workflow A Fixer persisted stage');
    addStep(9, 'Workflow A completes one Review-to-Fix loop on frozen selections', { status: completedA.status,
      reviewRound: completedA.reviewRound, fixRound: completedA.fixRound, stageCount: persistedA.stages.length,
      coder: providerBName, fixer: providerBName, providerIdBound: true, modelIdBound: true,
      source: expectedB.source, executionSource: expectedB.executionSource, tier: expectedB.tier, tierSource: expectedB.tierSource });

    const taskB = await createTaskViaVisibleUi(client, project.id);
    const workflowB = await client.evaluate(`window.api.createWorkflow({ taskId: ${js(taskB)}, prompt: 'Local acceptance task B', currentPermissionMode: 'default' })`);
    const workflowBSelections = await roleSelections(client, taskB, providers);
    assert(workflowBSelections.coder.provider === providerAName && workflowBSelections.fixer.provider === providerAName,
      'Workflow B did not capture changed global balanced A.');
    const aRequestsBeforeWorkflowB = aServer.requests.filter((item) => item.kind === 'messages').length;
    await client.evaluate(`window.api.startWorkflowPlanning(${js(workflowB.id)})`, { timeoutMs: 120_000 });
    assert(aServer.requests.filter((item) => item.kind === 'messages').length > aRequestsBeforeWorkflowB,
      'Workflow B did not make an actual Provider A stage request.');
    const persistedAAfterB = inspectDatabase(fixture, [workflowA.id, workflowB.id]);
    const expectedAPlanner = { providerId: providerA.provider.id, modelId: sentinels.providerAModel,
      source: 'global_agent_policy', executionSource: 'database_provider', tier: 'high_quality', tierSource: 'global' };
    const workflowBPlanner = persistedAAfterB.stages.find((stage) => stage.workflow_id === workflowB.id && stage.stage === 'planner');
    assertPersistedSelection(workflowBPlanner?.input?.modelSelection, expectedAPlanner, 'Workflow B actual Planner stage');
    assert(persistedAAfterB.workflows[0].metadata_json === persistedA.workflows[0].metadata_json,
      'Workflow A provenance changed after Workflow B creation.');
    addStep(10, 'Workflow B captures changed A while Workflow A provenance is unchanged', { nextCoder: providerAName,
      nextFixer: providerAName, actualProviderAStageRequest: true, actualStage: 'planner', workflowAUnchanged: true,
      provenance: { source: expectedAPlanner.source, executionSource: expectedAPlanner.executionSource,
        tier: expectedAPlanner.tier, tierSource: expectedAPlanner.tierSource } });

    const taskPolicy = await createTaskViaVisibleUi(client, project.id);
    const sequence = [];
    sequence.push((await roleSelections(client, taskPolicy, providers)).coder);
    await client.evaluate(`window.api.bindAllModelTiers({ scope: { type: 'project', projectId: ${js(project.id)} },
      providerId: ${js(providerB.provider.id)}, modelId: ${js(sentinels.providerBModel)} })`);
    const projectPreview = await client.evaluate(`window.api.previewAgentPreset({ scope: { type: 'project', projectId: ${js(project.id)} }, presetId: 'software_development' })`);
    await client.evaluate(`window.api.applyAgentPreset({ scope: { type: 'project', projectId: ${js(project.id)} }, presetId: 'software_development',
      expectedRevision: ${js(projectPreview.revision)}, previewConfirmed: true, overwriteConfirmed: true })`);
    sequence.push((await roleSelections(client, taskPolicy, providers)).coder);
    await client.evaluate(`window.api.setTaskModelOverride({ taskId: ${js(taskPolicy)}, providerId: ${js(providerA.provider.id)}, modelId: ${js(sentinels.providerAModel)} })`);
    sequence.push((await roleSelections(client, taskPolicy, providers)).coder);
    await client.evaluate(`window.api.clearTaskModelOverride({ taskId: ${js(taskPolicy)} })`);
    sequence.push((await roleSelections(client, taskPolicy, providers)).coder);
    for (const role of [...ROLES, 'default']) await client.evaluate(`window.api.deleteProjectModelPolicy({ projectId: ${js(project.id)}, agentType: ${js(role)} })`);
    for (const tier of TIERS) await client.evaluate(`window.api.clearProjectModelTierBinding({ projectId: ${js(project.id)}, tier: ${js(tier)} })`);
    sequence.push((await roleSelections(client, taskPolicy, providers)).coder);
    assert(JSON.stringify(sequence.map((item) => [item.source, item.provider])) === JSON.stringify([
      ['global_agent_policy', providerAName], ['project_policy', providerBName], ['task_override', providerAName],
      ['project_policy', providerBName], ['global_agent_policy', providerAName],
    ]), 'Global/project/task precedence sequence drifted.');
    assert(JSON.stringify(sequence.map((item) => item.tierSource)) === JSON.stringify(['global', 'project', null, 'project', 'global']),
      'Authoritative global/project tierSource sequence drifted.');
    addStep(11, 'Global/project/task precedence and tier sources', { sequence: sequence.map((item) => ({ source: item.source, provider: item.provider })),
      tierSources: sequence.map((item) => item.tierSource) });

    phase = 'step12_bind_project_tiers_to_b';
    await client.evaluate(`window.api.bindAllModelTiers({ scope: { type: 'project', projectId: ${js(project.id)} },
      providerId: ${js(providerB.provider.id)}, modelId: ${js(sentinels.providerBModel)} })`);
    phase = 'step12_preview_valid_project_preset';
    const validPreview = await client.evaluate(`window.api.previewAgentPreset({ scope: { type: 'project', projectId: ${js(project.id)} }, presetId: 'software_development' })`);
    phase = 'step12_apply_valid_project_preset';
    await client.evaluate(`window.api.applyAgentPreset({ scope: { type: 'project', projectId: ${js(project.id)} }, presetId: 'software_development',
      expectedRevision: ${js(validPreview.revision)}, previewConfirmed: true, overwriteConfirmed: true })`);
    const beforeInvalid = inspectDatabase(fixture, [workflowA.id, workflowB.id]);
    const invalidStageRequestsBefore = aServer.requests.filter((item) => item.kind === 'messages').length
      + bServer.requests.filter((item) => item.kind === 'messages').length
      + deepServer.requests.filter((item) => item.kind === 'chat').length;
    phase = 'step12_disable_provider_b';
    await client.evaluate(`window.api.setModelProviderEnabled({ providerId: ${js(providerB.provider.id)}, enabled: false })`);
    phase = 'step12_list_invalid_bindings';
    const invalid = await client.evaluate(`window.api.listModelTierBindings({ scope: { type: 'project', projectId: ${js(project.id)} } })`);
    const bindingFact = closedDisabledBindingDiagnosticFact(invalid, {
      previewBlocked: false, templateApplyBlocked: false, workflowBlocked: false,
      workflowsUnchanged: true, fallbackUsed: false,
    });
    report.diagnosticBoundaryEvidence.step12 = { bindingCount: bindingFact.bindingCount,
      validity: bindingFact.validity, reason: bindingFact.reason };
    phase = 'step12_assert_invalid_bindings';
    assert(bindingFact.validity === 'needs_reconfiguration' && bindingFact.reason === 'provider_disabled',
      'Disabled Provider B bindings did not require reconfiguration.');
    phase = 'step12_prepare_preview_must_block';
    const blockedPrepare = await client.evaluate(`window.api.prepareAgentPreset({ scope: { type: 'project', projectId: ${js(project.id)} }, presetId: 'software_development' })`);
    const blockedPreview = await client.evaluate(`window.api.previewAgentPreset({ scope: { type: 'project', projectId: ${js(project.id)} }, presetId: 'software_development' })`);
    phase = 'step12_assert_preview_block';
    const previewBlocked = assertDisabledTemplatePreviewFacts(blockedPrepare, blockedPreview);
    let templateApplyBlocked = false; let workflowBlocked = false;
    phase = 'step12_template_apply_must_block';
    try { await client.evaluate(`window.api.applyAgentPreset({ scope: { type: 'project', projectId: ${js(project.id)} }, presetId: 'software_development',
      expectedRevision: ${js(blockedPreview.revision)}, previewConfirmed: true, overwriteConfirmed: true })`); } catch { templateApplyBlocked = true; }
    phase = 'step12_create_blocked_workflow_task';
    const invalidTask = await createTaskViaVisibleUi(client, project.id);
    phase = 'step12_workflow_create_must_block';
    try { await client.evaluate(`window.api.createWorkflow({ taskId: ${js(invalidTask)}, prompt: 'Blocked local acceptance task', currentPermissionMode: 'default' })`); } catch { workflowBlocked = true; }
    const afterInvalid = inspectDatabase(fixture, [workflowA.id, workflowB.id]);
    const invalidStageRequestsAfter = aServer.requests.filter((item) => item.kind === 'messages').length
      + bServer.requests.filter((item) => item.kind === 'messages').length
      + deepServer.requests.filter((item) => item.kind === 'chat').length;
    const workflowsUnchanged = beforeInvalid.workflowCount === afterInvalid.workflowCount
      && JSON.stringify(beforeInvalid.workflows) === JSON.stringify(afterInvalid.workflows);
    const disabledFacts = closedDisabledBindingDiagnosticFact(invalid, { previewBlocked, templateApplyBlocked,
      workflowBlocked, workflowsUnchanged, fallbackUsed: invalidStageRequestsAfter !== invalidStageRequestsBefore });
    report.diagnosticBoundaryEvidence.step12 = disabledFacts;
    phase = 'step12_assert_clean_block';
    assertDisabledBindingFacts(disabledFacts);
    addStep(12, 'Disabled Provider binding blocks preview and Workflow without fallback', { validity: 'needs_reconfiguration',
      reason: 'provider_disabled', previewBlocked, templateApplyBlocked, workflowBlocked,
      fallbackUsed: false, partialWrite: false });

    const beforeRestart = { completedVersion: await client.evaluate('window.api.getFirstRunCompletedVersion()'),
      providers: await client.evaluate(`window.api.listModelProviders({ limit: 100, offset: 0 })`),
      projectBindings: invalid, database: inspectDatabase(fixture, [workflowA.id, workflowB.id]) };
    await stopAndRetainOwnedElectron(instance, ownedElectronOutputBuffers);
    instance = null;
    instance = await launchProductionElectron(fixture, (owned) => { instance = owned; });
    const restartClient = instance.client;
    const afterRestart = { completedVersion: await restartClient.evaluate('window.api.getFirstRunCompletedVersion()'),
      providers: await restartClient.evaluate(`window.api.listModelProviders({ limit: 100, offset: 0 })`),
      workflowA: await restartClient.evaluate(`window.api.getWorkflow(${js(workflowA.id)})`),
      workflowB: await restartClient.evaluate(`window.api.getWorkflow(${js(workflowB.id)})`),
      database: inspectDatabase(fixture, [workflowA.id, workflowB.id]) };
    assert(afterRestart.completedVersion === 1 && !await restartClient.evaluate(`Boolean(document.getElementById('first-run-title'))`),
      'First Run completion did not persist.');
    assert(afterRestart.database.integrity === 'ok' && afterRestart.database.foreignKeyViolationCount === 0,
      'SQLite integrity or foreign keys failed after restart.');
    assert(afterRestart.providers.total === beforeRestart.providers.total && afterRestart.workflowA.status === 'completed',
      'Provider or Workflow persistence failed after restart.');
    phase = 'step13_wait_persisted_ui_ready';
    const restartScreenshotReady = await waitForRestartScreenshotReady(restartClient, project.name,
      workflowA.taskId, workflowA.id, afterRestart.workflowA.status);
    phase = 'step13_capture_persisted_ui';
    screenshots.push(await screenshot(restartClient, '13-restart-persistence.png'));
    addStep(13, 'Same-profile restart persists configuration and provenance', { firstRunCompleted: true,
      providerCount: afterRestart.providers.total, workflowAStatus: afterRestart.workflowA.status,
      workflowBStatus: afterRestart.workflowB.status, sqliteIntegrity: afterRestart.database.integrity,
      foreignKeyViolationCount: afterRestart.database.foreignKeyViolationCount,
      screenshotReady: { loadingOverlayAbsent: restartScreenshotReady.loadingOverlayCount === 0,
        historyLoadingAbsent: restartScreenshotReady.historyLoadingCount === 0,
        exactProjectTaskVisible: restartScreenshotReady.visibleProjectButtonCount === 1
          && restartScreenshotReady.visibleTaskButtonCount === 1,
        exactCompletedWorkflowVisible: restartScreenshotReady.visibleCurrentWorkflowCount === 1
          && restartScreenshotReady.visibleWorkflowControlsCount === 1
          && restartScreenshotReady.visibleWorkflowPanelCount === 1
          && restartScreenshotReady.selectedWorkflowListItemCount === 1
          && restartScreenshotReady.workflowStatusLeafCount === 1
          && restartScreenshotReady.workflowIdentityLeafCount === 1
          && restartScreenshotReady.authoritativeWorkflowMatch === true } });

    await openSettingsCategory(restartClient, 'Data & Diagnostics');
    const defaultOff = await restartClient.evaluate(`document.querySelector('[data-testid="data-anonymous-performance"]')?.checked === false`);
    assert(defaultOff, 'Anonymous performance data was not default-off.');
    const step14Screenshot = await captureDataSettingsScreenshotMasked(restartClient,
      '14-data-default-off.png', fixture.dataRoot, screenshot, privateProfilePaths);
    screenshots.push(step14Screenshot.screenshot);
    const providerRequestsBeforeOff = aServer.requests.length + bServer.requests.length + deepServer.requests.length;
    const taggedElectron = taggedElectronRoleFact(instance.acceptanceTag, instance.child.pid);
    report.nativeDiagnosticBoundary = { taggedElectron };
    assert(taggedElectron.expectedLaunchPidIsMain && taggedElectron.main === 1 && taggedElectron.taggedRoots >= 1,
      'Expected Electron launch PID was not the unique tagged main process.');
    const offExport = await exportDiagnosticsExact(restartClient, instance.child.pid, false, fixture,
      (value) => { phase = `step14_${value}`; });
    zipCandidates.push(offExport.candidate);
    assertDiagnosticsFacts({
      off: { manifest: { includeAnonymousPerformanceData: offExport.manifest.includeAnonymousPerformanceData }, entryNames: offExport.entryNames },
      on: { manifest: { includeAnonymousPerformanceData: true }, aggregate: {
        schemaVersion: 1,
        operations: { direct: { total: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0 },
          orchestrated: { total: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0 } },
        durationBuckets: { underOneSecond: 0, oneToTenSeconds: 0, tenToSixtySeconds: 0,
          oneToTenMinutes: 0, tenMinutesOrMore: 0 },
      } },
    });
    assert(aServer.requests.length + bServer.requests.length + deepServer.requests.length === providerRequestsBeforeOff,
      'Diagnostics default-off export changed Provider request counts.');
    addStep(14, 'Data default-off native diagnostics export', { defaultOff: true, manifestIncludeAnonymousPerformanceData: false,
      anonymousPerformanceEntryAbsent: true, providerRequestDelta: 0, nativeBinding: {
        expectedPid: true, exactClassAndTitle: true, exactValuePatternEdit: true, knownFolderApi: true, exactIdentityHash: true,
      }, screenshotPrivacy: step14Screenshot.mask });

    phase = 'step15_close_settings_after_default_off_export';
    await closeSettings(restartClient);
    phase = 'step15_reopen_data_settings';
    await openSettingsCategory(restartClient, 'Data & Diagnostics');
    phase = 'step15_assert_reopened_default_off';
    assert(await restartClient.evaluate(`document.querySelector('[data-testid="data-anonymous-performance"]')?.checked === false`),
      'Anonymous performance opt-in persisted without explicit opt-in.');
    phase = 'step15_click_explicit_opt_in';
    await clickExactCheckboxTestId(restartClient, 'data-anonymous-performance');
    phase = 'step15_wait_explicit_opt_in';
    await restartClient.waitFor(`document.querySelector('[data-testid="data-anonymous-performance"]')?.checked === true`,
      { description: 'anonymous performance explicit opt-in' });
    phase = 'step15_capture_opt_in_screenshot';
    const step15Screenshot = await captureDataSettingsScreenshotMasked(restartClient,
      '15-data-opt-in.png', fixture.dataRoot, screenshot, privateProfilePaths);
    screenshots.push(step15Screenshot.screenshot);
    phase = 'step15_prepare_opt_in_export';
    const providerRequestsBeforeOn = aServer.requests.length + bServer.requests.length + deepServer.requests.length;
    const onExport = await exportDiagnosticsExact(restartClient, instance.child.pid, true, fixture,
      (value) => { phase = `step15_${value}`; });
    zipCandidates.push(onExport.candidate);
    assertDiagnosticsFacts({
      off: { manifest: { includeAnonymousPerformanceData: offExport.manifest.includeAnonymousPerformanceData }, entryNames: offExport.entryNames },
      on: { manifest: { includeAnonymousPerformanceData: onExport.manifest.includeAnonymousPerformanceData }, aggregate: onExport.aggregate },
    });
    assert(aServer.requests.length + bServer.requests.length + deepServer.requests.length === providerRequestsBeforeOn,
      'Diagnostics opt-in export changed Provider request counts.');
    const secretValues = [sentinels.providerASecret, sentinels.providerBSecret, sentinels.deepSeekSecret];
    const diagnosticPrivateValues = [offExport.candidate.path, onExport.candidate.path,
      path.basename(offExport.candidate.path), path.basename(onExport.candidate.path), path.dirname(offExport.candidate.path)];
    const postStep15State = createPostStep15State({
      diagnosticCandidateCount: zipCandidates.length,
      tempPreserved: fs.existsSync(fixture.root),
    });
    failureReportPrivacy = createPostStep15FailureReportPrivacy([
      ...secretValues, ...diagnosticPrivateValues, path.join(fixture.dataRoot, 'model-credentials'), 'model-credentials',
    ], privateProfilePaths);
    let acceptanceTag = null;
    let cdpPort = null;
    let credentialFacts = null;
    let restrictedPrivateValues = null;
    let childOutputPrivateGroups = null;
    let retainedPrivateValues = null;
    let retainedFilePrivacy = null;
    let publicDtoCapture = null;
    addStep(15, 'Explicit opt-in native diagnostics export and closed aggregate', { reopenedDefaultOff: true,
      manifestIncludeAnonymousPerformanceData: true, aggregateSchemaVersion: onExport.aggregate.schemaVersion,
      aggregateFields: Object.keys(onExport.aggregate), providerRequestDelta: 0, exactZipIdentityBound: true,
      screenshotPrivacy: step15Screenshot.mask });

    await runPostStep15GateSequence({
      setPhase: (value) => { phase = value; },
      owned_runtime_identity: async () => {
        acceptanceTag = instance?.acceptanceTag;
        cdpPort = instance?.port;
        assert(typeof acceptanceTag === 'string' && /^[0-9a-f-]{36}$/iu.test(acceptanceTag)
          && Number.isSafeInteger(cdpPort) && cdpPort > 0 && cdpPort <= 65_535,
        'Owned post-Step 15 runtime identity is invalid.');
      },
      credential_privacy_facts: async () => {
        credentialFacts = credentialPrivacyFacts(fixture);
        const vaultPrivateValues = [...credentialFacts.references, ...credentialFacts.vaultFileNames,
          path.join(fixture.dataRoot, 'model-credentials'), 'model-credentials'];
        restrictedPrivateValues = [...secretValues, ...diagnosticPrivateValues, ...vaultPrivateValues];
        childOutputPrivateGroups = {
          provider_secret: [...secretValues],
          diagnostic_full: [offExport.candidate.path, onExport.candidate.path],
          diagnostic_basename: [path.basename(offExport.candidate.path), path.basename(onExport.candidate.path)],
          diagnostic_parent: [path.dirname(offExport.candidate.path)],
          credential_ref: [...credentialFacts.references],
          vault_filename: [...credentialFacts.vaultFileNames],
          vault_directory: [path.join(fixture.dataRoot, 'model-credentials'), 'model-credentials'],
          fixture_root: [fixture.root],
          data_root: [fixture.dataRoot],
          real_profile: [fixture.nativeDialogUserProfile],
        };
        retainedPrivateValues = [...restrictedPrivateValues, ...privateProfilePaths];
        extendPostStep15FailureReportPrivacy(failureReportPrivacy,
          [...credentialFacts.references, ...credentialFacts.vaultFileNames]);
      },
      owned_child_arguments_privacy: async () => {
        assert(ownedClaudeChildArguments && authoritativeChildPaths,
          'Owned Claude argument evidence was not retained for the final privacy gate.');
        assertOwnedClaudeChildArgumentsPrivacy(ownedClaudeChildArguments, {
          ...authoritativeChildPaths,
          promptToolName: 'mcp__workbench_permissions__request_permission',
          sensitiveValues: restrictedPrivateValues,
          privateProfilePaths,
        });
      },
      settings_close: async () => {
        await closeSettings(restartClient);
      },
      public_capture: async () => {
        publicDtoCapture = await restartClient.evaluate(`(async () => ({
          providers: await window.api.listModelProviders({ limit: 100, offset: 0 }),
          workflowA: await window.api.getWorkflow(${js(workflowA.id)}),
          workflowB: await window.api.getWorkflow(${js(workflowB.id)}),
          stagesA: await window.api.listWorkflowStages(${js(workflowA.id)}, { limit: 100, offset: 0 }),
          bodyText: document.body.innerText,
        }))()`);
      },
      public_dto_privacy: async () => {
        assertPublicDtoCapturePrivacy(publicDtoCapture, {
          workflowA: { id: workflowA.id, taskId: taskA, projectId: project.id, projectPath: project.path },
          workflowB: { id: workflowB.id, taskId: taskB, projectId: project.id, projectPath: project.path },
        }, restrictedPrivateValues, privateProfilePaths);
      },
      persisted_event_privacy: async () => {
        assertAcceptancePrivacyBoundary(JSON.stringify(credentialFacts.eventPayloads), restrictedPrivateValues,
          privateProfilePaths, 'persisted_event_payload');
      },
      database_file_privacy: async () => {
        const databasePrivateValues = [...secretValues, ...diagnosticPrivateValues, ...credentialFacts.vaultFileNames,
          path.join(fixture.dataRoot, 'model-credentials')];
        scanFilesForSecrets([databasePath(fixture), `${databasePath(fixture)}-wal`, `${databasePath(fixture)}-shm`],
          databasePrivateValues);
      },
      retained_file_privacy: async () => {
        const scanTargets = [SCREENSHOT_ROOT, offExport.candidate.path, onExport.candidate.path,
          offExport.extraction, onExport.extraction];
        retainedFilePrivacy = scanFilesForSecrets(scanTargets, retainedPrivateValues);
      },
      privacy_evidence_initialize: async () => {
        report.privacy = {
          passed: false,
          retainedFilesPassed: retainedFilePrivacy.passed,
          childOutputPassed: false,
          preCleanupRetainedReportPassed: false,
          files: retainedFilePrivacy.files,
          bytes: retainedFilePrivacy.bytes,
          rendererSecretCleared: true,
          rawCredentialsAbsent: true,
          opaqueCredentialRefsAbsentOutsideIntendedSqliteColumn: true,
          vaultNamesAbsent: true,
          diagnosticFilenameAndPathAbsent: true,
          childArgumentsScanned: true,
          ownedElectronInstancesOutputScanned: 0,
          rendererAndPublicDtosScanned: true,
          visibleDomTextPathRestricted: true,
          nonWorkflowPublicDtosPathRestricted: true,
          workflowProjectPathProjectedAfterIdentityValidation: true,
          logsEventsAndDatabaseScanned: true,
          diagnosticsPathsStored: false,
          dataScreenshotsUsedScopedDomOnlyMask: true,
          dataScreenshotOriginalPathRestored: true,
          fixtureAndRealProfilePathVariantsScanned: true,
          pathRestrictedBoundaries: ['retained_report', 'owned_child_arguments', 'child_output',
            'artifact_metadata', 'screenshot_dom', 'public_workflow_dto', 'public_non_workflow_dto'],
          publicWorkflowDtoProjectPathAllowedByContract: true,
          sqliteCredentialPolicy: 'opaque credential reference only',
        };
      },
      request_evidence: async () => {
        report.requestEvidence = {
          providerA: { total: aServer.requests.length,
            stageMessages: aServer.requests.filter((item) => item.kind === 'messages').length },
          providerB: { total: bServer.requests.length,
            stageMessages: bServer.requests.filter((item) => item.kind === 'messages').length },
          deepSeek: { total: deepServer.requests.length,
            modelDiscovery: deepServer.requests.filter((item) => item.kind === 'models').length,
            stageOrChat: deepServer.requests.filter((item) => item.kind === 'chat').length },
        };
        assert(report.requestEvidence.deepSeek.stageOrChat === 0,
          'DeepSeek received an Agent-stage or chat request.');
      },
      artifact_build: async () => {
        const buildFiles = [path.join(WORKSPACE_ROOT, 'dist', 'main', 'index.js'),
          path.join(WORKSPACE_ROOT, 'dist', 'preload', 'index.js')];
        const rendererFiles = fs.readdirSync(path.join(WORKSPACE_ROOT, 'dist', 'renderer', 'assets'))
          .map((name) => path.join(WORKSPACE_ROOT, 'dist', 'renderer', 'assets', name))
          .filter((target) => fs.lstatSync(target).isFile());
        report.artifacts = {
          script: sha256File(fileURLToPath(import.meta.url)),
          package: sha256File(path.join(WORKSPACE_ROOT, 'package.json')),
          production: [...buildFiles, ...rendererFiles].map((target) => ({
            file: path.relative(WORKSPACE_ROOT, target).replace(/\\/gu, '/'), sha256: sha256File(target),
          })),
          screenshots,
          diagnostics: [
            { includeAnonymousPerformanceData: false, sha256: offExport.identity.sha256,
              bytes: offExport.identity.size },
            { includeAnonymousPerformanceData: true, sha256: onExport.identity.sha256,
              bytes: onExport.identity.size },
          ],
        };
      },
      artifact_metadata_privacy: async () => {
        assertAcceptancePrivacyBoundary(JSON.stringify(report.artifacts), restrictedPrivateValues, privateProfilePaths,
          'artifact_metadata');
      },
      electron_stop_close_drain: async (state) => {
        await stopAndRecordPostStep15Electron(state, instance, ownedElectronOutputBuffers);
        instance = null;
      },
      electron_output_cardinality: async (state) => {
        assert(state.outputStreamCount === 4,
          'Output from both owned Electron instances was not retained as complete stdout/stderr streams.');
      },
      child_output_privacy: async (state) => {
        assert(childOutputPrivateGroups, 'Child-output private-match groups were not initialized.');
        const match = scanChildOutputPrivateMatches(ownedElectronOutputBuffers, childOutputPrivateGroups);
        if (recordChildOutputPrivateMatch(state, match)) {
          throw new Error('Owned Electron output failed the closed privacy match gate.');
        }
        for (let index = 0; index < ownedElectronOutputBuffers.length; index += 1) {
          state.childOutputStreamIndex = index;
          assertAcceptancePrivacyBoundary(ownedElectronOutputBuffers[index], restrictedPrivateValues,
            privateProfilePaths, 'child_output');
          state.outputStreamsScanned = index + 1;
        }
        state.childOutputStreamIndex = null;
        markPostStep15ChildOutputPrivacyPassed(report.privacy, 2);
      },
      retained_report_pre_cleanup: async () => {
        report.status = 'passed';
        assert(report.steps.length === 15 && report.steps.every((step) => step.status === 'passed'),
          'Fifteen-step acceptance did not complete.');
        assertAcceptancePrivacyBoundary(JSON.stringify(report), restrictedPrivateValues, privateProfilePaths,
          'retained_report');
        markPostStep15PreCleanupRetainedReportPrivacyPassed(report.privacy);
      },
      loopback_close_a: async (state) => {
        await aServer.close(); aServer = null; state.loopbackClosedCount += 1;
      },
      loopback_close_b: async (state) => {
        await bServer.close(); bServer = null; state.loopbackClosedCount += 1;
      },
      loopback_close_deepseek: async (state) => {
        await deepServer.close(); deepServer = null; state.loopbackClosedCount += 1;
      },
      diagnostics_delete: async (state) => {
        for (const candidate of zipCandidates) {
          deleteBoundFile(candidate);
          state.diagnosticDeletedCount += 1;
        }
      },
      owned_process_listener_zero: async (state) => {
        const taggedRemaining = acceptanceTaggedProcessCount(acceptanceTag);
        state.taggedCount = closedPostStep15ObservedCount(taggedRemaining);
        const listenerRemaining = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive',
          '-WindowStyle', 'Hidden', '-Command',
        `@(Get-NetTCPConnection -LocalPort ${cdpPort} -State Listen -ErrorAction SilentlyContinue).Count`], {
          encoding: 'utf8', windowsHide: true, shell: false,
        });
        const listenerCount = Number(listenerRemaining.stdout.trim() || '0');
        state.listenerCount = closedPostStep15ObservedCount(listenerCount);
        assert(state.taggedCount === 0 && state.listenerCount === 0,
          'Owned process or CDP listener remained after cleanup.');
      },
      owned_temp_remove: async (state) => {
        state.tempRemoveAttempted = !options.keepTemp;
        if (!options.keepTemp) safeRemoveFixture(fixture.root);
        state.tempPreserved = fs.existsSync(fixture.root);
      },
      retained_report_final: async () => {
        report.cleanup = { electronAndClaudeTrees: 'stopped with PID/start-time revalidation', loopbackListeners: 0,
          cdpListeners: 0, acceptanceTaggedProcesses: 0, nativeDialogs: 0, boundDiagnosticsZips: 0,
          ownedTempRoots: options.keepTemp ? 1 : 0, screenshotsRetainedAsEvidence: true };
        assertAcceptancePrivacyBoundary(JSON.stringify(report), restrictedPrivateValues, privateProfilePaths,
          'retained_report');
        markPostStep15FinalRetainedReportPrivacyPassed(report.privacy);
      },
      report_write: async () => {
        fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      },
    }, postStep15State);
    return report;
  } catch (error) {
    failure = error;
    report.status = 'failed';
    report.failure = { category: 'acceptance_assertion_failed', phase, completedSteps: report.steps.length };
    if (error?.postStep15) report.failure.postStep15 = closedPostStep15FailureFact(error.postStep15);
    if (step7TaskId && step7WorkflowId && report.steps.length === 6) {
      const countMessages = (server) => (server?.requests ?? []).filter((item) => item.kind === 'messages').length;
      const requestDelta = step7RequestBaseline ? closedStep7RequestDeltaFact({
        providerA: countMessages(aServer) - step7RequestBaseline.providerA,
        providerB: countMessages(bServer) - step7RequestBaseline.providerB,
      }) : { providerA: 0, providerB: 0 };
      let persistence = null;
      try { persistence = closedFailureDatabaseEvidence(fixture, step7TaskId); }
      catch { persistence = { workflowStatus: null, currentStage: null, failureCode: 'unknown',
        steps: [], events: [], childTerminal: null }; }
      report.failure.step7 = {
        plan: validateClosedStep7PlanFact(step7LastPlanFact),
        ui: validateClosedStep7UiFact(step7LastUiFact),
        requestDelta,
        persistence,
        errorType: closedErrorType(error),
      };
    }
    if (error?.nativeWindowDiscovery) report.failure.nativeWindowDiscovery = closedNativeWindowDiscoveryFact(error.nativeWindowDiscovery);
    if (error?.nativeControlDiscovery) report.failure.nativeControlDiscovery = closedNativeControlDiscoveryFact(error.nativeControlDiscovery);
    if (error?.nativeControlIdDiscovery) report.failure.nativeControlIdDiscovery = closedNativeControlIdDiscoveryFact(error.nativeControlIdDiscovery);
    if (error?.nativeJointControlDiscovery) report.failure.nativeJointControlDiscovery = closedNativeJointControlDiscoveryFact(error.nativeJointControlDiscovery);
    if (error?.nativeWin32JointDiscovery) report.failure.nativeWin32JointDiscovery = closedNativeWin32JointDiscoveryFact(error.nativeWin32JointDiscovery);
    if (error?.nativeBoundedTextDiscovery) report.failure.nativeBoundedTextDiscovery = closedNativeBoundedTextDiscoveryFact(error.nativeBoundedTextDiscovery);
    if (error?.archiveInspectionFailure) report.failure.archiveInspectionFailure = closedArchiveInspectionFailureFact(error.archiveInspectionFailure);
    if (error?.nativeFailureCleanup) report.failure.nativeFailureCleanup = closedNativeFailureCleanupFact(error.nativeFailureCleanup);
    throw error;
  } finally {
    if (failure) {
      const cleanupFailures = createCleanupFailureCollector();
      if (instance) { try { await runIndependentDialogCleanup(instance.child.pid); } catch { cleanupFailures.add('native_dialog'); } }
      if (instance) {
        try { await stopAndRetainOwnedElectron(instance, ownedElectronOutputBuffers); instance = null; }
        catch { cleanupFailures.add('electron_tree'); }
      }
      if (aServer) { try { await aServer.close(); } catch { cleanupFailures.add('provider_a_listener'); } }
      if (bServer) { try { await bServer.close(); } catch { cleanupFailures.add('provider_b_listener'); } }
      if (deepServer) { try { await deepServer.close(); } catch { cleanupFailures.add('deepseek_listener'); } }
      for (const candidate of zipCandidates) {
        try { if (fs.existsSync(candidate.path)) deleteBoundFile(candidate); } catch { cleanupFailures.add('bound_diagnostics_identity'); }
      }
      if (!options.keepTemp && fs.existsSync(fixture.root)) {
        try { safeRemoveFixture(fixture.root); } catch { cleanupFailures.add('owned_temp_root'); }
      }
      report.cleanup = { failureCategories: cleanupFailures.values(), ownedTempPreserved: fs.existsSync(fixture.root) };
      fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
      const serialized = report.failure?.postStep15 && failureReportPrivacy
        ? serializeFailureReportSafely(report, failureReportPrivacy.sensitiveValues,
          failureReportPrivacy.privatePathValues)
        : JSON.stringify(report, null, 2);
      fs.writeFileSync(REPORT_PATH, `${serialized}\n`, 'utf8');
    }
  }
}

async function runSelfTest() {
  const tests = [];
  const test = (name, body) => tests.push({ name, body });
  const expectThrow = (body, pattern) => {
    let thrown = null;
    try { body(); } catch (error) { thrown = error; }
    assert(thrown instanceof Error, 'Expected the unsafe variant to be rejected.');
    if (pattern) assert(pattern.test(thrown.message), `Unexpected rejection: ${thrown.message}`);
  };

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `${TEMP_PREFIX}self-test-`));
  const workspace = path.join(scratch, 'workspace');
  const dist = path.join(workspace, 'dist');
  const exactScreenshots = path.join(dist, 'beta-readiness-acceptance-screenshots');
  fs.mkdirSync(exactScreenshots, { recursive: true });
  const nativeRecoveryCandidate = (documents, filename, expectedPid = 101) => ({
    expectedPid, knownFolderSource: 'SHGetKnownFolderPath(FOLDERID_Documents)', targetExisted: false,
    documents, target: path.join(documents, filename), filename,
    dialogs: [{ pid: expectedPid, hwnd: 7, className: '#32770', title: DIAGNOSTICS_TITLE, visible: true,
      editControls: [{ pid: expectedPid, hwnd: 8, controlId: 1001, nativeClass: 'Edit', visible: true,
        enabled: true, contained: true, preRevalidated: true, boundedTextRead: true, postRevalidated: true,
        beforeActionRevalidated: true, targetAbsent: true, value: filename }],
      saveControls: [{ pid: expectedPid, hwnd: 9, controlId: 1, nativeClass: 'Button', visible: true,
        enabled: true, contained: true, nativeText: 'Save', preRevalidated: true,
        beforeActionRevalidated: true }] }],
  });

  test('accepts only the exact fixed screenshot root and rejects a reparse root', () => {
    assert(validateScreenshotRoot(workspace, exactScreenshots) === true, 'Exact screenshot root was rejected.');
    expectThrow(() => validateScreenshotRoot(workspace, path.join(dist, 'other-screenshots')));
    const realDirectory = path.join(scratch, 'real-screenshots');
    const linkedWorkspace = path.join(scratch, 'linked-workspace');
    fs.mkdirSync(realDirectory);
    fs.mkdirSync(path.join(linkedWorkspace, 'dist'), { recursive: true });
    const linkedRoot = path.join(linkedWorkspace, 'dist', 'beta-readiness-acceptance-screenshots');
    fs.symlinkSync(realDirectory, linkedRoot, 'junction');
    expectThrow(() => validateScreenshotRoot(linkedWorkspace, linkedRoot), /reparse|symbolic|ordinary/iu);
  });

  test('recursive deletion is limited to the exact owned screenshot root', () => {
    const owned = path.join(workspace, 'dist', 'beta-readiness-acceptance-screenshots');
    const outside = path.join(workspace, 'do-not-delete');
    fs.writeFileSync(path.join(owned, 'owned.txt'), 'owned', 'utf8');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep', 'utf8');
    assert(removeScreenshotRoot(workspace, owned) === true, 'Exact screenshot cleanup did not run.');
    assert(!fs.existsSync(owned), 'Exact screenshot root remains after cleanup.');
    expectThrow(() => removeScreenshotRoot(workspace, outside));
    assert(fs.existsSync(path.join(outside, 'keep.txt')), 'Out-of-scope directory was deleted.');
  });

  test('fresh fixture owns distinct empty Workbench, Chromium, and Claude roots', () => {
    const fixture = createIsolatedFixture(scratch);
    assert(fixture && new Set([fixture.dataRoot, fixture.browserRoot, fixture.claudeConfigRoot]).size === 3,
      'Fresh roots are missing or overlap.');
    for (const root of [fixture.dataRoot, fixture.browserRoot, fixture.claudeConfigRoot]) {
      assert(root.startsWith(`${fixture.root}${path.sep}`), 'Fresh root escaped the owned temp fixture.');
      assert(fs.readdirSync(root).length === 0, 'Fresh root was not empty.');
    }
  });

  test('binds diagnostics to the production database filename and closed workflow failure codes', () => {
    assert(databasePath({ dataRoot: scratch }) === path.join(scratch, 'claude-workbench.db'));
    assert(closedWorkflowFailureCode('AGENT_STAGE_FAILED') === 'AGENT_STAGE_FAILED');
    assert(closedWorkflowFailureCode('INVALID_STRUCTURED_OUTPUT') === 'INVALID_STRUCTURED_OUTPUT');
    assert(closedWorkflowFailureCode('raw secret-bearing text') === 'unknown');
  });

  test('explicit diagnostics opt-in clicks only the exact enabled checkbox test id', async () => {
    const checkbox = {
      checked: false,
      disabled: false,
      matches: (selector) => selector === 'input[type="checkbox"]',
      click() { this.checked = !this.checked; },
    };
    const document = {
      querySelector: (selector) => selector === '[data-testid="data-anonymous-performance"]' ? checkbox : null,
    };
    const client = {
      evaluate: async (source) => Function('document', `"use strict"; return (${source});`)(document),
    };
    await clickExactCheckboxTestId(client, 'data-anonymous-performance');
    assert(checkbox.checked === true, 'Exact diagnostics checkbox was not clicked.');
    checkbox.disabled = true;
    let rejected = false;
    try { await clickExactCheckboxTestId(client, 'data-anonymous-performance'); } catch { rejected = true; }
    assert(rejected && checkbox.checked === true, 'Disabled diagnostics checkbox was clicked.');
    checkbox.disabled = false;
    checkbox.matches = () => false;
    rejected = false;
    try { await clickExactCheckboxTestId(client, 'data-anonymous-performance'); } catch { rejected = true; }
    assert(rejected && checkbox.checked === true, 'Non-checkbox control was clicked as diagnostics opt-in.');
  });

  test('Data screenshots mask only the exact path display and restore it on success or capture failure', async () => {
    const original = 'C:\\Users\\private-profile\\Temp\\owned-fixture\\workbench-data';
    const attributes = new Map();
    const pathDisplay = {
      children: [], textContent: original,
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: (name) => attributes.delete(name),
    };
    const checkbox = { matches: (selector) => selector === 'input[type="checkbox"]' };
    const content = {
      querySelectorAll: (selector) => {
        if (selector === 'div') return [pathDisplay];
        if (selector === '[data-testid="data-anonymous-performance"]') return [checkbox];
        if (selector === '[data-cw-beta-screenshot-mask="data-storage-path"]') {
          return attributes.get('data-cw-beta-screenshot-mask') === 'data-storage-path' ? [pathDisplay] : [];
        }
        return [];
      },
    };
    const dialog = {
      querySelectorAll: (selector) => selector === '[data-testid="settings-content"]' ? [content] : [],
    };
    const document = {
      body: { innerText: '' },
      querySelectorAll: (selector) => selector === '[role="dialog"][aria-labelledby="settings-dialog-title"]' ? [dialog] : [],
    };
    const client = {
      evaluate: async (source) => Function('document', `"use strict"; return (${source});`)(document),
    };
    const captured = await captureDataSettingsScreenshotMasked(client, 'masked.png', original, async () => {
      assert(pathDisplay.textContent === '[private data path hidden for screenshot]'
        && attributes.get('data-cw-beta-screenshot-mask') === 'data-storage-path',
      'Data path privacy mask was not active during capture.');
      return { file: 'masked.png' };
    });
    assert(captured.screenshot.file === 'masked.png' && captured.mask.activeAtCapture && captured.mask.originalRestored
      && captured.mask.privatePathVariantsAbsentAtCapture,
      'Successful masked screenshot did not return closed mask evidence.');
    assert(pathDisplay.textContent === original && attributes.size === 0,
      'Data path was not restored after successful screenshot capture.');
    let rejected = false;
    try {
      await captureDataSettingsScreenshotMasked(client, 'failed.png', original, async () => {
        assert(pathDisplay.textContent === '[private data path hidden for screenshot]',
          'Data path privacy mask was not active during failed capture.');
        throw new Error('fixed test capture failure');
      });
    } catch { rejected = true; }
    assert(rejected && pathDisplay.textContent === original && attributes.size === 0,
      'Data path was not restored in the screenshot failure path.');
    document.body.innerText = `Background path leak: ${original}`;
    let captureCalled = false;
    rejected = false;
    try {
      await captureDataSettingsScreenshotMasked(client, 'background-leak.png', original, async () => {
        captureCalled = true;
        return { file: 'background-leak.png' };
      });
    } catch { rejected = true; }
    assert(rejected && !captureCalled && pathDisplay.textContent === original && attributes.size === 0,
      'Whole-viewport DOM path leak was not rejected before screenshot capture and restored.');
    document.body.innerText = '';
  });

  test('textual privacy paths include fixture, data-root, and real-profile separator and JSON variants', () => {
    const fixtureRoot = 'C:\\Users\\private-profile\\Temp\\fixture-root';
    const dataRoot = `${fixtureRoot}\\workbench-data`;
    const realProfile = 'C:\\Users\\private-profile';
    const variants = privatePathTextVariants([fixtureRoot, dataRoot, realProfile]);
    for (const expected of [fixtureRoot, fixtureRoot.replace(/\\/gu, '/'), JSON.stringify(fixtureRoot).slice(1, -1),
      dataRoot, dataRoot.replace(/\\/gu, '/'), realProfile, realProfile.toLocaleLowerCase('en-US')]) {
      assert(variants.includes(expected), `Private path scan variant is missing: ${expected}`);
    }
    expectThrow(() => assertPrivateValuesAbsent(`safe-prefix ${JSON.stringify(dataRoot).slice(1, -1)} safe-suffix`,
      variants, 'private path variant fixture'));
  });

  test('privacy routing rejects unprojected Workflow paths and all retained and child boundary paths', () => {
    const fixtureRoot = 'C:\\Users\\private-profile\\Temp\\fixture-root';
    const paths = privatePathTextVariants([fixtureRoot]);
    const sensitive = ['private-secret'];
    const publicWorkflow = JSON.stringify({ id: 'workflow-a', projectPath: fixtureRoot, status: 'completed' });
    expectThrow(() => assertAcceptancePrivacyBoundary(publicWorkflow, sensitive, paths, 'public_workflow_dto'));
    assert(assertAcceptancePrivacyBoundary(JSON.stringify({ id: 'workflow-a', status: 'completed' }), sensitive, paths,
      'public_workflow_dto') === true, 'Path-free public Workflow projection was rejected.');
    expectThrow(() => assertAcceptancePrivacyBoundary(`${publicWorkflow} private-secret`, sensitive, paths,
      'public_workflow_dto'));
    for (const boundary of ['retained_report', 'task_report', 'owned_child_arguments', 'child_output',
      'artifact_metadata', 'screenshot_dom', 'public_non_workflow_dto']) {
      expectThrow(() => assertAcceptancePrivacyBoundary(`fixed ${fixtureRoot} fixed`, sensitive, paths, boundary));
    }
    expectThrow(() => assertAcceptancePrivacyBoundary('safe', sensitive, paths, 'unknown_boundary'));
  });

  test('mixed public capture permits only validated Workflow projectPath leaves and restricts DOM and other DTOs', () => {
    const fixtureRoot = 'C:\\Users\\private-profile\\Temp\\fixture-root';
    const paths = privatePathTextVariants([fixtureRoot]);
    const workflow = (id, taskId) => ({
      id, taskId, projectId: 'project-1', projectPath: fixtureRoot, prompt: 'safe prompt', status: 'completed',
      currentStage: null, activeStage: null, modelPolicy: {}, plan: null, latestReview: null,
      reviewRound: 0, maxReviewRounds: 2,
      fixRound: 0, maxFixRounds: 2, revision: 3, pausedFrom: null, failure: null,
      createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:01.000Z',
    });
    const workflowA = workflow('workflow-a', 'task-a');
    const workflowB = workflow('workflow-b', 'task-b');
    const expected = {
      workflowA: { id: 'workflow-a', taskId: 'task-a', projectId: 'project-1', projectPath: fixtureRoot },
      workflowB: { id: 'workflow-b', taskId: 'task-b', projectId: 'project-1', projectPath: fixtureRoot },
    };
    const capture = { providers: { items: [], total: 0 }, workflowA, workflowB,
      stagesA: { items: [], total: 0 }, bodyText: 'safe visible viewport' };
    assert(assertPublicDtoCapturePrivacy(capture, expected, ['private-secret'], paths) === true,
      'Validated Workflow projectPath leaves were rejected from the mixed public capture.');
    for (const unsafe of [
      { ...capture, bodyText: `visible ${fixtureRoot}` },
      { ...capture, providers: { items: [{ baseUrl: fixtureRoot }], total: 1 } },
      { ...capture, stagesA: { items: [{ output: fixtureRoot }], total: 1 } },
      { ...capture, workflowA: { ...workflowA, prompt: fixtureRoot } },
      { ...capture, workflowB: { ...workflowB, projectPath: `${fixtureRoot}\\rogue` } },
      { ...capture, workflowB: { ...workflowB, prompt: 'private-secret' } },
    ]) expectThrow(() => assertPublicDtoCapturePrivacy(unsafe, expected, ['private-secret'], paths));
    expectThrow(() => assertAcceptancePrivacyBoundary(JSON.stringify(workflowA), ['private-secret'], paths,
      'public_workflow_dto'));
  });

  test('closes Step 7 plan and Provider request facts and rejects terminal, raw, or negative evidence', () => {
    const workflow = { id: 'workflow-a', taskId: 'task-a', status: 'waiting_plan_confirmation',
      currentStage: null, activeStage: null, plan: { steps: [] }, failure: null };
    const fact = closedStep7PlanResultFact(workflow, { workflowId: 'workflow-a', taskId: 'task-a' });
    assert(JSON.stringify(fact) === JSON.stringify({ identityMatch: true, status: 'waiting_plan_confirmation',
      currentStage: null, activeStage: null, hasPlan: true, failureCode: 'unknown' })
      && assertStep7PlanReadyFact(fact) === true,
    'Valid closed Step 7 plan result was rejected.');
    expectThrow(() => assertStep7PlanReadyFact({ ...fact, rawPath: 'C:\\private' }));
    expectThrow(() => assertStep7PlanReadyFact({ ...fact, identityMatch: false }));
    expectThrow(() => assertStep7PlanReadyFact({ ...fact, status: 'failed', hasPlan: false,
      failureCode: 'AGENT_STAGE_FAILED' }));
    assert(JSON.stringify(closedStep7RequestDeltaFact({ providerA: 1, providerB: 0 }))
      === JSON.stringify({ providerA: 1, providerB: 0 }), 'Valid Step 7 Provider delta was rejected.');
    expectThrow(() => closedStep7RequestDeltaFact({ providerA: -1, providerB: 0 }));
    expectThrow(() => closedStep7RequestDeltaFact({ providerA: 0, providerB: 0, rawRequest: {} }));
  });

  test('Step 7 UI fact requires exact current task, selected Workflow A panel, Plan tab, and one enabled start button', () => {
    const ready = { taskCurrentVisibleUnique: true, workflowListItemVisibleUnique: true,
      workflowListItemAriaCurrent: true, workflowPanelVisibleUnique: true, planTabSelectedUnique: true,
      startButtonCount: 1, enabledStartButtonCount: 1 };
    assert(assertStep7UiReadyFact(ready) === true, 'Valid closed Step 7 UI identity was rejected.');
    for (const unsafe of [
      { ...ready, taskCurrentVisibleUnique: false }, { ...ready, workflowListItemVisibleUnique: false },
      { ...ready, workflowListItemAriaCurrent: false }, { ...ready, workflowPanelVisibleUnique: false },
      { ...ready, planTabSelectedUnique: false }, { ...ready, startButtonCount: 0, enabledStartButtonCount: 0 },
      { ...ready, startButtonCount: 1, enabledStartButtonCount: 0 },
      { ...ready, startButtonCount: 2, enabledStartButtonCount: 2 }, { ...ready, rawText: 'private prompt' },
    ]) expectThrow(() => assertStep7UiReadyFact(unsafe));
  });

  test('Step 7 DOM selector clicks only the exact task-bound selected Workflow A Plan control', () => {
    const taskId = 'task-a'; const workflowId = 'workflow-a';
    const buildDom = ({ task = taskId, workflow = workflowId, disabled = false, buttonCount = 1 } = {}) => {
      let clicks = 0;
      const node = (input = {}) => ({ children: [], disabled: false, style: {},
        getBoundingClientRect: () => ({ width: 100, height: 20 }), getAttribute: () => null,
        querySelectorAll: () => [], click: () => { clicks += 1; }, ...input });
      const taskButton = node({ style: { backgroundColor: 'var(--bg-active)' },
        getAttribute: (name) => name === 'data-session-key' ? `scope::${task}` : null });
      const workflowItem = node({ getAttribute: (name) => name === 'data-workflow-id' ? workflow
        : name === 'aria-current' ? 'true' : null });
      const planTab = node({ getAttribute: (name) => name === 'aria-selected' ? 'true'
        : name === 'data-tab' ? 'plan' : null });
      const buttons = Array.from({ length: buttonCount }, () => node({ disabled }));
      const panel = node({ querySelectorAll: (selector) => {
        if (selector === '[data-testid="workflow-list-item"]') return [workflowItem];
        if (selector === '[data-testid="workflow-tab"][data-tab="plan"]') return [planTab];
        if (selector === '[data-testid="workflow-start-execution"]') return buttons;
        return [];
      } });
      const current = node({ querySelectorAll: (selector) => selector === '[data-testid="workflow-panel"]'
        ? [panel] : [] });
      const document = { querySelectorAll: (selector) => selector === '[data-session-key]' ? [taskButton]
        : selector === '[data-testid="current-workflow"]' ? [current] : [] };
      return { document, clicks: () => clicks };
    };
    const evaluate = (dom, expression) => Function('document', 'getComputedStyle',
      `"use strict"; return (${expression});`)(dom.document, () => ({ display: 'block', visibility: 'visible' }));
    const valid = buildDom();
    const validFact = evaluate(valid, step7UiIdentityFactExpression(taskId, workflowId));
    assert(assertStep7UiReadyFact(validFact) === true
      && evaluate(valid, step7ExactStartClickExpression(taskId, workflowId)) === true && valid.clicks() === 1,
    'Exact Step 7 DOM identity did not produce one bounded click.');
    for (const unsafe of [buildDom({ task: 'wrong-task' }), buildDom({ workflow: 'wrong-workflow' }),
      buildDom({ buttonCount: 0 }), buildDom({ disabled: true }), buildDom({ buttonCount: 2 })]) {
      expectThrow(() => assertStep7UiReadyFact(evaluate(unsafe, step7UiIdentityFactExpression(taskId, workflowId))));
      assert(evaluate(unsafe, step7ExactStartClickExpression(taskId, workflowId)) === false
        && unsafe.clicks() === 0, 'Unsafe Step 7 DOM identity clicked a control.');
    }
  });

  test('Step 7 phase runner is exact and terminal plan results stop before UI polling or click', async () => {
    const phases = []; const calls = [];
    const operations = {
      setPhase: (value) => phases.push(value), planCall: async () => { calls.push('planCall'); return 'planned'; },
      planResult: async (value) => { assert(value === 'planned'); calls.push('planResult'); },
      uiIdentityWait: async () => { calls.push('uiIdentityWait'); },
      clickStart: async () => { calls.push('clickStart'); }, waitExecuting: async () => { calls.push('waitExecuting'); },
      waitProviderBHold: async () => { calls.push('waitProviderBHold'); },
      childArgv: async () => { calls.push('childArgv'); }, switchBlock: async () => { calls.push('switchBlock'); },
    };
    await runStep7PhaseSequence(operations);
    assert(JSON.stringify(phases) === JSON.stringify(['step7_plan_call', 'plan_result',
      'ui_identity_wait', 'click_start', 'wait_executing', 'wait_provider_b_hold', 'child_argv', 'switch_block'])
      && JSON.stringify(calls) === JSON.stringify(['planCall', 'planResult', 'uiIdentityWait', 'clickStart',
        'waitExecuting', 'waitProviderBHold', 'childArgv', 'switchBlock']),
    'Step 7 diagnostic phases were missing, reordered, or duplicated.');

    const stopped = [];
    let terminalFailure = null;
    try {
      await runStep7PhaseSequence({ ...operations, setPhase: (value) => stopped.push(value),
        planResult: async () => assertStep7PlanReadyFact({ identityMatch: true, status: 'failed',
          currentStage: null, activeStage: null, hasPlan: false, failureCode: 'AGENT_STAGE_FAILED' }) });
    } catch (error) { terminalFailure = error; }
    assert(terminalFailure instanceof Error
      && JSON.stringify(stopped) === JSON.stringify(['step7_plan_call', 'plan_result']),
    'Terminal Step 7 plan result polled or clicked after fail-fast.');
  });

  test('retains and scans output from every owned Electron instance', () => {
    const fixtureRoot = 'C:\\Users\\private-profile\\Temp\\fixture-root';
    const splitAt = Math.floor(fixtureRoot.length / 2);
    const retained = [];
    retainOwnedElectronOutputBuffers(retained, {
      stdout: [Buffer.from(`first-instance ${fixtureRoot.slice(0, splitAt)}`, 'utf8'),
        Buffer.from(fixtureRoot.slice(splitAt), 'utf8')],
      stderr: [Buffer.from('first-instance-stderr', 'utf8')],
    });
    retainOwnedElectronOutputBuffers(retained, {
      stdout: [Buffer.from('second-instance-stdout', 'utf8')],
      stderr: [Buffer.from('second-instance-stderr', 'utf8')],
    });
    assert(retained.length === 4
      && retained.some((buffer) => buffer.equals(Buffer.from(`first-instance ${fixtureRoot}`, 'utf8')))
      && retained.some((buffer) => buffer.equals(Buffer.from('second-instance-stderr', 'utf8'))),
    'Owned Electron output from both instances was not retained exactly.');
    const paths = privatePathTextVariants([fixtureRoot]);
    expectThrow(() => {
      for (const buffer of retained) assertAcceptancePrivacyBoundary(buffer, [], paths, 'child_output');
    });
  });

  test('stopElectron waits for output-drained close before retaining late split output', async () => {
    const child = new EventEmitter();
    Object.assign(child, { pid: 701, exitCode: 0, signalCode: null });
    const stdout = [];
    const instance = { child, stdout, stderr: [], startTicks: '70100',
      client: { close: async () => undefined }, outputClosed: bindElectronOutputClose(child) };
    setTimeout(() => {
      child.emit('exit', 0, null);
      stdout.push(Buffer.from('late-private-', 'utf8'), Buffer.from('path', 'utf8'));
      child.emit('close', 0, null);
    }, 10);

    await stopElectron(instance, { closeTimeoutMs: 250 });
    const retained = [];
    retainOwnedElectronOutputBuffers(retained, instance);
    assert(retained[0].equals(Buffer.from('late-private-path', 'utf8')),
      'Electron output was retained before the child close drained late split output.');
  });

  test('stopElectron rejects tree-kill failure and output-close timeout without retaining output', async () => {
    const makeInstance = () => {
      const child = new EventEmitter();
      Object.assign(child, { pid: 702, exitCode: null, signalCode: null });
      return { child, stdout: [Buffer.from('before-stop', 'utf8')], stderr: [], startTicks: '70200',
        client: { close: async () => undefined }, outputClosed: bindElectronOutputClose(child) };
    };
    const retained = [];
    let failure = null;
    const killFailure = makeInstance();
    try {
      await stopElectron(killFailure, { closeTimeoutMs: 25, readStartTicks: () => '70200',
        terminateTree: () => ({ status: 1, error: null }) });
    } catch (error) { failure = error; }
    assert(failure?.message === 'Electron tree termination failed.' && retained.length === 0,
      'Tree-kill failure did not fail closed before output retention.');

    failure = null;
    const closeTimeout = makeInstance();
    try {
      await stopElectron(closeTimeout, { closeTimeoutMs: 25, readStartTicks: () => '70200',
        terminateTree: () => ({ status: 0, error: null }) });
    } catch (error) { failure = error; }
    assert(failure?.message === 'Electron output close confirmation timed out.' && retained.length === 0,
      'Output-close timeout did not fail closed before output retention.');
  });

  test('transfers preliminary Electron ownership before start identity binding and preserves failed setup for retry', async () => {
    const executablePath = 'C:\\Program Files\\Electron\\electron.exe';
    const acceptanceTag = '00000000-0000-4000-8000-000000000703';
    const child = new EventEmitter();
    Object.assign(child, { pid: 703, exitCode: null, signalCode: null });
    const owned = { stdout: [Buffer.from('first-', 'utf8')], stderr: [], child, client: null,
      outputClosed: Promise.resolve({ code: 0, signal: null }), startTicks: null, acceptanceTag, executablePath };
    const retained = [];
    const order = [];
    let outerInstance = null;
    let failure = null;
    try {
      await runOwnedElectronLaunchReadiness(owned,
        (instance) => { outerInstance = instance; order.push('transfer'); },
        async () => { order.push('readiness'); return owned; },
        async () => { order.push('first-stop'); throw new Error('fixed first stop failure'); },
        () => { order.push('bind-identity'); throw new Error('fixed start identity failure'); });
    } catch (error) { failure = error; }
    assert(failure?.message === 'fixed first stop failure' && outerInstance === owned
      && JSON.stringify(order) === JSON.stringify(['transfer', 'bind-identity', 'first-stop'])
      && owned.startTicks === null,
    'Start-identity failure occurred before preliminary ownership transfer or escaped retry ownership.');

    await stopAndRetainOwnedElectron(outerInstance, retained, async (instance) => {
      const stopped = await stopElectron(instance, { closeTimeoutMs: 50,
        readProcessIdentity: () => ({ pid: 703, startTicks: '70300', executablePath,
          commandLine: `"${executablePath}" --cw-beta-acceptance=${acceptanceTag}` }),
        tokenize: (commandLine) => [executablePath, commandLine.split(' ').at(-1)],
        terminateTree: () => ({ status: 0, error: null }),
      });
      assert(stopped === true && instance.startTicks === '70300',
        'Preliminary Electron identity was not safely rebound for cleanup.');
      instance.stdout.push(Buffer.from('late-output', 'utf8'));
      return true;
    });
    assert(retained[0].equals(Buffer.from('first-late-output', 'utf8')),
      'Preliminary-owned Electron output was not retained after exact cleanup retry.');
    outerInstance = null;
    assert(outerInstance === null, 'Preliminary Electron ownership was released before complete retention.');
  });

  test('Electron process identity rebind requires exact PID executable and unique acceptance tag token', () => {
    const executablePath = 'C:\\Program Files\\Electron\\electron.exe';
    const acceptanceTag = '00000000-0000-4000-8000-000000000704';
    const instance = { child: { pid: 704 }, startTicks: null, acceptanceTag, executablePath };
    const commandLine = `"${executablePath}" --cw-beta-acceptance=${acceptanceTag}`;
    const exact = { pid: 704, startTicks: '70400', executablePath, commandLine };
    const tokenize = (value) => [executablePath, ...value.split(' ').slice(1)];
    assert(bindElectronProcessIdentity(instance, { readProcessIdentity: () => exact }) === '70400',
      'Exact Electron process identity was rejected.');
    for (const unsafe of [
      { ...exact, pid: 705 }, { ...exact, executablePath: `${executablePath}.rogue` },
      { ...exact, startTicks: '' },
      { ...exact, commandLine: `"${executablePath}" --cw-beta-acceptance=${acceptanceTag}.rogue` },
      { ...exact, commandLine: `${commandLine} --cw-beta-acceptance=${acceptanceTag}` },
      { ...exact, commandLine: `${commandLine} --cw-beta-acceptance=${acceptanceTag}.rogue` },
      { ...exact, commandLine: `${commandLine} --cw-beta-acceptance=00000000-0000-4000-8000-000000009999` },
      { ...exact, commandLine: `${commandLine} --cw-beta-acceptance` },
    ]) expectThrow(() => bindElectronProcessIdentity({ ...instance, startTicks: null }, {
      readProcessIdentity: () => unsafe, tokenize,
    }));
  });

  test('launch readiness stop failure preserves outer ownership for retry and retain-before-release', async () => {
    const owned = { stdout: [Buffer.from('first-', 'utf8')], stderr: [], child: { pid: 703 } };
    const retained = [];
    let outerInstance = null;
    let stopAttempts = 0;
    let failure = null;
    try {
      await runOwnedElectronLaunchReadiness(owned, (instance) => { outerInstance = instance; },
        async () => { throw new Error('fixed readiness failure'); }, async () => {
          stopAttempts += 1;
          throw new Error('fixed first stop failure');
        }, () => '70300');
    } catch (error) { failure = error; }
    assert(failure?.message === 'fixed first stop failure' && outerInstance === owned && stopAttempts === 1,
      'Launch readiness failure lost outer cleanup ownership after the first stop failed.');

    await stopAndRetainOwnedElectron(outerInstance, retained, async () => {
      stopAttempts += 1;
      owned.stdout.push(Buffer.from('late-output', 'utf8'));
      return true;
    });
    assert(outerInstance === owned && stopAttempts === 2
      && retained[0].equals(Buffer.from('first-late-output', 'utf8')),
    'Outer cleanup retry did not retain complete output before ownership release.');
    outerInstance = null;
    assert(outerInstance === null, 'Outer Electron ownership was not released after complete output retention.');

    const cleanupFailures = [];
    try {
      await stopAndRetainOwnedElectron(owned, [], async () => { throw new Error('fixed retry failure'); });
    } catch { cleanupFailures.push('electron_tree'); }
    assert(JSON.stringify(cleanupFailures) === JSON.stringify(['electron_tree']),
      'Repeated Electron cleanup failure did not retain the fixed failure category.');
  });

  test('owned Claude argv permits only authoritative executable and MCP paths under the real profile', () => {
    const profile = 'C:\\Users\\private-profile';
    const claudeExecutable = `${profile}\\AppData\\Local\\Programs\\Claude\\claude.exe`;
    const electronExecutable = `${profile}\\Projects\\Workbench\\node_modules\\electron\\dist\\electron.exe`;
    const permissionMcpPath = `${profile}\\Projects\\Workbench\\dist\\main\\permission-mcp.js`;
    const mcpConfig = JSON.stringify({ mcpServers: { workbench_permissions: { type: 'stdio',
      command: electronExecutable, args: [permissionMcpPath], env: { ELECTRON_RUN_AS_NODE: '1' } } } });
    const commandLine = `claude -p fixed --mcp-config "${mcpConfig.replace(/"/gu, '\\"')}"`
      + ' --permission-prompt-tool mcp__workbench_permissions__request_permission';
    const rogueMcpConfig = JSON.stringify({ mcpServers: { workbench_permissions: { type: 'stdio',
      command: electronExecutable, args: [`${profile}\\rogue-mcp.js`], env: { ELECTRON_RUN_AS_NODE: '1' } } } });
    const rogueMcpCommandLine = `claude -p fixed --mcp-config "${rogueMcpConfig.replace(/"/gu, '\\"')}"`
      + ' --permission-prompt-tool mcp__workbench_permissions__request_permission';
    const trustedPrefixRogueConfig = JSON.stringify({ mcpServers: { workbench_permissions: { type: 'stdio',
      command: `${electronExecutable}.rogue`, args: [`${permissionMcpPath}.rogue`],
      env: { ELECTRON_RUN_AS_NODE: '1' } } } });
    const trustedPrefixRogueCommandLine = `claude -p fixed --mcp-config "${trustedPrefixRogueConfig.replace(/"/gu, '\\"')}"`
      + ' --permission-prompt-tool mcp__workbench_permissions__request_permission';
    const wrongPromptValueWithTrailingExact = commandLine.replace(
      '--permission-prompt-tool mcp__workbench_permissions__request_permission',
      '--permission-prompt-tool wrong-tool mcp__workbench_permissions__request_permission',
    );
    const duplicateFlags = `${commandLine} --mcp-config "${mcpConfig.replace(/"/gu, '\\"')}"`
      + ' --permission-prompt-tool mcp__workbench_permissions__request_permission';
    const input = { claudeExecutable, observedExecutablePath: claudeExecutable, electronExecutable, permissionMcpPath,
      promptToolName: 'mcp__workbench_permissions__request_permission',
      sensitiveValues: ['private-secret', 'diagnostic-name'], privateProfilePaths: privatePathTextVariants([profile]) };
    const phases = [];
    assert(assertOwnedClaudeChildArgumentsPrivacy(Buffer.from(commandLine, 'utf8'), input,
      (value) => phases.push(value)) === true,
      'Authoritative owned Claude arguments were rejected.');
    assert(JSON.stringify(phases) === JSON.stringify([
      'child_argv_observed_executable', 'child_argv_command_line_parse', 'child_argv_argv0',
      'child_argv_flag_layout', 'child_argv_mcp_closed_config', 'child_argv_privacy',
    ]), 'Owned Claude argument gates did not report the fixed closed phases in order.');
    const absoluteArgv0 = `"${claudeExecutable}"${commandLine.slice('claude'.length)}`;
    for (const unsafe of [
      absoluteArgv0, commandLine.replace(/^claude\b/u, 'claude.exe'),
      commandLine.replace(/^claude\b/u, 'claude-suffix'), commandLine.replace(/^claude\b/u, 'other-cli'),
      `${commandLine} --other ${profile}\\rogue.txt`, `${commandLine} private-secret`,
      rogueMcpCommandLine, trustedPrefixRogueCommandLine, wrongPromptValueWithTrailingExact, duplicateFlags,
      commandLine.replace('--permission-prompt-tool', '--other-prompt-tool'),
    ]) expectThrow(() => assertOwnedClaudeChildArgumentsPrivacy(Buffer.from(unsafe, 'utf8'), input));
    expectThrow(() => assertOwnedClaudeChildArgumentsPrivacy(Buffer.from(commandLine, 'utf8'), {
      ...input, observedExecutablePath: `${claudeExecutable}.rogue`,
    }));
  });

  test('owned Claude privacy scans the parsed stage prompt without a second JSON escape layer', () => {
    const profile = 'C:\\Users\\private-profile';
    const claudeExecutable = `${profile}\\AppData\\Local\\Programs\\Claude\\claude.exe`;
    const electronExecutable = `${profile}\\Projects\\Workbench\\node_modules\\electron\\dist\\electron.exe`;
    const permissionMcpPath = `${profile}\\Projects\\Workbench\\dist\\main\\permission-mcp.js`;
    const privateProjectPath = `${profile}\\Projects\\Sensitive-Workspace`;
    const stagePrompt = JSON.stringify({ kind: 'coder', projectPath: privateProjectPath });
    const mcpConfig = JSON.stringify({ mcpServers: { workbench_permissions: { type: 'stdio',
      command: electronExecutable, args: [permissionMcpPath], env: { ELECTRON_RUN_AS_NODE: '1' } } } });
    const commandLine = `claude -p "${stagePrompt.replace(/"/gu, '\\"')}"`
      + ` --mcp-config "${mcpConfig.replace(/"/gu, '\\"')}"`
      + ' --permission-prompt-tool mcp__workbench_permissions__request_permission';
    const phases = [];
    let failure = null;
    try {
      assertOwnedClaudeChildArgumentsPrivacy(Buffer.from(commandLine, 'utf8'), {
        claudeExecutable, observedExecutablePath: claudeExecutable, electronExecutable, permissionMcpPath,
        promptToolName: 'mcp__workbench_permissions__request_permission', sensitiveValues: [],
        privateProfilePaths: privatePathTextVariants([profile]),
      }, (value) => phases.push(value));
    } catch (error) { failure = error; }
    assert(failure instanceof Error && phases.at(-1) === 'child_argv_privacy',
      'JSON stage-prompt path was not rejected at the fixed child argv privacy gate.');
  });

  test('binds one structured CIM Claude executable and command-line record', () => {
    const executablePath = 'C:\\Users\\private-profile\\Programs\\Claude\\claude.exe';
    const commandLine = `"${executablePath}" -p fixed`;
    const phases = [];
    const bound = bindOwnedClaudeProcessArgumentEvidence([{ executablePath, commandLine }],
      (value) => phases.push(value));
    assert(bound.observedExecutablePath === executablePath && bound.commandLine.equals(Buffer.from(commandLine, 'utf8')),
      'Exact structured CIM Claude argument evidence was not bound.');
    assert(JSON.stringify(phases) === JSON.stringify([
      'child_argv_record_cardinality', 'child_argv_record_schema',
    ]), 'Owned Claude CIM record gates did not report the fixed closed phases in order.');
    for (const unsafe of [[], [{ executablePath, commandLine }, { executablePath, commandLine }],
      [{ executablePath: null, commandLine }], [{ executablePath, commandLine, pid: 9 }]]) {
      expectThrow(() => bindOwnedClaudeProcessArgumentEvidence(unsafe));
    }
  });

  test('child argv phase enumeration is closed and strictly ordered', () => {
    const phases = [];
    const setPhase = createChildArgvPhaseSetter((value) => phases.push(value));
    for (const value of CHILD_ARGV_PHASES) setPhase(value);
    assert(JSON.stringify(phases) === JSON.stringify(CHILD_ARGV_PHASES),
      'Child argv phases were missing, reordered, or duplicated.');
    for (const unsafe of [
      () => createChildArgvPhaseSetter(() => undefined)('child_argv_privacy'),
      () => { const set = createChildArgvPhaseSetter(() => undefined); set(CHILD_ARGV_PHASES[0]); set(CHILD_ARGV_PHASES[0]); },
      () => createChildArgvPhaseSetter(() => undefined)('child_argv_raw_arguments'),
    ]) expectThrow(unsafe);
  });

  test('child argv record-cardinality phase is set before the owned CIM query can fail', () => {
    const phases = [];
    let queryCalls = 0;
    expectThrow(() => descendantClaudeArgumentEvidence(1, (value) => phases.push(value), {
      runQuery: () => { queryCalls += 1; throw new Error('fixed CIM query failure'); },
    }));
    assert(queryCalls === 1
      && JSON.stringify(phases) === JSON.stringify(['child_argv_record_cardinality']),
    'Owned CIM query failure was attributed to the preceding child argv phase.');
  });

  test('production owned-Claude generic-list serialization returns exact JSON arrays in a real PowerShell child', () => {
    for (const count of [0, 1, 2]) {
      const additions = Array.from({ length: count }, (_unused, index) =>
        `$records.Add([pscustomobject]@{index=${index}})`).join(';');
      const script = `$ErrorActionPreference='Stop';$records=New-Object System.Collections.Generic.List[object];`
        + `${additions};[Console]::Out.Write((ConvertTo-Json -Compress -InputObject `
        + `${POWERSHELL_GENERIC_LIST_JSON_ARRAY_EXPRESSION}))`;
      const result = spawnSync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script,
      ], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 5_000, maxBuffer: 64 * 1024 });
      assert(!result.error && result.status === 0 && result.signal === null && !result.stderr.trim()
        && result.stdout.trim(), 'Production generic-list JSON serialization failed in a real PowerShell child.');
      let parsed = null;
      try { parsed = JSON.parse(result.stdout); } catch { /* fixed assertion below */ }
      const expected = Array.from({ length: count }, (_unused, index) => ({ index }));
      assert(Array.isArray(parsed) && JSON.stringify(parsed) === JSON.stringify(expected),
        'Production generic-list JSON serialization did not preserve the exact array shape.');
    }
  });

  test('child argv authoritative-files phase is set before CLI path resolution can fail', () => {
    const phases = [];
    let resolverCalls = 0;
    expectThrow(() => authoritativeClaudeChildPaths((value) => phases.push(value), () => {
      resolverCalls += 1;
      throw new Error('fixed CLI resolution failure');
    }));
    assert(resolverCalls === 1
      && JSON.stringify(phases) === JSON.stringify(['child_argv_authoritative_files']),
    'Authoritative child path resolution failure was attributed to the preceding child argv phase.');
  });

  test('post-Step 15 gates set the exact phase before each operation and stop all downstream work', async () => {
    const phases = []; const calls = [];
    const operations = { setPhase: (value) => phases.push(value) };
    for (const gate of POST_STEP15_GATES) operations[gate] = async () => {
      assert(phases.at(-1) === gate, 'Post-Step 15 phase was not set before its operation.');
      calls.push(gate);
    };
    await runPostStep15GateSequence(operations, createPostStep15State({
      diagnosticCandidateCount: 2, tempPreserved: true,
    }));
    assert(JSON.stringify(phases) === JSON.stringify(POST_STEP15_GATES)
      && JSON.stringify(calls) === JSON.stringify(POST_STEP15_GATES),
    'Post-Step 15 gates were missing, reordered, or duplicated.');

    const stoppedPhases = []; const stoppedCalls = [];
    const stopped = { setPhase: (value) => stoppedPhases.push(value) };
    for (const gate of POST_STEP15_GATES) stopped[gate] = async (state) => {
      assert(stoppedPhases.at(-1) === gate, 'Failing post-Step 15 phase was not set before its operation.');
      stoppedCalls.push(gate);
      if (gate === 'electron_stop_close_drain') state.outputStreamCount = 4;
      if (gate === 'child_output_privacy') {
        state.childOutputStreamIndex = 1; state.outputStreamsScanned = 1;
        throw new Error('private child output must never enter the closed fact');
      }
    };
    let failure = null;
    try {
      await runPostStep15GateSequence(stopped, createPostStep15State({
        diagnosticCandidateCount: 2, tempPreserved: true,
      }));
    } catch (error) { failure = error; }
    const expectedCalls = POST_STEP15_GATES.slice(0, POST_STEP15_GATES.indexOf('child_output_privacy') + 1);
    assert(failure?.postStep15?.gate === 'child_output_privacy'
      && JSON.stringify(stoppedCalls) === JSON.stringify(expectedCalls)
      && JSON.stringify(stoppedPhases) === JSON.stringify(expectedCalls),
    'Post-Step 15 failure did not retain its exact gate or allowed downstream work.');
  });

  test('post-Step 15 failure fact is closed to fixed categories and bounded stream/count evidence', () => {
    const fact = closedPostStep15FailureFact({
      ...createPostStep15State({ diagnosticCandidateCount: 2, tempPreserved: true }),
      gate: 'child_output_privacy', errorType: 'unknown', outputStreamCount: 4,
      outputStreamsScanned: 1, childOutputStreamIndex: 1,
    });
    assert(JSON.stringify(Object.keys(fact)) === JSON.stringify([
      'gate', 'errorType', 'outputStreamCount', 'outputStreamsScanned', 'childOutputStreamIndex', 'childOutputMatch',
      'loopbackClosedCount', 'diagnosticCandidateCount', 'diagnosticDeletedCount', 'taggedCount',
      'listenerCount', 'tempRemoveAttempted', 'tempPreserved',
    ]) && !JSON.stringify(fact).includes('private'),
    'Post-Step 15 failure fact exposed raw data or changed schema.');
    for (const unsafe of [
      { ...fact, rawPath: 'private' }, { ...fact, outputStreamCount: -1 },
      { ...fact, outputStreamsScanned: -1 }, { ...fact, childOutputStreamIndex: -1 },
      { ...fact, diagnosticDeletedCount: -1 }, { ...fact, taggedCount: -1 },
      { ...fact, listenerCount: -1 }, { ...fact, gate: 'private_raw_gate' },
      { ...fact, errorType: 'private_raw_error' }, { ...fact, childOutputStreamIndex: 4 },
    ]) expectThrow(() => closedPostStep15FailureFact(unsafe));
  });

  test('over-bound owned process/listener counts retain the exact gate with null closed values', async () => {
    const phases = [];
    const operations = { setPhase: (value) => phases.push(value) };
    for (const gate of POST_STEP15_GATES) operations[gate] = async (state) => {
      if (gate === 'owned_process_listener_zero') {
        state.taggedCount = closedPostStep15ObservedCount(4_097);
        state.listenerCount = closedPostStep15ObservedCount(4_097);
        assert(state.taggedCount === 0 && state.listenerCount === 0, 'fixed nonzero owned count');
      }
    };
    let failure = null;
    try {
      await runPostStep15GateSequence(operations, createPostStep15State({
        diagnosticCandidateCount: 2, tempPreserved: false,
      }));
    } catch (error) { failure = error; }
    assert(failure?.postStep15?.gate === 'owned_process_listener_zero'
      && failure.postStep15.taggedCount === null && failure.postStep15.listenerCount === null
      && phases.at(-1) === 'owned_process_listener_zero',
    'Over-bound owned count caused a secondary closed-fact failure or lost the exact gate.');
    assert(closedPostStep15ObservedCount(0) === 0 && closedPostStep15ObservedCount(4_096) === 4_096,
      'Valid bounded owned counts were not preserved.');
  });

  test('post-Step 15 stop and post-scan marker failures retain the current bounded stream count', async () => {
    const state = createPostStep15State({ diagnosticCandidateCount: 2, tempPreserved: true });
    const streams = [Buffer.from('first stdout'), Buffer.from('first stderr')];
    let failure = null;
    try {
      await stopAndRecordPostStep15Electron(state, {}, streams, async (_instance, target) => {
        target.push(Buffer.from('second stdout'), Buffer.from('second stderr'));
        throw new Error('fixed stop failure');
      });
    } catch (error) { failure = error; }
    assert(failure instanceof Error && state.outputStreamCount === 4,
      'Post-Step 15 stop failure did not retain the current drained stream count.');
    assert(closedPostStep15FailureFact({ ...state, gate: 'electron_stop_close_drain', errorType: 'unknown' })
      .outputStreamCount === 4, 'Post-Step 15 stop failure count was not closed.');
    const postScan = closedPostStep15FailureFact({ ...state, gate: 'child_output_privacy', errorType: 'unknown',
      outputStreamsScanned: 4, childOutputStreamIndex: null });
    assert(postScan.childOutputStreamIndex === null && postScan.outputStreamsScanned === 4,
      'Post-scan child-output marker failure was not representable without raw stream data.');
  });

  test('child-output private-match evidence maps four streams and classifies only closed aggregate facts', () => {
    const realProfile = 'C:\\Users\\private-profile';
    const fixtureRoot = `${realProfile}\\AppData\\Local\\Temp\\cw-beta-fixture`;
    const dataRoot = `${fixtureRoot}\\workbench-data`;
    const providerSecret = 'cw-provider-private-sentinel';
    const groups = {
      provider_secret: [providerSecret],
      diagnostic_full: ['C:\\Users\\private-profile\\Documents\\diagnostics-private.zip'],
      diagnostic_basename: ['diagnostics-private.zip'],
      diagnostic_parent: ['C:\\Users\\private-profile\\Documents'],
      credential_ref: ['safe-storage://v1/private-reference'],
      vault_filename: ['private-reference.bin'],
      vault_directory: [`${dataRoot}\\model-credentials`, 'model-credentials'],
      fixture_root: [fixtureRoot],
      data_root: [dataRoot],
      real_profile: [realProfile],
    };
    const streams = [
      Buffer.from('fixed clean first stdout', 'utf8'),
      Buffer.from(`[ClaudeCliAdapter] fixed ${JSON.stringify(dataRoot).slice(1, -1)}\n`
        + `unclassified ${providerSecret}`, 'utf8'),
      Buffer.from('fixed clean second stdout', 'utf8'),
      Buffer.from(`[1:2:ERROR:disk_cache.cc(42)] ${fixtureRoot}\n(node:1) Warning: ${realProfile}`, 'utf8'),
    ];
    const fact = scanChildOutputPrivateMatches(streams, groups);
    assert(JSON.stringify(fact) === JSON.stringify({
      firstMatchStreamRole: 'first_stderr',
      streamMask: 0b1010,
      families: ['provider_secret', 'fixture_root', 'data_root', 'real_profile'],
      encodingForms: ['literal_utf8', 'json_escaped_utf8'],
      producerHints: ['product', 'platform', 'runtime', 'unknown'],
      lineShapes: ['header', 'platform', 'runtime_warning', 'plain'],
      distanceBuckets: ['same', 'none'],
      componentCounts: [
        { component: 'claude_cli_adapter', matchCount: 1 },
        { component: 'platform', matchCount: 1 },
        { component: 'runtime', matchCount: 1 },
        { component: 'unknown', matchCount: 1 },
      ],
      markerGroupCount: 3,
      attributedCount: 3,
      unattributedCount: 1,
      totalCount: 4,
      saturated: false,
    }), 'Child-output private-match evidence did not preserve the exact closed classifications.');
    assert(!JSON.stringify(fact).includes(providerSecret) && !JSON.stringify(fact).includes(realProfile),
      'Child-output private-match evidence retained a raw private value.');
    const state = createPostStep15State({ diagnosticCandidateCount: 2, tempPreserved: true });
    state.outputStreamCount = 4;
    assert(recordChildOutputPrivateMatch(state, fact) === true
      && state.childOutputStreamIndex === 1 && state.outputStreamsScanned === 1
      && JSON.stringify(state.childOutputMatch) === JSON.stringify(fact),
    'Child-output match did not bind the first failing stream after the prior clean stream.');
  });

  test('child-output private-match closed schema rejects raw, extra, negative, duplicate, and unknown facts', () => {
    const valid = {
      firstMatchStreamRole: 'first_stderr', streamMask: 0b0010,
      families: ['fixture_root'], encodingForms: ['literal_utf8'], producerHints: ['unknown'],
      lineShapes: ['plain'], distanceBuckets: ['none'],
      componentCounts: [{ component: 'unknown', matchCount: 1 }],
      markerGroupCount: 0, attributedCount: 0, unattributedCount: 1,
      totalCount: 1, saturated: false,
    };
    assert(JSON.stringify(closedChildOutputMatchFact(valid)) === JSON.stringify(valid),
      'Valid child-output match fact was not preserved exactly.');
    for (const unsafe of [
      { ...valid, raw: 'private' },
      { ...valid, streamMask: -1 },
      { ...valid, totalCount: -1 },
      { ...valid, firstMatchStreamRole: 'private_stream' },
      { ...valid, families: ['private_family'] },
      { ...valid, families: ['fixture_root', 'fixture_root'] },
      { ...valid, encodingForms: ['private_encoding'] },
      { ...valid, producerHints: ['private_producer'] },
      { ...valid, saturated: 'false' },
    ]) expectThrow(() => closedChildOutputMatchFact(unsafe));
  });

  test('child-output producer hints prefer strong platform and runtime signatures over generic product text', () => {
    const fixtureRoot = 'C:\\Users\\private-profile\\Temp\\cw-beta-fixture';
    const groups = {
      provider_secret: [], diagnostic_full: [], diagnostic_basename: [], diagnostic_parent: [], credential_ref: [],
      vault_filename: [], vault_directory: [], fixture_root: [fixtureRoot], data_root: [], real_profile: [],
    };
    for (const [line, expected] of [
      [`[ClaudeCliAdapter] [1:2:ERROR:disk_cache.cc(42)] ${fixtureRoot}`, 'product'],
      [`[1:2:ERROR:disk_cache.cc(42)] Failed to load ${fixtureRoot}`, 'platform'],
      [`(node:1) Warning: Unable to load ${fixtureRoot}`, 'runtime'],
    ]) {
      const fact = scanChildOutputPrivateMatches([
        Buffer.from('clean'), Buffer.from(line, 'utf8'), Buffer.from('clean'), Buffer.from('clean'),
      ], groups);
      assert(JSON.stringify(fact.producerHints) === JSON.stringify([expected]),
        'A generic product phrase overrode a strong platform or runtime signature.');
    }
  });

  test('child-output context evidence attributes thirteen IPC stack matches to three fixed components', () => {
    const realProfile = 'C:\\Users\\private-profile';
    const groups = {
      provider_secret: [], diagnostic_full: [], diagnostic_basename: [], diagnostic_parent: [], credential_ref: [],
      vault_filename: [], vault_directory: [], fixture_root: [], data_root: [], real_profile: [realProfile],
    };
    const blocks = [
      ['model-selection:set-task-override', 'ipc_task_model_override', 5],
      ['agent-preset:apply', 'ipc_agent_preset_apply', 4],
      ['workflow:create', 'ipc_workflow_create', 4],
    ];
    const stderr = blocks.map(([channel, _component, count], blockIndex) => [
      `Error occurred in handler for '${channel}': Error: fixed rejection`,
      ...Array.from({ length: count }, (_unused, frameIndex) => (
        `    at fixed_${blockIndex}_${frameIndex} (${realProfile}\\workspace\\dist\\main\\index.js:${frameIndex + 1}:1)`
      )),
    ].join('\n')).join('\n');
    const fact = scanChildOutputPrivateMatches([
      Buffer.from('clean'), Buffer.from(stderr, 'utf8'), Buffer.from('clean'), Buffer.from('clean'),
    ], groups);
    assert(fact.firstMatchStreamRole === 'first_stderr' && fact.streamMask === 0b0010
      && fact.totalCount === 13 && !fact.saturated,
    'IPC context evidence changed the existing closed match cardinality.');
    assert(JSON.stringify(fact.lineShapes) === JSON.stringify(['stack_frame'])
      && JSON.stringify(fact.distanceBuckets) === JSON.stringify(['1', '2_4', '5_8'])
      && JSON.stringify(fact.componentCounts) === JSON.stringify([
        { component: 'ipc_task_model_override', matchCount: 5 },
        { component: 'ipc_agent_preset_apply', matchCount: 4 },
        { component: 'ipc_workflow_create', matchCount: 4 },
      ])
      && fact.markerGroupCount === 3 && fact.attributedCount === 13 && fact.unattributedCount === 0,
    'Thirteen IPC stack matches were not attributed to the three closed components.');
    const serialized = JSON.stringify(fact);
    assert(!serialized.includes(realProfile) && !blocks.some(([channel]) => serialized.includes(channel))
      && !serialized.includes('fixed_') && !serialized.includes('index.js'),
    'Child-output context evidence retained a channel, function, file, or private path.');
  });

  test('child-output context evidence enforces nearest-marker, stack-boundary, line, and byte limits', () => {
    const realProfile = 'C:\\Users\\private-profile';
    const groups = {
      provider_secret: [], diagnostic_full: [], diagnostic_basename: [], diagnostic_parent: [], credential_ref: [],
      vault_filename: [], vault_directory: [], fixture_root: [], data_root: [], real_profile: [realProfile],
    };
    const lines = [
      `[ClaudeCliAdapter] ${realProfile}`,
      `[PermissionBroker] ${realProfile}`,
      `[CheckpointManager] ${realProfile}`,
      `[CheckpointLifecycleCoordinator] ${realProfile}`,
      `[ClaudeLocalSessionAdapter] ${realProfile}`,
      `[FileMutationManager] ${realProfile}`,
      `[TaskManager] ${realProfile}`,
      `Failed to load fixed resource ${realProfile}`,
      `[1:2:ERROR:disk_cache.cc(42)] ${realProfile}`,
      `(node:1) Warning: ${realProfile}`,
      '[TaskManager] older marker',
      '    at fixed (C:\\safe\\older.js:1:1)',
      '[PermissionBroker] nearer marker',
      `    at [TaskManager]nearest (${realProfile}\\workspace\\nearest.js:1:1)`,
      '[TaskManager] within line bound',
      ...Array.from({ length: 11 }, (_unused, index) => `    at safe_${index} (C:\\safe\\line.js:1:1)`),
      `    at line_twelve (${realProfile}\\workspace\\bounded.js:1:1)`,
      '[FileMutationManager] over line bound',
      ...Array.from({ length: 16 }, (_unused, index) => `    at over_${index} (C:\\safe\\line.js:1:1)`),
      `    at line_seventeen (${realProfile}\\workspace\\over-line.js:1:1)`,
      '[CheckpointManager] over byte bound',
      `    at huge (C:\\safe\\${'x'.repeat(8_200)}.js:1:1)`,
      `    at over_bytes (${realProfile}\\workspace\\over-bytes.js:1:1)`,
      '[TaskManager] non-stack boundary',
      'fixed boundary',
      `    at after_plain (${realProfile}\\workspace\\after-plain.js:1:1)`,
      '[TaskManager] blank boundary',
      '',
      `    at after_blank (${realProfile}\\workspace\\after-blank.js:1:1)`,
      `unmarked ${realProfile}`,
    ];
    const fact = scanChildOutputPrivateMatches([
      Buffer.from('clean'), Buffer.from(lines.join('\n'), 'utf8'), Buffer.from('clean'), Buffer.from('clean'),
    ], groups);
    assert(JSON.stringify(fact.lineShapes) === JSON.stringify([
      'stack_frame', 'header', 'platform', 'runtime_warning', 'plain',
    ]) && JSON.stringify(fact.distanceBuckets) === JSON.stringify([
      'same', '1', '9_16', 'none',
    ]), 'Context evidence lost a fixed line shape or distance bucket.');
    assert(JSON.stringify(fact.componentCounts) === JSON.stringify([
      { component: 'claude_cli_adapter', matchCount: 1 },
      { component: 'permission_broker', matchCount: 2 },
      { component: 'checkpoint_manager', matchCount: 1 },
      { component: 'checkpoint_lifecycle_coordinator', matchCount: 1 },
      { component: 'claude_local_session_adapter', matchCount: 1 },
      { component: 'file_mutation_manager', matchCount: 1 },
      { component: 'task_manager', matchCount: 2 },
      { component: 'generic_product', matchCount: 1 },
      { component: 'platform', matchCount: 1 },
      { component: 'runtime', matchCount: 1 },
      { component: 'unknown', matchCount: 5 },
    ]) && fact.markerGroupCount === 12 && fact.attributedCount === 12
      && fact.unattributedCount === 5 && fact.totalCount === 17,
    'Nearest-marker or bounded context attribution did not remain closed and conservative.');
  });

  test('child-output context uses the private-match byte offset for exact bounds and preceding markers', () => {
    const realProfile = 'C:\\Users\\private-profile';
    const groups = {
      provider_secret: [], diagnostic_full: [], diagnostic_basename: [], diagnostic_parent: [], credential_ref: [],
      vault_filename: [], vault_directory: [], fixture_root: [], data_root: [], real_profile: [realProfile],
    };
    const marker = '[TaskManager]';
    const markerAtDistance = (distance) => `${marker}${'x'.repeat(distance - Buffer.byteLength(marker))}${realProfile}`;
    const stackPrefix = '    at bounded (';
    const precedingMarkerAtDistance = (distance) => [
      marker,
      `${stackPrefix}${'x'.repeat(distance - Buffer.byteLength(`${marker}\n${stackPrefix}`))}${realProfile})`,
    ];
    const lines = [
      markerAtDistance(8_192),
      markerAtDistance(8_193),
      ...precedingMarkerAtDistance(8_192),
      ...precedingMarkerAtDistance(8_193),
      '[TaskManager] prior marker',
      `    at long_match (${`x`.repeat(8_193)}${realProfile})`,
      `${realProfile} [1:2:ERROR:disk_cache.cc(42)]`,
      `${realProfile} (node:1) Warning: fixed`,
      `${realProfile} Failed to load fixed resource`,
      `${realProfile} Error occurred in handler for 'workflow:create': Error: fixed`,
      `${realProfile} [TaskManager]`,
    ];
    const fact = scanChildOutputPrivateMatches([
      Buffer.from('clean'), Buffer.from(lines.join('\n'), 'utf8'), Buffer.from('clean'), Buffer.from('clean'),
    ], groups);
    assert(fact.totalCount === 10 && fact.markerGroupCount === 2
      && fact.attributedCount === 2 && fact.unattributedCount === 8
      && JSON.stringify(fact.componentCounts) === JSON.stringify([
        { component: 'task_manager', matchCount: 2 },
        { component: 'unknown', matchCount: 8 },
      ]) && JSON.stringify(fact.distanceBuckets) === JSON.stringify(['same', '1', 'none'])
      && JSON.stringify(fact.lineShapes) === JSON.stringify([
        'stack_frame', 'header', 'platform', 'runtime_warning', 'plain',
      ]),
    'Context attribution did not enforce the exact private-match byte boundary or preceding-marker rule.');
  });

  test('child-output context closed schema rejects raw, extra, unknown, negative, and non-conserving facts', () => {
    const valid = {
      firstMatchStreamRole: 'first_stderr', streamMask: 0b0010,
      families: ['real_profile'], encodingForms: ['literal_utf8'], producerHints: ['unknown'],
      lineShapes: ['plain'], distanceBuckets: ['none'],
      componentCounts: [{ component: 'unknown', matchCount: 1 }],
      markerGroupCount: 0, attributedCount: 0, unattributedCount: 1,
      totalCount: 1, saturated: false,
    };
    assert(JSON.stringify(closedChildOutputMatchFact(valid)) === JSON.stringify(valid),
      'Valid child-output context evidence was not preserved exactly.');
    for (const unsafe of [
      { ...valid, raw: 'private' },
      { ...valid, lineShapes: ['private_shape'] },
      { ...valid, lineShapes: ['plain', 'plain'] },
      { ...valid, distanceBuckets: ['private_distance'] },
      { ...valid, componentCounts: [{ component: 'private_component', matchCount: 1 }] },
      { ...valid, componentCounts: [{ component: 'unknown', matchCount: -1 }] },
      { ...valid, markerGroupCount: -1 },
      { ...valid, producerHints: ['product'], distanceBuckets: ['same'],
        componentCounts: [{ component: 'claude_cli_adapter', matchCount: 1 }],
        markerGroupCount: 0, attributedCount: 1, unattributedCount: 0 },
      { ...valid, attributedCount: 1, unattributedCount: 1 },
      { ...valid, unattributedCount: 0 },
    ]) expectThrow(() => closedChildOutputMatchFact(unsafe));
  });

  test('post-Step 15 recovery cannot overwrite the original stop or temp-removal failure gate', async () => {
    for (const failingGate of ['electron_stop_close_drain', 'owned_temp_remove']) {
      const phases = []; let recoveryRan = false;
      const operations = { setPhase: (value) => phases.push(value) };
      for (const gate of POST_STEP15_GATES) operations[gate] = async (state) => {
        if (gate === 'electron_stop_close_drain') state.outputStreamCount = 2;
        if (gate === 'owned_temp_remove') { state.tempRemoveAttempted = true; state.tempPreserved = true; }
        if (gate === failingGate) throw new Error('fixed recoverable failure');
      };
      let closed = null;
      try {
        await runPostStep15GateSequence(operations, createPostStep15State({
          diagnosticCandidateCount: 2, tempPreserved: true,
        }));
      } catch (error) {
        closed = error.postStep15;
        recoveryRan = true;
      }
      assert(recoveryRan && closed?.gate === failingGate && phases.at(-1) === failingGate,
        'Successful outer recovery replaced or lost the original post-Step 15 failure gate.');
      if (failingGate === 'owned_temp_remove') assert(closed.tempRemoveAttempted && closed.tempPreserved,
        'Temp-removal failure did not preserve its pre-recovery closed state.');
    }
  });

  test('privacy passed marker advances only after the final retained-report scan', async () => {
    const privacy = { passed: false, childOutputPassed: false, preCleanupRetainedReportPassed: false,
      ownedElectronInstancesOutputScanned: 0 };
    expectThrow(() => markPostStep15PreCleanupRetainedReportPrivacyPassed(privacy));
    expectThrow(() => markPostStep15FinalRetainedReportPrivacyPassed(privacy));
    markPostStep15ChildOutputPrivacyPassed(privacy, 2);
    assert(privacy.childOutputPassed && privacy.ownedElectronInstancesOutputScanned === 2 && !privacy.passed,
      'Child-output scan marked total privacy passed before the retained-report scan.');
    markPostStep15PreCleanupRetainedReportPrivacyPassed(privacy);
    assert(privacy.preCleanupRetainedReportPassed && !privacy.passed,
      'Pre-cleanup retained-report scan marked final privacy passed.');

    const phases = [];
    const failedFinalPrivacy = { ...privacy };
    const operations = { setPhase: (value) => phases.push(value) };
    for (const gate of POST_STEP15_GATES) operations[gate] = async () => {
      if (gate === 'retained_report_final') throw new Error('fixed final retained-report failure');
    };
    let failure = null;
    try {
      await runPostStep15GateSequence(operations, createPostStep15State({
        diagnosticCandidateCount: 2, tempPreserved: false,
      }));
    } catch (error) { failure = error; }
    assert(failure?.postStep15?.gate === 'retained_report_final'
      && failedFinalPrivacy.preCleanupRetainedReportPassed && !failedFinalPrivacy.passed,
    'Final retained-report failure inherited a misleading privacy passed marker.');

    markPostStep15FinalRetainedReportPrivacyPassed(privacy);
    assert(privacy.passed && privacy.preCleanupRetainedReportPassed,
      'Successful final retained-report scan did not mark privacy passed.');
    expectThrow(() => markPostStep15ChildOutputPrivacyPassed({ ...privacy }, -1));
  });

  test('failed post-Step 15 report falls back to a closed projection when the partial report is private', () => {
    const postStep15 = closedPostStep15FailureFact({
      ...createPostStep15State({ diagnosticCandidateCount: 2, tempPreserved: false }),
      gate: 'artifact_metadata_privacy', errorType: 'unknown',
    });
    const report = { schemaVersion: 1, status: 'failed', privateField: 'private-sentinel',
      failure: { category: 'acceptance_assertion_failed', phase: 'artifact_metadata_privacy', completedSteps: 15,
        postStep15 },
      cleanup: { failureCategories: [], ownedTempPreserved: false } };
    const serialized = serializeFailureReportSafely(report, ['private-sentinel'], []);
    const closed = JSON.parse(serialized);
    assert(!serialized.includes('private-sentinel')
      && JSON.stringify(Object.keys(closed)) === JSON.stringify(['schemaVersion', 'status', 'failure', 'cleanup'])
      && JSON.stringify(Object.keys(closed.failure)) === JSON.stringify([
        'category', 'phase', 'completedSteps', 'postStep15',
      ]) && closed.failure.postStep15.gate === 'artifact_metadata_privacy',
    'Private failed report was written instead of the exact closed fallback projection.');
    const safe = { ...report, privateField: 'fixed' };
    assert(JSON.parse(serializeFailureReportSafely(safe, ['private-sentinel'], [])).privateField === 'fixed',
      'Safe failed report was unnecessarily replaced by the fallback projection.');
  });

  test('duplicate diagnostics cleanup failures still write one closed private-report fallback category', () => {
    const cleanupFailures = createCleanupFailureCollector();
    for (let index = 0; index < 2; index += 1) cleanupFailures.add('bound_diagnostics_identity');
    const postStep15 = closedPostStep15FailureFact({
      ...createPostStep15State({ diagnosticCandidateCount: 2, tempPreserved: true }),
      gate: 'diagnostics_delete', errorType: 'unknown', diagnosticDeletedCount: 0,
    });
    const report = { schemaVersion: 1, status: 'failed', privateField: 'private-sentinel',
      failure: { category: 'acceptance_assertion_failed', phase: 'diagnostics_delete', completedSteps: 15,
        postStep15 },
      cleanup: { failureCategories: cleanupFailures.values(), ownedTempPreserved: true } };
    const closed = JSON.parse(serializeFailureReportSafely(report, ['private-sentinel'], []));
    assert(JSON.stringify(closed.cleanup.failureCategories) === JSON.stringify(['bound_diagnostics_identity'])
      && !JSON.stringify(closed).includes('private-sentinel'),
    'Duplicate ZIP cleanup failures blocked or duplicated the closed fallback category.');
    expectThrow(() => cleanupFailures.add('private_raw_cleanup_failure'));
  });

  test('every operation after Step 15 starts inside the closed runner and private early failures use fallback', async () => {
    const requiredPrefix = [
      'owned_runtime_identity', 'credential_privacy_facts', 'owned_child_arguments_privacy', 'settings_close',
      'public_capture', 'public_dto_privacy', 'persisted_event_privacy', 'database_file_privacy',
      'retained_file_privacy', 'privacy_evidence_initialize', 'request_evidence', 'artifact_build',
      'artifact_metadata_privacy',
    ];
    assert(JSON.stringify(POST_STEP15_GATES.slice(0, requiredPrefix.length)) === JSON.stringify(requiredPrefix),
      'Post-Step 15 runner does not own every pre-shutdown operation in exact order.');
    const phases = []; const calls = [];
    const operations = { setPhase: (value) => phases.push(value) };
    for (const gate of POST_STEP15_GATES) operations[gate] = async () => {
      calls.push(gate);
      if (gate === 'credential_privacy_facts') throw new Error('private-sentinel');
    };
    let failure = null;
    try {
      await runPostStep15GateSequence(operations, createPostStep15State({
        diagnosticCandidateCount: 2, tempPreserved: true,
      }));
    } catch (error) { failure = error; }
    const expectedCalls = ['owned_runtime_identity', 'credential_privacy_facts'];
    assert(failure?.postStep15?.gate === 'credential_privacy_facts'
      && JSON.stringify(phases) === JSON.stringify(expectedCalls)
      && JSON.stringify(calls) === JSON.stringify(expectedCalls),
    'Early post-Step 15 failure lost its closed gate or allowed downstream operations.');
    const report = { schemaVersion: 1, status: 'failed', privateField: 'private-sentinel',
      failure: { category: 'acceptance_assertion_failed', phase: failure.postStep15.gate, completedSteps: 15,
        postStep15: failure.postStep15 },
      cleanup: { failureCategories: [], ownedTempPreserved: false } };
    const serialized = serializeFailureReportSafely(report, ['private-sentinel'], []);
    assert(!serialized.includes('private-sentinel')
      && JSON.parse(serialized).failure.postStep15.gate === 'credential_privacy_facts',
    'Early private post-Step 15 failure did not use the exact closed fallback report.');
    const failurePrivacy = createPostStep15FailureReportPrivacy(['private-sentinel'], []);
    extendPostStep15FailureReportPrivacy(failurePrivacy, ['opaque-credential-ref', 'vault-file-name']);
    for (const privateValue of ['opaque-credential-ref', 'vault-file-name']) {
      const expanded = { ...report, privateField: privateValue };
      const closed = serializeFailureReportSafely(expanded, failurePrivacy.sensitiveValues,
        failurePrivacy.privatePathValues);
      assert(!closed.includes(privateValue), 'Expanded credential/vault identity escaped the closed fallback report.');
    }
  });

  test('restart screenshot readiness requires no loading overlay and exact persisted project/workflow UI', () => {
    const ready = { loadingOverlayCount: 0, historyLoadingCount: 0, visibleProjectButtonCount: 1,
      visibleTaskButtonCount: 1, visibleCurrentWorkflowCount: 1, visibleWorkflowControlsCount: 1,
      visibleWorkflowPanelCount: 1, selectedWorkflowListItemCount: 1, workflowStatusLeafCount: 1,
      workflowIdentityLeafCount: 1, authoritativeWorkflowMatch: true };
    assert(assertRestartScreenshotReadyFact(ready) === true, 'Exact restart screenshot readiness was rejected.');
    for (const unsafe of [
      { ...ready, loadingOverlayCount: 1 }, { ...ready, historyLoadingCount: 1 },
      { ...ready, visibleProjectButtonCount: 0 }, { ...ready, visibleTaskButtonCount: 0 },
      { ...ready, visibleCurrentWorkflowCount: 0 }, { ...ready, visibleWorkflowControlsCount: 2 },
      { ...ready, visibleWorkflowPanelCount: 0 }, { ...ready, selectedWorkflowListItemCount: 0 },
      { ...ready, workflowStatusLeafCount: 0 }, { ...ready, workflowIdentityLeafCount: 0 },
      { ...ready, authoritativeWorkflowMatch: false },
    ]) expectThrow(() => assertRestartScreenshotReadyFact(unsafe));
  });

  test('restart DOM readiness binds the visible Plan-header Workflow id without a Review-only marker', () => {
    const projectName = 'Persisted Project';
    const taskId = 'task-a';
    const workflowId = 'workflow-a';
    const visibleNode = (input = {}) => ({
      children: [], textContent: '', disabled: false,
      getBoundingClientRect: () => ({ width: 100, height: 20 }),
      getAttribute: () => null, querySelectorAll: () => [], ...input,
    });
    const projectLeaf = visibleNode({ textContent: projectName });
    const projectButton = visibleNode({ children: [projectLeaf] });
    const taskButton = visibleNode({ getAttribute: (name) => name === 'data-session-key' ? `scope::${taskId}` : null });
    const statusLeaf = visibleNode({ textContent: 'completed' });
    const controls = visibleNode({ querySelectorAll: (selector) => selector === 'span' ? [statusLeaf] : [] });
    const selectedWorkflow = visibleNode({ getAttribute: (name) => {
      if (name === 'data-workflow-id') return workflowId;
      if (name === 'aria-current') return 'true';
      return null;
    } });
    const visibleHeaderIdentity = visibleNode({ textContent: workflowId });
    const panel = visibleNode({ querySelectorAll: (selector) => {
      if (selector === '[data-testid="workflow-list-item"]') return [selectedWorkflow];
      if (selector === 'span') return [visibleHeaderIdentity];
      if (selector === '.sr-only') return [];
      return [];
    } });
    const currentWorkflow = visibleNode({ querySelectorAll: (selector) => {
      if (selector === '[data-testid="workflow-controls"]') return [controls];
      if (selector === '[data-testid="workflow-panel"]') return [panel];
      return [];
    } });
    const sidebar = visibleNode({ querySelectorAll: (selector) => {
      if (selector === '[data-project-search]') return [visibleNode()];
      if (selector === 'button') return [projectButton];
      if (selector === '[data-session-key]') return [taskButton];
      return [];
    } });
    const document = { querySelectorAll: (selector) => {
      if (selector === 'aside') return [sidebar];
      if (selector === '[data-testid="current-workflow"]') return [currentWorkflow];
      return [];
    } };
    const expression = restartScreenshotUiFactExpression(projectName, taskId, workflowId, 'completed');
    const fact = Function('document', 'getComputedStyle', `"use strict"; return (${expression});`)(document,
      () => ({ display: 'block', visibility: 'visible' }));
    assert(fact.workflowIdentityLeafCount === 1 && fact.selectedWorkflowListItemCount === 1,
      'Plan-tab visible Workflow identity was not bound without a Review-only marker.');
  });

  test('child environment removes fake and inherited backend credentials', () => {
    const fixture = {
      root: scratch,
      dataRoot: path.join(scratch, 'expected-data-root'),
      browserRoot: path.join(scratch, 'expected-browser-root'),
      claudeConfigRoot: path.join(scratch, 'expected-claude-root'),
      isolatedHome: path.join(scratch, 'isolated-home'),
      appData: path.join(scratch, 'app-data'),
      localAppData: path.join(scratch, 'local-app-data'),
      runtimeTemp: path.join(scratch, 'runtime-temp'),
      nativeDialogUserProfile: scratch,
    };
    for (const directory of [fixture.isolatedHome, fixture.appData, fixture.localAppData, fixture.runtimeTemp]) fs.mkdirSync(directory);
    const inherited = {
      FORCE_FAKE: '1', WORKBENCH_FORCE_FAKE_CLAUDE: '1', ANTHROPIC_API_KEY: 'secret',
      ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_BASE_URL: 'https://example.invalid',
      CLAUDE_CODE_OAUTH_TOKEN: 'secret', OPENAI_API_KEY: 'secret', DEEPSEEK_API_KEY: 'secret',
      CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1',
      AWS_PROFILE: 'host', AWS_DEFAULT_PROFILE: 'host', AWS_CONFIG_FILE: 'host',
      AWS_SHARED_CREDENTIALS_FILE: 'host', AWS_REGION: 'host', AWS_DEFAULT_REGION: 'host',
      AWS_ROLE_ARN: 'host', AWS_WEB_IDENTITY_TOKEN_FILE: 'host',
      GOOGLE_CLOUD_PROJECT: 'host', GOOGLE_CLOUD_LOCATION: 'host',
      ANTHROPIC_VERTEX_PROJECT_ID: 'host', ANTHROPIC_VERTEX_REGION: 'host',
      ANTHROPIC_FOUNDRY_RESOURCE: 'host', ANTHROPIC_FOUNDRY_API_KEY: 'secret',
      AZURE_API_KEY: 'secret', AZURE_OPENAI_API_KEY: 'secret', AZURE_OPENAI_ENDPOINT: 'host',
      AZURE_CLIENT_ID: 'host', AZURE_CLIENT_SECRET: 'secret', AZURE_TENANT_ID: 'host',
    };
    const child = buildChildEnvironment(inherited, fixture);
    for (const name of [
      'FORCE_FAKE', 'WORKBENCH_FORCE_FAKE_CLAUDE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY',
      'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
      'AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE',
      'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE',
      'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'ANTHROPIC_VERTEX_PROJECT_ID', 'ANTHROPIC_VERTEX_REGION',
      'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_FOUNDRY_API_KEY', 'AZURE_API_KEY', 'AZURE_OPENAI_API_KEY',
      'AZURE_OPENAI_ENDPOINT', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_TENANT_ID',
    ]) assert(child[name] === undefined, `${name} survived child-environment sanitization.`);
    assert(child.WORKBENCH_DATA_DIR === fixture.dataRoot, 'Workbench data root was not isolated.');
    assert(child.CLAUDE_CONFIG_DIR === fixture.claudeConfigRoot, 'Claude config root was not isolated.');
    assert(child.HOME === fixture.isolatedHome && child.USERPROFILE === fixture.isolatedHome,
      'Non-Electron child home was not isolated.');
    const electronChild = buildElectronChildEnvironment(inherited, fixture);
    assert(electronChild.HOME === fixture.nativeDialogUserProfile
      && electronChild.USERPROFILE === fixture.nativeDialogUserProfile,
    'Electron did not retain the real Windows profile required by native dialogs.');
    assert(electronChild.APPDATA === fixture.appData && electronChild.LOCALAPPDATA === fixture.localAppData
      && electronChild.TEMP === fixture.runtimeTemp && electronChild.TMP === fixture.runtimeTemp,
    'Electron app data or temp roots escaped isolation.');
    assert(electronChild.CLAUDE_CONFIG_DIR === fixture.claudeConfigRoot
      && electronChild.XDG_CONFIG_HOME === path.join(fixture.isolatedHome, '.config'),
    'Electron could inherit user Claude/config state.');
  });

  test('declares one real runtime and no gateway conversion', () => {
    assert(JSON.stringify(runtimeFacts()) === JSON.stringify({ runtime: 'ClaudeCliAdapter', gatewayConversion: false }),
      'Runtime facts are not the required closed pair.');
  });

  test('uses exact five-role Software Development map and permits one model for all tiers', () => {
    assert(JSON.stringify(exactPresetFacts()) === JSON.stringify({
      planner: 'high_quality', coder: 'balanced', tester: 'fast', reviewer: 'high_quality', fixer: 'balanced',
    }), 'Software Development role map drifted.');
    assert(JSON.stringify(bindOneModelForAllTiers({ providerId: 'provider-a', modelId: 'model-a' })) === JSON.stringify([
      ['high_quality', 'provider-a', 'model-a'], ['balanced', 'provider-a', 'model-a'], ['fast', 'provider-a', 'model-a'],
    ]), 'One-model-for-all tier binding is unavailable.');
  });

  test('excludes runtime=none DeepSeek from tier and Quick Switch candidates', () => {
    const candidates = eligibleTierCandidates([
      { providerId: 'a', modelId: 'a', runtimeType: 'claude-code' },
      { providerId: 'deepseek', modelId: 'deepseek-chat', runtimeType: 'none' },
    ]);
    assert(candidates.length === 1 && candidates[0].providerId === 'a', 'Management-only DeepSeek remained eligible.');
  });

  test('requires frozen current Workflow and changed next Workflow facts', () => {
    assert(assertWorkflowSelectionFacts({
      currentBefore: { coder: 'B', fixer: 'B' }, currentAfterGlobalChange: { coder: 'B', fixer: 'B' },
      next: { coder: 'A', fixer: 'A' }, uiFutureCallsOnly: true, runningSwitchBlockedUi: true,
      runningSwitchBlockedMain: true,
    }) === true, 'Valid frozen/current-next evidence was rejected.');
    expectThrow(() => assertWorkflowSelectionFacts({
      currentBefore: { coder: 'B', fixer: 'B' }, currentAfterGlobalChange: { coder: 'A', fixer: 'A' },
      next: { coder: 'A', fixer: 'A' }, uiFutureCallsOnly: true, runningSwitchBlockedUi: true,
      runningSwitchBlockedMain: true,
    }));
  });

  test('requires global/project/task source precedence and exact role resolution', () => {
    assert(assertPrecedenceFacts({
      roles: { planner: 'A', coder: 'B', tester: 'A', reviewer: 'A', fixer: 'B' },
      sequence: [['global_agent_policy', 'A'], ['project_policy', 'B'], ['task_override', 'A'],
        ['project_policy', 'B'], ['global_agent_policy', 'A']],
      tierSources: ['global', 'project'],
    }) === true, 'Valid precedence facts were rejected.');
    expectThrow(() => assertPrecedenceFacts({ roles: {}, sequence: [], tierSources: [] }));
  });

  test('reads authoritative tierSource strings for global/project precedence', () => {
    assert(tierSourceFact({ tier: 'balanced', tierSource: 'global' }) === 'global');
    assert(tierSourceFact({ tier: 'balanced', tierSource: 'project' }) === 'project');
    assert(tierSourceFact({ tier: undefined, tierSource: undefined }) === null);
    expectThrow(() => tierSourceFact({ tier: 'balanced', tierSource: undefined }));
  });

  test('requires provider-disabled blocking with no fallback or partial write', () => {
    assert(assertDisabledBindingFacts({ validity: 'needs_reconfiguration', reason: 'provider_disabled',
      previewBlocked: true, templateApplyBlocked: true, workflowBlocked: true,
      fallbackUsed: false, partialWrite: false }) === true,
    'Valid disabled-binding evidence was rejected.');
    expectThrow(() => assertDisabledBindingFacts({ validity: 'needs_reconfiguration', reason: 'provider_disabled',
      previewBlocked: true, templateApplyBlocked: true, workflowBlocked: true,
      fallbackUsed: true, partialWrite: false }));
  });

  test('closes disabled Provider diagnostics to exact tier counts, enums, and booleans', () => {
    const bindings = ['high_quality', 'balanced', 'fast'].map(() => ({
      validity: 'needs_reconfiguration', invalidReason: 'provider_disabled',
    }));
    const fact = closedDisabledBindingDiagnosticFact(bindings, {
      previewBlocked: true, templateApplyBlocked: true, workflowBlocked: true,
      workflowsUnchanged: true, fallbackUsed: false,
    });
    assert(JSON.stringify(fact) === JSON.stringify({ bindingCount: 3, validity: 'needs_reconfiguration',
      reason: 'provider_disabled', previewBlocked: true, templateApplyBlocked: true,
      workflowBlocked: true, fallbackUsed: false, partialWrite: false }));
    assert(assertDisabledBindingFacts(fact) === true);
    const unknown = closedDisabledBindingDiagnosticFact([
      { validity: 'private-validity', invalidReason: 'private-reason' },
    ], { previewBlocked: false, templateApplyBlocked: false, workflowBlocked: false,
      workflowsUnchanged: false, fallbackUsed: true });
    assert(!JSON.stringify(unknown).includes('private'), 'Raw disabled-binding diagnostic value escaped.');
  });

  test('blocks disabled-Provider template preview through prepare and exposes no fallback candidate', () => {
    const invalidRole = { resolution: { validity: 'needs_reconfiguration',
      invalidReason: 'provider_disabled', candidate: null } };
    const prepare = { step: 'bind_tiers', missingTiers: ['high_quality', 'balanced', 'fast'] };
    const preview = { roles: Object.fromEntries(ROLES.map((role) => [role, invalidRole])) };
    assert(assertDisabledTemplatePreviewFacts(prepare, preview) === true);
    expectThrow(() => assertDisabledTemplatePreviewFacts({ step: 'preview', preview }, preview));
    expectThrow(() => assertDisabledTemplatePreviewFacts({ step: 'bind_tiers', missingTiers: ['balanced'] }, preview));
    expectThrow(() => assertDisabledTemplatePreviewFacts(prepare, { roles: {
      ...preview.roles, coder: { resolution: { validity: 'valid', candidate: { providerId: 'fallback' } } },
    } }));
  });

  test('requires closed persisted Provider/model/source/execution/tier provenance', () => {
    const expected = { providerId: 'provider-b', modelId: 'model-b', source: 'global_agent_policy',
      executionSource: 'database_provider', tier: 'balanced', tierSource: 'global' };
    assert(assertPersistedSelection({ ...expected, runtimeType: 'claude-code' }, expected, 'Workflow A Coder'));
    for (const [key, value] of [['providerId', 'other'], ['modelId', 'other'], ['source', 'task_override'],
      ['executionSource', 'environment'], ['tier', 'fast'], ['tierSource', 'project']]) {
      expectThrow(() => assertPersistedSelection({ ...expected, runtimeType: 'claude-code', [key]: value }, expected, 'unsafe selection'));
    }
  });

  test('closes persisted selection diagnostics to A/B labels and provenance enums', () => {
    const identities = { providerA: 'provider-a', modelA: 'model-a', providerB: 'provider-b', modelB: 'model-b' };
    assert(JSON.stringify(closedSelectionDiagnosticFact({ providerId: 'provider-b', modelId: 'model-b',
      runtimeType: 'claude-code', source: 'global_agent_policy', executionSource: 'database_provider',
      tier: 'balanced', tierSource: 'global' }, identities)) === JSON.stringify({
      provider: 'B', model: 'B', runtimeType: 'claude-code', source: 'global_agent_policy',
      executionSource: 'database_provider', tier: 'balanced', tierSource: 'global',
    }));
    const unknown = closedSelectionDiagnosticFact({ providerId: 'private-provider', modelId: 'private-model',
      runtimeType: 'private-runtime', source: 'private-source', executionSource: 'private-execution',
      tier: 'private-tier', tierSource: 'private-tier-source' }, identities);
    assert(Object.values(unknown).every((value) => value === 'unknown'), 'Unknown selection values escaped the closed diagnostic boundary.');
  });

  test('production stage fixture preserves the protocol probe StructuredOutput contract', () => {
    const payload = stagePayload({ tools: [{ name: 'StructuredOutput', input_schema: {
      type: 'object', properties: { ok: { type: 'boolean', const: true } }, required: ['ok'],
    } }] }, { reviews: 0 });
    assert(payload?.structured?.ok === true, 'Production fixture cannot answer the bounded protocol probe.');
  });

  test('production stage fixture selects only the named StructuredOutput schema amid general tools', () => {
    const counters = { reviews: 0 };
    const payload = stagePayload({ tools: [
      { name: 'GeneralTool', input_schema: { type: 'object', properties: {
        commands: { type: 'array' }, skipped: { type: 'integer' },
      } } },
      { name: 'StructuredOutput', input_schema: { type: 'object', properties: {
        round: { type: 'integer' }, score: { type: 'number' }, issues: { type: 'array' }, tests: { type: 'object' },
      } } },
    ] }, counters);
    assert(Array.isArray(payload?.structured?.issues) && payload.structured.score === 7,
      'Reviewer request was misclassified by a general tool schema.');
    assert(counters.reviews === 1, 'Reviewer fixture branch did not execute exactly once.');
  });

  test('diagnostic boundary retains only closed protocol keys, branch, and error category', () => {
    const fact = diagnosticRequestFact({ secret: 'must-not-survive', tools: [{ name: 'StructuredOutput',
      input_schema: { type: 'object', properties: { filesExpected: { type: 'array' }, title: { type: 'string' } } } }],
    tool_choice: { type: 'tool', name: 'StructuredOutput' }, stream: true },
    { structured: { filesExpected: [], title: 'must-not-survive' } });
    assert(JSON.stringify(fact) === JSON.stringify({ topLevelKeys: ['secret', 'stream', 'tool_choice', 'tools'],
      toolNames: ['StructuredOutput'], toolChoiceType: 'tool', toolChoiceName: 'StructuredOutput',
      outputSchemaKeys: ['filesExpected', 'title'], responseFixtureBranch: 'planner' }));
    assert(!JSON.stringify(fact).includes('must-not-survive'));
    assert(closedErrorType('Workflow planner returned no structured output.') === 'missing_structured_output');
    assert(closedErrorType('opaque upstream wording') === 'unknown');
  });

  test('closes Workflow A terminal diagnostics and accepts only a completed Review-to-Fix loop', () => {
    const completed = closedWorkflowTerminalFact({ status: 'completed', reviewRound: 2, fixRound: 2, failure: null });
    assert(JSON.stringify(completed) === JSON.stringify({ status: 'completed', reviewRound: 2, fixRound: 2,
      failureCode: 'unknown' }));
    assert(assertWorkflowACompletionFact(completed) === true);
    for (const unsafe of [
      { status: 'failed', reviewRound: 1, fixRound: 1, failure: { code: 'AGENT_STAGE_FAILED' } },
      { status: 'executing', reviewRound: 2, fixRound: 2, failure: null },
      { status: 'completed', reviewRound: 1, fixRound: 1, failure: null },
    ]) expectThrow(() => assertWorkflowACompletionFact(closedWorkflowTerminalFact(unsafe)));
    assert(closedWorkflowTerminalFact({ status: 'private-upstream-status', failure: { code: 'private-code' } }).status === 'unknown');
  });

  test('uses the production First Run provider-navigation label', () => {
    assert(firstRunProviderConfigureLabel() === 'Configure models', 'First Run provider navigation label drifted.');
    assert(JSON.stringify(firstRunFlowLabels()) === JSON.stringify({ createProject: 'Create test project',
      generatePlan: 'Generate read-only plan', planReady: 'The plan is ready and waiting for your confirmation.',
      finish: 'Finish setup' }),
    'First Run project/task labels drifted.');
  });

  test('creates workflow tasks through the exact visible project-sidebar control and binds one new identity', () => {
    assert(JSON.stringify(visibleTaskCreationContract()) === JSON.stringify({
      rootSelector: 'aside:has([data-project-search])', accessibleName: '新建任务',
    }), 'Visible task creation control drifted.');
    assert(bindUniqueNewTaskId(['task-old'], ['task-old', 'task-new']) === 'task-new');
    expectThrow(() => bindUniqueNewTaskId(['task-old'], ['task-old']));
    expectThrow(() => bindUniqueNewTaskId(['task-old'], ['task-old', 'task-a', 'task-b']));
    expectThrow(() => bindUniqueNewTaskId(['task-old'], ['task-old', 'task-old']));
  });

  test('requires closed Main and owned-UI evidence for the First Run plan gate', () => {
    assert(assertFirstRunPlanEvidence({ workflowStatus: 'waiting_plan_confirmation',
      currentPermissionMode: 'plan', uiReady: true }));
    for (const unsafe of [
      { workflowStatus: 'failed', currentPermissionMode: 'plan', uiReady: true },
      { workflowStatus: 'waiting_plan_confirmation', currentPermissionMode: 'default', uiReady: true },
      { workflowStatus: 'waiting_plan_confirmation', currentPermissionMode: 'plan', uiReady: false },
    ]) expectThrow(() => assertFirstRunPlanEvidence(unsafe));
  });

  test('requires non-Git read-only First Run before visible Git initialization and Workflow A', () => {
    const valid = {
      firstRunStatus: 'waiting_plan_confirmation', permissionMode: 'plan', gitContextKind: 'not_repository',
      gitCheckpointTypes: [], initializationMethod: 'visible_ui', repositoryUiTrusted: true,
      phases: ['first_run_plan', 'first_run_finish', 'drawer_open', 'git_tab', 'git_initialize',
        'repository_ready', 'workflow_a_create'],
    };
    assert(assertFirstRunGitInitializationFacts(valid));
    expectThrow(() => assertFirstRunGitInitializationFacts({ ...valid, gitContextKind: 'repository' }));
    expectThrow(() => assertFirstRunGitInitializationFacts({ ...valid, gitCheckpointTypes: ['before_plan'] }));
    expectThrow(() => assertFirstRunGitInitializationFacts({ ...valid, initializationMethod: 'main_api' }));
    expectThrow(() => assertFirstRunGitInitializationFacts({ ...valid,
      phases: ['first_run_plan', 'first_run_finish', 'workflow_a_create', 'git_initialize', 'repository_ready'] }));
  });

  test('wraps the First Run project query in an async expression', () => {
    const expression = firstRunProjectQueryExpression();
    assert(expression.startsWith('(async () =>') && expression.endsWith(')()'), 'First Run project query is not an async IIFE.');
    assert(typeof new Function(`return ${expression}`) === 'function', 'First Run project query is not valid expression syntax.');
  });

  test('rejects renderer evaluation await outside an async IIFE', () => {
    assert(assertEvaluationAwaitBoundary(`(() => document.title)()`));
    assert(assertEvaluationAwaitBoundary(`(async () => await window.api.listProjects())()`));
    expectThrow(() => assertEvaluationAwaitBoundary(`await window.api.listProjects()`));
    expectThrow(() => assertEvaluationAwaitBoundary(`(() => await window.api.listProjects())()`));
  });

  test('selects UI buttons only by an owned exact accessible name or explicit prefix', () => {
    const buttons = [{ owner: 'first-run', accessibleName: 'Continue' },
      { owner: 'nested', accessibleName: 'Continue' },
      { owner: 'first-run', accessibleName: 'Continue with Test Project' }];
    assert(selectOwnedUiButtonFact('first-run', buttons, 'Continue', false).accessibleName === 'Continue');
    assert(selectOwnedUiButtonFact('first-run', buttons, 'Continue with', true).accessibleName === 'Continue with Test Project');
    expectThrow(() => selectOwnedUiButtonFact('first-run', buttons, 'Continue', true));
    expectThrow(() => selectOwnedUiButtonFact('first-run', [...buttons,
      { owner: 'first-run', accessibleName: 'Continue' }], 'Continue', false));
  });

  test('scopes preset modal buttons by exact dialog title and exact button text', () => {
    const dialogs = [{ id: 'settings', headings: [{ text: 'Settings', owner: 'settings' },
      { text: 'Apply template preview', owner: 'preview' }], buttons: ['Apply template', 'Apply template'] },
    { id: 'preview', headings: [{ text: 'Apply template preview', owner: 'preview' }], buttons: ['Cancel', 'Modify tiers', 'Apply'] }];
    assert(selectExactDialogButtonFact(dialogs, 'Apply template preview', 'Apply') === 'Apply');
    expectThrow(() => selectExactDialogButtonFact(dialogs, 'Settings', 'Apply'));
    expectThrow(() => selectExactDialogButtonFact([...dialogs,
      { id: 'preview-two', headings: [{ text: 'Apply template preview', owner: 'preview-two' }], buttons: ['Apply'] }],
    'Apply template preview', 'Apply'));
  });

  test('waits for exactly one enabled button owned by the exact modal', () => {
    const dialogs = [{ id: 'settings', headings: [{ text: 'Configure model tiers', owner: 'wizard' }],
      buttons: [{ text: 'Use this model for all tiers', owner: 'wizard', disabled: false }] },
    { id: 'wizard', headings: [{ text: 'Configure model tiers', owner: 'wizard' }],
      buttons: [{ text: 'Use this model for all tiers', owner: 'wizard', disabled: false }] }];
    assert(selectReadyExactDialogButtonFact(dialogs, 'Configure model tiers', 'Use this model for all tiers').owner === 'wizard');
    expectThrow(() => selectReadyExactDialogButtonFact([{ ...dialogs[1], buttons: [
      { text: 'Use this model for all tiers', owner: 'wizard', disabled: true },
    ] }], 'Configure model tiers', 'Use this model for all tiers'));
    expectThrow(() => selectReadyExactDialogButtonFact([{ ...dialogs[1], buttons: [
      { text: 'Use this model for all tiers', owner: 'wizard', disabled: false },
      { text: 'Use this model for all tiers', owner: 'wizard', disabled: false },
    ] }], 'Configure model tiers', 'Use this model for all tiers'));
  });

  test('requires Provider A to be the sole candidate before bind-all wizard', () => {
    assertSoleTierCandidate([{ providerId: 'provider-a', modelId: 'model-a' }], 'provider-a', 'model-a');
    expectThrow(() => assertSoleTierCandidate([{ providerId: 'provider-a', modelId: 'model-a' },
      { providerId: 'synthetic', modelId: 'default' }], 'provider-a', 'model-a'));
  });

  test('closes only the Settings-owned exact accessible Close button', () => {
    const facts = { id: 'settings', buttons: [{ owner: 'settings', accessibleName: 'Close' },
      { owner: 'child', accessibleName: 'Close' }] };
    assert(selectExactOwnedAccessibleButtonFact(facts, 'Close').owner === 'settings');
    expectThrow(() => selectExactOwnedAccessibleButtonFact({ id: 'settings', buttons: [
      { owner: 'settings', accessibleName: 'Close' }, { owner: 'settings', accessibleName: 'Close' },
    ] }, 'Close'));
  });

  test('requires diagnostics default-off absence and opt-in closed anonymous schema', () => {
    assert(assertDiagnosticsFacts({
      off: { manifest: { includeAnonymousPerformanceData: false }, entryNames: ['manifest.json'] },
      on: { manifest: { includeAnonymousPerformanceData: true }, aggregate: {
        schemaVersion: 1,
        operations: {
          direct: { total: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0 },
          orchestrated: { total: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0 },
        },
        durationBuckets: {
          underOneSecond: 0,
          oneToTenSeconds: 0,
          tenToSixtySeconds: 0,
          oneToTenMinutes: 0,
          tenMinutesOrMore: 0,
        },
      } },
    }) === true, 'Valid diagnostics off/on evidence was rejected.');
    expectThrow(() => assertDiagnosticsFacts({ off: { manifest: { includeAnonymousPerformanceData: false }, entryNames: ['anonymous-performance.json'] }, on: {} }));
  });

  test('binds exact native dialog PID/class/title/Edit/known-folder identity and fails closed on ambiguity', () => {
    const requestedAt = Date.UTC(2026, 7, 9, 0, 0, 0, 0);
    const bound = bindNativeDialogCandidate({ expectedPid: 101, requestedAt, now: requestedAt + 1_000, dialogs: [{
      pid: 101, className: '#32770', title: DIAGNOSTICS_TITLE, hwnd: 7,
      filenameControls: [{ pid: 101, automationId: '1001', controlType: 'Edit', supportsValuePattern: true,
        value: 'ClaudeWorkbench-diagnostics-2026-08-09T00-00-00-000Z.zip' }],
      saveControls: [{ pid: 101, automationId: '1', controlType: 'Button', hwnd: 8, name: 'Save' }],
    }], knownFolderSource: 'SHGetKnownFolderPath(FOLDERID_Documents)', targetExisted: false });
    assert(bound && bound.dialogHwnd === 7 && bound.saveHwnd === 8, 'Exact native dialog was not bound.');
    expectThrow(() => bindNativeDialogCandidate({ expectedPid: 101, requestedAt, now: requestedAt + 1_000, dialogs: [bound, bound], knownFolderSource: 'SHGetKnownFolderPath(FOLDERID_Documents)', targetExisted: false }));
  });

  test('native dialog binding rejects every identity/control/filename ambiguity', () => {
    const requestedAt = Date.UTC(2026, 7, 9, 0, 0, 0, 0);
    const edit = { pid: 101, automationId: '1001', controlType: 'Edit', supportsValuePattern: true,
      value: 'ClaudeWorkbench-diagnostics-2026-08-09T00-00-00-000Z.zip' };
    const save = { pid: 101, automationId: '1', controlType: 'Button', hwnd: 8, name: 'Save' };
    const dialog = { pid: 101, className: '#32770', title: DIAGNOSTICS_TITLE, hwnd: 7,
      filenameControls: [edit], saveControls: [save] };
    const input = { expectedPid: 101, requestedAt, now: requestedAt + 1_000, dialogs: [dialog],
      knownFolderSource: 'SHGetKnownFolderPath(FOLDERID_Documents)', targetExisted: false };
    for (const changed of [
      { ...dialog, pid: 102 },
      { ...dialog, className: '#other' },
      { ...dialog, title: 'Save As' },
      { ...dialog, hwnd: 0 },
      { ...dialog, filenameControls: [] },
      { ...dialog, filenameControls: [edit, { ...edit }] },
      { ...dialog, filenameControls: [{ ...edit, automationId: '999' }] },
      { ...dialog, filenameControls: [{ ...edit, supportsValuePattern: false }] },
      { ...dialog, filenameControls: [{ ...edit, value: '..\\unsafe.zip' }] },
      { ...dialog, filenameControls: [{ ...edit, value: 'C:unsafe.zip' }] },
      { ...dialog, filenameControls: [{ ...edit, value: 'diagnostics.zip' }] },
      { ...dialog, filenameControls: [{ ...edit, value: 'ClaudeWorkbench-diagnostics-2026-08-08T00-00-00-000Z.zip' }] },
      { ...dialog, saveControls: [] },
      { ...dialog, saveControls: [save, { ...save, hwnd: 9 }] },
      { ...dialog, saveControls: [{ ...save, hwnd: 0 }] },
    ]) expectThrow(() => bindNativeDialogCandidate({ ...input, dialogs: [changed] }));
    expectThrow(() => bindNativeDialogCandidate({ ...input, targetExisted: true }));
    expectThrow(() => bindNativeDialogCandidate({ ...input, knownFolderSource: 'USERPROFILE/Documents' }));
  });

  test('Win32 native discovery accepts one exact visible PID/class/title HWND and fails closed otherwise', () => {
    const exact = { pid: 101, className: '#32770', title: DIAGNOSTICS_TITLE, hwnd: 7, visible: true };
    const unrelated = [
      { ...exact, pid: 102, hwnd: 8 }, { ...exact, className: '#other', hwnd: 9 },
      { ...exact, title: 'Save As', hwnd: 10 }, { ...exact, visible: false, hwnd: 11 },
      { ...exact, hwnd: 0 },
    ];
    assert(selectExactVisibleNativeWindowFact([...unrelated, exact], 101, DIAGNOSTICS_TITLE).hwnd === 7);
    expectThrow(() => selectExactVisibleNativeWindowFact(unrelated, 101, DIAGNOSTICS_TITLE));
    expectThrow(() => selectExactVisibleNativeWindowFact([exact, { ...exact, hwnd: 12 }], 101, DIAGNOSTICS_TITLE));
  });

  test('Root UIA provider projection binds one same-HWND exact dialog and revalidates Win32 identity', () => {
    const bound = { pid: 101, className: '#32770', title: DIAGNOSTICS_TITLE, hwnd: 7, visible: true };
    const unrelated = [{ ...bound, pid: 102, hwnd: 8 }, { ...bound, className: '#other', hwnd: 9 },
      { ...bound, title: 'Save As', hwnd: 10 }];
    assert(selectSameHwndRootDialogFact([...unrelated, bound], bound, [bound]).hwnd === 7);
    expectThrow(() => selectSameHwndRootDialogFact(unrelated, bound, [bound]));
    expectThrow(() => selectSameHwndRootDialogFact([bound, { ...bound }], bound, [bound]));
    expectThrow(() => selectSameHwndRootDialogFact([bound], bound, [{ ...bound, hwnd: 12 }]));
  });

  test('native controls bind one exact filename Edit and anchored localized Save button', () => {
    const filename = { pid: 101, automationId: '1001', controlType: 'Edit', supportsValuePattern: true,
      value: 'ClaudeWorkbench-diagnostics-2026-08-09T00-00-00-000Z.zip' };
    const unrelatedEdit = { ...filename, automationId: 'search' };
    const save = { pid: 101, automationId: '1', controlType: 'Button', hwnd: 8, name: '保存(S)' };
    const bound = selectNativeDialogControlsFact([unrelatedEdit, filename, save], 101);
    assert(bound.filename === filename && bound.save === save, 'Exact native controls were not bound.');
    assert(selectNativeDialogControlsFact([filename, { ...save, name: 'Save' }], 101).save.name === 'Save');
    for (const controls of [
      [unrelatedEdit, save], [filename, { ...filename }, save],
      [{ ...filename, pid: 102 }, save], [{ ...filename, supportsValuePattern: false }, save],
      [filename, { ...save, pid: 102 }], [filename, { ...save, automationId: '2' }],
      [filename, { ...save, controlType: 'Text' }], [filename, { ...save, hwnd: 0 }],
      [filename, { ...save, name: 'Save as' }], [filename, save, { ...save, name: 'Save(S)' }],
    ]) expectThrow(() => selectNativeDialogControlsFact(controls, 101));
  });

  test('native discovery diagnostics retain only eight fixed nonnegative window counts', () => {
    const input = { topLevel: { visible: 4, class32770: 1, exactTitle: 1, exactBoth: 0 },
      children: { visible: 12, class32770: 0, exactTitle: 0, exactBoth: 0 } };
    const fact = closedNativeWindowDiscoveryFact(input);
    assert(JSON.stringify(fact) === JSON.stringify(input), 'Closed native discovery counts changed.');
    expectThrow(() => closedNativeWindowDiscoveryFact({ ...input, pid: 101 }));
    expectThrow(() => closedNativeWindowDiscoveryFact({ ...input,
      children: { ...input.children, exactBoth: -1 } }));
  });

  test('tagged Electron diagnostic retains only fixed process-role counts and expected-main boolean', () => {
    const input = { taggedRoots: 1, main: 1, renderer: 2, utility: 3, other: 1, expectedLaunchPidIsMain: true };
    const fact = closedTaggedElectronRoleFact(input);
    assert(JSON.stringify(fact) === JSON.stringify(input), 'Closed tagged Electron role counts changed.');
    expectThrow(() => closedTaggedElectronRoleFact({ ...input, commandLine: 'private' }));
    expectThrow(() => closedTaggedElectronRoleFact({ ...input, renderer: 1.5 }));
  });

  test('native control diagnostics retain only fixed staged exact-dialog counts', () => {
    const input = {
      totalDescendants: 20, expectedPidDescendants: 18,
      edit: { total: 2, id1001: 1, id1001Value: 1, id1001ValueVisible: 1,
        expectedPidTotal: 2, expectedPidId1001: 1, expectedPidId1001Value: 1, expectedPidId1001ValueVisible: 1 },
      save: { button: 4, buttonId1: 1, buttonId1AnchoredName: 1, buttonId1AnchoredNamePositiveHwnd: 1,
        expectedPidButton: 4, expectedPidButtonId1: 1, expectedPidButtonId1AnchoredName: 1,
        expectedPidButtonId1AnchoredNamePositiveHwnd: 1 },
    };
    const fact = closedNativeControlDiscoveryFact(input);
    assert(JSON.stringify(fact) === JSON.stringify(input), 'Closed native control counts changed.');
    expectThrow(() => closedNativeControlDiscoveryFact({ ...input, automationId: '1001' }));
    expectThrow(() => closedNativeControlDiscoveryFact({ ...input,
      edit: { ...input.edit, expectedPidId1001Value: -1 } }));
  });

  test('native dialog-ID diagnostics retain only fixed recursive containment counts', () => {
    const input = { id1001: { id: 1, visible: 1, expectedPid: 1, contained: 1 },
      id1: { id: 1, visible: 1, expectedPid: 1, contained: 1 } };
    const fact = closedNativeControlIdDiscoveryFact(input);
    assert(JSON.stringify(fact) === JSON.stringify(input), 'Closed native control-ID counts changed.');
    expectThrow(() => closedNativeControlIdDiscoveryFact({ ...input, hwnd: 7 }));
    expectThrow(() => closedNativeControlIdDiscoveryFact({ ...input,
      id1001: { ...input.id1001, contained: -1 } }));
  });

  test('native/UIA joint diagnostics retain only fixed final-predicate counts', () => {
    const input = {
      id1001: { nativeCandidates: 2, uiaNonnull: 2, nativeRevalidated: 2, edit: 1, valuePattern: 1,
        visibleEnabled: 1, canonicalBasename: 1, freshRoundTrip: 1, targetAbsent: 1 },
      id1: { nativeCandidates: 1, uiaNonnull: 1, nativeRevalidated: 1, button: 1, anchoredName: 1, positiveHwnd: 1 },
    };
    const fact = closedNativeJointControlDiscoveryFact(input);
    assert(JSON.stringify(fact) === JSON.stringify(input), 'Closed native/UIA joint counts changed.');
    expectThrow(() => closedNativeJointControlDiscoveryFact({ ...input, value: 'private' }));
    expectThrow(() => closedNativeJointControlDiscoveryFact({ ...input,
      id1: { ...input.id1, anchoredName: -1 } }));
  });

  test('pure Win32 control diagnostics retain only fixed class/text predicate counts', () => {
    const input = {
      direct1001: { nativeCandidates: 2, visibleEnabled: 2, classEdit: 0, canonicalFreshText: 0 },
      descendant1001: { containers: 2, nativeDescendants: 3, expectedPidContained: 3,
        classEdit: 1, visibleEnabled: 1, canonicalFreshText: 1 },
      mergedFilename: { canonicalFreshCandidates: 1 },
      id1: { nativeCandidates: 1, visibleEnabled: 1, classButton: 1, anchoredText: 1 },
    };
    const fact = closedNativeWin32JointDiscoveryFact(input);
    assert(JSON.stringify(fact) === JSON.stringify(input), 'Closed pure Win32 joint counts changed.');
    expectThrow(() => closedNativeWin32JointDiscoveryFact({ ...input, text: 'private' }));
    expectThrow(() => closedNativeWin32JointDiscoveryFact({ ...input,
      mergedFilename: { canonicalFreshCandidates: -1 } }));
  });

  test('bounded native Edit text diagnostics retain only fixed read/revalidation counts', () => {
    const input = { nativeEditCandidates: 1, preRevalidated: 1, lengthRead: 1, lengthWithinBound: 1,
      textRead: 1, postRevalidated: 1, canonicalBasename: 1, freshRoundTrip: 1, targetAbsent: 1 };
    const fact = closedNativeBoundedTextDiscoveryFact(input);
    assert(JSON.stringify(fact) === JSON.stringify(input), 'Closed bounded native-text counts changed.');
    expectThrow(() => closedNativeBoundedTextDiscoveryFact({ ...input, value: 'private' }));
    expectThrow(() => closedNativeBoundedTextDiscoveryFact({ ...input, textRead: -1 }));
  });

  test('native save operation binds only the exact revalidated Edit and Save chain', () => {
    const requestedAt = Date.UTC(2026, 7, 9, 0, 0, 0, 0);
    const edit = { pid: 101, hwnd: 8, controlId: 1001, nativeClass: 'Edit', visible: true, enabled: true,
      contained: true, preRevalidated: true, boundedTextRead: true, postRevalidated: true,
      beforeActionRevalidated: true, targetAbsent: true,
      value: 'ClaudeWorkbench-diagnostics-2026-08-09T00-00-00-000Z.zip' };
    const save = { pid: 101, hwnd: 9, controlId: 1, nativeClass: 'Button', visible: true, enabled: true,
      contained: true, nativeText: 'Save(S)', preRevalidated: true, beforeActionRevalidated: true };
    const input = { expectedPid: 101, requestedAt, now: requestedAt + 1_000,
      knownFolderSource: 'SHGetKnownFolderPath(FOLDERID_Documents)', targetExisted: false,
      dialogs: [{ pid: 101, hwnd: 7, className: '#32770', title: DIAGNOSTICS_TITLE, visible: true,
        editControls: [edit], saveControls: [save] }],
      action: { dialogBeforeActionRevalidated: true, boundedBmClick: true, fallback: 'not_needed', fallbackRevalidated: null,
        boundedWmCommand: null, dialogClosed: true } };
    const bound = bindNativeSaveOperationFact(input);
    assert(bound.dialogHwnd === 7 && bound.editHwnd === 8 && bound.saveHwnd === 9,
      'Exact native save-operation chain was not bound.');
    assert(bindNativeSaveOperationFact({ ...input, action: { ...input.action,
      fallback: 'same_dialog_wm_command', fallbackRevalidated: true, boundedWmCommand: true,
      dialogClosed: true } }).saveHwnd === 9, 'Revalidated same-dialog fallback was rejected.');
    for (const changed of [
      { ...edit, pid: 102 }, { ...edit, hwnd: 0 }, { ...edit, controlId: 1002 },
      { ...edit, nativeClass: 'ComboBox' }, { ...edit, visible: false }, { ...edit, enabled: false },
      { ...edit, contained: false }, { ...edit, preRevalidated: false }, { ...edit, boundedTextRead: false },
      { ...edit, postRevalidated: false }, { ...edit, beforeActionRevalidated: false },
      { ...edit, targetAbsent: false }, { ...edit, value: '..\\unsafe.zip' },
    ]) expectThrow(() => bindNativeSaveOperationFact({ ...input, dialogs: [{ ...input.dialogs[0], editControls: [changed] }] }));
    for (const changed of [
      { ...save, pid: 102 }, { ...save, hwnd: 0 }, { ...save, controlId: 2 },
      { ...save, nativeClass: 'Text' }, { ...save, visible: false }, { ...save, enabled: false },
      { ...save, contained: false }, { ...save, nativeText: 'Save as' },
      { ...save, preRevalidated: false }, { ...save, beforeActionRevalidated: false },
    ]) expectThrow(() => bindNativeSaveOperationFact({ ...input, dialogs: [{ ...input.dialogs[0], saveControls: [changed] }] }));
    expectThrow(() => bindNativeSaveOperationFact({ ...input,
      dialogs: [{ ...input.dialogs[0], editControls: [edit, { ...edit, hwnd: 10 }] }] }));
    expectThrow(() => bindNativeSaveOperationFact({ ...input,
      dialogs: [{ ...input.dialogs[0], saveControls: [save, { ...save, hwnd: 10 }] }] }));
    expectThrow(() => bindNativeSaveOperationFact({ ...input,
      dialogs: [{ ...input.dialogs[0], saveControls: [save, { ...save, hwnd: 10, nativeClass: 'Text' }] }] }));
    for (const action of [
      { ...input.action, dialogBeforeActionRevalidated: false },
      { ...input.action, boundedBmClick: false },
      { ...input.action, fallback: 'same_dialog_wm_command', fallbackRevalidated: false, boundedWmCommand: true },
      { ...input.action, fallback: 'same_dialog_wm_command', fallbackRevalidated: true, boundedWmCommand: false },
      { ...input.action, fallback: 'other_dialog', fallbackRevalidated: true, boundedWmCommand: true },
      { ...input.action, dialogClosed: false },
    ]) expectThrow(() => bindNativeSaveOperationFact({ ...input, action }));
  });

  test('large Unicode native helper scripts travel on stdin and never in child arguments', () => {
    const source = `保存-${'x'.repeat(40_000)}`;
    const invocation = powerShellStdinInvocationFact(source);
    assert(Buffer.isBuffer(invocation.stdin) && invocation.stdin.toString('utf16le') === source,
      'PowerShell helper stdin did not retain exact Unicode source.');
    assert(invocation.args.at(-2) === '-Command' && typeof invocation.args.at(-1) === 'string',
      'PowerShell helper did not use the bounded stdin decoder command.');
    assert(!invocation.args.join(' ').includes(source.slice(0, 16)) && invocation.args.join(' ').length < 2_000,
      'PowerShell helper source leaked into or overflowed child arguments.');
  });

  test('PowerShell stdin transport executes exact Unicode source in a real child', async () => {
    assert(await runPowerShellStdinTransportSelfTest() === 'CW_BETA_STDIN_OK=保存',
      'PowerShell stdin transport did not execute exact Unicode source.');
  });

  test('real owned Win32 controls accept only bounded BM_CLICK and WM_COMMAND fallback messages', async () => {
    const result = await runBoundedNativeMessageSelfTest();
    assert(JSON.stringify(result) === JSON.stringify({ bmClick: true, wmCommand: true }),
      'Real bounded native-message self-test did not exercise both save branches.');
  });

  test('pre-click basename gate requires canonical date round-trip and freshness', () => {
    const requestedAt = Date.UTC(2026, 7, 9, 0, 0, 0, 0);
    assert(validateNativePreClickBasename('ClaudeWorkbench-diagnostics-2026-08-09T00-00-00-000Z.zip', requestedAt, requestedAt + 500));
    for (const unsafe of [
      'ClaudeWorkbench-diagnostics-2026-02-30T00-00-00-000Z.zip',
      'ClaudeWorkbench-diagnostics-2026-08-08T00-00-00-000Z.zip',
      'ClaudeWorkbench-diagnostics-2026-08-09T00-00-00-000Z.zip:stream',
    ]) expectThrow(() => validateNativePreClickBasename(unsafe, requestedAt, requestedAt + 500));
  });

  test('native failure cleanup targets only the exact verified dialog identity', () => {
    const expected = { pid: 101, className: '#32770', title: DIAGNOSTICS_TITLE, hwnd: 7 };
    assert(selectExactDialogForClose([expected], expected).hwnd === 7);
    for (const changed of [{ ...expected, pid: 102 }, { ...expected, className: '#other' },
      { ...expected, title: 'Save As' }, { ...expected, hwnd: 0 }]) {
      expectThrow(() => selectExactDialogForClose([changed], expected));
    }
    expectThrow(() => selectExactDialogForClose([expected, { ...expected }], expected));
  });

  test('closes native-helper failures to fixed categories without retaining stderr or paths', () => {
    const cases = [
      ['verified diagnostics dialog missing', 'dialog_missing'],
      ['filename edit ambiguity', 'filename_edit_ambiguous'],
      ['filename edit id mismatch', 'filename_edit_identity'],
      ['verified save ambiguity', 'save_control_ambiguous'],
      ['unsafe diagnostics basename', 'unsafe_basename'],
      ['noncanonical or stale diagnostics basename', 'stale_basename'],
      ['known Documents folder unavailable', 'known_folder_unavailable'],
      ['diagnostics target already exists', 'target_exists'],
      ['verified BM_CLICK failed', 'save_click_failed'],
      ['dialog identity changed before WM_COMMAND fallback', 'dialog_identity_changed'],
      ['verified diagnostics dialog did not close', 'dialog_close_failed'],
    ];
    for (const [raw, expected] of cases) assert(closedNativeHelperFailureCategory(raw) === expected);
    const unknown = closedNativeHelperFailureCategory('private raw C:\\Users\\person\\Documents\\secret.zip');
    assert(unknown === 'unknown' && !unknown.includes('secret'), 'Raw native helper failure escaped the closed category.');
  });

  test('closes native helper and diagnostics API joint settlement without retaining rejection data', () => {
    const helperError = new Error('private helper detail');
    helperError.nativeFailureCategory = 'dialog_missing';
    const rejected = closedNativeExportSettlementFact([
      { status: 'rejected', reason: helperError }, { status: 'rejected', reason: new Error('private api detail') },
    ]);
    assert(JSON.stringify(rejected) === JSON.stringify({ helper: 'dialog_missing', api: 'rejected' }));
    assert(closedNativeExportSettlementFact([{ status: 'fulfilled', value: {} }, { status: 'fulfilled', value: null }]).api === 'null');
    assert(closedNativeExportSettlementFact([{ status: 'fulfilled', value: {} }, { status: 'fulfilled', value: true }]).api === 'true');
    assert(!JSON.stringify(rejected).includes('private'), 'Raw joint-settlement rejection escaped.');
  });

  test('independent bounded dialog cleanup tolerates no exact PID/class/title match', async () => {
    const result = await runIndependentDialogCleanup(2_147_483_647);
    assert(result.matched === 0 && result.closed === true, 'Independent exact-dialog cleanup did not fail closed.');
  });

  test('post-save failure cleanup retains and deletes only the immediately bound candidate', async () => {
    const target = path.join(scratch, 'post-save-bound.zip');
    fs.writeFileSync(target, 'bound-zip', 'utf8');
    const identity = snapshotBoundFile(target);
    await expectRejectWithBoundCleanup(async () => {
      throw new Error('post-save extraction failed');
    }, { path: target, identity, ambiguous: false });
    assert(!fs.existsSync(target), 'Immediately bound post-save candidate was not deleted after failure.');
  });

  test('fresh exact candidate binding hashes full identity and failure cleanup preserves every unbound file', async () => {
    const requestedAt = Date.now();
    const target = path.join(scratch, 'fresh-bound.zip');
    const unbound = path.join(scratch, 'unbound-preserved.zip');
    fs.writeFileSync(target, 'fresh-bound-zip', 'utf8');
    fs.writeFileSync(unbound, 'unbound-zip', 'utf8');
    const identity = snapshotFreshBoundFile(target, requestedAt, Date.now() + 1_000);
    assert(Object.keys(identity).sort().join(',') ===
      'birthtimeMs,ctimeMs,dev,ino,mtimeMs,nlink,sha256,size', 'Fresh bound identity fields drifted.');
    await expectRejectWithBoundCleanup(async () => { throw new Error('fixed post-save failure'); },
      { path: target, identity, ambiguous: false });
    assert(!fs.existsSync(target) && fs.existsSync(unbound),
      'Exact cleanup deleted an unbound file or retained the exact bound file.');
    const stale = path.join(scratch, 'stale-preserved.zip');
    fs.writeFileSync(stale, 'stale', 'utf8');
    expectThrow(() => snapshotFreshBoundFile(stale, Date.now() + 60_000, Date.now() + 61_000));
    assert(fs.existsSync(stale), 'Unbound stale candidate was deleted.');
    const oversized = path.join(scratch, 'oversized-preserved.zip');
    fs.writeFileSync(oversized, 'x', 'utf8');
    fs.truncateSync(oversized, (12 * 1024 * 1024) + 1);
    expectThrow(() => snapshotFreshBoundFile(oversized, requestedAt, Date.now() + 1_000));
    assert(fs.existsSync(oversized), 'Oversized unbound candidate was deleted.');
  });

  test('returned native candidate uses one absolute exact KnownFolder join and binds delayed creation without scanning', async () => {
    const requestedAt = Date.now();
    const filename = `ClaudeWorkbench-diagnostics-${new Date(requestedAt).toISOString().replace(/[:.]/gu, '-')}.zip`;
    const documents = path.join(scratch, 'exact-documents');
    fs.mkdirSync(documents);
    const target = path.join(documents, filename);
    assertExactKnownFolderCandidatePath({ documents, target, filename });
    expectThrow(() => assertExactKnownFolderCandidatePath({ documents, target: path.join(scratch, filename), filename }));
    expectThrow(() => assertExactKnownFolderCandidatePath({ documents: 'relative-documents', target, filename }));
    const timer = setTimeout(() => fs.writeFileSync(target, 'delayed-exact-zip', 'utf8'), 20);
    const candidate = await waitForFreshExactCandidate(target, requestedAt, 2_000);
    clearTimeout(timer);
    assert(candidate.path === target && candidate.ambiguous === false, 'Delayed exact candidate was not bound.');
    assert(deleteBoundFile(candidate) === true && !fs.existsSync(target), 'Exact returned candidate was not cleaned.');
  });

  test('diagnostics ZIP policy rejects symlink, traversal, duplicate, oversized, and extracted reparse entries', () => {
    assert(crc32Buffer(Buffer.from('123456789', 'utf8')) === 0xcbf43926,
      'Diagnostics ZIP CRC32 validation primitive drifted.');
    const required = ['manifest.json', 'version.json', 'system.json', 'database-summary.json', 'error-summary.json'];
    const policy = createDiagnosticsArchivePolicy(false);
    for (const fileName of [...required, 'logs/app.log']) {
      acceptDiagnosticsArchiveEntry(policy, { fileName, uncompressedSize: 16,
        externalFileAttributes: 0, versionMadeBy: 20 });
    }
    assert(finalizeDiagnosticsArchivePolicy(policy).entryNames.length === 6, 'Safe diagnostics ZIP entries were rejected.');
    for (const unsafe of [
      { fileName: 'manifest.json', uncompressedSize: 1, externalFileAttributes: (0o120777 << 16) >>> 0,
        versionMadeBy: (3 << 8) | 20 },
      { fileName: 'manifest.json', uncompressedSize: 1, externalFileAttributes: 0x10, versionMadeBy: 20 },
      { fileName: '../manifest.json', uncompressedSize: 1, externalFileAttributes: 0, versionMadeBy: 20 },
      { fileName: 'logs\\app.log', uncompressedSize: 1, externalFileAttributes: 0, versionMadeBy: 20 },
      { fileName: 'logs/app.log', uncompressedSize: (2 * 1024 * 1024) + 1,
        externalFileAttributes: 0, versionMadeBy: 20 },
    ]) expectThrow(() => acceptDiagnosticsArchiveEntry(createDiagnosticsArchivePolicy(false), unsafe));
    const duplicate = createDiagnosticsArchivePolicy(false);
    acceptDiagnosticsArchiveEntry(duplicate, { fileName: 'manifest.json', uncompressedSize: 1,
      externalFileAttributes: 0, versionMadeBy: 20 });
    expectThrow(() => acceptDiagnosticsArchiveEntry(duplicate, { fileName: 'manifest.json', uncompressedSize: 1,
      externalFileAttributes: 0, versionMadeBy: 20 }));

    const extracted = path.join(scratch, 'safe-extracted-diagnostics');
    fs.mkdirSync(path.join(extracted, 'logs'), { recursive: true });
    for (const fileName of required) fs.writeFileSync(path.join(extracted, fileName), '{}', 'utf8');
    fs.writeFileSync(path.join(extracted, 'logs', 'app.log'), '{}', 'utf8');
    assert(assertExtractedDiagnosticsTree(extracted, [...required, 'logs/app.log']) === true,
      'Safe extracted diagnostics tree was rejected.');
    const outside = path.join(scratch, 'outside-extracted-logs');
    fs.mkdirSync(outside);
    fs.rmSync(path.join(extracted, 'logs'), { recursive: true, force: false });
    fs.symlinkSync(outside, path.join(extracted, 'logs'), 'junction');
    expectThrow(() => assertExtractedDiagnosticsTree(extracted, required));
  });

  test('actual stored-ZIP preflight and full inspection reject truncated, CRC, local-header, path, reparse, and size attacks', async () => {
    const entries = [
      ['manifest.json', { includeAnonymousPerformanceData: false }],
      ['version.json', {}], ['system.json', {}], ['database-summary.json', {}], ['error-summary.json', {}],
    ].map(([name, value]) => ({ name, content: Buffer.from(JSON.stringify(value), 'utf8'), externalFileAttributes: 0 }));
    const safeBytes = buildStoredDiagnosticsZipFixture(entries);
    const safeZip = path.join(scratch, 'safe-binary-preflight.zip');
    fs.writeFileSync(safeZip, safeBytes);
    const preflight = await preflightDiagnosticsArchive(safeZip, false);
    assert(preflight.entryNames.length === 5, 'Actual stored-ZIP preflight rejected a bounded safe archive.');
    const inspected = await inspectDiagnosticsArchiveExact(safeZip, snapshotBoundFile(safeZip),
      path.join(scratch, 'safe-binary-inspection'), scratch, false);
    assert(inspected.manifest.includeAnonymousPerformanceData === false && inspected.aggregate === null,
      'Full safe diagnostics archive inspection drifted.');

    let variant = 0;
    const rejects = async (bytes) => {
      const target = path.join(scratch, `malicious-binary-preflight-${variant += 1}.zip`);
      fs.writeFileSync(target, bytes);
      let rejected = false;
      try { await preflightDiagnosticsArchive(target, false); } catch { rejected = true; }
      assert(rejected, 'Actual stored-ZIP preflight accepted a malicious archive.');
    };
    await rejects(safeBytes.subarray(0, safeBytes.length - 1));
    const crcMismatch = Buffer.from(safeBytes);
    const firstData = 30 + crcMismatch.readUInt16LE(26) + crcMismatch.readUInt16LE(28);
    crcMismatch[firstData] ^= 0x01;
    await rejects(crcMismatch);
    const localNameMismatch = Buffer.from(safeBytes);
    localNameMismatch[30] ^= 0x01;
    await rejects(localNameMismatch);
    await rejects(buildStoredDiagnosticsZipFixture(entries.map((entry, index) => index === 0
      ? { ...entry, name: '../manifest.json' } : entry)));
    await rejects(buildStoredDiagnosticsZipFixture(entries.map((entry, index) => index === 0
      ? { ...entry, externalFileAttributes: (0o120777 << 16) >>> 0 } : entry)));
    await rejects(buildStoredDiagnosticsZipFixture(entries.map((entry, index) => index === 0
      ? { ...entry, externalFileAttributes: 0x0400 } : entry)));
    await rejects(buildStoredDiagnosticsZipFixture(entries.map((entry, index) => index === 0
      ? { ...entry, content: Buffer.alloc((2 * 1024 * 1024) + 1, 0x61) } : entry)));
  });

  test('archive inspection failures expose only a fixed stage and bounded counts', () => {
    const fact = closedArchiveInspectionFailureFact({ stage: 'header_preflight', acceptedEntries: 4,
      expandedBytes: 1024 });
    assert(JSON.stringify(fact) === JSON.stringify({ stage: 'header_preflight', acceptedEntries: 4,
      expandedBytes: 1024 }), 'Closed archive failure fact changed.');
    expectThrow(() => closedArchiveInspectionFailureFact({ ...fact, path: 'private' }));
    expectThrow(() => closedArchiveInspectionFailureFact({ ...fact, stage: 'raw_error' }));
    expectThrow(() => closedArchiveInspectionFailureFact({ ...fact, expandedBytes: -1 }));
  });

  test('post-click recovery bounded-waits only the exact returned candidate regardless of API settlement', async () => {
    const requestedAt = Date.now();
    const filename = `ClaudeWorkbench-diagnostics-${new Date(requestedAt).toISOString().replace(/[:.]/gu, '-')}.zip`;
    const documents = path.join(scratch, 'recovery-documents');
    fs.mkdirSync(documents);
    const target = path.join(documents, filename);
    const returned = { expectedPid: 101, knownFolderSource: 'SHGetKnownFolderPath(FOLDERID_Documents)',
      targetExisted: false, documents, target, filename,
      dialogs: [{ pid: 101, hwnd: 7, className: '#32770', title: DIAGNOSTICS_TITLE, visible: true,
        editControls: [{ pid: 101, hwnd: 8, controlId: 1001, nativeClass: 'Edit', visible: true,
          enabled: true, contained: true, preRevalidated: true, boundedTextRead: true, postRevalidated: true,
          beforeActionRevalidated: true, targetAbsent: true, value: filename }],
        saveControls: [{ pid: 101, hwnd: 9, controlId: 1, nativeClass: 'Button', visible: true,
          enabled: true, contained: true, nativeText: 'Save', preRevalidated: true,
          beforeActionRevalidated: true }] }] };
    const timer = setTimeout(() => fs.writeFileSync(target, 'delayed-post-click-zip', 'utf8'), 50);
    let recovered;
    try { recovered = await recoverReturnedNativeCandidate(returned, 101, requestedAt, 1_000); }
    finally { clearTimeout(timer); }
    assert(recovered.appeared === true && recovered.deleted === true && !fs.existsSync(target),
      'Delayed exact post-click candidate was not identity-bound and deleted.');
    const absent = await recoverReturnedNativeCandidate(returned, 101, requestedAt, 100);
    assert(absent.appeared === false && absent.deleted === false, 'Absent exact candidate was treated as a cleanup failure.');
    const unbound = path.join(documents, 'unbound-preserved.zip');
    fs.writeFileSync(unbound, 'preserve', 'utf8');
    let invalidFailed = false;
    try { await recoverReturnedNativeCandidate({ ...returned, target: unbound }, 101, requestedAt, 100); }
    catch { invalidFailed = true; }
    assert(invalidFailed && fs.existsSync(unbound), 'Invalid returned identity did not fail closed or deleted an unbound file.');
  });

  test('rejected or timed-out helper recovery waits for delayed exact creation without consulting API state', async () => {
    const requestedAt = Date.now();
    const filename = `ClaudeWorkbench-diagnostics-${new Date(requestedAt).toISOString().replace(/[:.]/gu, '-')}.zip`;
    const documents = path.join(scratch, 'rejected-helper-recovery');
    fs.mkdirSync(documents);
    const returned = nativeRecoveryCandidate(documents, filename);
    const timer = setTimeout(() => fs.writeFileSync(returned.target, 'rejected-helper-delayed', 'utf8'), 50);
    let result;
    try { result = await recoverRejectedNativeHelperCandidate({ nativeCandidate: returned }, 101, requestedAt, 1_000); }
    finally { clearTimeout(timer); }
    assert(result.appeared && result.deleted && !fs.existsSync(returned.target),
      'Rejected-helper delayed exact candidate was not cleaned.');
  });

  test('fulfilled malformed-result recovery uses only the emitted marker and preserves identity-mismatched files', async () => {
    const requestedAt = Date.now();
    const filename = `ClaudeWorkbench-diagnostics-${new Date(requestedAt).toISOString().replace(/[:.]/gu, '-')}.zip`;
    const documents = path.join(scratch, 'fulfilled-helper-recovery');
    fs.mkdirSync(documents);
    const returned = nativeRecoveryCandidate(documents, filename);
    const output = `CW_BETA_NATIVE_CANDIDATE=${JSON.stringify(returned)}\nCW_BETA_NATIVE_RESULT=malformed`;
    const timer = setTimeout(() => fs.writeFileSync(returned.target, 'fulfilled-helper-delayed', 'utf8'), 50);
    let result;
    try { result = await recoverFulfilledNativeHelperOutput(output, 101, requestedAt, 1_000); }
    finally { clearTimeout(timer); }
    assert(result.appeared && result.deleted && !fs.existsSync(returned.target),
      'Malformed fulfilled-helper result did not recover its exact emitted candidate.');
    const original = path.join(documents, 'identity-source.zip');
    fs.writeFileSync(original, 'identity-mismatch', 'utf8');
    fs.linkSync(original, returned.target);
    let rejected = false;
    try { await recoverFulfilledNativeHelperOutput(output, 101, requestedAt, 100); } catch { rejected = true; }
    assert(rejected && fs.existsSync(original) && fs.existsSync(returned.target),
      'Identity-mismatched returned candidate was deleted instead of preserved.');
    fs.unlinkSync(returned.target);
  });

  test('dialog cleanup rejection cannot suppress delayed exact candidate recovery and reports both fixed outcomes', async () => {
    const requestedAt = Date.now();
    const filename = `ClaudeWorkbench-diagnostics-${new Date(requestedAt).toISOString().replace(/[:.]/gu, '-')}.zip`;
    const documents = path.join(scratch, 'independent-failure-cleanup');
    fs.mkdirSync(documents);
    const returned = nativeRecoveryCandidate(documents, filename);
    const timer = setTimeout(() => fs.writeFileSync(returned.target, 'independent-delayed', 'utf8'), 50);
    let failure = null;
    try {
      await settleIndependentNativeFailureCleanup(
        async () => { throw new Error('private dialog failure'); },
        async () => recoverReturnedNativeCandidate(returned, 101, requestedAt, 1_000));
    } catch (error) { failure = error; }
    finally { clearTimeout(timer); }
    assert(failure?.nativeFailureCleanup?.dialog === 'failed'
      && failure.nativeFailureCleanup.candidate === 'completed' && !fs.existsSync(returned.target),
    'Dialog failure suppressed exact delayed candidate deletion or escaped raw outcomes.');

    const original = path.join(documents, 'hardlink-source.zip');
    fs.writeFileSync(original, 'preserve-hardlink', 'utf8');
    fs.linkSync(original, returned.target);
    failure = null;
    try {
      await settleIndependentNativeFailureCleanup(
        async () => { throw new Error('private dialog failure'); },
        async () => recoverReturnedNativeCandidate(returned, 101, requestedAt, 100));
    } catch (error) { failure = error; }
    assert(failure?.nativeFailureCleanup?.dialog === 'failed'
      && failure.nativeFailureCleanup.candidate === 'failed'
      && fs.existsSync(original) && fs.existsSync(returned.target),
    'Dual cleanup failures were not closed independently or deleted an identity-mismatched file.');
    fs.unlinkSync(returned.target);
  });

  test('private-value scan rejects secrets, opaque refs, vault names, and diagnostic paths', () => {
    assert(assertPrivateValuesAbsent('safe public data', ['secret', 'opaque-ref', 'vault.bin', 'Documents/path'], 'safe buffer'));
    for (const value of ['secret', 'opaque-ref', 'vault.bin', 'Documents/path']) {
      expectThrow(() => assertPrivateValuesAbsent(`prefix ${value} suffix`, [value], 'unsafe buffer'));
    }
  });

  test('acceptance-tag process filtering excludes the inspecting helper itself', () => {
    const records = [{ ProcessId: 100, CommandLine: 'electron --cw-beta-acceptance=tag' },
      { ProcessId: 200, CommandLine: "powershell *tag*" }, { ProcessId: 300, CommandLine: null }];
    assert(countTaggedProcessRecords(records, 'tag', 200) === 1, 'Inspecting PowerShell process counted itself.');
    assert(acceptanceTaggedProcessCount(`self-test-${crypto.randomUUID()}`) === 0,
      'Live inspecting PowerShell process counted its own tag literal.');
  });

  test('rejects scanning, guessing, filename/path writes, blind keys, clipboard, and physical mouse', () => {
    const safe = { documentsEnumerated: false, documentsDiffed: false, guessDeleted: false, filenameWritten: false,
      pathWritten: false, sendKeysUsed: false, clipboardUsed: false, physicalMouseUsed: false };
    assert(assertAutomationPolicy(safe) === true, 'Safe automation policy was rejected.');
    for (const key of Object.keys(safe)) expectThrow(() => assertAutomationPolicy({ ...safe, [key]: true }));
  });

  test('deletes only an unambiguous identity-bound file and removes only owned temp roots', () => {
    const candidatePath = path.join(scratch, 'candidate.zip');
    fs.writeFileSync(candidatePath, 'zip', 'utf8');
    const stat = fs.lstatSync(candidatePath);
    const candidate = { path: candidatePath, identity: { dev: stat.dev, ino: stat.ino, size: stat.size, nlink: stat.nlink,
      mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, birthtimeMs: stat.birthtimeMs,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(candidatePath)).digest('hex') }, ambiguous: false };
    assert(deleteBoundFile(candidate) === true && !fs.existsSync(candidatePath), 'Bound file was not deleted.');
    fs.writeFileSync(candidatePath, 'zip', 'utf8');
    expectThrow(() => deleteBoundFile({ ...candidate, path: candidatePath, ambiguous: true }));
    assert(fs.existsSync(candidatePath), 'Ambiguous file was deleted.');
    const fixture = createIsolatedFixture(scratch);
    assert(safeRemoveFixture(fixture.root) === true && !fs.existsSync(fixture.root), 'Owned fixture was not removed.');
    expectThrow(() => safeRemoveFixture(scratch));
  });

  test('bound-file cleanup rejects symlink/reparse, hardlink, metadata drift, and hash drift', () => {
    const original = path.join(scratch, 'identity-original.zip');
    fs.writeFileSync(original, 'original-zip', 'utf8');
    const before = fs.lstatSync(original);
    const identity = { dev: before.dev, ino: before.ino, size: before.size, nlink: before.nlink,
      mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs, birthtimeMs: before.birthtimeMs,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(original)).digest('hex') };
    const safeCandidate = { path: original, identity, ambiguous: false };
    const metadataDrift = { ...safeCandidate, identity: { ...identity, mtimeMs: identity.mtimeMs - 1 } };
    expectThrow(() => deleteBoundFile(metadataDrift));
    assert(fs.existsSync(original), 'Metadata-drift candidate was deleted.');
    const hashDrift = { ...safeCandidate, identity: { ...identity, sha256: '0'.repeat(64) } };
    expectThrow(() => deleteBoundFile(hashDrift));
    assert(fs.existsSync(original), 'Hash-drift candidate was deleted.');
    const hardlink = path.join(scratch, 'identity-hardlink.zip');
    fs.linkSync(original, hardlink);
    const linkedStat = fs.lstatSync(hardlink);
    expectThrow(() => deleteBoundFile({ path: hardlink, ambiguous: false, identity: {
      ...fileIdentity(linkedStat), sha256: identity.sha256,
    } }));
    assert(fs.existsSync(hardlink), 'Hardlink candidate was deleted.');
    fs.unlinkSync(hardlink);
    const reparseTarget = path.join(scratch, 'identity-reparse-target');
    const reparse = path.join(scratch, 'identity-reparse.zip');
    fs.mkdirSync(reparseTarget);
    fs.symlinkSync(reparseTarget, reparse, 'junction');
    expectThrow(() => deleteBoundFile({ path: reparse, ambiguous: false, identity }));
    assert(fs.existsSync(reparse), 'Symlink/reparse candidate was deleted.');
    fs.unlinkSync(reparse);
    const finalStat = fs.lstatSync(original);
    const rebound = { path: original, ambiguous: false, identity: {
      dev: finalStat.dev, ino: finalStat.ino, size: finalStat.size, nlink: finalStat.nlink,
      mtimeMs: finalStat.mtimeMs, ctimeMs: finalStat.ctimeMs, birthtimeMs: finalStat.birthtimeMs,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(original)).digest('hex'),
    } };
    assert(deleteBoundFile(rebound) === true && !fs.existsSync(original), 'Exact identity/hash-bound file was not deleted.');
  });

  const failures = [];
  try {
    for (const { name, body } of tests) {
      try {
        await body();
        console.log(`[self-test pass] ${name}`);
      } catch (error) {
        failures.push({ name, message: error instanceof Error ? error.message : String(error) });
        console.error(`[self-test fail] ${name}: ${failures.at(-1).message}`);
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  assert(failures.length === 0, `${failures.length} beta-readiness self-test(s) failed.`);
  console.log(`BETA_READINESS_SELF_TEST_RESULT=${JSON.stringify({ status: 'passed', tests: tests.length })}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--self-test') {
    await runSelfTest();
    return;
  }
  if (args.length === 1 && args[0] === '--probe-only') {
    await runProbeOnly();
    return;
  }
  const allowed = new Set(['--skip-build', '--keep-temp']);
  for (const argument of args) assert(allowed.has(argument), `Unknown beta-readiness argument: ${argument}`);
  if (!args.includes('--skip-build')) {
    const build = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
      cwd: WORKSPACE_ROOT, stdio: 'inherit', windowsHide: true, shell: false,
    });
    assert(build.status === 0, 'Production build failed before beta-readiness acceptance.');
  }
  const report = await runProductionAcceptance({ keepTemp: args.includes('--keep-temp') });
  console.log(`BETA_READINESS_ACCEPTANCE_RESULT=${JSON.stringify({ status: report.status, steps: report.steps.length,
    report: path.relative(WORKSPACE_ROOT, REPORT_PATH).replace(/\\/gu, '/') })}`);
}

main().catch((error) => {
  if (process.argv.includes('--self-test') || process.argv.includes('--probe-only')) {
    console.error(error instanceof Error ? error.message : String(error));
  } else {
    console.error('Beta-readiness acceptance failed; inspect the sanitized fixed report.');
  }
  process.exitCode = 1;
});
