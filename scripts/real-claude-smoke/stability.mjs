import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import electron from 'electron';
import { CdpClient, waitForCdpPage } from '../lib/cdp-client.mjs';
import {
  assert,
  directorySize,
  disposableRoot,
  monotonicNow,
  redact,
  removeDisposableRoot,
  reservePort,
  runChecked,
  safeError,
  stopProcessTree,
  writeJson,
} from './support.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const TEMP_PREFIX = 'claude-workbench-stability-';
const DEFAULT_DURATION_MS = 30 * 60_000;
const DEFAULT_SAMPLE_MS = 10_000;
const PROJECT_ID = 'release-stability-project';

function parseArguments(argv) {
  const options = {
    durationMs: DEFAULT_DURATION_MS,
    sampleMs: DEFAULT_SAMPLE_MS,
    keepTemp: false,
    reportPath: null,
    exerciseAgent: true,
    taskIntervalMs: 1_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--duration-ms') {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 5_000 || value > 24 * 60 * 60_000) {
        throw new Error('--duration-ms must be an integer between 5000 and 86400000.');
      }
      options.durationMs = value;
    } else if (argument === '--sample-ms') {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 500 || value > 60_000) {
        throw new Error('--sample-ms must be an integer between 500 and 60000.');
      }
      options.sampleMs = value;
    } else if (argument === '--report') {
      const value = argv[++index];
      if (!value) throw new Error('--report requires a path.');
      options.reportPath = path.resolve(value);
    } else if (argument === '--idle') options.exerciseAgent = false;
    else if (argument === '--task-interval-ms') {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 250 || value > 60_000) {
        throw new Error('--task-interval-ms must be an integer between 250 and 60000.');
      }
      options.taskIntervalMs = value;
    } else if (argument === '--keep-temp') options.keepTemp = true;
    else if (argument === '--help') {
      console.log([
        'Usage: node scripts/real-claude-smoke/stability.mjs [options]',
        '',
        'Starts the production Electron build with isolated data and samples process/renderer/database metrics.',
        '',
        '  --duration-ms <ms>  Soak duration (default: 1800000 / 30 minutes).',
        '  --sample-ms <ms>    Sampling interval (default: 10000).',
        '  --task-interval-ms  Deterministic Agent Task interval (default: 1000).',
        '  --idle              Disable the continuous deterministic Agent Task workload.',
        '  --report <path>     Persist the metadata-only JSON report.',
        '  --keep-temp         Keep isolated Workbench/Chromium data.',
      ].join('\n'));
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  assert(options.sampleMs <= options.durationMs, '--sample-ms cannot exceed --duration-ms.');
  return options;
}

function assertBuildOutputs() {
  for (const relativePath of ['dist/main/index.js', 'dist/preload/index.js', 'dist/renderer/index.html']) {
    const output = path.join(WORKSPACE_ROOT, ...relativePath.split('/'));
    assert(fs.existsSync(output), `Missing production build output: ${output}. Run npm run build first.`);
  }
}

function createFixture() {
  const root = disposableRoot(TEMP_PREFIX);
  const dataRoot = path.join(root, 'workbench-data');
  const browserDataRoot = path.join(root, 'chromium-profile');
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(browserDataRoot, { recursive: true });
  const projectPath = path.join(root, 'project');
  fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'src', 'fixture.js'), "export const stabilityFixture = true;\n", 'utf8');
  fs.writeFileSync(path.join(projectPath, 'package.json'), `${JSON.stringify({
    name: 'claude-workbench-stability-fixture',
    private: true,
    type: 'module',
    scripts: { test: 'node --test' },
  }, null, 2)}\n`, 'utf8');
  runChecked('git', ['init', '--quiet'], { cwd: projectPath });
  runChecked('git', ['add', '--all'], { cwd: projectPath });
  runChecked('git', [
    '-c', 'user.name=Claude Workbench Stability',
    '-c', 'user.email=stability@example.invalid',
    'commit', '--quiet', '-m', 'stability baseline',
  ], { cwd: projectPath });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dataRoot, 'claude-workbench.db'), `${JSON.stringify({
    projects: {
      [PROJECT_ID]: {
        id: PROJECT_ID,
        name: 'Release Stability Project',
        path: projectPath,
        created_at: now,
        last_opened_at: now,
      },
    },
    sessions: {},
    messages: {},
    events: {},
    fileChanges: {},
    settings: { language: 'zh-CN', theme: 'light' },
  }, null, 2)}\n`, 'utf8');
  return {
    root,
    dataRoot,
    browserDataRoot,
    dbPath: path.join(dataRoot, 'claude-workbench.db'),
    logsPath: path.join(dataRoot, 'logs'),
    projectPath,
  };
}

