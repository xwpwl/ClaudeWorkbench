import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import electron from 'electron';
import { CdpClient, waitForCdpPage } from './lib/cdp-client.mjs';

const TEMP_PREFIX = 'claude-workbench-model-provider-acceptance-';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(SCRIPT_DIR, '..');
const PROJECT_ID = 'model-provider-acceptance-project';
const TASK_ID = 'model-provider-acceptance-task';
const PROJECT_NAME = 'Model Provider Acceptance Project';
const MIMO_NAME = 'MiMo';
const MIMO_MODEL = 'mimo-v2.5-pro';
const MIMO_FAST_MODEL = 'mimo-v2.5-fast';
const MIMO_REVIEW_MODEL = 'mimo-v2.5-review';
const DEEPSEEK_NAME = 'DeepSeek';
const DEEPSEEK_MODEL = 'deepseek-chat';
const UNSUPPORTED_RUNTIME_MESSAGE = '当前 Provider 不支持 Claude Code Agent Runtime';
const PROVIDER_RUNTIME_NOT_RUNNABLE_MESSAGE =
  '当前 Provider 可以管理和测试，但尚不能用于 Claude Code Agent。请选择支持 Claude Code Runtime 的 Provider。';
const FUTURE_CALLS_WARNING = '模型改变只影响后续 Agent 调用。';
const RUNNING_SWITCH_WARNING = '正在运行任务时禁止切换模型。';
const REPORT_DEFAULT = path.join(WORKSPACE_ROOT, 'dist', 'model-provider-acceptance-report.json');
const SCREENSHOTS_DEFAULT = path.join(WORKSPACE_ROOT, 'dist', 'model-provider-acceptance-screenshots');
const STEP_TIMEOUT_MS = 30_000;
const NATIVE_DIALOG_POLL_INTERVAL_MS = 100;
const NATIVE_DIALOG_FIND_ATTEMPTS = 160;
const NATIVE_DIALOG_BUTTON_CLOSE_ATTEMPTS = 60;
const NATIVE_DIALOG_COMMAND_CLOSE_ATTEMPTS = 100;
const NATIVE_DIALOG_CLEANUP_MARGIN_MS = 5_000;
const NATIVE_DIALOG_CHILD_TIMEOUT_MS = 40_000;
const NATIVE_DIALOG_EXPORT_TIMEOUT_MS = 45_000;
const DIAGNOSTICS_ARCHIVE_NAME_PATTERN = /^ClaudeWorkbench-diagnostics-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.zip$/u;

