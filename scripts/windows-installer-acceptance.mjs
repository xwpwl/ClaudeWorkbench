import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpClient, waitForCdpPage } from './lib/cdp-client.mjs';
import {
  assert,
  reservePort,
  safeError,
  stopProcessTree,
  writeJson,
} from './real-claude-smoke/support.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(scriptDirectory, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'));
const setupPath = path.join(workspace, 'release', `ClaudeWorkbench Setup ${packageJson.version}.exe`);
const reportArgument = process.argv.indexOf('--report');
const reportPath = reportArgument >= 0 && process.argv[reportArgument + 1]
  ? path.resolve(process.argv[reportArgument + 1])
  : path.join(workspace, 'release-validation', 'windows-installer.json');

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(250);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function runExecutable(executable, args, timeoutMs = 180_000) {
  const result = spawnSync(executable, args, {
    cwd: workspace,
    windowsHide: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(executable)} failed with exit ${String(result.status)}: ${safeError(result.error ?? result.stderr)}`);
  }
}

function authenticodeStatus(filePath) {
  const command = [
    "$signature = Get-AuthenticodeSignature -LiteralPath $env:WORKBENCH_SETUP_PATH",
    '[PSCustomObject]@{ Status = [string]$signature.Status; Subject = [string]$signature.SignerCertificate.Subject } | ConvertTo-Json -Compress',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, WORKBENCH_SETUP_PATH: filePath },
  });
  if (result.error || result.status !== 0) return { status: 'Unknown', subject: '' };
  const parsed = JSON.parse(result.stdout || '{}');
  return { status: parsed.Status || 'Unknown', subject: parsed.Subject || '' };
}

if (process.platform !== 'win32') throw new Error('Windows installer acceptance can only run on Windows.');
assert(fs.existsSync(setupPath), `Installer not found: ${setupPath}`);
assert(fs.readFileSync(setupPath).subarray(0, 2).toString('ascii') === 'MZ', 'Installer is not a Windows executable.');

const temporaryParent = path.resolve(os.tmpdir());
const temporaryRoot = fs.mkdtempSync(path.join(temporaryParent, 'claude-workbench-installer-acceptance-'));
const installRoot = path.join(temporaryRoot, 'installed');
const dataRoot = path.join(temporaryRoot, 'workbench-data');
const chromiumRoot = path.join(temporaryRoot, 'chromium-profile');
const installedExecutable = path.join(installRoot, 'Claude Workbench.exe');
const desktopShortcut = path.join(process.env.USERPROFILE || '', 'Desktop', 'Claude Workbench.lnk');
const startMenuShortcut = path.join(
  process.env.APPDATA || '',
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Claude Workbench.lnk',
);
const preexistingShortcuts = [desktopShortcut, startMenuShortcut].filter((candidate) => fs.existsSync(candidate));
assert(preexistingShortcuts.length === 0, 'Installer acceptance refuses to overwrite a pre-existing Claude Workbench shortcut.');

const report = {
  startedAt: new Date().toISOString(),
  version: packageJson.version,
  setup: {
    path: setupPath,
    bytes: fs.statSync(setupPath).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(setupPath)).digest('hex'),
    authenticode: authenticodeStatus(setupPath),
  },
  installation: {},
  launch: {},
  uninstall: {},
  cleanup: {},
  status: 'running',
};

let application = null;
let client = null;
let uninstallExecutable = null;
try {
  runExecutable(setupPath, ['/S', `/D=${installRoot}`]);
  await waitUntil(() => fs.existsSync(installedExecutable), 30_000, 'installed application executable');
  uninstallExecutable = fs.readdirSync(installRoot)
    .map((name) => path.join(installRoot, name))
    .find((candidate) => /uninstall.*\.exe$/iu.test(path.basename(candidate)));
  assert(uninstallExecutable && fs.existsSync(uninstallExecutable), 'NSIS uninstaller was not installed.');
  report.installation = {
    installRoot,
    executable: fs.existsSync(installedExecutable),
    uninstaller: path.basename(uninstallExecutable),
    desktopShortcut: fs.existsSync(desktopShortcut),
    startMenuShortcut: fs.existsSync(startMenuShortcut),
    customDirectoryHonored: path.dirname(installedExecutable) === installRoot,
  };
  assert(report.installation.desktopShortcut, 'Desktop shortcut was not created.');
  assert(report.installation.startMenuShortcut, 'Start menu shortcut was not created.');

  const port = await reservePort();
  application = spawn(installedExecutable, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${chromiumRoot}`,
    '--disable-gpu',
  ], {
    cwd: installRoot,
    windowsHide: true,
    env: {
      ...process.env,
      WORKBENCH_DATA_DIR: dataRoot,
      WORKBENCH_FORCE_FAKE_CLAUDE: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const page = await waitForCdpPage(port, {
    timeoutMs: 45_000,
    processExited: () => application.exitCode !== null || application.signalCode !== null,
  });
  client = await CdpClient.connect(page.webSocketDebuggerUrl);
  const runtime = await client.evaluate(`(async () => ({
    title: document.title,
    rendererUrl: location.href,
    nodeIntegrationDisabled: typeof window.require === 'undefined' && typeof process === 'undefined',
    release: await window.api.getReleaseVersion(),
    updates: await window.api.getUpdateState(),
    settings: await window.api.getSettings(),
  }))()`);
  report.launch = {
    title: runtime.title,
    rendererUrl: runtime.rendererUrl,
    nodeIntegrationDisabled: runtime.nodeIntegrationDisabled,
    release: runtime.release,
    updates: runtime.updates,
    autoCheckUpdates: runtime.settings?.autoCheckUpdates,
    dataRootCreated: fs.existsSync(dataRoot),
  };
  assert(runtime.release?.version === packageJson.version, 'Installed application reports the wrong version.');
  assert(runtime.nodeIntegrationDisabled, 'Installed renderer unexpectedly has Node integration.');
  assert(runtime.settings?.autoCheckUpdates === false, 'Installed application must not force automatic update checks.');

  await client.close();
  client = null;
  await stopProcessTree(application, 5_000);
  application = null;

  runExecutable(uninstallExecutable, ['/S'], 180_000);
  await waitUntil(() => !fs.existsSync(installedExecutable), 30_000, 'application removal');
  await waitUntil(
    () => !fs.existsSync(desktopShortcut) && !fs.existsSync(startMenuShortcut),
    30_000,
    'shortcut removal',
  );
  report.uninstall = {
    applicationRemoved: !fs.existsSync(installedExecutable),
    desktopShortcutRemoved: !fs.existsSync(desktopShortcut),
    startMenuShortcutRemoved: !fs.existsSync(startMenuShortcut),
  };
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = safeError(error);
  process.exitCode = 1;
} finally {
  if (client) {
    try { await client.close(); } catch { /* The renderer may have already exited. */ }
  }
  if (application) await stopProcessTree(application, 2_000).catch(() => {});
  if (uninstallExecutable && fs.existsSync(uninstallExecutable) && fs.existsSync(installedExecutable)) {
    try {
      runExecutable(uninstallExecutable, ['/S'], 180_000);
      await waitUntil(() => !fs.existsSync(installedExecutable), 30_000, 'failure-path application removal');
    } catch { /* The primary failure is already recorded in the report. */ }
  }
  if (preexistingShortcuts.length === 0) {
    for (const shortcut of [desktopShortcut, startMenuShortcut]) {
      if (path.basename(shortcut) === 'Claude Workbench.lnk' && fs.existsSync(shortcut)) {
        fs.unlinkSync(shortcut);
      }
    }
  }
  const resolvedRoot = path.resolve(temporaryRoot);
  const safeTemporaryRoot = path.dirname(resolvedRoot) === temporaryParent
    && path.basename(resolvedRoot).startsWith('claude-workbench-installer-acceptance-');
  if (safeTemporaryRoot) fs.rmSync(resolvedRoot, { recursive: true, force: true });
  report.cleanup = {
    isolatedTemporaryRootRemoved: safeTemporaryRoot && !fs.existsSync(resolvedRoot),
    preexistingUserShortcuts: preexistingShortcuts.length,
  };
  report.completedAt = new Date().toISOString();
  writeJson(reportPath, report);
  console.log(JSON.stringify(report, null, 2));
}
