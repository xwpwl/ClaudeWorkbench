import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import electron from 'electron';
import { CdpClient, waitForCdpPage } from './lib/cdp-client.mjs';

const TEMP_PREFIX = 'claude-workbench-electron-acceptance-';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_STEP_TIMEOUT_MS = 20_000;

function parseArguments(argv) {
  const options = {
    build: true,
    keepTemp: false,
    reportPath: null,
    smoke: false,
    security: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--skip-build') options.build = false;
    else if (argument === '--keep-temp') options.keepTemp = true;
    else if (argument === '--smoke') options.smoke = true;
    else if (argument === '--security') options.security = true;
    else if (argument === '--report') {
      options.reportPath = argv[index + 1] ? path.resolve(argv[++index]) : null;
      if (!options.reportPath) throw new Error('--report requires a file path.');
    } else if (argument === '--help') {
      console.log([
        'Usage: node scripts/electron-acceptance.mjs [options]',
        '',
        '  --skip-build     Reuse the current dist/ output.',
        '  --smoke          Run launch, isolation, project load, IPC, and restart checks only.',
        '  --security       Run the real-Electron mutation and bypass-permission boundary checks.',
        '  --report <path>  Also write the JSON result to an explicit path.',
        '  --keep-temp      Keep the isolated fixture directory for diagnosis.',
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (options.smoke && options.security) {
    throw new Error('--smoke and --security are mutually exclusive.');
  }
  return options;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalProjectKey(projectPath) {
  return projectPath.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase('en-US');
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
    const detail = [result.error?.message, result.stderr, result.stdout].filter(Boolean).join('\n').trim();
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

async function approveNativeBypassConfirmation(processId) {
  assert(process.platform === 'win32', 'Native bypass confirmation automation currently requires Windows.');
  assert(Number.isInteger(processId) && processId > 0, 'Electron process id is unavailable.');
  const source = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class WorkbenchDialogAutomation {
  private delegate bool EnumWindowsProc(IntPtr handle, IntPtr parameter);
  private const uint BM_CLICK = 0x00F5;

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll")]
  private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(IntPtr handle, StringBuilder value, int capacity);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr handle, StringBuilder value, int capacity);
  [DllImport("user32.dll")]
  private static extern IntPtr SendMessage(IntPtr handle, uint message, IntPtr word, IntPtr data);

  private static string ClassName(IntPtr handle) {
    var value = new StringBuilder(256);
    GetClassName(handle, value, value.Capacity);
    return value.ToString();
  }

  private static string Text(IntPtr handle) {
    var value = new StringBuilder(1024);
    GetWindowText(handle, value, value.Capacity);
    return value.ToString();
  }

  public static string Click(int expectedProcessId, string buttonToken, int timeoutMs) {
    var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
    IntPtr dialog = IntPtr.Zero;
    while (dialog == IntPtr.Zero && DateTime.UtcNow < deadline) {
      EnumWindows((handle, parameter) => {
        uint owner;
        GetWindowThreadProcessId(handle, out owner);
        if (owner == expectedProcessId && IsWindowVisible(handle) && ClassName(handle) == "#32770") {
          dialog = handle;
          return false;
        }
        return true;
      }, IntPtr.Zero);
      if (dialog == IntPtr.Zero) Thread.Sleep(50);
    }
    if (dialog == IntPtr.Zero) throw new InvalidOperationException("Native security confirmation was not found.");

    var buttons = new List<Tuple<IntPtr, string>>();
    EnumChildWindows(dialog, (handle, parameter) => {
      if (ClassName(handle) == "Button") buttons.Add(Tuple.Create(handle, Text(handle)));
      return true;
    }, IntPtr.Zero);
    var target = buttons.FirstOrDefault(button =>
      button.Item2.IndexOf(buttonToken, StringComparison.OrdinalIgnoreCase) >= 0);
    if (target == null) {
      throw new InvalidOperationException("Native confirmation button not found: "
        + String.Join(" | ", buttons.Select(button => button.Item2)));
    }
    SendMessage(target.Item1, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
    return Text(dialog) + "\t" + String.Join(" | ", buttons.Select(button => button.Item2));
  }
}`;
  const powerShell = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    "Add-Type -TypeDefinition @'",
    source,
    "'@",
    `[WorkbenchDialogAutomation]::Click(${processId}, 'Enable once', 20000)`,
  ].join('\n');
  const encoded = Buffer.from(powerShell, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encoded,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code) => {
      const output = Buffer.concat(stdout).toString('utf8').trim();
      const error = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) {
        reject(new Error(`Unable to approve native bypass confirmation (${code}): ${error || output}`));
        return;
      }
      const [title, buttons] = output.split('\t');
      resolve({ title, buttons, processId });
    });
  });
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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function git(projectPath, args) {
  return runChecked('git', args, { cwd: projectPath });
}

function gitHead(projectPath) {
  return git(projectPath, ['rev-parse', 'HEAD']);
}

function recordAcceptanceFileChanges(databasePath, taskId, runId, changes) {
  const database = new BetterSqlite3(databasePath);
  try {
    database.pragma('busy_timeout = 5000');
    const insert = database.prepare(`
      INSERT OR REPLACE INTO file_changes (
        id, session_id, file_path, change_type, additions, deletions,
        old_content, new_content, is_binary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `);
    const createdAt = new Date().toISOString();
    database.transaction(() => {
      changes.forEach((change, index) => insert.run(
        `${taskId}:${runId}:acceptance:${index}`,
        taskId,
        change.filePath,
        change.changeType,
        change.additions,
        change.deletions,
        change.oldContent,
        change.newContent,
        createdAt,
      ));
    })();
  } finally {
    database.close();
  }
}

function createGitProject(projectPath, name, skillName) {
  const sourcePath = path.join(projectPath, 'src', 'sample.ts');
  const taskTargetPath = path.join(projectPath, 'src', 'phase5-task-target.ts');
  const userOwnedPath = path.join(projectPath, 'src', 'phase5-user-owned.ts');
  const skillPath = path.join(projectPath, '.claude', 'skills', skillName, 'SKILL.md');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(sourcePath, [
    `export const project = '${name}';`,
    'export function total(left: number, right: number) {',
    '  return left + right;',
    '}',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(taskTargetPath, [
    `export const phase = '${name} baseline';`,
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(userOwnedPath, [
    `export const owner = '${name} user baseline';`,
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(skillPath, [
    '---',
    `name: ${skillName}`,
    `description: Isolated acceptance Skill for ${name}`,
    '---',
    '',
    '# Acceptance Skill',
    '',
    'This document is read-only during Electron acceptance.',
    '',
  ].join('\n'), 'utf8');
  writeJson(path.join(projectPath, '.mcp.json'), {
    mcpServers: {
      acceptance_filesystem: {
        type: 'stdio',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        env: { ACCEPTANCE_TOKEN: 'must-never-reach-the-renderer' },
      },
    },
  });
  fs.writeFileSync(path.join(projectPath, 'CLAUDE.md'), '# Isolated acceptance project\n', 'utf8');
  runChecked('git', ['init', '--quiet'], { cwd: projectPath });
  runChecked('git', ['config', 'user.name', 'Claude Workbench Acceptance'], { cwd: projectPath });
  runChecked('git', ['config', 'user.email', 'acceptance@example.invalid'], { cwd: projectPath });
  runChecked('git', ['add', '--all'], { cwd: projectPath });
  runChecked('git', [
    '-c', 'user.name=Claude Workbench Acceptance',
    '-c', 'user.email=acceptance@example.invalid',
    'commit', '--quiet', '-m', 'acceptance baseline',
  ], { cwd: projectPath });
  fs.writeFileSync(sourcePath, [
    `export const project = '${name}';`,
    'export function total(left: number, right: number) {',
    '  const result = left + right;',
    '  return Number.isFinite(result) ? result : 0;',
    '}',
    '',
  ].join('\n'), 'utf8');
  return { sourcePath, skillPath, taskTargetPath, userOwnedPath };
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
  const projectAlpha = path.join(root, 'projects', 'Acceptance Alpha');
  const projectBeta = path.join(root, 'projects', 'Acceptance Beta');
  for (const directory of [
    dataRoot,
    browserDataRoot,
    isolatedHome,
    appData,
    localAppData,
    runtimeTemp,
    projectAlpha,
    projectBeta,
  ]) fs.mkdirSync(directory, { recursive: true });

  const alphaGit = createGitProject(projectAlpha, 'Acceptance Alpha', 'acceptance-project-skill');
  const betaGit = createGitProject(projectBeta, 'Acceptance Beta', 'acceptance-beta-skill');
  const userSkillPath = path.join(
    isolatedHome,
    '.claude',
    'skills',
    'acceptance-user-skill',
    'SKILL.md',
  );
  fs.mkdirSync(path.dirname(userSkillPath), { recursive: true });
  fs.writeFileSync(userSkillPath, [
    '---',
    'name: acceptance-user-skill',
    'description: User-scoped only inside the isolated acceptance home',
    '---',
    '',
    '# Isolated User Skill',
    '',
  ].join('\n'), 'utf8');

  const createdAt = new Date(Date.now() - 60_000).toISOString();
  const alphaOpenedAt = new Date().toISOString();
  const betaOpenedAt = new Date(Date.now() - 1_000).toISOString();
  writeJson(path.join(dataRoot, 'claude-workbench.db'), {
    projects: {
      'acceptance-alpha': {
        id: 'acceptance-alpha',
        name: 'Acceptance Alpha',
        path: projectAlpha,
        created_at: createdAt,
        last_opened_at: alphaOpenedAt,
      },
      'acceptance-beta': {
        id: 'acceptance-beta',
        name: 'Acceptance Beta',
        path: projectBeta,
        created_at: createdAt,
        last_opened_at: betaOpenedAt,
      },
    },
    sessions: {
      'bootstrap-alpha': {
        id: 'bootstrap-alpha',
        project_id: 'acceptance-alpha',
        title: 'Bootstrap Alpha',
        status: 'idle',
        created_at: createdAt,
        updated_at: createdAt,
      },
      'bootstrap-beta': {
        id: 'bootstrap-beta',
        project_id: 'acceptance-beta',
        title: 'Bootstrap Beta',
        status: 'idle',
        created_at: createdAt,
        updated_at: createdAt,
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
    browserDataRoot,
    isolatedHome,
    appData,
    localAppData,
    runtimeTemp,
    projectAlpha,
    projectBeta,
    alphaGit,
    betaGit,
    userSkillPath,
  };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
    throw error;
  }
}

function childEnvironment(fixture) {
  const env = {
    ...process.env,
    WORKBENCH_DATA_DIR: fixture.dataRoot,
    FORCE_FAKE: '1',
    NODE_ENV: 'production',
    HOME: fixture.isolatedHome,
    USERPROFILE: fixture.isolatedHome,
    APPDATA: fixture.appData,
    LOCALAPPDATA: fixture.localAppData,
    XDG_CONFIG_HOME: path.join(fixture.isolatedHome, '.config'),
    CLAUDE_CONFIG_DIR: path.join(fixture.isolatedHome, '.claude'),
    TEMP: fixture.runtimeTemp,
    TMP: fixture.runtimeTemp,
  };
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ELECTRON_RUN_AS_NODE',
    'NODE_OPTIONS',
    'VITE_DEV_SERVER_URL',
    'WORKBENCH_OPEN_DEVTOOLS',
  ]) delete env[key];
  return env;
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
    // The renderer can close the CDP socket before returning the evaluation result.
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
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    if (!(await waitForProcessExit(instance.child, 2_000))) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
  await waitForProcessExit(instance.child, 3_000);
}

async function launchElectron(fixture) {
  const port = await reservePort();
  const electronPath = electron.default || electron;
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${fixture.browserDataRoot}`,
    '.',
  ];
  const child = spawn(electronPath, args, {
    cwd: WORKSPACE_ROOT,
    env: childEnvironment(fixture),
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
      rendererErrors.push(params.args?.map((argument) => argument.value ?? argument.description ?? '').join(' ')
        || 'Renderer console error');
    });
    await Promise.all([
      client.send('Runtime.enable'),
      client.send('Page.enable'),
      client.send('Log.enable'),
    ]);
    await client.waitFor(
      `document.readyState === 'complete' && document.getElementById('root')?.children.length > 0`,
      { description: 'Workbench React root', timeoutMs: 30_000 },
    );
    return { child, client, page, port, stdout, stderr, rendererErrors };
  } catch (error) {
    const instance = { child, client, stdout, stderr };
    await stopElectron(instance);
    const logs = [...stderr, ...stdout].join('').trim().split(/\r?\n/).slice(-30).join('\n');
    throw new Error(`${error.message}${logs ? `\nElectron log tail:\n${logs}` : ''}`);
  }
}

function js(value) {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

async function clickControl(client, labels, { exact = true, selector = 'button, [role="button"], [role="option"], summary' } = {}) {
  return client.evaluate(`(() => {
    const labels = ${js(labels)};
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll(${js(selector)})).filter(visible);
    const match = candidates.find((element) => {
      const values = [element.textContent, element.getAttribute('title'), element.getAttribute('aria-label')].map(normalize);
      return labels.some((label) => values.some((value) => ${exact ? 'value === label' : 'value.includes(label)'}));
    });
    if (!match) return null;
    match.click();
    return {
      text: normalize(match.textContent),
      title: normalize(match.getAttribute('title')),
      ariaLabel: normalize(match.getAttribute('aria-label')),
    };
  })()`);
}

async function controlInventory(client) {
  return client.evaluate(`(() => Array.from(document.querySelectorAll('button, [role="button"], [role="option"]'))
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    })
    .slice(0, 80)
    .map((element) => ({
      text: String(element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100),
      title: element.getAttribute('title'),
      ariaLabel: element.getAttribute('aria-label'),
      testId: element.getAttribute('data-testid'),
    })))()`);
}

async function selectProject(client, name, bootstrapTitle) {
  const clicked = await clickControl(client, [name]);
  assert(clicked, `Project control not found: ${name}`);
  await client.waitFor(`document.body.innerText.includes(${js(bootstrapTitle)})`, {
    description: `${name} sessions`,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  });
}

async function selectSession(client, sessionId) {
  const clicked = await client.evaluate(`(() => {
    const element = document.querySelector(${js(`[data-session-key$="::${sessionId}"]`)});
    if (!element) return false;
    element.click();
    return true;
  })()`);
  assert(clicked, `Session control not found for ${sessionId}.`);
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function setTaskPrompt(client, prompt) {
  const result = await client.evaluate(`(() => {
    const element = Array.from(document.querySelectorAll('textarea')).find((candidate) => !candidate.disabled);
    if (!element) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter.call(element, ${js(prompt)});
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${js(prompt)} }));
    element.focus();
    return element.value;
  })()`);
  assert(result === prompt, 'Unable to populate the task input.');
  await client.waitFor(`Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === '发送' && !button.disabled)`, {
    description: 'enabled Send button',
  });
}

async function waitForSessionStatus(client, sessionId, expected) {
  await client.waitFor(`(async () => (await window.api.getSession(${js(sessionId)}))?.status === ${js(expected)})()`, {
    description: `session ${sessionId} to become ${expected}`,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  });
  return client.evaluate(`window.api.getSession(${js(sessionId)})`);
}

async function createTaskFromUi(client, projectId) {
  const before = await client.evaluate(`window.api.listSessions(${js(projectId)})`);
  const clicked = await clickControl(client, ['新建任务']);
  assert(clicked, 'New task button is unavailable.');
  await client.waitFor(`(async () => (await window.api.listSessions(${js(projectId)})).length === ${before.length + 1})()`, {
    description: `new task in ${projectId}`,
  });
  const after = await client.evaluate(`window.api.listSessions(${js(projectId)})`);
  const previous = new Set(before.map((session) => session.id));
  const created = after.find((session) => !previous.has(session.id));
  assert(created, `The new task in ${projectId} was not returned by SQLite IPC.`);
  await selectSession(client, created.id);
  return created;
}

async function runTaskFromUi(client, sessionId, prompt) {
  await setTaskPrompt(client, prompt);
  const clicked = await clickControl(client, ['发送']);
  assert(clicked, 'Send button is unavailable.');
  const detail = await waitForSessionStatus(client, sessionId, 'completed');
  assert(detail?.claudeSessionId, `Completed task ${sessionId} has no Claude session id.`);
  return detail;
}

async function clickTaskGitAction(client, actionIndex) {
  const clicked = await client.evaluate(`(() => {
    const groups = Array.from(document.querySelectorAll('[data-testid="task-git-actions"]'));
    const group = groups.at(-1);
    const button = group?.querySelectorAll('button')[${actionIndex}];
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert(clicked, `Task Git action ${actionIndex} is unavailable.`);
}

async function clickDrawerTab(client, label) {
  const clicked = await client.evaluate(`(() => {
    const drawer = document.querySelector('[data-testid="workspace-right-drawer"]');
    const button = Array.from(drawer?.querySelectorAll(':scope > header button') || [])
      .find((candidate) => candidate.textContent.trim() === ${js(label)});
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert(clicked, `Workspace drawer tab is unavailable: ${label}`);
}

function phaseFileState(fixture, aiNewPath) {
  return {
    head: gitHead(fixture.projectAlpha),
    taskTargetHash: hashFile(fixture.alphaGit.taskTargetPath),
    userOwnedHash: hashFile(fixture.alphaGit.userOwnedPath),
    sampleHash: hashFile(fixture.alphaGit.sourcePath),
    aiNewExists: fs.existsSync(aiNewPath),
    aiNewHash: fs.existsSync(aiNewPath) ? hashFile(aiNewPath) : null,
    porcelain: git(fixture.projectAlpha, ['status', '--porcelain=v1', '--untracked-files=all']),
  };
}

async function runPhaseFiveMutationTask(client, fixture) {
  await selectProject(client, 'Acceptance Alpha', 'Bootstrap Alpha');
  const task = await createTaskFromUi(client, 'acceptance-alpha');
  const title = 'Add safe checkpoint workflow';
  await client.evaluate(`window.api.updateSession(${js(task.id)}, { title: ${js(title)}, titleSource: 'manual' })`);

  const userContent = [
    "export const owner = 'user dirty state before AI task';",
    'export const keepThis = true;',
    '',
  ].join('\n');
  fs.writeFileSync(fixture.alphaGit.userOwnedPath, userContent, 'utf8');
  const userOwnedHash = hashFile(fixture.alphaGit.userOwnedPath);
  const sampleHash = hashFile(fixture.alphaGit.sourcePath);
  const taskTargetBefore = fs.readFileSync(fixture.alphaGit.taskTargetPath, 'utf8');
  const aiNewPath = path.join(fixture.projectAlpha, 'src', 'phase5-ai-created.ts');
  const taskTargetAfter = [
    "export const phase = 'AI checkpoint implementation';",
    'export const restoreSafe = true;',
    '',
  ].join('\n');
  const aiNewContent = [
    'export function phaseFiveCheckpoint() {',
    "  return 'created by isolated AI acceptance task';",
    '}',
    '',
  ].join('\n');
  const runId = `acceptance-phase5-${crypto.randomUUID()}`;
  const descriptor = await client.evaluate(`window.api.runPrompt({
    runId: ${js(runId)},
    projectKey: ${js(canonicalProjectKey(fixture.projectAlpha))},
    sessionKey: ${js(`${canonicalProjectKey(fixture.projectAlpha)}::${task.id}`)},
    projectPath: ${js(fixture.projectAlpha)},
    prompt: ${js(title)},
    permissionMode: 'default',
    agentMode: 'develop'
  })`);

  // The deterministic adapter stays active for 140 ms. Mutate only the isolated
  // repository after beforeRun has durably captured the automatic baseline.
  fs.writeFileSync(fixture.alphaGit.taskTargetPath, taskTargetAfter, 'utf8');
  fs.writeFileSync(aiNewPath, aiNewContent, 'utf8');
  recordAcceptanceFileChanges(path.join(fixture.dataRoot, 'claude-workbench.db'), task.id, runId, [
    {
      filePath: 'src/phase5-task-target.ts',
      changeType: 'modified',
      additions: 2,
      deletions: 1,
      oldContent: taskTargetBefore,
      newContent: taskTargetAfter,
    },
    {
      filePath: 'src/phase5-ai-created.ts',
      changeType: 'added',
      additions: 4,
      deletions: 0,
      oldContent: null,
      newContent: aiNewContent,
    },
  ]);

  const detail = await waitForSessionStatus(client, task.id, 'completed');
  await client.waitFor(`(async () => {
    const checkpoints = await window.api.listCheckpoints(${js(task.id)});
    return checkpoints.some((checkpoint) => checkpoint.type === 'before_task')
      && checkpoints.some((checkpoint) => checkpoint.type === 'task_completed');
  })()`, {
    description: 'automatic Phase 5 checkpoints',
    timeoutMs: 30_000,
  });
  await selectSession(client, task.id);
  await client.waitFor(`document.querySelector('[data-testid="task-result-card"]')`, {
    description: 'Phase 5 task result card',
  });
  return {
    task,
    title,
    runId,
    descriptor,
    detail,
    aiNewPath,
    taskTargetBefore,
    taskTargetAfter,
    aiNewContent,
    userContent,
    userOwnedHash,
    sampleHash,
  };
}

async function runConcurrentTasks(client, fixture) {
  const value = await client.evaluate(`(async () => {
    const alphaId = await window.api.createSession('acceptance-alpha');
    const betaId = await window.api.createSession('acceptance-beta');
    const runA = 'acceptance-concurrent-alpha-' + crypto.randomUUID();
    const runB = 'acceptance-concurrent-beta-' + crypto.randomUUID();
    const events = [];
    const unsubscribe = window.api.onClaudeEvent((envelope) => {
      if (envelope.runId === runA || envelope.runId === runB) {
        events.push({ runId: envelope.runId, type: envelope.event.type, at: performance.now() });
      }
    });
    const descriptors = await Promise.all([
      window.api.runPrompt({
        runId: runA,
        projectKey: ${js(canonicalProjectKey(fixture.projectAlpha))},
        sessionKey: ${js(`${canonicalProjectKey(fixture.projectAlpha)}::`)} + alphaId,
        projectPath: ${js(fixture.projectAlpha)},
        prompt: 'Acceptance concurrent task Alpha',
        permissionMode: 'default',
      }),
      window.api.runPrompt({
        runId: runB,
        projectKey: ${js(canonicalProjectKey(fixture.projectBeta))},
        sessionKey: ${js(`${canonicalProjectKey(fixture.projectBeta)}::`)} + betaId,
        projectPath: ${js(fixture.projectBeta)},
        prompt: 'Acceptance concurrent task Beta',
        permissionMode: 'default',
      }),
    ]);
    const active = typeof window.api.listActiveTasks === 'function'
      ? await window.api.listActiveTasks()
      : [];
    await new Promise((resolve, reject) => {
      const deadline = performance.now() + 5000;
      const poll = () => {
        const terminal = new Set(events
          .filter((event) => event.type === 'session_completed' || event.type === 'session_failed')
          .map((event) => event.runId));
        if (terminal.has(runA) && terminal.has(runB)) resolve();
        else if (performance.now() > deadline) reject(new Error('Concurrent tasks did not finish.'));
        else setTimeout(poll, 20);
      };
      poll();
    });
    if (typeof window.api.listActiveTasks === 'function') {
      await new Promise((resolve, reject) => {
        const deadline = performance.now() + 10_000;
        const poll = async () => {
          try {
            const current = await window.api.listActiveTasks();
            const activeRunIds = new Set(current.map((task) => task.runId));
            if (!activeRunIds.has(runA) && !activeRunIds.has(runB)) {
              resolve();
            } else if (performance.now() > deadline) {
              reject(new Error('Concurrent task finalizers did not release their project locks.'));
            } else {
              setTimeout(() => void poll(), 20);
            }
          } catch (error) {
            reject(error);
          }
        };
        void poll();
      });
    }
    unsubscribe();
    return { alphaId, betaId, runA, runB, descriptors, active, events };
  })()`, { timeoutMs: 10_000 });
  const firstTerminal = value.events.findIndex((event) => event.type === 'session_completed' || event.type === 'session_failed');
  const startsBeforeTerminal = value.events
    .slice(0, firstTerminal)
    .filter((event) => event.type === 'session_started')
    .map((event) => event.runId);
  assert(firstTerminal > 0, 'Concurrent tasks emitted no terminal event.');
  assert(new Set(startsBeforeTerminal).size === 2, 'Both projects were not active before the first task completed.');
  if (value.active.length > 0) {
    const activeRunIds = new Set(value.active.map((task) => task.runId));
    assert(activeRunIds.has(value.runA) && activeRunIds.has(value.runB), 'TaskManager did not report both active tasks.');
  }

  const lock = await client.evaluate(`(async () => {
    const firstSession = await window.api.createSession('acceptance-alpha');
    const secondSession = await window.api.createSession('acceptance-alpha');
    const firstRun = 'acceptance-lock-owner-' + crypto.randomUUID();
    const secondRun = 'acceptance-lock-contender-' + crypto.randomUUID();
    const completed = new Promise((resolve, reject) => {
      const deadline = performance.now() + 5000;
      const unsubscribe = window.api.onClaudeEvent((envelope) => {
        if (envelope.runId === firstRun && envelope.event.type === 'session_completed') {
          unsubscribe();
          resolve();
        }
      });
      setTimeout(() => {
        unsubscribe();
        reject(new Error('Lock owner did not complete.'));
      }, Math.max(0, deadline - performance.now()));
    });
    await window.api.runPrompt({
      runId: firstRun,
      projectKey: ${js(canonicalProjectKey(fixture.projectAlpha))},
      sessionKey: ${js(`${canonicalProjectKey(fixture.projectAlpha)}::`)} + firstSession,
      projectPath: ${js(fixture.projectAlpha)},
      prompt: 'Acceptance lock owner',
      permissionMode: 'default',
    });
    let rejection = null;
    try {
      await window.api.runPrompt({
        runId: secondRun,
        projectKey: ${js(canonicalProjectKey(fixture.projectAlpha))},
        sessionKey: ${js(`${canonicalProjectKey(fixture.projectAlpha)}::`)} + secondSession,
        projectPath: ${js(fixture.projectAlpha)},
        prompt: 'Acceptance lock contender',
        permissionMode: 'default',
      });
    } catch (error) {
      rejection = String(error?.message || error);
    }
    await completed;
    if (typeof window.api.listActiveTasks === 'function') {
      await new Promise((resolve, reject) => {
        const deadline = performance.now() + 10_000;
        const poll = async () => {
          try {
            const current = await window.api.listActiveTasks();
            if (!current.some((task) => task.runId === firstRun)) {
              resolve();
            } else if (performance.now() > deadline) {
              reject(new Error('Lock owner finalizer did not release its project lock.'));
            } else {
              setTimeout(() => void poll(), 20);
            }
          } catch (error) {
            reject(error);
          }
        };
        void poll();
      });
    }
    return { rejection };
  })()`, { timeoutMs: 10_000 });
  assert(/已有任务|TASK_PROJECT_BUSY|正在修改文件/.test(lock.rejection ?? ''), 'Same-project write lock did not reject a competing task.');
  return {
    runIds: [value.runA, value.runB],
    activeSnapshotCount: value.active.length,
    eventOrder: value.events.map((event) => `${event.runId}:${event.type}`),
    sameProjectRejection: lock.rejection,
  };
}

async function openIntegrationsPanel(client) {
  if (await client.evaluate(`Boolean(document.querySelector('[data-testid="integrations-panel"]'))`)) return;
  const direct = await clickControl(client, ['MCP 与 Skills', '集成管理', 'MCP 管理', 'Integrations'], { exact: false });
  if (direct) {
    try {
      await client.waitFor(`document.querySelector('[data-testid="integrations-panel"]')`, {
        description: 'integrations panel',
        timeoutMs: 3_000,
      });
      return;
    } catch { /* try the settings surface */ }
  }
  await clickControl(client, ['设置'], { exact: false });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const settingsEntry = await clickControl(client, ['集成管理', 'MCP 管理', 'MCP 与 Skills', 'MCP'], { exact: false });
  if (settingsEntry) {
    try {
      await client.waitFor(`document.querySelector('[data-testid="integrations-panel"]')`, {
        description: 'integrations panel from settings',
        timeoutMs: 3_000,
      });
      return;
    } catch { /* command palette is the final UI path */ }
  }
  await client.dispatchShortcut({ key: 'P', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 2 | 8 });
  try {
    await client.waitFor(`document.querySelector('[data-testid="command-palette-backdrop"]')`, {
      description: 'command palette for integrations',
      timeoutMs: 2_000,
    });
    await client.evaluate(`(() => {
      const input = document.querySelector('[aria-label="命令面板"] input, [data-testid="command-palette-backdrop"] input');
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter.call(input, 'MCP');
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'MCP' }));
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await clickControl(client, ['MCP', '集成'], { exact: false, selector: '[role="option"], button' });
    await client.waitFor(`document.querySelector('[data-testid="integrations-panel"]')`, {
      description: 'integrations panel from command palette',
      timeoutMs: 3_000,
    });
    return;
  } catch {
    const controls = await controlInventory(client);
    throw new Error(`No UI route opened IntegrationsPanel. Visible controls: ${JSON.stringify(controls)}`);
  }
}

function verifySqlite(databasePath) {
  const header = fs.readFileSync(databasePath).subarray(0, 16).toString('utf8');
  assert(header.startsWith('SQLite format 3'), 'The persisted database is not SQLite.');
  const database = new BetterSqlite3(databasePath, { readonly: true });
  try {
    const integrity = database.pragma('integrity_check', { simple: true });
    const projectCount = database.prepare('SELECT COUNT(*) AS count FROM projects').get().count;
    const sessionCount = database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count;
    const completedTaskCount = database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'completed'").get().count;
    assert(integrity === 'ok', `SQLite integrity_check returned ${integrity}.`);
    assert(projectCount === 2, `Expected 2 persisted projects, found ${projectCount}.`);
    return { header, integrity, projectCount, sessionCount, completedTaskCount };
  } finally {
    database.close();
  }
}

function verifyPhaseFivePersistence(databasePath, fixture, state) {
  const database = new BetterSqlite3(databasePath, { readonly: true });
  try {
    database.pragma('foreign_keys = ON');
    const schemaVersion = database.pragma('user_version', { simple: true });
    const foreignKeyViolations = database.pragma('foreign_key_check');
    const checkpointForeignKeys = database.pragma('foreign_key_list(checkpoints)');
    const checkpointFileForeignKeys = database.pragma('foreign_key_list(checkpoint_files)');
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all().map((row) => row.name));
    assert(schemaVersion === 2, `Expected SQLite schema v2, found v${schemaVersion}.`);
    assert(tables.has('checkpoints') && tables.has('checkpoint_files'), 'Checkpoint v2 tables are missing.');
    assert(foreignKeyViolations.length === 0, `SQLite foreign_key_check found ${foreignKeyViolations.length} violation(s).`);
    assert(checkpointForeignKeys.some((item) => item.table === 'tasks'), 'checkpoints.task_id foreign key is missing.');
    assert(checkpointFileForeignKeys.some((item) => item.table === 'checkpoints'), 'checkpoint_files foreign key is missing.');

    const checkpoints = database.prepare(`
      SELECT id, task_id, type, git_commit, snapshot_path, metadata_json
      FROM checkpoints WHERE task_id = ? ORDER BY created_at ASC, id ASC
    `).all(state.phase5.task.id);
    assert(checkpoints.length >= 5, `Expected at least five Phase 5 checkpoints, found ${checkpoints.length}.`);
    assert(checkpoints.some((checkpoint) => checkpoint.type === 'before_task'), 'Persisted before_task checkpoint is missing.');
    assert(checkpoints.some((checkpoint) => checkpoint.type === 'task_completed'), 'Persisted task_completed checkpoint is missing.');
    assert(checkpoints.some((checkpoint) => checkpoint.type === 'manual'), 'Persisted manual checkpoint is missing.');
    assert(checkpoints.some((checkpoint) => checkpoint.type === 'accepted'), 'Persisted accepted checkpoint is missing.');

    const snapshotRoot = path.resolve(fixture.dataRoot, 'checkpoints');
    let verifiedSnapshotFiles = 0;
    for (const checkpoint of checkpoints) {
      assert(checkpoint.snapshot_path, `Checkpoint ${checkpoint.id} has no snapshot path.`);
      const snapshotPath = path.resolve(checkpoint.snapshot_path);
      const relative = path.relative(snapshotRoot, snapshotPath);
      assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `Checkpoint snapshot escaped the isolated data root: ${snapshotPath}`);
      const manifestPath = path.join(snapshotPath, 'manifest.json');
      assert(fs.existsSync(manifestPath), `Checkpoint manifest is missing: ${checkpoint.id}`);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert(manifest.id === checkpoint.id && manifest.task_id === state.phase5.task.id, `Checkpoint manifest identity mismatch: ${checkpoint.id}`);
      const fileRows = database.prepare(`
        SELECT file_path, hash, size FROM checkpoint_files
        WHERE checkpoint_id = ? ORDER BY file_path ASC
      `).all(checkpoint.id);
      assert(Array.isArray(manifest.files) && manifest.files.length === fileRows.length, `Checkpoint manifest/file row mismatch: ${checkpoint.id}`);
      for (const file of fileRows) {
        if (file.hash === 'absent') continue;
        const snapshotFile = path.join(snapshotPath, 'files', crypto.createHash('sha256').update(file.file_path).digest('hex'));
        assert(fs.existsSync(snapshotFile), `Snapshot payload is missing: ${checkpoint.id}:${file.file_path}`);
        assert(hashFile(snapshotFile) === file.hash, `Snapshot payload hash mismatch: ${checkpoint.id}:${file.file_path}`);
        assert(fs.statSync(snapshotFile).size === file.size, `Snapshot payload size mismatch: ${checkpoint.id}:${file.file_path}`);
        verifiedSnapshotFiles += 1;
      }
      if (checkpoint.git_commit) {
        git(fixture.projectAlpha, ['cat-file', '-e', `${checkpoint.git_commit}^{commit}`]);
      }
    }
    assert(verifiedSnapshotFiles > 0, 'No checkpoint snapshot payload was verified.');

    const eventRow = database.prepare(`
      SELECT payload_json FROM events
      WHERE session_id = ? AND event_type = 'git_commit_created'
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(state.phase5.task.id);
    assert(eventRow, 'Persisted git_commit_created event is missing.');
    const commitEvent = JSON.parse(eventRow.payload_json);
    assert(commitEvent.commit === state.phase5.commit.commit, 'Commit event hash differs from the confirmed commit result.');
    assert(commitEvent.subject === state.phase5.commit.subject, 'Commit event subject differs from the confirmed preview.');
    assert(JSON.stringify([...commitEvent.files].sort()) === JSON.stringify([...state.phase5.commit.files].sort()), 'Commit event file list differs from the confirmed commit result.');
    assert(gitHead(fixture.projectAlpha) === state.phase5.commit.commit, 'Repository HEAD differs from the persisted commit event.');

    return {
      schemaVersion,
      foreignKeyViolations: foreignKeyViolations.length,
      foreignKeys: {
        checkpointsToTasks: checkpointForeignKeys.some((item) => item.table === 'tasks'),
        filesToCheckpoints: checkpointFileForeignKeys.some((item) => item.table === 'checkpoints'),
      },
      checkpointCount: checkpoints.length,
      checkpointTypes: checkpoints.map((checkpoint) => checkpoint.type),
      checkpointIds: checkpoints.map((checkpoint) => checkpoint.id),
      verifiedSnapshotFiles,
      commitEvent: {
        commit: commitEvent.commit,
        subject: commitEvent.subject,
        files: commitEvent.files,
      },
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

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.build) {
    console.log('[preflight] Building the real Electron main, preload, and renderer bundles...');
    runNpm(['run', 'build'], { inherit: true });
  }

  const fixture = createFixture();
  const report = {
    startedAt: new Date().toISOString(),
    mode: options.security ? 'security' : options.smoke ? 'smoke' : 'full',
    workspace: WORKSPACE_ROOT,
    isolation: {
      workbenchDataDir: fixture.dataRoot,
      chromiumUserDataDir: fixture.browserDataRoot,
      homeDir: fixture.isolatedHome,
      forceFake: true,
      externalClaudeInvoked: false,
      globalConfigModified: false,
    },
    electron: null,
    steps: [],
    rendererErrors: [],
    cleanup: { processStopped: false, tempRemoved: false },
  };
  let instance = null;
  let failed = null;
  const state = {};

  const step = async (number, title, work) => {
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
      console.log(`[pass ${number}] ${title} (${result.durationMs} ms)`);
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
      console.error(`[fail ${number}] ${title}: ${result.error}`);
      throw error;
    }
  };

  try {
    instance = await launchElectron(fixture);
    const identity = await instance.client.evaluate(`({
      title: document.title,
      userAgent: navigator.userAgent,
      rendererUrl: location.href,
      apiAvailable: Boolean(window.api),
      nodeIntegrationDisabled: typeof require === 'undefined' && typeof process === 'undefined',
      viewport: { width: innerWidth, height: innerHeight },
    })`);
    assert(identity.title === 'Claude Workbench', `Unexpected Electron window title: ${identity.title}`);
    assert(/Electron\//.test(identity.userAgent), 'The renderer user agent does not identify Electron.');
    assert(identity.apiAvailable, 'The contextBridge API is unavailable.');
    assert(identity.nodeIntegrationDisabled, 'Renderer Node integration is unexpectedly enabled.');
    report.electron = { pid: instance.child.pid, cdpPort: instance.port, ...identity };
    console.log(`[preflight] Real Electron PID ${instance.child.pid}, renderer ${identity.rendererUrl}`);

    await step(1, '打开并隔离两个项目', async () => {
      const projects = await instance.client.evaluate('window.api.listProjects()');
      assert(projects.length === 2, `Expected 2 projects, found ${projects.length}.`);
      assert(projects.some((project) => project.path === fixture.projectAlpha), 'Acceptance Alpha path is missing.');
      assert(projects.some((project) => project.path === fixture.projectBeta), 'Acceptance Beta path is missing.');
      await instance.client.waitFor(`document.body.innerText.includes('Acceptance Alpha') && document.body.innerText.includes('Acceptance Beta')`, {
        description: 'both projects in the sidebar',
      });
      const installation = await instance.client.evaluate('window.api.checkInstallation()');
      assert(installation.path === 'fake-claude', 'Acceptance did not stay on the deterministic isolated adapter.');
      return { projects: projects.map((project) => ({ id: project.id, name: project.name, path: project.path })), installation };
    });

    if (options.security) {
      await step('security-settings', '显式启用危险权限模式并重启', async () => {
        await instance.client.evaluate(`window.api.setSettings({
          defaultPermissionMode: 'bypass',
          showDangerousPermissions: true,
        })`);
        const settings = await instance.client.evaluate('window.api.getSettings()');
        assert(settings.defaultPermissionMode === 'bypass', 'Bypass mode was not explicitly persisted.');
        assert(settings.showDangerousPermissions === true, 'Dangerous permission visibility was not explicitly persisted.');
        report.rendererErrors.push(...instance.rendererErrors);
        assert(instance.rendererErrors.length === 0, `Renderer emitted errors before security restart: ${instance.rendererErrors.join(' | ')}`);
        await stopElectron(instance);
        instance = await launchElectron(fixture);
        return {
          defaultPermissionMode: settings.defaultPermissionMode,
          showDangerousPermissions: settings.showDangerousPermissions,
          restartedElectronPid: instance.child.pid,
        };
      });

      await step('security-boundary', '运行中阻止 restore，并确认 bypass 高风险授权与审计', async () => {
        await selectProject(instance.client, 'Acceptance Alpha', 'Bootstrap Alpha');
        await selectSession(instance.client, 'bootstrap-alpha');
        const prompt = 'Electron security acceptance bypass request';
        await setTaskPrompt(instance.client, prompt);
        const started = await instance.client.evaluate(`(() => {
          const button = document.querySelector('button[title*="Ctrl+Enter"]');
          if (!button || button.disabled) return false;
          button.click();
          return true;
        })()`);
        assert(started, 'Unable to start the bypass task from the renderer UI.');

        await instance.client.waitFor(`document.querySelector('[data-testid="bypass-permission-warning"]')`, {
          description: 'bypass high-risk confirmation',
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        });
        const dialog = await instance.client.evaluate(`(() => {
          const warning = document.querySelector('[data-testid="bypass-permission-warning"]');
          const allow = document.querySelector('[data-testid="bypass-permission-allow-once"]');
          const active = Array.from(document.querySelectorAll('[role="dialog"]')).at(-1) ?? warning?.parentElement;
          return {
            warning: warning?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
            allowLabel: allow?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
            dialogText: active?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
          };
        })()`);
        assert(dialog.warning.length > 0, 'The bypass dialog did not show a high-risk warning.');
        assert(dialog.allowLabel.length > 0, 'The bypass dialog did not require an explicit one-shot decision.');

        const requestedAudit = await instance.client.evaluate(`(async () => {
          const page = await window.api.listTaskEvents('bootstrap-alpha', { limit: 500, offset: 0 });
          return page.items.filter((event) => event.type.startsWith('permission_audit_'));
        })()`);
        assert(requestedAudit.filter((event) => event.type === 'permission_audit_requested').length === 1,
          'PermissionAudit did not durably record the bypass request before the decision.');
        assert(requestedAudit.every((event) => event.type !== 'permission_audit_decided'),
          'PermissionAudit recorded a decision before the user acted.');
        const auditId = requestedAudit.find((event) => event.type === 'permission_audit_requested')?.payload.auditId;
        assert(typeof auditId === 'string' && auditId.length > 0, 'PermissionAudit request id is unavailable.');
        const rendererDecision = await instance.client.evaluate(`window.api.decidePermission(
          ${js(auditId)},
          'allow_once'
        )`);
        assert(rendererDecision.accepted === false,
          'The renderer directly approved bypassPermissions without trusted main-process confirmation.');

        const activeTasks = await instance.client.evaluate('window.api.listActiveTasks()');
        assert(activeTasks.some((task) => task.projectPath === fixture.projectAlpha && task.writable),
          'The bypass task did not hold the writable project mutation lease while awaiting permission.');
        const beforeHash = hashFile(fixture.alphaGit.sourcePath);
        const restoreAttempt = await instance.client.evaluate(`window.api.restoreFile(
          'src/sample.ts',
          ${js(fixture.projectAlpha)}
        ).then(() => ({ ok: true })).catch((error) => ({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }))`);
        assert(!restoreAttempt.ok, 'Checkpoint/Git restore unexpectedly ran beside an active writable task.');
        assert(/running task|file mutation|project busy|TASK_PROJECT_BUSY/i.test(restoreAttempt.message),
          `Restore failed for the wrong reason: ${restoreAttempt.message}`);
        assert(hashFile(fixture.alphaGit.sourcePath) === beforeHash,
          'Rejected restore changed user project bytes.');

        const nativeConfirmation = await approveNativeBypassConfirmation(instance.child.pid);
        assert(nativeConfirmation.title.includes('Claude Workbench Security Confirmation'),
          `Unexpected native confirmation title: ${nativeConfirmation.title}`);
        assert(nativeConfirmation.buttons.includes('Enable once'),
          `Native confirmation did not expose the explicit one-shot action: ${nativeConfirmation.buttons}`);
        await waitForSessionStatus(instance.client, 'bootstrap-alpha', 'completed');

        const audit = await instance.client.evaluate(`(async () => {
          const page = await window.api.listTaskEvents('bootstrap-alpha', { limit: 500, offset: 0 });
          return page.items.filter((event) => event.type.startsWith('permission_audit_'));
        })()`);
        const requested = audit.find((event) => event.type === 'permission_audit_requested');
        const decided = audit.find((event) => event.type === 'permission_audit_decided');
        assert(requested && decided, 'PermissionAudit request/decision pair is incomplete.');
        assert(requested.payload.risk === 'high' && requested.payload.projectId === 'acceptance-alpha'
          && requested.payload.sessionId === 'bootstrap-alpha' && requested.payload.taskId === 'bootstrap-alpha',
          'PermissionAudit request identity is incomplete.');
        assert(decided.payload.behavior === 'allow' && decided.payload.decision === 'allow_once',
          'PermissionAudit did not record the explicit one-shot authorization.');
        const serializedAudit = JSON.stringify(audit);
        assert(!serializedAudit.includes(prompt), 'PermissionAudit leaked the user prompt.');
        await instance.client.waitFor(`(async () => (await window.api.listActiveTasks()).length === 0)()`, {
          description: 'TaskManager terminal finalizers and mutation lease release',
          timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        });
        const remainingActive = await instance.client.evaluate('window.api.listActiveTasks()');
        assert(remainingActive.length === 0, 'The project mutation lease was not released after task completion.');

        return {
          dialog,
          nativeConfirmation,
          rendererDecision,
          restoreAttempt,
          projectHashPreserved: beforeHash,
          audit: audit.map((event) => ({ type: event.type, payload: event.payload })),
          activeTaskCountAfterCompletion: remainingActive.length,
        };
      });
    } else if (options.smoke) {
      await step('smoke-ipc', '隔离 IPC 与项目集成读取', async () => {
        const result = await instance.client.evaluate(`(async () => {
          const changes = await window.api.listFileChanges(${js(fixture.projectAlpha)});
          const mcp = typeof window.api.discoverMcp === 'function'
            ? await window.api.discoverMcp('acceptance-alpha', ${js(fixture.projectAlpha)}).catch((error) => ({ error: String(error) }))
            : null;
          const skills = typeof window.api.discoverSkills === 'function'
            ? await window.api.discoverSkills('acceptance-alpha', ${js(fixture.projectAlpha)}).catch((error) => ({ error: String(error) }))
            : null;
          return { changes, mcp, skills };
        })()`);
        assert(result.changes.some((change) => change.filePath.replace(/\\/g, '/') === 'src/sample.ts'), 'Git Diff IPC missed src/sample.ts.');
        return {
          changedFiles: result.changes.length,
          mcpServers: result.mcp?.servers?.length ?? null,
          skills: result.skills?.skills?.length ?? null,
          integrationErrors: [result.mcp?.error, result.skills?.error].filter(Boolean),
        };
      });
    } else {
      await step(2, '分别创建任务', async () => {
        await selectProject(instance.client, 'Acceptance Alpha', 'Bootstrap Alpha');
        state.alphaTask = await createTaskFromUi(instance.client, 'acceptance-alpha');
        await selectProject(instance.client, 'Acceptance Beta', 'Bootstrap Beta');
        state.betaTask = await createTaskFromUi(instance.client, 'acceptance-beta');
        assert(state.alphaTask.id !== state.betaTask.id, 'Task identities collided across projects.');
        return { alphaTaskId: state.alphaTask.id, betaTaskId: state.betaTask.id };
      });

      await step(3, '分别运行任务', async () => {
        await selectProject(instance.client, 'Acceptance Alpha', 'Bootstrap Alpha');
        await selectSession(instance.client, state.alphaTask.id);
        state.alphaDetail = await runTaskFromUi(instance.client, state.alphaTask.id, '验收 Alpha Timeline 与结果');
        await selectProject(instance.client, 'Acceptance Beta', 'Bootstrap Beta');
        await selectSession(instance.client, state.betaTask.id);
        state.betaDetail = await runTaskFromUi(instance.client, state.betaTask.id, '验收 Beta 后台任务');
        return {
          alpha: { id: state.alphaDetail.id, status: state.alphaDetail.status, claudeSessionId: state.alphaDetail.claudeSessionId },
          beta: { id: state.betaDetail.id, status: state.betaDetail.status, claudeSessionId: state.betaDetail.claudeSessionId },
        };
      });

      await step(4, '查看人类可读 Timeline', async () => {
        await selectProject(instance.client, 'Acceptance Alpha', 'Bootstrap Alpha');
        await selectSession(instance.client, state.alphaTask.id);
        const clicked = await clickControl(instance.client, ['工作记录']);
        assert(clicked, 'Work Timeline tab is unavailable.');
        await instance.client.waitFor(`document.querySelector('[data-task-status="completed"]') && document.querySelectorAll('[data-timeline-id]').length >= 3`, {
          description: 'completed Agent Timeline',
        });
        const timeline = await instance.client.evaluate(`(() => {
          const text = document.body.innerText;
          return {
            entries: Array.from(document.querySelectorAll('[data-timeline-id]')).map((element) => element.textContent.trim()),
            containsInternalLabels: ['system_init', 'assistant_text', 'tool_call'].some((label) => text.includes(label)),
          };
        })()`);
        assert(!timeline.containsInternalLabels, 'Timeline leaked internal protocol labels.');
        assert(timeline.entries.some((entry) => entry.includes('任务已启动')), 'Timeline omitted the task start step.');
        assert(timeline.entries.some((entry) => entry.includes('任务已完成')), 'Timeline omitted the task completion step.');
        return timeline;
      });

      await step(5, '查看 Monaco Diff', async () => {
        const opened = await clickControl(instance.client, ['文件改动', 'File Changes', '查看 Diff'], { exact: false });
        assert(opened, 'File Changes toolbar control is unavailable.');
        await instance.client.waitFor(`document.body.innerText.includes('src/sample.ts')`, {
          description: 'changed sample.ts in FileChangeViewer',
        });
        await instance.client.waitFor(`(() => {
          const drawer = document.querySelector('[data-testid="workspace-right-drawer"]');
          const refresh = Array.from(drawer?.querySelectorAll(':scope > header button') || [])
            .find((button) => button.hasAttribute('title') && button.querySelector('.lucide-refresh-cw'));
          return Boolean(refresh && !refresh.disabled && !refresh.querySelector('.animate-spin'));
        })()`, {
          description: 'settled workspace drawer refresh',
        });
        await new Promise((resolve) => setTimeout(resolve, 250));
        const selected = await instance.client.evaluate(`(() => {
          const row = Array.from(document.querySelectorAll('[data-testid="workspace-right-drawer"] button'))
            .find((button) => button.textContent.includes('src/sample.ts'));
          if (!row) return false;
          row.click();
          return true;
        })()`);
        assert(selected, 'Changed file src/sample.ts is not selectable.');
        await instance.client.waitFor(`(() => {
          const row = Array.from(document.querySelectorAll('[data-testid="workspace-right-drawer"] button'))
            .find((button) => button.textContent.includes('src/sample.ts'));
          return Boolean(row?.querySelector('.lucide-chevron-down'));
        })()`, {
          description: 'expanded sample.ts diff row',
        });
        await instance.client.waitFor(`document.querySelector('.monaco-diff-editor') || document.querySelector('.monaco-editor')`, {
          description: 'lazy Monaco Diff editor',
          timeoutMs: 30_000,
        });
        const diff = await instance.client.evaluate(`(async () => {
          const result = await window.api.getFileDiff('src/sample.ts', ${js(fixture.projectAlpha)});
          return {
            additions: result.additions,
            deletions: result.deletions,
            tooLarge: result.tooLarge,
            editors: document.querySelectorAll('.monaco-editor').length,
          };
        })()`);
        assert(diff.additions > 0 && diff.deletions > 0, 'Diff line statistics are incomplete.');
        assert(!diff.tooLarge, 'Small acceptance fixture was unexpectedly rejected as too large.');
        assert(diff.editors >= 2, `Expected a split Monaco Diff, found ${diff.editors} editor surface(s).`);
        return diff;
      });

      await step(6, '查看确定性结果总结卡', async () => {
        await instance.client.waitFor(`document.querySelector('[data-testid="task-result-card"]') && document.querySelector('[data-testid="task-result-metrics"]')`, {
          description: 'persisted task result card and metrics',
        });
        const card = await instance.client.evaluate(`(() => {
          const element = document.querySelector('[data-testid="task-result-card"]');
          return {
            text: element?.innerText,
            hasCopy: Array.from(element?.querySelectorAll('button') || []).some((button) => button.textContent.includes('复制')),
            hasExport: Array.from(element?.querySelectorAll('button') || []).some((button) => button.textContent.includes('导出 Markdown')),
          };
        })()`);
        assert(card.text.includes('任务结果'), 'Result card has no deterministic completion heading.');
        for (const label of ['修改', '行数', '测试', '权限', '模型', '测试命令']) {
          assert(card.text.includes(label), `Result card omitted ${label}.`);
        }
        assert(card.hasCopy && card.hasExport, 'Result card copy/export actions are incomplete.');
        const reports = await instance.client.evaluate(`Promise.all([
          window.api.getTaskReport(${js(state.alphaTask.id)}),
          window.api.getTaskReport(${js(state.alphaTask.id)}),
        ])`);
        assert(reports[0]?.markdown === reports[1]?.markdown, 'Task report is not deterministic across repeated reads.');
        for (const section of ['- 修改：', '- 新增：', '- 删除：', '- 耗时：', '- 模型：', '- Token：', '- 权限：', '## 测试', '## 修改文件']) {
          assert(reports[0].markdown.includes(section), `Markdown report omitted ${section}.`);
        }
        return { ...card, reportFileName: reports[0].fileName, deterministicMarkdown: true };
      });

      await step(7, '切换任务并保持项目隔离', async () => {
        await selectSession(instance.client, 'bootstrap-alpha');
        await instance.client.waitFor(`document.body.innerText.includes('Bootstrap Alpha')`, { description: 'bootstrap task selection' });
        await selectSession(instance.client, state.alphaTask.id);
        await instance.client.waitFor(`document.body.innerText.includes('验收 Alpha Timeline 与结果')`, { description: 'acceptance task reselection' });
        return { selectedInOrder: ['bootstrap-alpha', state.alphaTask.id] };
      });

      await step(8, '两个项目后台并行且同项目写锁生效', async () => runConcurrentTasks(instance.client, fixture));

      await step(9, '打开项目级 MCP 管理', async () => {
        const mcpConfigPath = path.join(fixture.projectAlpha, '.mcp.json');
        const configHashBefore = crypto.createHash('sha256').update(fs.readFileSync(mcpConfigPath)).digest('hex');
        const discovery = await instance.client.evaluate(`window.api.discoverMcp('acceptance-alpha', ${js(fixture.projectAlpha)})`);
        const server = discovery.servers.find((candidate) => candidate.name === 'acceptance_filesystem');
        assert(server, 'Project MCP fixture was not discovered.');
        assert(server.source === 'project', 'MCP source is not project-scoped.');
        assert(!JSON.stringify(server).includes('must-never-reach-the-renderer'), 'MCP secret reached the renderer.');
        await openIntegrationsPanel(instance.client);
        await instance.client.waitFor(`document.body.innerText.includes('acceptance_filesystem')`, {
          description: 'project MCP card',
        });
        const controls = await instance.client.evaluate(`(() => {
          const card = document.querySelector(${js(`[data-testid="mcp-server:${server.id}"]`)});
          return Array.from(card?.querySelectorAll('button') || []).map((button) => button.textContent.trim());
        })()`);
        assert(controls.includes('禁用') && controls.includes('测试配置'), 'MCP enable/disable or safe test control is missing.');
        await instance.client.evaluate(`(() => {
          const card = document.querySelector(${js(`[data-testid="mcp-server:${server.id}"]`)});
          Array.from(card?.querySelectorAll('button') || []).find((button) => button.textContent.trim() === '禁用')?.click();
        })()`);
        await instance.client.waitFor(`(async () => (await window.api.discoverMcp('acceptance-alpha', ${js(fixture.projectAlpha)})).servers.find((server) => server.name === 'acceptance_filesystem')?.status === 'disabled')()`, {
          description: 'project-local MCP disabled state',
        });
        await instance.client.waitFor(`document.querySelector(${js(`[data-testid="mcp-server:${server.id}"]`)})?.innerText.includes('已禁用')`, {
          description: 'disabled MCP status badge',
        });
        await instance.client.evaluate(`(() => {
          const card = document.querySelector(${js(`[data-testid="mcp-server:${server.id}"]`)});
          Array.from(card?.querySelectorAll('button') || []).find((button) => button.textContent.trim() === '启用')?.click();
        })()`);
        await instance.client.waitFor(`(async () => (await window.api.discoverMcp('acceptance-alpha', ${js(fixture.projectAlpha)})).servers.find((server) => server.name === 'acceptance_filesystem')?.status === 'configured')()`, {
          description: 'project-local MCP re-enabled state',
        });
        await instance.client.evaluate(`(() => {
          const card = document.querySelector(${js(`[data-testid="mcp-server:${server.id}"]`)});
          Array.from(card?.querySelectorAll('button') || []).find((button) => button.textContent.trim() === '测试配置')?.click();
        })()`);
        await instance.client.waitFor(`document.querySelector(${js(`[data-testid="mcp-server:${server.id}"]`)})?.innerText.includes('不会执行 MCP 命令')`, {
          description: 'safe MCP configuration probe',
        });
        const configHashAfter = crypto.createHash('sha256').update(fs.readFileSync(mcpConfigPath)).digest('hex');
        assert(configHashAfter === configHashBefore, 'MCP controls modified the project .mcp.json file.');
        state.mcp = server;
        return {
          name: server.name,
          source: server.source,
          status: server.status,
          controls,
          safeProbe: true,
          configFileUnchanged: true,
          envRedacted: Object.values(server.redactedEnv).every((value) => value !== 'must-never-reach-the-renderer'),
        };
      });

      await step(10, '打开并只读查看 Skills', async () => {
        const projectSkillPath = path.join(fixture.projectAlpha, '.claude', 'skills', 'acceptance-project-skill', 'SKILL.md');
        const skillHashBefore = crypto.createHash('sha256').update(fs.readFileSync(projectSkillPath)).digest('hex');
        const discovery = await instance.client.evaluate(`window.api.discoverSkills('acceptance-alpha', ${js(fixture.projectAlpha)})`);
        const projectSkill = discovery.skills.find((candidate) => candidate.name === 'acceptance-project-skill');
        const userSkill = discovery.skills.find((candidate) => candidate.name === 'acceptance-user-skill');
        assert(projectSkill && userSkill, 'Project/user Skill sources were not both discovered in the isolated home.');
        const clicked = await clickControl(instance.client, ['Skills'], {
          exact: false,
          selector: '[data-testid="integrations-panel"] button',
        });
        assert(clicked, 'Skills tab is unavailable in IntegrationsPanel.');
        await instance.client.waitFor(`document.body.innerText.includes('acceptance-project-skill') && document.body.innerText.includes('acceptance-user-skill')`, {
          description: 'isolated project and user Skills',
        });
        const viewer = await instance.client.evaluate(`(() => {
          const card = document.querySelector(${js(`[data-testid="skill:${projectSkill.id}"]`)});
          const button = Array.from(card?.querySelectorAll('button') || []).find((candidate) => candidate.textContent.includes('只读查看'));
          if (!button) return false;
          button.click();
          return true;
        })()`);
        assert(viewer, 'Read-only Skill action is unavailable.');
        await instance.client.waitFor(`document.querySelector('[data-testid="skill-readonly-viewer"]')?.innerText.includes('This document is read-only')`, {
          description: 'read-only SKILL.md viewer',
        });
        const skillHashAfter = crypto.createHash('sha256').update(fs.readFileSync(projectSkillPath)).digest('hex');
        assert(skillHashAfter === skillHashBefore, 'Read-only Skill viewer modified SKILL.md.');
        return {
          projectSkill: { name: projectSkill.name, source: projectSkill.source },
          userSkill: { name: userSkill.name, source: userSkill.source },
          viewerReadOnly: true,
          skillFileUnchanged: true,
        };
      });

      await step(11, 'Ctrl+Shift+P 打开命令面板', async () => {
        await clickControl(instance.client, ['关闭 Skill 内容', '关闭集成管理'], { exact: false });
        await clickControl(instance.client, ['关闭集成管理'], { exact: false });
        await instance.client.dispatchShortcut({ key: 'P', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 2 | 8 });
        await instance.client.waitFor(`document.querySelector('[data-testid="command-palette-backdrop"]') && document.querySelector('[aria-label="命令面板"]')`, {
          description: 'Ctrl+Shift+P command palette',
        });
        const palette = await instance.client.evaluate(`(() => ({
          options: document.querySelectorAll('[role="option"]').length,
          titles: Array.from(document.querySelectorAll('[role="option"]')).map((element) => element.textContent.trim()).slice(0, 20),
          focused: document.activeElement?.tagName === 'INPUT',
        }))()`);
        assert(palette.options >= 8, `Command palette exposes only ${palette.options} commands.`);
        assert(palette.focused, 'Command palette search input is not focused.');
        await instance.client.send('Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
        });
        await instance.client.send('Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
        });
        return palette;
      });

      await step('phase5-1', '真实 Git status 与 Git 面板', async () => {
        state.phase5 = await runPhaseFiveMutationTask(instance.client, fixture);
        const status = await instance.client.evaluate(`window.api.getGitWorkspaceStatus('acceptance-alpha', ${js(fixture.projectAlpha)})`);
        const paths = status.files.map((file) => file.filePath);
        for (const expected of [
          'src/sample.ts',
          'src/phase5-user-owned.ts',
          'src/phase5-task-target.ts',
          'src/phase5-ai-created.ts',
        ]) assert(paths.includes(expected), `Git status omitted ${expected}.`);
        assert(status.head === gitHead(fixture.projectAlpha), 'Renderer Git HEAD differs from the real repository.');
        assert(status.files.find((file) => file.filePath === 'src/phase5-ai-created.ts')?.untracked, 'AI-created file is not classified as untracked.');

        await clickTaskGitAction(instance.client, 2);
        await instance.client.waitFor(`document.querySelector('[data-testid="workspace-right-drawer"]')`, {
          description: 'Phase 5 workspace drawer',
        });
        await clickDrawerTab(instance.client, 'Git');
        await instance.client.waitFor(`document.querySelector('[data-testid="git-change-list"]')?.innerText.includes('src/phase5-task-target.ts')
          && document.querySelector('[data-testid="git-change-list"]')?.innerText.includes('src/phase5-ai-created.ts')`, {
          description: 'Phase 5 Git change list',
        });
        const panel = await instance.client.evaluate(`(() => ({
          text: document.querySelector('[data-testid="workspace-right-drawer"]')?.innerText,
          rows: document.querySelectorAll('[data-testid="git-change-list"] button').length,
        }))()`);
        return {
          branch: status.branch,
          head: status.head,
          files: status.files.map((file) => ({
            filePath: file.filePath,
            changeType: file.changeType,
            staged: file.staged,
            unstaged: file.unstaged,
            additions: file.additions,
            deletions: file.deletions,
          })),
          hostPorcelain: git(fixture.projectAlpha, ['status', '--porcelain=v1', '--untracked-files=all']),
          uiRows: panel.rows,
        };
      });

      await step('phase5-2', '真实 Git diff 与 Monaco 联动', async () => {
        const diffs = await instance.client.evaluate(`window.api.getGitWorkspaceDiff(
          'acceptance-alpha',
          ${js(fixture.projectAlpha)},
          { filePaths: ['src/phase5-task-target.ts', 'src/phase5-ai-created.ts'] }
        )`);
        const tracked = diffs.find((diff) => diff.filePath === 'src/phase5-task-target.ts');
        const created = diffs.find((diff) => diff.filePath === 'src/phase5-ai-created.ts');
        assert(tracked?.patch?.includes("AI checkpoint implementation"), 'Tracked Git patch omitted the AI change.');
        assert(created?.patch?.includes('--- /dev/null'), 'Untracked Git patch omitted the empty baseline.');
        assert(!tracked.tooLarge && !created.tooLarge && !tracked.isBinary && !created.isBinary, 'Small Phase 5 diff was unexpectedly protected.');
        const opened = await instance.client.evaluate(`(() => {
          const row = Array.from(document.querySelectorAll('[data-testid="git-change-list"] button'))
            .find((button) => button.textContent.includes('src/phase5-task-target.ts'));
          if (!row) return false;
          row.click();
          return true;
        })()`);
        assert(opened, 'Phase 5 tracked Git row is not selectable.');
        await instance.client.waitFor(`document.querySelector('.monaco-diff-editor') || document.querySelector('.monaco-editor')`, {
          description: 'Phase 5 Monaco diff',
          timeoutMs: 30_000,
        });
        const switched = await instance.client.evaluate(`(() => {
          const row = Array.from(document.querySelectorAll('[data-testid="workspace-right-drawer"] button'))
            .find((button) => button.textContent.includes('src/phase5-ai-created.ts'));
          if (!row) return false;
          row.click();
          return true;
        })()`);
        assert(switched, 'Phase 5 AI-created file is not selectable from the Files diff list.');
        await instance.client.waitFor(`(() => {
          const row = Array.from(document.querySelectorAll('[data-testid="workspace-right-drawer"] button'))
            .find((button) => button.textContent.includes('src/phase5-ai-created.ts'));
          return Boolean(row?.querySelector('.lucide-chevron-down') && document.querySelector('.monaco-diff-editor'));
        })()`, {
          description: 'second Phase 5 Monaco diff after file switch',
          timeoutMs: 30_000,
        });
        return {
          diffs: diffs.map((diff) => ({
            filePath: diff.filePath,
            additions: diff.additions,
            deletions: diff.deletions,
            isBinary: diff.isBinary,
            tooLarge: diff.tooLarge,
            omittedReason: diff.omittedReason,
            patchHash: crypto.createHash('sha256').update(diff.patch ?? '').digest('hex'),
          })),
          monacoEditors: await instance.client.evaluate(`document.querySelectorAll('.monaco-editor').length`),
          switchedFiles: ['src/phase5-task-target.ts', 'src/phase5-ai-created.ts'],
        };
      });

      await step('phase5-3', '自动 before_task 与 task_completed Checkpoint', async () => {
        const checkpoints = await instance.client.evaluate(`window.api.listCheckpoints(${js(state.phase5.task.id)})`);
        const baseline = checkpoints.find((checkpoint) => checkpoint.type === 'before_task');
        const completed = checkpoints.find((checkpoint) => checkpoint.type === 'task_completed');
        assert(baseline && completed, 'Automatic before_task/task_completed checkpoints are incomplete.');
        const baselinePaths = baseline.metadata.baselineFiles.map((file) => file.filePath);
        assert(baselinePaths.includes('src/phase5-user-owned.ts'), 'before_task did not capture the user dirty baseline.');
        assert(!baselinePaths.includes('src/phase5-task-target.ts'), 'before_task incorrectly included the later AI tracked change.');
        assert(!baselinePaths.includes('src/phase5-ai-created.ts'), 'before_task incorrectly included the later AI-created file.');
        const eventPage = await instance.client.evaluate(`window.api.listTaskEvents(${js(state.phase5.task.id)}, { limit: 500, offset: 0 })`);
        const checkpointEvents = eventPage.items.filter((event) => event.type === 'git_checkpoint_created');
        assert(checkpointEvents.length >= 2, 'Automatic checkpoint timeline events were not persisted.');
        state.phase5.baseline = baseline;
        return {
          checkpointTypes: checkpoints.map((checkpoint) => checkpoint.type),
          beforeTaskId: baseline.id,
          completedId: completed.id,
          baselineFiles: baselinePaths,
          timelineCheckpointEvents: checkpointEvents.length,
        };
      });

      await step('phase5-4', '通过 UI 创建手动 Checkpoint', async () => {
        await clickDrawerTab(instance.client, 'Checkpoint');
        const before = await instance.client.evaluate(`window.api.listCheckpoints(${js(state.phase5.task.id)})`);
        const clicked = await instance.client.evaluate(`(() => {
          const list = document.querySelector('[data-testid="checkpoint-list"]');
          const button = Array.from(list?.parentElement?.children || [])
            .find((element) => element.tagName === 'BUTTON');
          if (!button) return false;
          button.click();
          return true;
        })()`);
        assert(clicked, 'Manual Checkpoint UI control is unavailable.');
        await instance.client.waitFor(`(async () => (await window.api.listCheckpoints(${js(state.phase5.task.id)})).length === ${before.length + 1})()`, {
          description: 'manual Phase 5 checkpoint',
          timeoutMs: 30_000,
        });
        const after = await instance.client.evaluate(`window.api.listCheckpoints(${js(state.phase5.task.id)})`);
        const created = after.find((checkpoint) => !before.some((candidate) => candidate.id === checkpoint.id));
        assert(created?.type === 'manual' && created.metadata.reason === 'user_created', 'Manual Checkpoint has the wrong type or reason.');
        await instance.client.waitFor(`document.querySelectorAll('[data-testid="checkpoint-list"] article').length >= ${after.length}`, {
          description: 'manual checkpoint in UI list',
        });
        return { beforeCount: before.length, afterCount: after.length, checkpoint: created };
      });

      await step('phase5-5', '恢复二次确认与取消保持零变化', async () => {
        const impact = await instance.client.evaluate(`window.api.previewCheckpointRestore(${js(state.phase5.baseline.id)})`);
        assert(impact.restoreFiles.includes('src/phase5-task-target.ts'), `Restore preview omitted the tracked task file: ${JSON.stringify(impact)}`);
        assert(impact.deleteFiles.includes('src/phase5-ai-created.ts'), `Restore preview omitted the AI-created file deletion: ${JSON.stringify(impact)}`);
        assert(impact.preservedUserFiles.includes('src/phase5-user-owned.ts'), `Restore preview omitted user-file preservation evidence: ${JSON.stringify(impact)}`);
        const beforeState = phaseFileState(fixture, state.phase5.aiNewPath);
        const checkpointCount = (await instance.client.evaluate(`window.api.listCheckpoints(${js(state.phase5.task.id)})`)).length;
        await clickTaskGitAction(instance.client, 1);
        await instance.client.waitFor(`document.querySelector('[data-testid="checkpoint-restore-dialog"]')`, {
          description: 'restore confirmation dialog',
        });
        const dialog = await instance.client.evaluate(`(() => ({
          text: document.querySelector('[data-testid="checkpoint-restore-dialog"]')?.innerText,
          buttons: document.querySelectorAll('[data-testid="checkpoint-restore-dialog"] button').length,
        }))()`);
        assert(dialog.buttons === 2, 'Restore dialog does not expose explicit cancel/confirm choices.');
        await instance.client.evaluate(`document.querySelectorAll('[data-testid="checkpoint-restore-dialog"] button')[0].click()`);
        await instance.client.waitFor(`!document.querySelector('[data-testid="checkpoint-restore-dialog"]')`, {
          description: 'cancelled restore dialog',
        });
        const afterState = phaseFileState(fixture, state.phase5.aiNewPath);
        assert(JSON.stringify(afterState) === JSON.stringify(beforeState), 'Cancelling restore changed Git HEAD or file bytes.');
        const afterCheckpointCount = (await instance.client.evaluate(`window.api.listCheckpoints(${js(state.phase5.task.id)})`)).length;
        assert(afterCheckpointCount === checkpointCount, 'Cancelling restore unexpectedly created a checkpoint.');
        state.phase5.restoreImpact = impact;
        return {
          restoreFiles: impact.restoreFiles,
          deleteFiles: impact.deleteFiles,
          preservedUserFiles: impact.preservedUserFiles,
          blockedFiles: impact.blockedFiles,
          dialogButtons: dialog.buttons,
          stateHashBefore: crypto.createHash('sha256').update(JSON.stringify(beforeState)).digest('hex'),
          stateHashAfter: crypto.createHash('sha256').update(JSON.stringify(afterState)).digest('hex'),
          checkpointCountUnchanged: true,
        };
      });

      await step('phase5-6', '确认后恢复 tracked 文件', async () => {
        await clickTaskGitAction(instance.client, 1);
        await instance.client.waitFor(`document.querySelector('[data-testid="checkpoint-restore-dialog"]')`, {
          description: 'second restore confirmation dialog',
        });
        const confirmEnabled = await instance.client.evaluate(`!document.querySelectorAll('[data-testid="checkpoint-restore-dialog"] button')[1].disabled`);
        assert(confirmEnabled, 'Restore confirmation is unexpectedly disabled.');
        await instance.client.evaluate(`document.querySelectorAll('[data-testid="checkpoint-restore-dialog"] button')[1].click()`);
        await instance.client.waitFor(`!document.querySelector('[data-testid="checkpoint-restore-dialog"]')`, {
          description: 'confirmed restore dialog dismissal',
          timeoutMs: 30_000,
        });
        await instance.client.waitFor(`(async () => {
          const status = await window.api.getGitWorkspaceStatus('acceptance-alpha', ${js(fixture.projectAlpha)});
          const paths = status.files.map((file) => file.filePath);
          return !paths.includes('src/phase5-task-target.ts') && !paths.includes('src/phase5-ai-created.ts');
        })()`, {
          description: 'confirmed restore filesystem completion',
          timeoutMs: 30_000,
        });
        const restored = fs.readFileSync(fixture.alphaGit.taskTargetPath, 'utf8');
        assert(restored === state.phase5.taskTargetBefore, 'Tracked task file was not restored to its before-task bytes.');
        const checkpoints = await instance.client.evaluate(`window.api.listCheckpoints(${js(state.phase5.task.id)})`);
        const rollback = checkpoints.find((checkpoint) => checkpoint.type === 'manual' && checkpoint.metadata.reason === 'before_restore');
        assert(rollback, 'Restore did not create a rollback checkpoint.');
        return {
          trackedPath: 'src/phase5-task-target.ts',
          restoredHash: hashFile(fixture.alphaGit.taskTargetPath),
          expectedHash: crypto.createHash('sha256').update(state.phase5.taskTargetBefore).digest('hex'),
          rollbackCheckpointId: rollback.id,
        };
      });

      await step('phase5-7', '删除 AI 新文件并保留用户既有修改', async () => {
        assert(!fs.existsSync(state.phase5.aiNewPath), 'Confirmed restore did not delete the AI-created file.');
        assert(hashFile(fixture.alphaGit.userOwnedPath) === state.phase5.userOwnedHash, 'Restore overwrote the user dirty file.');
        assert(hashFile(fixture.alphaGit.sourcePath) === state.phase5.sampleHash, 'Restore overwrote an unrelated pre-existing modification.');
        const status = await instance.client.evaluate(`window.api.getGitWorkspaceStatus('acceptance-alpha', ${js(fixture.projectAlpha)})`);
        const paths = status.files.map((file) => file.filePath);
        assert(paths.includes('src/phase5-user-owned.ts') && paths.includes('src/sample.ts'), 'Preserved user changes disappeared from Git status.');
        assert(!paths.includes('src/phase5-task-target.ts') && !paths.includes('src/phase5-ai-created.ts'), 'Task changes remain after confirmed restore.');
        return {
          aiCreatedFileDeleted: true,
          preservedHashes: {
            userOwned: state.phase5.userOwnedHash,
            sample: state.phase5.sampleHash,
          },
          remainingGitFiles: paths,
        };
      });

      await step('phase5-8', '重新应用任务修改并接受 Changes', async () => {
        fs.writeFileSync(fixture.alphaGit.taskTargetPath, state.phase5.taskTargetAfter, 'utf8');
        fs.writeFileSync(state.phase5.aiNewPath, state.phase5.aiNewContent, 'utf8');
        await clickTaskGitAction(instance.client, 0);
        await instance.client.waitFor(`document.querySelector('[data-testid="commit-preview"]')`, {
          description: 'accepted task commit preview',
          timeoutMs: 30_000,
        });
        const checkpoints = await instance.client.evaluate(`window.api.listCheckpoints(${js(state.phase5.task.id)})`);
        const accepted = checkpoints.find((checkpoint) => checkpoint.type === 'accepted');
        assert(accepted?.metadata.reason === 'user_accepted', 'Accept did not create an accepted checkpoint.');
        const preview = await instance.client.evaluate(`window.api.createCommitPreview(${js(state.phase5.task.id)})`);
        assert(JSON.stringify([...preview.files].sort()) === JSON.stringify(['src/phase5-ai-created.ts', 'src/phase5-task-target.ts']), 'Accept preview includes non-task files.');
        state.phase5.accepted = accepted;
        state.phase5.preview = preview;
        return {
          acceptedCheckpointId: accepted.id,
          acceptedReason: accepted.metadata.reason,
          preview,
          userFilesStillDirty: git(fixture.projectAlpha, ['status', '--porcelain=v1', '--untracked-files=all'])
            .includes('src/phase5-user-owned.ts'),
        };
      });

      await step('phase5-9', '确定性 Conventional Commit Preview', async () => {
        const previews = await instance.client.evaluate(`Promise.all([
          window.api.createCommitPreview(${js(state.phase5.task.id)}),
          window.api.createCommitPreview(${js(state.phase5.task.id)}),
          window.api.createCommitPreview(${js(state.phase5.task.id)})
        ])`);
        assert(JSON.stringify(previews[0]) === JSON.stringify(previews[1])
          && JSON.stringify(previews[1]) === JSON.stringify(previews[2]), 'Commit Preview changed across repeated reads.');
        assert(/^[a-z]+(?:\([a-z0-9-]+\))?: [^\r\n]+$/u.test(previews[0].subject), `Commit Preview is not conventional: ${previews[0].subject}`);
        const uiSubject = await instance.client.evaluate(`document.querySelector('[data-testid="commit-preview"] code')?.textContent`);
        assert(uiSubject === previews[0].subject, 'UI Commit Preview differs from the production service result.');
        assert(!JSON.stringify(previews[0]).toLowerCase().includes('model'), 'Commit Preview unexpectedly contains model metadata.');
        state.phase5.preview = previews[0];
        return { preview: previews[0], repeatedReads: 3, uiMatchesService: true };
      });

      await step('phase5-10', '未确认与取消均不创建 Commit', async () => {
        const headBefore = gitHead(fixture.projectAlpha);
        const countBefore = Number(git(fixture.projectAlpha, ['rev-list', '--count', 'HEAD']));
        const opened = await instance.client.evaluate(`(() => {
          const button = document.querySelectorAll('[data-testid="commit-preview"] button')[1];
          if (!button) return false;
          button.click();
          return true;
        })()`);
        assert(opened, 'Create Commit preview action is unavailable.');
        await instance.client.waitFor(`document.querySelector('[data-testid="commit-confirm-dialog"]')`, {
          description: 'commit confirmation dialog',
        });
        assert(gitHead(fixture.projectAlpha) === headBefore, 'Opening commit confirmation changed HEAD.');
        await instance.client.evaluate(`document.querySelectorAll('[data-testid="commit-confirm-dialog"] button')[0].click()`);
        await instance.client.waitFor(`!document.querySelector('[data-testid="commit-confirm-dialog"]')`, {
          description: 'cancelled commit dialog',
        });
        const rejection = await instance.client.evaluate(`(async () => {
          try {
            await window.api.commitTaskChanges(${js(state.phase5.task.id)}, ${js(state.phase5.preview.subject)}, false);
            return null;
          } catch (error) {
            return String(error?.message || error);
          }
        })()`);
        assert(rejection && /confirmation|确认/iu.test(rejection), 'Unconfirmed commit IPC was not rejected.');
        assert(gitHead(fixture.projectAlpha) === headBefore, 'Cancelled/unconfirmed commit changed HEAD.');
        assert(Number(git(fixture.projectAlpha, ['rev-list', '--count', 'HEAD'])) === countBefore, 'Cancelled/unconfirmed commit changed commit count.');
        return { headBefore, countBefore, uiCancelled: true, ipcRejected: rejection };
      });

      await step('phase5-11', '确认后只提交任务文件', async () => {
        const parent = gitHead(fixture.projectAlpha);
        const opened = await instance.client.evaluate(`(() => {
          const button = document.querySelectorAll('[data-testid="commit-preview"] button')[1];
          if (!button) return false;
          button.click();
          return true;
        })()`);
        assert(opened, 'Confirmed commit action is unavailable.');
        await instance.client.waitFor(`document.querySelector('[data-testid="commit-confirm-dialog"]')`, {
          description: 'final commit confirmation dialog',
        });
        await instance.client.evaluate(`document.querySelectorAll('[data-testid="commit-confirm-dialog"] button')[1].click()`);
        await instance.client.waitFor(`(async () => (await window.api.getGitWorkspaceStatus('acceptance-alpha', ${js(fixture.projectAlpha)})).head !== ${js(parent)})()`, {
          description: 'confirmed task-only commit',
          timeoutMs: 30_000,
        });
        const commit = gitHead(fixture.projectAlpha);
        const subject = git(fixture.projectAlpha, ['log', '-1', '--pretty=%s']);
        const files = git(fixture.projectAlpha, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])
          .split(/\r?\n/u).filter(Boolean).sort();
        assert(git(fixture.projectAlpha, ['rev-parse', 'HEAD^']) === parent, 'Confirmed commit parent differs from the previewed HEAD.');
        assert(subject === state.phase5.preview.subject, 'Confirmed commit subject differs from Commit Preview.');
        assert(JSON.stringify(files) === JSON.stringify(['src/phase5-ai-created.ts', 'src/phase5-task-target.ts']), `Commit included non-task files: ${files.join(', ')}`);
        assert(hashFile(fixture.alphaGit.userOwnedPath) === state.phase5.userOwnedHash, 'Commit changed the user dirty file bytes.');
        assert(hashFile(fixture.alphaGit.sourcePath) === state.phase5.sampleHash, 'Commit changed an unrelated user file.');
        const remaining = git(fixture.projectAlpha, ['status', '--porcelain=v1', '--untracked-files=all']);
        assert(remaining.includes('src/phase5-user-owned.ts') && remaining.includes('src/sample.ts'), 'Task-only commit did not preserve user working-tree changes.');
        assert(!remaining.includes('src/phase5-task-target.ts') && !remaining.includes('src/phase5-ai-created.ts'), 'Committed task files remain dirty.');
        state.phase5.commit = { commit, subject, files };
        state.phase5.checkpointsBeforeRestart = await instance.client.evaluate(`window.api.listCheckpoints(${js(state.phase5.task.id)})`);
        return {
          parent,
          commit,
          subject,
          files,
          remainingPorcelain: remaining,
          preservedUserHashes: {
            userOwned: state.phase5.userOwnedHash,
            sample: state.phase5.sampleHash,
          },
        };
      });
    }

    const beforeRestart = await instance.client.evaluate(`(async () => {
      const projects = await window.api.listProjects();
      const sessionCounts = {};
      for (const project of projects) sessionCounts[project.id] = (await window.api.listSessions(project.id)).length;
      return { projects: projects.map((project) => project.id), sessionCounts };
    })()`);
    report.rendererErrors.push(...instance.rendererErrors);
    assert(instance.rendererErrors.length === 0, `Renderer emitted errors: ${instance.rendererErrors.join(' | ')}`);
    await stopElectron(instance);
    report.cleanup.processStopped = true;
    instance = null;

    const databasePath = path.join(fixture.dataRoot, 'claude-workbench.db');
    const sqliteBeforeRestart = verifySqlite(databasePath);
    const phaseFiveBeforeRestart = options.smoke || options.security
      ? null
      : verifyPhaseFivePersistence(databasePath, fixture, state);
    await step(12, '重启应用并确认数据保留', async () => {
      instance = await launchElectron(fixture);
      const afterRestart = await instance.client.evaluate(`(async () => {
        const projects = await window.api.listProjects();
        const sessionCounts = {};
        for (const project of projects) sessionCounts[project.id] = (await window.api.listSessions(project.id)).length;
        return { projects: projects.map((project) => project.id), sessionCounts };
      })()`);
      assert(JSON.stringify(afterRestart.projects.sort()) === JSON.stringify(beforeRestart.projects.sort()), 'Project identities changed after restart.');
      for (const [projectId, count] of Object.entries(beforeRestart.sessionCounts)) {
        assert(afterRestart.sessionCounts[projectId] === count, `Session count changed after restart for ${projectId}.`);
      }
      await instance.client.waitFor(`document.body.innerText.includes('Acceptance Alpha') && document.body.innerText.includes('Acceptance Beta')`, {
        description: 'persisted projects after restart',
      });
      const sqliteAfterRestart = verifySqlite(path.join(fixture.dataRoot, 'claude-workbench.db'));
      return { beforeRestart, afterRestart, sqliteBeforeRestart, sqliteAfterRestart };
    });
    if (!options.smoke && !options.security) {
      await step('phase5-12', '重启后 SQLite v2、FK、Snapshot 与 Commit 一致', async () => {
        const phaseFiveAfterRestart = verifyPhaseFivePersistence(databasePath, fixture, state);
        const checkpoints = await instance.client.evaluate(`window.api.listCheckpoints(${js(state.phase5.task.id)})`);
        const beforeIds = state.phase5.checkpointsBeforeRestart.map((checkpoint) => checkpoint.id).sort();
        const afterIds = checkpoints.map((checkpoint) => checkpoint.id).sort();
        assert(JSON.stringify(afterIds) === JSON.stringify(beforeIds), 'Checkpoint identities changed after restart.');
        const status = await instance.client.evaluate(`window.api.getGitWorkspaceStatus('acceptance-alpha', ${js(fixture.projectAlpha)})`);
        assert(status.head === state.phase5.commit.commit, 'Restarted Git status lost the confirmed commit HEAD.');

        await selectProject(instance.client, 'Acceptance Alpha', 'Bootstrap Alpha');
        await selectSession(instance.client, state.phase5.task.id);
        const workTab = await clickControl(instance.client, ['工作记录']);
        assert(workTab, 'Restarted Phase 5 task has no Work Timeline tab.');
        await instance.client.waitFor(`document.querySelector('[data-testid="task-result-card"]')`, {
          description: 'restarted Phase 5 task result',
        });
        const persistedSessionStatus = await instance.client.evaluate(`(() => {
          const session = document.querySelector(${js(`[data-session-key$="::${state.phase5.task.id}"]`)});
          return { text: session?.textContent?.trim(), title: session?.getAttribute('title') };
        })()`);
        assert(`${persistedSessionStatus.title} ${persistedSessionStatus.text}`.includes('已完成'),
          `Restarted Phase 5 task was hydrated as non-terminal: ${JSON.stringify(persistedSessionStatus)}`);
        await clickTaskGitAction(instance.client, 2);
        await instance.client.waitFor(`document.querySelector('[data-testid="workspace-right-drawer"]')`, {
          description: 'restarted workspace drawer',
        });
        await clickDrawerTab(instance.client, 'Checkpoint');
        await instance.client.waitFor(`document.querySelectorAll('[data-testid="checkpoint-list"] article').length === ${checkpoints.length}`, {
          description: 'persisted checkpoint UI list',
          timeoutMs: 30_000,
        });
        return {
          beforeRestart: phaseFiveBeforeRestart,
          afterRestart: phaseFiveAfterRestart,
          apiCheckpointCount: checkpoints.length,
          uiCheckpointCount: await instance.client.evaluate(`document.querySelectorAll('[data-testid="checkpoint-list"] article').length`),
          persistedSessionStatus,
          gitHead: status.head,
          remainingFiles: status.files.map((file) => file.filePath),
        };
      });
    }
    report.rendererErrors.push(...instance.rendererErrors);
    assert(instance.rendererErrors.length === 0, `Restarted renderer emitted errors: ${instance.rendererErrors.join(' | ')}`);
  } catch (error) {
    failed = error;
    report.error = error instanceof Error ? error.message : String(error);
    if (instance) {
      try {
        report.failureControls = await controlInventory(instance.client);
        report.failureBodyTail = (await instance.client.evaluate('document.body.innerText')).slice(-4_000);
      } catch { /* the renderer may already be gone */ }
      report.rendererErrors.push(...(instance.rendererErrors ?? []));
      report.electronLogTail = [...instance.stderr, ...instance.stdout]
        .join('')
        .trim()
        .split(/\r?\n/)
        .slice(-40);
    }
  } finally {
    if (instance) {
      await stopElectron(instance);
      report.cleanup.processStopped = true;
      instance = null;
    }
    report.completedAt = new Date().toISOString();
    report.status = failed ? 'failed' : 'passed';
    if (options.keepTemp) {
      report.cleanup.tempPath = fixture.root;
      console.log(`[cleanup] Kept isolated fixture by request: ${fixture.root}`);
    } else {
      safeRemoveFixture(fixture.root);
      report.cleanup.tempRemoved = true;
    }
    if (options.reportPath) {
      fs.mkdirSync(path.dirname(options.reportPath), { recursive: true });
      fs.writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
  }

  console.log(`ELECTRON_ACCEPTANCE_RESULT=${JSON.stringify(report)}`);
  if (failed) throw failed;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