function parseArguments(argv) {
  const options = {
    build: true,
    keepTemp: false,
    reportPath: REPORT_DEFAULT,
    screenshotsPath: SCREENSHOTS_DEFAULT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--skip-build') options.build = false;
    else if (argument === '--keep-temp') options.keepTemp = true;
    else if (argument === '--report') {
      const value = argv[index + 1];
      if (!value) throw new Error('--report requires a file path.');
      options.reportPath = path.resolve(argv[++index]);
    } else if (argument === '--screenshots') {
      const value = argv[index + 1];
      if (!value) throw new Error('--screenshots requires a directory path.');
      options.screenshotsPath = path.resolve(argv[++index]);
    } else if (argument === '--help') {
      console.log([
        'Usage: node scripts/electron-model-provider-acceptance.mjs [options]',
        '',
        '  --skip-build          Reuse current production dist/ output.',
        '  --report <path>       Write machine-readable JSON evidence.',
        '  --screenshots <dir>   Write production Renderer screenshots.',
        '  --keep-temp           Keep the isolated profile for diagnosis.',
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

function js(value) {
  return JSON.stringify(value).replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');
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

function runNpm(args) {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
  const npmCli = candidates.find((candidate) => fs.existsSync(candidate));
  if (!npmCli) throw new Error('Unable to locate npm-cli.js without invoking a command shell.');
  return runChecked(process.execPath, [npmCli, ...args], { inherit: true });
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function snapshotFile(filePath) {
  const bytes = fs.readFileSync(filePath);
  const stat = fs.statSync(filePath);
  return {
    path: path.relative(WORKSPACE_ROOT, filePath).replace(/\\/gu, '/'),
    sha256: sha256(bytes),
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

function assertBuildOutputs() {
  const required = [
    path.join(WORKSPACE_ROOT, 'dist', 'main', 'index.js'),
    path.join(WORKSPACE_ROOT, 'dist', 'preload', 'index.js'),
    path.join(WORKSPACE_ROOT, 'dist', 'renderer', 'index.html'),
  ];
  for (const output of required) assert(fs.existsSync(output), `Production build output is missing: ${output}`);
  const outputs = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) outputs.push(entryPath);
    }
  };
  for (const directory of ['main', 'preload', 'renderer']) {
    visit(path.join(WORKSPACE_ROOT, 'dist', directory));
  }
  return outputs.sort().map(snapshotFile);
}

function assertNativeDialogProfile() {
  const userProfile = path.resolve(process.env.USERPROFILE ?? os.homedir());
  assert(fs.existsSync(userProfile), `Windows user profile is unavailable: ${userProfile}`);
  assert(fs.statSync(userProfile).isDirectory(), `Windows user profile is not a directory: ${userProfile}`);
  return userProfile;
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
    const nativeDialogUserProfile = assertNativeDialogProfile();
    const diagnosticsDirectory = path.join(nativeDialogUserProfile, 'Documents');
    assert(fs.existsSync(diagnosticsDirectory), `Windows Documents directory is unavailable: ${diagnosticsDirectory}`);
    assert(fs.statSync(diagnosticsDirectory).isDirectory(), `Windows Documents path is not a directory: ${diagnosticsDirectory}`);
    fs.accessSync(diagnosticsDirectory, fs.constants.R_OK | fs.constants.W_OK);
    for (const directory of [
      dataRoot,
      browserDataRoot,
      isolatedHome,
      path.join(isolatedHome, 'Documents'),
      path.join(isolatedHome, 'Desktop'),
      appData,
      localAppData,
      runtimeTemp,
      projectPath,
    ]) fs.mkdirSync(directory, { recursive: true });

    fs.writeFileSync(path.join(projectPath, 'README.md'), '# Model Provider acceptance fixture\n', 'utf8');
    const now = new Date().toISOString();
    const databasePath = path.join(dataRoot, 'claude-workbench.db');
    writeJson(databasePath, {
      projects: {
        [PROJECT_ID]: {
          id: PROJECT_ID,
          name: PROJECT_NAME,
          path: projectPath,
          created_at: now,
          last_opened_at: now,
        },
      },
      sessions: {
        [TASK_ID]: {
          id: TASK_ID,
          project_id: PROJECT_ID,
          title: 'Model Provider acceptance task',
          status: 'idle',
          created_at: now,
          updated_at: now,
        },
      },
      messages: {},
      events: {},
      fileChanges: {},
      settings: {
        language: 'zh-CN',
        theme: 'light',
      },
    });

    return {
      root,
      dataRoot,
      databasePath,
      browserDataRoot,
      isolatedHome,
      appData,
      localAppData,
      runtimeTemp,
      projectPath,
      nativeDialogUserProfile,
      diagnosticsDirectory,
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
    NODE_ENV: 'production',
    // Native Windows dialogs resolve known folders from the real profile.
    // A synthetic USERPROFILE produces the "Location is unavailable" Desktop
    // error even when a same-named directory exists in the fixture.
    HOME: fixture.nativeDialogUserProfile,
    USERPROFILE: fixture.nativeDialogUserProfile,
    APPDATA: fixture.appData,
    LOCALAPPDATA: fixture.localAppData,
    TEMP: fixture.runtimeTemp,
    TMP: fixture.runtimeTemp,
    XDG_CONFIG_HOME: path.join(fixture.isolatedHome, '.config'),
    CLAUDE_CONFIG_DIR: path.join(fixture.isolatedHome, '.claude'),
  };
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'NODE_OPTIONS',
    'VITE_DEV_SERVER_URL',
    'WORKBENCH_OPEN_DEVTOOLS',
    'FORCE_FAKE',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]) delete env[key];
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

async function readRequestBody(request, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Provider acceptance request exceeded its limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function writeAnthropicTextStream(response, model, text) {
  const messageId = `msg_${crypto.randomUUID().replace(/-/gu, '')}`;
  const events = [
    ['message_start', { type: 'message_start', message: {
      id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null,
      stop_sequence: null, usage: { input_tokens: 11, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
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

async function startProviderServer(mimoSecret, deepSeekSecret) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const startedAt = Date.now();
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    try {
      if (request.method === 'POST' && pathname === '/anthropic/v1/messages') {
        const body = JSON.parse(await readRequestBody(request));
        const suppliedSecret = request.headers['x-api-key']
          ?? request.headers.authorization?.replace(/^Bearer\s+/iu, '');
        const credentialMatched = suppliedSecret === mimoSecret;
        requests.push({
          method: request.method,
          pathname,
          credentialMatched,
          authScheme: request.headers.authorization?.startsWith('Bearer ') ? 'bearer' : 'other',
          model: typeof body.model === 'string' ? body.model : null,
          startedAt,
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (!credentialMatched) {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { type: 'authentication_error' } }));
        } else if (body.stream === true) {
          writeAnthropicTextStream(response, typeof body.model === 'string' ? body.model : MIMO_MODEL, 'OK');
        } else {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            id: `msg_${crypto.randomUUID()}`,
            type: 'message',
            role: 'assistant',
            model: typeof body.model === 'string' ? body.model : MIMO_MODEL,
            content: [{ type: 'text', text: 'OK' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 11, output_tokens: 1 },
          }));
        }
        return;
      }
      if (request.method === 'GET' && pathname === '/openai/models') {
        const credentialMatched = request.headers.authorization === `Bearer ${deepSeekSecret}`;
        requests.push({
          method: request.method,
          pathname,
          credentialMatched,
          authScheme: request.headers.authorization?.startsWith('Bearer ') ? 'bearer' : 'other',
          model: null,
          startedAt,
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        response.writeHead(credentialMatched ? 200 : 401, { 'content-type': 'application/json' });
        response.end(JSON.stringify(credentialMatched
          ? { object: 'list', data: [{ id: DEEPSEEK_MODEL }, { id: 'deepseek-reasoner' }] }
          : { error: { type: 'authentication_error' } }));
        return;
      }
      requests.push({
        method: request.method ?? 'UNKNOWN',
        pathname,
        credentialMatched: false,
        model: null,
        startedAt,
      });
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'invalid_request' }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(typeof address === 'object' && address, 'Provider fixture server has no address.');
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    ))),
  };
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
    // The production page normally closes CDP before Runtime.evaluate resolves.
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
    try { process.kill(pid, 'SIGTERM'); } catch { /* already stopped */ }
    if (!(await waitForProcessExit(instance.child, 2_000))) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ }
    }
  }
  await waitForProcessExit(instance.child, 3_000);
}

async function launchElectron(fixture) {
  const port = await reservePort();
  const electronPath = electron.default || electron;
  const launchArgs = [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${fixture.browserDataRoot}`,
    '.',
  ];
  const launchEnv = childEnvironment(fixture);
  assert(launchEnv.FORCE_FAKE === undefined, 'Production acceptance must not force FakeClaudeCliAdapter.');
  const child = spawn(electronPath, launchArgs, {
    cwd: WORKSPACE_ROOT,
    env: launchEnv,
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
      timeoutMs: STEP_TIMEOUT_MS,
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
      `document.readyState === 'complete'
        && document.getElementById('root')?.children.length > 0
        && Boolean(window.api)`,
      { description: 'production Workbench Renderer and named preload API', timeoutMs: STEP_TIMEOUT_MS },
    );
    return { child, client, page, port, launchArgs, stdout, stderr, rendererErrors };
  } catch (error) {
    await stopElectron({ child, client, stdout, stderr });
    const logTail = [...stderr, ...stdout].join('').trim().split(/\r?\n/u).slice(-30).join('\n');
    throw new Error(`${error.message}${logTail ? `\nElectron log tail:\n${logTail}` : ''}`);
  }
}

async function clickTestId(client, testId) {
  const clicked = await client.evaluate(`(() => {
    const root = document.querySelector(${js(`[data-testid="${testId}"]`)});
    const element = root?.matches('button, [role="button"]') ? root : root?.querySelector('button, [role="button"]');
    if (!element || element.disabled) return false;
    element.click();
    return true;
  })()`);
  assert(clicked, `UI control is unavailable: ${testId}`);
}

async function clickVisibleText(client, text, selector = 'button, [role="button"], [role="tab"]') {
  const clicked = await client.evaluate(`(() => {
    const target = ${js(text)};
    const normalize = (value) => String(value || '').replace(/\\s+/gu, ' ').trim();
    const match = Array.from(document.querySelectorAll(${js(selector)})).find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !element.disabled
        && normalize(element.textContent || element.title || element.getAttribute('aria-label')).includes(target);
    });
    if (!match) return false;
    match.click();
    return true;
  })()`);
  assert(clicked, `Visible UI control was not found: ${text}`);
}

async function setEditorControl(client, index, value) {
  const changed = await client.evaluate(`(() => {
    const controls = Array.from(document.querySelectorAll('[data-testid="provider-editor"] .provider-input'));
    const element = controls[${index}];
    if (!element) return false;
    const prototype = element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    setter?.call(element, ${js(value)});
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    return element.value === ${js(value)};
  })()`);
  assert(changed, `Provider editor control ${index} could not be changed.`);
}

async function addProviderThroughUi(client, input) {
  await clickTestId(client, 'add-provider');
  await client.waitFor(`Boolean(document.querySelector('[data-testid="provider-editor"]'))`, {
    description: `${input.name} Provider editor`,
  });
  await setEditorControl(client, 0, input.name);
  await setEditorControl(client, 1, input.type);
  await setEditorControl(client, 3, input.baseUrl);
  await setEditorControl(client, 4, input.modelId);
  await setEditorControl(client, 5, input.secret);
  const credentialInputBefore = await client.evaluate(`(() => {
    const input = document.querySelector('[data-testid="provider-editor"] input[type="password"]');
    return { type: input?.type ?? null, length: input?.value.length ?? -1 };
  })()`);
  assert(credentialInputBefore.type === 'password', `${input.name} credential field is not a password input.`);
  assert(credentialInputBefore.length === input.secret.length, `${input.name} credential did not reach the transient form state.`);

  await clickTestId(client, 'validate-provider');
  await client.waitFor(
    `document.querySelector('[data-testid="provider-editor"] [role="status"]')?.innerText.includes('连接成功')`,
    { description: `${input.name} real connection success`, timeoutMs: STEP_TIMEOUT_MS },
  );
  const validationUi = await client.evaluate(`(() => {
    const editor = document.querySelector('[data-testid="provider-editor"]');
    const credential = editor?.querySelector('input[type="password"]');
    const save = editor?.querySelector('[data-testid="save-provider"]');
    return {
      status: editor?.querySelector('[role="status"]')?.innerText ?? '',
      credentialCleared: credential?.value === '',
      saveEnabled: Boolean(save && !save.disabled),
    };
  })()`);
  assert(validationUi.credentialCleared, `${input.name} credential remained in Renderer state after submit.`);
  assert(validationUi.saveEnabled, `${input.name} could not be saved after a successful real test.`);

  await clickTestId(client, 'save-provider');
  await client.waitFor(
    `!document.querySelector('[data-testid="provider-editor"]')
      && Array.from(document.querySelectorAll('[data-testid="model-provider-list-item"]'))
        .some((element) => element.innerText.includes(${js(input.name)}))`,
    { description: `${input.name} saved Provider list item`, timeoutMs: STEP_TIMEOUT_MS },
  );
  const provider = await client.evaluate(`(async () => {
    const page = await window.api.listModelProviders({ limit: 100, offset: 0 });
    return page.items.find((item) => item.name === ${js(input.name)}) ?? null;
  })()`);
  assert(provider, `${input.name} is missing from the public Provider API.`);
  return { provider, validationUi };
}

async function selectProviderInUi(client, name) {
  const selected = await client.evaluate(`(() => {
    const item = Array.from(document.querySelectorAll('[data-testid="model-provider-list-item"]'))
      .find((element) => element.innerText.includes(${js(name)}));
    if (!item) return false;
    item.click();
    return true;
  })()`);
  assert(selected, `Provider list item was not found: ${name}`);
  const expanded = await client.evaluate(`(() => {
    const details = document.querySelector('[data-testid="provider-advanced-details"]');
    if (!(details instanceof HTMLDetailsElement)) return false;
    details.open = true;
    return true;
  })()`);
  assert(expanded, `${name} Provider advanced details could not be expanded.`);
  await client.waitFor(
    `document.querySelector('[data-testid="model-provider-details"]')?.innerText.includes(${js(name)})`,
    { description: `${name} Provider details` },
  );
}

async function openModelProviderCenter(client) {
  const opened = await client.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button'))
      .find((element) => String(element.title || '').includes('Ctrl+,'));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert(opened, 'Settings toolbar button was not found.');
  await client.waitFor(`document.body.innerText.includes('设置')`, { description: 'Settings dialog' });
  await clickVisibleText(client, '模型与连接');
  await client.waitFor(`Boolean(document.querySelector('[data-testid="model-provider-center"]'))`, {
    description: 'Model Provider Center',
  });
}

async function closeSettings(client) {
  const closed = await client.evaluate(`(() => {
    const body = document.querySelector('[data-testid="settings-body"]');
    const overlay = body?.closest('.fixed.inset-0');
    const header = overlay?.firstElementChild?.firstElementChild;
    const button = header?.querySelector('button');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert(closed, 'Settings close button was not found.');
  await client.waitFor(`!document.querySelector('[data-testid="settings-body"]')`, {
    description: 'Settings dialog close',
  });
}

async function captureScreenshot(client, directory, name) {
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, name);
  const capture = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(output, Buffer.from(capture.data, 'base64'));
  return {
    path: path.relative(WORKSPACE_ROOT, output).replace(/\\/gu, '/'),
    sha256: sha256(fs.readFileSync(output)),
    bytes: fs.statSync(output).size,
  };
}

async function setSelectByAriaLabel(client, label, value) {
  const changed = await client.evaluate(`(() => {
    const element = document.querySelector(${js(`select[aria-label="${label}"]`)});
    if (!element || element.disabled) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(element, ${js(value)});
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert(changed, `Policy control could not be changed: ${label}`);
}

async function setAgentPolicyThroughUi(client, providerId, modelId, role, notes) {
  const pair = `${encodeURIComponent(providerId)}:${encodeURIComponent(modelId)}`;
  const noteLabels = { quality: '质量', speed: '速度', cost: '成本' };
  await client.waitFor(
    `(() => { const element = document.querySelector(${js(`select[aria-label="${role} 模型"]`)}); return Boolean(element && !element.disabled); })()`,
    { description: `${role} policy selector enabled` },
  );
  await setSelectByAriaLabel(client, `${role} 模型`, pair);
  await client.waitFor(
    `(async () => (await window.api.listAgentModelPolicies())
      .some((item) => item.agentType === ${js(role.toLowerCase())}
        && item.providerId === ${js(providerId)}
        && item.modelId === ${js(modelId)}))()`,
    { description: `${role} Agent policy persistence` },
  );
  for (const [field, value] of Object.entries(notes)) {
    const fieldLabel = noteLabels[field];
    assert(fieldLabel, `Unknown Agent policy note field: ${field}`);
    await client.waitFor(
      `(() => { const element = document.querySelector(${js(`select[aria-label="${role} ${fieldLabel}"]`)}); return Boolean(element && !element.disabled); })()`,
      { description: `${role} ${field} note enabled` },
    );
    await setSelectByAriaLabel(client, `${role} ${fieldLabel}`, value);
  }
  await client.waitFor(
    `(async () => (await window.api.listAgentModelPolicies())
      .some((item) => item.agentType === ${js(role.toLowerCase())}
        && item.notes.quality === ${js(notes.quality)}
        && item.notes.speed === ${js(notes.speed)}
        && item.notes.cost === ${js(notes.cost)}))()`,
    { description: `${role} quality/speed/cost notes` },
  );
}

function updateTaskStatus(databasePath, status) {
  const database = new BetterSqlite3(databasePath);
  try {
    database.transaction(() => {
      database.prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, new Date().toISOString(), TASK_ID);
      database.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, new Date().toISOString(), TASK_ID);
    })();
  } finally {
    database.close();
  }
}

function addFixtureModel(databasePath, providerId, modelId, displayName) {
  const database = new BetterSqlite3(databasePath);
  try {
    const now = Date.now();
    database.prepare(`
      INSERT OR IGNORE INTO model_provider_models
        (provider_id, model_id, display_name, source, created_at, updated_at)
      VALUES (?, ?, ?, 'manual', ?, ?)
    `).run(providerId, modelId, displayName, now, now);
  } finally {
    database.close();
  }
}

function executionSideEffectCounts(databasePath) {
  const database = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
  try {
    return Object.fromEntries([
      'sessions', 'tasks', 'events', 'checkpoints', 'workflows', 'workflow_steps',
    ].map((table) => [table, database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
  } finally {
    database.close();
  }
}

function privateCredentialIdentifiers(fixture) {
  const database = new BetterSqlite3(fixture.databasePath, { readonly: true, fileMustExist: true });
  let records;
  try {
    records = database.prepare(`
      SELECT id AS providerId, credential_ref AS credentialRef
      FROM model_providers
      WHERE credential_ref IS NOT NULL
      ORDER BY id
    `).all().map((row) => ({
      providerId: row.providerId,
      credentialRef: row.credentialRef,
      vaultFile: `${row.credentialRef.slice('safe-storage://v1/'.length)}.bin`,
    }));
  } finally {
    database.close();
  }
  const vaultPath = path.join(fixture.dataRoot, 'model-credentials');
  const vaultFiles = fs.existsSync(vaultPath)
    ? fs.readdirSync(vaultPath).filter((name) => name.endsWith('.bin')).sort()
    : [];
  return {
    records,
    refs: records.map((record) => record.credentialRef),
    vaultFiles,
    vaultPath,
  };
}

function sqliteSensitiveSurfaceEvidence(fixture, identifiers, secrets) {
  const databaseFiles = [
    fixture.databasePath,
    `${fixture.databasePath}-wal`,
    `${fixture.databasePath}-shm`,
  ].filter((filePath) => fs.existsSync(filePath));
  const databaseBytes = Buffer.concat(databaseFiles.map((filePath) => fs.readFileSync(filePath)));
  const database = new BetterSqlite3(fixture.databasePath, { readonly: true, fileMustExist: true });
  let taskEvents;
  let configuredReferenceCount;
  try {
    taskEvents = database.prepare(`
      SELECT event_type AS eventType, payload_json AS payloadJson
      FROM events
      WHERE session_id = ?
      ORDER BY created_at, id
    `).all(TASK_ID);
    configuredReferenceCount = database.prepare(`
      SELECT COUNT(*) AS count
      FROM model_providers
      WHERE credential_ref IS NOT NULL
    `).get().count;
  } finally {
    database.close();
  }
  const privateValues = [...secrets, ...identifiers.refs, ...identifiers.vaultFiles];
  const eventBytes = Buffer.from(JSON.stringify(taskEvents), 'utf8');
  const taskEventScan = scanBufferForSensitiveValues(eventBytes, [
    { kind: 'sentinel_api_key', values: secrets },
    { kind: 'credential_ref', values: identifiers.refs },
    { kind: 'vault_filename', values: identifiers.vaultFiles },
  ]);
  const databaseSecretScan = scanBufferForSensitiveValues(databaseBytes, [
    { kind: 'sentinel_api_key', values: secrets },
    { kind: 'vault_filename', values: identifiers.vaultFiles },
  ]);
  assert(databaseSecretScan.every((scan) => !scan.present), 'SQLite files contain a secret or vault filename.');
  assert(taskEventScan.every((scan) => !scan.present), 'Task events contain a private Provider identifier.');
  assert(configuredReferenceCount === identifiers.refs.length, 'Credential refs escaped their designated Provider column.');
  return {
    databaseFiles: databaseFiles.map((filePath) => ({
      suffix: path.basename(filePath).replace(path.basename(fixture.databasePath), 'database'),
      sha256: sha256(fs.readFileSync(filePath)),
      bytes: fs.statSync(filePath).size,
    })),
    configuredReferenceCount,
    allowedCredentialRefLocation: 'model_providers.credential_ref',
    taskEventCount: taskEvents.length,
    databaseSecretScan,
    taskEventScan,
    privateValueCount: privateValues.length,
  };
}

function assertCredentialCleanupCompleted(fixture, deletedRecord) {
  const database = new BetterSqlite3(fixture.databasePath, { readonly: true, fileMustExist: true });
  let providerRows;
  let cleanupRows;
  try {
    providerRows = database.prepare('SELECT COUNT(*) AS count FROM model_providers WHERE id = ?')
      .get(deletedRecord.providerId).count;
    cleanupRows = database.prepare(`
      SELECT COUNT(*) AS count
      FROM credential_cleanup_jobs
      WHERE provider_id = ? OR credential_ref = ?
    `).get(deletedRecord.providerId, deletedRecord.credentialRef).count;
  } finally {
    database.close();
  }
  const vaultFileExists = fs.existsSync(path.join(
    fixture.dataRoot,
    'model-credentials',
    deletedRecord.vaultFile,
  ));
  assert(providerRows === 0, 'Deleted Provider row remains in SQLite.');
  assert(cleanupRows === 0, 'Completed Provider credential cleanup job remains in SQLite.');
  assert(!vaultFileExists, 'Deleted Provider credential remains in the encrypted vault.');
  return { providerRows, cleanupRows, vaultFileExists };
}

function runPowerShellEncoded(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return spawn('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-OutputFormat', 'Text',
    '-EncodedCommand', encoded,
  ], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function awaitChild(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    let settled = false;
    child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* already stopped */ }
      reject(new Error('Native dialog automation timed out.'));
    }, timeoutMs);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString('utf8').trim();
      const error = Buffer.concat(stderr).toString('utf8').trim();
      if (code === 0) resolve({ stdout: output, stderr: error });
      else reject(new Error(`Native dialog automation exited ${code}:\n${error}\n${output}`));
    });
  });
}

function buildNativeDialogAutomationScript(expectedProcessId) {
  assert(Number.isInteger(expectedProcessId) && expectedProcessId > 0, 'Electron process id is unavailable.');
  return String.raw`
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $expectedProcessId = ${expectedProcessId}
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -TypeDefinition @'
      using System.Runtime.InteropServices;
      public static class WorkbenchAcceptanceNativeDialog {
        [DllImport("user32.dll")]
        public static extern bool PostMessage(System.IntPtr window, uint message, System.IntPtr wParam, System.IntPtr lParam);
      }
'@
    function Test-VerifiedDialogOpen {
      param(
        [System.Windows.Automation.AutomationElement]$Root,
        [System.IntPtr]$DialogHandle,
        [int]$ExpectedProcessId
      )
      $windows = $Root.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition
      )
      foreach ($candidate in $windows) {
        if ($candidate.Current.NativeWindowHandle -eq $DialogHandle.ToInt32() -and
          $candidate.Current.ProcessId -eq $ExpectedProcessId -and
          $candidate.Current.ClassName -eq '#32770' -and
          $candidate.Current.Name -eq 'Export Claude Workbench diagnostics') {
          return $true
        }
      }
      return $false
    }
    function Close-VerifiedDialog {
      param(
        [System.Windows.Automation.AutomationElement]$Root,
        [System.IntPtr]$DialogHandle,
        [int]$ExpectedProcessId
      )
      if (Test-VerifiedDialogOpen $Root $DialogHandle $ExpectedProcessId) {
        [WorkbenchAcceptanceNativeDialog]::PostMessage(
          $DialogHandle, 0x0010, [System.IntPtr]::Zero, [System.IntPtr]::Zero
        ) | Out-Null
      }
    }
    function Wait-VerifiedDialogClosed {
      param(
        [System.Windows.Automation.AutomationElement]$Root,
        [System.IntPtr]$DialogHandle,
        [int]$ExpectedProcessId,
        [int]$Attempts
      )
      for ($index = 0; $index -lt $Attempts; $index += 1) {
        if (-not (Test-VerifiedDialogOpen $Root $DialogHandle $ExpectedProcessId)) {
          return $true
        }
        Start-Sleep -Milliseconds ${NATIVE_DIALOG_POLL_INTERVAL_MS}
      }
      return $false
    }

    $root = $null
    $dialog = $null
    $dialogHandle = [System.IntPtr]::Zero
    try {
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      for ($index = 0; $index -lt ${NATIVE_DIALOG_FIND_ATTEMPTS}; $index += 1) {
      $windows = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition
      )
      foreach ($candidate in $windows) {
        if ($candidate.Current.ProcessId -eq $expectedProcessId -and
          $candidate.Current.ClassName -eq '#32770' -and
          $candidate.Current.Name -eq 'Export Claude Workbench diagnostics') {
          $dialog = $candidate
          break
        }
      }
      if ($null -ne $dialog) { break }
      Start-Sleep -Milliseconds ${NATIVE_DIALOG_POLL_INTERVAL_MS}
      }
      if ($null -eq $dialog) {
        Write-Output ('Verified diagnostics dialog was not found for Electron PID {0}.' -f $expectedProcessId)
        exit 2
      }
      $dialogHandle = [System.IntPtr]$dialog.Current.NativeWindowHandle
      if ($dialogHandle -eq [System.IntPtr]::Zero) {
        Write-Output 'Verified diagnostics dialog has no native window handle.'
        exit 5
      }

    $controls = $dialog.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    $save = $null
    foreach ($control in $controls) {
      if ($control.Current.ProcessId -eq $expectedProcessId -and
        $control.Current.AutomationId -eq '1' -and
        $control.Current.Name -match '^(Save|保存)(\(|$)') {
        $save = $control
        break
      }
    }
    if ($null -eq $save) {
      Write-Output ('Verified dialog found but Save control was unavailable; pid={0};class={1};title={2}' -f
        $dialog.Current.ProcessId,
        $dialog.Current.ClassName,
        $dialog.Current.Name)
      Close-VerifiedDialog $root $dialogHandle $expectedProcessId
      exit 4
    }
    $saveHandle = [System.IntPtr]$save.Current.NativeWindowHandle
    if ($saveHandle -eq [System.IntPtr]::Zero) {
      Write-Output ('Verified Save control has no HWND; pid={0};id={1};name={2};type={3}' -f
        $save.Current.ProcessId,
        $save.Current.AutomationId,
        $save.Current.Name,
        $save.Current.ControlType.ProgrammaticName)
      Close-VerifiedDialog $root $dialogHandle $expectedProcessId
      exit 6
    }

    $buttonPosted = [WorkbenchAcceptanceNativeDialog]::PostMessage(
      $saveHandle, 0x00F5, [System.IntPtr]::Zero, [System.IntPtr]::Zero
    )
    if (Wait-VerifiedDialogClosed $root $dialogHandle $expectedProcessId ${NATIVE_DIALOG_BUTTON_CLOSE_ATTEMPTS}) { exit 0 }

    $commandPosted = [WorkbenchAcceptanceNativeDialog]::PostMessage(
      $dialogHandle, 0x0111, [System.IntPtr]1, $saveHandle
    )
    if (Wait-VerifiedDialogClosed $root $dialogHandle $expectedProcessId ${NATIVE_DIALOG_COMMAND_CLOSE_ATTEMPTS}) { exit 0 }

    Write-Output ('Verified Save action failed; pid={0};dialog-hwnd={1};save-hwnd={2};save-name={3};save-type={4};button-posted={5};command-posted={6}' -f
      $expectedProcessId,
      $dialogHandle,
      $saveHandle,
      $save.Current.Name,
      $save.Current.ControlType.ProgrammaticName,
      $buttonPosted,
      $commandPosted)
      Close-VerifiedDialog $root $dialogHandle $expectedProcessId
      exit 3
    } catch {
      $failureMessage = $_.Exception.Message
      $closeFailure = ''
      if ($null -ne $root -and $dialogHandle -ne [System.IntPtr]::Zero) {
        try {
          Close-VerifiedDialog $root $dialogHandle $expectedProcessId
        } catch {
          $closeFailure = $_.Exception.Message
        }
      }
      Write-Output ('Unexpected diagnostics dialog automation failure; pid={0};error={1};close-error={2}' -f
        $expectedProcessId,
        $failureMessage,
        $closeFailure)
      exit 7
    }
  `;
}

function diagnosticsArchiveCreatedAt(fileName) {
  const match = DIAGNOSTICS_ARCHIVE_NAME_PATTERN.exec(fileName);
  if (!match) return null;
  const timestamp = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number(match[7]),
  );
  if (!Number.isFinite(timestamp)) return null;
  const canonicalName = `ClaudeWorkbench-diagnostics-${new Date(timestamp).toISOString().replace(/[:.]/gu, '-')}.zip`;
  return canonicalName === fileName ? timestamp : null;
}

function sameResolvedPath(left, right) {
  return path.resolve(left).toLocaleLowerCase('en-US') === path.resolve(right).toLocaleLowerCase('en-US');
}

function diagnosticsIdentity(stat, bytes) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    birthtimeMs: stat.birthtimeMs,
    ctimeMs: stat.ctimeMs,
    nlink: stat.nlink,
    sha256: sha256(bytes),
  };
}

function sameDiagnosticsIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.birthtimeMs === right.birthtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.nlink === right.nlink
    && left.sha256 === right.sha256;
}

function snapshotDiagnosticsIdentity(filePath) {
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    return { ok: false, reason: 'Diagnostics path is not a single-link regular file.' };
  }
  const bytes = fs.readFileSync(filePath);
  const after = fs.lstatSync(filePath);
  const beforeMetadata = diagnosticsIdentity(before, bytes);
  const afterIdentity = diagnosticsIdentity(after, bytes);
  if (!sameDiagnosticsIdentity(beforeMetadata, afterIdentity)) {
    return { ok: false, reason: 'Diagnostics file identity changed while it was inspected.' };
  }
  return { ok: true, identity: afterIdentity };
}

function inspectExactDiagnosticsCandidate(explicitPath, context) {
  const { outputDirectory, existingNames, requestedAt } = context;
  if (typeof explicitPath !== 'string' || explicitPath.trim().length === 0) {
    return { ok: false, reason: 'No explicit diagnostics path was returned.' };
  }
  if (!path.isAbsolute(explicitPath)) {
    return { ok: false, reason: 'Returned diagnostics path is not absolute.' };
  }
  const resolvedDirectory = path.resolve(outputDirectory);
  const resolvedPath = path.resolve(explicitPath);
  if (!sameResolvedPath(path.dirname(resolvedPath), resolvedDirectory)) {
    return { ok: false, reason: 'Returned diagnostics path is outside the verified directory.' };
  }
  const fileName = path.basename(resolvedPath);
  const createdAt = diagnosticsArchiveCreatedAt(fileName);
  if (createdAt === null) {
    return { ok: false, reason: 'Returned diagnostics filename is not canonical.' };
  }
  const now = Date.now();
  if (createdAt < requestedAt - 2_000 || createdAt > now + 2_000) {
    return { ok: false, reason: 'Returned diagnostics filename timestamp is not fresh.' };
  }
  if (existingNames.has(fileName)) {
    return { ok: false, reason: 'Returned diagnostics path existed before this export.' };
  }
  let stat;
  try {
    stat = fs.lstatSync(resolvedPath);
  } catch (error) {
    return { ok: false, reason: `Returned diagnostics path is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { ok: false, reason: 'Returned diagnostics path is not a regular file.' };
  }
  if (stat.nlink !== 1) {
    return { ok: false, reason: `Returned diagnostics file has ${stat.nlink} hard links.` };
  }
  if (stat.mtimeMs < requestedAt - 2_000 || stat.mtimeMs > now + 2_000) {
    return { ok: false, reason: 'Returned diagnostics file mtime is not fresh.' };
  }
  let snapshot;
  try {
    snapshot = snapshotDiagnosticsIdentity(resolvedPath);
  } catch (error) {
    return { ok: false, reason: `Unable to bind diagnostics file identity: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!snapshot.ok) return snapshot;
  return {
    ok: true,
    candidate: {
      filePath: resolvedPath,
      fileName,
      outputDirectory: resolvedDirectory,
      identity: snapshot.identity,
    },
  };
}

function deleteBoundDiagnosticsCandidate(candidate) {
  if (!candidate || typeof candidate.filePath !== 'string' || !path.isAbsolute(candidate.filePath)) {
    return { deleted: false, reason: 'No bound diagnostics candidate was provided.' };
  }
  if (!sameResolvedPath(path.dirname(candidate.filePath), candidate.outputDirectory)) {
    return { deleted: false, reason: 'Bound diagnostics candidate is outside its verified directory.' };
  }
  if (diagnosticsArchiveCreatedAt(candidate.fileName) === null
    || path.basename(candidate.filePath) !== candidate.fileName) {
    return { deleted: false, reason: 'Bound diagnostics candidate filename is not canonical.' };
  }
  let current;
  try {
    current = snapshotDiagnosticsIdentity(candidate.filePath);
  } catch (error) {
    return { deleted: false, reason: `Unable to revalidate diagnostics identity: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!current.ok) return { deleted: false, reason: current.reason };
  if (!sameDiagnosticsIdentity(current.identity, candidate.identity)) {
    return { deleted: false, reason: 'Diagnostics file identity changed before deletion.' };
  }
  try {
    fs.unlinkSync(candidate.filePath);
  } catch (error) {
    return { deleted: false, reason: `Unable to delete bound diagnostics file: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (fs.existsSync(candidate.filePath)) {
    return { deleted: false, reason: 'Diagnostics path was repopulated during deletion.' };
  }
  return { deleted: true, reason: 'Deleted the exact returned diagnostics file.', filePath: candidate.filePath };
}

function cleanupReturnedDiagnosticsOnFailure(exportResult, context) {
  if (!exportResult || exportResult.status !== 'fulfilled' || exportResult.value !== true) {
    return { deleted: false, reason: 'No fulfilled explicit diagnostics path was returned.' };
  }
  const newNames = fs.readdirSync(context.outputDirectory)
    .filter((name) => !context.existingNames.has(name) && diagnosticsArchiveCreatedAt(name) !== null);
  if (newNames.length !== 1) {
    return { deleted: false, reason: `Expected one fresh diagnostics file, found ${newNames.length}.` };
  }
  const inspected = inspectExactDiagnosticsCandidate(
    path.join(context.outputDirectory, newNames[0]),
    context,
  );
  if (!inspected.ok) return { deleted: false, reason: inspected.reason };
  return deleteBoundDiagnosticsCandidate(inspected.candidate);
}


async function exportDiagnosticsThroughProductionDialog(client, outputDirectory, electronProcessId) {
  assert(process.platform === 'win32', 'This native diagnostics acceptance currently requires Windows.');
  assert(Number.isInteger(electronProcessId) && electronProcessId > 0, 'Electron process id is unavailable.');
  const resolvedDirectory = path.resolve(outputDirectory);
  assert(fs.existsSync(resolvedDirectory), `Native dialog directory is unavailable: ${resolvedDirectory}`);
  assert(fs.statSync(resolvedDirectory).isDirectory(), `Native dialog target is not a directory: ${resolvedDirectory}`);
  fs.accessSync(resolvedDirectory, fs.constants.R_OK | fs.constants.W_OK);
  const existingNames = new Set(fs.readdirSync(resolvedDirectory));
  const requestedAt = Date.now();
  const cleanupContext = { outputDirectory: resolvedDirectory, existingNames, requestedAt };
  let exportResult;
  try {
    const helper = runPowerShellEncoded(buildNativeDialogAutomationScript(electronProcessId));
    const exportPromise = client.evaluate(
      'window.api.exportDiagnostics({ includeAnonymousPerformanceData: false })',
      { timeoutMs: NATIVE_DIALOG_EXPORT_TIMEOUT_MS },
    );
    const settled = await Promise.allSettled([
      awaitChild(helper, NATIVE_DIALOG_CHILD_TIMEOUT_MS),
      exportPromise,
    ]);
    const helperResult = settled[0];
    exportResult = settled[1];
    if (helperResult.status === 'rejected') throw helperResult.reason;
    if (exportResult.status === 'rejected') throw exportResult.reason;
    assert(exportResult.value === true, 'Diagnostics export did not report success.');
    const newNames = fs.readdirSync(resolvedDirectory)
      .filter((name) => !existingNames.has(name) && diagnosticsArchiveCreatedAt(name) !== null);
    assert(newNames.length === 1, `Expected one fresh diagnostics archive, found ${newNames.length}.`);
    const inspected = inspectExactDiagnosticsCandidate(
      path.join(resolvedDirectory, newNames[0]),
      cleanupContext,
    );
    assert(inspected.ok, `Diagnostics export path was not safe: ${inspected.reason}`);
    return {
      exportedPath: inspected.candidate.filePath,
      fileName: inspected.candidate.fileName,
      requestedAt,
      cleanupCandidate: inspected.candidate,
    };
  } catch (error) {
    const cleanup = cleanupReturnedDiagnosticsOnFailure(exportResult, cleanupContext);
    const originalMessage = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${originalMessage}\nDiagnostics failure cleanup: ${cleanup.deleted ? 'deleted exact returned path' : `preserved files (${cleanup.reason})`}.`,
      { cause: error },
    );
  }
}

function scanBufferForSensitiveValues(buffer, values) {
  return values.map((value) => ({
    kind: value.kind,
    present: value.values.some((candidate) => candidate && buffer.includes(Buffer.from(candidate, 'utf8'))),
    checkedCount: value.values.length,
  }));
}

function expandedArchivePayload(archivePath, fixtureRoot) {
  const resolvedFixtureRoot = path.resolve(fixtureRoot);
  const extractionRoot = path.resolve(fixtureRoot, 'diagnostics-archive-expanded');
  assert(
    extractionRoot.startsWith(`${resolvedFixtureRoot}${path.sep}`),
    'Diagnostics extraction directory escaped the acceptance fixture.',
  );
  fs.rmSync(extractionRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  fs.mkdirSync(extractionRoot, { recursive: true });
  const quote = (value) => value.replace(/'/gu, "''");
  const encoded = Buffer.from(
    `Expand-Archive -LiteralPath '${quote(path.resolve(archivePath))}' -DestinationPath '${quote(extractionRoot)}' -Force`,
    'utf16le',
  ).toString('base64');
  runChecked('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encoded,
  ]);
  const entries = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) entries.push(entryPath);
    }
  };
  visit(extractionRoot);
  const payloadParts = [];
  for (const entryPath of entries.sort()) {
    payloadParts.push(Buffer.from(path.relative(extractionRoot, entryPath), 'utf8'));
    payloadParts.push(fs.readFileSync(entryPath));
  }
  return {
    payload: Buffer.concat(payloadParts),
    entryCount: entries.length,
    expandedBytes: entries.reduce((total, entryPath) => total + fs.statSync(entryPath).size, 0),
  };
}

