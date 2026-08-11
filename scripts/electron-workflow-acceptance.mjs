import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import electron from 'electron';
import { CdpClient, waitForCdpPage } from './lib/cdp-client.mjs';

const TEMP_PREFIX = 'claude-workbench-electron-workflow-acceptance-';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(SCRIPT_DIR, '..');
const PRODUCTION_BUILD_ARTIFACTS = [
  { role: 'main', relativePath: 'dist/main/index.js' },
  { role: 'preload', relativePath: 'dist/preload/index.js' },
  { role: 'renderer', relativePath: 'dist/renderer/index.html' },
];
const PROJECT_ID = 'workflow-acceptance-project';
const PROJECT_NAME = 'Workflow Acceptance Project';
const BOOTSTRAP_TASK_TITLE = 'Workflow Bootstrap Task';
const WORKFLOW_PROMPT = 'Implement the deterministic Phase 6 acceptance target';
const MODIFIED_PLAN_TITLE = 'Acceptance Modified Workflow Plan';
const TARGET_RELATIVE_PATH = 'src/phase6-target.ts';
const TARGET_CONTENT = [
  'export const phase6AcceptanceTarget = {',
  "  source: 'electron-workflow-acceptance',",
  '  fakeTransportOnly: true,',
  '  verified: true,',
  '} as const;',
  '',
].join('\n');
const REQUIRED_CHECKPOINT_TYPES = [
  'before_task',
  'before_plan',
  'after_plan',
  'before_execute',
  'after_execute',
  'before_review',
  'before_fix',
  'after_fix',
  'task_completed',
];
const EXPECTED_CHECKPOINT_COUNTS = {
  before_task: 1,
  before_plan: 1,
  after_plan: 1,
  before_execute: 1,
  after_edit: 2,
  after_execute: 1,
  before_review: 2,
  before_fix: 1,
  after_fix: 1,
  task_completed: 1,
};
const EXPECTED_STAGE_SEQUENCE = [
  'planner',
  'coder',
  'tester',
  'reviewer',
  'coder',
  'tester',
  'reviewer',
];
const STEP_TIMEOUT_MS = 30_000;
const REAL_WORKFLOW_TIMEOUT_MS = 20 * 60_000;
const REAL_WORKFLOW_PROMPT = [
  '增加一个数学计算模块，并添加完整测试。',
  '在这个一次性 Node.js 项目中创建 src/calculator.js 和 test/calculator.test.js。',
  '导出 add、subtract、multiply、divide；除以零必须抛出 RangeError。',
  '使用内置 node:test，运行 npm test，不安装依赖，不创建 commit。',
  'Acceptance requirement: during the Coder stage, invoke Bash twice as two separate tool calls: first `npm test`, then `npm run test`. Do not combine these commands.',
  'During the Tester stage, independently invoke `npm test` again.',
  'Fix-loop acceptance invariant: the initial Coder pass must leave the comment `// REVIEW_FIX_REQUIRED: validate finite operands` and tests may still pass. The first Reviewer must report that marker as an unresolved low-severity issue. In the resulting fix round, Coder must remove the marker, add finite-number validation and tests, and rerun both test commands.',
].join('\n');