function js(value) {
  return JSON.stringify(value).replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');
}

function canonicalProjectKey(projectPath) {
  return projectPath.trim().replace(/\\/gu, '/').replace(/\/+$/gu, '').toLocaleLowerCase('en-US');
}

async function startAgentWorkload(client, fixture, intervalMs) {
  const projectKey = canonicalProjectKey(fixture.projectPath);
  await client.evaluate(`(() => {
    const state = window.__releaseStabilityWorkload = {
      started: 0,
      completed: 0,
      failed: 0,
      lastError: null,
      running: true,
      stop: false,
    };
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const runOne = async () => {
      const sessionId = await window.api.createSession(${js(PROJECT_ID)});
      const runId = crypto.randomUUID();
      state.started += 1;
      let unsubscribe = () => {};
      let timeout = null;
      const terminal = new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
          unsubscribe();
          reject(new Error('Deterministic Agent Task timed out.'));
        }, 15000);
        unsubscribe = window.api.onClaudeEvent((envelope) => {
          if (envelope.runId !== runId) return;
          if (envelope.event.type !== 'session_completed' && envelope.event.type !== 'session_failed') return;
          clearTimeout(timeout);
          unsubscribe();
          if (envelope.event.type === 'session_completed') resolve();
          else reject(new Error('Deterministic Agent Task failed.'));
        });
      });
      try {
        await window.api.runPrompt({
          runId,
          projectKey: ${js(projectKey)},
          sessionKey: ${js(`${projectKey}::`)} + sessionId,
          projectPath: ${js(fixture.projectPath)},
          prompt: 'Release stability deterministic Agent Task ' + state.started,
          permissionMode: 'default',
          agentMode: 'develop',
        });
        await terminal;
        const releaseDeadline = performance.now() + 10000;
        while ((await window.api.listActiveTasks()).some((task) => task.runId === runId)) {
          if (performance.now() >= releaseDeadline) throw new Error('Agent Task finalizer did not release its project lock.');
          await wait(25);
        }
        state.completed += 1;
      } catch (error) {
        if (timeout) clearTimeout(timeout);
        unsubscribe();
        throw error;
      }
    };
    void (async () => {
      while (!state.stop) {
        const cycleStartedAt = performance.now();
        try { await runOne(); }
        catch (error) {
          state.failed += 1;
          state.lastError = String(error?.message || error).slice(0, 500);
        }
        const remaining = ${intervalMs} - (performance.now() - cycleStartedAt);
        if (!state.stop && remaining > 0) await wait(remaining);
      }
      state.running = false;
    })();
  })()`);
}

async function stopAgentWorkload(client) {
  await client.evaluate(`(async () => {
    const state = window.__releaseStabilityWorkload;
    if (!state) return null;
    state.stop = true;
    const deadline = performance.now() + 20000;
    while (state.running && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { ...state };
  })()`, { timeoutMs: 25_000 }).catch((error) => ({
    stopError: safeError(error),
  }));
  return client.evaluate('window.__releaseStabilityWorkload ? ({ ...window.__releaseStabilityWorkload }) : null')
    .catch((error) => ({ readError: safeError(error) }));
}

