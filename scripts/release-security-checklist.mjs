import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(scriptDirectory, '..');
const requestedReport = process.argv.indexOf('--report');
const reportPath = requestedReport >= 0 && process.argv[requestedReport + 1]
  ? path.resolve(process.argv[requestedReport + 1])
  : path.join(workspace, 'release-validation', 'security-checklist.json');

function read(relativePath) {
  return fs.readFileSync(path.join(workspace, relativePath), 'utf8');
}

function productionSources(directory) {
  const root = path.join(workspace, directory);
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...productionSources(path.relative(workspace, absolute)));
    else if (/\.tsx?$/u.test(entry.name)) result.push(fs.readFileSync(absolute, 'utf8'));
  }
  return result;
}

const mainSource = read('src/main/index.ts');
const singleInstanceSource = read('src/main/lifecycle/SingleInstanceGuard.ts');
const settingsSource = read('src/main/ipc/settings.ts');
const builderConfig = read('electron-builder.yml');
const gitMutationSource = [
  ...productionSources('src/main/checkpoints'),
  ...productionSources('src/main/file-changes'),
].join('\n');

const staticChecks = [
  ['bypassPermissions defaults off', /defaultPermissionMode:\s*'standard'/u.test(settingsSource)],
  ['renderer Node integration disabled', /nodeIntegration:\s*false/u.test(mainSource)],
  ['renderer context isolation enabled', /contextIsolation:\s*true/u.test(mainSource)],
  ['renderer sandbox enabled', /sandbox:\s*true/u.test(mainSource)],
  ['single-instance lock enabled', /installSingleInstanceGuard/u.test(mainSource)
    && /requestSingleInstanceLock/u.test(singleInstanceSource)],
  ['NSIS runs as current user', /requestedExecutionLevel:\s*asInvoker/u.test(builderConfig)],
  ['code-signing hook prepared', /CSC_LINK\/CSC_KEY_PASSWORD/u.test(builderConfig)],
  ['dangerous Git mutations absent', !/(?:reset.{0,40}--hard|clean.{0,40}(?:-f|--force)|push.{0,40}--force)/isu.test(gitMutationSource)],
].map(([name, passed]) => ({ name, passed: Boolean(passed) }));

const focusedTests = [
  'src/main/tasks/__tests__/TaskManager.test.ts',
  'src/main/permissions/__tests__/PermissionBroker.test.ts',
  'src/main/permissions/__tests__/PermissionAudit.test.ts',
  'src/main/ipc/__tests__/claude.test.ts',
  'src/main/ipc/__tests__/permissions.test.ts',
  'src/main/ipc/__tests__/system.test.ts',
  'src/main/ipc/__tests__/file-changes.test.ts',
  'src/main/ipc/__tests__/git-workspace.test.ts',
  'src/main/file-mutations/__tests__/FileMutationManager.test.ts',
  'src/main/logging/__tests__/StructuredLogger.test.ts',
  'src/main/diagnostics/__tests__/DiagnosticsExporter.test.ts',
  'src/main/ipc/__tests__/diagnostics.test.ts',
  'src/main/release/__tests__/InstallerConfig.test.ts',
];

const vitest = path.join(workspace, 'node_modules', 'vitest', 'vitest.mjs');
const testRun = spawnSync(process.execPath, [vitest, 'run', ...focusedTests, '--reporter=json'], {
  cwd: workspace,
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
  windowsHide: true,
});

let testSummary = { passed: false, testCount: 0, failedCount: 0 };
try {
  const parsed = JSON.parse(testRun.stdout || '{}');
  testSummary = {
    passed: testRun.status === 0 && Boolean(parsed.success),
    testCount: Number(parsed.numTotalTests || 0),
    failedCount: Number(parsed.numFailedTests || 0),
  };
} catch {
  testSummary = { passed: false, testCount: 0, failedCount: 1 };
}

const report = {
  generatedAt: new Date().toISOString(),
  version: JSON.parse(read('package.json')).version,
  staticChecks,
  focusedTests: testSummary,
  runtimeEvidenceRequired: [
    'production Electron security acceptance',
    'diagnostic ZIP sentinel scan',
    'Authenticode status of the final installer',
  ],
  passed: staticChecks.every((check) => check.passed) && testSummary.passed,
};

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
if (!report.passed) {
  if (testRun.stderr) console.error(testRun.stderr.slice(0, 4_000));
  process.exitCode = 1;
}