function parseArguments(argv) {
  const options = {
    build: true,
    keepTemp: false,
    real: false,
    permissionScopeBaseline: false,
    permissionScopeFinal: false,
    permissionLifecycleOnly: false,
    permissionBoundaryOnly: false,
    gitStateOnly: false,
    permissionLifecycleMatrix: false,
    reportPath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--skip-build') options.build = false;
    else if (argument === '--real') options.real = true;
    else if (argument === '--permission-scope-baseline') {
      options.real = true;
      options.permissionScopeBaseline = true;
    }
    else if (argument === '--permission-scope-final') {
      options.real = true;
      options.permissionScopeFinal = true;
    }
    else if (argument === '--permission-lifecycle-only') {
      options.real = true;
      options.permissionLifecycleOnly = true;
    }
    else if (argument === '--permission-boundary-only') {
      options.real = true;
      options.permissionBoundaryOnly = true;
    }
    else if (argument === '--git-state-only') {
      options.gitStateOnly = true;
    }
    else if (argument === '--keep-temp') options.keepTemp = true;
    else if (argument === '--report') {
      const value = argv[index + 1];
      if (!value) throw new Error('--report requires a file path.');
      options.reportPath = path.resolve(argv[++index]);
    } else if (argument === '--help') {
      console.log([
        'Usage: node scripts/electron-workflow-acceptance.mjs [options]',
        '',
        '  --skip-build     Reuse the current production dist/ output.',
        '  --real           Use the real ClaudeCliAdapter for a disposable full workflow.',
        '  --permission-scope-baseline  Reproduce the legacy per-run permission cache.',
        '  --permission-scope-final     Verify task-scoped permission reuse across Agent processes.',
        '  --permission-lifecycle-only  Verify new-task and persistent project-rule lifecycle.',
        '  --permission-boundary-only   Verify risk escalation and cross-project scope boundaries.',
        '  --git-state-only             Verify production non-repository Git panel semantics.',
        '  --report <path>  Write the complete JSON result to an explicit path.',
        '  --keep-temp      Keep the isolated fixture directory for diagnosis.',
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? WORKSPACE_ROOT,
    env: options.env ?? process.env,
    encoding: 'utf8',
    windowsHide: true,
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stderr, result.stdout]
      .filter(Boolean)
      .join('\n')
      .trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : '.'}`);
  }
  return result.stdout?.trim() ?? '';
}

function runNpm(args, options = {}) {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
  const npmCli = candidates.find((candidate) => fs.existsSync(candidate));
  if (!npmCli) throw new Error('Unable to locate npm-cli.js without invoking a command shell.');
  return runChecked(process.execPath, [npmCli, ...args], options);
}

function git(projectPath, args) {
  return runChecked('git', args, { cwd: projectPath });
}

function gitHead(projectPath) {
  return git(projectPath, ['rev-parse', 'HEAD']);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function productionBuildArtifactEvidence() {
  return {
    capturedAt: new Date().toISOString(),
    files: PRODUCTION_BUILD_ARTIFACTS.map(({ role, relativePath }) => {
      const filePath = path.join(WORKSPACE_ROOT, ...relativePath.split('/'));
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) {
          return {
            role,
            relativePath,
            path: filePath,
            status: 'missing',
            sha256: null,
            size: null,
            mtime: null,
          };
        }
        return {
          role,
          relativePath,
          path: filePath,
          status: 'present',
          sha256: createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        };
      } catch (error) {
        return {
          role,
          relativePath,
          path: filePath,
          status: error?.code === 'ENOENT' ? 'missing' : 'unreadable',
          sha256: null,
          size: null,
          mtime: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  };
}

function assertBuildOutputs() {
  const outputs = PRODUCTION_BUILD_ARTIFACTS.map(({ relativePath }) => (
    path.join(WORKSPACE_ROOT, ...relativePath.split('/'))
  ));
  for (const output of outputs) assert(fs.existsSync(output), `Production build output is missing: ${output}`);
  return outputs;
}

function createGitProject(projectPath) {
  const sourcePath = path.join(projectPath, 'src', 'index.ts');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, [
    "export const fixtureName = 'workflow-acceptance';",
    'export function stableValue() {',
    '  return 6;',
    '}',
    '',
  ].join('\n'), 'utf8');
  writeJson(path.join(projectPath, 'package.json'), {
    name: 'workflow-acceptance-fixture',
    private: true,
    type: 'module',
    scripts: { test: 'node --test' },
  });
  fs.writeFileSync(
    path.join(projectPath, 'CLAUDE.md'),
    '# Isolated Phase 6 workflow acceptance fixture\n',
    'utf8',
  );
  runChecked('git', ['init', '--quiet'], { cwd: projectPath });
  runChecked('git', ['add', '--all'], { cwd: projectPath });
  runChecked('git', [
    '-c', 'user.name=Claude Workbench Workflow Acceptance',
    '-c', 'user.email=workflow-acceptance@example.invalid',
    'commit', '--quiet', '-m', 'workflow acceptance baseline',
  ], { cwd: projectPath });
  assert(git(projectPath, ['status', '--porcelain=v1']) === '', 'Fixture repository is not clean.');
  return {
    sourcePath,
    targetPath: path.join(projectPath, ...TARGET_RELATIVE_PATH.split('/')),
    initialHead: gitHead(projectPath),
  };
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  try {
    const dataRoot = path.join(root, 'workbench-data');
    const browserDataRoot = path.join(root, 'chromium-profile');
    const isolatedHome = path.join(root, 'isolated-home');
    const appData = path.join(root, 'app-data');
    const localAppData = path.join(root, 'local-app-data');
    const runtimeTemp = path.join(root, 'runtime-temp');
    const projectPath = path.join(root, 'projects', PROJECT_NAME);
    for (const directory of [
      dataRoot,
      browserDataRoot,
      isolatedHome,
      appData,
      localAppData,
      runtimeTemp,
      projectPath,
    ]) fs.mkdirSync(directory, { recursive: true });

    const projectGit = createGitProject(projectPath);
    const now = new Date().toISOString();
    const bootstrapAt = new Date(Date.now() - 60_000).toISOString();
    writeJson(path.join(dataRoot, 'claude-workbench.db'), {
      projects: {
        [PROJECT_ID]: {
          id: PROJECT_ID,
          name: PROJECT_NAME,
          path: projectPath,
          created_at: bootstrapAt,
          last_opened_at: now,
        },
      },
      sessions: {
        'workflow-bootstrap-task': {
          id: 'workflow-bootstrap-task',
          project_id: PROJECT_ID,
          title: BOOTSTRAP_TASK_TITLE,
          status: 'idle',
          created_at: bootstrapAt,
          updated_at: bootstrapAt,
        },
      },
      messages: {},
      events: {},
      fileChanges: {},
      settings: { language: 'zh-CN', theme: 'light' },
    });

    return {
      root,
      dataRoot,
      databasePath: path.join(dataRoot, 'claude-workbench.db'),
      browserDataRoot,
      isolatedHome,
      appData,
      localAppData,
      runtimeTemp,
      projectPath,
      projectGit,
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
    throw error;
  }
}

function childEnvironment(fixture, realClaude = false) {
  const env = {
    ...process.env,
    WORKBENCH_DATA_DIR: fixture.dataRoot,
    NODE_ENV: 'production',
    TEMP: fixture.runtimeTemp,
    TMP: fixture.runtimeTemp,
    ...(realClaude ? {} : {
      FORCE_FAKE: '1',
      HOME: fixture.isolatedHome,
      USERPROFILE: fixture.isolatedHome,
      APPDATA: fixture.appData,
      LOCALAPPDATA: fixture.localAppData,
      XDG_CONFIG_HOME: path.join(fixture.isolatedHome, '.config'),
      CLAUDE_CONFIG_DIR: path.join(fixture.isolatedHome, '.claude'),
    }),
  };
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'NODE_OPTIONS',
    'VITE_DEV_SERVER_URL',
    'WORKBENCH_OPEN_DEVTOOLS',
  ]) delete env[key];
  if (!realClaude) {
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
      delete env[key];
    }
  }
  return env;
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error('Unable to reserve a CDP port.'));
        else resolve(port);
      });
    });
  });
}

async function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

async function stopElectron(instance) {
  if (!instance) return;
  try {
    await instance.client?.evaluate('window.close()');
  } catch {
    // Closing the real Workbench window can close CDP before evaluate returns.
  }
  instance.client?.close();
  if (await waitForProcessExit(instance.child, 5_000)) return;
  const pid = instance.child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch { /* process already exited */ }
    if (!(await waitForProcessExit(instance.child, 2_000))) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* process already exited */ }
    }
  }
  await waitForProcessExit(instance.child, 3_000);
}

async function launchElectron(fixture, realClaude = false) {
  const port = await reservePort();
  const electronPath = electron.default || electron;
  const child = spawn(electronPath, [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${fixture.browserDataRoot}`,
    '.',
  ], {
    cwd: WORKSPACE_ROOT,
    env: childEnvironment(fixture, realClaude),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout?.on('data', (chunk) => stdout.push(chunk.toString('utf8')));
  child.stderr?.on('data', (chunk) => stderr.push(chunk.toString('utf8')));
  let client = null;
  try {
    const page = await waitForCdpPage(port, {
      timeoutMs: 30_000,
      processExited: () => child.exitCode !== null || child.signalCode !== null,
    });
    client = await CdpClient.connect(page.webSocketDebuggerUrl);
    const rendererErrors = [];
    client.on('Runtime.exceptionThrown', (params) => {
      rendererErrors.push(params.exceptionDetails?.exception?.description
        ?? params.exceptionDetails?.text
        ?? 'Unknown renderer exception');
    });
    client.on('Runtime.consoleAPICalled', (params) => {
      if (params.type !== 'error' && params.type !== 'assert') return;
      rendererErrors.push(params.args?.map((item) => item.value ?? item.description ?? '').join(' ')
        || 'Renderer console error');
    });
    await Promise.all([
      client.send('Runtime.enable'),
      client.send('Page.enable'),
      client.send('Log.enable'),
    ]);
    await client.waitFor(
      `document.readyState === 'complete' && document.getElementById('root')?.children.length > 0`,
      { description: 'real Workbench React root', timeoutMs: 30_000 },
    );
    return { child, client, page, port, stdout, stderr, rendererErrors };
  } catch (error) {
    await stopElectron({ child, client, stdout, stderr });
    const logTail = [...stderr, ...stdout].join('').trim().split(/\r?\n/u).slice(-40).join('\n');
    throw new Error(`${error.message}${logTail ? `\nElectron log tail:\n${logTail}` : ''}`);
  }
}

function js(value) {
  return JSON.stringify(value).replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');
}

async function clickControl(client, labels) {
  return client.evaluate(`(() => {
    const labels = ${js(labels)};
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="option"]'));
    const match = candidates.find((element) => {
      if (element.disabled) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const values = [element.textContent, element.title, element.getAttribute('aria-label')].map(normalize);
      return labels.some((label) => values.some((value) => value === label || value.includes(label)));
    });
    if (!match) return null;
    match.click();
    return normalize(match.textContent || match.title || match.getAttribute('aria-label'));
  })()`);
}

async function clickTestId(client, testId, extraSelector = '') {
  const clicked = await client.evaluate(`(() => {
    const element = document.querySelector(${js(`[data-testid="${testId}"]${extraSelector}`)});
    if (!element || element.disabled) return false;
    element.click();
    return true;
  })()`);
  assert(clicked, `UI control is unavailable: ${testId}${extraSelector}`);
}

async function selectWorkflowTab(client, tab) {
  const clicked = await client.evaluate(`(() => {
    const element = document.querySelector(${js(`[data-testid="workflow-tab"][data-tab="${tab}"]`)});
    if (!element) return false;
    element.click();
    return true;
  })()`);
  assert(clicked, `Workflow tab is unavailable: ${tab}`);
  await client.waitFor(
    `document.querySelector(${js(`[data-testid="workflow-tab"][data-tab="${tab}"]`)})?.getAttribute('aria-selected') === 'true'`,
    { description: `selected workflow ${tab} tab` },
  );
}

async function selectProject(client) {
  const clicked = await client.evaluate(`(() => {
    const search = document.querySelector('[data-project-search]');
    const sidebar = search?.closest('aside');
    const button = Array.from(sidebar?.querySelectorAll('button') || [])
      .find((item) => item.textContent?.trim() === ${js(PROJECT_NAME)});
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert(clicked, `Project control is unavailable: ${PROJECT_NAME}`);
  await client.waitFor(`document.body.innerText.includes(${js(BOOTSTRAP_TASK_TITLE)})`, {
    description: 'isolated project task list',
    timeoutMs: STEP_TIMEOUT_MS,
  });
}

async function selectTask(client, taskId) {
  const selected = await client.evaluate(`(() => {
    const element = document.querySelector(${js(`[data-session-key$="::${taskId}"]`)});
    if (!element) return false;
    element.click();
    return true;
  })()`);
  assert(selected, `Task control is unavailable: ${taskId}`);
  await client.waitFor(
    `document.querySelector(${js(`[data-session-key$="::${taskId}"]`)})
      ?.style.backgroundColor.includes('--bg-active')`,
    { description: `active task identity ${taskId}`, timeoutMs: STEP_TIMEOUT_MS },
  );
}

async function createTaskFromUi(client) {
  const before = await client.evaluate(`window.api.listSessions(${js(PROJECT_ID)})`);
  const clicked = await clickControl(client, ['新建任务']);
  assert(clicked, 'New task control is unavailable.');
  await client.waitFor(
    `(async () => (await window.api.listSessions(${js(PROJECT_ID)})).length === ${before.length + 1})()`,
    { description: 'new workflow acceptance task', timeoutMs: STEP_TIMEOUT_MS },
  );
  const after = await client.evaluate(`window.api.listSessions(${js(PROJECT_ID)})`);
  const previousIds = new Set(before.map((session) => session.id));
  const created = after.find((session) => !previousIds.has(session.id));
  assert(created, 'New task was not returned by the real session IPC.');
  await selectTask(client, created.id);
  return created;
}

async function selectPlanMode(client) {
  const value = await client.evaluate(`(() => {
    const select = document.querySelector('select[aria-label="Agent 模式"]');
    if (!select) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter.call(select, 'plan');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value;
  })()`);
  assert(value === 'plan', 'Unable to select Plan Mode in the real toolbar.');
  await client.waitFor(
    `(async () => (await window.api.getProjectSettings(${js(PROJECT_ID)})).agentMode === 'plan')()`,
    { description: 'persisted Plan Mode setting' },
  );
}

async function selectAgentMode(client, mode, projectId = PROJECT_ID) {
  const value = await client.evaluate(`(() => {
    const select = document.querySelector('select[aria-label="Agent 模式"]');
    if (!select) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter.call(select, ${js(mode)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value;
  })()`);
  assert(value === mode, `Unable to select ${mode} Agent mode in the real toolbar.`);
  await client.waitFor(
    `(async () => (await window.api.getProjectSettings(${js(projectId)})).agentMode === ${js(mode)})()`,
    { description: `persisted ${mode} Agent mode setting` },
  );
}

async function submitWorkflowPrompt(client, prompt) {
  await client.waitFor(
    `Array.from(document.querySelectorAll('textarea')).some((item) => !item.disabled)`,
    { description: 'enabled workflow prompt textarea', timeoutMs: STEP_TIMEOUT_MS },
  );
  const populated = await client.evaluate(`(() => {
    const textarea = Array.from(document.querySelectorAll('textarea')).find((item) => !item.disabled);
    if (!textarea) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter.call(textarea, ${js(prompt)});
    textarea.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: ${js(prompt)},
    }));
    return textarea.value;
  })()`);
  assert(populated === prompt, 'Unable to populate the workflow prompt.');
  await client.waitFor(`(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('button')).some((element) => {
      if (element.disabled) return false;
      const rect = element.getBoundingClientRect();
      const values = [element.textContent, element.title, element.getAttribute('aria-label')]
        .map(normalize);
      return rect.width > 0 && rect.height > 0 && values.some((value) => value.includes('发送'));
    });
  })()`, { description: 'enabled Plan Mode send control', timeoutMs: STEP_TIMEOUT_MS });
  const sent = await clickControl(client, ['发送']);
  assert(sent, 'Plan Mode send control is unavailable.');
}

async function installWorkflowEventRecorder(client) {
  await client.evaluate(`(() => {
    window.__WORKFLOW_ACCEPTANCE_UNSUBSCRIBE__?.();
    window.__WORKFLOW_ACCEPTANCE_EVENTS__ = [];
    window.__WORKFLOW_ACCEPTANCE_UNSUBSCRIBE__ = window.api.onWorkflowChanged((event) => {
      window.__WORKFLOW_ACCEPTANCE_EVENTS__.push(JSON.parse(JSON.stringify(event)));
    });
    return true;
  })()`);
}

async function workflowEvents(client) {
  return client.evaluate('window.__WORKFLOW_ACCEPTANCE_EVENTS__ ?? []');
}

async function openWorkspaceDrawer(client) {
  const present = await client.evaluate(
    `Boolean(document.querySelector('[data-testid="workspace-right-drawer"]'))`,
  );
  if (!present) {
    const clicked = await client.evaluate(`(() => {
      const icon = document.querySelector('button .lucide-file-text');
      const button = icon?.closest('button');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert(clicked, 'Workspace drawer toolbar control is unavailable.');
  }
  await client.waitFor(`document.querySelector('[data-testid="workspace-right-drawer"]')`, {
    description: 'workspace right drawer',
  });
}

async function selectDrawerTab(client, tab) {
  const selected = await client.evaluate(`(() => {
    const element = document.querySelector(${js(`[data-testid="right-drawer-tab"][data-tab="${tab}"]`)});
    if (!element) return false;
    element.click();
    return true;
  })()`);
  assert(selected, `Workspace drawer tab is unavailable: ${tab}`);
}

function checkpointSummary(checkpoints) {
  const counts = {};
  for (const checkpoint of checkpoints) {
    counts[checkpoint.type] = (counts[checkpoint.type] ?? 0) + 1;
  }
  return {
    count: checkpoints.length,
    counts,
    ids: checkpoints.map((checkpoint) => checkpoint.id),
    types: checkpoints.map((checkpoint) => checkpoint.type),
  };
}

function stageSummary(stages) {
  return stages.map((stage) => ({
    id: stage.id,
    stage: stage.stage,
    round: stage.round,
    status: stage.status,
    startedAt: stage.startedAt,
    completedAt: stage.completedAt,
  }));
}

function verifySqlitePersistence(databasePath, taskId, workflowId) {
  const header = fs.readFileSync(databasePath).subarray(0, 16).toString('utf8');
  assert(header.startsWith('SQLite format 3'), 'Workflow fixture did not migrate to SQLite.');
  const database = new BetterSqlite3(databasePath, { readonly: true });
  try {
    database.pragma('busy_timeout = 5000');
    const integrity = database.pragma('integrity_check', { simple: true });
    const schemaVersion = database.pragma('user_version', { simple: true });
    const foreignKeyViolations = database.pragma('foreign_key_check');
    const workflow = database.prepare(
      'SELECT id, task_id, status, current_stage, metadata_json FROM workflows WHERE id = ?',
    ).get(workflowId);
    const stages = database.prepare(
      'SELECT id, agent_type, review_round, status FROM workflow_steps WHERE workflow_id = ? ORDER BY started_at, id',
    ).all(workflowId);
    const reviews = database.prepare(
      'SELECT id, review_round, score, tests_passed, tests_failed FROM reviews WHERE workflow_id = ? ORDER BY review_round',
    ).all(workflowId);
    const issueCount = database.prepare(`
      SELECT COUNT(*) AS count FROM review_issues
      WHERE review_id IN (SELECT id FROM reviews WHERE workflow_id = ?)
    `).get(workflowId).count;
    const checkpoints = database.prepare(
      'SELECT id, type FROM checkpoints WHERE task_id = ? ORDER BY created_at, id',
    ).all(taskId);
    const task = database.prepare('SELECT status FROM tasks WHERE session_id = ?').get(taskId);
    const session = database.prepare('SELECT status FROM sessions WHERE id = ?').get(taskId);
    assert(integrity === 'ok', `SQLite integrity_check returned ${integrity}.`);
    assert(schemaVersion === 5, `Expected SQLite schema v5, found v${schemaVersion}.`);
    assert(foreignKeyViolations.length === 0, 'SQLite foreign_key_check found violations.');
    assert(workflow?.task_id === taskId && workflow.status === 'completed', 'Persisted workflow identity/status is invalid.');
    assert(stages.length === 7, `Expected 7 persisted workflow stages, found ${stages.length}.`);
    assert(reviews.length === 2, `Expected 2 persisted reviews, found ${reviews.length}.`);
    assert(issueCount >= 1, 'The persisted first-round review issue is missing.');
    assert(task?.status === 'completed' && session?.status === 'completed', 'Task/session terminal status was not synchronized.');
    for (const type of REQUIRED_CHECKPOINT_TYPES) {
      assert(checkpoints.some((checkpoint) => checkpoint.type === type), `Persisted ${type} checkpoint is missing.`);
    }
    return {
      header,
      integrity,
      schemaVersion,
      foreignKeyViolations: foreignKeyViolations.length,
      workflow: { id: workflow.id, taskId: workflow.task_id, status: workflow.status },
      stages,
      reviews,
      issueCount,
      checkpoints,
      taskStatus: task.status,
      sessionStatus: session.status,
    };
  } finally {
    database.close();
  }
}

function safeRemoveFixture(root) {
  const resolved = path.resolve(root);
  const tempRoot = path.resolve(os.tmpdir());
  assert(path.dirname(resolved) === tempRoot, `Refusing to remove non-temp path: ${resolved}`);
  assert(path.basename(resolved).startsWith(TEMP_PREFIX), `Refusing to remove unexpected temp path: ${resolved}`);
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function realWorkflowDatabaseEvidence(databasePath, taskId, workflowId) {
  const database = new BetterSqlite3(databasePath, { readonly: true });
  try {
    database.pragma('busy_timeout = 5000');
    const integrity = database.pragma('integrity_check', { simple: true });
    const foreignKeyViolations = database.pragma('foreign_key_check');
    const schemaVersion = Number(database.pragma('user_version', { simple: true }));
    const workflow = database.prepare(
      'SELECT status, current_stage, metadata_json FROM workflows WHERE id = ?',
    ).get(workflowId);
    const workflowMetadata = workflow?.metadata_json
      ? JSON.parse(workflow.metadata_json)
      : {};
    const task = database.prepare(
      'SELECT status FROM tasks WHERE id = ?',
    ).get(taskId);
    const session = database.prepare(
      'SELECT status FROM sessions WHERE id = ?',
    ).get(taskId);
    const audit = database.prepare(`
      SELECT
        COUNT(*) AS requests,
        SUM(CASE WHEN status = 'allowed' THEN 1 ELSE 0 END) AS allowed,
        SUM(CASE WHEN status = 'denied' THEN 1 ELSE 0 END) AS denied
      FROM permission_requests WHERE task_id = ?
    `).get(taskId);
    const checkpointCount = database.prepare(
      'SELECT COUNT(*) AS count FROM checkpoints WHERE task_id = ?',
    ).get(taskId).count;
    assert(integrity === 'ok', `SQLite integrity_check returned ${integrity}.`);
    assert(foreignKeyViolations.length === 0, 'SQLite foreign_key_check found violations.');
    const autoAllowedRows = database.prepare(`
      SELECT payload_json FROM events
      WHERE session_id = ? AND event_type = 'permission_auto_allowed'
      ORDER BY created_at, id
    `).all(taskId);
    const autoAllowed = autoAllowedRows.map((row) => {
      const payload = JSON.parse(row.payload_json);
      return {
        toolName: payload.toolName ?? null,
        capability: payload.capability ?? null,
        riskLevel: payload.riskLevel ?? null,
        scope: payload.scope ?? null,
        matchedRuleIdPresent: typeof payload.matchedRuleId === 'string' && payload.matchedRuleId.length > 0,
        taskMatches: payload.taskId === taskId,
      };
    });
    const projectRuleCount = Number(database.prepare(
      'SELECT COUNT(*) AS count FROM project_permission_rules',
    ).get().count);
    assert(schemaVersion === 5, `Expected SQLite schema v5, found v${schemaVersion}.`);
    assert(workflow?.status === 'completed', `Persisted workflow is ${workflow?.status ?? 'missing'}.`);
    assert(task?.status === 'completed' && session?.status === 'completed', 'Task/session did not persist completion.');
    return {
      schemaVersion,
      integrity,
      foreignKeyViolations: foreignKeyViolations.length,
      workflowStatus: workflow.status,
      workflowStage: workflow.current_stage,
      reviewRound: Number(workflowMetadata.reviewRound ?? 0),
      taskStatus: task.status,
      sessionStatus: session.status,
      permissionAudit: {
        requests: Number(audit?.requests ?? 0),
        allowed: Number(audit?.allowed ?? 0),
        denied: Number(audit?.denied ?? 0),
        autoAllowed,
      },
      projectRuleCount,
      checkpointCount: Number(checkpointCount),
    };
  } finally {
    database.close();
  }
}

async function installRealWorkflowRecorders(client) {
  await installWorkflowEventRecorder(client);
  await client.evaluate(`(() => {
    const encoder = new TextEncoder();
    const secretMarkers = [
      'api-key',
      'api_key',
      'apikey',
      'access-token',
      'access_token',
      'authorization: bearer ',
      'client-secret',
      'client_secret',
      'password=',
      'password:',
      'private-key',
      'private_key',
      'secret=',
      'secret:',
      'session-token',
      'session_token',
    ];
    const containsSecret = (value) => {
      const lower = String(value).toLowerCase();
      if (secretMarkers.some((marker) => lower.includes(marker))) return true;
      return lower.split(/[^a-z0-9_-]+/u).some((part) => (
        ['ghp_', 'gho_', 'github_pat_', 'sk-', 'xoxb-', 'xoxp-']
          .some((prefix) => part.startsWith(prefix))
        && part.length >= 16
      ));
    };
    const byteCount = (value) => encoder.encode(value).byteLength;
    const normalizePath = (value) => String(value).split(String.fromCharCode(92)).join('/');
    const summarizePath = (value, projectPath) => {
      if (typeof value !== 'string' || value.length === 0) return null;
      if (containsSecret(value)) return '[redacted]';
      const normalized = normalizePath(value);
      let project = typeof projectPath === 'string' ? normalizePath(projectPath) : '';
      while (project.endsWith('/')) project = project.slice(0, -1);
      let safePath;
      if (project && normalized.toLowerCase().startsWith(project.toLowerCase() + '/')) {
        safePath = normalized.slice(project.length + 1);
      } else {
        const parts = normalized.split('/').filter(Boolean);
        safePath = parts.length > 0 ? '[external]/' + parts.at(-1) : '[external]';
      }
      if (safePath.length <= 240) return safePath;
      return '[truncated]/' + safePath.slice(-200);
    };
    const safeCommandPreview = (command) => {
      if (containsSecret(command)) return null;
      const compact = command.split(/\\s+/u).join(' ').trim();
      const withoutCwd = compact.replace(
        /^cd\\s+(?:"[^"]*"|'[^']*'|[^&]+?)\\s*&&\\s*/iu,
        '',
      );
      const match = withoutCwd.match(/^(npm(?:\\.cmd)?\\s+test)(?:\\s+(2>&1))?$/iu);
      return match ? [match[1], match[2]].filter(Boolean).join(' ').slice(0, 80) : null;
    };
    const summarizeInput = (request) => {
      const input = request.input && typeof request.input === 'object' ? request.input : {};
      const inputKeys = Object.keys(input).sort();
      const serializedInput = JSON.stringify(input) ?? '';
      const summary = {
        keys: inputKeys.slice(0, 32).map((key) => (
          /^[a-z][a-z0-9_.-]{0,63}$/iu.test(key) ? key : '[unusual-key]'
        )),
        keyCount: inputKeys.length,
        serializedByteCount: byteCount(serializedInput),
      };
      const pathValue = input.file_path ?? input.path ?? input.notebook_path;
      const safePath = summarizePath(pathValue, request.projectPath);
      if (safePath) summary.path = safePath;

      const contentByteCounts = {};
      for (const key of ['content', 'old_string', 'new_string']) {
        if (!Object.hasOwn(input, key)) continue;
        const value = typeof input[key] === 'string'
          ? input[key]
          : (JSON.stringify(input[key]) ?? '');
        contentByteCounts[key] = byteCount(value);
      }
      if (Object.keys(contentByteCounts).length > 0) {
        summary.contentByteCounts = contentByteCounts;
      }

      if (typeof input.command === 'string') {
        const preview = safeCommandPreview(input.command);
        summary.command = { byteCount: byteCount(input.command) };
        if (preview) summary.command.preview = preview;
      }
      return summary;
    };
    const sha256 = async (value) => {
      const digest = await window.crypto.subtle.digest('SHA-256', encoder.encode(value));
      return Array.from(new Uint8Array(digest), (byte) => (
        byte.toString(16).padStart(2, '0')
      )).join('');
    };

    window.__REAL_PERMISSION_UNSUBSCRIBE__?.();
    window.__REAL_PERMISSION_SETTLED_UNSUBSCRIBE__?.();
    window.__REAL_PERMISSION_REQUESTS__ = [];
    window.__REAL_PERMISSION_HASHES__ = [];
    window.__REAL_PERMISSION_SETTLEMENTS__ = [];
    window.__REAL_PERMISSION_UNSUBSCRIBE__ = window.api.onPermissionRequest((request) => {
      const input = request.input && typeof request.input === 'object' ? request.input : {};
      const recorded = {
        requestId: request.requestId,
        runId: request.runId,
        taskId: request.taskId ?? null,
        workflowId: request.workflowId ?? null,
        processId: request.processId ?? null,
        sessionKeyPresent: typeof request.sessionKey === 'string' && request.sessionKey.length > 0,
        projectPath: summarizePath(request.projectPath, null),
        canonicalProjectPath: summarizePath(request.canonicalProjectPath, null),
        effectiveCwd: summarizePath(request.effectiveCwd, request.projectPath),
        targetPaths: Array.isArray(request.targetPaths)
          ? request.targetPaths.slice(0, 32).map((value) => summarizePath(value, request.projectPath))
          : [],
        toolName: request.toolName,
        toolUseId: request.toolUseId ?? null,
        input: summarizeInput(request),
        risk: request.risk,
        capability: request.capability ?? null,
        outsideProject: Boolean(request.outsideProject),
        cacheKey: typeof request.cacheKey === 'string' ? request.cacheKey : null,
        cacheStatus: request.cacheStatus ?? null,
        cacheMissReason: request.cacheMissReason ?? null,
        projectRulePersistable: Boolean(request.projectRulePersistable),
        kind: request.kind ?? 'tool',
        createdAt: request.createdAt,
      };
      window.__REAL_PERMISSION_REQUESTS__.push(recorded);
      if (typeof input.command === 'string') {
        const pendingHash = sha256(input.command).then((hash) => {
          recorded.input.command.sha256 = hash;
        });
        window.__REAL_PERMISSION_HASHES__.push(pendingHash);
      }
      if (typeof request.normalizedRule === 'string') {
        const pendingRuleHash = sha256(request.normalizedRule).then((hash) => {
          recorded.normalizedRuleSha256 = hash;
        });
        window.__REAL_PERMISSION_HASHES__.push(pendingRuleHash);
      }
    });
    window.__REAL_PERMISSION_SETTLED_UNSUBSCRIBE__ = window.api.onPermissionSettled((settlement) => {
      window.__REAL_PERMISSION_SETTLEMENTS__.push({
        requestId: settlement.requestId,
        runId: settlement.runId,
        taskId: settlement.taskId ?? null,
        workflowId: settlement.workflowId ?? null,
        processId: settlement.processId ?? null,
        toolName: settlement.toolName,
        capability: settlement.capability ?? null,
        risk: settlement.risk ?? null,
        effectiveCwd: summarizePath(settlement.effectiveCwd, settlement.projectPath),
        targetPaths: Array.isArray(settlement.targetPaths)
          ? settlement.targetPaths.slice(0, 32).map((value) => summarizePath(value, settlement.projectPath))
          : [],
        behavior: settlement.behavior,
        cause: settlement.cause,
        scope: settlement.scope ?? null,
        matchedRuleId: settlement.matchedRuleId ?? null,
        outsideProject: Boolean(settlement.outsideProject),
        settledAt: settlement.settledAt,
      });
    });
    return true;
  })()`);
}

async function realPermissionEvidence(client) {
  return client.evaluate(`(async () => {
    const hashes = window.__REAL_PERMISSION_HASHES__ ?? [];
    const hashTimeout = await Promise.race([
      Promise.all(hashes).then(() => false),
      new Promise((resolve) => window.setTimeout(() => resolve(true), 5_000)),
    ]);
    return {
      requests: window.__REAL_PERMISSION_REQUESTS__ ?? [],
      settlements: window.__REAL_PERMISSION_SETTLEMENTS__ ?? [],
      hashTimeout,
    };
  })()`);
}

async function executeRealTask(client, taskId, decideRequest) {
  const deadline = Date.now() + REAL_WORKFLOW_TIMEOUT_MS;
  const handled = new Set();
  while (Date.now() < deadline) {
    const state = await client.evaluate(`(async () => ({
      session: await window.api.getSession(${js(taskId)}),
      bypass: Boolean(document.querySelector('[data-testid="bypass-permission-warning"]')),
      pending: (() => {
        const settled = new Set((window.__REAL_PERMISSION_SETTLEMENTS__ ?? []).map((item) => item.requestId));
        return (window.__REAL_PERMISSION_REQUESTS__ ?? []).find((item) => !settled.has(item.requestId)) ?? null;
      })(),
      controls: Array.from(document.querySelectorAll('[data-testid^="permission-"]'))
        .filter((item) => !item.disabled && item.getBoundingClientRect().width > 0)
        .map((item) => item.dataset.testid),
    }))()`);
    assert(!state.bypass, 'A permission lifecycle task requested bypassPermissions.');
    if (state.pending && !handled.has(state.pending.requestId) && state.controls.length > 0) {
      const testId = await decideRequest(state.pending, handled.size, state.controls, client);
      assert(typeof testId === 'string' && state.controls.includes(testId),
        `Permission decision control is unavailable: ${testId}; request=${JSON.stringify(state.pending)}; controls=${state.controls.join(',')}`);
      await clickTestId(client, testId);
      handled.add(state.pending.requestId);
      await sleep(150);
      continue;
    }
    if (state.session && ['completed', 'failed', 'cancelled'].includes(state.session.status)) {
      console.log(`[permission-task] terminal task=${taskId} status=${state.session.status}`);
      await sleep(250);
      const evidence = await realPermissionEvidence(client);
      console.log(`[permission-task] evidence task=${taskId} requests=${evidence.requests.length} settlements=${evidence.settlements.length} hashTimeout=${evidence.hashTimeout}`);
      return { session: state.session, evidence };
    }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for permission lifecycle task ${taskId}.`);
}

async function runSingleCommandTask(instance, prompt, decideRequest) {
  await installRealWorkflowRecorders(instance.client);
  const task = await createTaskFromUi(instance.client);
  await selectAgentMode(instance.client, 'normal');
  await submitWorkflowPrompt(instance.client, prompt);
  const result = await executeRealTask(instance.client, task.id, decideRequest);
  assert(result.session.status === 'completed', `Permission lifecycle task ended in ${result.session.status}.`);
  return { task, ...result };
}

async function openProjectPermissionSettings(client) {
  const openedMenu = await client.evaluate(`(() => {
    const search = document.querySelector('[data-project-search]');
    const sidebar = search?.closest('aside');
    const project = Array.from(sidebar?.querySelectorAll('button') ?? [])
      .find((item) => item.textContent?.trim() === ${js(PROJECT_NAME)});
    if (!project) return false;
    const rect = project.getBoundingClientRect();
    project.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 20,
      clientY: rect.top + 10,
    }));
    return true;
  })()`);
  assert(openedMenu, 'Unable to open the project context menu.');
  await client.waitFor(
    `Array.from(document.querySelectorAll('[role="menu"] button')).some((item) => item.textContent?.includes('项目设置'))`,
    { description: 'project settings context action' },
  );
  assert(await clickControl(client, ['项目设置']), 'Project settings action is unavailable.');
  await client.waitFor(
    `Boolean(document.querySelector('[role="dialog"][aria-label="项目设置"]'))
      && document.body.innerText.includes('权限规则')`,
    { description: 'project permission settings' },
  );
}

async function deleteProjectRuleThroughUi(client, ruleId, screenshotPath = null) {
  await openProjectPermissionSettings(client);
  await client.waitFor(
    `(async () => (await window.api.listProjectPermissionRules(${js(PROJECT_ID)}, { limit: 50, offset: 0 }))
      .items.some((item) => item.id === ${js(ruleId)}))()`,
    { description: 'persisted project permission rule in settings' },
  );
  if (screenshotPath) {
    const capture = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, Buffer.from(capture.data, 'base64'));
  }
  await client.evaluate('window.confirm = () => true');
  const clicked = await client.evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="项目设置"]');
    const button = Array.from(dialog?.querySelectorAll('button') ?? [])
      .find((item) => item.textContent?.trim() === '删除');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  assert(clicked, 'Project permission rule delete control is unavailable.');
  await client.waitFor(
    `(async () => !(await window.api.listProjectPermissionRules(${js(PROJECT_ID)}, { limit: 50, offset: 0 }))
      .items.some((item) => item.id === ${js(ruleId)}))()`,
    { description: 'project permission rule deletion' },
  );
  const closed = await client.evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="项目设置"]');
    const button = Array.from(dialog?.querySelectorAll('button') ?? [])
      .find((item) => item.textContent?.trim() === '取消');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  assert(closed, 'Unable to close project settings after rule deletion.');
}

async function waitForRealPlan(client, workflowId) {
  const deadline = Date.now() + REAL_WORKFLOW_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const workflow = await client.evaluate(`window.api.getWorkflow(${js(workflowId)})`);
    if (workflow?.status === 'waiting_plan_confirmation') return workflow;
    if (workflow && ['failed', 'cancelled'].includes(workflow.status)) {
      throw new Error(`Real Planner ended in ${workflow.status}: ${workflow.failure?.code ?? 'unknown'} ${workflow.failure?.message ?? ''}`);
    }
    await sleep(500);
  }
  throw new Error('Timed out waiting for the real Planner confirmation state.');
}

async function executeRealWorkflow(client, workflowId, options = {}) {
  const deadline = Date.now() + REAL_WORKFLOW_TIMEOUT_MS;
  let permissionScreenshotCaptured = false;
  options.permissionUserDecisions = [];
  while (Date.now() < deadline) {
    const boundary = await client.evaluate(`(() => {
      const bypass = Boolean(document.querySelector('[data-testid="bypass-permission-warning"]'));
      const allow = document.querySelector('[data-testid="${options.permissionScopeFinal
        ? 'permission-allow-task'
        : 'permission-allow-once'}"]');
      const ready = Boolean(allow && !allow.disabled);
      const settled = new Set((window.__REAL_PERMISSION_SETTLEMENTS__ ?? []).map((item) => item.requestId));
      const active = (window.__REAL_PERMISSION_REQUESTS__ ?? []).find((item) => !settled.has(item.requestId)) ?? null;
      return { bypass, ready, active };
    })()`);
    assert(!boundary.bypass, 'The real workflow requested bypassPermissions.');
    if (boundary.ready && options.permissionScopeFinal && !permissionScreenshotCaptured) {
      options.permissionUiEvidence = await client.evaluate(`(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const rect = dialog?.getBoundingClientRect();
        return {
          labels: Array.from(dialog?.querySelectorAll('button') ?? []).map((item) => item.textContent?.trim()),
          dialogFitsViewport: Boolean(rect && rect.left >= 0 && rect.top >= 0
            && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight),
          dialogRect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        };
      })()`);
      if (options.permissionScreenshotPath) {
        const capture = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
        fs.mkdirSync(path.dirname(options.permissionScreenshotPath), { recursive: true });
        fs.writeFileSync(options.permissionScreenshotPath, Buffer.from(capture.data, 'base64'));
        options.permissionUiEvidence.screenshot = options.permissionScreenshotPath;
      }
      permissionScreenshotCaptured = true;
    }
    const clicked = boundary.ready
      ? await client.evaluate(`(() => {
          const allow = document.querySelector('[data-testid="${options.permissionScopeFinal
            ? 'permission-allow-task'
            : 'permission-allow-once'}"]');
          if (!allow || allow.disabled) return false;
          allow.click();
          return true;
        })()`)
      : false;
    if (clicked && boundary.active) {
      options.permissionUserDecisions.push({
        requestId: boundary.active.requestId,
        runId: boundary.active.runId,
        processId: boundary.active.processId,
        toolName: boundary.active.toolName,
        capability: boundary.active.capability,
        risk: boundary.active.risk,
      });
    }
    const workflow = await client.evaluate(`window.api.getWorkflow(${js(workflowId)})`);
    if (workflow?.status === 'completed') return workflow;
    if (workflow && ['failed', 'cancelled', 'paused'].includes(workflow.status)) {
      throw new Error(`Real workflow ended in ${workflow.status}: ${workflow.failure?.code ?? 'unknown'} ${workflow.failure?.message ?? ''}`);
    }
    await sleep(clicked ? 150 : 350);
  }
  throw new Error('Timed out waiting for the real workflow to complete.');
}

async function runRealWorkflowAcceptance(options) {
  const report = {
    kind: 'real-workbench-agent-workflow',
    scope: 'Production Electron + real ClaudeCliAdapter + persisted Planner/Coder/Tester/Reviewer workflow.',
    request: '增加一个数学计算模块，并添加完整测试。',
    startedAt: new Date().toISOString(),
    completedAt: null,
    success: false,
    build: { requested: options.build, outputs: [] },
    electron: null,
    workflow: null,
    verification: null,
    database: null,
    productionArtifacts: null,
    cleanup: { processStopped: false, tempRemoved: false },
  };
  let fixture = null;
  let instance = null;
  let failure = null;
  try {
    if (options.permissionScopeFinal && options.reportPath) {
      options.permissionScreenshotPath = path.join(
        path.dirname(options.reportPath),
        'electron-permission-scope-final-dialog.png',
      );
    }
    if (options.build) runNpm(['run', 'build'], { inherit: true });
    report.build.outputs = assertBuildOutputs();
    fixture = createFixture();
    instance = await launchElectron(fixture, true);
    report.electron = {
      pid: instance.child.pid,
      productionBuild: true,
      fakeAdapter: false,
      rendererNodeIntegrationDisabled: await instance.client.evaluate(
        `typeof require === 'undefined' && typeof process === 'undefined'`,
      ),
    };
    assert(report.electron.rendererNodeIntegrationDisabled, 'Renderer Node integration is unexpectedly enabled.');
    const installation = await instance.client.evaluate('window.api.checkInstallation()');
    assert(installation.installed && installation.path !== 'fake-claude', 'Real ClaudeCliAdapter is unavailable.');
    report.electron.claude = {
      installed: true,
      version: installation.version ?? null,
      transport: 'ClaudeCliAdapter',
    };
    await installRealWorkflowRecorders(instance.client);

    const projects = await instance.client.evaluate('window.api.listProjects()');
    assert(projects.length === 1 && projects[0].path === fixture.projectPath, 'Disposable project registration failed.');
    await instance.client.waitFor(`document.body.innerText.includes(${js(PROJECT_NAME)})`, {
      description: 'real workflow disposable project',
      timeoutMs: STEP_TIMEOUT_MS,
    });
    await selectProject(instance.client);
    const task = await createTaskFromUi(instance.client);
    await selectPlanMode(instance.client);
    await submitWorkflowPrompt(instance.client, REAL_WORKFLOW_PROMPT);
    await instance.client.waitFor(
      `(async () => Boolean(await window.api.getWorkflowByTask(${js(task.id)})))()`,
      { description: 'real workflow creation', timeoutMs: STEP_TIMEOUT_MS },
    );
    let workflow = await instance.client.evaluate(`window.api.getWorkflowByTask(${js(task.id)})`);
    assert(workflow?.taskId === task.id && workflow.projectPath === fixture.projectPath, 'Real workflow identity mismatch.');
    workflow = await waitForRealPlan(instance.client, workflow.id);
    assert(workflow.plan?.steps?.length > 0, 'Real Planner returned no structured steps.');
    assert(workflow.plan.filesExpected.length > 0, 'Real Planner returned no expected files.');
    await instance.client.waitFor(
      `Boolean(document.querySelector('[data-testid="workflow-plan-review"]'))`,
      { description: 'real structured plan review UI', timeoutMs: STEP_TIMEOUT_MS },
    );
    await clickTestId(instance.client, 'workflow-start-execution');
    workflow = await executeRealWorkflow(instance.client, workflow.id, options);

    const stagePage = await instance.client.evaluate(
      `window.api.listWorkflowStages(${js(workflow.id)}, { limit: 100, offset: 0 })`,
    );
    const stageNames = stagePage.items.map((item) => item.stage);
    for (const required of ['planner', 'coder', 'tester', 'reviewer']) {
      assert(stageNames.includes(required), `Real workflow omitted ${required}.`);
    }
    assert(stagePage.items.every((item) => item.status === 'completed'), 'A real workflow stage did not complete.');
    const review = await instance.client.evaluate(`window.api.getWorkflowReview(${js(workflow.id)})`);
    assert(review && review.tests.passed > 0 && review.tests.failed === 0, 'Real Reviewer/Tester result is not release-ready.');
    if (options.permissionScopeFinal) {
      assert(review.round >= 2, 'The real workflow did not enter the required Reviewer-to-Fix loop.');
      for (const stage of ['coder', 'tester', 'reviewer']) {
        assert(
          stagePage.items.some((item) => item.stage === stage && item.round >= 2),
          `The fix loop omitted the round-two ${stage} stage.`,
        );
      }
    }
    await instance.client.waitFor(
      `(async () => (await window.api.listCheckpoints(${js(task.id)}))
        .some((item) => item.type === 'task_completed'))()`,
      { description: 'real terminal workflow checkpoint', timeoutMs: STEP_TIMEOUT_MS },
    );
    const checkpoints = await instance.client.evaluate(`window.api.listCheckpoints(${js(task.id)})`);
    for (const required of ['before_plan', 'after_plan', 'before_execute', 'after_execute', 'before_review', 'task_completed']) {
      assert(checkpoints.some((checkpoint) => checkpoint.type === required), `Real workflow omitted ${required} checkpoint.`);
    }
    const preview = await instance.client.evaluate(`window.api.createWorkflowCommitPreview(${js(workflow.id)})`);
    assert(preview.fileCount > 0 && preview.files.length === preview.fileCount, 'Commit Preview has no real changes.');
    assert(preview.message.includes('## Plan') && preview.message.includes('## Review'), 'Commit Preview omitted workflow context.');
    const permissionEvidence = await instance.client.evaluate(`(async () => {
      await Promise.all(window.__REAL_PERMISSION_HASHES__ ?? []);
      return {
        requests: window.__REAL_PERMISSION_REQUESTS__ ?? [],
        settlements: window.__REAL_PERMISSION_SETTLEMENTS__ ?? [],
      };
    })()`);
    // Preserve diagnostic evidence even when a strict scope assertion below
    // fails; a failed production run must remain explainable and reproducible.
    report.permissionEvidence = permissionEvidence;
    assert(permissionEvidence.requests.length > 0, 'Real Coder/Tester produced no PermissionBroker request.');
    assert(permissionEvidence.requests.every((item) => item.kind !== 'bypass_permissions'), 'A bypass permission request was observed.');
    assert(permissionEvidence.settlements.some((item) => item.behavior === 'allow'), 'No permission allow decision was recorded.');
    assert(
      permissionEvidence.requests.every((item) => (
        !item.input.keys.includes('command')
        || /^[a-f0-9]{64}$/u.test(item.input.command?.sha256 ?? '')
      )),
      'A recorded command is missing its SHA-256 evidence.',
    );
    if (options.permissionScopeBaseline) {
      const bashRequests = permissionEvidence.requests.filter((item) => item.toolName === 'Bash');
      const bashRunIds = [...new Set(bashRequests.map((item) => item.runId))];
      assert(
        bashRequests.length >= 2 && bashRunIds.length >= 2,
        'The baseline did not produce repeated Bash prompts across Agent stage runs.',
      );
      permissionEvidence.legacyScopeDiagnosis = {
        taskGrantDecision: 'allow_for_session',
        repeatedBashPrompts: bashRequests.length,
        distinctRunIds: bashRunIds,
        cacheKey: 'runId + sha256(toolName + NUL + canonicalJson(fullInput))',
        cacheMissReason: 'Agent stage created a new runId; completeRun removed the previous run cache.',
      };
    }
    if (options.permissionScopeFinal) {
      const bashRequests = permissionEvidence.requests.filter((item) => item.toolName === 'Bash');
      const testRequests = bashRequests.filter((item) => item.capability === 'shell.test');
      const visibleTestDecisions = options.permissionUserDecisions.filter((item) => (
        item.toolName === 'Bash' && item.capability === 'shell.test'
      ));
      const bashSettlements = permissionEvidence.settlements.filter((item) => item.toolName === 'Bash');
      const testSettlements = bashSettlements.filter((item) => item.capability === 'shell.test');
      const userGrant = testSettlements.find((item) => item.cause === 'allow_for_task');
      const automaticGrants = testSettlements.filter((item) => item.cause === 'permission_auto_allowed');
      const sameRunAutomaticGrants = automaticGrants.filter((item) => item.runId === userGrant?.runId);
      const crossRunAutomaticGrants = automaticGrants.filter((item) => item.runId !== userGrant?.runId);
      const processIds = [...new Set(testSettlements.map((item) => item.processId).filter(Number.isInteger))];
      const runIds = [...new Set(testSettlements.map((item) => item.runId).filter(Boolean))];
      assert(testRequests.length >= 1, 'The real workflow emitted no shell.test permission request.');
      assert(
        visibleTestDecisions.length === 1,
        `Expected one user-visible shell.test decision, found ${visibleTestDecisions.length}.`,
      );
      assert(userGrant, 'The first Bash request was not granted for the task.');
      assert(
        sameRunAutomaticGrants.length >= 1,
        'A repeated shell.test command in the same Agent run did not hit the task rule automatically.',
      );
      assert(
        crossRunAutomaticGrants.length >= 1,
        'A shell.test command in a later Agent run did not hit the task rule automatically.',
      );
      assert(runIds.length >= 2, 'Task rule reuse was not observed across Agent run IDs.');
      assert(processIds.length >= 2, 'Task rule reuse was not observed across Claude CLI process IDs.');
      assert(
        automaticGrants.every((item) => item.scope === 'task' && item.matchedRuleId),
        'Automatic Bash grants did not identify their matched task rule.',
      );
      assert(options.permissionUiEvidence?.dialogFitsViewport, 'Permission dialog did not fit the Electron viewport.');
      permissionEvidence.taskScopeVerification = {
        emittedBashRequests: bashRequests.length,
        emittedShellTestRequests: testRequests.length,
        visibleShellTestPrompts: visibleTestDecisions.length,
        userDecisions: options.permissionUserDecisions,
        otherBashCapabilitiesPrompted: [...new Set(
          bashRequests.filter((item) => item.capability !== 'shell.test').map((item) => item.capability),
        )],
        automaticBashGrants: automaticGrants.length,
        sameRunAutomaticBashGrants: sameRunAutomaticGrants.length,
        crossRunAutomaticBashGrants: crossRunAutomaticGrants.length,
        distinctRunIds: runIds,
        distinctProcessIds: processIds,
        capability: userGrant.capability,
        scope: userGrant.scope,
        ui: options.permissionUiEvidence,
      };
    }

    const statusLines = git(fixture.projectPath, ['status', '--porcelain=v1', '--untracked-files=all'])
      .split(/\r?\n/u).filter(Boolean);
    const changedFiles = statusLines.map((line) => line.slice(3).replace(/\\/gu, '/')).sort();
    for (const required of ['src/calculator.js', 'test/calculator.test.js']) {
      assert(changedFiles.includes(required), `Real Coder omitted ${required}.`);
    }
    const testOutput = runNpm(['test', '--', '--test-reporter=spec'], {
      cwd: fixture.projectPath,
    });
    assert(gitHead(fixture.projectPath) === fixture.projectGit.initialHead, 'Real workflow changed Git HEAD.');

    report.workflow = {
      id: workflow.id,
      taskId: task.id,
      status: workflow.status,
      plan: {
        title: workflow.plan.title,
        steps: workflow.plan.steps.length,
        riskLevel: workflow.plan.riskLevel,
        filesExpected: workflow.plan.filesExpected,
      },
      stages: stagePage.items.map((item) => ({
        stage: item.stage,
        round: item.round,
        status: item.status,
        permissionCount: item.permissions?.length ?? 0,
      })),
      review: {
        round: review.round,
        score: review.score,
        tests: review.tests,
        issueSeverities: review.issues.map((issue) => issue.severity),
      },
      checkpoints: checkpointSummary(checkpoints),
      permissions: permissionEvidence,
      commitPreview: {
        subject: preview.subject,
        files: preview.files,
        fileCount: preview.fileCount,
        additions: preview.additions,
        deletions: preview.deletions,
        includesPlan: preview.message.includes('## Plan'),
        includesReview: preview.message.includes('## Review'),
      },
    };
    report.verification = {
      changedFiles,
      gitHeadUnchanged: true,
      npmTestPassed: true,
      testSummary: testOutput.split(/\r?\n/u).slice(-10),
      rendererErrorCount: instance.rendererErrors.length,
    };
    if (options.permissionScopeFinal && options.permissionLifecycleMatrix) {
      const lifecyclePrompt = [
        '不要修改任何文件，也不要安装依赖。',
        '使用 Bash 工具，命令必须精确为：npm test',
        '不要添加 cd、重定向、timeout 或任何其他参数；读取测试结果后立即结束。',
        '不要使用其他命令或工具。',
      ].join('\n');
      const rendererErrors = [...instance.rendererErrors];

      const taskB = await runSingleCommandTask(
        instance,
        lifecyclePrompt,
        () => 'permission-allow-once',
      );
      const taskBBashRequests = taskB.evidence.requests.filter((item) => item.toolName === 'Bash');
      assert(taskBBashRequests.length === 1, 'A new task inherited the completed workflow task rule.');

      const projectGrantTask = await runSingleCommandTask(
        instance,
        lifecyclePrompt,
        (request) => request.toolName === 'Bash'
          && request.capability === 'shell.test'
          && request.projectRulePersistable
          ? 'permission-allow-project'
          : 'permission-allow-once',
      );
      const createdRules = await instance.client.evaluate(
        `window.api.listProjectPermissionRules(${js(PROJECT_ID)}, { limit: 50, offset: 0 })`,
      );
      const persistedTestRule = createdRules.items.find((item) => item.capability === 'shell.test');
      assert(
        persistedTestRule?.enabled,
        `The explicit shell.test project rule was not persisted: ${JSON.stringify(projectGrantTask.evidence)}`,
      );
      assert(
        projectGrantTask.evidence.settlements.some((item) => (
          item.toolName === 'Bash' && item.cause === 'allow_for_project' && item.scope === 'project'
        )),
        'The project permission decision was not settled as project-scoped.',
      );

      rendererErrors.push(...instance.rendererErrors);
      const initialPid = instance.child.pid;
      await stopElectron(instance);
      instance = await launchElectron(fixture, true);
      report.electron.restarts = [{ fromPid: initialPid, toPid: instance.child.pid }];
      await installRealWorkflowRecorders(instance.client);
      await selectProject(instance.client);
      const restartedRules = await instance.client.evaluate(
        `window.api.listProjectPermissionRules(${js(PROJECT_ID)}, { limit: 50, offset: 0 })`,
      );
      assert(
        restartedRules.items.some((item) => item.id === persistedTestRule.id && item.enabled),
        'The project permission rule did not survive an Electron restart.',
      );

      const projectHitTask = await runSingleCommandTask(
        instance,
        lifecyclePrompt,
        () => 'permission-allow-once',
      );
      const projectHitBashRequests = projectHitTask.evidence.requests.filter((item) => item.toolName === 'Bash');
      const projectAutoHits = projectHitTask.evidence.settlements.filter((item) => (
        item.toolName === 'Bash'
        && item.cause === 'permission_auto_allowed'
        && item.scope === 'project'
        && item.matchedRuleId === persistedTestRule.id
      ));
      assert(projectHitBashRequests.length === 0, 'A persisted project shell.test rule did not suppress the prompt.');
      assert(projectAutoHits.length >= 1, 'The restarted task did not audit a project rule auto-hit.');

      const ruleSettingsScreenshot = options.reportPath
        ? path.join(path.dirname(options.reportPath), 'electron-project-permission-rule-settings.png')
        : null;
      await deleteProjectRuleThroughUi(
        instance.client,
        persistedTestRule.id,
        ruleSettingsScreenshot,
      );
      const afterDeleteTask = await runSingleCommandTask(
        instance,
        lifecyclePrompt,
        () => 'permission-allow-once',
      );
      const afterDeleteBashRequests = afterDeleteTask.evidence.requests.filter((item) => item.toolName === 'Bash');
      assert(afterDeleteBashRequests.length === 1, 'Deleting the project rule did not restore the Bash prompt.');

      rendererErrors.push(...instance.rendererErrors);
      report.verification.rendererErrorCount = rendererErrors.length;
      assert(rendererErrors.length === 0, `Renderer reported ${rendererErrors.length} lifecycle error(s).`);
      report.permissionLifecycle = {
        newTaskIsolation: {
          taskId: taskB.task.id,
          visibleBashPrompts: taskBBashRequests.length,
        },
        projectRule: {
          ruleId: persistedTestRule.id,
          capability: persistedTestRule.capability,
          survivedRestart: true,
          visibleBashPromptsAfterRestart: projectHitBashRequests.length,
          automaticHitsAfterRestart: projectAutoHits.length,
          settingsScreenshot: ruleSettingsScreenshot,
          deletedThroughSettingsUi: true,
          visibleBashPromptsAfterDelete: afterDeleteBashRequests.length,
        },
      };
    }
    assert(instance.rendererErrors.length === 0, `Renderer reported ${instance.rendererErrors.length} error(s).`);
    await stopElectron(instance);
    instance = null;
    report.cleanup.processStopped = true;
    report.database = realWorkflowDatabaseEvidence(fixture.databasePath, task.id, workflow.id);
    if (options.permissionScopeFinal) {
      assert(report.database.permissionAudit.autoAllowed.length >= 1, 'SQLite contains no automatic permission audit event.');
      assert(
        report.database.permissionAudit.autoAllowed.every((item) => (
          item.scope === 'task' && item.matchedRuleIdPresent && item.taskMatches
        )),
        'SQLite automatic permission audit identity is incomplete.',
      );
      assert(report.database.projectRuleCount === 0, 'Task-only acceptance unexpectedly persisted a project rule.');
    }
    report.success = true;
  } catch (error) {
    failure = error;
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (instance) {
      await stopElectron(instance);
      report.cleanup.processStopped = true;
    }
    if (fixture && !options.keepTemp) {
      safeRemoveFixture(fixture.root);
      report.cleanup.tempRemoved = true;
    }
    report.productionArtifacts = productionBuildArtifactEvidence();
    report.completedAt = new Date().toISOString();
    if (options.reportPath) writeJson(options.reportPath, report);
  }
  console.log(`ELECTRON_REAL_WORKFLOW_RESULT=${JSON.stringify(report)}`);
  if (failure) throw failure;
}

async function runPermissionLifecycleAcceptance(options) {
  const report = {
    kind: 'real-workbench-permission-lifecycle',
    scope: 'Production Electron + real ClaudeCliAdapter + task/project permission lifecycle.',
    startedAt: new Date().toISOString(),
    completedAt: null,
    success: false,
    electron: { launches: [], rendererNodeIntegrationDisabled: null, claude: null },
    cases: null,
    database: null,
    productionArtifacts: null,
    cleanup: { processStopped: false, tempRemoved: false },
  };
  const lifecyclePrompt = [
    '不要修改任何文件，也不要安装依赖。',
    '使用 Bash 工具，命令必须精确为：npm test',
    '不要添加 cd、重定向、timeout 或任何其他参数；读取测试结果后立即结束。',
    '不要使用其他命令或工具。',
  ].join('\n');
  let fixture = null;
  let instance = null;
  let failure = null;
  try {
    if (options.build) runNpm(['run', 'build'], { inherit: true });
    assertBuildOutputs();
    fixture = createFixture();
    instance = await launchElectron(fixture, true);
    report.electron.launches.push({ pid: instance.child.pid, phase: 'initial' });
    report.electron.rendererNodeIntegrationDisabled = await instance.client.evaluate(
      `typeof require === 'undefined' && typeof process === 'undefined'`,
    );
    assert(report.electron.rendererNodeIntegrationDisabled, 'Renderer Node integration is unexpectedly enabled.');
    const installation = await instance.client.evaluate('window.api.checkInstallation()');
    assert(installation.installed && installation.path !== 'fake-claude', 'Real ClaudeCliAdapter is unavailable.');
    report.electron.claude = {
      installed: true,
      version: installation.version ?? null,
      transport: 'ClaudeCliAdapter',
    };
    await instance.client.waitFor(`document.body.innerText.includes(${js(PROJECT_NAME)})`, {
      description: 'permission lifecycle project after initial launch',
      timeoutMs: STEP_TIMEOUT_MS,
    });
    await selectProject(instance.client);

    const taskGrant = await runSingleCommandTask(
      instance,
      lifecyclePrompt,
      (request) => request.capability === 'shell.test'
        ? 'permission-allow-task'
        : 'permission-allow-once',
    );
    const taskGrantSettlement = taskGrant.evidence.settlements.find((item) => (
      item.capability === 'shell.test' && item.cause === 'allow_for_task' && item.scope === 'task'
    ));
    assert(taskGrantSettlement, 'The lifecycle seed task did not receive a task-scoped test rule.');

    const newTask = await runSingleCommandTask(
      instance,
      lifecyclePrompt,
      () => 'permission-allow-once',
    );
    const newTaskPrompts = newTask.evidence.requests.filter((item) => item.capability === 'shell.test');
    assert(newTaskPrompts.length === 1, 'A completed task rule leaked into a new task.');

    const projectGrant = await runSingleCommandTask(
      instance,
      lifecyclePrompt,
      (request) => request.capability === 'shell.test' && request.projectRulePersistable
        ? 'permission-allow-project'
        : 'permission-allow-once',
    );
    const createdRules = await instance.client.evaluate(
      `window.api.listProjectPermissionRules(${js(PROJECT_ID)}, { limit: 50, offset: 0 })`,
    );
    const persistedRule = createdRules.items.find((item) => item.capability === 'shell.test');
    assert(
      persistedRule?.enabled,
      `The project shell.test rule was not persisted: ${JSON.stringify(projectGrant.evidence)}`,
    );
    assert(projectGrant.evidence.settlements.some((item) => (
      item.capability === 'shell.test' && item.cause === 'allow_for_project' && item.scope === 'project'
    )), 'The shell.test project grant was not recorded with project scope.');

    const rendererErrors = [...instance.rendererErrors];
    await stopElectron(instance);
    instance = await launchElectron(fixture, true);
    report.electron.launches.push({ pid: instance.child.pid, phase: 'restart' });
    await instance.client.waitFor(`document.body.innerText.includes(${js(PROJECT_NAME)})`, {
      description: 'permission lifecycle project after restart',
      timeoutMs: STEP_TIMEOUT_MS,
    });
    await selectProject(instance.client);
    const restoredRules = await instance.client.evaluate(
      `window.api.listProjectPermissionRules(${js(PROJECT_ID)}, { limit: 50, offset: 0 })`,
    );
    assert(
      restoredRules.items.some((item) => item.id === persistedRule.id && item.enabled),
      'The project rule did not survive a production Electron restart.',
    );

    const projectHit = await runSingleCommandTask(
      instance,
      lifecyclePrompt,
      () => 'permission-allow-once',
    );
    const projectHitPrompts = projectHit.evidence.requests.filter((item) => item.capability === 'shell.test');
    const projectAutoHits = projectHit.evidence.settlements.filter((item) => (
      item.capability === 'shell.test'
      && item.cause === 'permission_auto_allowed'
      && item.scope === 'project'
      && item.matchedRuleId === persistedRule.id
    ));
    assert(projectHitPrompts.length === 0, 'The restored project rule did not suppress the test prompt.');
    assert(projectAutoHits.length >= 1, 'The restored project rule emitted no automatic audit settlement.');

    const settingsScreenshot = options.reportPath
      ? path.join(path.dirname(options.reportPath), 'electron-project-permission-rule-settings.png')
      : null;
    await deleteProjectRuleThroughUi(instance.client, persistedRule.id, settingsScreenshot);
    const afterDelete = await runSingleCommandTask(
      instance,
      lifecyclePrompt,
      () => 'permission-allow-once',
    );
    const afterDeletePrompts = afterDelete.evidence.requests.filter((item) => item.capability === 'shell.test');
    assert(afterDeletePrompts.length === 1, 'Deleting the project rule did not restore the test prompt.');

    rendererErrors.push(...instance.rendererErrors);
    assert(rendererErrors.length === 0, `Renderer reported ${rendererErrors.length} lifecycle error(s).`);
    report.cases = {
      taskRuleTerminalCleanup: {
        grantingTaskId: taskGrant.task.id,
        nextTaskId: newTask.task.id,
        nextTaskVisibleTestPrompts: newTaskPrompts.length,
      },
      projectRulePersistence: {
        grantingTaskId: projectGrant.task.id,
        ruleId: persistedRule.id,
        capability: persistedRule.capability,
        survivedRestart: true,
        restartedTaskId: projectHit.task.id,
        restartedVisibleTestPrompts: projectHitPrompts.length,
        restartedAutomaticHits: projectAutoHits.length,
        settingsScreenshot,
      },
      projectRuleRevocation: {
        deletedThroughSettingsUi: true,
        afterDeleteTaskId: afterDelete.task.id,
        afterDeleteVisibleTestPrompts: afterDeletePrompts.length,
      },
      rendererErrorCount: rendererErrors.length,
    };

    await stopElectron(instance);
    instance = null;
    report.cleanup.processStopped = true;
    const database = new BetterSqlite3(fixture.databasePath, { readonly: true });
    try {
      const autoProjectEvents = Number(database.prepare(`
        SELECT COUNT(*) AS count FROM events
        WHERE event_type = 'permission_auto_allowed'
          AND json_extract(payload_json, '$.scope') = 'project'
      `).get().count);
      const remainingRules = Number(database.prepare(
        'SELECT COUNT(*) AS count FROM project_permission_rules',
      ).get().count);
      report.database = {
        schemaVersion: Number(database.pragma('user_version', { simple: true })),
        integrity: database.pragma('integrity_check', { simple: true }),
        foreignKeyViolations: database.pragma('foreign_key_check').length,
        autoProjectEvents,
        remainingRules,
      };
    } finally {
      database.close();
    }
    assert(report.database.schemaVersion === 5, 'Permission lifecycle database is not schema v5.');
    assert(report.database.integrity === 'ok' && report.database.foreignKeyViolations === 0,
      'Permission lifecycle database integrity failed.');
    assert(report.database.autoProjectEvents >= 1, 'SQLite contains no project-rule automatic audit event.');
    assert(report.database.remainingRules === 0, 'Project rule remained after UI deletion.');
    report.success = true;
  } catch (error) {
    failure = error;
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (instance) {
      await stopElectron(instance);
      report.cleanup.processStopped = true;
    }
    if (fixture && !options.keepTemp) {
      safeRemoveFixture(fixture.root);
      report.cleanup.tempRemoved = true;
    }
    report.productionArtifacts = productionBuildArtifactEvidence();
    report.completedAt = new Date().toISOString();
    if (options.reportPath) writeJson(options.reportPath, report);
  }
  console.log(`ELECTRON_PERMISSION_LIFECYCLE_RESULT=${JSON.stringify(report)}`);
  if (failure) throw failure;
}

async function runPermissionBoundaryAcceptance(options) {
  const report = {
    kind: 'real-workbench-permission-boundaries',
    scope: 'Production Electron + real ClaudeCliAdapter risk and external-root boundaries.',
    startedAt: new Date().toISOString(),
    completedAt: null,
    success: false,
    electron: null,
    riskEscalation: null,
    crossProject: null,
    productionArtifacts: null,
    cleanup: { processStopped: false, tempRemoved: false },
  };
  let fixture = null;
  let instance = null;
  let failure = null;
  try {
    if (options.build) runNpm(['run', 'build'], { inherit: true });
    assertBuildOutputs();
    fixture = createFixture();
    const externalB = path.join(fixture.root, 'external-project-b');
    const externalC = path.join(fixture.root, 'external-project-c');
    const registeredTargetId = 'workflow-registered-target-project';
    const registeredTargetName = 'Registered Target Acceptance Project';
    const registeredTarget = path.join(fixture.root, 'registered-target-project');
    fs.mkdirSync(externalB, { recursive: true });
    fs.mkdirSync(externalC, { recursive: true });
    fs.mkdirSync(registeredTarget, { recursive: true });
    createGitProject(externalB);
    createGitProject(externalC);
    createGitProject(registeredTarget);
    fs.writeFileSync(path.join(registeredTarget, 'REGISTERED_TARGET_ONLY.txt'), 'target project evidence\n', 'utf8');
    const legacy = JSON.parse(fs.readFileSync(fixture.databasePath, 'utf8'));
    const registeredAt = new Date().toISOString();
    legacy.projects[registeredTargetId] = {
      id: registeredTargetId,
      name: registeredTargetName,
      path: registeredTarget,
      created_at: registeredAt,
      last_opened_at: registeredAt,
    };
    writeJson(fixture.databasePath, legacy);
    const deleteTarget = path.join(fixture.projectPath, 'boundary-delete-target');
    fs.mkdirSync(deleteTarget, { recursive: true });
    fs.writeFileSync(path.join(deleteTarget, 'keep.txt'), 'must remain\n', 'utf8');

    instance = await launchElectron(fixture, true);
    report.electron = {
      pid: instance.child.pid,
      productionBuild: true,
      rendererNodeIntegrationDisabled: await instance.client.evaluate(
        `typeof require === 'undefined' && typeof process === 'undefined'`,
      ),
    };
    assert(report.electron.rendererNodeIntegrationDisabled, 'Renderer Node integration is unexpectedly enabled.');
    await instance.client.waitFor(`document.body.innerText.includes(${js(PROJECT_NAME)})`, {
      description: 'permission boundary project', timeoutMs: STEP_TIMEOUT_MS,
    });
    await selectProject(instance.client);

    const switchSourceTask = await createTaskFromUi(instance.client);
    const switchPrompt = `请检查已注册项目 ${registeredTarget}，但在我确认切换前不要执行。`;
    await submitWorkflowPrompt(instance.client, switchPrompt);
    await instance.client.waitFor(
      `Boolean(document.querySelector('[data-testid="prompt-project-switch-dialog"]'))`,
      { description: 'pre-spawn registered project switch confirmation', timeoutMs: STEP_TIMEOUT_MS },
    );
    const switchDialog = await instance.client.evaluate(`(() => {
      const dialog = document.querySelector('[data-testid="prompt-project-switch-dialog"]');
      return {
        text: dialog?.innerText ?? '',
        currentPathVisible: Boolean(dialog?.innerText.includes(${js(fixture.projectPath)})),
        targetPathVisible: Boolean(dialog?.innerText.includes(${js(registeredTarget)})),
        holisticBindingVisible: ['Git', 'Checkpoint', 'Diff', '文件监控', '权限绑定']
          .every((label) => dialog?.innerText.includes(label)),
      };
    })()`);
    assert(switchDialog.currentPathVisible && switchDialog.targetPathVisible,
      'Pre-spawn switch confirmation omitted current or target project path.');
    assert(switchDialog.holisticBindingVisible,
      'Pre-spawn switch confirmation omitted holistic project binding semantics.');
    const switchScreenshot = options.reportPath
      ? path.join(path.dirname(options.reportPath), 'electron-project-switch-confirmation.png')
      : null;
    if (switchScreenshot) {
      const capture = await instance.client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.mkdirSync(path.dirname(switchScreenshot), { recursive: true });
      fs.writeFileSync(switchScreenshot, Buffer.from(capture.data, 'base64'));
    }
    await clickTestId(instance.client, 'prompt-project-switch-confirm');
    await instance.client.waitFor(
      `(async () => {
        const sessions = await window.api.listSessions(${js(registeredTargetId)});
        const textarea = Array.from(document.querySelectorAll('textarea')).find((item) => !item.disabled);
        return sessions.length === 1
          && textarea?.value === ${js(switchPrompt)}
          && !document.querySelector('[data-testid="prompt-project-switch-dialog"]');
      })()`,
      { description: 'holistic target project switch without execution', timeoutMs: STEP_TIMEOUT_MS },
    );
    const [switchTargetTask] = await instance.client.evaluate(
      `window.api.listSessions(${js(registeredTargetId)})`,
    );
    const switchSourceMessages = await instance.client.evaluate(
      `window.api.listMessages(${js(switchSourceTask.id)})`,
    );
    const switchTargetMessages = await instance.client.evaluate(
      `window.api.listMessages(${js(switchTargetTask.id)})`,
    );
    assert(switchSourceMessages.length === 0 && switchTargetMessages.length === 0,
      'Project-target confirmation executed the prompt instead of switching only.');
    assert(!await instance.client.evaluate(`window.api.getWorkflowByTask(${js(switchSourceTask.id)})`),
      'Project-target confirmation created a workflow in the source project.');
    assert(!await instance.client.evaluate(`window.api.getWorkflowByTask(${js(switchTargetTask.id)})`),
      'Project-target confirmation executed a workflow in the target project.');

    await installRealWorkflowRecorders(instance.client);
    await selectAgentMode(instance.client, 'normal', registeredTargetId);
    const switchedExecutionPrompt = [
      '在当前已切换的目标项目中创建文件 SWITCHED_TARGET_OUTPUT.txt。',
      '文件内容必须精确为：holistic project binding verified',
      '不要访问其他项目，不要创建 commit。',
    ].join('\n');
    await submitWorkflowPrompt(instance.client, switchedExecutionPrompt);
    const switchedExecution = await executeRealTask(
      instance.client,
      switchTargetTask.id,
      async (request) => request.capability === 'tool.write'
        ? 'permission-allow-task'
        : 'permission-allow-once',
    );
    assert(switchedExecution.session.status === 'completed',
      'The explicitly re-submitted target-project task did not complete.');
    const switchedOutputPath = path.join(registeredTarget, 'SWITCHED_TARGET_OUTPUT.txt');
    assert(fs.readFileSync(switchedOutputPath, 'utf8').trim() === 'holistic project binding verified',
      'The confirmed target-project task wrote outside or did not write the expected target file.');
    await openWorkspaceDrawer(instance.client);
    await selectDrawerTab(instance.client, 'files');
    await instance.client.waitFor(
      `document.querySelector('[data-testid="workspace-right-drawer"]')?.innerText.includes('SWITCHED_TARGET_OUTPUT.txt')`,
      { description: 'File Changes rebound to registered target project', timeoutMs: STEP_TIMEOUT_MS },
    );
    await selectDrawerTab(instance.client, 'git');
    await instance.client.waitFor(
      `document.querySelector('[data-testid="workspace-right-drawer"]')?.innerText.includes('REGISTERED_TARGET_ONLY.txt')`,
      { description: 'Git drawer rebound to registered target project', timeoutMs: STEP_TIMEOUT_MS },
    );
    const targetGit = await instance.client.evaluate(
      `window.api.getGitWorkspaceStatus(${js(registeredTargetId)}, ${js(registeredTarget)})`,
    );
    const targetDiff = await instance.client.evaluate(
      `window.api.getGitWorkspaceDiff(${js(registeredTargetId)}, ${js(registeredTarget)}, { paths: ['REGISTERED_TARGET_ONLY.txt'] })`,
    );
    const targetCheckpoints = await instance.client.evaluate(
      `window.api.listCheckpoints(${js(switchTargetTask.id)})`,
    );
    assert(targetGit.files.some((file) => file.filePath === 'REGISTERED_TARGET_ONLY.txt')
      && targetGit.files.some((file) => file.filePath === 'SWITCHED_TARGET_OUTPUT.txt')
      && targetDiff.some((file) => file.filePath === 'REGISTERED_TARGET_ONLY.txt'),
    'Git and Diff did not rebind to the confirmed target project.');
    assert(targetCheckpoints.some((checkpoint) => checkpoint.type === 'before_task')
      && targetCheckpoints.some((checkpoint) => checkpoint.type === 'task_completed'),
    'Checkpoint lifecycle did not follow the explicitly confirmed target task.');
    const preSpawnSwitch = {
      sourceTaskId: switchSourceTask.id,
      targetTaskId: switchTargetTask.id,
      sourceProject: fixture.projectPath,
      targetProject: registeredTarget,
      promptExecuted: false,
      currentPathVisible: switchDialog.currentPathVisible,
      targetPathVisible: switchDialog.targetPathVisible,
      holisticBindingVisible: switchDialog.holisticBindingVisible,
      gitBoundToTarget: true,
      diffBoundToTarget: true,
      fileChangesBoundToTarget: true,
      checkpointBoundToTargetTask: true,
      targetExecution: {
        status: switchedExecution.session.status,
        outputFile: 'SWITCHED_TARGET_OUTPUT.txt',
        checkpointCount: targetCheckpoints.length,
      },
      screenshot: switchScreenshot,
    };
    await selectProject(instance.client);

    await installRealWorkflowRecorders(instance.client);
    const installTask = await createTaskFromUi(instance.client);
    await selectAgentMode(instance.client, 'normal');
    await submitWorkflowPrompt(instance.client, [
      '不要修改文件。必须按顺序使用 Bash 请求以下两个命令，每个命令只请求一次：',
      '1. npm test',
      '2. npm install lodash',
      '第二个命令如果被拒绝，不要使用替代命令，直接结束。',
    ].join('\n'));
    const installDecisions = [];
    const installResult = await executeRealTask(
      instance.client,
      installTask.id,
      async (request, _index, controls) => {
        installDecisions.push({
          capability: request.capability,
          risk: request.risk,
          availableControls: controls,
        });
        if (request.capability === 'shell.test') return 'permission-allow-task';
        if (request.capability === 'shell.package_install') return 'permission-deny';
        return 'permission-allow-once';
      },
    );
    const installRequest = installResult.evidence.requests.find((item) => (
      item.capability === 'shell.package_install'
    ));
    assert(installRequest, 'The real risk task did not request package installation.');
    assert(installResult.evidence.settlements.some((item) => (
      item.capability === 'shell.package_install' && item.cause === 'deny'
    )), 'The package-install escalation was not independently denied.');

    await installRealWorkflowRecorders(instance.client);
    const destructiveTask = await createTaskFromUi(instance.client);
    await selectAgentMode(instance.client, 'normal');
    await submitWorkflowPrompt(instance.client, [
      '使用 Bash 工具只请求一次以下命令，不要修改命令，也不要使用替代命令：',
      'rm -rf boundary-delete-target',
      '如果权限被拒绝，立即结束。',
    ].join('\n'));
    let destructiveUi = null;
    const destructiveScreenshot = options.reportPath
      ? path.join(path.dirname(options.reportPath), 'electron-permission-high-risk-dialog.png')
      : null;
    const destructiveResult = await executeRealTask(
      instance.client,
      destructiveTask.id,
      async (request, _index, controls, client) => {
        if (request.capability === 'shell.destructive') {
          destructiveUi = await client.evaluate(`(() => ({
            text: document.querySelector('[role="dialog"]')?.innerText ?? '',
            controls: Array.from(document.querySelectorAll('[role="dialog"] button'))
              .map((item) => item.textContent?.trim()),
          }))()`);
          if (destructiveScreenshot) {
            const capture = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
            fs.mkdirSync(path.dirname(destructiveScreenshot), { recursive: true });
            fs.writeFileSync(destructiveScreenshot, Buffer.from(capture.data, 'base64'));
          }
          assert(!controls.includes('permission-allow-task'), 'High-risk request exposed task persistence.');
          assert(!controls.includes('permission-allow-project'), 'High-risk request exposed project persistence.');
          return 'permission-deny';
        }
        return 'permission-allow-once';
      },
    );
    const destructiveRequest = destructiveResult.evidence.requests.find((item) => (
      item.capability === 'shell.destructive'
    ));
    assert(destructiveRequest?.risk === 'high', 'Recursive deletion was not classified as high-risk destructive.');
    assert(destructiveResult.evidence.settlements.some((item) => (
      item.capability === 'shell.destructive' && item.cause === 'deny'
    )), 'The destructive escalation was not denied.');
    assert(fs.existsSync(path.join(deleteTarget, 'keep.txt')), 'Denied destructive command changed the fixture.');
    report.riskEscalation = {
      packageInstall: {
        taskId: installTask.id,
        capability: installRequest.capability,
        risk: installRequest.risk,
        denied: true,
        decisions: installDecisions,
      },
      destructive: {
        taskId: destructiveTask.id,
        capability: destructiveRequest.capability,
        risk: destructiveRequest.risk,
        denied: true,
        targetPreserved: true,
        taskPersistenceHidden: !destructiveUi.controls.includes('本任务允许此类操作'),
        projectPersistenceHidden: !destructiveUi.controls.includes('此项目始终允许此规则'),
        screenshot: destructiveScreenshot,
      },
    };

    await installRealWorkflowRecorders(instance.client);
    const crossTask = await createTaskFromUi(instance.client);
    await selectAgentMode(instance.client, 'normal');
    const commandB1 = `cd "${externalB}" && npm test`;
    const commandB2 = `cd "${externalB}" && npm run test`;
    const commandC = `cd "${externalC}" && npm test`;
    await submitWorkflowPrompt(instance.client, [
      '必须按顺序使用 Bash 请求以下三个命令，每条只请求一次，不要改写路径或添加参数：',
      `1. ${commandB1}`,
      `2. ${commandB2}`,
      `3. ${commandC}`,
      '第三条若被拒绝，立即结束。',
    ].join('\n'));
    const crossDecisions = [];
    let crossUi = null;
    const crossScreenshot = options.reportPath
      ? path.join(path.dirname(options.reportPath), 'electron-permission-cross-project-dialog.png')
      : null;
    const crossResult = await executeRealTask(
      instance.client,
      crossTask.id,
      async (request, _index, controls, client) => {
        const target = request.targetPaths.find((value) => value?.includes('external-project-')) ?? null;
        crossDecisions.push({ target, capability: request.capability, controls });
        if (target?.includes('external-project-b')) {
          if (!crossUi) {
            crossUi = await client.evaluate(`(() => ({
              text: document.querySelector('[role="dialog"]')?.innerText ?? '',
              crossWarning: Boolean(document.querySelector('[data-testid="permission-cross-project-warning"]')),
              switchControlPresent: Boolean(document.querySelector('[data-testid="permission-switch-project"]')),
            }))()`);
            if (crossScreenshot) {
              const capture = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
              fs.mkdirSync(path.dirname(crossScreenshot), { recursive: true });
              fs.writeFileSync(crossScreenshot, Buffer.from(capture.data, 'base64'));
            }
          }
          return 'permission-allow-task';
        }
        if (target?.includes('external-project-c')) return 'permission-deny';
        return 'permission-allow-once';
      },
    );
    const externalRequests = crossResult.evidence.requests.filter((item) => item.outsideProject);
    const bSettlements = crossResult.evidence.settlements.filter((item) => (
      item.targetPaths.some((value) => value?.includes('external-project-b'))
    ));
    const cSettlements = crossResult.evidence.settlements.filter((item) => (
      item.targetPaths.some((value) => value?.includes('external-project-c'))
    ));
    assert(externalRequests.length >= 2, 'The real cross-project task did not issue both external-root scopes.');
    assert(bSettlements.some((item) => item.cause === 'allow_for_task' && item.scope === 'task'),
      'External project B did not receive an explicit task root grant.');
    assert(bSettlements.some((item) => item.cause === 'permission_auto_allowed' && item.scope === 'task'),
      'A second request inside external project B did not reuse its scoped root grant.');
    assert(cSettlements.some((item) => item.cause === 'deny'),
      'External project C did not require and receive a separate decision.');
    assert(crossUi?.crossWarning && crossUi.switchControlPresent,
      'Cross-project permission UI omitted its warning or project-switch control.');
    const gitStatus = await instance.client.evaluate(
      `window.api.getGitWorkspaceStatus(${js(PROJECT_ID)}, ${js(fixture.projectPath)})`,
    );
    assert(gitStatus.projectPath === fixture.projectPath, 'Git workspace silently followed the external command cwd.');
    const projectRules = await instance.client.evaluate(
      `window.api.listProjectPermissionRules(${js(PROJECT_ID)}, { limit: 50, offset: 0 })`,
    );
    assert(projectRules.items.length === 0, 'Cross-project task grant was persisted as a project rule.');
    report.crossProject = {
      preSpawnSwitch,
      taskId: crossTask.id,
      currentProject: fixture.projectPath,
      externalB,
      externalC,
      emittedExternalRequests: externalRequests.length,
      userDecisions: crossDecisions,
      externalBAutomaticHits: bSettlements.filter((item) => item.cause === 'permission_auto_allowed').length,
      externalCDenied: cSettlements.some((item) => item.cause === 'deny'),
      warningVisible: crossUi.crossWarning,
      switchControlPresent: crossUi.switchControlPresent,
      gitRemainedBoundToSelectedProject: true,
      projectRuleCount: projectRules.items.length,
      screenshot: crossScreenshot,
    };
    assert(instance.rendererErrors.length === 0, `Renderer reported ${instance.rendererErrors.length} boundary error(s).`);
    report.success = true;
  } catch (error) {
    failure = error;
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (instance) {
      await stopElectron(instance);
      report.cleanup.processStopped = true;
    }
    if (fixture && !options.keepTemp) {
      safeRemoveFixture(fixture.root);
      report.cleanup.tempRemoved = true;
    }
    report.productionArtifacts = productionBuildArtifactEvidence();
    report.completedAt = new Date().toISOString();
    if (options.reportPath) writeJson(options.reportPath, report);
  }
  console.log(`ELECTRON_PERMISSION_BOUNDARY_RESULT=${JSON.stringify(report)}`);
  if (failure) throw failure;
}

async function runGitStateAcceptance(options) {
  const report = {
    kind: 'production-electron-git-non-repository-state',
    startedAt: new Date().toISOString(),
    completedAt: null,
    success: false,
    state: null,
    productionArtifacts: null,
    cleanup: { processStopped: false, tempRemoved: false },
  };
  let fixture = null;
  let instance = null;
  let failure = null;
  try {
    if (options.build) runNpm(['run', 'build'], { inherit: true });
    assertBuildOutputs();
    fixture = createFixture();
    const nonRepoId = 'workflow-non-repository-project';
    const nonRepoName = 'Non Repository Acceptance Project';
    const nonRepoTask = 'Non Repository Bootstrap Task';
    const nonRepoPath = path.join(fixture.root, 'projects', nonRepoName);
    fs.mkdirSync(nonRepoPath, { recursive: true });
    fs.writeFileSync(path.join(nonRepoPath, 'README.md'), '# Non repository fixture\n', 'utf8');
    const legacy = JSON.parse(fs.readFileSync(fixture.databasePath, 'utf8'));
    const now = new Date().toISOString();
    legacy.projects[nonRepoId] = {
      id: nonRepoId,
      name: nonRepoName,
      path: nonRepoPath,
      created_at: now,
      last_opened_at: now,
    };
    legacy.sessions[nonRepoTask] = {
      id: nonRepoTask,
      project_id: nonRepoId,
      title: nonRepoTask,
      status: 'idle',
      created_at: now,
      updated_at: now,
    };
    writeJson(fixture.databasePath, legacy);

    instance = await launchElectron(fixture, false);
    await instance.client.waitFor(`document.body.innerText.includes(${js(nonRepoName)})`, {
      description: 'non-repository fixture project', timeoutMs: STEP_TIMEOUT_MS,
    });
    const selected = await instance.client.evaluate(`(() => {
      const search = document.querySelector('[data-project-search]');
      const sidebar = search?.closest('aside');
      const button = Array.from(sidebar?.querySelectorAll('button') ?? [])
        .find((item) => item.textContent?.trim() === ${js(nonRepoName)});
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert(selected, 'Unable to select the non-repository project.');
    await instance.client.waitFor(`document.body.innerText.includes(${js(nonRepoTask)})`, {
      description: 'non-repository project task list', timeoutMs: STEP_TIMEOUT_MS,
    });
    await openWorkspaceDrawer(instance.client);
    await selectDrawerTab(instance.client, 'git');
    await instance.client.waitFor(
      `Boolean(document.querySelector('[data-testid="git-state-not-repository"]'))`,
      { description: 'non-repository Git panel state', timeoutMs: STEP_TIMEOUT_MS },
    );
    const state = await instance.client.evaluate(`(() => {
      const drawer = document.querySelector('[data-testid="workspace-right-drawer"]');
      const nonRepo = drawer?.querySelector('[data-testid="git-state-not-repository"]');
      return {
        drawerText: drawer?.innerText ?? '',
        stateText: nonRepo?.innerText ?? '',
        buttons: Array.from(nonRepo?.querySelectorAll('button') ?? []).map((item) => item.textContent?.trim()),
        detachedVisible: Boolean(drawer?.innerText.includes('Detached HEAD')),
        repositorySummaryVisible: Boolean(drawer?.querySelector('[data-testid="git-status-summary"]')),
        acceptVisible: Boolean(drawer?.querySelector('[data-testid="checkpoint-accept"]')),
        commitPreviewVisible: Boolean(drawer?.querySelector('[data-testid="commit-preview-create"]')),
      };
    })()`);
    assert(state.stateText.includes('当前项目不是 Git 仓库'), 'Non-repository state label is missing.');
    assert(!state.detachedVisible && !state.repositorySummaryVisible,
      'Non-repository state was mixed with Detached HEAD or repository status.');
    assert(!state.acceptVisible && !state.commitPreviewVisible,
      'Git mutation controls remained visible for a non-repository project.');
    assert(
      state.buttons.includes('初始化 Git')
        && state.buttons.includes('在资源管理器中打开')
        && state.buttons.includes('关闭面板'),
      `Non-repository actions are incomplete: ${JSON.stringify(state.buttons)}`,
    );
    const screenshot = options.reportPath
      ? path.join(path.dirname(options.reportPath), 'electron-git-non-repository-state.png')
      : null;
    if (screenshot) {
      const capture = await instance.client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.mkdirSync(path.dirname(screenshot), { recursive: true });
      fs.writeFileSync(screenshot, Buffer.from(capture.data, 'base64'));
    }
    await clickTestId(instance.client, 'git-initialize');
    await instance.client.waitFor(
      `Boolean(document.querySelector('[data-testid="git-status-summary"]'))
        && !document.querySelector('[data-testid="git-state-not-repository"]')`,
      { description: 'initialized Git repository state', timeoutMs: STEP_TIMEOUT_MS },
    );
    assert(fs.existsSync(path.join(nonRepoPath, '.git')), 'Explicit Git initialization did not create repository metadata.');
    const initializedState = await instance.client.evaluate(`(() => {
      const drawer = document.querySelector('[data-testid="workspace-right-drawer"]');
      return {
        summaryText: drawer?.querySelector('[data-testid="git-status-summary"]')?.textContent ?? '',
        detachedVisible: Boolean(drawer?.innerText.includes('Detached HEAD')),
        nonRepositoryVisible: Boolean(drawer?.querySelector('[data-testid="git-state-not-repository"]')),
        acceptVisible: Boolean(drawer?.querySelector('[data-testid="checkpoint-accept"]')),
        commitPreviewVisible: Boolean(drawer?.querySelector('[data-testid="commit-preview-create"]')),
      };
    })()`);
    assert(!initializedState.detachedVisible && !initializedState.nonRepositoryVisible,
      'An initialized unborn repository was mislabeled Detached HEAD or non-repository.');
    assert(initializedState.acceptVisible && initializedState.commitPreviewVisible,
      'Git controls did not become available after explicit initialization.');

    const secondInitialization = await instance.client.evaluate(
      `window.api.initializeGitWorkspace(${js(nonRepoId)}, ${js(nonRepoPath)})`,
    );
    assert(secondInitialization && secondInitialization.projectPath,
      'Repeated explicit Git initialization was not idempotent.');
    await selectDrawerTab(instance.client, 'checkpoints');
    await instance.client.waitFor(
      `Boolean(document.querySelector('[data-testid="checkpoint-create-manual"]'))
        && !document.querySelector('[data-testid="checkpoint-git-unavailable"]')`,
      { description: 'Git-backed checkpoint availability after initialization', timeoutMs: STEP_TIMEOUT_MS },
    );
    report.state = {
      ...state,
      screenshot,
      initialization: {
        repositoryCreated: true,
        idempotentSecondRequest: true,
        initializedState,
        checkpointAvailable: true,
      },
    };
    assert(instance.rendererErrors.length === 0, 'Renderer emitted an error during Git state acceptance.');
    report.success = true;
  } catch (error) {
    failure = error;
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (instance) {
      await stopElectron(instance);
      report.cleanup.processStopped = true;
    }
    if (fixture && !options.keepTemp) {
      safeRemoveFixture(fixture.root);
      report.cleanup.tempRemoved = true;
    }
    report.productionArtifacts = productionBuildArtifactEvidence();
    report.completedAt = new Date().toISOString();
    if (options.reportPath) writeJson(options.reportPath, report);
  }
  console.log(`ELECTRON_GIT_STATE_RESULT=${JSON.stringify(report)}`);
  if (failure) throw failure;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.gitStateOnly) {
    await runGitStateAcceptance(options);
    return;
  }
  if (options.permissionBoundaryOnly) {
    await runPermissionBoundaryAcceptance(options);
    return;
  }
  if (options.permissionLifecycleOnly) {
    await runPermissionLifecycleAcceptance(options);
    return;
  }
  if (options.real) {
    await runRealWorkflowAcceptance(options);
    return;
  }
  const report = {
    startedAt: new Date().toISOString(),
    workspace: WORKSPACE_ROOT,
    build: { requested: options.build, outputs: [] },
    isolation: null,
    electronLaunches: [],
    steps: [],
    rendererErrors: [],
    cleanup: { processStopped: false, tempRemoved: false },
  };
  let fixture = null;
  let instance = null;
  let failed = null;
  const state = {};

  const step = async (number, title, work) => {
    assert(number === report.steps.length + 1, `Acceptance step numbering drifted at ${number}.`);
    const startedAt = performance.now();
    try {
      const evidence = await work();
      const result = {
        number,
        title,
        status: 'passed',
        durationMs: Math.round(performance.now() - startedAt),
        evidence: evidence ?? null,
      };
      report.steps.push(result);
      console.log(`[pass ${number}/15] ${title} (${result.durationMs} ms)`);
      return evidence;
    } catch (error) {
      const result = {
        number,
        title,
        status: 'failed',
        durationMs: Math.round(performance.now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
      };
      report.steps.push(result);
      console.error(`[fail ${number}/15] ${title}: ${result.error}`);
      throw error;
    }
  };

  try {
    if (options.build) {
      console.log('[preflight] Building real Electron production bundles...');
      runNpm(['run', 'build'], { inherit: true });
    }
    report.build.outputs = assertBuildOutputs();
    fixture = createFixture();
    report.isolation = {
      fixtureRoot: fixture.root,
      workbenchDataDir: fixture.dataRoot,
      sqlitePath: fixture.databasePath,
      chromiumUserDataDir: fixture.browserDataRoot,
      homeDir: fixture.isolatedHome,
      projectPath: fixture.projectPath,
      forceFake: true,
      fakeScope: 'model transport only',
      externalClaudeInvoked: false,
      fixtureMutationOnly: true,
      targetPath: TARGET_RELATIVE_PATH,
    };

    instance = await launchElectron(fixture);
    report.electronLaunches.push({ pid: instance.child.pid, cdpPort: instance.port, phase: 'initial' });
    const identity = await instance.client.evaluate(`({
      title: document.title,
      userAgent: navigator.userAgent,
      url: location.href,
      apiAvailable: Boolean(window.api),
      nodeIntegrationDisabled: typeof require === 'undefined' && typeof process === 'undefined',
    })`);
    assert(identity.title === 'Claude Workbench', `Unexpected window title: ${identity.title}`);
    assert(/Electron\//u.test(identity.userAgent), 'The renderer is not running in Electron.');
    assert(identity.apiAvailable && identity.nodeIntegrationDisabled, 'The isolated contextBridge boundary is invalid.');
    const installation = await instance.client.evaluate('window.api.checkInstallation()');
    assert(installation.path === 'fake-claude', 'FORCE_FAKE did not isolate model transport.');
    await installWorkflowEventRecorder(instance.client);

    await step(1, '创建隔离小项目与 Workbench 任务', async () => {
      const projects = await instance.client.evaluate('window.api.listProjects()');
      assert(projects.length === 1, `Expected one isolated project, found ${projects.length}.`);
      assert(projects[0].id === PROJECT_ID && projects[0].path === fixture.projectPath, 'Project DB identity/path mismatch.');
      await instance.client.waitFor(`document.body.innerText.includes(${js(PROJECT_NAME)})`, {
        description: 'fixture project in the real sidebar',
      });
      await selectProject(instance.client);
      state.task = await createTaskFromUi(instance.client);
      const session = await instance.client.evaluate(`window.api.getSession(${js(state.task.id)})`);
      assert(session?.projectId === PROJECT_ID, 'Created task belongs to the wrong project.');
      assert(gitHead(fixture.projectPath) === fixture.projectGit.initialHead, 'Task creation changed Git HEAD.');
      return {
        project: { id: projects[0].id, name: projects[0].name, path: projects[0].path },
        taskId: state.task.id,
        apiSessionProjectId: session.projectId,
        uiTaskSelector: `[data-session-key$="::${state.task.id}"]`,
        gitHead: fixture.projectGit.initialHead,
      };
    });

    await step(2, '进入 Plan Mode 并创建 Workflow', async () => {
      await selectPlanMode(instance.client);
      await submitWorkflowPrompt(instance.client, WORKFLOW_PROMPT);
      await instance.client.waitFor(
        `(async () => Boolean(await window.api.getWorkflowByTask(${js(state.task.id)})))()`,
        { description: 'workflow created from Plan Mode', timeoutMs: STEP_TIMEOUT_MS },
      );
      state.workflow = await instance.client.evaluate(`window.api.getWorkflowByTask(${js(state.task.id)})`);
      const session = await instance.client.evaluate(`window.api.getSession(${js(state.task.id)})`);
      assert(state.workflow.taskId === state.task.id, 'Workflow task identity mismatch.');
      assert(state.workflow.projectId === PROJECT_ID && state.workflow.projectPath === fixture.projectPath, 'Workflow project identity was not DB-derived.');
      assert(state.workflow.prompt === WORKFLOW_PROMPT, 'Workflow prompt changed during creation.');
      assert(state.workflow.modelPolicy && typeof state.workflow.modelPolicy === 'object', 'Workflow model policy is missing.');
      await instance.client.waitFor(`document.querySelector('[data-testid="current-workflow"]')`, {
        description: 'current workflow UI',
        timeoutMs: STEP_TIMEOUT_MS,
      });
      const events = await workflowEvents(instance.client);
      return {
        workflowId: state.workflow.id,
        apiStatus: state.workflow.status,
        permissionMode: session.permissionMode,
        planModeValue: await instance.client.evaluate(
          `document.querySelector('select[aria-label="Agent 模式"]')?.value`,
        ),
        uiCurrentWorkflow: true,
        observedEventTypes: events.map((event) => event.eventType).filter(Boolean),
      };
    });

    await step(3, '生成并展示结构化 Planner 计划', async () => {
      await instance.client.waitFor(
        `(async () => {
          const status = (await window.api.getWorkflow(${js(state.workflow.id)}))?.status;
          return status === 'waiting_plan_confirmation'
            || status === 'failed'
            || status === 'cancelled';
        })()`,
        { description: 'structured plan confirmation state', timeoutMs: STEP_TIMEOUT_MS },
      );
      state.workflow = await instance.client.evaluate(`window.api.getWorkflow(${js(state.workflow.id)})`);
      assert(
        state.workflow.status === 'waiting_plan_confirmation',
        `Planner ended in ${state.workflow.status}: ${state.workflow.failure?.code ?? 'unknown'} ${state.workflow.failure?.message ?? ''}`,
      );
      const plan = state.workflow.plan;
      assert(plan && typeof plan.title === 'string' && plan.title.length > 0, 'Planner returned no structured title.');
      assert(Array.isArray(plan.steps) && plan.steps.length >= 2, 'Planner returned no structured steps.');
      assert(plan.steps.every((item) => Number.isInteger(item.id) && ['low', 'medium', 'high'].includes(item.risk)), 'Planner step schema is invalid.');
      assert(Array.isArray(plan.filesExpected) && plan.filesExpected.includes(TARGET_RELATIVE_PATH), 'Planner omitted the deterministic target path.');
      await instance.client.waitFor(
        `document.querySelector('[data-testid="workflow-plan-review"]')?.innerText.includes(${js(plan.title)})
          && document.querySelectorAll('[data-testid="workflow-plan-step"]').length === ${plan.steps.length}`,
        { description: 'structured plan UI', timeoutMs: STEP_TIMEOUT_MS },
      );
      const stages = await instance.client.evaluate(
        `window.api.listWorkflowStages(${js(state.workflow.id)}, { limit: 100, offset: 0 })`,
      );
      const planner = stages.items.find((item) => item.stage === 'planner');
      assert(planner?.status === 'completed' && planner.outputJson, 'Planner stage was not durably completed.');
      assert(sameJson(JSON.parse(planner.outputJson), plan), 'Planner stage output and workflow plan differ.');
      return {
        plan,
        plannerStage: stageSummary([planner])[0],
        uiPlanStepCount: await instance.client.evaluate(
          `document.querySelectorAll('[data-testid="workflow-plan-step"]').length`,
        ),
      };
    });

    await step(4, '修改计划并同步 API 与 UI', async () => {
      const plan = state.workflow.plan;
      state.modifiedPlan = {
        ...plan,
        title: MODIFIED_PLAN_TITLE,
        summary: `${plan.summary} Modified by the real acceptance IPC before execution.`,
        steps: plan.steps.map((item, index) => ({
          ...item,
          ...(index === 0 ? {
            description: 'Verify the isolated fixture mutation and persisted workflow boundaries.',
            acceptanceCriteria: ['Git HEAD remains unchanged', 'Round two tests pass'],
          } : {}),
        })),
        constraints: [...(plan.constraints ?? []), 'Acceptance fixture only'],
      };
      const controlPresent = await instance.client.evaluate(
        `Boolean(document.querySelector('[data-testid="workflow-modify-plan"]'))`,
      );
      assert(controlPresent, 'Modify Plan UI control is missing.');
      const updated = await instance.client.evaluate(
        `window.api.updateWorkflowPlan(${js(state.workflow.id)}, ${js(state.modifiedPlan)})`,
      );
      assert(updated.plan?.title === MODIFIED_PLAN_TITLE, 'Main-process plan update did not persist.');
      await instance.client.waitFor(
        `document.querySelector('[data-testid="workflow-plan-review"]')?.innerText.includes(${js(MODIFIED_PLAN_TITLE)})`,
        { description: 'modified plan UI', timeoutMs: STEP_TIMEOUT_MS },
      );
      state.workflow = updated;
      return {
        apiPlanTitle: updated.plan.title,
        apiRevision: updated.revision,
        uiPlanTitleVisible: true,
        modifyControlPresent: controlPresent,
        constraints: updated.plan.constraints,
      };
    });

    await step(5, '从 UI 确认计划并开始执行', async () => {
      state.headBeforeExecution = gitHead(fixture.projectPath);
      const session = await instance.client.evaluate(`window.api.getSession(${js(state.task.id)})`);
      assert(session.permissionMode === 'default', `Unexpected writable permission mode: ${session.permissionMode}`);
      await clickTestId(instance.client, 'workflow-start-execution');
      await instance.client.waitFor(
        `(async () => {
          const workflow = await window.api.getWorkflow(${js(state.workflow.id)});
          return workflow && workflow.status !== 'waiting_plan_confirmation';
        })()`,
        { description: 'confirmed workflow execution', timeoutMs: STEP_TIMEOUT_MS, intervalMs: 10 },
      );
      const workflow = await instance.client.evaluate(`window.api.getWorkflow(${js(state.workflow.id)})`);
      return {
        uiControl: 'workflow-start-execution',
        apiStatusAfterConfirmation: workflow.status,
        apiCurrentStage: workflow.currentStage,
        sessionPermissionMode: session.permissionMode,
        gitHeadBeforeExecution: state.headBeforeExecution,
      };
    });

    await step(6, '观察 Planner → Coder → Tester 并执行 fixture mutation', async () => {
      await instance.client.waitFor(
        `(async () => (await window.api.listWorkflowStages(${js(state.workflow.id)}, { limit: 100, offset: 0 }))
          .items.some((item) => item.stage === 'coder' && item.round === 1))()`,
        { description: 'first Coder stage record', timeoutMs: STEP_TIMEOUT_MS, intervalMs: 10 },
      );
      const coderAtMutation = await instance.client.evaluate(`(async () => {
        const page = await window.api.listWorkflowStages(${js(state.workflow.id)}, { limit: 100, offset: 0 });
        return page.items.find((item) => item.stage === 'coder' && item.round === 1);
      })()`);
      // FakeClaudeAdapter is model transport only. This is an explicit mutation
      // of the isolated Git fixture after the real Coder stage becomes visible.
      fs.writeFileSync(fixture.projectGit.targetPath, TARGET_CONTENT, 'utf8');
      state.fixtureMutation = {
        relativePath: TARGET_RELATIVE_PATH,
        absolutePath: fixture.projectGit.targetPath,
        owner: 'electron-workflow-acceptance-script',
        observedCoderStatus: coderAtMutation.status,
        bytes: Buffer.byteLength(TARGET_CONTENT, 'utf8'),
      };
      await instance.client.waitFor(
        `(async () => (await window.api.getWorkflow(${js(state.workflow.id)}))?.status === 'completed')()`,
        { description: 'completed two-round workflow', timeoutMs: STEP_TIMEOUT_MS, intervalMs: 20 },
      );
      await instance.client.waitFor(
        `(async () => (await window.api.listCheckpoints(${js(state.task.id)}))
          .some((item) => item.type === 'task_completed'))()`,
        { description: 'terminal workflow checkpoint', timeoutMs: STEP_TIMEOUT_MS, intervalMs: 20 },
      );
      const page = await instance.client.evaluate(
        `window.api.listWorkflowStages(${js(state.workflow.id)}, { limit: 100, offset: 0 })`,
      );
      state.stages = page.items;
      assert(state.stages.length === 7 && page.total === 7, `Expected 7 workflow stages, found ${page.total}.`);
      assert(state.stages.every((item) => item.status === 'completed'), 'At least one Agent stage did not complete.');
      const sequence = state.stages.map((item) => item.stage);
      assert(sameJson(sequence, EXPECTED_STAGE_SEQUENCE), `Unexpected Agent stage sequence: ${sequence.join(' -> ')}`);
      assert(sameJson(sequence.slice(0, 3), ['planner', 'coder', 'tester']), 'Planner → Coder → Tester order is invalid.');
      return {
        sequence,
        stages: stageSummary(state.stages.slice(0, 3)),
        fixtureMutation: state.fixtureMutation,
        fakeTransportWroteFile: false,
      };
    });

    await step(7, '验证 Timeline 与 Agent Team UI', async () => {
      await selectWorkflowTab(instance.client, 'team');
      await instance.client.waitFor(
        `document.querySelectorAll('[data-testid="workflow-agent-card"]').length === 4`,
        { description: 'four Agent Team cards', timeoutMs: STEP_TIMEOUT_MS },
      );
      const team = await instance.client.evaluate(`(() => Array.from(
        document.querySelectorAll('[data-testid="workflow-agent-card"]')
      ).map((item) => ({ agent: item.dataset.agent, status: item.dataset.status, text: item.innerText })))()`);
      assert(sameJson(team.map((item) => item.agent), ['planner', 'coder', 'tester', 'reviewer']), 'Agent Team roles are incomplete.');
      assert(team.every((item) => item.status === 'completed'), 'Agent Team did not render terminal status.');
      await selectWorkflowTab(instance.client, 'timeline');
      await instance.client.waitFor(
        `document.querySelectorAll('[data-testid="workflow-timeline-item"]').length === 7`,
        { description: 'seven Agent Timeline items', timeoutMs: STEP_TIMEOUT_MS },
      );
      const timeline = await instance.client.evaluate(`(() => Array.from(
        document.querySelectorAll('[data-testid="workflow-timeline-item"]')
      ).map((item) => ({ agent: item.dataset.agent, status: item.dataset.status, text: item.textContent })))()`);
      assert(sameJson(timeline.map((item) => item.agent), EXPECTED_STAGE_SEQUENCE), 'Timeline order differs from persisted stage order.');
      return { team, timeline, apiStageCount: state.stages.length };
    });

    await step(8, '验证完整 Workflow Checkpoint 边界', async () => {
      state.checkpoints = await instance.client.evaluate(`window.api.listCheckpoints(${js(state.task.id)})`);
      state.checkpointSummary = checkpointSummary(state.checkpoints);
      for (const type of REQUIRED_CHECKPOINT_TYPES) {
        assert(state.checkpointSummary.counts[type] >= 1, `Required checkpoint is missing: ${type}`);
      }
      for (const [type, expectedCount] of Object.entries(EXPECTED_CHECKPOINT_COUNTS)) {
        assert(
          state.checkpointSummary.counts[type] === expectedCount,
          `Expected ${expectedCount} ${type} checkpoint(s), found ${state.checkpointSummary.counts[type] ?? 0}.`,
        );
      }
      assert(
        state.checkpointSummary.count === Object.values(EXPECTED_CHECKPOINT_COUNTS)
          .reduce((total, count) => total + count, 0),
        `Unexpected checkpoint total: ${state.checkpointSummary.count}`,
      );
      await openWorkspaceDrawer(instance.client);
      await selectDrawerTab(instance.client, 'checkpoints');
      await instance.client.waitFor(
        `document.querySelectorAll('[data-testid="checkpoint-row"]').length >= ${state.checkpoints.length}`,
        { description: 'checkpoint rows in UI', timeoutMs: STEP_TIMEOUT_MS },
      );
      const uiTypes = await instance.client.evaluate(`(() => Array.from(
        document.querySelectorAll('[data-testid="checkpoint-row"]')
      ).map((item) => item.dataset.checkpointType))()`);
      for (const type of REQUIRED_CHECKPOINT_TYPES) {
        assert(uiTypes.includes(type), `Checkpoint UI omitted ${type}.`);
      }
      return { api: state.checkpointSummary, uiTypes };
    });

    await step(9, '验证固定 fixture Git 变更且 HEAD 不变', async () => {
      const status = await instance.client.evaluate(
        `window.api.getGitWorkspaceStatus(${js(PROJECT_ID)}, ${js(fixture.projectPath)})`,
      );
      const target = status.files.find((item) => item.filePath === TARGET_RELATIVE_PATH);
      assert(target, `Git status omitted ${TARGET_RELATIVE_PATH}.`);
      assert(target.untracked || target.changeType === 'added' || target.changeType === 'untracked', 'Target is not reported as an added fixture file.');
      assert(status.head === state.headBeforeExecution && gitHead(fixture.projectPath) === state.headBeforeExecution, 'Workflow fixture mutation changed HEAD.');
      assert(fs.readFileSync(fixture.projectGit.targetPath, 'utf8') === TARGET_CONTENT, 'Fixture target bytes changed unexpectedly.');
      await selectDrawerTab(instance.client, 'git');
      await instance.client.waitFor(
        `document.querySelector(${js(`[data-testid="git-file-row"][data-file-path="${TARGET_RELATIVE_PATH}"]`)})`,
        { description: 'fixture target in Git changes UI', timeoutMs: STEP_TIMEOUT_MS },
      );
      return {
        mutation: state.fixtureMutation,
        apiGitFile: target,
        uiGitSelector: `[data-testid="git-file-row"][data-file-path="${TARGET_RELATIVE_PATH}"]`,
        head: status.head,
      };
    });

    await step(10, '验证最终 Review UI 与 API', async () => {
      await selectWorkflowTab(instance.client, 'review');
      await instance.client.waitFor(
        `document.querySelector('[data-testid="workflow-review"]')
          && document.querySelector('[data-testid="workflow-review-score"]')?.textContent === '10'`,
        { description: 'clean second-round Review UI', timeoutMs: STEP_TIMEOUT_MS },
      );
      state.latestReview = await instance.client.evaluate(
        `window.api.getWorkflowReview(${js(state.workflow.id)})`,
      );
      assert(state.latestReview.round === 2 && state.latestReview.score === 10, 'Latest Review is not the clean second round.');
      assert(state.latestReview.issues.length === 0 && state.latestReview.tests.failed === 0, 'Latest Review is not clean.');
      const ui = await instance.client.evaluate(`({
        score: document.querySelector('[data-testid="workflow-review-score"]')?.textContent,
        tests: document.querySelector('[data-testid="workflow-review-tests"]')?.innerText,
        issueCount: document.querySelectorAll('[data-testid="workflow-review-issue"]').length,
        text: document.querySelector('[data-testid="workflow-review"]')?.innerText,
      })`);
      assert(ui.issueCount === 0 && ui.text.includes('第 2 轮'), 'Review UI does not show the clean second round.');
      return { apiReview: state.latestReview, ui };
    });

    await step(11, '读取第 1 轮 high issue', async () => {
      state.roundOneReview = await instance.client.evaluate(
        `window.api.getWorkflowReview(${js(state.workflow.id)}, 1)`,
      );
      assert(state.roundOneReview?.round === 1, 'Round-one Review was not persisted.');
      const highIssues = state.roundOneReview.issues.filter((item) => item.severity === 'high');
      assert(highIssues.length >= 1, 'Round-one Review contains no high issue.');
      assert(highIssues.every((item) => item.file === TARGET_RELATIVE_PATH), 'Round-one issue points outside the fixture target.');
      await selectWorkflowTab(instance.client, 'timeline');
      const reviewerRoundOneVisible = await instance.client.evaluate(`(() => Array.from(
        document.querySelectorAll('[data-testid="workflow-timeline-item"][data-agent="reviewer"]')
      ).some((item) => item.textContent.includes('第 1 轮')))()`);
      assert(reviewerRoundOneVisible, 'Timeline UI omitted Reviewer round one.');
      return { review: state.roundOneReview, highIssues, reviewerRoundOneVisible };
    });

    await step(12, '确认自动 fix loop 进入第 2 轮并 clean 完成', async () => {
      const rounds = state.stages.slice(1).map((item) => `${item.stage}:${item.round}`);
      assert(sameJson(rounds, [
        'coder:1', 'tester:1', 'reviewer:1',
        'coder:2', 'tester:2', 'reviewer:2',
      ]), `Automatic fix-loop stages are invalid: ${rounds.join(', ')}`);
      const events = await workflowEvents(instance.client);
      assert(events.some((event) => event.eventType === 'workflow_fix_loop_started'), 'Fix-loop notification was not observed.');
      assert(events.some((event) => event.eventType === 'workflow_terminal' && event.status === 'completed'), 'Completed workflow notification was not observed.');
      const uiRoundTwo = await instance.client.evaluate(`(() => {
        const items = Array.from(document.querySelectorAll('[data-testid="workflow-timeline-item"]'));
        return ['coder', 'tester', 'reviewer'].every((agent) => items.some((item) => (
          item.dataset.agent === agent && item.textContent.includes('第 2 轮')
        )));
      })()`);
      assert(uiRoundTwo, 'Timeline UI omitted a round-two fix-loop Agent.');
      return {
        rounds,
        latestReview: state.latestReview,
        eventTypes: events.map((event) => event.eventType).filter(Boolean),
        uiRoundTwo,
      };
    });

    await step(13, '确认第 2 轮 Tester passed', async () => {
      const tester = state.stages.find((item) => item.stage === 'tester' && item.round === 2);
      assert(tester?.status === 'completed' && tester.outputJson, 'Round-two Tester stage is incomplete.');
      const output = JSON.parse(tester.outputJson);
      assert(output.passed >= 1 && output.failed === 0, 'Round-two Tester did not pass.');
      const uiTester = await instance.client.evaluate(`(() => Array.from(
        document.querySelectorAll('[data-testid="workflow-timeline-item"][data-agent="tester"]')
      ).find((item) => item.textContent.includes('第 2 轮'))?.textContent ?? null)()`);
      assert(uiTester && uiTester.includes('完成'), 'Timeline UI does not show the completed second Tester round.');
      return { tester: stageSummary([tester])[0], output, uiTester };
    });

    await step(14, '生成 Workflow Commit Preview 且不改变 HEAD', async () => {
      const headBefore = gitHead(fixture.projectPath);
      state.preview = await instance.client.evaluate(
        `window.api.createWorkflowCommitPreview(${js(state.workflow.id)})`,
      );
      assert(state.preview.files.includes(TARGET_RELATIVE_PATH), 'Workflow Commit Preview omitted the fixture target.');
      assert(state.preview.fileCount === state.preview.files.length, 'Commit Preview file count is inconsistent.');
      assert(state.preview.additions >= 0 && state.preview.deletions >= 0, 'Commit Preview diff counts are invalid.');
      assert(state.preview.message.includes('## Plan') && state.preview.message.includes(MODIFIED_PLAN_TITLE), 'Commit Preview omitted plan context.');
      assert(state.preview.message.includes('## Review') && /Tests:\s*1 passed,\s*0 failed/iu.test(state.preview.message), 'Commit Preview omitted test/review context.');
      assert(state.preview.message.includes('## Files') && state.preview.message.includes(TARGET_RELATIVE_PATH), 'Commit Preview omitted changed-file context.');
      assert(gitHead(fixture.projectPath) === headBefore, 'Commit Preview API changed HEAD.');
      await clickTestId(instance.client, 'workflow-create-commit-preview');
      await instance.client.waitFor(
        `document.querySelector('[data-testid="workflow-commit-preview"]')
          && document.querySelector('[data-testid="workflow-commit-preview"] code')?.textContent === ${js(state.preview.subject)}`,
        { description: 'Workflow Commit Preview UI', timeoutMs: STEP_TIMEOUT_MS },
      );
      const ui = await instance.client.evaluate(`({
        subject: document.querySelector('[data-testid="workflow-commit-preview"] code')?.textContent,
        details: document.querySelector('[data-testid="workflow-commit-preview-details"] pre')?.textContent,
        warning: document.querySelector('[data-testid="workflow-commit-preview"]')?.innerText,
      })`);
      assert(ui.details === state.preview.message, 'Commit Preview UI details differ from the API.');
      assert(ui.warning.includes('未创建 Commit') && gitHead(fixture.projectPath) === headBefore, 'Preview UI implied or created a commit.');
      state.headBeforeRestart = headBefore;
      return { apiPreview: state.preview, ui, headBefore, headAfter: gitHead(fixture.projectPath) };
    });

    await step(15, '重启 Electron 后恢复 Workflow、Stages、Reviews、Checkpoints 与状态', async () => {
      const before = {
        workflow: await instance.client.evaluate(`window.api.getWorkflow(${js(state.workflow.id)})`),
        stages: await instance.client.evaluate(
          `window.api.listWorkflowStages(${js(state.workflow.id)}, { limit: 100, offset: 0 })`,
        ),
        roundOne: await instance.client.evaluate(
          `window.api.getWorkflowReview(${js(state.workflow.id)}, 1)`,
        ),
        roundTwo: await instance.client.evaluate(
          `window.api.getWorkflowReview(${js(state.workflow.id)}, 2)`,
        ),
        checkpoints: await instance.client.evaluate(`window.api.listCheckpoints(${js(state.task.id)})`),
        gitStatus: await instance.client.evaluate(
          `window.api.getGitWorkspaceStatus(${js(PROJECT_ID)}, ${js(fixture.projectPath)})`,
        ),
      };
      report.rendererErrors.push(...instance.rendererErrors);
      assert(instance.rendererErrors.length === 0, `Initial renderer emitted errors: ${instance.rendererErrors.join(' | ')}`);
      await stopElectron(instance);
      report.cleanup.processStopped = true;
      instance = null;
      const sqlite = verifySqlitePersistence(
        fixture.databasePath,
        state.task.id,
        state.workflow.id,
      );

      instance = await launchElectron(fixture);
      report.electronLaunches.push({ pid: instance.child.pid, cdpPort: instance.port, phase: 'restart' });
      const after = await instance.client.evaluate(`(async () => ({
        workflow: await window.api.getWorkflow(${js(state.workflow.id)}),
        byTask: await window.api.getWorkflowByTask(${js(state.task.id)}),
        stages: await window.api.listWorkflowStages(${js(state.workflow.id)}, { limit: 100, offset: 0 }),
        roundOne: await window.api.getWorkflowReview(${js(state.workflow.id)}, 1),
        roundTwo: await window.api.getWorkflowReview(${js(state.workflow.id)}, 2),
        checkpoints: await window.api.listCheckpoints(${js(state.task.id)}),
        gitStatus: await window.api.getGitWorkspaceStatus(${js(PROJECT_ID)}, ${js(fixture.projectPath)}),
        session: await window.api.getSession(${js(state.task.id)}),
      }))()`);
      assert(after.workflow?.id === before.workflow.id && after.byTask?.id === before.workflow.id, 'Workflow identity was not restored.');
      assert(after.workflow.status === 'completed' && after.session.status === 'completed', 'Workflow/session terminal status was not restored.');
      assert(
        after.workflow.currentStage === null
          && after.workflow.reviewRound === 2
          && after.workflow.fixRound === 2
          && sameJson(after.workflow.plan, before.workflow.plan),
        'Workflow plan/round/stage state was not restored.',
      );
      assert(sameJson(after.stages.items.map((item) => item.id), before.stages.items.map((item) => item.id)), 'Stage identities changed after restart.');
      assert(sameJson(after.roundOne, before.roundOne) && sameJson(after.roundTwo, before.roundTwo), 'Review reports changed after restart.');
      assert(sameJson(
        after.checkpoints.map((item) => item.id).sort(),
        before.checkpoints.map((item) => item.id).sort(),
      ), 'Checkpoint identities changed after restart.');
      assert(after.gitStatus.head === state.headBeforeRestart && after.gitStatus.files.some((item) => item.filePath === TARGET_RELATIVE_PATH), 'Git status/HEAD was not restored.');

      await instance.client.waitFor(`document.body.innerText.includes(${js(PROJECT_NAME)})`, {
        description: 'persisted project after restart',
      });
      await selectProject(instance.client);
      await selectTask(instance.client, state.task.id);
      await instance.client.waitFor(
        `document.querySelector('[data-testid="current-workflow"]')
          && document.querySelector('[data-testid="workflow-controls"]')?.innerText.includes('completed')`,
        { description: 'completed workflow UI after restart', timeoutMs: STEP_TIMEOUT_MS },
      );
      await selectWorkflowTab(instance.client, 'timeline');
      await instance.client.waitFor(
        `document.querySelectorAll('[data-testid="workflow-timeline-item"]').length === 7`,
        { description: 'persisted Agent Timeline after restart', timeoutMs: STEP_TIMEOUT_MS },
      );
      await selectWorkflowTab(instance.client, 'review');
      await instance.client.waitFor(
        `document.querySelector('[data-testid="workflow-review"]')?.innerText.includes('第 2 轮')`,
        { description: 'persisted Review UI after restart', timeoutMs: STEP_TIMEOUT_MS },
      );
      await openWorkspaceDrawer(instance.client);
      await selectDrawerTab(instance.client, 'checkpoints');
      await instance.client.waitFor(
        `document.querySelectorAll('[data-testid="checkpoint-row"]').length === ${after.checkpoints.length}`,
        { description: 'persisted Checkpoint UI after restart', timeoutMs: STEP_TIMEOUT_MS },
      );
      const ui = await instance.client.evaluate(`({
        workflowStatus: document.querySelector('[data-testid="workflow-controls"]')?.innerText,
        timelineCount: document.querySelectorAll('[data-testid="workflow-timeline-item"]').length,
        reviewText: document.querySelector('[data-testid="workflow-review"]')?.innerText,
        checkpointCount: document.querySelectorAll('[data-testid="checkpoint-row"]').length,
      })`);
      return {
        before: {
          workflow: { id: before.workflow.id, status: before.workflow.status, revision: before.workflow.revision },
          stageIds: before.stages.items.map((item) => item.id),
          reviewRounds: [before.roundOne.round, before.roundTwo.round],
          checkpointIds: before.checkpoints.map((item) => item.id),
          gitHead: before.gitStatus.head,
        },
        after: {
          workflow: { id: after.workflow.id, status: after.workflow.status, revision: after.workflow.revision },
          stageIds: after.stages.items.map((item) => item.id),
          reviewRounds: [after.roundOne.round, after.roundTwo.round],
          checkpointIds: after.checkpoints.map((item) => item.id),
          gitHead: after.gitStatus.head,
          sessionStatus: after.session.status,
        },
        sqlite,
        ui,
      };
    });

    assert(report.steps.length === 15 && report.steps.every((item) => item.status === 'passed'), 'The 15-step workflow acceptance did not complete.');
    report.rendererErrors.push(...instance.rendererErrors);
    assert(instance.rendererErrors.length === 0, `Restarted renderer emitted errors: ${instance.rendererErrors.join(' | ')}`);
  } catch (error) {
    failed = error;
    report.error = error instanceof Error ? error.message : String(error);
    if (instance) {
      try {
        report.failure = {
          bodyTail: (await instance.client.evaluate('document.body.innerText')).slice(-5_000),
          workflow: state.workflow?.id
            ? await instance.client.evaluate(`window.api.getWorkflow(${js(state.workflow.id)})`)
            : null,
          stages: state.workflow?.id
            ? await instance.client.evaluate(
              `window.api.listWorkflowStages(${js(state.workflow.id)}, { limit: 100, offset: 0 })`,
            )
            : null,
          controls: await instance.client.evaluate(`(() => Array.from(
            document.querySelectorAll('button, [role="button"], select')
          ).filter((item) => {
            const rect = item.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }).slice(0, 100).map((item) => ({
            text: String(item.textContent || '').replace(/\\s+/g, ' ').trim(),
            title: item.title,
            testId: item.dataset.testid,
            value: item.value,
          })))()`),
        };
      } catch {
        // The renderer may already be unavailable.
      }
      report.rendererErrors.push(...(instance.rendererErrors ?? []));
      report.electronLogTail = [...instance.stderr, ...instance.stdout]
        .join('')
        .trim()
        .split(/\r?\n/u)
        .slice(-50);
    }
  } finally {
    if (instance) {
      await stopElectron(instance);
      report.cleanup.processStopped = true;
      instance = null;
    }
    report.completedAt = new Date().toISOString();
    report.status = failed ? 'failed' : 'passed';
    if (fixture) {
      if (options.keepTemp) {
        report.cleanup.tempPath = fixture.root;
        console.log(`[cleanup] Kept isolated workflow fixture: ${fixture.root}`);
      } else {
        safeRemoveFixture(fixture.root);
        report.cleanup.tempRemoved = true;
      }
    }
    if (options.reportPath) {
      fs.mkdirSync(path.dirname(options.reportPath), { recursive: true });
      fs.writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
  }

  console.log(`ELECTRON_WORKFLOW_ACCEPTANCE_RESULT=${JSON.stringify(report)}`);
  if (failed) throw failed;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
