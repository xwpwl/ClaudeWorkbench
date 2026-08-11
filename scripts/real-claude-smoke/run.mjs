import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assert,
  disposableRoot,
  monotonicNow,
  redact,
  removeDisposableRoot,
  runChecked,
  safeError,
  sha256,
  stopProcessTree,
  writeJson,
} from './support.mjs';

const TEMP_PREFIX = 'claude-workbench-real-cli-';
const DEFAULT_TIMEOUT_MS = 12 * 60_000;
const REQUEST = '增加一个数学计算模块，并添加完整测试。';
const EXPECTED_FILES = ['src/math.js', 'test/math.test.js'];

function parseArguments(argv) {
  const options = {
    claudePath: process.env.CLAUDE_PATH || 'claude',
    keepTemp: false,
    reportPath: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--keep-temp') options.keepTemp = true;
    else if (argument === '--report') {
      const value = argv[++index];
      if (!value) throw new Error('--report requires a path.');
      options.reportPath = path.resolve(value);
    } else if (argument === '--timeout-ms') {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 10_000 || value > 60 * 60_000) {
        throw new Error('--timeout-ms must be an integer between 10000 and 3600000.');
      }
      options.timeoutMs = value;
    } else if (argument === '--claude-path') {
      const value = argv[++index];
      if (!value) throw new Error('--claude-path requires an executable path.');
      options.claudePath = value;
    } else if (argument === '--help') {
      console.log([
        'Usage: node scripts/real-claude-smoke/run.mjs [options]',
        '',
        'Runs the real Claude Code CLI in a disposable Git repository.',
        'This is a CLI/write/test/diff smoke, not a Workbench UI workflow acceptance.',
        '',
        '  --timeout-ms <ms>     CLI timeout (default: 720000).',
        '  --claude-path <path>  Claude executable (default: CLAUDE_PATH or claude).',
        '  --report <path>       Persist the redacted metadata-only JSON report.',
        '  --keep-temp           Keep the disposable repository for diagnosis.',
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function createFixture(root) {
  const projectPath = path.join(root, 'project');
  fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
  fs.mkdirSync(path.join(projectPath, 'test'), { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'src', 'index.js'), [
    "export const fixtureName = 'claude-workbench-release-smoke';",
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(projectPath, 'package.json'), `${JSON.stringify({
    name: 'claude-workbench-real-cli-smoke',
    private: true,
    type: 'module',
    scripts: { test: 'node --test' },
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(projectPath, '.gitignore'), 'node_modules/\n', 'utf8');
  runChecked('git', ['init', '--quiet'], { cwd: projectPath });
  runChecked('git', ['add', '--all'], { cwd: projectPath });
  runChecked('git', [
    '-c', 'user.name=Claude Workbench Release Validation',
    '-c', 'user.email=release-validation@example.invalid',
    'commit', '--quiet', '-m', 'release smoke baseline',
  ], { cwd: projectPath });
  assert(runChecked('git', ['status', '--porcelain=v1'], { cwd: projectPath }) === '', 'Fixture Git repository is dirty.');
  return projectPath;
}

function runNpm(args, options) {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
  const npmCli = candidates.find((candidate) => fs.existsSync(candidate));
  assert(npmCli, 'Unable to locate npm-cli.js without using a command shell.');
  return runChecked(process.execPath, [npmCli, ...args], options);
}

function getClaudeIdentity(claudePath) {
  const versionOutput = runChecked(claudePath, ['--version'], { timeoutMs: 20_000 });
  const authResult = spawnSync(claudePath, ['auth', 'status'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (authResult.error || authResult.status !== 0) {
    throw new Error('Claude auth status failed; raw authentication output was intentionally discarded.');
  }
  const authOutput = authResult.stdout ?? '';
  let auth;
  try {
    const parsed = JSON.parse(authOutput);
    auth = {
      loggedIn: parsed.loggedIn === true,
      authMethod: typeof parsed.authMethod === 'string' ? parsed.authMethod : 'unknown',
      apiProvider: typeof parsed.apiProvider === 'string' ? parsed.apiProvider : 'unknown',
    };
  } catch {
    throw new Error('Claude auth status did not return parseable JSON; raw auth output was intentionally discarded.');
  }
  assert(auth.loggedIn, 'Claude Code CLI is not authenticated.');
  return {
    version: redact(versionOutput.split(/\r?\n/u)[0]).slice(0, 160),
    auth,
  };
}

function safeEventMetadata(parsed) {
  const type = typeof parsed?.type === 'string' ? parsed.type : 'unknown';
  const subtype = typeof parsed?.subtype === 'string' ? parsed.subtype : null;
  const messageContent = Array.isArray(parsed?.message?.content) ? parsed.message.content : [];
  return {
    type,
    subtype,
    contentTypes: messageContent
      .map((item) => (item && typeof item.type === 'string' ? item.type : 'unknown'))
      .slice(0, 20),
    isError: parsed?.is_error === true,
  };
}

async function runClaude(claudePath, projectPath, timeoutMs) {
  const prompt = [
    `任务：${REQUEST}`,
    '',
    '这是一次隔离的发布验证。请只完成以下确定性改动：',
    '1. 新建 src/math.js，导出 add、subtract、multiply、divide 四个函数。',
    '2. divide 的除数为 0 时抛出 RangeError。',
    '3. 新建 test/math.test.js，使用 node:test 和 node:assert/strict，覆盖四种运算、负数/小数以及除零异常。',
    '4. 运行 npm test 并修复失败。',
    '',
    '不要安装依赖，不要访问网络，不要提交 Git，不要修改上述两个目标文件之外的文件。',
  ].join('\n');
  const allowedTools = 'Read,Write,Edit,Glob,Grep,Bash(npm test),Bash(node --test)';
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--safe-mode',
    '--no-session-persistence',
    '--permission-mode', 'manual',
    '--tools', 'Read,Write,Edit,Glob,Grep,Bash',
    '--allowedTools', allowedTools,
    '--max-turns', '24',
    prompt,
  ];
  const serializedArgs = args.join(' ');
  assert(!/bypassPermissions|dangerously-skip-permissions/iu.test(serializedArgs), 'Unsafe permission bypass flag detected.');

  const startedAt = monotonicNow();
  const child = spawn(claudePath, args, {
    cwd: projectPath,
    env: { ...process.env, CLAUDE_CODE_SAFE_MODE: '1' },
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const events = [];
  const eventCounts = {};
  let stdoutBuffer = '';
  let stderr = '';
  let timedOut = false;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/u);
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const metadata = safeEventMetadata(JSON.parse(line));
        events.push(metadata);
        eventCounts[metadata.type] = (eventCounts[metadata.type] ?? 0) + 1;
      } catch {
        eventCounts.unparseable = (eventCounts.unparseable ?? 0) + 1;
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-32_000);
  });

  const timer = setTimeout(() => {
    timedOut = true;
    void stopProcessTree(child, 3_000);
  }, timeoutMs);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  if (stdoutBuffer.trim()) {
    try {
      const metadata = safeEventMetadata(JSON.parse(stdoutBuffer));
      events.push(metadata);
      eventCounts[metadata.type] = (eventCounts[metadata.type] ?? 0) + 1;
    } catch {
      eventCounts.unparseable = (eventCounts.unparseable ?? 0) + 1;
    }
  }
  assert(!timedOut, `Claude CLI exceeded ${timeoutMs} ms.`);
  assert(result.code === 0, `Claude CLI exited with code ${result.code ?? 'null'} (${result.signal ?? 'no signal'}). ${redact(stderr).slice(-2_000)}`);
  assert(events.some((event) => event.type === 'result' && !event.isError), 'Claude stream did not contain a successful result event.');
  return {
    durationMs: Math.round(monotonicNow() - startedAt),
    exitCode: result.code,
    signal: result.signal,
    permissionMode: 'manual',
    allowedTools: allowedTools.split(','),
    eventCounts,
    events: events.slice(0, 250),
    stderrTail: redact(stderr).trim().split(/\r?\n/u).slice(-20),
  };
}

async function verifyResult(projectPath) {
  const changedFiles = runChecked('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: projectPath })
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/\\/gu, '/'))
    .sort();
  assert(JSON.stringify(changedFiles) === JSON.stringify([...EXPECTED_FILES].sort()),
    `Unexpected Git changes: ${changedFiles.join(', ') || '(none)'}.`);
  for (const relativePath of EXPECTED_FILES) {
    assert(fs.existsSync(path.join(projectPath, ...relativePath.split('/'))), `Expected file is missing: ${relativePath}`);
  }

  const modulePath = path.join(projectPath, 'src', 'math.js');
  const math = await import(`${pathToFileURL(modulePath).href}?validation=${Date.now()}`);
  const assertions = [
    ['add', math.add?.(2, 3), 5],
    ['subtract', math.subtract?.(2, 3), -1],
    ['multiply', math.multiply?.(-2, 3), -6],
    ['divide', math.divide?.(7.5, 2.5), 3],
  ];
  for (const [name, actual, expected] of assertions) {
    assert(actual === expected, `${name} acceptance assertion failed: expected ${expected}, received ${actual}.`);
  }
  let divideByZeroError = null;
  try { math.divide?.(1, 0); } catch (error) { divideByZeroError = error; }
  assert(divideByZeroError instanceof RangeError, 'divide(1, 0) must throw RangeError.');

  const testStartedAt = monotonicNow();
  const testOutput = runNpm(['test', '--', '--test-reporter=spec'], {
    cwd: projectPath,
    timeoutMs: 120_000,
  });
  // `git diff` omits untracked files. Mark only the two already-validated
  // outputs as intent-to-add so the report contains a real worktree diff
  // without staging bytes or changing HEAD.
  runChecked('git', ['add', '--intent-to-add', '--', ...EXPECTED_FILES], { cwd: projectPath });
  const diff = runChecked('git', ['diff', '--no-ext-diff', '--stat'], { cwd: projectPath });
  const numstat = runChecked('git', ['diff', '--no-ext-diff', '--numstat'], { cwd: projectPath });
  assert(diff.length > 0 && numstat.length > 0, 'Git diff did not include the generated files.');
  return {
    changedFiles,
    sourceSha256: sha256(fs.readFileSync(modulePath)),
    testSha256: sha256(fs.readFileSync(path.join(projectPath, 'test', 'math.test.js'))),
    testDurationMs: Math.round(monotonicNow() - testStartedAt),
    testSummary: redact(testOutput).split(/\r?\n/u).slice(-12),
    gitIntentToAddOnly: true,
    gitDiffStat: redact(diff),
    gitNumStat: redact(numstat).split(/\r?\n/u).filter(Boolean),
    headUnchanged: runChecked('git', ['rev-list', '--count', 'HEAD'], { cwd: projectPath }) === '1',
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = disposableRoot(TEMP_PREFIX);
  const startedAt = new Date().toISOString();
  let report;
  try {
    const projectPath = createFixture(root);
    const claude = getClaudeIdentity(options.claudePath);
    console.log(`Claude CLI authenticated (${claude.auth.authMethod}/${claude.auth.apiProvider}); raw auth output was discarded.`);
    console.log(`Running real CLI smoke in disposable repository: ${projectPath}`);
    const run = await runClaude(options.claudePath, projectPath, options.timeoutMs);
    const verification = await verifyResult(projectPath);
    assert(verification.headUnchanged, 'Claude committed changes even though the task forbids commits.');
    report = {
      kind: 'real-claude-cli-smoke',
      scope: 'Direct Claude Code CLI transport + real file writes + tests + Git diff. It does not prove the Workbench UI, PermissionBroker, workflow state machine, checkpoints, reviewer, or commit preview.',
      request: REQUEST,
      startedAt,
      completedAt: new Date().toISOString(),
      success: true,
      claude,
      safety: {
        disposableProject: true,
        permissionBypass: false,
        permissionMode: run.permissionMode,
        networkOrDependencyInstallRequested: false,
        sessionPersistence: false,
        safeMode: true,
      },
      run,
      verification,
      tempProjectKept: options.keepTemp,
      tempProjectPath: options.keepTemp ? projectPath : null,
    };
    console.log(`PASS: ${verification.changedFiles.join(', ')}; npm test passed; Git HEAD unchanged.`);
  } catch (error) {
    report = {
      kind: 'real-claude-cli-smoke',
      request: REQUEST,
      startedAt,
      completedAt: new Date().toISOString(),
      success: false,
      error: safeError(error),
      tempProjectKept: options.keepTemp,
      tempProjectPath: options.keepTemp ? path.join(root, 'project') : null,
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
