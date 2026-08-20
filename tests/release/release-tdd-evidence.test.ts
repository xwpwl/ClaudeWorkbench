import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  TDD_REQUIREMENT_CASES,
  runObservedTddCommand,
} from '../../scripts/release/lib/tdd-evidence.mjs';
import { assertTddChildArgv, assertTddTestReferences, TDD_COMMAND_SLICES, TDD_GREEN_PATH_OBSERVATION_SLICES } from '../../scripts/release/requirements-contract.mjs';
import * as requirementsContract from '../../scripts/release/requirements-contract.mjs';

const temporaryRoots: string[] = [];
const execFile = promisify(execFileCallback);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliPath = path.join(workspace, 'scripts', 'release', 'tdd-evidence.mjs');
const launcherPath = path.join(workspace, 'scripts', 'release', 'tdd-evidence-launcher.ps1');
const OFFICIAL_LAUNCHER_COMMAND = "& ([IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'WindowsPowerShell\\v1.0\\powershell.exe')) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\\scripts\\release\\tdd-evidence-launcher.ps1";
const OFFICIAL_LAUNCHER_EXIT = '; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }';
const IPC_TEST_REFERENCES = [
  'src/main/ipc/__tests__/release.test.ts',
  'src/preload/__tests__/index.test.ts',
  'src/preload/__tests__/transport-surface.test.ts',
];
const INVALID_IPC_CHILD_ARGV = [
  ['missing reviewed reference', ['node', 'node_modules/vitest/vitest.mjs', 'run', IPC_TEST_REFERENCES[0]]],
  ['wrong executable', ['npm', 'node_modules/vitest/vitest.mjs', 'run', ...IPC_TEST_REFERENCES]],
  ['reordered references', ['node', 'node_modules/vitest/vitest.mjs', 'run', ...[...IPC_TEST_REFERENCES].reverse()]],
  ['duplicate reference', ['node', 'node_modules/vitest/vitest.mjs', 'run', ...IPC_TEST_REFERENCES, IPC_TEST_REFERENCES[0]]],
  ['extra reporter option', ['node', 'node_modules/vitest/vitest.mjs', 'run', '--reporter', IPC_TEST_REFERENCES[0], ...IPC_TEST_REFERENCES.slice(1)]],
] as const;
const PROTECTED_INPUTS = [
  ['toolchain contract', 'scripts/release/tdd-evidence-toolchain.json', '75f8495157afae85bd9c98232221576cbba9157b316c00a9639edec636936472'],
  ['recorder CLI', 'scripts/release/tdd-evidence.mjs', 'ea913e99264471456ddbe3577707f137e903e676928406b5c9fca6d1dbace8b6'],
  ['requirements contract', 'scripts/release/requirements-contract.mjs', 'a105d1414beb8c9a7618031000fa4f370ac2566ee871f430904b1eb2929859e3'],
  ['recorder library', 'scripts/release/lib/tdd-evidence.mjs', '87fc61bee6ef1660552c30cc2cef3e7e4dc1916993379e4b2cfacff8bb2d36e7'],
] as const;
const PLAN_PATHS = [
  'docs/superpowers/plans/2026-08-12-release-foundation-and-assets.md',
  'docs/superpowers/plans/2026-08-12-release-artifact-integrity.md',
  'docs/superpowers/plans/2026-08-12-controlled-updater-and-data-safety.md',
  'docs/superpowers/plans/2026-08-12-beta-diagnostics-feedback-and-disclosures.md',
  'docs/superpowers/plans/2026-08-12-windows-release-acceptance-and-gates.md',
] as const;

const EXPECTED_CASES = [
  ['VER-01', 'single version source'],
  ['VER-02', 'higher than known installed version'],
  ['VER-03', 'RC channel'],
  ['VER-04', 'invalid version blocks'],
  ['VER-05', 'dirty blocks'],
  ['VER-06', 'unknown commit blocks'],
  ['VER-07', 'Build ID parses as version + short SHA + UTC'],
  ['META-08', 'complete metadata'],
  ['META-09', 'no absolute path'],
  ['META-10', 'no secret'],
  ['META-11', 'About equals Manifest public facts'],
  ['META-12', 'Diagnostics equals Metadata public facts'],
  ['INS-13', 'filename has real version'],
  ['INS-14', 'stable App ID'],
  ['INS-15', 'install-directory policy'],
  ['INS-16', 'shortcuts'],
  ['INS-17', 'uninstall retains project'],
  ['INS-18', 'default retains userData'],
  ['INS-19', 'any optional local-data cleanup requires explicit confirmation'],
  ['INS-20', 'package excludes forbidden directories'],
  ['SIG-21', 'no certificate → NotSigned'],
  ['SIG-22', 'never forge Signed'],
  ['SIG-23', 'signing password absent from logs'],
  ['SIG-24', 'signature result in Manifest'],
  ['SIG-25', 'invalid certificate blocks signing'],
  ['UPD-26', 'no feed UI'],
  ['UPD-27', 'Renderer cannot set URL'],
  ['UPD-28', 'loopback only in test'],
  ['UPD-29', 'RC channel'],
  ['UPD-30', 'explicit download'],
  ['UPD-31', 'explicit install'],
  ['UPD-32', 'no forced restart'],
  ['UPD-33', 'hash mismatch rejects'],
  ['UPD-34', 'future schema not overwritten'],
  ['UPD-35', 'pre-update backup'],
  ['UPD-36', 'Provider/history retained'],
  ['DIA-37', 'Release Metadata exported'],
  ['DIA-38', 'no API key'],
  ['DIA-39', 'no credential ref'],
  ['DIA-40', 'no vault path'],
  ['DIA-41', 'no source'],
  ['DIA-42', 'update logs redacted'],
  ['DIA-43', 'crash metadata redacted'],
  ['DIA-44', 'all sentinel secrets filtered'],
  ['SBM-45', 'SBOM generated'],
  ['SBM-46', 'production closure complete'],
  ['SBM-47', 'third-party notice generated'],
  ['SBM-48', 'unknown license flagged'],
  ['SBM-49', 'project license not auto-selected'],
  ['FDB-50', 'template has no user code'],
  ['FDB-51', 'diagnostics off by default'],
  ['FDB-52', 'only explicit inclusion'],
  ['FDB-53', 'absent URL stays local'],
  ['FDB-54', 'feedback result/path does not leak username'],
  ['SEC-55', 'release IPC sender check'],
  ['SEC-56', 'updater IPC sender check'],
  ['SEC-57', 'diagnostics IPC sender check'],
  ['SEC-58', 'release-artifact secret scan'],
  ['SEC-59', 'installer inventory scan'],
  ['SEC-60', 'Manifest path scan'],
] as const;