function redact(value, sensitiveValues) {
  let output = String(value ?? '');
  for (const sensitive of sensitiveValues) {
    if (sensitive) output = output.split(sensitive).join('[REDACTED]');
  }
  return output;
}

async function runStep(report, name, action) {
  const started = Date.now();
  const step = { name, status: 'running', startedAt: new Date(started).toISOString() };
  report.steps.push(step);
  try {
    const result = await action();
    step.status = 'passed';
    step.durationMs = Date.now() - started;
    if (result !== undefined) step.evidence = result;
    return result;
  } catch (error) {
    step.status = 'failed';
    step.durationMs = Date.now() - started;
    step.error = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const startedAt = new Date();
  const mimoSecret = `CW_MIMO_KEY_${crypto.randomUUID()}`;
  const deepSeekSecret = `CW_DEEPSEEK_KEY_${crypto.randomUUID()}`;
  const sensitiveValues = [mimoSecret, deepSeekSecret];
  const report = {
    format: 'claude-workbench-model-provider-acceptance',
    formatVersion: 2,
    status: 'running',
    startedAt: startedAt.toISOString(),
    production: {
      nodeEnv: 'production',
      devServerUsed: false,
      fakeClaudeRuntime: false,
      fakeModelTransport: true,
      runtime: 'ClaudeCliAdapter',
      billedModelTaskStarted: false,
      note: 'The production app runs the real ClaudeCliAdapter against an authenticated loopback fake model transport; no billed model task is started.',
      build: [],
      sourceEvidence: [],
      launches: [],
    },
    steps: [],
    screenshots: [],
    rendererErrors: [],
  };
  let fixture = null;
  let providerServer = null;
  let instance = null;
  const electronInstances = [];
  let capturedIdentifiers = null;
  let failed = null;
  try {
    if (options.build) runNpm(['run', 'build']);
    report.production.build = assertBuildOutputs();
    report.production.sourceEvidence = [
      snapshotFile(path.join(WORKSPACE_ROOT, 'scripts', 'electron-model-provider-acceptance.mjs')),
      snapshotFile(path.join(WORKSPACE_ROOT, 'package.json')),
    ];
    const screenshotRoot = path.resolve(options.screenshotsPath);
    assert(
      screenshotRoot === path.resolve(SCREENSHOTS_DEFAULT)
        || screenshotRoot.startsWith(`${path.resolve(WORKSPACE_ROOT)}${path.sep}`),
      'Screenshot output must remain inside the workspace.',
    );
    fs.rmSync(screenshotRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

    fixture = createFixture();
    providerServer = await startProviderServer(mimoSecret, deepSeekSecret);
    report.providerServer = {
      transport: 'real-loopback-http',
      origin: providerServer.baseUrl,
      endpoints: ['/anthropic/v1/messages', '/openai/models'],
    };

    instance = await launchElectron(fixture);
    electronInstances.push(instance);
    report.production.launches.push({
      phase: 'initial', pid: instance.child.pid, cdpPort: instance.port, runtime: 'ClaudeCliAdapter',
    });
    await instance.client.waitFor(`document.body.innerText.includes(${js(PROJECT_NAME)})`, {
      description: 'isolated acceptance project',
    });

    await runStep(report, 'Open production Model Provider Center', async () => {
      await openModelProviderCenter(instance.client);
      const pageUrl = await instance.client.evaluate('location.href');
      assert(pageUrl.startsWith('file:'), `Renderer did not use the production file URL: ${pageUrl}`);
      const viewport = await instance.client.evaluate(`(() => {
        const center = document.querySelector('[data-testid="model-provider-center"]');
        const centerRect = center?.getBoundingClientRect();
        const overlay = center?.closest('.fixed.inset-0');
        const modalRect = overlay?.firstElementChild?.getBoundingClientRect();
        const primaryActionRect = center?.querySelector('[data-testid="add-provider"]')?.getBoundingClientRect();
        return {
          width: window.innerWidth,
          height: window.innerHeight,
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          modalFitsViewport: Boolean(modalRect
            && modalRect.left >= 0 && modalRect.top >= 0
            && modalRect.right <= window.innerWidth && modalRect.bottom <= window.innerHeight),
          centerFitsHorizontally: Boolean(centerRect
            && centerRect.left >= 0 && centerRect.right <= window.innerWidth),
          primaryActionVisible: Boolean(primaryActionRect
            && primaryActionRect.left >= 0 && primaryActionRect.top >= 0
            && primaryActionRect.right <= window.innerWidth && primaryActionRect.bottom <= window.innerHeight),
        };
      })()`);
      assert(!viewport.horizontalOverflow, 'Production Renderer has unintended horizontal overflow.');
      assert(viewport.modalFitsViewport, 'Settings modal is clipped in the as-launched window.');
      assert(viewport.centerFitsHorizontally, 'Model Provider Center is clipped horizontally.');
      assert(viewport.primaryActionVisible, 'Model Provider Center primary action is not initially visible.');
      return { rendererUrlScheme: new URL(pageUrl).protocol, preloadApi: true, viewport };
    });

    const mimo = await runStep(report, 'Add MiMo through password form and real Anthropic test', async () => {
      const result = await addProviderThroughUi(instance.client, {
        name: MIMO_NAME,
        type: 'anthropic-compatible',
        baseUrl: `${providerServer.baseUrl}/anthropic`,
        modelId: MIMO_MODEL,
        secret: mimoSecret,
      });
      await selectProviderInUi(instance.client, MIMO_NAME);
      const details = await instance.client.evaluate(`(() => ({
        text: document.querySelector('[data-testid="model-provider-details"]')?.innerText ?? '',
        capabilities: document.querySelectorAll('[data-testid="provider-capability"]').length,
      }))()`);
      assert(details.text.includes('连接成功'), 'MiMo health does not show a successful connection.');
      assert(details.text.includes(MIMO_MODEL), 'MiMo manual model is not visible.');
      assert(details.capabilities === 6, 'MiMo does not display all six capabilities.');
      for (const use of ['普通聊天', 'Agent任务', 'Claude Code', 'MCP工具']) {
        assert(details.text.includes(use), `MiMo supported use is missing: ${use}`);
      }
      await clickTestId(instance.client, 'set-default-provider');
      await instance.client.waitFor(
        `(async () => (await window.api.getModelProvider(${js(result.provider.id)})).isDefault)()`,
        { description: 'MiMo global default' },
      );
      report.screenshots.push(await captureScreenshot(
        instance.client,
        screenshotRoot,
        '01-mimo-connected.png',
      ));
      const publicJson = JSON.stringify(result.provider);
      assert(!publicJson.includes(mimoSecret), 'MiMo public DTO exposed the API key.');
      assert(!publicJson.includes('credentialRef'), 'MiMo public DTO exposed credentialRef.');
      return {
        id: result.provider.id,
        type: result.provider.type,
        runtimeType: result.provider.runtimeType,
        health: result.provider.health,
        passwordInput: true,
        credentialClearedAfterSubmit: result.validationUi.credentialCleared,
        publicDtoAllowlisted: true,
      };
    });

    await runStep(report, 'Prepare distinct MiMo models for Agent role selection', async () => {
      addFixtureModel(fixture.databasePath, mimo.id, MIMO_FAST_MODEL, 'MiMo Fast');
      addFixtureModel(fixture.databasePath, mimo.id, MIMO_REVIEW_MODEL, 'MiMo Review');
      const connection = await instance.client.evaluate(`window.api.testModelProviderConnection(${js(mimo.id)})`);
      assert(connection.ok, 'MiMo failed its second real connection after adding role models.');
      await instance.client.waitFor(
        `(async () => (await window.api.listModelProviderModels(${js(mimo.id)})).length === 3)()`,
        { description: 'three MiMo role models' },
      );
      return {
        providerId: mimo.id,
        modelIds: [MIMO_MODEL, MIMO_FAST_MODEL, MIMO_REVIEW_MODEL],
        connectionLatencyMs: connection.latencyMs,
      };
    });

    await runStep(report, 'Run a minimal MiMo Agent task through the production Claude Runtime', async () => {
      const beforeRequests = providerServer.requests.length;
      const runId = `model-provider-mimo-${crypto.randomUUID()}`;
      const evidence = await instance.client.evaluate(`new Promise((resolve) => {
        const events = [];
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          unsubscribe();
          resolve(value);
        };
        const unsubscribe = window.api.onClaudeEvent((envelope) => {
          if (envelope.runId !== ${js(runId)}) return;
          events.push(envelope.event.type);
          if (envelope.event.type === 'session_completed') finish({ ok: true, events });
          if (envelope.event.type === 'session_failed') finish({
            ok: false, events, error: envelope.event.error
          });
        });
        const timeout = setTimeout(() => {
          void window.api.stopRun(${js(runId)}).finally(() => finish({
            ok: false, events, error: 'timeout'
          }));
        }, 45000);
        void window.api.runPrompt({
          runId: ${js(runId)},
          projectKey: ${js(fixture.projectPath)},
          sessionKey: ${js(`${fixture.projectPath}::${TASK_ID}`)},
          projectPath: ${js(fixture.projectPath)},
          prompt: 'Reply with OK only.',
          model: ${js(MIMO_MODEL)},
          permissionMode: 'plan',
          agentMode: 'plan',
          disallowedTools: []
        }).catch((error) => finish({ ok: false, events, error: error?.message ?? String(error) }));
      })`);
      assert(evidence.ok, `MiMo production Agent task failed: ${evidence.error ?? 'unknown'}`);
      const runtimeRequests = providerServer.requests.slice(beforeRequests)
        .filter((request) => request.pathname === '/anthropic/v1/messages');
      assert(runtimeRequests.length >= 1
        && runtimeRequests.every((request) => request.credentialMatched)
        && runtimeRequests.some((request) => request.model === MIMO_MODEL),
      'MiMo Agent task did not enter the Claude Runtime with the selected Provider/model.');
      assert(evidence.events.includes('session_started') || evidence.events.includes('system_init'),
        'MiMo Agent task did not emit a Claude Runtime initialization event.');
      return {
        runId,
        runtime: 'claude-code',
        providerId: mimo.id,
        modelId: MIMO_MODEL,
        events: evidence.events,
        authenticatedRequests: runtimeRequests.length,
      };
    });

    const deepSeek = await runStep(report, 'Add DeepSeek as management-only OpenAI Provider', async () => {
      const result = await addProviderThroughUi(instance.client, {
        name: DEEPSEEK_NAME,
        type: 'openai-compatible',
        baseUrl: `${providerServer.baseUrl}/openai`,
        modelId: DEEPSEEK_MODEL,
        secret: deepSeekSecret,
      });
      await selectProviderInUi(instance.client, DEEPSEEK_NAME);
      const details = await instance.client.evaluate(`(() => {
        const root = document.querySelector('[data-testid="model-provider-details"]');
        return {
          text: root?.innerText ?? '',
          hasDefaultButton: Boolean(root?.querySelector('[data-testid="set-default-provider"]')),
        };
      })()`);
      assert(details.text.includes(UNSUPPORTED_RUNTIME_MESSAGE), 'DeepSeek missing the unsupported Runtime warning.');
      assert(details.text.includes('deepseek-reasoner'), 'DeepSeek /models discovery was not displayed.');
      assert(!details.hasDefaultButton, 'DeepSeek incorrectly exposes a default Runtime action.');
      const beforeRejection = executionSideEffectCounts(fixture.databasePath);
      const forged = await instance.client.evaluate(`(async () => {
        const validation = await window.api.validateModelProviderDraft({
          providerId: ${js(result.provider.id)},
          name: ${js(DEEPSEEK_NAME)},
          type: 'openai-compatible',
          apiFormat: 'openai-chat-completions',
          baseUrlIntent: { mode: 'preserve_existing' },
          credential: null,
          defaultModelId: ${js(DEEPSEEK_MODEL)},
          capabilities: {
            supportsClaudeCode: true,
            supportsAgentWorkflow: true,
            supportsTools: true,
            supportsMCP: true
          }
        });
        await window.api.updateModelProvider({
          providerId: ${js(result.provider.id)}, validationToken: validation.validationToken
        });
        return window.api.getModelProvider(${js(result.provider.id)});
      })()`);
      assert(forged.runtimeType === 'none'
        && forged.capabilities.supportsClaudeCode === false
        && forged.capabilities.supportsAgentWorkflow === false,
      'Renderer capability forgery promoted DeepSeek runtime facts.');
      const rejectedDefault = await instance.client.evaluate(`window.api.setDefaultModelProvider(${js(result.provider.id)})
        .then(() => ({ ok: true, code: '', message: '' }))
        .catch((error) => ({ ok: false, code: error?.code ?? '', message: error?.message ?? String(error) }))`);
      assert(!rejectedDefault.ok
        && rejectedDefault.code === 'PROVIDER_RUNTIME_NOT_RUNNABLE'
        && rejectedDefault.message === PROVIDER_RUNTIME_NOT_RUNNABLE_MESSAGE,
      'DeepSeek default rejection did not use the stable public code and message.');
      const defaults = await instance.client.evaluate(`window.api.listModelProviders({ limit: 100, offset: 0 })`);
      assert(defaults.items.some((provider) => provider.id === mimo.id && provider.isDefault)
        && defaults.items.some((provider) => provider.id === result.provider.id && !provider.isDefault),
      'DeepSeek rejection wrote an invalid default or silently changed the valid default.');
      const rejectedPolicy = await instance.client.evaluate(`window.api.setAgentModelPolicy({
        agentType: 'planner',
        providerId: ${js(result.provider.id)},
        modelId: ${js(DEEPSEEK_MODEL)},
        quality: 'high', speed: 'high', cost: 'low'
      }).then(() => ({ ok: true, code: '', message: '' }))
        .catch((error) => ({ ok: false, code: error?.code ?? '', message: error?.message ?? String(error) }))`);
      assert(!rejectedPolicy.ok && rejectedPolicy.code === 'RUNTIME_INCOMPATIBLE',
        'DeepSeek was incorrectly accepted for Agent Workflow.');
      assert(JSON.stringify(executionSideEffectCounts(fixture.databasePath)) === JSON.stringify(beforeRejection),
        'DeepSeek rejection created a Session, Task run, Workflow Stage, event, or Checkpoint.');
      report.screenshots.push(await captureScreenshot(
        instance.client,
        screenshotRoot,
        '02-deepseek-runtime-blocked.png',
      ));
      return {
        id: result.provider.id,
        type: result.provider.type,
        runtimeType: result.provider.runtimeType,
        discoveredModels: await instance.client.evaluate(`window.api.listModelProviderModels(${js(result.provider.id)})`),
        defaultRejected: true,
        defaultErrorCode: rejectedDefault.code,
        forgedCapabilitiesRejected: true,
        executionSideEffectsCreated: false,
        claudeCliAdapterCalls: 0,
        agentPolicyRejected: true,
        exactWarningVisible: true,
      };
    });

    await runStep(report, 'Configure Agent policies and informational notes through UI', async () => {
      await clickVisibleText(instance.client, 'Agent');
      await instance.client.waitFor(`Boolean(document.querySelector('[data-testid="agent-model-policy-editor"]'))`, {
        description: 'Agent Model Policy editor',
      });
      await instance.client.waitFor(
        `Array.from(document.querySelector('select[aria-label="Planner 模型"]')?.options ?? [])
          .some((option) => option.value.endsWith(${js(`:${encodeURIComponent(MIMO_REVIEW_MODEL)}`)}))`,
        { description: 'distinct MiMo models in Agent policy UI' },
      );
      const deepSeekAbsent = await instance.client.evaluate(`(() => Array.from(
        document.querySelectorAll('[data-testid="agent-model-policy-editor"] select[aria-label$="模型"]')
      ).every((select) => !Array.from(select.options).some((option) => option.text.includes(${js(DEEPSEEK_NAME)}))))()`);
      assert(deepSeekAbsent, 'DeepSeek appeared as an Agent Workflow model option.');
      await setAgentPolicyThroughUi(instance.client, mimo.id, MIMO_MODEL, 'Planner', {
        quality: 'high', speed: 'medium', cost: 'high',
      });
      await setAgentPolicyThroughUi(instance.client, mimo.id, MIMO_FAST_MODEL, 'Coder', {
        quality: 'medium', speed: 'high', cost: 'medium',
      });
      await setAgentPolicyThroughUi(instance.client, mimo.id, MIMO_REVIEW_MODEL, 'Reviewer', {
        quality: 'high', speed: 'medium', cost: 'medium',
      });
      const policies = await instance.client.evaluate('window.api.listAgentModelPolicies()');
      assert(policies.length === 3, `Expected three persisted policies, found ${policies.length}.`);
      const selections = await instance.client.evaluate(`Promise.all([
        window.api.getEffectiveModelSelection({ taskId: ${js(TASK_ID)}, agentType: 'planner' }),
        window.api.getEffectiveModelSelection({ taskId: ${js(TASK_ID)}, agentType: 'coder' }),
        window.api.getEffectiveModelSelection({ taskId: ${js(TASK_ID)}, agentType: 'reviewer' }),
      ])`);
      const expectedModels = [MIMO_MODEL, MIMO_FAST_MODEL, MIMO_REVIEW_MODEL];
      assert(selections.every((selection, index) => (
        selection.providerId === mimo.id
        && selection.modelId === expectedModels[index]
        && selection.source === 'global_agent_policy'
      )), `Production Agent role selections were incorrect: ${JSON.stringify(selections)}`);
      await instance.client.evaluate(`document.querySelector('[data-testid="agent-model-policy-editor"]')?.scrollIntoView({ block: 'start' })`);
      report.screenshots.push(await captureScreenshot(
        instance.client,
        screenshotRoot,
        '03-agent-model-policy.png',
      ));
      return {
        roles: policies.map((policy) => ({
          agentType: policy.agentType,
          modelId: policy.modelId,
          notes: policy.notes,
        })),
        resolvedThroughMainProcess: selections.map((selection) => ({
          providerName: selection.providerName,
          modelId: selection.modelId,
          source: selection.source,
        })),
        openAiProviderExcluded: true,
        notesAffectRouting: false,
      };
    });

    await runStep(report, 'Verify real provider requests and credential transport', async () => {
      const anthropicRequests = providerServer.requests.filter((request) => request.pathname === '/anthropic/v1/messages');
      const openAiRequests = providerServer.requests.filter((request) => request.pathname === '/openai/models');
      assert(anthropicRequests.length >= 1 && anthropicRequests.every((request) => request.credentialMatched), 'MiMo did not make an authenticated Anthropic Messages request.');
      assert(openAiRequests.length >= 1 && openAiRequests.every((request) => request.credentialMatched), 'DeepSeek did not make an authenticated OpenAI /models request.');
      assert(anthropicRequests.every((request) => request.authScheme === 'bearer'), 'MiMo Anthropic-compatible requests did not use Authorization: Bearer.');
      assert(openAiRequests.every((request) => request.authScheme === 'bearer'), 'DeepSeek OpenAI-compatible requests did not use Authorization: Bearer.');
      assert(providerServer.requests.every((request) => request.pathname !== '/openai/chat/completions'), 'An OpenAI-to-Anthropic conversion path was used.');
      return {
        anthropicMessagesRequests: anthropicRequests.length,
        openAiModelsRequests: openAiRequests.length,
        allCredentialsMatched: true,
        mimoAuthentication: 'authorization_bearer',
        deepSeekAuthentication: 'authorization_bearer',
        gatewayConversionUsed: false,
      };
    });

    const firstRendererErrors = [...instance.rendererErrors];
    await closeSettings(instance.client);
    await stopElectron(instance);
    instance = null;

    instance = await launchElectron(fixture);
    electronInstances.push(instance);
    report.production.launches.push({
      phase: 'persistence-restart', pid: instance.child.pid, cdpPort: instance.port, runtime: 'ClaudeCliAdapter',
    });
    await instance.client.waitFor(`document.body.innerText.includes(${js(PROJECT_NAME)})`, {
      description: 'acceptance project after restart',
    });

    await runStep(report, 'Restart preserves Providers, health, default and policies', async () => {
      const persisted = await instance.client.evaluate(`(async () => ({
        providers: await window.api.listModelProviders({ limit: 100, offset: 0 }),
        policies: await window.api.listAgentModelPolicies(),
        selection: await window.api.getEffectiveModelSelection({ taskId: ${js(TASK_ID)} }),
      }))()`);
      assert(persisted.providers.items.some((provider) => provider.id === mimo.id && provider.isDefault), 'MiMo default did not survive restart.');
      assert(persisted.providers.items.some((provider) => provider.id === deepSeek.id && provider.health.state === 'connected'), 'DeepSeek health did not survive restart.');
      assert(persisted.policies.length === 3, 'Agent policies did not survive restart.');
      assert(persisted.selection.providerId === mimo.id && persisted.selection.source === 'global_default', 'Global default did not resolve after restart.');
      return {
        providerCount: persisted.providers.total,
        policyCount: persisted.policies.length,
        defaultProvider: persisted.selection.providerName,
        source: persisted.selection.source,
      };
    });

    await runStep(report, 'Top switcher shows Provider, model, Runtime, capabilities and source', async () => {
      await instance.client.waitFor(
        `document.querySelector('[data-testid="model-quick-switcher"]')?.innerText.includes(${js(MIMO_NAME)})
          && document.querySelector('[data-testid="model-quick-switcher"]')?.innerText.includes(${js(MIMO_MODEL)})`,
        { description: 'top Provider/model label', timeoutMs: STEP_TIMEOUT_MS },
      );
      await clickTestId(instance.client, 'model-quick-switcher');
      await instance.client.waitFor(`Boolean(document.querySelector('[data-testid="model-quick-switcher-panel"]'))`, {
        description: 'top model quick-switch details',
      });
      const panel = await instance.client.evaluate(`document.querySelector('[data-testid="model-quick-switcher-panel"]')?.innerText ?? ''`);
      for (const expected of ['Provider', 'Runtime', 'Capabilities', '当前来源', '全局默认']) {
        assert(panel.includes(expected), `Top model panel is missing: ${expected}`);
      }
      await clickTestId(instance.client, 'model-quick-switcher');
      await instance.client.waitFor(`!document.querySelector('[data-testid="model-quick-switcher-panel"]')`, {
        description: 'top model quick-switch details close',
      });
      return { label: `${MIMO_NAME} / ${MIMO_MODEL}`, sourceLabel: '全局默认' };
    });

    await runStep(report, 'Composer switcher shares task selection and opens upward', async () => {
      await instance.client.waitFor(
        `document.querySelector('[data-testid="task-composer-model-switcher"]')?.innerText.includes(${js(MIMO_NAME)})
          && document.querySelector('[data-testid="task-composer-model-switcher"]')?.innerText.includes(${js(MIMO_MODEL)})`,
        { description: 'composer Provider/model label', timeoutMs: STEP_TIMEOUT_MS },
      );
      const opened = await instance.client.evaluate(`(() => {
        const root = document.querySelector('[data-testid="task-composer-model-switcher"]');
        const button = root?.querySelector('[data-testid="model-quick-switcher"] button');
        if (!button || button.disabled) return false;
        button.click();
        return true;
      })()`);
      assert(opened, 'Composer model quick-switcher could not be opened.');
      await instance.client.waitFor(
        `Boolean(document.querySelector('[data-testid="task-composer-model-switcher"] [data-testid="model-quick-switcher-panel"]'))`,
        { description: 'composer model quick-switch details' },
      );
      const composer = await instance.client.evaluate(`(() => {
        const root = document.querySelector('[data-testid="task-composer-model-switcher"]');
        const panel = root?.querySelector('[data-testid="model-quick-switcher-panel"]');
        const rootRect = root?.getBoundingClientRect();
        const panelRect = panel?.getBoundingClientRect();
        return {
          text: panel?.innerText ?? '',
          opensUpward: Boolean(rootRect && panelRect && panelRect.bottom <= rootRect.top + 2),
          fitsViewport: Boolean(panelRect
            && panelRect.left >= 0 && panelRect.top >= 0
            && panelRect.right <= window.innerWidth && panelRect.bottom <= window.innerHeight),
        };
      })()`);
      for (const expected of ['Provider', 'Runtime', 'Capabilities']) {
        assert(composer.text.includes(expected), `Composer model panel is missing: ${expected}`);
      }
      assert(composer.opensUpward, 'Composer model switcher did not open upward.');
      assert(composer.fitsViewport, 'Composer model switcher panel is clipped.');
      report.screenshots.push(await captureScreenshot(
        instance.client,
        screenshotRoot,
        '04-composer-model-switcher.png',
      ));
      return {
        label: `${MIMO_NAME} / ${MIMO_MODEL}`,
        sharedTaskContext: true,
        opensUpward: true,
        fitsViewport: true,
      };
    });

    await runStep(report, 'Idle task switch confirms future calls and persists task override', async () => {
      await instance.client.evaluate(`(() => {
        window.__MODEL_PROVIDER_CONFIRMS__ = [];
        window.confirm = (message) => {
          window.__MODEL_PROVIDER_CONFIRMS__.push(String(message));
          return true;
        };
      })()`);
      const clicked = await instance.client.evaluate(`(() => {
        const option = Array.from(document.querySelectorAll('[data-testid="model-switch-option"]'))
          .find((element) => element.innerText.includes(${js(MIMO_FAST_MODEL)}));
        if (!option || option.disabled) return false;
        option.click();
        return true;
      })()`);
      assert(clicked, 'Idle MiMo Fast switch option was unavailable.');
      await instance.client.waitFor(
        `document.querySelector('[data-testid="model-quick-switcher"]')?.innerText.includes(${js(MIMO_FAST_MODEL)})`,
        { description: 'task override top label' },
      );
      await clickTestId(instance.client, 'model-quick-switcher');
      const evidence = await instance.client.evaluate(`(async () => ({
        confirms: window.__MODEL_PROVIDER_CONFIRMS__ ?? [],
        selection: await window.api.getEffectiveModelSelection({ taskId: ${js(TASK_ID)} }),
        panel: document.querySelector('[data-testid="model-quick-switcher-panel"]')?.innerText ?? '',
      }))()`);
      assert(evidence.confirms.includes('模型改变只影响后续 Agent 调用。是否继续？'), 'Idle switch did not show the future-calls confirmation.');
      assert(evidence.selection.modelId === MIMO_FAST_MODEL && evidence.selection.source === 'task_override', 'Idle switch did not create a task override.');
      assert(evidence.panel.includes('任务覆盖'), 'Top model source did not change to task override.');
      report.screenshots.push(await captureScreenshot(
        instance.client,
        screenshotRoot,
        '04-task-model-override.png',
      ));
      return {
        confirmation: FUTURE_CALLS_WARNING,
        modelId: evidence.selection.modelId,
        source: evidence.selection.source,
      };
    });

    const secondRendererErrors = [...instance.rendererErrors];
    updateTaskStatus(fixture.databasePath, 'running');
    await instance.client.send('Page.reload', { ignoreCache: true });
    await instance.client.waitFor(
      `document.readyState === 'complete'
        && document.getElementById('root')?.children.length > 0
        && Boolean(window.api)`,
      { description: 'production Renderer reload for running task', timeoutMs: STEP_TIMEOUT_MS },
    );
    report.production.rendererReloads = [{ phase: 'running-task-state', pid: instance.child.pid }];
    await instance.client.waitFor(`document.body.innerText.includes(${js(PROJECT_NAME)})`, {
      description: 'running task project after Renderer reload',
    });

    await runStep(report, 'Running task blocks UI and main-process task override', async () => {
      await instance.client.waitFor(`Boolean(document.querySelector('[data-testid="model-quick-switcher"]'))`, {
        description: 'running-task model switcher',
      });
      await clickTestId(instance.client, 'model-quick-switcher');
      await instance.client.waitFor(
        `document.querySelector('[data-testid="model-quick-switcher-panel"]')?.innerText.includes('正在运行任务时不能切换模型')`,
        { description: 'running-task switch warning' },
      );
      const ui = await instance.client.evaluate(`(() => ({
        panel: document.querySelector('[data-testid="model-quick-switcher-panel"]')?.innerText ?? '',
        everyOptionDisabled: Array.from(document.querySelectorAll('[data-testid="model-switch-option"]'))
          .every((element) => element.disabled),
      }))()`);
      assert(ui.everyOptionDisabled, 'A running task still exposed an enabled model switch option.');
      const rejected = await instance.client.evaluate(`window.api.setTaskModelOverride({
        taskId: ${js(TASK_ID)}, providerId: ${js(mimo.id)}, modelId: ${js(MIMO_MODEL)}
      }).then(() => ({ ok: true, error: '' })).catch((error) => ({ ok: false, error: String(error) }))`);
      assert(!rejected.ok && rejected.error.includes(RUNNING_SWITCH_WARNING), 'Main process did not reject a running-task model switch.');
      report.screenshots.push(await captureScreenshot(
        instance.client,
        screenshotRoot,
        '05-running-task-switch-blocked.png',
      ));
      return { uiBlocked: true, mainProcessBlocked: true, warning: RUNNING_SWITCH_WARNING };
    });

    await runStep(report, 'Export diagnostics and scan credentials', async () => {
      const identifiers = privateCredentialIdentifiers(fixture);
      capturedIdentifiers = identifiers;
      assert(identifiers.refs.length === 2, `Expected two credential references, found ${identifiers.refs.length}.`);
      const providerVaultFiles = new Set(identifiers.records.map((record) => record.vaultFile));
      assert([...providerVaultFiles].every((fileName) => identifiers.vaultFiles.includes(fileName)),
        'A Provider credential reference has no encrypted vault file.');
      assert(identifiers.vaultFiles.length === identifiers.refs.length + 1,
        `Expected two Provider vault files and one internal signing key, found ${identifiers.vaultFiles.length}.`);
      for (const fileName of identifiers.vaultFiles) {
        const bytes = fs.readFileSync(path.join(identifiers.vaultPath, fileName));
        assert(!bytes.includes(Buffer.from(mimoSecret)), 'MiMo key exists in plaintext in the credential vault.');
        assert(!bytes.includes(Buffer.from(deepSeekSecret)), 'DeepSeek key exists in plaintext in the credential vault.');
      }
      const exported = await exportDiagnosticsThroughProductionDialog(
        instance.client,
        fixture.diagnosticsDirectory,
        instance.child.pid,
      );
      let evidence;
      try {
        const bytes = fs.readFileSync(exported.exportedPath);
        const expanded = expandedArchivePayload(exported.exportedPath, fixture.root);
        const scans = scanBufferForSensitiveValues(Buffer.concat([bytes, expanded.payload]), [
          { kind: 'sentinel_api_key', values: [mimoSecret, deepSeekSecret] },
          { kind: 'credential_ref', values: identifiers.refs },
          { kind: 'vault_filename', values: identifiers.vaultFiles },
        ]);
        assert(scans.every((scan) => !scan.present), `Diagnostics archive leaked a private identifier: ${JSON.stringify(scans)}`);
        evidence = {
          archive: {
            path: `Windows Documents/${exported.fileName}`,
            sha256: sha256(bytes),
            bytes: bytes.length,
            modifiedAt: fs.statSync(exported.exportedPath).mtime.toISOString(),
          },
          nativeDialogDirectory: 'Windows Documents',
          nativeDialogDirectoryExists: fs.statSync(path.dirname(exported.exportedPath)).isDirectory(),
          nativeDialogUsedRealWindowsProfile: fixture.nativeDialogUserProfile === path.resolve(process.env.USERPROFILE ?? os.homedir()),
          defaultFilenameValidated: true,
          freshFileValidated: true,
          expandedEntryCount: expanded.entryCount,
          expandedBytes: expanded.expandedBytes,
          encryptedVaultFiles: identifiers.vaultFiles.length,
          scans,
        };
      } finally {
        const cleanup = deleteBoundDiagnosticsCandidate(exported.cleanupCandidate);
        assert(cleanup.deleted, `Diagnostics cleanup failed closed: ${cleanup.reason}`);
      }
      assert(!fs.existsSync(exported.exportedPath), 'Acceptance diagnostics artifact was not cleaned up.');
      return { ...evidence, cleanedUpAfterScan: true };
    });

    await runStep(report, 'Scan SQLite and task events for Provider private values', async () => {
      assert(capturedIdentifiers, 'Credential identifiers were not captured for SQLite scanning.');
      return sqliteSensitiveSurfaceEvidence(
        fixture,
        capturedIdentifiers,
        [mimoSecret, deepSeekSecret],
      );
    });

    await runStep(report, 'Delete DeepSeek and remove its encrypted credential', async () => {
      assert(capturedIdentifiers, 'Credential identifiers were not captured for deletion verification.');
      const deletedRecord = capturedIdentifiers.records.find((record) => record.providerId === deepSeek.id);
      assert(deletedRecord, 'DeepSeek private credential record was not found.');
      updateTaskStatus(fixture.databasePath, 'idle');
      await instance.client.send('Page.reload', { ignoreCache: true });
      await instance.client.waitFor(
        `document.readyState === 'complete'
          && document.getElementById('root')?.children.length > 0
          && Boolean(window.api)`,
        { description: 'idle Renderer reload before Provider deletion', timeoutMs: STEP_TIMEOUT_MS },
      );
      await openModelProviderCenter(instance.client);
      await selectProviderInUi(instance.client, DEEPSEEK_NAME);
      await instance.client.evaluate(`(() => {
        window.__MODEL_PROVIDER_DELETE_CONFIRMS__ = [];
        window.confirm = (message) => {
          window.__MODEL_PROVIDER_DELETE_CONFIRMS__.push(String(message));
          return true;
        };
      })()`);
      await clickTestId(instance.client, 'delete-provider');
      await instance.client.waitFor(
        `(async () => !(await window.api.listModelProviders({ limit: 100, offset: 0 }))
          .items.some((provider) => provider.id === ${js(deepSeek.id)}))()`,
        { description: 'DeepSeek Provider and credential deletion', timeoutMs: STEP_TIMEOUT_MS },
      );
      const confirmationCount = await instance.client.evaluate(
        '(window.__MODEL_PROVIDER_DELETE_CONFIRMS__ ?? []).length',
      );
      assert(confirmationCount === 1, 'DeepSeek deletion did not require exactly one credential confirmation.');
      const cleanup = assertCredentialCleanupCompleted(fixture, deletedRecord);
      const remaining = privateCredentialIdentifiers(fixture);
      assert(!remaining.refs.includes(deletedRecord.credentialRef), 'Deleted credential ref remains live.');
      assert(!remaining.vaultFiles.includes(deletedRecord.vaultFile), 'Deleted credential vault filename remains live.');
      report.screenshots.push(await captureScreenshot(
        instance.client,
        screenshotRoot,
        '06-deepseek-credential-deleted.png',
      ));
      return {
        confirmationCount,
        providerRemoved: cleanup.providerRows === 0,
        cleanupJobRemoved: cleanup.cleanupRows === 0,
        encryptedCredentialRemoved: !cleanup.vaultFileExists,
        remainingProviderCredentials: remaining.refs.length,
      };
    });

    report.rendererErrors.push(
      ...firstRendererErrors,
      ...secondRendererErrors,
      ...instance.rendererErrors,
    );
    assert(report.rendererErrors.length === 0, `Renderer reported ${report.rendererErrors.length} error(s).`);
    await stopElectron(instance);
    instance = null;

    await runStep(report, 'Scan process arguments, stdout and stderr', async () => {
      assert(capturedIdentifiers, 'Credential identifiers were not captured for process scanning.');
      const values = [
        { kind: 'sentinel_api_key', values: [mimoSecret, deepSeekSecret] },
        { kind: 'credential_ref', values: capturedIdentifiers.refs },
        { kind: 'vault_filename', values: capturedIdentifiers.vaultFiles },
      ];
      const output = Buffer.from(electronInstances.flatMap((current) => [
        ...current.stdout,
        ...current.stderr,
      ]).join(''), 'utf8');
      const argumentsBuffer = Buffer.from(electronInstances
        .flatMap((current) => current.launchArgs)
        .join('\n'), 'utf8');
      const outputScans = scanBufferForSensitiveValues(output, values);
      const argumentScans = scanBufferForSensitiveValues(argumentsBuffer, values);
      assert(outputScans.every((scan) => !scan.present), 'Electron stdout/stderr leaked a Provider private value.');
      assert(argumentScans.every((scan) => !scan.present), 'Electron process arguments leaked a Provider private value.');
      return {
        launchCount: electronInstances.length,
        outputBytes: output.length,
        outputScans,
        argumentScans,
      };
    });

    report.providerServer.requests = providerServer.requests.map((request) => ({
      method: request.method,
      pathname: request.pathname,
      credentialMatched: request.credentialMatched,
      authScheme: request.authScheme,
      model: request.model,
    }));
    report.status = 'passed';
  } catch (error) {
    failed = error;
    report.status = 'failed';
    report.error = redact(error instanceof Error ? error.message : String(error), sensitiveValues);
    if (instance) {
      try {
        report.failure = {
          bodyTail: redact((await instance.client.evaluate('document.body.innerText')).slice(-5_000), sensitiveValues),
          rendererErrors: instance.rendererErrors.map((value) => redact(value, sensitiveValues)),
        };
      } catch {
        report.failure = { rendererUnavailable: true };
      }
    }
  } finally {
    if (instance) await stopElectron(instance);
    if (fixture && fs.existsSync(fixture.databasePath)) {
      try { updateTaskStatus(fixture.databasePath, 'idle'); } catch { /* best effort fixture cleanup */ }
    }
    if (providerServer) await providerServer.close().catch(() => {});
    report.completedAt = new Date().toISOString();
    report.durationMs = Date.parse(report.completedAt) - startedAt.getTime();
    const serialized = JSON.stringify(report, null, 2);
    const reportPrivateValues = capturedIdentifiers
      ? [...sensitiveValues, ...capturedIdentifiers.refs, ...capturedIdentifiers.vaultFiles]
      : sensitiveValues;
    for (const sensitive of reportPrivateValues) {
      assert(!serialized.includes(sensitive), 'Acceptance report contains a credential sentinel.');
    }
    writeJson(options.reportPath, report);
    if (fixture) {
      if (options.keepTemp) console.log(`Retained isolated fixture: ${fixture.root}`);
      else fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
    }
  }
  if (failed) throw failed;
  console.log(`Model Provider production Electron acceptance passed: ${options.reportPath}`);
}

function runNativeDialogSafetySelfTest() {
  const helperSource = buildNativeDialogAutomationScript(4242);
  const helperWorstCaseMs = (
    NATIVE_DIALOG_FIND_ATTEMPTS
    + NATIVE_DIALOG_BUTTON_CLOSE_ATTEMPTS
    + NATIVE_DIALOG_COMMAND_CLOSE_ATTEMPTS
  ) * NATIVE_DIALOG_POLL_INTERVAL_MS;
  assert(
    helperWorstCaseMs + NATIVE_DIALOG_CLEANUP_MARGIN_MS < NATIVE_DIALOG_CHILD_TIMEOUT_MS,
    `Native dialog helper timeout cannot finish fail-closed cleanup: ${helperWorstCaseMs}ms worst case.`,
  );
  assert(
    NATIVE_DIALOG_CHILD_TIMEOUT_MS < NATIVE_DIALOG_EXPORT_TIMEOUT_MS,
    'Native dialog child timeout must expire before the Renderer export timeout.',
  );
  assert(
    helperSource.includes(`$index -lt ${NATIVE_DIALOG_FIND_ATTEMPTS}`)
      && helperSource.includes(`Start-Sleep -Milliseconds ${NATIVE_DIALOG_POLL_INTERVAL_MS}`)
      && helperSource.includes(`$expectedProcessId ${NATIVE_DIALOG_BUTTON_CLOSE_ATTEMPTS}`)
      && helperSource.includes(`$expectedProcessId ${NATIVE_DIALOG_COMMAND_CLOSE_ATTEMPTS}`),
    'Generated helper polling no longer uses the shared timeout-budget constants.',
  );
  assert(helperSource.includes('$expectedProcessId = 4242'), 'Helper did not bind the expected Electron PID.');
  assert(
    helperSource.includes('$candidate.Current.ProcessId -eq $expectedProcessId'),
    'Helper did not filter UI Automation windows by Electron PID.',
  );
  assert(
    helperSource.includes("$candidate.Current.ClassName -eq '#32770'"),
    'Helper did not require the native dialog window class.',
  );
  assert(
    helperSource.includes("$candidate.Current.Name -eq 'Export Claude Workbench diagnostics'"),
    'Helper did not require the exact diagnostics dialog title.',
  );
  const forbiddenAutomation = [
    ['Save', ' As'].join(''),
    '\u53e6\u5b58\u4e3a',
    ['SetCursor', 'Pos'].join(''),
    ['mouse', '_event'].join(''),
    ['Send', 'Keys'].join(''),
    ['Clip', 'board'].join(''),
    ['WM_', 'SETTEXT'].join(''),
  ];
  for (const forbidden of forbiddenAutomation) {
    assert(!helperSource.includes(forbidden), `Helper contains forbidden native-dialog automation: ${forbidden}`);
  }
  assert(helperSource.includes('0x00F5'), 'Helper does not use the identified Save HWND.');
  assert(helperSource.includes('0x0111'), 'Helper does not use the verified dialog IDOK fallback.');
  assert(helperSource.includes('catch {'), 'Helper does not trap unexpected PowerShell failures.');
  assert(
    helperSource.includes('$null -ne $root -and $dialogHandle -ne [System.IntPtr]::Zero')
      && helperSource.includes('Close-VerifiedDialog $root $dialogHandle $expectedProcessId'),
    'Unexpected PowerShell failures do not close only the previously verified dialog.',
  );
  assert(
    helperSource.includes('Unexpected diagnostics dialog automation failure'),
    'Unexpected PowerShell failures are not preserved in diagnostic output.',
  );

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-diagnostics-cleanup-test-'));
  const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-diagnostics-outside-test-'));
  const requestedAt = Date.now();
  const canonicalName = (timestamp) => `ClaudeWorkbench-diagnostics-${new Date(timestamp).toISOString().replace(/[:.]/gu, '-')}.zip`;
  const baselineName = canonicalName(requestedAt - 1_000);
  const explicitName = canonicalName(requestedAt);
  const otherFreshName = canonicalName(requestedAt + 1);
  const staleName = canonicalName(requestedAt - 10_000);
  const identityName = canonicalName(requestedAt + 2);
  const symlinkName = canonicalName(requestedAt + 3);
  const hardlinkName = canonicalName(requestedAt + 4);
  const outsideName = canonicalName(requestedAt + 5);
  const invalidDateName = 'ClaudeWorkbench-diagnostics-2026-07-40T22-58-20-391Z.zip';
  const invalidName = 'ClaudeWorkbench-diagnostics-latest.zip';
  const baselinePath = path.join(directory, baselineName);
  const explicitPath = path.join(directory, explicitName);
  const otherFreshPath = path.join(directory, otherFreshName);
  const stalePath = path.join(directory, staleName);
  const identityPath = path.join(directory, identityName);
  const symlinkPath = path.join(directory, symlinkName);
  const hardlinkPath = path.join(directory, hardlinkName);
  const invalidDatePath = path.join(directory, invalidDateName);
  const invalidPath = path.join(directory, invalidName);
  const outsidePath = path.join(outsideDirectory, outsideName);
  const hardlinkSourcePath = path.join(outsideDirectory, 'hardlink-source.zip');
  const symlinkTargetDirectory = path.join(outsideDirectory, 'symlink-target');
  const existingNames = new Set([baselineName]);
  const cleanupContext = { outputDirectory: directory, existingNames, requestedAt };
  try {
    fs.mkdirSync(symlinkTargetDirectory);
    for (const filePath of [
      baselinePath,
      explicitPath,
      otherFreshPath,
      stalePath,
      identityPath,
      invalidDatePath,
      invalidPath,
      outsidePath,
      hardlinkSourcePath,
    ]) {
      fs.writeFileSync(filePath, 'diagnostics fixture', 'utf8');
    }
    fs.linkSync(hardlinkSourcePath, hardlinkPath);
    fs.symlinkSync(symlinkTargetDirectory, symlinkPath, 'junction');
    fs.utimesSync(stalePath, new Date(requestedAt - 10_000), new Date(requestedAt - 10_000));
    const freshTime = new Date(requestedAt + 100);
    for (const filePath of [
      baselinePath,
      explicitPath,
      otherFreshPath,
      identityPath,
      invalidDatePath,
      invalidPath,
      outsidePath,
      hardlinkSourcePath,
    ]) {
      fs.utimesSync(filePath, freshTime, freshTime);
    }

    assert(diagnosticsArchiveCreatedAt(invalidDateName) === null, 'Invalid calendar dates were normalized instead of rejected.');
    const rejected = cleanupReturnedDiagnosticsOnFailure({ status: 'rejected', reason: new Error('fixture') }, cleanupContext);
    assert(!rejected.deleted, 'Rejected exports triggered diagnostics deletion.');
    const undefinedResult = cleanupReturnedDiagnosticsOnFailure({ status: 'fulfilled', value: undefined }, cleanupContext);
    assert(!undefinedResult.deleted, 'Missing export paths triggered diagnostics deletion.');
    assert(fs.existsSync(otherFreshPath), 'An unrelated fresh diagnostics ZIP was deleted without an explicit return path.');

    for (const protectedPath of [
      baselinePath,
      stalePath,
      invalidDatePath,
      invalidPath,
      outsidePath,
      symlinkPath,
      hardlinkPath,
    ]) {
      const result = cleanupReturnedDiagnosticsOnFailure({ status: 'fulfilled', value: protectedPath }, cleanupContext);
      assert(!result.deleted, `Unsafe diagnostics candidate was deleted: ${protectedPath}`);
      assert(fs.existsSync(protectedPath), `Protected diagnostics path was removed: ${protectedPath}`);
    }

    const inspected = inspectExactDiagnosticsCandidate(identityPath, cleanupContext);
    assert(inspected.ok, `Identity fixture was not accepted before replacement: ${inspected.reason}`);
    fs.writeFileSync(identityPath, 'replacement diagnostics payload', 'utf8');
    fs.utimesSync(identityPath, freshTime, freshTime);
    const identityMismatch = deleteBoundDiagnosticsCandidate(inspected.candidate);
    assert(!identityMismatch.deleted, 'Identity-mismatched diagnostics file was deleted.');
    assert(fs.existsSync(identityPath), 'Identity-mismatched diagnostics file was not preserved.');

    const explicit = cleanupReturnedDiagnosticsOnFailure({ status: 'fulfilled', value: explicitPath }, cleanupContext);
    assert(explicit.deleted, `Explicit fresh diagnostics path was not deleted: ${explicit.reason}`);
    assert(!fs.existsSync(explicitPath), 'Explicit fresh diagnostics path still exists after cleanup.');
    for (const preserved of [
      baselinePath,
      otherFreshPath,
      stalePath,
      identityPath,
      invalidDatePath,
      invalidPath,
      outsidePath,
      symlinkPath,
      hardlinkPath,
    ]) {
      assert(fs.existsSync(preserved), `Cleanup removed a protected diagnostics path: ${preserved}`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(outsideDirectory, { recursive: true, force: true });
  }
  console.log('Native diagnostics dialog safety self-test passed.');
}

if (process.argv.includes('--self-test-native-dialog-safety')) {
  runNativeDialogSafetySelfTest();
} else {
  await main();
}