async function delay(ms, signal) {
  if (signal?.aborted) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function processRowsWindows({ rootPid = null, pids = [] } = {}) {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$rows = @(Get-CimInstance Win32_Process)',
    "$rootPid = if ($env:WORKBENCH_SAMPLE_ROOT_PID) { [int]$env:WORKBENCH_SAMPLE_ROOT_PID } else { 0 }",
    "$explicitPids = @($env:WORKBENCH_SAMPLE_PIDS -split ',' | Where-Object { $_ } | ForEach-Object { [int]$_ })",
    'if ($rootPid -gt 0) {',
    '  $wanted = [System.Collections.Generic.HashSet[int]]::new()',
    '  [void]$wanted.Add($rootPid)',
    '  $changed = $true',
    '  while ($changed) {',
    '    $changed = $false',
    '    foreach ($row in $rows) {',
    '      if ($wanted.Contains([int]$row.ParentProcessId) -and $wanted.Add([int]$row.ProcessId)) { $changed = $true }',
    '    }',
    '  }',
    '  $rows = @($rows | Where-Object { $wanted.Contains([int]$_.ProcessId) })',
    '} elseif ($explicitPids.Count -gt 0) {',
    '  $wanted = [System.Collections.Generic.HashSet[int]]::new()',
    '  foreach ($pidValue in $explicitPids) { [void]$wanted.Add($pidValue) }',
    '  $rows = @($rows | Where-Object { $wanted.Contains([int]$_.ProcessId) })',
    '}',
    '$result = foreach ($row in $rows) {',
    '  $process = Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue',
    '  [PSCustomObject]@{',
    '    pid = [int]$row.ProcessId',
    '    ppid = [int]$row.ParentProcessId',
    '    rssBytes = if ($process) { [int64]$process.WorkingSet64 } else { 0 }',
    '    handles = if ($process) { [int]$process.HandleCount } else { 0 }',
    '    creationTime = [string]$row.CreationDate',
    '    name = [string]$row.Name',
    '  }',
    '}',
    '@($result) | ConvertTo-Json -Compress',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    env: {
      ...process.env,
      WORKBENCH_SAMPLE_ROOT_PID: rootPid === null ? '' : String(rootPid),
      WORKBENCH_SAMPLE_PIDS: pids.map((pid) => String(pid)).join(','),
    },
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) throw new Error(`Unable to sample Windows processes: ${redact(result.error?.message ?? result.stderr)}`);
  const parsed = JSON.parse(result.stdout || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

function processRowsPosix() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,rss=,etime=,comm='], {
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) throw new Error(`Unable to sample processes: ${redact(result.error?.message ?? result.stderr)}`);
  return result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(line);
    if (!match) return null;
    return {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      handles: (() => {
        try { return fs.readdirSync(`/proc/${match[1]}/fd`).length; } catch { return 0; }
      })(),
      creationTime: match[4],
      name: match[5],
    };
  }).filter(Boolean);
}

function allProcessRows(options) {
  return process.platform === 'win32' ? processRowsWindows(options) : processRowsPosix();
}

function processTree(rows, rootPid) {
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => descendants.has(row.pid));
}

function databaseMetrics(dbPath) {
  const familyBytes = ['', '-wal', '-shm'].reduce((total, suffix) => {
    const candidate = `${dbPath}${suffix}`;
    return total + (fs.existsSync(candidate) ? fs.statSync(candidate).size : 0);
  }, 0);
  if (!fs.existsSync(dbPath)) return { familyBytes, eventCount: 0, taskCount: 0, schemaVersion: 0 };
  let database;
  try {
    database = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
    const hasTable = (name) => Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(name));
    return {
      familyBytes,
      eventCount: hasTable('events') ? database.prepare('SELECT COUNT(*) AS count FROM events').get().count : 0,
      taskCount: hasTable('tasks') ? database.prepare('SELECT COUNT(*) AS count FROM tasks').get().count : 0,
      schemaVersion: Number(database.pragma('user_version', { simple: true }) || 0),
    };
  } catch (error) {
    return { familyBytes, eventCount: null, taskCount: null, schemaVersion: null, readError: safeError(error) };
  } finally {
    database?.close();
  }
}