const EXPECTED_FINAL_PATH_SLICE = {
  'src/main/release/__tests__/ReleaseMetadata.test.ts': 'foundation-version-metadata',
  'tests/release/release-metadata-script.test.ts': 'foundation-version-metadata',
  'src/main/release/__tests__/VersionInfo.test.ts': 'foundation-version-metadata',
  'package.json': 'artifact-package-scans',
  'package-lock.json': 'foundation-version-metadata',
  'vite.main.config.ts': 'updater-source-policy',
  'src/main/index.ts': 'diagnostics-export',
  'src/shared/release-contract.json': 'updater-install-safety',
  'src/shared/types/release.ts': 'foundation-version-metadata',
  'src/main/release/ReleaseMetadata.ts': 'foundation-version-metadata',
  'src/main/release/VersionInfo.ts': 'foundation-version-metadata',
  'scripts/lib/release-metadata.mjs': 'foundation-version-metadata',
  'src/main/release/__tests__/InstallerConfig.test.ts': 'foundation-installer',
  'src/main/release/__tests__/AppIconPath.test.ts': 'foundation-installer',
  'tests/release/app-update-config.test.ts': 'foundation-installer',
  'electron-builder.yml': 'foundation-installer',
  'build-resources/installer.nsh': 'foundation-installer',
  'build-resources/app-update.yml': 'foundation-installer',
  'src/shared/update-bootstrap-contract.json': 'foundation-installer',
  'src/main/release/AppIcon.ts': 'foundation-installer',
  'src/main/release/UpdateBootstrapConfig.ts': 'foundation-installer',
  'scripts/generate-app-update-config.mjs': 'foundation-installer',
  'src/main/ipc/__tests__/release.test.ts': 'updater-ipc',
  'src/preload/__tests__/index.test.ts': 'beta-feedback',
  'src/preload/__tests__/transport-surface.test.ts': 'beta-feedback',
  'src/main/ipc/release.ts': 'updater-ipc',
  'src/preload/index.ts': 'beta-feedback',
  'src/shared/types/ipc.ts': 'beta-feedback',
  'tests/release/release-signing.test.ts': 'artifact-signing',
  'src/main/release/__tests__/AuthenticodeStatusReader.test.ts': 'artifact-signing',
  'src/main/release/__tests__/RuntimeReleaseStatus.test.ts': 'artifact-signing',
  'src/shared/authenticode-command.json': 'updater-install-safety',
  'scripts/release/signing.mjs': 'artifact-signing',
  'scripts/release/lib/authenticode.mjs': 'artifact-signing',
  'src/main/release/AuthenticodeStatusReader.ts': 'artifact-signing',
  'src/main/release/RuntimeReleaseStatus.ts': 'artifact-signing',
  'tests/release/release-sbom.test.ts': 'artifact-sbom',
  'scripts/release/sbom.mjs': 'artifact-sbom',
  'scripts/release/lib/artifact-inventory.mjs': 'artifact-sbom',
  'tests/release/release-manifest.test.ts': 'artifact-package-scans',
  'tests/release/release-verify.test.ts': 'artifact-package-scans',
  'scripts/release/manifest.mjs': 'artifact-package-scans',
  'scripts/release/verify.mjs': 'artifact-package-scans',
  'src/main/release/__tests__/UpdateSourcePolicy.test.ts': 'updater-source-policy',
  'src/main/release/__tests__/UpdateTransportGuard.test.ts': 'updater-source-policy',
  'src/main/release/__tests__/UpdateManager.test.ts': 'updater-install-safety',
  'src/main/release/UpdateSourcePolicy.ts': 'updater-source-policy',
  'src/main/release/UpdateTransportGuard.ts': 'updater-source-policy',
  'src/main/release/UpdateManager.ts': 'updater-install-safety',
  'src/main/release/__tests__/UpdateSignatureInspector.test.ts': 'updater-install-safety',
  'src/main/release/__tests__/UpdateInstallGuard.test.ts': 'updater-install-safety',
  'src/main/release/UpdateSignatureInspector.ts': 'updater-install-safety',
  'src/main/release/UpdateInstallGuard.ts': 'updater-install-safety',
  'src/main/ipc/__tests__/database-compatibility.test.ts': 'updater-ipc',
  'src/preload/__tests__/public-ipc-transport.test.ts': 'beta-feedback',
  'src/renderer/__tests__/public-api-facade.test.ts': 'beta-feedback',
  'src/main/ipc/database-compatibility.ts': 'updater-ipc',
  'src/main/diagnostics/__tests__/DiagnosticsSchemas.test.ts': 'diagnostics-export',
  'src/main/diagnostics/__tests__/DiagnosticsSnapshotProvider.test.ts': 'diagnostics-export',
  'src/main/files/__tests__/SafeUserSelectedWriter.test.ts': 'diagnostics-export',
  'src/main/diagnostics/__tests__/DiagnosticsExporter.test.ts': 'diagnostics-export',
  'src/main/diagnostics/__tests__/DiagnosticsExporter.release.test.ts': 'diagnostics-export',
  'src/main/ipc/__tests__/diagnostics.test.ts': 'diagnostics-ipc',
  'src/main/diagnostics/DiagnosticsSchemas.ts': 'diagnostics-export',
  'src/main/diagnostics/DiagnosticsSnapshotProvider.ts': 'diagnostics-export',
  'src/main/diagnostics/DiagnosticsExporter.ts': 'diagnostics-export',
  'src/main/files/SafeUserSelectedWriter.ts': 'beta-feedback',
  'src/main/ipc/diagnostics.ts': 'diagnostics-ipc',
  'src/main/logging/__tests__/StructuredLogger.test.ts': 'diagnostics-ipc',
  'src/main/logging/__tests__/StructuredLogger.release.test.ts': 'diagnostics-ipc',
  'src/main/diagnostics/__tests__/RendererErrorCollector.test.ts': 'diagnostics-ipc',
  'src/renderer/__tests__/renderer-bootstrap.test.ts': 'diagnostics-ipc',
  'src/main/logging/StructuredLogger.ts': 'diagnostics-ipc',
  'src/main/diagnostics/RendererErrorCollector.ts': 'diagnostics-ipc',
  'src/main/feedback/__tests__/BetaFeedbackService.test.ts': 'beta-feedback',
  'src/main/ipc/__tests__/feedback.test.ts': 'beta-feedback',
  'src/shared/types/feedback.ts': 'beta-feedback',
  'src/shared/feedback-config.json': 'beta-feedback',
  'src/main/feedback/BetaFeedbackService.ts': 'beta-feedback',
  'src/main/ipc/feedback.ts': 'beta-feedback',
} as const;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function evidenceOptions() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-workbench-tdd-evidence-'));
  temporaryRoots.push(root);
  const trackedPaths = [
    'src/main/ipc/release.ts',
    'src/preload/index.ts',
    'src/main/ipc/__tests__/release.test.ts',
    'src/preload/__tests__/index.test.ts',
    'src/preload/__tests__/transport-surface.test.ts',
    'src/shared/types/ipc.ts',
    'src/shared/release-contract.json',
  ];
  await Promise.all(trackedPaths.map(async (relativePath) => {
    const source = path.join(root, relativePath);
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, 'export const release = true;\n', 'utf8');
  }));
  return {
    evidencePath: path.join(root, 'release-validation', 'tdd', 'requirements-tdd-evidence.json'),
    workspaceRoot: root,
    isTrackedPath: async (relativePath: string) => trackedPaths.includes(relativePath),
    observedTestReferences: IPC_TEST_REFERENCES,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function rehashHistory(history: { entries: Array<Record<string, unknown>> }) {
  let previousHash: string | null = null;
  for (const entry of history.entries) {
    entry.previousRecordSha256 = previousHash;
    const { recordSha256: _recordSha256, ...unsigned } = entry;
    entry.recordSha256 = createHash('sha256').update(canonicalJson(unsigned)).digest('hex');
    previousHash = String(entry.recordSha256);
  }
}

async function createCliRepository() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'Claude Workbench β CLI-'));
  temporaryRoots.push(root);
  const greenPaths = [
    'src/main/ipc/release.ts',
    'src/preload/index.ts',
    'src/shared/types/ipc.ts',
    'src/main/ipc/__tests__/release.test.ts',
    'src/preload/__tests__/index.test.ts',
    'src/preload/__tests__/transport-surface.test.ts',
    'src/shared/release-contract.json',
  ];
  const packageJson = JSON.parse(await fs.readFile(path.join(workspace, 'package.json'), 'utf8'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'tdd-cli-fixture',
    private: true,
    scripts: { 'release:tdd-evidence': packageJson.scripts['release:tdd-evidence'] },
  }), 'utf8');
  for (const relativePath of ['scripts/release/tdd-evidence.mjs', 'scripts/release/requirements-contract.mjs', 'scripts/release/lib/tdd-evidence.mjs']) {
    const destination = path.join(root, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(workspace, relativePath), destination);
  }
  for (const relativePath of ['scripts/release/tdd-evidence-launcher.ps1', 'scripts/release/tdd-evidence-toolchain.json']) {
    const destination = path.join(root, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(workspace, relativePath), destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  const vitestStub = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
  await fs.mkdir(path.dirname(vitestStub), { recursive: true });
  await fs.writeFile(vitestStub, "import fs from 'node:fs'; const injected = Object.keys(process.env).filter((key) => /^(?:NODE|NPM|YARN|PNPM|ELECTRON|VSCODE|OPENSSL|SSL_CERT|UV_|COMPLUS_|COR_)/iu.test(key)); fs.appendFileSync('fixture-child-ran', `${injected.length === 0 ? 'clean' : injected.join(',')}\\n`); process.exit(fs.readFileSync('fixture-status', 'utf8').trim() === 'red' ? 1 : 0);\n", 'utf8');
  await execFile('git', ['init', '--quiet'], { cwd: root });
  await execFile('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
  await execFile('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  await execFile('git', ['add', 'package.json'], { cwd: root });
  await execFile('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root });
  await fs.writeFile(path.join(root, 'fixture-status'), 'red\n', 'utf8');
  await Promise.all(greenPaths.map(async (relativePath) => {
    const target = path.join(root, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, relativePath.endsWith('.json') ? '{}\n' : 'export const marker = true;\n', 'utf8');
  }));
  return { root, greenPaths };
}

async function createLinkedWorktreeCliRepository() {
  const primaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-primary-'));
  temporaryRoots.push(primaryRoot);
  await execFile('git', ['init', '--quiet'], { cwd: primaryRoot });
  await execFile('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: primaryRoot });
  await execFile('git', ['config', 'user.name', 'Fixture'], { cwd: primaryRoot });
  await fs.writeFile(path.join(primaryRoot, 'README.md'), 'linked worktree fixture\n', 'utf8');
  await execFile('git', ['add', 'README.md'], { cwd: primaryRoot });
  await execFile('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: primaryRoot });
  const linkedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'Claude Workbench 链接 空格-'));
  await fs.rm(linkedRoot, { recursive: true, force: true });
  temporaryRoots.push(linkedRoot);
  await execFile('git', ['worktree', 'add', '--quiet', '-b', 'linked-fixture', linkedRoot, 'HEAD'], { cwd: primaryRoot });
  const { root: sourceFixture } = await createCliRepository();
  for (const relativePath of ['package.json', 'fixture-status', ...IPC_TEST_REFERENCES,
    'src/main/ipc/release.ts', 'src/preload/index.ts', 'src/shared/types/ipc.ts', 'src/shared/release-contract.json',
    'scripts/release/tdd-evidence-launcher.ps1', 'scripts/release/tdd-evidence-toolchain.json',
    'scripts/release/tdd-evidence.mjs', 'scripts/release/requirements-contract.mjs', 'scripts/release/lib/tdd-evidence.mjs',
    'node_modules/vitest/vitest.mjs']) {
    const source = path.join(sourceFixture, relativePath);
    const destination = path.join(linkedRoot, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  }
  return { primaryRoot, root: linkedRoot };
}

async function runDirectCli(root: string, phase: 'red' | 'green', childArgv: string[], environment: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'release', 'tdd-evidence.mjs'),
      '--phase', phase,
      '--case-ids', 'SEC-55',
      '--command-id', 'foundation-release-ipc',
      '--',
      ...childArgv,
    ], {
      cwd: root,
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'safe.directory',
        GIT_CONFIG_VALUE_0: root,
        WORKBENCH_TDD_EVIDENCE_ROOT: path.join(root, 'outside'),
        WORKBENCH_TDD_EVIDENCE_PATH: path.join(root, 'outside', 'evidence.json'),
        ...environment,
      },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', () => resolve({ code: 1, stderr }));
    child.once('close', (code) => resolve({ code: Number.isInteger(code) ? Number(code) : 1, stderr }));
  });
}

async function runCli(root: string, phase: 'red' | 'green', childArgv: string[], environment: NodeJS.ProcessEnv = {}) {
  const systemDirectory = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const powershell = path.join(systemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    await execFile(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(root, 'scripts', 'release', 'tdd-evidence-launcher.ps1'),
      '-Phase', phase,
      '-CaseIds', 'SEC-55',
      '-CommandId', 'foundation-release-ipc',
      '-ChildArgumentsBase64', Buffer.from(childArgv.join('\0'), 'utf8').toString('base64'),
    ], {
      cwd: root,
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'safe.directory',
        GIT_CONFIG_VALUE_0: root,
        WORKBENCH_TDD_EVIDENCE_ROOT: path.join(root, 'outside'),
        WORKBENCH_TDD_EVIDENCE_PATH: path.join(root, 'outside', 'evidence.json'),
        ...environment,
      },
      windowsHide: true,
    });
    return { code: 0, stderr: '' };
  } catch (error) {
    return {
      code: Number.isInteger((error as { code?: number }).code) ? Number((error as { code?: number }).code) : 1,
      stderr: String((error as { stderr?: string }).stderr ?? ''),
    };
  }
}

async function instrumentFixtureLauncher(root: string) {
  const fixtureLauncherPath = path.join(root, 'scripts', 'release', 'tdd-evidence-launcher.ps1');
  const source = await fs.readFile(fixtureLauncherPath, 'utf8');
  const inspectionMarker = "  Assert-NonReparsePath -LiteralPath ([IO.Path]::Combine($PSScriptRoot, 'lib', 'tdd-evidence.mjs')) -RequireFile $true | Out-Null";
  const nodeStartMarker = "    if (-not $processStarted) { throw 'The trusted Node process did not start.' }";
  expect(source.split(inspectionMarker)).toHaveLength(2);
  expect(source.split(nodeStartMarker)).toHaveLength(2);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const instrumented = source
    .replace(inspectionMarker, [
      inspectionMarker,
      "  [IO.File]::WriteAllText([IO.Path]::Combine($workspaceRoot, 'launcher-inspection-ready'), 'ready')",
      "  $inspectionRelease = [IO.Path]::Combine($workspaceRoot, 'launcher-inspection-release')",
      '  $inspectionDeadline = [DateTime]::UtcNow.AddSeconds(10)',
      '  while (-not [IO.File]::Exists($inspectionRelease)) {',
      "    if ([DateTime]::UtcNow -ge $inspectionDeadline) { throw 'Fixture launcher inspection barrier timed out.' }",
      '    [Threading.Thread]::Sleep(10)',
      '  }',
    ].join(newline))
    .replace(nodeStartMarker, `${nodeStartMarker}${newline}    [IO.File]::WriteAllText([IO.Path]::Combine($workspaceRoot, 'node-process-started'), 'started')`);
  await fs.writeFile(fixtureLauncherPath, instrumented, 'utf8');
}

async function instrumentAllInputsOpenBarrier(root: string) {
  const fixtureLauncherPath = path.join(root, 'scripts', 'release', 'tdd-evidence-launcher.ps1');
  const source = await fs.readFile(fixtureLauncherPath, 'utf8');
  const marker = '    if ((Get-Sha256FromStream -Stream $protectedInputStream) -ne $protectedInputHashes[$relativePath]) {';
  expect(source.split(marker)).toHaveLength(2);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const instrumented = source.replace(marker, [
    "    [IO.File]::WriteAllText([IO.Path]::Combine($workspaceRoot, 'project-content-read-ready'), 'ready')",
    "    $contentReadRelease = [IO.Path]::Combine($workspaceRoot, 'project-content-read-release')",
    '    $contentReadDeadline = [DateTime]::UtcNow.AddSeconds(10)',
    '    while (-not [IO.File]::Exists($contentReadRelease)) {',
    "      if ([DateTime]::UtcNow -ge $contentReadDeadline) { throw 'Fixture content-read barrier timed out.' }",
    '      [Threading.Thread]::Sleep(10)',
    '    }',
    marker,
  ].join(newline));
  await fs.writeFile(fixtureLauncherPath, instrumented, 'utf8');
}

async function instrumentFinalIdentityAudit(root: string) {
  const fixtureLauncherPath = path.join(root, 'scripts', 'release', 'tdd-evidence-launcher.ps1');
  const source = await fs.readFile(fixtureLauncherPath, 'utf8');
  const functionMarker = [
    '    [Parameter(Mandatory = $true)][bool] $RequireFile',
    '  )',
    '',
    "  if (-not [IO.Path]::IsPathRooted($LiteralPath)) { throw 'Path must be absolute.' }",
  ].join(source.includes('\r\n') ? '\r\n' : '\n');
  const enableMarker = "  $start.EnvironmentVariables['WORKBENCH_TDD_LAUNCH_TOKEN'] = $nonce";
  expect(source.split(functionMarker)).toHaveLength(2);
  expect(source.split(enableMarker)).toHaveLength(2);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const instrumented = source
    .replace(functionMarker, [
      '    [Parameter(Mandatory = $true)][bool] $RequireFile',
      '  )',
      '',
      "  $fixtureAuditEnabled = [IO.Path]::Combine($PSScriptRoot, '..', '..', 'final-identity-audit-enabled')",
      '  if ($RequireFile -and [IO.File]::Exists($fixtureAuditEnabled)) {',
      "    [IO.File]::AppendAllText([IO.Path]::Combine($PSScriptRoot, '..', '..', 'final-identity-audit.log'), [IO.Path]::GetFullPath($LiteralPath) + [Environment]::NewLine)",
      '  }',
      '',
      "  if (-not [IO.Path]::IsPathRooted($LiteralPath)) { throw 'Path must be absolute.' }",
    ].join(newline))
    .replace(enableMarker, `${enableMarker}${newline}  [IO.File]::WriteAllText([IO.Path]::Combine($workspaceRoot, 'final-identity-audit-enabled'), 'enabled')`);
  await fs.writeFile(fixtureLauncherPath, instrumented, 'utf8');
}

