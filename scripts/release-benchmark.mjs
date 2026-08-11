import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import electron from 'electron';
import { CdpClient, waitForCdpPage } from './lib/cdp-client.mjs';
import {
  assert,
  disposableRoot,
  monotonicNow,
  redact,
  removeDisposableRoot,
  reservePort,
  safeError,
  stopProcessTree,
  writeJson,
} from './real-claude-smoke/support.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(SCRIPT_DIR, '..');
const TEMP_PREFIX = 'claude-workbench-release-benchmark-';
const RELEASE_SCALE = Object.freeze({ projects: 1_000, sessions: 10_000, tasks: 10_000, events: 100_000 });
const QUICK_SCALE = Object.freeze({ projects: 20, sessions: 200, tasks: 200, events: 2_000 });

function parseArguments(argv) {
  const options = {
    scale: RELEASE_SCALE,
    firstPaint: true,
    keepTemp: false,
    reportPath: null,
    repetitions: 100,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--quick') options.scale = QUICK_SCALE;
    else if (argument === '--skip-first-paint') options.firstPaint = false;
    else if (argument === '--keep-temp') options.keepTemp = true;
    else if (argument === '--report') {
      const value = argv[++index];
      if (!value) throw new Error('--report requires a path.');
      options.reportPath = path.resolve(value);
    } else if (argument === '--repetitions') {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 5 || value > 2_000) {
        throw new Error('--repetitions must be an integer between 5 and 2000.');
      }
      options.repetitions = value;
    } else if (argument === '--help') {
      console.log([
        'Usage: node scripts/release-benchmark.mjs [options]',
        '',
        'Default scale: 1,000 projects / 10,000 sessions / 10,000 tasks / 100,000 events.',
        'The benchmark creates a disposable SQLite database using the production schema.',
        '',
        '  --quick              Mechanics run at 20/200/200/2,000 (not release evidence).',
        '  --skip-first-paint   Skip launching the production Electron build.',
        '  --repetitions <n>    Timed query repetitions (default: 100).',
        '  --report <path>      Persist JSON results.',
        '  --keep-temp          Keep the disposable database/profile.',
      ].join('\n'));
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function timestamp(index) {
  return new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString();
}

async function initializeProductionSchema(dbPath) {
  const databaseModule = await import('../src/main/database/Database.ts');
  const appDatabase = new databaseModule.AppDatabase(dbPath);
  const diagnostics = appDatabase.getDiagnosticsSummary();
  appDatabase.close();
  return diagnostics;
}

function seedDatabase(dbPath, scale) {
  const database = new BetterSqlite3(dbPath);
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  const insertProject = database.prepare(`
    INSERT INTO projects (id, name, path, created_at, last_opened_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertSession = database.prepare(`
    INSERT INTO sessions (
      id, project_id, claude_session_id, title, status, model, permission_mode,
      created_at, updated_at, completed_at, archived, tags_json, title_source
    ) VALUES (?, ?, NULL, ?, 'completed', NULL, 'default', ?, ?, ?, 0, '[]', 'manual')
  `);
  const insertTask = database.prepare(`
    INSERT INTO tasks (
      id, session_id, project_id, status, agent_mode, started_at, completed_at,
      duration_ms, input_tokens, output_tokens, total_tokens, permission_count,
      test_status, test_command, test_output, created_at, updated_at
    ) VALUES (?, ?, ?, 'completed', 'normal', ?, ?, 1000, 100, 200, 300, 0,
      'passed', 'npm test', NULL, ?, ?)
  `);
  const insertEvent = database.prepare(`
    INSERT INTO events (id, session_id, event_type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const startedAt = monotonicNow();
  const seed = database.transaction(() => {
    for (let projectIndex = 0; projectIndex < scale.projects; projectIndex += 1) {
      const projectId = `project-${String(projectIndex).padStart(4, '0')}`;
      const createdAt = timestamp(projectIndex);
      insertProject.run(
        projectId,
        `Benchmark Project ${String(projectIndex).padStart(4, '0')}`,
        path.join(path.dirname(dbPath), 'projects', projectId),
        createdAt,
        createdAt,
      );
    }
    for (let sessionIndex = 0; sessionIndex < scale.sessions; sessionIndex += 1) {
      const sessionId = `session-${String(sessionIndex).padStart(5, '0')}`;
      const projectIndex = sessionIndex % scale.projects;
      const projectId = `project-${String(projectIndex).padStart(4, '0')}`;
      const createdAt = timestamp(scale.projects + sessionIndex);
      insertSession.run(sessionId, projectId, `Benchmark Session ${sessionIndex}`, createdAt, createdAt, createdAt);
      if (sessionIndex < scale.tasks) {
        insertTask.run(sessionId, sessionId, projectId, createdAt, createdAt, createdAt, createdAt);
      }
    }
    for (let eventIndex = 0; eventIndex < scale.events; eventIndex += 1) {
      const sessionIndex = eventIndex % scale.sessions;
      const sessionId = `session-${String(sessionIndex).padStart(5, '0')}`;
      insertEvent.run(
        `event-${String(eventIndex).padStart(6, '0')}`,
        sessionId,
        eventIndex % 5 === 0 ? 'agent_event' : 'assistant_event',
        JSON.stringify({ sequence: eventIndex, benchmark: true }),
        timestamp(scale.projects + scale.sessions + eventIndex),
      );
    }
  });
  seed();
  const seedDurationMs = Math.round(monotonicNow() - startedAt);
  database.pragma('wal_checkpoint(TRUNCATE)');
  const integrity = database.pragma('integrity_check', { simple: true });
  const counts = Object.fromEntries(['projects', 'sessions', 'tasks', 'events'].map((table) => [
    table,
    database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
  ]));
  database.close();
  return { seedDurationMs, integrity, counts };
}

function percentile(sorted, ratio) {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

function measureQuery(statement, parameterFactory, repetitions) {
  for (let index = 0; index < 10; index += 1) statement.all(...parameterFactory(index));
  const samples = [];
  let rowCount = 0;
  for (let index = 0; index < repetitions; index += 1) {
    const startedAt = monotonicNow();
    const rows = statement.all(...parameterFactory(index));
    samples.push(monotonicNow() - startedAt);
    rowCount = rows.length;
  }
  samples.sort((left, right) => left - right);
  return {
    repetitions,
    returnedRows: rowCount,
    averageMs: Number((samples.reduce((sum, value) => sum + value, 0) / samples.length).toFixed(3)),
    p50Ms: Number(percentile(samples, 0.5).toFixed(3)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
    maxMs: Number(samples.at(-1).toFixed(3)),
  };
}

function benchmarkQueries(dbPath, scale, repetitions) {
  const database = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
  const tests = {
    projectsCurrentFullList: {
      note: 'Matches the current production listProjects query; it intentionally exposes the remaining lack of project pagination.',
      sql: 'SELECT * FROM projects ORDER BY last_opened_at DESC',
      params: () => [],
    },
    projectsPage: {
      note: 'Release-scale pagination candidate.',
      sql: 'SELECT * FROM projects ORDER BY last_opened_at DESC LIMIT ? OFFSET ?',
      params: (index) => [50, (index % Math.max(1, Math.ceil(scale.projects / 50))) * 50],
    },
    sessionsPage: {
      note: 'Matches listSessions, including its correlated message count.',
      sql: `SELECT sessions.*,
        (SELECT COUNT(*) FROM messages WHERE messages.session_id = sessions.id) AS message_count
        FROM sessions WHERE project_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      params: (index) => [`project-${String(index % scale.projects).padStart(4, '0')}`, 50, 0],
    },
    tasksPage: {
      note: 'Matches listTasks.',
      sql: 'SELECT * FROM tasks WHERE project_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?',
      params: (index) => [`project-${String(index % scale.projects).padStart(4, '0')}`, 50, 0],
    },
    timelineFirstPage: {
      note: 'Matches listEvents first page.',
      sql: 'SELECT * FROM events WHERE session_id = ? ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?',
      params: (index) => [`session-${String(index % scale.sessions).padStart(5, '0')}`, 100, 0],
    },
    timelineDeepPage: {
      note: 'Exercises OFFSET pagination on a session timeline.',
      sql: 'SELECT * FROM events WHERE session_id = ? ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?',
      params: (index) => [`session-${String(index % scale.sessions).padStart(5, '0')}`, 5, 5],
    },
  };
  const results = {};
  for (const [name, test] of Object.entries(tests)) {
    const statement = database.prepare(test.sql);
    results[name] = {
      ...measureQuery(statement, test.params, repetitions),
      note: test.note,
      queryPlan: database.prepare(`EXPLAIN QUERY PLAN ${test.sql}`).all(...test.params(0))
        .map((row) => String(row.detail)),
    };
  }
  const pageCount = Number(database.pragma('page_count', { simple: true }));
  const pageSize = Number(database.pragma('page_size', { simple: true }));
  const schemaVersion = Number(database.pragma('user_version', { simple: true }));
  database.close();
  const familyBytes = ['', '-wal', '-shm'].reduce((sum, suffix) => {
    const candidate = `${dbPath}${suffix}`;
    return sum + (fs.existsSync(candidate) ? fs.statSync(candidate).size : 0);
  }, 0);
  return { results, pageCount, pageSize, schemaVersion, databaseFamilyBytes: familyBytes };
}

function assertBuildOutputs() {
  for (const relativePath of ['dist/main/index.js', 'dist/preload/index.js', 'dist/renderer/index.html']) {
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, ...relativePath.split('/'))),
      `Missing ${relativePath}; run npm run build or pass --skip-first-paint.`);
  }
}

async function measureFirstPaint(root, dataRoot) {
  assertBuildOutputs();
  const profilePath = path.join(root, 'chromium-profile');
  fs.mkdirSync(profilePath, { recursive: true });
  const port = await reservePort();
  const electronPath = electron.default || electron;
  const launchStartedAt = monotonicNow();
  const child = spawn(electronPath, [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profilePath}`,
    '.',
  ], {
    cwd: WORKSPACE_ROOT,
    env: {
      ...process.env,
      WORKBENCH_DATA_DIR: dataRoot,
      WORKBENCH_DISABLE_UPDATE_CHECK: '1',
      NODE_ENV: 'production',
    },
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-32_000); });
  let client;
  try {
    const page = await waitForCdpPage(port, {
      timeoutMs: 30_000,
      processExited: () => child.exitCode !== null || child.signalCode !== null,
    });
    const rendererAvailableMs = monotonicNow() - launchStartedAt;
    client = await CdpClient.connect(page.webSocketDebuggerUrl);
    await Promise.all([client.send('Runtime.enable'), client.send('Page.enable')]);
    await client.waitFor(
      `document.readyState === 'complete' && document.getElementById('root')?.children.length > 0`,
      { description: 'production React root', timeoutMs: 30_000 },
    );
    const reactRootReadyMs = monotonicNow() - launchStartedAt;
    const projectVisible = await client.evaluate("document.body.innerText.includes('Benchmark Project')");
    const rendererPaintEntries = await client.evaluate(`performance.getEntriesByType('paint').map((entry) => ({
      name: entry.name,
      startTime: entry.startTime,
      duration: entry.duration,
    }))`);
    return {
      rendererAvailableMs: Math.round(rendererAvailableMs),
      reactRootReadyMs: Math.round(reactRootReadyMs),
      targetMs: 3_000,
      targetMet: reactRootReadyMs < 3_000,
      seededProjectVisibleAtRootReady: projectVisible,
      rendererPaintEntries,
      definition: 'Target uses process-spawn to populated production React root; renderer paint entries use Chromium navigation-relative time.',
    };
  } catch (error) {
    throw new Error(`${safeError(error)}${stderr ? `\nElectron stderr tail:\n${redact(stderr).split(/\r?\n/u).slice(-20).join('\n')}` : ''}`);
  } finally {
    client?.close();
    await stopProcessTree(child);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = disposableRoot(TEMP_PREFIX);
  const dataRoot = path.join(root, 'workbench-data');
  const dbPath = path.join(dataRoot, 'claude-workbench.db');
  fs.mkdirSync(dataRoot, { recursive: true });
  const startedAt = new Date().toISOString();
  let report;
  try {
    console.log(`Initializing production schema and seeding ${JSON.stringify(options.scale)} in ${root}.`);
    const initialDiagnostics = await initializeProductionSchema(dbPath);
    const seed = seedDatabase(dbPath, options.scale);
    for (const [table, expected] of Object.entries(options.scale)) {
      assert(seed.counts[table] === expected, `${table} count mismatch: expected ${expected}, got ${seed.counts[table]}.`);
    }
    assert(seed.integrity === 'ok', `SQLite integrity check failed: ${seed.integrity}.`);
    const query = benchmarkQueries(dbPath, options.scale, options.repetitions);
    const firstPaint = options.firstPaint ? await measureFirstPaint(root, dataRoot) : null;
    report = {
      kind: 'release-scale-benchmark',
      startedAt,
      completedAt: new Date().toISOString(),
      success: true,
      releaseScale: options.scale === RELEASE_SCALE,
      scale: options.scale,
      initialDiagnostics,
      seed,
      query,
      firstPaint,
      limitations: [
        'This is a deterministic local synthetic dataset; production hardware and payload distributions will vary.',
        'The current project list API is not paginated; both its full-list query and a pagination candidate are measured.',
        'First-paint timing requires a current production dist/ and a graphical Electron session.',
      ],
      tempDataKept: options.keepTemp,
      tempRoot: options.keepTemp ? root : null,
    };
    console.log(`PASS: seeded in ${seed.seedDurationMs} ms; DB family ${query.databaseFamilyBytes} bytes.`);
    if (firstPaint) console.log(`Production React root: ${firstPaint.reactRootReadyMs} ms (target < ${firstPaint.targetMs} ms).`);
  } catch (error) {
    report = {
      kind: 'release-scale-benchmark',
      startedAt,
      completedAt: new Date().toISOString(),
      success: false,
      scale: options.scale,
      error: safeError(error),
      tempDataKept: options.keepTemp,
      tempRoot: options.keepTemp ? root : null,
    };
    throw error;
  } finally {
    if (options.reportPath && report) writeJson(options.reportPath, report);
    if (!options.keepTemp) removeDisposableRoot(root, TEMP_PREFIX);
  }
}

main().catch((error) => {
  console.error(`FAIL: ${safeError(error)}`);
  process.exitCode = 1;
});

