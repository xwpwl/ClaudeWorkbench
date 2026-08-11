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

const TEMP_PREFIX = 'claude-workbench-crash-recovery-acceptance-';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(SCRIPT_DIR, '..');
const PROJECT_ID = 'crash-recovery-project';
const TASK_ID = 'crash-recovery-task';
const PROJECT_NAME = 'Crash Recovery Acceptance Project';
const SENTINEL_CONTENT = 'CW_RECOVERY_SECRET_SENTINEL_do_not_log_or_overwrite';
const REPORT_DEFAULT = path.join(WORKSPACE_ROOT, 'release-validation', 'crash-recovery.json');

function parseArguments(argv) {
  const options = { build: true, keepTemp: false, reportPath: REPORT_DEFAULT };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--skip-build') options.build = false;
    else if (argument === '--keep-temp') options.keepTemp = true;
    else if (argument === '--report') {
      const value = argv[index + 1];
      if (!value) throw new Error('--report requires a file path.');
      options.reportPath = path.resolve(argv[++index]);
    } else if (argument === '--help') {
      console.log([
        'Usage: node scripts/electron-crash-recovery-acceptance.mjs [options]',
        '',
        '  --skip-build     Reuse the current production dist/ output.',
        '  --report <path>  Write the JSON evidence to an explicit path.',
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

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function snapshotFile(filePath) {
  const stat = fs.statSync(filePath);
  return {
    sha256: hashFile(filePath),
    size: stat.size,
    modifiedMs: stat.mtimeMs,
  };
}

function assertBuildOutputs() {
  const outputs = [
    path.join(WORKSPACE_ROOT, 'dist', 'main', 'index.js'),
    path.join(WORKSPACE_ROOT, 'dist', 'preload', 'index.js'),
    path.join(WORKSPACE_ROOT, 'dist', 'renderer', 'index.html'),
  ];
  for (const output of outputs) assert(fs.existsSync(output), `Production build output is missing: ${output}`);
  return outputs;
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

    const sentinelPath = path.join(projectPath, 'recovery-sentinel.txt');
    fs.writeFileSync(sentinelPath, SENTINEL_CONTENT, 'utf8');
    const now = new Date().toISOString();
    const bootstrapAt = new Date(Date.now() - 60_000).toISOString();
    const databasePath = path.join(dataRoot, 'claude-workbench.db');
    // AppDatabase imports this legacy JSON atomically and upgrades it through the
    // same production migration path used by an existing profile.
    writeJson(databasePath, {
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
        [TASK_ID]: {
          id: TASK_ID,
          project_id: PROJECT_ID,
          title: 'Interrupted release acceptance task',
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
      databasePath,
      browserDataRoot,
      isolatedHome,
      appData,
      localAppData,
      runtimeTemp,
      projectPath,
      sentinelPath,
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
    FORCE_FAKE: '1',
    HOME: fixture.isolatedHome,
    USERPROFILE: fixture.isolatedHome,
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

async function launchElectron(fixture) {
  const port = await reservePort();
  const electronPath = electron.default || electron;
  const child = spawn(electronPath, [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${fixture.browserDataRoot}`,
    '.',
  ], {
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
      rendererErrors.push(params.args?.map((item) => item.value ?? item.description ?? '').join(' ')
        || 'Renderer console error');
    });
    await Promise.all([
      client.send('Runtime.enable'),
      client.send('Page.enable'),
      client.send('Log.enable'),
    ]);
    await client.waitFor(
      `document.readyState === 'complete' && document.getElementById('root')?.children.length > 0 && Boolean(window.api)`,
      { description: 'production Workbench renderer and preload API', timeoutMs: 30_000 },
    );
    return { child, client, port, stdout, stderr, rendererErrors };
  } catch (error) {
    client?.close();
    if (child.pid && child.exitCode === null) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      });
    }
    throw error;
  }
}

async function crashElectron(instance) {
  const pid = instance.child.pid;
  assert(pid, 'Electron process has no PID for the crash simulation.');
  instance.client.close();
  let method;
  let status;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    method = 'taskkill /T /F';
    status = result.status;
    assert(!result.error && result.status === 0, `Crash simulation taskkill failed: ${result.stderr || result.error?.message}`);
  } else {
    process.kill(pid, 'SIGKILL');
    method = 'SIGKILL';
    status = 0;
  }
  assert(await waitForProcessExit(instance.child, 10_000), 'Crashed Electron process did not exit.');
  return { pid, method, commandStatus: status, exitCode: instance.child.exitCode, signal: instance.child.signalCode };
}

async function stopElectronGracefully(instance) {
  if (!instance) return false;
  try {
    await instance.client.evaluate('window.close()');
  } catch {
    // A successful window close commonly closes CDP before evaluate returns.
  }
  instance.client.close();
  if (await waitForProcessExit(instance.child, 20_000)) return true;
  const pid = instance.child.pid;
  if (pid && process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else if (pid) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
  }
  await waitForProcessExit(instance.child, 5_000);
  return false;
}

function seedInterruptedState(fixture, instance, workflowId) {
  const database = new BetterSqlite3(fixture.databasePath, { timeout: 5_000 });
  try {
    database.pragma('busy_timeout = 5000');
    const appRun = database.prepare(`
      SELECT * FROM app_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1
    `).get();
    assert(appRun, 'First production app run was not journaled.');
    const workflow = database.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId);
    assert(workflow, 'Workflow created through production IPC is missing.');
    const metadata = JSON.parse(workflow.metadata_json);
    metadata.activeStage = 'coder';
    metadata.reviewRound = 1;
    metadata.executionCycle = 1;
    metadata.revision = Number(metadata.revision || 0) + 1;
    metadata.plan = {
      title: 'Crash recovery acceptance plan',
      summary: 'The interrupted run must never restart automatically.',
      steps: [{ id: 1, title: 'Preserve the project sentinel', risk: 'high' }],
      filesExpected: ['recovery-sentinel.txt'],
      estimatedChanges: '1 file',
      riskLevel: 'high',
    };
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    const sentinel = snapshotFile(fixture.sentinelPath);
    database.transaction(() => {
      database.prepare(`
        UPDATE sessions SET status = 'running', completed_at = NULL, updated_at = ? WHERE id = ?
      `).run(startedAt, TASK_ID);
      database.prepare(`
        UPDATE tasks SET status = 'running', agent_mode = 'plan', started_at = ?,
          completed_at = NULL, updated_at = ? WHERE id = ?
      `).run(startedAt, startedAt, TASK_ID);
      database.prepare(`
        UPDATE workflows SET status = 'executing', current_stage = 'coder', updated_at = ?,
          metadata_json = ? WHERE id = ?
      `).run(startedAt, JSON.stringify(metadata), workflowId);
      database.prepare(`
        INSERT INTO workflow_steps
          (id, workflow_id, agent_type, review_round, status, input, output, error, started_at, completed_at)
        VALUES (?, ?, 'coder', 1, 'running', ?, NULL, NULL, ?, NULL)
      `).run('crash-recovery-coder-stage', workflowId, JSON.stringify({ prompt: metadata.prompt }), startedAt);
      database.prepare(`
        INSERT INTO managed_processes
          (id, app_run_id, kind, pid, parent_pid, creation_time, executable_path, launch_nonce,
           project_id, session_id, task_id, run_id, state, started_at)
        VALUES (?, ?, 'claude', ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, 'running', ?)
      `).run(
        'crash-recovery-process', appRun.id, instance.child.pid,
        'crash-recovery-launch-nonce', PROJECT_ID, TASK_ID, TASK_ID,
        'crash-recovery-agent-run', startedAt,
      );
      database.prepare(`
        INSERT INTO permission_requests
          (id, app_run_id, project_id, session_id, task_id, run_id, tool_name,
           status, requested_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, 'Write', 'pending', ?, NULL)
      `).run(
        'crash-recovery-permission', appRun.id, PROJECT_ID, TASK_ID, TASK_ID,
        'crash-recovery-agent-run', startedAt,
      );
      database.prepare(`
        INSERT INTO mutation_operations
          (id, app_run_id, project_id, project_path, session_id, task_id, run_id, kind,
           status, file_paths_json, fingerprint_json, started_at, completed_at, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'claude_edit', 'running', ?, ?, ?, NULL, NULL)
      `).run(
        'crash-recovery-mutation', appRun.id, PROJECT_ID, fixture.projectPath, TASK_ID, TASK_ID,
        'crash-recovery-agent-run', JSON.stringify([fixture.sentinelPath]),
        JSON.stringify({ [fixture.sentinelPath]: sentinel.sha256 }), startedAt,
      );
    })();
    return {
      appRunId: appRun.id,
      appRunPid: appRun.pid,
      workflowId,
      stageId: 'crash-recovery-coder-stage',
      processId: 'crash-recovery-process',
      permissionId: 'crash-recovery-permission',
      mutationId: 'crash-recovery-mutation',
      seededAt: startedAt,
      sentinel,
    };
  } finally {
    database.close();
  }
}

function readDatabaseEvidence(databasePath, ids) {
  const database = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
  try {
    const one = (sql, value) => database.prepare(sql).get(value);
    return {
      userVersion: database.pragma('user_version', { simple: true }),
      integrity: database.pragma('integrity_check', { simple: true }),
      foreignKeyViolations: database.pragma('foreign_key_check'),
      sourceAppRun: one('SELECT * FROM app_runs WHERE id = ?', ids.appRunId),
      currentAppRun: database.prepare('SELECT * FROM app_runs ORDER BY started_at DESC LIMIT 1').get(),
      task: one('SELECT * FROM tasks WHERE id = ?', TASK_ID),
      session: one('SELECT * FROM sessions WHERE id = ?', TASK_ID),
      workflow: one('SELECT * FROM workflows WHERE id = ?', ids.workflowId),
      stage: one('SELECT * FROM workflow_steps WHERE id = ?', ids.stageId),
      process: one('SELECT * FROM managed_processes WHERE id = ?', ids.processId),
      permission: one('SELECT * FROM permission_requests WHERE id = ?', ids.permissionId),
      mutation: one('SELECT * FROM mutation_operations WHERE id = ?', ids.mutationId),
      recoveryItems: database.prepare(`
        SELECT id, kind, resource_id, task_id, last_state, reason, status, detected_at, resolved_at,
          resolution_json FROM recovery_items ORDER BY kind, id
      `).all(),
    };
  } finally {
    database.close();
  }
}

function scanLogs(logsDirectory) {
  if (!fs.existsSync(logsDirectory)) return { files: [], sentinelFound: false };
  const files = fs.readdirSync(logsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(logsDirectory, entry.name));
  const sentinelFound = files.some((filePath) => fs.readFileSync(filePath).includes(SENTINEL_CONTENT));
  return { files: files.map((filePath) => path.basename(filePath)), sentinelFound };
}

function safelyRemoveFixture(root) {
  const tempRoot = path.resolve(os.tmpdir());
  const target = path.resolve(root);
  assert(path.dirname(target) === tempRoot, `Refusing to remove non-temp fixture: ${target}`);
  assert(path.basename(target).startsWith(TEMP_PREFIX), `Refusing to remove unexpected fixture: ${target}`);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
}

function publicRow(row) {
  if (!row) return null;
  const result = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.endsWith('_json')) {
      try { result[key] = value === null ? null : JSON.parse(value); } catch { result[key] = '<invalid-json>'; }
    } else {
      result[key] = value;
    }
  }
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.build) runNpm(['run', 'build']);
  const buildOutputs = assertBuildOutputs();
  const fixture = createFixture();
  let firstInstance = null;
  let secondInstance = null;
  let report;
  try {
    firstInstance = await launchElectron(fixture);
    const firstRelease = await firstInstance.client.evaluate('window.api.getReleaseVersion()');
    const workflow = await firstInstance.client.evaluate(`window.api.createWorkflow(${JSON.stringify({
      taskId: TASK_ID,
      prompt: 'Verify that an interrupted code-writing workflow is never resumed automatically.',
      currentPermissionMode: 'default',
    })})`);
    assert(workflow?.id, 'Production workflow creation IPC did not return an id.');
    const seeded = seedInterruptedState(fixture, firstInstance, workflow.id);
    const sentinelBeforeCrash = snapshotFile(fixture.sentinelPath);
    assert(sentinelBeforeCrash.sha256 === seeded.sentinel.sha256, 'Sentinel changed while seeding active state.');

    const crash = await crashElectron(firstInstance);
    firstInstance = null;
    const afterCrashBeforeRestart = readDatabaseEvidence(fixture.databasePath, seeded);
    assert(afterCrashBeforeRestart.sourceAppRun.status === 'running', 'Crash unexpectedly ran clean shutdown logic.');
    assert(afterCrashBeforeRestart.task.status === 'running', 'Task changed before recovery startup.');

    secondInstance = await launchElectron(fixture);
    const recoverySnapshot = await secondInstance.client.evaluate('window.api.getRecoveryCenter()');
    assert(recoverySnapshot.abnormalExitDetected === true, 'Recovery API did not report the abnormal exit.');
    const kinds = new Set(recoverySnapshot.items.map((item) => item.kind));
    for (const kind of ['task', 'workflow', 'process', 'permission', 'mutation']) {
      assert(kinds.has(kind), `Recovery Center is missing ${kind} evidence.`);
    }
    await secondInstance.client.waitFor(
      `Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'))`,
      { description: 'Recovery Center dialog', timeoutMs: 15_000 },
    );
    const recoveryUi = await secondInstance.client.evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
      return {
        visible: Boolean(dialog),
        articleCount: dialog?.querySelectorAll('article').length ?? 0,
        resourceIds: Array.from(dialog?.querySelectorAll('article') ?? [])
          .map((article) => article.textContent ?? ''),
      };
    })()`);
    assert(recoveryUi.articleCount === recoverySnapshot.items.length, 'Recovery Center UI does not match IPC items.');

    // Give any accidental autonomous continuation ample time to show itself.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const sentinelAfterRecoveryStartup = snapshotFile(fixture.sentinelPath);
    assert(
      sentinelAfterRecoveryStartup.sha256 === sentinelBeforeCrash.sha256
        && fs.readFileSync(fixture.sentinelPath, 'utf8') === SENTINEL_CONTENT,
      'Recovery startup overwrote the project sentinel.',
    );
    const activeTasks = await secondInstance.client.evaluate('window.api.listActiveTasks()');
    assert(activeTasks.length === 0, 'Recovery startup automatically recreated an active task.');
    const interruptedEvidence = readDatabaseEvidence(fixture.databasePath, seeded);
    assert(interruptedEvidence.task.status === 'interrupted', 'Task was not interrupted on restart.');
    assert(interruptedEvidence.session.status === 'interrupted', 'Session was not interrupted on restart.');
    assert(interruptedEvidence.workflow.status === 'paused', 'Workflow was not paused on restart.');
    assert(interruptedEvidence.workflow.current_stage === null, 'Workflow retained an active stage on restart.');
    assert(interruptedEvidence.stage.status === 'interrupted', 'Running workflow stage was not interrupted.');
    assert(interruptedEvidence.process.state === 'orphaned_unverified', 'Persisted process PID was trusted unexpectedly.');
    assert(interruptedEvidence.permission.status === 'interrupted', 'Pending permission was not cleared.');
    assert(interruptedEvidence.mutation.status === 'interrupted', 'Active mutation was not interrupted.');

    const releaseVersion = await secondInstance.client.evaluate('window.api.getReleaseVersion()');
    const updateBefore = await secondInstance.client.evaluate('window.api.getUpdateState()');
    const updateAfterCheck = await secondInstance.client.evaluate('window.api.checkForUpdates()');
    const installWithoutDownload = await secondInstance.client.evaluate('window.api.installUpdate(true)');
    assert(releaseVersion.version === '1.0.0', `Unexpected release version: ${releaseVersion.version}`);
    assert(updateBefore.status === 'idle', 'Update manager did not start idle.');
    assert(
      updateAfterCheck.status === 'disabled' && updateAfterCheck.reason === 'development',
      'Unpackaged production runner did not fail closed for updates.',
    );
    assert(installWithoutDownload === false, 'Updater accepted installation without a downloaded update.');

    const workflowRecovery = recoverySnapshot.items.find((item) => item.kind === 'workflow');
    assert(workflowRecovery, 'Workflow recovery item is missing.');
    const clickedRollback = await secondInstance.client.evaluate(`(() => {
      const article = Array.from(document.querySelectorAll('[role="dialog"] article'))
        .find((candidate) => candidate.textContent?.includes(${JSON.stringify(workflowRecovery.resourceId)}));
      const buttons = Array.from(article?.querySelectorAll('button') ?? []);
      const abandon = buttons.at(-1);
      if (!abandon || abandon.disabled) return false;
      abandon.click();
      return true;
    })()`);
    assert(clickedRollback, 'Could not execute explicit rollback through the Recovery Center UI.');
    await secondInstance.client.waitFor(
      `(async () => (await window.api.getRecoveryCenter()).items.length === 0)()`,
      { description: 'explicit recovery rollback', timeoutMs: 15_000 },
    );
    await secondInstance.client.waitFor(
      `!document.querySelector('[role="dialog"][aria-modal="true"]')`,
      { description: 'closed Recovery Center after rollback', timeoutMs: 15_000 },
    );
    const rollbackSnapshot = await secondInstance.client.evaluate('window.api.getRecoveryCenter()');
    const sentinelAfterRollback = snapshotFile(fixture.sentinelPath);
    assert(sentinelAfterRollback.sha256 === sentinelBeforeCrash.sha256, 'Explicit rollback changed project files.');
    const rollbackEvidence = readDatabaseEvidence(fixture.databasePath, seeded);
    assert(rollbackEvidence.task.status === 'cancelled', 'Rollback did not cancel the interrupted task.');
    assert(rollbackEvidence.session.status === 'cancelled', 'Rollback did not cancel the interrupted session.');
    assert(rollbackEvidence.workflow.status === 'cancelled', 'Rollback did not cancel the paused workflow.');
    assert(
      rollbackEvidence.recoveryItems.every((item) => item.status === 'abandoned'),
      'Rollback left related recovery work unresolved.',
    );

    const secondRendererErrors = [...secondInstance.rendererErrors];
    const graceful = await stopElectronGracefully(secondInstance);
    secondInstance = null;
    assert(graceful, 'Second Electron run required force termination.');
    const finalEvidence = readDatabaseEvidence(fixture.databasePath, seeded);
    assert(finalEvidence.currentAppRun.status === 'clean', 'Second app run did not journal a clean shutdown.');
    assert(finalEvidence.integrity === 'ok', `SQLite integrity check failed: ${finalEvidence.integrity}`);
    assert(finalEvidence.foreignKeyViolations.length === 0, 'SQLite foreign key check failed.');
    const logScan = scanLogs(path.join(fixture.dataRoot, 'logs'));
    assert(logScan.sentinelFound === false, 'Project sentinel secret leaked into production logs.');

    report = {
      success: true,
      generatedAt: new Date().toISOString(),
      mode: {
        electron: 'real Electron process',
        assets: 'production dist/main + dist/preload + dist/renderer',
        adapter: 'FORCE_FAKE=1 (recovery lifecycle only; no model call)',
        isolatedDataDirectory: true,
      },
      buildOutputs,
      firstRun: {
        release: firstRelease,
        appRunId: seeded.appRunId,
        workflowId: seeded.workflowId,
        crash,
        stateBeforeRestart: {
          appRun: publicRow(afterCrashBeforeRestart.sourceAppRun),
          task: publicRow(afterCrashBeforeRestart.task),
          workflow: publicRow(afterCrashBeforeRestart.workflow),
        },
      },
      restartRecovery: {
        abnormalExitDetected: recoverySnapshot.abnormalExitDetected,
        recoveryAppRunId: recoverySnapshot.appRunId,
        items: recoverySnapshot.items,
        ui: recoveryUi,
        activeTaskCount: activeTasks.length,
        persisted: {
          crashedAppRun: publicRow(interruptedEvidence.sourceAppRun),
          task: publicRow(interruptedEvidence.task),
          session: publicRow(interruptedEvidence.session),
          workflow: publicRow(interruptedEvidence.workflow),
          stage: publicRow(interruptedEvidence.stage),
          process: publicRow(interruptedEvidence.process),
          permission: publicRow(interruptedEvidence.permission),
          mutation: publicRow(interruptedEvidence.mutation),
        },
      },
      noAutomaticProjectWrites: {
        waitAfterRestartMs: 2_000,
        beforeCrash: sentinelBeforeCrash,
        afterRecoveryStartup: sentinelAfterRecoveryStartup,
        unchanged: sentinelAfterRecoveryStartup.sha256 === sentinelBeforeCrash.sha256,
      },
      explicitRollback: {
        action: 'Recovery Center UI abandon workflow',
        itemId: workflowRecovery.id,
        pendingItemsAfter: rollbackSnapshot.items.length,
        sentinelAfterRollback,
        persisted: {
          task: publicRow(rollbackEvidence.task),
          session: publicRow(rollbackEvidence.session),
          workflow: publicRow(rollbackEvidence.workflow),
          recoveryItems: rollbackEvidence.recoveryItems.map(publicRow),
        },
      },
      releaseFoundation: {
        version: releaseVersion,
        updateBefore,
        updateAfterExplicitCheck: updateAfterCheck,
        installWithoutDownload,
      },
      logs: logScan,
      rendererErrors: {
        firstRun: firstInstance?.rendererErrors ?? [],
        secondRun: secondRendererErrors,
      },
      database: {
        userVersion: finalEvidence.userVersion,
        integrity: finalEvidence.integrity,
        foreignKeyViolations: finalEvidence.foreignKeyViolations,
        secondAppRun: publicRow(finalEvidence.currentAppRun),
      },
      diagnosticsExportAutomation: {
        guiSaveDialogInvoked: false,
        reason: 'The production export API intentionally requires a native user-selected destination; the acceptance harness does not add a test-only bypass.',
        evidenceBoundary: 'Structured logger and ZIP exporter are covered by their focused production-code tests; this run scans real JSONL logs for the project sentinel.',
      },
      rendererErrorCount: secondRendererErrors.length,
      disposableFixtureRemoved: !options.keepTemp,
      ...(options.keepTemp ? { retainedFixture: fixture.root } : {}),
    };
    assert(secondRendererErrors.length === 0, `Renderer reported errors: ${secondRendererErrors.join('\n')}`);
    writeJson(options.reportPath, report);
    console.log(JSON.stringify({
      success: true,
      report: options.reportPath,
      recoveryItems: recoverySnapshot.items.length,
      rollbackPendingItems: rollbackSnapshot.items.length,
      databaseIntegrity: finalEvidence.integrity,
      sentinelUnchanged: true,
    }, null, 2));
  } catch (error) {
    report = {
      success: false,
      generatedAt: new Date().toISOString(),
      error: error instanceof Error ? error.stack ?? error.message : String(error),
      retainedFixture: fixture.root,
      firstStdout: firstInstance?.stdout.join('').slice(-4_000) ?? '',
      firstStderr: firstInstance?.stderr.join('').slice(-4_000) ?? '',
      secondStdout: secondInstance?.stdout.join('').slice(-4_000) ?? '',
      secondStderr: secondInstance?.stderr.join('').slice(-4_000) ?? '',
    };
    writeJson(options.reportPath, report);
    throw error;
  } finally {
    if (firstInstance) await stopElectronGracefully(firstInstance);
    if (secondInstance) await stopElectronGracefully(secondInstance);
    if (report?.success && !options.keepTemp) safelyRemoveFixture(fixture.root);
  }
}

await main();