async function instrumentOsHandleAudit(root: string) {
  const fixtureLauncherPath = path.join(root, 'scripts', 'release', 'tdd-evidence-launcher.ps1');
  const source = await fs.readFile(fixtureLauncherPath, 'utf8');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const marker = [
    '      $process.StandardInput.Close()',
    '      $process.WaitForExit()',
  ].join(newline);
  expect(source.split(marker)).toHaveLength(2);
  const instrumented = source.replace(marker, [
    '      $process.StandardInput.Close()',
    "      $fixtureChildStarted = [IO.Path]::Combine($workspaceRoot, 'fixture-child-started')",
    '      $fixtureChildDeadline = [DateTime]::UtcNow.AddSeconds(10)',
    '      while (-not [IO.File]::Exists($fixtureChildStarted)) {',
    "        if ([DateTime]::UtcNow -ge $fixtureChildDeadline) { throw 'Fixture OS-handle child-running barrier timed out.' }",
    '        [Threading.Thread]::Sleep(10)',
    '      }',
    '      $fixtureOsAudit = @(',
    "        [PSCustomObject]@{ Label = 'node'; Path = $nodePath; Stream = $nodeStream },",
    "        [PSCustomObject]@{ Label = 'powershell'; Path = $trustedPowerShell; Stream = $heldStreams[$heldStreams.Count - 2] },",
    "        [PSCustomObject]@{ Label = 'cmd'; Path = $trustedCmd; Stream = $heldStreams[$heldStreams.Count - 1] }",
    '      ) | ForEach-Object {',
    '        $fixtureFacts = Get-FileHandleFacts -Stream $_.Stream',
    "        [String]::Join('|', @($_.Label, [IO.Path]::GetFullPath($_.Path), $fixtureFacts.Identity, $fixtureFacts.FinalPath, $_.Stream.CanRead))",
    '      }',
    "      [IO.File]::WriteAllLines([IO.Path]::Combine($workspaceRoot, 'os-handle-audit.log'), $fixtureOsAudit)",
    '      $process.WaitForExit()',
  ].join(newline));
  await fs.writeFile(fixtureLauncherPath, instrumented, 'utf8');
}

async function instrumentAssignFailure(root: string) {
  const fixtureLauncherPath = path.join(root, 'scripts', 'release', 'tdd-evidence-launcher.ps1');
  const fixtureCliPath = path.join(root, 'scripts', 'release', 'tdd-evidence.mjs');
  const fixtureCli = [
    "import fs from 'node:fs';",
    "fs.writeFileSync('assign-failure-node-ran', String(process.pid));",
    'setInterval(() => undefined, 1_000);',
    '',
  ].join('\n');
  await fs.writeFile(fixtureCliPath, fixtureCli, 'utf8');

  const source = await fs.readFile(fixtureLauncherPath, 'utf8');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const approvedCliHash = PROTECTED_INPUTS.find(([, relativePath]) => relativePath === 'scripts/release/tdd-evidence.mjs')![2];
  const fixtureCliHash = createHash('sha256').update(fixtureCli).digest('hex');
  const hashMarker = `'scripts/release/tdd-evidence.mjs' = '${approvedCliHash}'`;
  const startMarker = "    if (-not $processStarted) { throw 'The trusted Node process did not start.' }";
  const assignMarker = '    if (-not $nativeApi::AssignProcessToJobObject($jobHandle, $process.Handle)) {';
  const disposeMarker = '    $process.Dispose()';
  expect(source.split(hashMarker)).toHaveLength(2);
  expect(source.split(startMarker)).toHaveLength(2);
  expect(source.split(assignMarker)).toHaveLength(2);
  expect(source.split(disposeMarker)).toHaveLength(2);
  const instrumented = source
    .replace(hashMarker, `'scripts/release/tdd-evidence.mjs' = '${fixtureCliHash}'`)
    .replace(startMarker, [
      startMarker,
      "    [IO.File]::WriteAllText([IO.Path]::Combine($workspaceRoot, 'forced-node-pid'), [string]$process.Id)",
      "    $fixtureNodeReady = [IO.Path]::Combine($workspaceRoot, 'assign-failure-node-ran')",
      '    $fixtureNodeDeadline = [DateTime]::UtcNow.AddSeconds(10)',
      '    while (-not [IO.File]::Exists($fixtureNodeReady)) {',
      "      if ([DateTime]::UtcNow -ge $fixtureNodeDeadline) { throw 'Fixture assignment-failure Node start barrier timed out.' }",
      '      [Threading.Thread]::Sleep(10)',
      '    }',
    ].join(newline))
    .replace(assignMarker, '    if (-not $false) {')
    .replace(disposeMarker, [
      disposeMarker,
      "    [IO.File]::WriteAllText([IO.Path]::Combine($workspaceRoot, 'assign-failure-cleanup-ready'), 'ready')",
      "    $cleanupRelease = [IO.Path]::Combine($workspaceRoot, 'assign-failure-cleanup-release')",
      '    $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(10)',
      '    while (-not [IO.File]::Exists($cleanupRelease)) {',
      "      if ([DateTime]::UtcNow -ge $cleanupDeadline) { throw 'Fixture assignment-failure cleanup barrier timed out.' }",
      '      [Threading.Thread]::Sleep(10)',
      '    }',
    ].join(newline));
  await fs.writeFile(fixtureLauncherPath, instrumented, 'utf8');
}

async function instrumentPostStartFailure(root: string) {
  const fixtureLauncherPath = path.join(root, 'scripts', 'release', 'tdd-evidence-launcher.ps1');
  const source = await fs.readFile(fixtureLauncherPath, 'utf8');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const challengeMarker = [
    '      $jobAssigned = $true',
    '      $process.StandardInput.WriteLine($nonce)',
  ].join(newline);
  const disposeMarker = '    $process.Dispose()';
  expect(source.split(challengeMarker)).toHaveLength(2);
  expect(source.split(disposeMarker)).toHaveLength(2);
  const instrumented = source
    .replace(challengeMarker, [
      '      $jobAssigned = $true',
      "      [IO.File]::WriteAllText([IO.Path]::Combine($workspaceRoot, 'forced-node-pid'), [string]$process.Id)",
      "      throw 'Fixture forced post-start failure before the synchronous challenge.'",
      '      $process.StandardInput.WriteLine($nonce)',
    ].join(newline))
    .replace(disposeMarker, [
      disposeMarker,
      "    [IO.File]::WriteAllText([IO.Path]::Combine($workspaceRoot, 'post-start-cleanup-ready'), 'ready')",
      "    $cleanupRelease = [IO.Path]::Combine($workspaceRoot, 'post-start-cleanup-release')",
      '    $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(10)',
      '    while (-not [IO.File]::Exists($cleanupRelease)) {',
      "      if ([DateTime]::UtcNow -ge $cleanupDeadline) { throw 'Fixture cleanup barrier timed out.' }",
      '      [Threading.Thread]::Sleep(10)',
      '    }',
    ].join(newline));
  await fs.writeFile(fixtureLauncherPath, instrumented, 'utf8');
}

async function instrumentPostChildStartFailure(root: string) {
  const fixtureLauncherPath = path.join(root, 'scripts', 'release', 'tdd-evidence-launcher.ps1');
  const source = await fs.readFile(fixtureLauncherPath, 'utf8');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const waitMarker = [
    '      $process.StandardInput.Close()',
    '      $process.WaitForExit()',
  ].join(newline);
  const disposeMarker = '    $process.Dispose()';
  expect(source.split(waitMarker)).toHaveLength(2);
  expect(source.split(disposeMarker)).toHaveLength(2);
  const instrumented = source
    .replace(waitMarker, [
      '      $process.StandardInput.Close()',
      "      $fixtureChildStarted = [IO.Path]::Combine($workspaceRoot, 'fixture-child-started')",
      '      $fixtureChildDeadline = [DateTime]::UtcNow.AddSeconds(10)',
      '      while (-not [IO.File]::Exists($fixtureChildStarted)) {',
      "        if ([DateTime]::UtcNow -ge $fixtureChildDeadline) { throw 'Fixture child start barrier timed out.' }",
      '        [Threading.Thread]::Sleep(10)',
      '      }',
      "      [IO.File]::WriteAllText([IO.Path]::Combine($workspaceRoot, 'forced-node-pid'), [string]$process.Id)",
      "      throw 'Fixture forced post-start failure after the child started.'",
      '      $process.WaitForExit()',
    ].join(newline))
    .replace(disposeMarker, [
      disposeMarker,
      "    [IO.File]::WriteAllText([IO.Path]::Combine($workspaceRoot, 'post-child-cleanup-ready'), 'ready')",
      "    $cleanupRelease = [IO.Path]::Combine($workspaceRoot, 'post-child-cleanup-release')",
      '    $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(10)',
      '    while (-not [IO.File]::Exists($cleanupRelease)) {',
      "      if ([DateTime]::UtcNow -ge $cleanupDeadline) { throw 'Fixture cleanup barrier timed out.' }",
      '      [Threading.Thread]::Sleep(10)',
      '    }',
    ].join(newline));
  await fs.writeFile(fixtureLauncherPath, instrumented, 'utf8');
}

async function processIsAlive(processId: number) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function stopProcessIfAlive(processId: number | undefined) {
  if (!processId || !(await processIsAlive(processId))) return;
  try { process.kill(processId); } catch { /* best-effort cleanup for a deliberately broken RED */ }
}

async function waitForProcessExit(processId: number | undefined) {
  if (!processId) return;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!(await processIsAlive(processId))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fixture process ${processId} did not exit`);
}

async function renameAfterReleased(from: string, to: string) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !/^(?:EACCES|EBUSY|EPERM)$/u.test(code ?? '') || attempt >= 39) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function startCli(root: string, phase: 'red' | 'green', childArgv: string[], environment: NodeJS.ProcessEnv = {}) {
  const systemDirectory = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const powershell = path.join(systemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(root, 'scripts', 'release', 'tdd-evidence-launcher.ps1'),
    '-Phase', phase,
    '-CaseIds', 'SEC-55',
    '-CommandId', 'foundation-release-ipc',
    '-ChildArgumentsBase64', Buffer.from(childArgv.join('\0'), 'utf8').toString('base64'),
  ], {
    cwd: root,
    env: { ...process.env, ...environment },
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const result = new Promise<{ code: number; stderr: string }>((resolve) => {
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', () => resolve({ code: 1, stderr }));
    child.once('close', (code) => resolve({ code: Number.isInteger(code) ? Number(code) : 1, stderr }));
  });
  return { child, result };
}

async function waitForFile(filePath: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fs.stat(filePath).then(() => true).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path.basename(filePath)}`);
}

async function makeCliSourcesGreen(root: string) {
  await fs.writeFile(path.join(root, 'fixture-status'), 'green\n', 'utf8');
}