function metricValue(metrics, name) {
  return metrics.find((entry) => entry.name === name)?.value ?? null;
}

async function rendererMetrics(client) {
  const response = await client.send('Performance.getMetrics');
  const metrics = response.metrics ?? [];
  return {
    jsHeapUsedBytes: metricValue(metrics, 'JSHeapUsedSize'),
    jsHeapTotalBytes: metricValue(metrics, 'JSHeapTotalSize'),
    nodes: metricValue(metrics, 'Nodes'),
    documents: metricValue(metrics, 'Documents'),
    jsEventListeners: metricValue(metrics, 'JSEventListeners'),
    layoutCount: metricValue(metrics, 'LayoutCount'),
    taskDurationSeconds: metricValue(metrics, 'TaskDuration'),
  };
}

function aggregateSamples(samples) {
  const first = samples[0];
  const last = samples.at(-1);
  const peak = (key) => Math.max(...samples.map((sample) => Number(sample[key] ?? 0)));
  const delta = (key) => Number(last?.[key] ?? 0) - Number(first?.[key] ?? 0);
  const rendererDelta = (key) => Number(last?.renderer?.[key] ?? 0) - Number(first?.renderer?.[key] ?? 0);
  return {
    samples: samples.length,
    appRssStartBytes: first?.appRssBytes ?? null,
    appRssEndBytes: last?.appRssBytes ?? null,
    appRssPeakBytes: samples.length ? peak('appRssBytes') : null,
    appRssDeltaBytes: samples.length ? delta('appRssBytes') : null,
    handlesStart: first?.handles ?? null,
    handlesEnd: last?.handles ?? null,
    handlesPeak: samples.length ? peak('handles') : null,
    handlesDelta: samples.length ? delta('handles') : null,
    processCountStart: first?.processCount ?? null,
    processCountEnd: last?.processCount ?? null,
    processCountPeak: samples.length ? peak('processCount') : null,
    eventCountStart: first?.database?.eventCount ?? null,
    eventCountEnd: last?.database?.eventCount ?? null,
    databaseEndBytes: last?.database?.familyBytes ?? null,
    logEndBytes: last?.logBytes ?? null,
    rendererHeapStartBytes: first?.renderer?.jsHeapUsedBytes ?? null,
    rendererHeapEndBytes: last?.renderer?.jsHeapUsedBytes ?? null,
    rendererHeapDeltaBytes: samples.length ? rendererDelta('jsHeapUsedBytes') : null,
    rendererListenersStart: first?.renderer?.jsEventListeners ?? null,
    rendererListenersEnd: last?.renderer?.jsEventListeners ?? null,
    rendererListenersDelta: samples.length ? rendererDelta('jsEventListeners') : null,
  };
}

function leakAssessment(summary, orphanProcesses, elapsedMs) {
  const longEnoughForTrend = elapsedMs >= 5 * 60_000 && summary.samples >= 12;
  const rssThreshold = Math.max(64 * 1024 * 1024, (summary.appRssStartBytes ?? 0) * 0.3);
  const heapThreshold = Math.max(32 * 1024 * 1024, (summary.rendererHeapStartBytes ?? 0) * 0.4);
  const handleThreshold = Math.max(100, (summary.handlesStart ?? 0) * 0.5);
  const listenerThreshold = Math.max(100, (summary.rendererListenersStart ?? 0) * 0.5);
  const signals = {
    processOrphans: orphanProcesses.length > 0,
    sustainedAppRssGrowth: longEnoughForTrend && (summary.appRssDeltaBytes ?? 0) > rssThreshold,
    sustainedRendererHeapGrowth: longEnoughForTrend && (summary.rendererHeapDeltaBytes ?? 0) > heapThreshold,
    sustainedHandleGrowth: longEnoughForTrend && (summary.handlesDelta ?? 0) > handleThreshold,
    sustainedRendererListenerGrowth: longEnoughForTrend && (summary.rendererListenersDelta ?? 0) > listenerThreshold,
    processCountGrowth: longEnoughForTrend && (summary.processCountEnd ?? 0) > (summary.processCountStart ?? 0) + 2,
  };
  return {
    result: Object.values(signals).some(Boolean) ? 'suspected-leak' : (longEnoughForTrend ? 'no-threshold-breach' : 'insufficient-duration-for-leak-claim'),
    signals,
    thresholds: { rssBytes: rssThreshold, rendererHeapBytes: heapThreshold, handles: handleThreshold, rendererListeners: listenerThreshold },
    limitations: [
      'External sampling cannot enumerate JavaScript timers; renderer listener count and process handles are proxies.',
      'A no-threshold-breach result is bounded evidence, not proof that no leak exists.',
      'Runs shorter than five minutes are mechanics checks only and never reported as stability acceptance.',
    ],
  };
}