async function runOfficialPlanCli(root: string, environment: NodeJS.ProcessEnv = {}) {
  const plan = await fs.readFile(path.join(workspace, PLAN_PATHS[0]), 'utf8');
  const common = {
    cwd: root,
    env: { ...process.env, ...environment },
    windowsHide: true,
  };
  try {
    const systemDirectory = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    const powershell = path.join(systemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const officialCommand = [...plan.matchAll(/Run \(observed red\): `([^`]+)`/gu)]
      .map((match) => match[1])
      .find((command) => command.includes('-CommandId foundation-release-ipc'));
    if (!officialCommand) throw new Error('missing official plan command');
    const invocationScript = path.join(root, 'invoke-official-plan-command.ps1');
    await fs.writeFile(invocationScript, `${officialCommand}\n`, 'utf8');
    const { stdout, stderr } = await execFile(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', invocationScript,
    ], common);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: Number((error as { code?: number }).code ?? 1),
      stderr: String((error as { stderr?: string }).stderr ?? ''),
    };
  }
}

describe('release TDD evidence', () => {
  it('freezes all 60 planned requirements with their exact descriptions', () => {
    expect(TDD_REQUIREMENT_CASES.map(({ id, description }) => [id, description])).toEqual(EXPECTED_CASES);
    expect(new Set(TDD_REQUIREMENT_CASES.map(({ id }) => id)).size).toBe(60);
    expect(TDD_COMMAND_SLICES).toHaveLength(12);
    for (const slice of TDD_COMMAND_SLICES) {
      for (const phaseName of ['red', 'green'] as const) {
        expect(() => assertTddChildArgv(slice.commandId, phaseName, slice.phases[phaseName].childArgv)).not.toThrow();
      }
    }
  });

  it('matches the independently frozen direct Vitest vectors for every approved phase', () => {
    const expected = [
      ['foundation-version-metadata', 'red', ['VER-01', 'VER-02', 'VER-03', 'VER-04', 'VER-05', 'VER-06', 'VER-07', 'META-08', 'META-09', 'META-10', 'META-11', 'META-12']],
      ['foundation-version-metadata', 'green', ['VER-01', 'VER-02', 'VER-03', 'VER-04', 'VER-05', 'VER-06', 'VER-07', 'META-08', 'META-09', 'META-10', 'META-11', 'META-12']],
      ['foundation-installer', 'red', ['INS-13', 'INS-14', 'INS-15', 'INS-16', 'INS-17', 'INS-18', 'INS-19', 'INS-20']],
      ['foundation-installer', 'green', ['INS-13', 'INS-14', 'INS-15', 'INS-16', 'INS-17', 'INS-18', 'INS-19', 'INS-20']],
      ['foundation-release-ipc', 'red', ['SEC-55']], ['foundation-release-ipc', 'green', ['SEC-55']],
      ['artifact-signing', 'red', ['SIG-21', 'SIG-22', 'SIG-23', 'SIG-24', 'SIG-25']], ['artifact-signing', 'green', ['SIG-21', 'SIG-22', 'SIG-23', 'SIG-24', 'SIG-25']],
      ['artifact-sbom', 'red', ['SBM-45', 'SBM-46', 'SBM-47', 'SBM-48', 'SBM-49']], ['artifact-sbom', 'green', ['SBM-45', 'SBM-46', 'SBM-47', 'SBM-48', 'SBM-49']],
      ['artifact-package-scans', 'red', ['SEC-58', 'SEC-59', 'SEC-60']], ['artifact-package-scans', 'green', ['SEC-58', 'SEC-59', 'SEC-60']],
      ['updater-source-policy', 'red', ['UPD-26', 'UPD-28', 'UPD-29']], ['updater-source-policy', 'green', ['UPD-26', 'UPD-28', 'UPD-29']],
      ['updater-install-safety', 'red', ['UPD-30', 'UPD-31', 'UPD-32', 'UPD-33', 'UPD-34', 'UPD-35', 'UPD-36']], ['updater-install-safety', 'green', ['UPD-30', 'UPD-31', 'UPD-32', 'UPD-33', 'UPD-34', 'UPD-35', 'UPD-36']],
      ['updater-ipc', 'red', ['UPD-27', 'SEC-56']], ['updater-ipc', 'green', ['UPD-27', 'SEC-56']],
      ['diagnostics-export', 'red', ['DIA-37', 'DIA-38', 'DIA-39', 'DIA-40', 'DIA-41', 'DIA-42', 'DIA-43', 'DIA-44']], ['diagnostics-export', 'green', ['DIA-37', 'DIA-38', 'DIA-39', 'DIA-40', 'DIA-41', 'DIA-42', 'DIA-43', 'DIA-44']],
      ['diagnostics-ipc', 'red', ['SEC-57']], ['diagnostics-ipc', 'green', ['SEC-57']],
      ['beta-feedback', 'red', ['FDB-50', 'FDB-51', 'FDB-52', 'FDB-53', 'FDB-54']], ['beta-feedback', 'green', ['FDB-50', 'FDB-51', 'FDB-52', 'FDB-53', 'FDB-54']],
    ];
    expect(TDD_COMMAND_SLICES.flatMap((slice) => ['red', 'green'].map((phase) => [slice.commandId, phase, slice.caseIds, slice.phases[phase].childArgv]))).toEqual(
      expected.map(([commandId, phase, caseIds]) => [commandId, phase, caseIds, ['node', 'node_modules/vitest/vitest.mjs', 'run', ...TDD_COMMAND_SLICES.find((slice) => slice.commandId === commandId)!.phases[phase as 'red'].testReferences]]),
    );
  });

  it('parses every copyable plan recorder command and exactly matches its approved vector', async () => {
    const observed: Array<[string, string, string[], string[]]> = [];
    for (const plan of PLAN_PATHS) {
      const source = await fs.readFile(path.join(workspace, plan), 'utf8');
      const commands = [...source.matchAll(/Run \(observed (red|green)\): `([^`]+)`/gu)];
      for (const command of commands) {
        expect(command[2].startsWith(`${OFFICIAL_LAUNCHER_COMMAND} `)).toBe(true);
        expect(command[2].endsWith(OFFICIAL_LAUNCHER_EXIT)).toBe(true);
        const invocation = command[2].slice(OFFICIAL_LAUNCHER_COMMAND.length, -OFFICIAL_LAUNCHER_EXIT.length).match(/^ -Phase (red|green) -CaseIds ([A-Z0-9,-]+) -CommandId ([a-z-]+) -ChildArgumentsBase64 ([A-Za-z0-9+/]+={0,2})$/u);
        expect(invocation).not.toBeNull();
        expect(command[1]).toBe(invocation![1]);
        observed.push([invocation![3], invocation![1], invocation![2].split(','), Buffer.from(invocation![4], 'base64').toString('utf8').split('\0')]);
      }
    }
    expect(observed).toHaveLength(24);
    expect(observed).toEqual([
      ...TDD_COMMAND_SLICES.map((slice) => [slice.commandId, 'red', slice.caseIds, slice.phases.red.childArgv]),
      ...TDD_COMMAND_SLICES.map((slice) => [slice.commandId, 'green', slice.caseIds, slice.phases.green.childArgv]),
    ]);
    expect(new Set(observed.map(([id, phase]) => `${id}:${phase}`)).size).toBe(24);
  });

  it('freezes the exact newly index-invisible paths for all twelve intent-to-add steps', async () => {
    const expectedNewlyIndexInvisiblePaths = {
      'foundation-version-metadata': ['src/main/release/__tests__/ReleaseMetadata.test.ts', 'tests/release/release-metadata-script.test.ts', 'src/main/release/__tests__/VersionInfo.test.ts', 'src/shared/release-contract.json', 'src/shared/types/release.ts', 'src/main/release/ReleaseMetadata.ts', 'src/main/release/VersionInfo.ts', 'scripts/lib/release-metadata.mjs'],
      'foundation-installer': ['build-resources/installer.nsh', 'build-resources/app-update.yml', 'src/shared/update-bootstrap-contract.json', 'src/main/release/AppIcon.ts', 'src/main/release/UpdateBootstrapConfig.ts', 'scripts/generate-app-update-config.mjs', 'src/main/release/__tests__/InstallerConfig.test.ts', 'src/main/release/__tests__/AppIconPath.test.ts', 'tests/release/app-update-config.test.ts'],
      'foundation-release-ipc': ['src/main/ipc/__tests__/release.test.ts', 'src/preload/__tests__/index.test.ts', 'src/preload/__tests__/transport-surface.test.ts'],
      'artifact-signing': ['src/shared/authenticode-command.json', 'src/main/release/AuthenticodeStatusReader.ts', 'src/main/release/RuntimeReleaseStatus.ts', 'src/main/release/__tests__/AuthenticodeStatusReader.test.ts', 'src/main/release/__tests__/RuntimeReleaseStatus.test.ts', 'scripts/release/lib/authenticode.mjs', 'scripts/release/signing.mjs', 'tests/release/release-signing.test.ts'],
      'artifact-sbom': ['scripts/release/lib/artifact-inventory.mjs', 'scripts/release/sbom.mjs', 'tests/release/release-sbom.test.ts'],
      'artifact-package-scans': ['scripts/release/manifest.mjs', 'scripts/release/verify.mjs', 'tests/release/release-manifest.test.ts', 'tests/release/release-verify.test.ts'],
      'updater-source-policy': ['src/main/release/UpdateSourcePolicy.ts', 'src/main/release/UpdateTransportGuard.ts', 'src/main/release/UpdateManager.ts', 'src/main/release/__tests__/UpdateSourcePolicy.test.ts', 'src/main/release/__tests__/UpdateTransportGuard.test.ts', 'src/main/release/__tests__/UpdateManager.test.ts'],
      'updater-install-safety': ['src/main/release/UpdateSignatureInspector.ts', 'src/main/release/UpdateInstallGuard.ts', 'src/main/release/__tests__/UpdateSignatureInspector.test.ts', 'src/main/release/__tests__/UpdateInstallGuard.test.ts'],
      'updater-ipc': ['src/main/ipc/database-compatibility.ts', 'src/main/ipc/__tests__/database-compatibility.test.ts', 'src/preload/__tests__/public-ipc-transport.test.ts', 'src/renderer/__tests__/public-api-facade.test.ts'],
      'diagnostics-export': ['src/main/diagnostics/DiagnosticsSchemas.ts', 'src/main/diagnostics/DiagnosticsSnapshotProvider.ts', 'src/main/files/SafeUserSelectedWriter.ts', 'src/main/diagnostics/DiagnosticsExporter.ts', 'src/main/ipc/diagnostics.ts', 'src/main/diagnostics/__tests__/DiagnosticsSchemas.test.ts', 'src/main/diagnostics/__tests__/DiagnosticsSnapshotProvider.test.ts', 'src/main/files/__tests__/SafeUserSelectedWriter.test.ts', 'src/main/diagnostics/__tests__/DiagnosticsExporter.test.ts', 'src/main/diagnostics/__tests__/DiagnosticsExporter.release.test.ts', 'src/main/ipc/__tests__/diagnostics.test.ts'],
      'diagnostics-ipc': ['src/main/diagnostics/RendererErrorCollector.ts', 'src/main/diagnostics/__tests__/RendererErrorCollector.test.ts', 'src/main/logging/__tests__/StructuredLogger.release.test.ts', 'src/preload/__tests__/public-ipc-transport.test.ts', 'src/renderer/__tests__/public-api-facade.test.ts', 'src/renderer/__tests__/renderer-bootstrap.test.ts'],
      'beta-feedback': ['src/shared/types/feedback.ts', 'src/shared/feedback-config.json', 'src/main/feedback/BetaFeedbackService.ts', 'src/main/ipc/feedback.ts', 'src/main/feedback/__tests__/BetaFeedbackService.test.ts', 'src/main/ipc/__tests__/feedback.test.ts', 'src/preload/__tests__/public-ipc-transport.test.ts', 'src/renderer/__tests__/public-api-facade.test.ts'],
    };
    const sources = await Promise.all(PLAN_PATHS.map((plan) => fs.readFile(path.join(workspace, plan), 'utf8')));
    const actualNewlyIndexInvisiblePaths = Object.fromEntries(sources.flatMap((source) => [...source.matchAll(/Run: `git add -N -- ([^`]+)` \(intent-to-add for ([a-z-]+):[^\n]*\)\./gu)]
      .map((match) => [match[2], match[1].split(' ')])));
    const artifactSigningOwnedInputs = TDD_COMMAND_SLICES.find(({ commandId }) => commandId === 'artifact-signing')?.relatedSourcePaths;
    expect(artifactSigningOwnedInputs).toContain('src/shared/release-contract.json');
    expect(expectedNewlyIndexInvisiblePaths['artifact-signing']).not.toContain('src/shared/release-contract.json');
    const trackedContract = await execFile('git', ['ls-files', '--error-unmatch', '--', 'src/shared/release-contract.json'], { cwd: workspace });
    expect(trackedContract.stdout.trim()).toBe('src/shared/release-contract.json');
    expect(actualNewlyIndexInvisiblePaths).toEqual(expectedNewlyIndexInvisiblePaths);
    const paired = sources.flatMap((source) => [...source.matchAll(/Run: `git add -N -- [^`]+` \(intent-to-add for ([a-z-]+):[^\n]*\)\.\r?\n\r?\nRun \(diagnostic green, not recorded\):/gu)]
      .map((match) => match[1]));
    expect(paired).toEqual(Object.keys(expectedNewlyIndexInvisiblePaths));
  });

  it('exports the complete final green order and one unambiguous last slice for every observed path', () => {
    const expectedOrder = ['foundation-version-metadata', 'foundation-installer', 'foundation-release-ipc', 'artifact-signing', 'artifact-sbom', 'artifact-package-scans', 'updater-source-policy', 'updater-install-safety', 'updater-ipc', 'diagnostics-export', 'diagnostics-ipc', 'beta-feedback'];
    const finalOrder = (requirementsContract as typeof requirementsContract & { TDD_FINAL_GREEN_ORDER?: string[] }).TDD_FINAL_GREEN_ORDER;
    const finalByPath = (requirementsContract as typeof requirementsContract & { TDD_FINAL_PATH_OBSERVATION_SLICE?: Record<string, string> }).TDD_FINAL_PATH_OBSERVATION_SLICE;
    expect(finalOrder).toEqual(expectedOrder);
    expect(finalByPath).toEqual(EXPECTED_FINAL_PATH_SLICE);
    expect(Object.keys(finalByPath ?? {}).sort()).toEqual(Object.keys(TDD_GREEN_PATH_OBSERVATION_SLICES).sort());
  });

  it('places every planned modifier before the final green phase, including shared and non-observation tasks', async () => {
    const sources = await Promise.all(PLAN_PATHS.map((plan) => fs.readFile(path.join(workspace, plan), 'utf8')));
    const combined = sources.join('\n');
    const finalPhase = combined.indexOf('### Task 7: Execute final build, real acceptance, and audit');
    const firstFinalGreen = combined.indexOf('Run (observed green):', finalPhase);
    expect(finalPhase).toBeGreaterThan(0);
    expect(firstFinalGreen).toBeGreaterThan(finalPhase);
    const modifiers = new Map<string, number[]>();
    for (const match of combined.matchAll(/^- (?:Create(?: generated| test)?|Modify(?: test)?|Test): `([^`]+)`/gmu)) {
      const positions = modifiers.get(match[1]) ?? [];
      positions.push(match.index);
      modifiers.set(match[1], positions);
    }
    for (const observedPath of Object.keys(EXPECTED_FINAL_PATH_SLICE)) {
      const positions = modifiers.get(observedPath);
      expect(positions, 'missing lifecycle declaration for ' + observedPath).toBeDefined();
      expect(positions!.at(-1), 'late modifier for ' + observedPath).toBeLessThan(firstFinalGreen);
    }
    for (const sharedPath of ['package.json', 'vite.main.config.ts', 'electron-builder.yml', 'src/main/index.ts', 'src/preload/index.ts', 'src/shared/types/ipc.ts']) {
      expect(modifiers.get(sharedPath)!.length).toBeGreaterThan(1);
    }
    expect([...combined.slice(firstFinalGreen).matchAll(/^- (?:Create|Modify|Test)(?: [^:]+)?: `([^`]+)`/gmu)]).toEqual([]);
  });

  it('keeps all five plans valid UTF-8 with exact approved Chinese disclosures and no mojibake', async () => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const sources = await Promise.all(PLAN_PATHS.map(async (plan) => decoder.decode(await fs.readFile(path.join(workspace, plan)))));
    const foundation = sources[0];
    const diagnostics = sources[3];
    const affiliation = 'Claude Workbench 是独立第三方软件，与 Anthropic、OpenAI 及其关联公司不存在官方隶属、授权或背书关系。';
    expect(foundation).toContain('!define MUI_WELCOMEPAGE_TEXT "' + affiliation + '$\\r$\\n$\\r$\\n这是未签名的封闭 Beta 测试版本。"');
    expect(diagnostics.split(affiliation)).toHaveLength(3);
    expect(diagnostics).toContain(String.fromCharCode(96) + '默认不上传遥测或诊断信息' + String.fromCharCode(96));
    for (const source of sources) {
      expect(source).not.toContain('�');
      for (const fragment of ['鏄嫭', '鈥', '銆', '脳', '鈫', '榛樿', '璇ュ浘']) expect(source).not.toContain(fragment);
      expect(source.split(String.fromCharCode(96).repeat(3)).length % 2).toBe(1);
    }
  });

  it('freezes complete, independently reviewed source allowlists for all twelve slices', () => {
    const expected = {
      'foundation-version-metadata': ['package.json', 'package-lock.json', 'vite.main.config.ts', 'src/main/index.ts', 'src/shared/release-contract.json', 'src/shared/types/release.ts', 'src/main/release/ReleaseMetadata.ts', 'src/main/release/VersionInfo.ts', 'scripts/lib/release-metadata.mjs'],
      'foundation-installer': ['electron-builder.yml', 'build-resources/installer.nsh', 'build-resources/app-update.yml', 'src/shared/update-bootstrap-contract.json', 'src/main/release/AppIcon.ts', 'src/main/release/UpdateBootstrapConfig.ts', 'scripts/generate-app-update-config.mjs'],
      'foundation-release-ipc': ['src/main/ipc/release.ts', 'src/preload/index.ts', 'src/shared/types/ipc.ts', 'src/shared/release-contract.json'],
      'artifact-signing': ['package.json', 'src/shared/authenticode-command.json', 'src/shared/release-contract.json', 'scripts/release/signing.mjs', 'scripts/release/lib/authenticode.mjs', 'src/main/release/AuthenticodeStatusReader.ts', 'src/main/release/RuntimeReleaseStatus.ts'],
      'artifact-sbom': ['package.json', 'scripts/release/sbom.mjs', 'scripts/release/lib/artifact-inventory.mjs'],
      'artifact-package-scans': ['package.json', 'scripts/release/manifest.mjs', 'scripts/release/verify.mjs'],
      'updater-source-policy': ['src/main/release/UpdateSourcePolicy.ts', 'src/main/release/UpdateTransportGuard.ts', 'src/main/release/UpdateManager.ts', 'src/main/index.ts', 'vite.main.config.ts'],
      'updater-install-safety': ['src/main/release/UpdateSignatureInspector.ts', 'src/main/release/UpdateInstallGuard.ts', 'src/main/release/UpdateManager.ts', 'src/shared/authenticode-command.json', 'src/shared/release-contract.json'],
      'updater-ipc': ['src/main/ipc/release.ts', 'src/main/ipc/database-compatibility.ts', 'src/preload/index.ts', 'src/shared/types/ipc.ts', 'src/main/index.ts'],
      'diagnostics-export': ['src/main/diagnostics/DiagnosticsSchemas.ts', 'src/main/diagnostics/DiagnosticsSnapshotProvider.ts', 'src/main/diagnostics/DiagnosticsExporter.ts', 'src/main/files/SafeUserSelectedWriter.ts', 'src/main/ipc/diagnostics.ts', 'src/main/index.ts'],
      'diagnostics-ipc': ['src/main/logging/StructuredLogger.ts', 'src/main/diagnostics/RendererErrorCollector.ts', 'src/main/ipc/diagnostics.ts', 'src/preload/index.ts', 'src/shared/types/ipc.ts'],
      'beta-feedback': ['src/shared/types/feedback.ts', 'src/shared/feedback-config.json', 'src/main/feedback/BetaFeedbackService.ts', 'src/main/files/SafeUserSelectedWriter.ts', 'src/main/ipc/feedback.ts', 'src/preload/index.ts', 'src/shared/types/ipc.ts'],
    };
    expect(Object.fromEntries(TDD_COMMAND_SLICES.map((slice) => [slice.commandId, slice.relatedSourcePaths]))).toEqual(expected);
  });

  it('permits an existing untracked red test and does not rehash earlier tests after a later slice', async () => {
    const options = await evidenceOptions();
    await expect(runObservedTddCommand({
      ...options,
      isTrackedPath: async () => false,
      phase: 'red', caseIds: ['SEC-55'], commandId: 'foundation-release-ipc',
      runner: async () => ({ exitCode: 1 }),
    })).resolves.toMatchObject({ phase: 'red' });
  });

  it('rejects rehashed noncanonical UTC timestamps', async () => {
    const options = await evidenceOptions();
    await runObservedTddCommand({ ...options, phase: 'red', caseIds: ['SEC-55'], commandId: 'foundation-release-ipc', runner: async () => ({ exitCode: 1 }) });
    const history = JSON.parse(await fs.readFile(options.evidencePath, 'utf8'));
    history.entries[0].observedAtUtc = '2026-08-12T10:00:00+08:00';
    rehashHistory(history);
    await fs.writeFile(options.evidencePath, JSON.stringify(history));
    await expect(runObservedTddCommand({ ...options, phase: 'green', caseIds: ['SEC-55'], commandId: 'foundation-release-ipc', runner: async () => ({ exitCode: 0 }) })).rejects.toThrow('integrity');
  });

  it('rejects green evidence without its observed red command', async () => {
    await expect(runObservedTddCommand({
      ...(await evidenceOptions()),
      phase: 'green',
      caseIds: ['SEC-55'],
      commandId: 'foundation-release-ipc',
      runner: async () => ({ exitCode: 0 }),
    })).rejects.toThrow();
  });

  it('rejects a subset, reordered, duplicated, or phase-wrong focused test vector', () => {
    const exact = [
      'src/main/ipc/__tests__/release.test.ts',
      'src/preload/__tests__/index.test.ts',
      'src/preload/__tests__/transport-surface.test.ts',
    ];
    expect(() => assertTddTestReferences('foundation-release-ipc', 'red', exact.slice(0, 1))).toThrow('exact');
    expect(() => assertTddTestReferences('foundation-release-ipc', 'red', [...exact].reverse())).toThrow('exact');
    expect(() => assertTddTestReferences('foundation-release-ipc', 'red', [...exact, exact[0]])).toThrow('exact');
  });

  it('requires focused tests to exist for red and be tracked for green evidence', async () => {
    const options = await evidenceOptions();
    await fs.unlink(path.join(options.workspaceRoot, 'src/main/ipc/__tests__/release.test.ts'));
    await expect(runObservedTddCommand({
      ...options,
      phase: 'red',
      caseIds: ['SEC-55'],
      commandId: 'foundation-release-ipc',
      runner: async () => ({ exitCode: 1 }),
    })).rejects.toThrow('focused test');
    const untrackedOptions = await evidenceOptions();
    await runObservedTddCommand({
      ...untrackedOptions,
      phase: 'red', caseIds: ['SEC-55'], commandId: 'foundation-release-ipc',
      runner: async () => ({ exitCode: 1 }),
    });
    await expect(runObservedTddCommand({
      ...untrackedOptions,
      isTrackedPath: async () => false,
      phase: 'green',
      caseIds: ['SEC-55'],
      commandId: 'foundation-release-ipc',
      runner: async () => ({ exitCode: 0 }),
    })).rejects.toThrow('focused test');
  });

  it('allows a missing implementation source only for red and requires it for green', async () => {
    const options = await evidenceOptions();
    await fs.unlink(path.join(options.workspaceRoot, 'src/main/ipc/release.ts'));
    await expect(runObservedTddCommand({
      ...options,
      phase: 'red',
      caseIds: ['SEC-55'],
      commandId: 'foundation-release-ipc',
      runner: async () => ({ exitCode: 1 }),
    })).resolves.toMatchObject({ phase: 'red' });
    await expect(runObservedTddCommand({
      ...options,
      phase: 'green',
      caseIds: ['SEC-55'],
      commandId: 'foundation-release-ipc',
      runner: async () => ({ exitCode: 0 }),
    })).rejects.toThrow('implementation source');
  });

  it('rejects duplicate red, extra history root fields, and rehashed semantic tampering', async () => {
    const options = await evidenceOptions();
    await runObservedTddCommand({
      ...options,
      phase: 'red',
      caseIds: ['SEC-55'],
      commandId: 'foundation-release-ipc',
      runner: async () => ({ exitCode: 1 }),
    });
    await expect(runObservedTddCommand({
      ...options,
      phase: 'red',
      caseIds: ['SEC-55'],
      commandId: 'foundation-release-ipc',
      runner: async () => ({ exitCode: 1 }),
    })).rejects.toThrow('chronology');

    const history = JSON.parse(await fs.readFile(options.evidencePath, 'utf8'));
    history.extra = true;
    await fs.writeFile(options.evidencePath, `${JSON.stringify(history)}\n`, 'utf8');
    await expect(runObservedTddCommand({
      ...options,
      phase: 'green',
      caseIds: ['SEC-55'],
      commandId: 'foundation-release-ipc',
      runner: async () => ({ exitCode: 0 }),
    })).rejects.toThrow('integrity');

    delete history.extra;
    history.entries[0].plannedTestReferences = ['tests/release/unrelated.test.ts'];
    rehashHistory(history);
    await fs.writeFile(options.evidencePath, `${JSON.stringify(history)}\n`, 'utf8');
    await expect(runObservedTddCommand({
      ...options,
      phase: 'green',
      caseIds: ['SEC-55'],
      commandId: 'foundation-release-ipc',
      runner: async () => ({ exitCode: 0 }),
    })).rejects.toThrow('integrity');
  });

  it('rejects a clock rollback before writing the new record', async () => {
    const options = await evidenceOptions();
    await runObservedTddCommand({
      ...options,
      phase: 'red',
      caseIds: ['SEC-55'],
      commandId: 'foundation-release-ipc',
      runner: async () => ({ exitCode: 1 }),
    });
    await expect(runObservedTddCommand({
      ...options,
      phase: 'green',
      caseIds: ['SEC-55'],
      commandId: 'foundation-release-ipc',
      runner: async () => ({ exitCode: 0 }),
      now: () => new Date('2000-01-01T00:00:00.000Z'),
    })).rejects.toThrow('integrity');
  });

  it('executes the shipping CLI in an isolated real Git repository without touching this worktree ledger', async () => {
    const { root, greenPaths } = await createCliRepository();
    const exact = ['node', 'node_modules/vitest/vitest.mjs', 'run', ...IPC_TEST_REFERENCES];
    expect(() => assertTddChildArgv('foundation-release-ipc', 'red', exact)).not.toThrow();
    const ledger = path.join(workspace, 'release-validation', 'tdd', 'requirements-tdd-evidence.json');
    const before = await fs.stat(ledger).then(async (stat) => ({ mtimeMs: stat.mtimeMs, hash: createHash('sha256').update(await fs.readFile(ledger)).digest('hex') })).catch(() => null);
    const redResult = await runCli(root, 'red', exact);
    expect(redResult.code, redResult.stderr).toBe(0);
    expect(await fs.readFile(path.join(root, 'fixture-child-ran'), 'utf8')).toBe('clean\n');
    await makeCliSourcesGreen(root);
    const fixtureLedger = path.join(root, 'release-validation', 'tdd', 'requirements-tdd-evidence.json');
    const beforeRejectedGreen = await fs.readFile(fixtureLedger);
    expect((await runCli(root, 'green', exact)).code).toBe(1);
    expect(await fs.readFile(path.join(root, 'fixture-child-ran'), 'utf8')).toBe('clean\n');
    expect(await fs.readFile(fixtureLedger)).toEqual(beforeRejectedGreen);
    await execFile('git', ['add', '-N', '--', ...greenPaths], { cwd: root });
    expect((await runCli(root, 'green', exact)).code).toBe(0);
    expect(await fs.readFile(path.join(root, 'fixture-child-ran'), 'utf8')).toBe('clean\nclean\n');
    const evidence = JSON.parse(await fs.readFile(path.join(root, 'release-validation', 'tdd', 'requirements-tdd-evidence.json'), 'utf8'));
    expect(evidence.entries.map((entry: { plannedTestReferences: string[] }) => entry.plannedTestReferences)).toEqual([IPC_TEST_REFERENCES, IPC_TEST_REFERENCES]);
    expect(await fs.stat(path.join(root, 'outside', 'evidence.json')).then(() => true).catch(() => false)).toBe(false);
    const after = await fs.stat(ledger).then(async (stat) => ({ mtimeMs: stat.mtimeMs, hash: createHash('sha256').update(await fs.readFile(ledger)).digest('hex') })).catch(() => null);
    expect(after).toEqual(before);
    const cliSource = await fs.readFile(cliPath, 'utf8');
    expect(cliSource).not.toContain('WORKBENCH_TDD_EVIDENCE_ROOT');
    expect(cliSource).not.toContain('WORKBENCH_TDD_EVIDENCE_PATH');
    expect(cliSource).toContain("'release-validation', 'tdd', 'requirements-tdd-evidence.json'");
  }, 30_000);

  it.each(INVALID_IPC_CHILD_ARGV)('rejects the %s shipping CLI argv without child or ledger activity', async (_label, childArgv) => {
    const { root } = await createCliRepository();
    const ledger = path.join(root, 'release-validation', 'tdd', 'requirements-tdd-evidence.json');
    const before = await fs.readFile(ledger).catch(() => null);
    expect((await runCli(root, 'red', [...childArgv])).code).toBe(1);
    expect(await fs.readFile(path.join(root, 'fixture-child-ran')).catch(() => null)).toBeNull();
    expect(await fs.readFile(ledger).catch(() => null)).toEqual(before);
  }, 30_000);

  it.runIf(process.platform === 'win32')('uses the official plan launcher before JavaScript and never executes caller Node preloads', async () => {
    for (const mode of ['require', 'import'] as const) {
      const { root } = await createCliRepository();
      const sentinel = path.join(root, `preload-${mode}-sentinel`);
      const preloadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cwpreload-'));
      temporaryRoots.push(preloadRoot);
      const preload = path.join(preloadRoot, mode === 'require' ? 'preload.cjs' : 'preload.mjs');
      await fs.writeFile(preload, mode === 'require'
        ? `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');\n`
        : `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(sentinel)}, 'executed');\n`, 'utf8');
      const option = mode === 'require'
        ? `--require=${preload}`
        : `--import=${pathToFileURL(preload).href}`;
      const result = await runOfficialPlanCli(root, {
        NODE_OPTIONS: option,
        NODE_PATH: path.join(root, 'attacker-node-path'),
        NODE_REPL_EXTERNAL_MODULE: preload,
      });
      expect(await fs.readFile(sentinel).catch(() => null)).toBeNull();
      expect(result.code, result.stderr).toBe(0);
      expect(await fs.readFile(path.join(root, 'fixture-child-ran'), 'utf8').catch(() => null), `${result.stdout}\n${result.stderr}`).toBe('clean\n');
    }
  }, 30_000);

  it.runIf(process.platform === 'win32')('runs the official route from a real Unicode and spaces linked worktree', async () => {
    const { root } = await createLinkedWorktreeCliRepository();
    const gitFile = await fs.readFile(path.join(root, '.git'), 'utf8');
    expect(gitFile).toMatch(/^gitdir: /u);
    const result = await runOfficialPlanCli(root);
    expect(result.code, result.stderr).toBe(0);
    expect(await fs.readFile(path.join(root, 'fixture-child-ran'), 'utf8')).toBe('clean\n');
  }, 30_000);

  it.runIf(process.platform === 'win32')('keeps the npm compatibility alias fail closed without starting Node evidence', async () => {
    const { root } = await createCliRepository();
    const npm = path.join(path.dirname(process.execPath), 'npm.cmd');
    let exitCode = 0;
    try {
      await execFile('cmd.exe', ['/d', '/s', '/c', `"${npm}" run release:tdd-evidence`], { cwd: root, windowsHide: true });
    } catch (error) {
      const code = (error as { code?: number | string }).code;
      exitCode = typeof code === 'number' ? code : 1;
    }
    expect(exitCode).toBe(1);
    expect(await fs.readFile(path.join(root, 'fixture-child-ran')).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(root, 'release-validation', 'tdd', 'requirements-tdd-evidence.json')).catch(() => null)).toBeNull();
  }, 30_000);

  it('contains exactly the four reviewed literal project-input anchors', async () => {
    const source = await fs.readFile(launcherPath, 'utf8');
    const table = source.match(/\$protectedInputHashes = \[ordered\]@\{\r?\n(?<body>[\s\S]*?)\r?\n  \}/u);
    expect(table?.groups?.body).toBeDefined();
    const lines = table!.groups!.body.split(/\r?\n/u);
    const entries = lines.map((line) => {
      const entry = line.match(/^    '([^']+)' = '([a-f0-9]{64})'$/u);
      expect(entry, line).not.toBeNull();
      return [entry![1], entry![2]];
    });
    expect(entries).toEqual(PROTECTED_INPUTS.map(([, relativePath, hash]) => [relativePath, hash]));
  });

  it.runIf(process.platform === 'win32')('opens and identity-binds all four project inputs before the first project content read', async () => {
    const { root } = await createCliRepository();
    await instrumentAllInputsOpenBarrier(root);
    const exact = ['node', 'node_modules/vitest/vitest.mjs', 'run', ...IPC_TEST_REFERENCES];
    const started = startCli(root, 'red', exact);
    const ready = path.join(root, 'project-content-read-ready');
    const release = path.join(root, 'project-content-read-release');
    const target = path.join(root, PROTECTED_INPUTS.at(-1)![1]);
    const renamed = `${target}.open-order-probe`;
    let renamedEarly = false;
    let lockError: NodeJS.ErrnoException | undefined;
    try {
      await Promise.race([
        waitForFile(ready),
        started.result.then(({ code, stderr }) => { throw new Error(`launcher exited before content-read barrier (${code}): ${stderr}`); }),
      ]);
      try {
        await fs.rename(target, renamed);
        renamedEarly = true;
      } catch (error) {
        lockError = error as NodeJS.ErrnoException;
      }
      if (renamedEarly) {
        await fs.rename(renamed, target);
        renamedEarly = false;
      }
      await fs.writeFile(release, 'release', 'utf8');
    } finally {
      if (renamedEarly) await fs.rename(renamed, target);
      await fs.writeFile(release, 'release', 'utf8').catch(() => undefined);
    }
    const result = await started.result;
    expect(lockError?.code).toMatch(/^(?:EACCES|EBUSY|EPERM)$/u);
    expect(result.code).toBe(0);
  }, 30_000);

  it.runIf(process.platform === 'win32')('revalidates exactly the four held project identities immediately before Node starts', async () => {
    const { root } = await createCliRepository();
    await instrumentFinalIdentityAudit(root);
    const exact = ['node', 'node_modules/vitest/vitest.mjs', 'run', ...IPC_TEST_REFERENCES];
    const result = await runCli(root, 'red', exact);
    expect(result.code, result.stderr).toBe(0);
    const audit = await fs.readFile(path.join(root, 'final-identity-audit.log'), 'utf8').catch(() => '');
    const auditedPaths = audit.trim().split(/\r?\n/u).filter(Boolean)
      .map((absolutePath) => path.relative(root, absolutePath).replaceAll('\\', '/'));
    expect(auditedPaths).toEqual(PROTECTED_INPUTS.map(([, relativePath]) => relativePath));
  }, 30_000);

  it.runIf(process.platform === 'win32').each(PROTECTED_INPUTS)('keeps $0 hash parity and rejects its tampered bytes before Node starts', async (_label, relativePath, expectedHash) => {
    const exactBytes = await fs.readFile(path.join(workspace, relativePath));
    expect(createHash('sha256').update(exactBytes).digest('hex')).toBe(expectedHash);

    const { root } = await createCliRepository();
    const target = path.join(root, relativePath);
    if (relativePath === 'scripts/release/tdd-evidence-toolchain.json') {
      const contract = await fs.readFile(target, 'utf8');
      await fs.writeFile(target, contract.includes('\r\n') ? contract.replaceAll('\r\n', '\n') : contract.replaceAll('\n', '\r\n'), 'utf8');
    } else {
      await fs.appendFile(target, '\n', 'utf8');
    }
    const exact = ['node', 'node_modules/vitest/vitest.mjs', 'run', ...IPC_TEST_REFERENCES];
    const result = await runCli(root, 'red', exact);
    expect(result.code).toBe(1);
    expect(await fs.readFile(path.join(root, 'fixture-child-ran')).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(root, 'release-validation', 'tdd', 'requirements-tdd-evidence.json')).catch(() => null)).toBeNull();
  }, 30_000);

  it.runIf(process.platform === 'win32').each([
    {
      label: 'recorder CLI',
      relativePath: 'scripts/release/tdd-evidence.mjs',
      attackerSentinel: 'attacker-cli-ran',
      maliciousSource: "import fs from 'node:fs'; fs.writeFileSync('attacker-cli-ran', 'ran');\n",
    },
    {
      label: 'requirements contract',
      relativePath: 'scripts/release/requirements-contract.mjs',
      attackerSentinel: 'attacker-requirements-contract-ran',
      maliciousSource: [
        "import fs from 'node:fs'; fs.writeFileSync('attacker-requirements-contract-ran', 'ran');",
        'export const TDD_REQUIREMENT_CASES = [];',
        "export function assertTddChildArgv() { throw new Error('attacker contract'); }",
        "export function assertTddCommandAssignment() { throw new Error('attacker contract'); }",
        "export function assertTddTestReferences() { throw new Error('attacker contract'); }",
        "export function getTddPhase() { throw new Error('attacker contract'); }",
        '',
      ].join('\n'),
    },
  ])('rejects a transient $label replacement after launcher inspection and before its first protected-input open', async ({ relativePath, attackerSentinel, maliciousSource }) => {
    const { root } = await createCliRepository();
    await instrumentFixtureLauncher(root);
    const exact = ['node', 'node_modules/vitest/vitest.mjs', 'run', ...IPC_TEST_REFERENCES];
    const target = path.join(root, relativePath);
    const backup = `${target}.trusted-backup`;
    const replacement = `${target}.attacker-ready`;
    const trustedBytes = await fs.readFile(target);
    const trustedHash = createHash('sha256').update(trustedBytes).digest('hex');
    await fs.writeFile(replacement, maliciousSource, 'utf8');
    const preloadSentinel = path.join(root, 'preload-sentinel');
    const preload = path.join(root, 'caller-preload.cjs');
    await fs.writeFile(preload, `require('node:fs').writeFileSync(${JSON.stringify(preloadSentinel)}, 'ran');\n`, 'utf8');
    const inspectionReady = path.join(root, 'launcher-inspection-ready');
    const inspectionRelease = path.join(root, 'launcher-inspection-release');
    const started = startCli(root, 'red', exact, { NODE_OPTIONS: `--require=${preload}` });
    let swapped = false;
    let result: { code: number; stderr: string };
    try {
      await Promise.race([
        waitForFile(inspectionReady),
        started.result.then(({ code, stderr }) => { throw new Error(`launcher exited before inspection barrier (${code}): ${stderr}`); }),
      ]);
      await fs.rename(target, backup);
      await fs.rename(replacement, target);
      swapped = true;
      await fs.writeFile(inspectionRelease, 'release', 'utf8');
      result = await started.result;
    } finally {
      await fs.writeFile(inspectionRelease, 'release', 'utf8').catch(() => undefined);
      await started.result;
      if (swapped) {
        await fs.unlink(target).catch(() => undefined);
        await fs.rename(backup, target);
      }
    }
    const evidenceDirectory = path.join(root, 'release-validation', 'tdd');
    const evidenceArtifacts = await fs.readdir(evidenceDirectory).catch(() => []);
    const restoredBytes = await fs.readFile(target);
    expect({
      exitCode: result!.code,
      inspectionReached: await fs.stat(inspectionReady).then(() => true).catch(() => false),
      nodeStarted: await fs.stat(path.join(root, 'node-process-started')).then(() => true).catch(() => false),
      attackerRan: await fs.stat(path.join(root, attackerSentinel)).then(() => true).catch(() => false),
      childRan: await fs.stat(path.join(root, 'fixture-child-ran')).then(() => true).catch(() => false),
      preloadRan: await fs.stat(preloadSentinel).then(() => true).catch(() => false),
      evidenceArtifacts: evidenceArtifacts.filter((name) => name.startsWith('requirements-tdd-evidence.json')),
      restoredBytesEqual: restoredBytes.equals(trustedBytes),
      restoredHash: createHash('sha256').update(restoredBytes).digest('hex'),
    }).toEqual({
      exitCode: 1,
      inspectionReached: true,
      nodeStarted: false,
      attackerRan: false,
      childRan: false,
      preloadRan: false,
      evidenceArtifacts: [],
      restoredBytesEqual: true,
      restoredHash: trustedHash,
    });
  }, 30_000);

  it.runIf(process.platform === 'win32')('holds every project input and the copied launcher against write, delete, rename, and parent rename until child exit', async () => {
    const { root } = await createCliRepository();
    await instrumentFixtureLauncher(root);
    await instrumentOsHandleAudit(root);
    await fs.writeFile(path.join(root, 'launcher-inspection-release'), 'release', 'utf8');
    const childStarted = path.join(root, 'fixture-child-started');
    const childRelease = path.join(root, 'fixture-child-release');
    const vitestStub = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
    await fs.writeFile(vitestStub, [
      "import fs from 'node:fs';",
      "fs.writeFileSync('fixture-child-started', String(process.pid));",
      "const wait = new Int32Array(new SharedArrayBuffer(4));",
      "while (!fs.existsSync('fixture-child-release')) Atomics.wait(wait, 0, 0, 10);",
      "fs.writeFileSync('fixture-child-ran', 'clean\\n');",
      'process.exit(1);',
      '',
    ].join('\n'), 'utf8');
    const exact = ['node', 'node_modules/vitest/vitest.mjs', 'run', ...IPC_TEST_REFERENCES];
    const started = startCli(root, 'red', exact);
    const protectedPaths = [
      ...PROTECTED_INPUTS.map(([, relativePath]) => relativePath),
      'scripts/release/tdd-evidence-launcher.ps1',
    ];
    const originalBytes = new Map(await Promise.all(protectedPaths.map(async (relativePath) => [relativePath, await fs.readFile(path.join(root, relativePath))] as const)));
    const conflictResults: Array<[string, string, string]> = [];
    const parentPaths = ['scripts/release/lib', 'scripts/release'];
    const probeConflict = async (relativePath: string, operation: string, action: () => Promise<void>, restore: () => Promise<void>) => {
      try {
        await action();
        await restore();
        conflictResults.push([relativePath, operation, 'succeeded']);
      } catch (error) {
        conflictResults.push([relativePath, operation, String((error as NodeJS.ErrnoException).code ?? 'UNKNOWN')]);
      }
    };
    try {
      await Promise.race([
        waitForFile(childStarted),
        started.result.then(({ code, stderr }) => { throw new Error(`launcher exited before child barrier (${code}): ${stderr}`); }),
      ]);
      await waitForFile(path.join(root, 'os-handle-audit.log'));
      for (const relativePath of protectedPaths) {
        const target = path.join(root, relativePath);
        const renamed = `${target}.rename-probe`;
        const bytes = originalBytes.get(relativePath)!;
        await probeConflict(relativePath, 'write', async () => {
          const handle = await fs.open(target, 'r+');
          await handle.close();
        }, async () => undefined);
        await probeConflict(relativePath, 'delete', () => fs.unlink(target), () => fs.writeFile(target, bytes));
        await probeConflict(relativePath, 'rename', () => fs.rename(target, renamed), () => fs.rename(renamed, target));
      }
      for (const relativePath of parentPaths) {
        const target = path.join(root, relativePath);
        const renamed = `${target}.rename-probe`;
        await probeConflict(relativePath, 'parent rename', () => fs.rename(target, renamed), () => fs.rename(renamed, target));
      }
    } finally {
      await fs.writeFile(childRelease, 'release', 'utf8');
      await started.result;
    }
    expect(conflictResults).toHaveLength((protectedPaths.length * 3) + parentPaths.length);
    expect(conflictResults.every(([, , code]) => /^(?:EACCES|EBUSY|EPERM)$/u.test(code)), JSON.stringify(conflictResults)).toBe(true);
    expect((await started.result).code).toBe(0);

    const systemDirectory = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    const osAudit = (await fs.readFile(path.join(root, 'os-handle-audit.log'), 'utf8')).trim().split(/\r?\n/u)
      .map((line) => line.split('|'));
    expect(osAudit.map(([label, expectedPath, identity, finalPath, canRead]) => ({
      label,
      expectedPath: path.normalize(expectedPath).toLowerCase(),
      identity,
      finalPath: path.normalize(finalPath).toLowerCase(),
      canRead,
    }))).toEqual([
      { label: 'node', expectedPath: path.normalize(process.execPath).toLowerCase(), identity: expect.stringMatching(/^[a-f0-9]{48}$/u), finalPath: path.normalize(process.execPath).toLowerCase(), canRead: 'True' },
      { label: 'powershell', expectedPath: path.join(systemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe').toLowerCase(), identity: expect.stringMatching(/^[a-f0-9]{48}$/u), finalPath: path.join(systemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe').toLowerCase(), canRead: 'True' },
      { label: 'cmd', expectedPath: path.join(systemDirectory, 'cmd.exe').toLowerCase(), identity: expect.stringMatching(/^[a-f0-9]{48}$/u), finalPath: path.join(systemDirectory, 'cmd.exe').toLowerCase(), canRead: 'True' },
    ]);

    for (const relativePath of protectedPaths) {
      const target = path.join(root, relativePath);
      const renamed = `${target}.post-exit-probe`;
      const handle = await fs.open(target, 'r+');
      await handle.close();
      await renameAfterReleased(target, renamed);
      await renameAfterReleased(renamed, target);
      await fs.unlink(target);
      await fs.writeFile(target, originalBytes.get(relativePath)!);
    }
    for (const relativePath of parentPaths) {
      const target = path.join(root, relativePath);
      const renamed = `${target}.post-exit-probe`;
      await renameAfterReleased(target, renamed);
      await renameAfterReleased(renamed, target);
    }
  }, 30_000);

  it.runIf(process.platform === 'win32')('kills and waits for Node when job assignment fails before releasing held paths', async () => {
    const { root } = await createCliRepository();
    await instrumentAssignFailure(root);
    const exact = ['node', 'node_modules/vitest/vitest.mjs', 'run', ...IPC_TEST_REFERENCES];
    const started = startCli(root, 'red', exact);
    const cleanupReady = path.join(root, 'assign-failure-cleanup-ready');
    const cleanupRelease = path.join(root, 'assign-failure-cleanup-release');
    const target = path.join(root, 'scripts', 'release', 'tdd-evidence.mjs');
    const renamed = `${target}.assign-failure-probe`;
    let nodePid: number | undefined;
    let observation: { nodeAlive: boolean; lockCode: string | undefined } | undefined;
    try {
      await Promise.race([
        waitForFile(cleanupReady),
        started.result.then(({ code, stderr }) => { throw new Error(`launcher exited before assignment-failure cleanup barrier (${code}): ${stderr}`); }),
      ]);
      nodePid = Number(await fs.readFile(path.join(root, 'forced-node-pid'), 'utf8'));
      let lockCode: string | undefined;
      try {
        await fs.rename(target, renamed);
        await fs.rename(renamed, target);
      } catch (error) {
        lockCode = (error as NodeJS.ErrnoException).code;
      }
      observation = { nodeAlive: await processIsAlive(nodePid), lockCode };
    } finally {
      await fs.writeFile(cleanupRelease, 'release', 'utf8').catch(() => undefined);
      await stopProcessIfAlive(nodePid);
      await waitForProcessExit(nodePid);
      await started.result;
    }
    expect(observation).toEqual({
      nodeAlive: false,
      lockCode: expect.stringMatching(/^(?:EACCES|EBUSY|EPERM)$/u),
    });
    expect((await started.result).code).toBe(1);
    expect(await fs.readFile(path.join(root, 'assign-failure-node-ran'), 'utf8')).toBe(String(nodePid));
    await renameAfterReleased(target, renamed);
    await renameAfterReleased(renamed, target);
  }, 30_000);

  it.runIf(process.platform === 'win32')('kills the recorder before releasing held paths when failure occurs before the synchronous challenge can create a child', async () => {
    const { root } = await createCliRepository();
    await instrumentPostStartFailure(root);
    const exact = ['node', 'node_modules/vitest/vitest.mjs', 'run', ...IPC_TEST_REFERENCES];
    const started = startCli(root, 'red', exact);
    const cleanupReady = path.join(root, 'post-start-cleanup-ready');
    const cleanupRelease = path.join(root, 'post-start-cleanup-release');
    const target = path.join(root, 'scripts', 'release', 'tdd-evidence.mjs');
    const renamed = `${target}.exception-probe`;
    let nodePid: number | undefined;
    let observation: { nodeAlive: boolean; childStarted: boolean; lockCode: string | undefined } | undefined;
    try {
      await Promise.race([
        waitForFile(cleanupReady),
        started.result.then(({ code, stderr }) => { throw new Error(`launcher exited before cleanup barrier (${code}): ${stderr}`); }),
      ]);
      nodePid = Number(await fs.readFile(path.join(root, 'forced-node-pid'), 'utf8'));
      let lockCode: string | undefined;
      try {
        await fs.rename(target, renamed);
        await fs.rename(renamed, target);
      } catch (error) {
        lockCode = (error as NodeJS.ErrnoException).code;
      }
      observation = {
        nodeAlive: await processIsAlive(nodePid),
        childStarted: await fs.stat(path.join(root, 'fixture-child-ran')).then(() => true).catch(() => false),
        lockCode,
      };
    } finally {
      await fs.writeFile(cleanupRelease, 'release', 'utf8').catch(() => undefined);
      await started.result;
      await stopProcessIfAlive(nodePid);
    }
    expect(observation).toEqual({
      nodeAlive: false,
      childStarted: false,
      lockCode: expect.stringMatching(/^(?:EACCES|EBUSY|EPERM)$/u),
    });
    expect((await started.result).code).toBe(1);
    expect(await fs.readFile(path.join(root, 'fixture-child-ran')).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(root, 'release-validation', 'tdd', 'requirements-tdd-evidence.json')).catch(() => null)).toBeNull();
    await fs.rename(target, renamed);
    await fs.rename(renamed, target);
  }, 30_000);

  it.runIf(process.platform === 'win32')('kills the recorder and its owned child before releasing held paths after a forced post-start exception', async () => {
    const { root } = await createCliRepository();
    await instrumentPostChildStartFailure(root);
    const vitestStub = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
    await fs.writeFile(vitestStub, [
      "import fs from 'node:fs';",
      "fs.writeFileSync('fixture-child-started', String(process.pid));",
      'const wait = new Int32Array(new SharedArrayBuffer(4));',
      'while (true) Atomics.wait(wait, 0, 0, 1000);',
      '',
    ].join('\n'), 'utf8');
    const exact = ['node', 'node_modules/vitest/vitest.mjs', 'run', ...IPC_TEST_REFERENCES];
    const started = startCli(root, 'red', exact);
    const cleanupReady = path.join(root, 'post-child-cleanup-ready');
    const cleanupRelease = path.join(root, 'post-child-cleanup-release');
    const target = path.join(root, 'scripts', 'release', 'requirements-contract.mjs');
    const renamed = `${target}.exception-child-probe`;
    let nodePid: number | undefined;
    let childPid: number | undefined;
    let observation: { nodeAlive: boolean; childAlive: boolean; lockCode: string | undefined } | undefined;
    try {
      await Promise.race([
        waitForFile(cleanupReady),
        started.result.then(({ code, stderr }) => { throw new Error(`launcher exited before child cleanup barrier (${code}): ${stderr}`); }),
      ]);
      nodePid = Number(await fs.readFile(path.join(root, 'forced-node-pid'), 'utf8'));
      childPid = Number(await fs.readFile(path.join(root, 'fixture-child-started'), 'utf8'));
      let lockCode: string | undefined;
      try {
        await fs.rename(target, renamed);
        await fs.rename(renamed, target);
      } catch (error) {
        lockCode = (error as NodeJS.ErrnoException).code;
      }
      observation = {
        nodeAlive: await processIsAlive(nodePid),
        childAlive: await processIsAlive(childPid),
        lockCode,
      };
    } finally {
      await fs.writeFile(cleanupRelease, 'release', 'utf8').catch(() => undefined);
      await started.result;
      await stopProcessIfAlive(childPid);
      await stopProcessIfAlive(nodePid);
    }
    expect(observation).toEqual({
      nodeAlive: false,
      childAlive: false,
      lockCode: expect.stringMatching(/^(?:EACCES|EBUSY|EPERM)$/u),
    });
    expect((await started.result).code).toBe(1);
    expect(await fs.readFile(path.join(root, 'fixture-child-ran')).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(root, 'release-validation', 'tdd', 'requirements-tdd-evidence.json')).catch(() => null)).toBeNull();
    await fs.rename(target, renamed);
    await fs.rename(renamed, target);
  }, 30_000);

  it('refuses the direct Node entry even when the caller supplies launcher-looking environment', async () => {
    const { root } = await createCliRepository();
    const exact = ['node', 'node_modules/vitest/vitest.mjs', 'run', ...IPC_TEST_REFERENCES];
    const result = await runDirectCli(root, 'red', exact, {
      WORKBENCH_TDD_LAUNCH_TOKEN: 'a'.repeat(64),
      WORKBENCH_TDD_LAUNCHER: launcherPath,
    });
    expect(result.code).toBe(1);
    expect(await fs.readFile(path.join(root, 'fixture-child-ran')).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(root, 'release-validation', 'tdd', 'requirements-tdd-evidence.json')).catch(() => null)).toBeNull();
  });

  it('rejects a same-size and same-mtime final-file swap restored immediately after open', async () => {
    const options = await evidenceOptions();
    const relativePath = IPC_TEST_REFERENCES[0];
    const target = path.join(options.workspaceRoot, relativePath);
    const backup = `${target}.trusted-backup`;
    const trustedBytes = await fs.readFile(target);
    const trustedStat = await fs.stat(target);
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-tdd-file-'));
    temporaryRoots.push(outsideRoot);
    const outside = path.join(outsideRoot, 'outside.test.ts');
    const outsideBytes = Buffer.alloc(trustedBytes.length, 0x58);
    await fs.writeFile(outside, outsideBytes);
    await fs.utimes(outside, trustedStat.atime, trustedStat.mtime);
    let swapped = false;
    const restore = async () => {
      if (!swapped) return;
      await fs.unlink(target).catch(() => undefined);
      await fs.rename(backup, target);
      swapped = false;
    };
    try {
      await expect(runObservedTddCommand({
        ...options,
        phase: 'red', caseIds: ['SEC-55'], commandId: 'foundation-release-ipc',
        runner: async () => ({ exitCode: 1 }),
        fileReadHooks: {
          beforeOpen: async (candidate: { relativePath: string }) => {
            if (candidate.relativePath !== relativePath) return;
            await fs.rename(target, backup);
            await fs.link(outside, target);
            await fs.utimes(target, trustedStat.atime, trustedStat.mtime);
            swapped = true;
          },
          afterOpen: async (candidate: { relativePath: string }) => {
            if (candidate.relativePath === relativePath) await restore();
          },
        },
      })).rejects.toThrow(/changed|identity|unsafe/i);
    } finally {
      await restore();
    }
    expect(await fs.readFile(target)).toEqual(trustedBytes);
    expect(await fs.readFile(options.evidencePath).catch(() => null)).toBeNull();
  });

  it.runIf(process.platform === 'win32')('rejects an intermediate junction swapped around open and restored before validation', async () => {
    const options = await evidenceOptions();
    const relativePath = IPC_TEST_REFERENCES[0];
    const directory = path.join(options.workspaceRoot, 'src', 'main', 'ipc');
    const backup = `${directory}.trusted-backup`;
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-tdd-junction-'));
    temporaryRoots.push(outsideRoot);
    await fs.mkdir(path.join(outsideRoot, '__tests__'));
    await fs.writeFile(path.join(outsideRoot, '__tests__', 'release.test.ts'), 'outside junction bytes\n', 'utf8');
    let swapped = false;
    const restore = async () => {
      if (!swapped) return;
      await fs.rm(directory, { recursive: true, force: true });
      await fs.rename(backup, directory);
      swapped = false;
    };
    try {
      await expect(runObservedTddCommand({
        ...options,
        phase: 'red', caseIds: ['SEC-55'], commandId: 'foundation-release-ipc',
        runner: async () => ({ exitCode: 1 }),
        fileReadHooks: {
          beforeOpen: async (candidate: { relativePath: string }) => {
            if (candidate.relativePath !== relativePath) return;
            await fs.rename(directory, backup);
            await execFile('cmd.exe', ['/d', '/c', 'mklink', '/J', directory, outsideRoot]);
            swapped = true;
          },
          afterOpen: async (candidate: { relativePath: string }) => {
            if (candidate.relativePath === relativePath) await restore();
          },
        },
      })).rejects.toThrow(/changed|identity|unsafe|reparse/i);
    } finally {
      await restore();
    }
    expect(await fs.readFile(path.join(directory, '__tests__', 'release.test.ts'), 'utf8')).toContain('release = true');
    expect(await fs.readFile(options.evidencePath).catch(() => null)).toBeNull();
  }, 30_000);

  it('scrubs alternate Git state, fake PATH tools, Git config injection, and caller Node options', async () => {
    const { root } = await createCliRepository();
    const exact = ['node', 'node_modules/vitest/vitest.mjs', 'run', ...IPC_TEST_REFERENCES];
    const fakeBin = path.join(root, 'fake-bin');
    await fs.mkdir(fakeBin);
    await fs.writeFile(path.join(fakeBin, 'git.cmd'), '@echo off\r\nexit /b 0\r\n', 'utf8');
    await fs.writeFile(path.join(fakeBin, 'node.cmd'), '@echo off\r\necho fake>fake-node-ran\r\nexit /b 99\r\n', 'utf8');
    const alternate = path.join(root, 'alternate');
    await fs.mkdir(alternate);
    await execFile('git', ['init', '--quiet'], { cwd: alternate });
    const result = await runCli(root, 'red', exact, {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
      GIT_DIR: path.join(alternate, '.git'),
      GIT_WORK_TREE: alternate,
      GIT_INDEX_FILE: path.join(alternate, '.git', 'index'),
      GIT_COMMON_DIR: path.join(alternate, '.git'),
      GIT_OBJECT_DIRECTORY: path.join(alternate, '.git', 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(alternate, '.git', 'objects'),
      GIT_NAMESPACE: 'attacker',
      GIT_CEILING_DIRECTORIES: root,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: '*',
      GIT_CONFIG_KEY_1: 'alias.ls-files',
      GIT_CONFIG_VALUE_1: '!exit 0',
    });
    expect(result.code).toBe(0);
    expect(await fs.readFile(path.join(root, 'fixture-child-ran'), 'utf8')).toBe('clean\n');
    expect(await fs.readFile(path.join(root, 'fake-node-ran')).catch(() => null)).toBeNull();

    const injected = await createCliRepository();
    expect((await runCli(injected.root, 'red', exact, {
      NODE_OPTIONS: '--no-warnings',
      NODE_PATH: path.join(injected.root, 'attacker-node-path'),
      NODE_REPL_EXTERNAL_MODULE: path.join(injected.root, 'attacker-repl.mjs'),
    })).code).toBe(0);
    expect(await fs.readFile(path.join(injected.root, 'fixture-child-ran'), 'utf8')).toBe('clean\n');
    expect(await fs.readFile(path.join(injected.root, 'release-validation', 'tdd', 'requirements-tdd-evidence.json')).catch(() => null)).not.toBeNull();

    const tamperedToolchain = await createCliRepository();
    const toolchainPath = path.join(tamperedToolchain.root, 'scripts', 'release', 'tdd-evidence-toolchain.json');
    const toolchain = JSON.parse(await fs.readFile(toolchainPath, 'utf8'));
    toolchain.nodeSha256 = '0'.repeat(64);
    await fs.writeFile(toolchainPath, `${JSON.stringify(toolchain)}\n`, 'utf8');
    expect((await runOfficialPlanCli(tamperedToolchain.root)).code).toBe(1);
    expect(await fs.readFile(path.join(tamperedToolchain.root, 'fixture-child-ran')).catch(() => null)).toBeNull();
  }, 30_000);

  it.runIf(process.platform === 'win32')('rejects an intermediate junction and a redirected evidence directory', async () => {
    const options = await evidenceOptions();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-tdd-'));
    temporaryRoots.push(outside);
    await fs.rm(path.join(options.workspaceRoot, 'src', 'main', 'ipc'), { recursive: true, force: true });
    await execFile('cmd.exe', ['/d', '/c', 'mklink', '/J', path.join(options.workspaceRoot, 'src', 'main', 'ipc'), outside]);
    await fs.writeFile(path.join(outside, 'release.ts'), 'outside\n', 'utf8');
    await fs.mkdir(path.join(outside, '__tests__'));
    await fs.writeFile(path.join(outside, '__tests__', 'release.test.ts'), 'outside\n', 'utf8');
    await expect(runObservedTddCommand({
      ...options, phase: 'red', caseIds: ['SEC-55'], commandId: 'foundation-release-ipc', runner: async () => ({ exitCode: 1 }),
    })).rejects.toThrow(/reparse|workspace|regular/i);

    const second = await evidenceOptions();
    const redirected = path.join(second.workspaceRoot, 'release-validation');
    await execFile('cmd.exe', ['/d', '/c', 'mklink', '/J', redirected, outside]);
    await expect(runObservedTddCommand({
      ...second, phase: 'red', caseIds: ['SEC-55'], commandId: 'foundation-release-ipc', runner: async () => ({ exitCode: 1 }),
    })).rejects.toThrow(/reparse|workspace|evidence/i);
    expect(await fs.readFile(path.join(outside, 'tdd', 'requirements-tdd-evidence.json')).catch(() => null)).toBeNull();
  }, 30_000);

  it('rejects a modified history instead of overwriting it', async () => {
    const options = await evidenceOptions();
    await runObservedTddCommand({
      ...options,
      phase: 'red',
      caseIds: ['SEC-55'],
      commandId: 'foundation-release-ipc',
      runner: async () => ({ exitCode: 1 }),
    });
    const history = JSON.parse(await fs.readFile(options.evidencePath, 'utf8'));
    history.entries[0].phase = 'green';
    await fs.writeFile(options.evidencePath, `${JSON.stringify(history)}\n`, 'utf8');

    await expect(runObservedTddCommand({
      ...options,
      phase: 'red',
      caseIds: ['SEC-55'],
      commandId: 'foundation-release-ipc',
      runner: async () => ({ exitCode: 1 }),
    })).rejects.toThrow('integrity');
  });

  it('records only a safe red-to-green summary with hashes and no raw runner data', async () => {
    const options = await evidenceOptions();
    const hostileResult = {
      exitCode: 1,
      stdout: 'super-secret-token',
      stderr: 'C:\\Users\\person\\private-source',
      argv: ['node', 'private-command'],
      cwd: 'C:\\Users\\person',
      env: { API_KEY: 'super-secret-token' },
      error: new Error('super-secret-token'),
    };
    await runObservedTddCommand({
      ...options,
      phase: 'red',
      caseIds: ['SEC-55'],
      commandId: 'foundation-release-ipc',
      runner: async () => hostileResult,
    });
    await runObservedTddCommand({
      ...options,
      phase: 'green',
      caseIds: ['SEC-55'],
      commandId: 'foundation-release-ipc',
      runner: async () => ({ ...hostileResult, exitCode: 0 }),
    });

    const serialized = await fs.readFile(options.evidencePath, 'utf8');
    const evidence = JSON.parse(serialized);
    expect(evidence.entries).toHaveLength(2);
    expect(evidence.entries.map((entry: { phase: string }) => entry.phase)).toEqual(['red', 'green']);
    expect(evidence.entries.map((entry: { exitCategory: string }) => entry.exitCategory)).toEqual(['nonzero', 'zero']);
    expect(evidence.entries[1].trackedFileHashes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/main/ipc/release.ts', sha256: expect.any(String) }),
    ]));
    expect(serialized).not.toMatch(/super-secret-token|C:\\Users|private-command|API_KEY|argv|stdout|stderr|cwd|env|error/i);
  });

  it('rejects chronology mismatches and invalid red or green exit categories', async () => {
    const options = await evidenceOptions();
    await expect(runObservedTddCommand({
      ...options,
      phase: 'red',
      caseIds: ['SEC-55'],
      commandId: 'foundation-release-ipc',
      runner: async () => ({ exitCode: 0 }),
    })).rejects.toThrow('nonzero');

    await runObservedTddCommand({
      ...options,
      phase: 'red',
      caseIds: ['SEC-55'],
      commandId: 'foundation-release-ipc',
      runner: async () => ({ exitCode: 1 }),
    });
    await expect(runObservedTddCommand({
      ...options,
      phase: 'green',
      caseIds: ['SEC-55'],
      commandId: 'foundation-release-ipc',
      runner: async () => ({ exitCode: 1 }),
    })).rejects.toThrow('zero');
    await runObservedTddCommand({
      ...options,
      phase: 'green',
      caseIds: ['SEC-55'],
      commandId: 'foundation-release-ipc',
      runner: async () => ({ exitCode: 0 }),
    });
    await expect(runObservedTddCommand({
      ...options,
      phase: 'green',
      caseIds: ['SEC-55'],
      commandId: 'foundation-release-ipc',
      runner: async () => ({ exitCode: 0 }),
    })).rejects.toThrow();
  });

  it('allowlists the focused test references for each requirement slice', () => {
    expect(() => assertTddTestReferences('foundation-release-ipc', 'red', [
      'src/main/ipc/__tests__/release.test.ts',
    ])).toThrow('exact');
    expect(() => assertTddTestReferences('foundation-release-ipc', 'red', [
      'tests/release/release-tdd-evidence.test.ts',
    ])).toThrow('exact');
  });
});