async function launchElectron(fixture, exerciseAgent) {
  const port = await reservePort();
  const electronPath = electron.default || electron;
  const child = spawn(electronPath, [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${fixture.browserDataRoot}`,
    '.',
  ], {
    cwd: WORKSPACE_ROOT,
    env: {
      ...process.env,
      WORKBENCH_DATA_DIR: fixture.dataRoot,
      NODE_ENV: 'production',
      ...(exerciseAgent ? { FORCE_FAKE: '1' } : {}),
    },
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-32_000); });
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-32_000); });
  try {
    const page = await waitForCdpPage(port, {
      timeoutMs: 30_000,
      processExited: () => child.exitCode !== null || child.signalCode !== null,
    });
    const client = await CdpClient.connect(page.webSocketDebuggerUrl);
    await Promise.all([
      client.send('Runtime.enable'),
      client.send('Page.enable'),
      client.send('Performance.enable'),
    ]);
    await client.waitFor(
      `document.readyState === 'complete' && document.getElementById('root')?.children.length > 0`,
      { description: 'Workbench production React root', timeoutMs: 30_000 },
    );
    return { child, client, stdout: () => stdout, stderr: () => stderr };
  } catch (error) {
    await stopProcessTree(child);
    throw new Error(`${safeError(error)}${stderr ? `\nElectron stderr tail:\n${redact(stderr).split(/\r?\n/u).slice(-20).join('\n')}` : ''}`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  assertBuildOutputs();
  const fixture = createFixture();
  const abortController = new AbortController();
  const onInterrupt = () => abortController.abort();
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);
  let instance;
  let report;
  const startedWall = Date.now();
  try {
    const launchStartedAt = monotonicNow();
    instance = await launchElectron(fixture, options.exerciseAgent);
    const firstPaintMs = Math.round(monotonicNow() - launchStartedAt);
    const rootPid = instance.child.pid;
    assert(Number.isInteger(rootPid), 'Electron did not expose a process id.');
    const samples = [];
    const observedIdentities = new Map();
    if (options.exerciseAgent) await startAgentWorkload(instance.client, fixture, options.taskIntervalMs);
    console.log(`Production Electron ready in ${firstPaintMs} ms; sampling for ${options.durationMs} ms.`);

    while (!abortController.signal.aborted && Date.now() - startedWall < options.durationMs) {
      const rows = allProcessRows({ rootPid });
      const tree = processTree(rows, rootPid);
      for (const row of tree) observedIdentities.set(`${row.pid}:${row.creationTime}`, row);
      const sample = {
        elapsedMs: Date.now() - startedWall,
        appRssBytes: tree.reduce((sum, row) => sum + Number(row.rssBytes || 0), 0),
        handles: tree.reduce((sum, row) => sum + Number(row.handles || 0), 0),
        processCount: tree.length,
        processes: tree.map((row) => ({ pid: row.pid, ppid: row.ppid, name: row.name, rssBytes: row.rssBytes, handles: row.handles })),
        renderer: await rendererMetrics(instance.client).catch((error) => ({ readError: safeError(error) })),
        database: databaseMetrics(fixture.dbPath),
        logBytes: directorySize(fixture.logsPath),
        workload: options.exerciseAgent
          ? await instance.client.evaluate('window.__releaseStabilityWorkload ? ({ ...window.__releaseStabilityWorkload }) : null')
            .catch((error) => ({ readError: safeError(error) }))
          : null,
      };
      samples.push(sample);
      const remaining = options.durationMs - (Date.now() - startedWall);
      if (remaining <= 0) break;
      await delay(Math.min(options.sampleMs, remaining), abortController.signal);
    }

    const workload = options.exerciseAgent ? await stopAgentWorkload(instance.client) : null;
    try { await instance.client.evaluate('window.close()'); } catch { /* Window close can end CDP first. */ }
    instance.client.close();
    const termination = await stopProcessTree(instance.child);
    await delay(1_000);
    const recordedPids = [...new Set([...observedIdentities.values()].map((row) => row.pid))];
    const remainingRows = allProcessRows({ pids: recordedPids });
    const orphanProcesses = remainingRows.filter((row) => observedIdentities.has(`${row.pid}:${row.creationTime}`));
    const elapsedMs = Date.now() - startedWall;
    const summary = aggregateSamples(samples);
    report = {
      kind: 'electron-stability-soak',
      startedAt: new Date(startedWall).toISOString(),
      completedAt: new Date().toISOString(),
      requestedDurationMs: options.durationMs,
      actualDurationMs: elapsedMs,
      interrupted: abortController.signal.aborted,
      productionBuild: true,
      isolatedData: true,
      workload: {
        kind: options.exerciseAgent ? 'continuous-deterministic-TaskManager-agent-tasks' : 'idle',
        usesRealClaude: false,
        taskIntervalMs: options.exerciseAgent ? options.taskIntervalMs : null,
        result: workload,
        boundary: options.exerciseAgent
          ? 'Exercises production Electron IPC, Session, TaskManager, Checkpoint, SQLite, and event lifecycles with FORCE_FAKE=1. Real-model evidence comes from run.mjs.'
          : 'No Agent Task workload was requested.',
      },
      firstPaintMs,
      firstPaintTargetMs: 3_000,
      firstPaintTargetMet: firstPaintMs < 3_000,
      summary,
      samples,
      termination,
      orphanProcesses: orphanProcesses.map((row) => ({ pid: row.pid, name: row.name, creationTime: row.creationTime })),
      assessment: leakAssessment(summary, orphanProcesses, elapsedMs),
      output: {
        stdoutTail: redact(instance.stdout()).split(/\r?\n/u).slice(-20),
        stderrTail: redact(instance.stderr()).split(/\r?\n/u).slice(-20),
      },
      tempDataKept: options.keepTemp,
      tempRoot: options.keepTemp ? fixture.root : null,
    };
    const workloadSummary = options.exerciseAgent
      ? `; Agent Tasks ${workload?.completed ?? 0} completed / ${workload?.failed ?? 0} failed`
      : '';
    console.log(`Completed ${samples.length} samples; peak RSS ${summary.appRssPeakBytes} bytes; assessment: ${report.assessment.result}${workloadSummary}.`);
  } catch (error) {
    if (instance) {
      instance.client?.close();
      await stopProcessTree(instance.child);
    }
    report = {
      kind: 'electron-stability-soak',
      startedAt: new Date(startedWall).toISOString(),
      completedAt: new Date().toISOString(),
      requestedDurationMs: options.durationMs,
      success: false,
      error: safeError(error),
      tempDataKept: options.keepTemp,
      tempRoot: options.keepTemp ? fixture.root : null,
    };
    throw error;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
    if (options.reportPath && report) writeJson(options.reportPath, report);
    if (!options.keepTemp) removeDisposableRoot(fixture.root, TEMP_PREFIX);
  }
}

main().catch((error) => {
  console.error(`FAIL: ${safeError(error)}`);
  process.exitCode = 1;
});
