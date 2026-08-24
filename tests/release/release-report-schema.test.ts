import { describe, expect, it } from 'vitest';
import {
  BuildInventorySchema,
  BuildReportSchema,
  EvidenceReferenceSchema,
  FINAL_REPORT_ITEM_IDS,
  FINAL_REPORT_STATUSES,
  FinalGateSchema,
  FinalReportItemSchema,
  NativeAbiProbeResultSchema,
  PreflightReportSchema,
  SIGNATURE_STATUSES,
  STAGE_STATUSES,
  StageResultSchema,
} from '../../scripts/release/lib/report-schema.mjs';

const SHA = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const COMMAND_IDS = ['npm-ci', 'typecheck', 'lint', 'test', 'build'] as const;
const CHECK_IDS = [
  'security-static-checks',
  'icon-verify',
  'node-native-abi',
  'electron-native-abi',
  'release-invariants',
] as const;

function nativeProbe(runtime: 'node' | 'electron-run-as-node') {
  return {
    schemaVersion: 1,
    runtime,
    nodeVersion: 'v24.15.0',
    electronVersion: runtime === 'node' ? null : '35.7.5',
    modulesAbi: '135',
    napi: '10',
    platform: 'win32',
    arch: 'x64',
    sqliteVersion: '3.49.1',
    status: 'PASS',
  };
}

function testCounts() {
  return { files: 148, tests: 3_634, passed: 3_634, failed: 0, skipped: 0, todo: 0 };
}

function command(id: typeof COMMAND_IDS[number], status: 'PASS' | 'FAIL' = 'PASS') {
  return {
    id,
    status,
    category: status === 'PASS' ? null : 'child-nonzero' as const,
    exitCode: status === 'PASS' ? 0 : 1,
    durationMs: 25,
  };
}

function machineCommand(
  id: typeof COMMAND_IDS[number],
  status: 'PASS' | 'FAIL' = 'PASS',
  category: 'child-nonzero' | 'timeout' | 'output-limit' | 'execution' | 'cleanup-unconfirmed' | 'invalid-output' | 'verification-failed' | null = status === 'PASS' ? null : 'child-nonzero',
  exitCode: number | null = status === 'PASS' ? 0 : 1,
) {
  return { id, status, category, exitCode, durationMs: 25 };
}

function check(id: typeof CHECK_IDS[number], status: 'PASS' | 'FAIL' = 'PASS') {
  return { id, status, durationMs: 15 };
}

function validPreflight() {
  return {
    schemaVersion: 1,
    stage: 'preflight',
    contextId: SHA,
    status: 'PASS',
    blocker: null,
    releaseMetadata: {
      relativePath: 'release-validation/staging/release-metadata.json',
      sha256: SHA,
    },
    packageLockSha256: SHA_B,
    toolchain: {
      nodeVersion: 'v24.15.0',
      npmVersion: '11.12.1',
      electronVersion: '35.7.5',
      electronBuilderVersion: '26.0.12',
      platform: 'win32',
      arch: 'x64',
    },
    commands: COMMAND_IDS.map((id) => command(id)),
    checks: CHECK_IDS.map((id) => check(id)),
    nativeAbi: { node: nativeProbe('node'), electron: nativeProbe('electron-run-as-node') },
    tests: testCounts(),
  };
}

function failedPreflightAt(position: number) {
  const report = validPreflight();
  report.status = 'FAIL';
  report.blocker = `Stage ${position + 1} failed.`;
  if (position < COMMAND_IDS.length) {
    report.commands = COMMAND_IDS.slice(0, position + 1)
      .map((id, index) => command(id, index === position ? 'FAIL' : 'PASS'));
    report.checks = [];
  } else {
    const checkPosition = position - COMMAND_IDS.length;
    report.checks = CHECK_IDS.slice(0, checkPosition + 1)
      .map((id, index) => check(id, index === checkPosition ? 'FAIL' : 'PASS'));
  }
  report.tests = position >= 3 ? testCounts() : null;
  const completedCheckCount = Math.max(0, position - COMMAND_IDS.length);
  report.nativeAbi = {
    node: completedCheckCount >= 3 ? nativeProbe('node') : null,
    electron: completedCheckCount >= 4 ? nativeProbe('electron-run-as-node') : null,
  };
  return report;
}

function validInventory() {
  return {
    version: '1.0.1-rc.1',
    outputRoot: 'release-validation/staging/build-output',
    installer: {
      artifactId: 'release-validation/staging/build-output/ClaudeWorkbench Setup 1.0.1-rc.1.exe',
      size: 164_000_000,
      sha256: SHA,
    },
    unpackedTree: {
      rootId: 'release-validation/staging/build-output/win-unpacked',
      fileCount: 1_024,
      totalBytes: 669_000_000,
      treeSha256: SHA_B,
    },
    metadata: {
      releaseMetadataSha256: SHA,
      embeddedMainReleaseMetadataSha256: SHA,
      resourceReleaseMetadataSha256: SHA,
    },
    appUpdate: { trackedSha256: SHA, packagedSha256: SHA_B },
  };
}

function validBuildReport() {
  return {
    schemaVersion: 1,
    stage: 'build-win',
    contextId: SHA,
    preflightReference: {
      reportPath: 'release-validation/reports/preflight.json',
      reportSha256: SHA_B,
      itemId: 'ARTIFACT-PREFLIGHT',
    },
    builder: {
      nodeVersion: 'v24.15.0',
      electronBuilderVersion: '26.0.12',
      cliRelativePath: 'node_modules/electron-builder/cli.js',
      cliSha256: SHA,
      arguments: ['--win', '--publish', 'never'],
    },
    inventory: validInventory(),
  };
}

const EXPECTED_ITEMS = [
  { id: 1, description: 'release capability audit matrix', scope: 'closed_beta_required' },
  { id: 2, description: 'reused pre-existing release capabilities', scope: 'closed_beta_required' },
  { id: 3, description: 'capabilities added in Task 15', scope: 'closed_beta_required' },
  { id: 4, description: 'target version and selection rationale', scope: 'closed_beta_required' },
  { id: 5, description: 'release channel', scope: 'closed_beta_required' },
  { id: 6, description: 'ReleaseMetadata architecture', scope: 'closed_beta_required' },
  { id: 7, description: 'Build ID and commit injection', scope: 'closed_beta_required' },
  { id: 8, description: 'release preflight', scope: 'closed_beta_required' },
  { id: 9, description: 'installer configuration', scope: 'closed_beta_required' },
  { id: 10, description: 'installer relative path, size, and SHA-256', scope: 'closed_beta_required' },
  { id: 11, description: 'signature status', scope: 'closed_beta_required' },
  { id: 12, description: 'unsigned-user warning', scope: 'closed_beta_required' },
  { id: 13, description: 'updater architecture', scope: 'closed_beta_required' },
  { id: 14, description: 'local-update acceptance', scope: 'closed_beta_required' },
  { id: 15, description: 'upgrade data-retention result', scope: 'closed_beta_required' },
  { id: 16, description: 'database migration/backup result', scope: 'closed_beta_required' },
  { id: 17, description: 'Release Manifest and checksums', scope: 'closed_beta_required' },
  { id: 18, description: 'SBOM', scope: 'closed_beta_required' },
  { id: 19, description: 'third-party notices', scope: 'closed_beta_required' },
  { id: 20, description: 'project-license status', scope: 'closed_beta_required' },
  { id: 21, description: 'privacy-draft status', scope: 'closed_beta_required' },
  { id: 22, description: 'affiliation/brand/asset audit', scope: 'closed_beta_required' },
  { id: 23, description: 'diagnostics redaction/sentinel result', scope: 'closed_beta_required' },
  { id: 24, description: 'Beta Feedback experience', scope: 'closed_beta_required' },
  { id: 25, description: 'install, upgrade, and uninstall acceptance', scope: 'closed_beta_required' },
  { id: 26, description: 'performance and package-composition measurements', scope: 'closed_beta_required' },
  { id: 27, description: 'added/modified file inventory', scope: 'closed_beta_required' },
  { id: 28, description: 'added/expanded test counts', scope: 'closed_beta_required' },
  { id: 29, description: 'full test file/case/pass/fail/skip/todo counts', scope: 'closed_beta_required' },
  { id: 30, description: 'typecheck, lint, test, and build results', scope: 'closed_beta_required' },
  { id: 31, description: 'every release-command result', scope: 'closed_beta_required' },
  { id: 32, description: 'renderer error count', scope: 'closed_beta_required' },
  { id: 33, description: 'test-owned residual-process count', scope: 'closed_beta_required' },
  { id: 34, description: 'closedBetaReady and PASS_FOR_CLOSED_BETA decision', scope: 'informational' },
  { id: 35, description: 'publicGaReady=false and BLOCKED_FOR_PUBLIC_GA reasons', scope: 'ga_only' },
  { id: 36, description: 'final task15 commit SHA', scope: 'closed_beta_required' },
  { id: 37, description: 'stable-main SHA and clean tracked status', scope: 'closed_beta_required' },
  { id: 38, description: 'unresolved issues', scope: 'informational' },
  { id: 39, description: 'future post-merge tag recommendation, explicitly not created', scope: 'informational' },
  { id: 40, description: 'next-stage recommendations', scope: 'informational' },
] as const;

function reference(itemId = 'PRE-1') {
  return {
    reportPath: 'release-validation/reports/preflight.json',
    reportSha256: SHA,
    itemId,
  };
}

function requiredItem(overrides: Record<string, unknown> = {}) {
  return {
    itemId: 'PRE-1',
    scope: 'closed_beta_required',
    status: 'PASS',
    gateInput: true,
    evidence: [reference()],
    blocker: null,
    ...overrides,
  };
}

function gaBlockerItem() {
  return {
    itemId: 'MAN-DIAG-REVIEW',
    scope: 'ga_only',
    status: 'NOT_RUN',
    gateInput: false,
    evidence: [],
    blocker: 'Manual diagnostic ZIP review is not yet supplied.',
  };
}

function licenseItem(overrides: Record<string, unknown> = {}) {
  return requiredItem({
    itemId: '20',
    evidence: [
      {
        ...reference('LICENSE-DECISION-REQUIRED'),
        reportPath: 'docs/legal/LICENSE-DECISION-REQUIRED.md',
      },
      { ...reference('BUNDLED-DOCUMENT-CATALOG'), reportPath: 'build-resources/bundled-documents.json' },
    ],
    licenseDecision: {
      status: 'decision_required',
      documentPath: 'docs/legal/LICENSE-DECISION-REQUIRED.md',
      bundledCatalogMatched: true,
      licenseGrantMade: false,
    },
    ...overrides,
  });
}

function validClosedBetaGate() {
  const fixedRequiredRows = EXPECTED_ITEMS
    .filter(({ scope, id }) => scope === 'closed_beta_required' && id !== 20)
    .map(({ id }) => requiredItem({
      itemId: String(id),
      evidence: [reference(`FINAL-ROW-${id}`)],
    }));
  return {
    closedBetaReady: true,
    publicGaReady: false,
    statusLabels: ['PASS_FOR_CLOSED_BETA', 'BLOCKED_FOR_PUBLIC_GA'],
    blockers: [
      {
        id: 'FINAL_PROJECT_LICENSE',
        scope: 'ga_only',
        severity: 'P2',
        reason: 'A final project license has not been selected.',
      },
      {
        id: 'MAN-DIAG-REVIEW',
        scope: 'ga_only',
        severity: 'P2',
        reason: 'Manual diagnostic ZIP review is not yet supplied.',
      },
    ],
    evidence: [requiredItem(), licenseItem(), ...fixedRequiredRows, gaBlockerItem()],
  };
}

describe('release report schema constants', () => {
  it('freezes exact status vocabularies', () => {
    expect(STAGE_STATUSES).toEqual(['PASS', 'FAIL', 'BLOCKED', 'NEEDS_MANUAL_EVIDENCE']);
    expect(FINAL_REPORT_STATUSES).toEqual([
      'PASS', 'FAIL', 'BLOCKED', 'NOT_RUN', 'NEEDS_MANUAL_EVIDENCE', 'INFORMATIONAL',
    ]);
    expect(SIGNATURE_STATUSES).toEqual([
      'Signed', 'NotSigned', 'UnknownError', 'HashMismatch', 'NotTrusted', 'Expired',
    ]);
    expect(Object.isFrozen(STAGE_STATUSES)).toBe(true);
    expect(Object.isFrozen(FINAL_REPORT_STATUSES)).toBe(true);
    expect(Object.isFrozen(SIGNATURE_STATUSES)).toBe(true);
  });

  it('freezes the exact ordered 40-row final-report contract', () => {
    expect(FINAL_REPORT_ITEM_IDS).toEqual(EXPECTED_ITEMS);
    expect(FINAL_REPORT_ITEM_IDS).toHaveLength(40);
    expect(new Set(FINAL_REPORT_ITEM_IDS.map((item: { id: number }) => item.id)).size).toBe(40);
    expect(Object.isFrozen(FINAL_REPORT_ITEM_IDS)).toBe(true);
    expect(FINAL_REPORT_ITEM_IDS.every(Object.isFrozen)).toBe(true);
  });
});

describe('evidence and stage schemas', () => {
  it('accepts only a strict, hash-bound, workspace-relative evidence reference', () => {
    expect(EvidenceReferenceSchema.parse(reference())).toEqual(reference());
    for (const invalid of [
      { ...reference(), reportSha256: 'A'.repeat(64) },
      { ...reference(), reportSha256: 'a'.repeat(63) },
      { ...reference(), reportPath: 'C:\\private\\report.json' },
      { ...reference(), reportPath: '\\\\server\\share\\report.json' },
      { ...reference(), reportPath: '../outside.json' },
      { ...reference(), reportPath: 'release-validation\\report.json' },
      { ...reference(), extra: true },
    ]) {
      expect(() => EvidenceReferenceSchema.parse(invalid)).toThrow();
    }
  });

  it('keeps stage status, evidence, and blocker semantics orthogonal', () => {
    const stage = {
      stage: 'preflight',
      contextId: SHA,
      scope: 'closed_beta_required',
      status: 'PASS',
      evidence: [reference()],
      blocker: null,
    };
    expect(StageResultSchema.parse(stage)).toEqual(stage);
    expect(() => StageResultSchema.parse({ ...stage, evidence: [] })).toThrow();
    expect(() => StageResultSchema.parse({
      ...stage,
      status: 'BLOCKED',
      evidence: [],
      blocker: null,
    })).toThrow();
  });

  it('binds every report row to its immutable scope and evidence-or-blocker rule', () => {
    expect(FinalReportItemSchema.parse({
      id: 1,
      status: 'PASS',
      evidence: [reference('REPORT-1')],
      blocker: null,
    })).toMatchObject({ id: 1, scope: 'closed_beta_required' });
    expect(() => FinalReportItemSchema.parse({
      id: 1,
      scope: 'ga_only',
      status: 'PASS',
      evidence: [reference('REPORT-1')],
      blocker: null,
    })).toThrow();
    expect(() => FinalReportItemSchema.parse({
      id: 1,
      status: 'NOT_RUN',
      evidence: [],
      blocker: null,
    })).toThrow();
    expect(() => FinalReportItemSchema.parse({
      id: 1,
      status: 'INFORMATIONAL',
      evidence: [reference('REPORT-1')],
      blocker: null,
    })).toThrow();

    for (const status of ['FAIL', 'BLOCKED', 'NOT_RUN', 'NEEDS_MANUAL_EVIDENCE']) {
      expect(() => FinalReportItemSchema.parse({
        id: 1,
        status,
        evidence: [reference('REPORT-1')],
        blocker: null,
      })).toThrow('blocker');
    }
    expect(FinalReportItemSchema.parse({
      id: 38,
      status: 'INFORMATIONAL',
      evidence: [reference('REPORT-38')],
      blocker: null,
    })).toMatchObject({ id: 38, status: 'INFORMATIONAL', scope: 'informational' });
  });
});

describe('strict preflight and native ABI report schemas', () => {
  it('accepts only the exact dual-runtime native ABI result', () => {
    expect(NativeAbiProbeResultSchema.parse(nativeProbe('node'))).toEqual(nativeProbe('node'));
    expect(NativeAbiProbeResultSchema.parse(nativeProbe('electron-run-as-node')))
      .toEqual(nativeProbe('electron-run-as-node'));
    for (const invalid of [
      { ...nativeProbe('node'), electronVersion: '35.7.5' },
      { ...nativeProbe('electron-run-as-node'), electronVersion: null },
      { ...nativeProbe('node'), runtime: 'renderer' },
      { ...nativeProbe('node'), platform: 'linux' },
      { ...nativeProbe('node'), status: 'FAIL' },
      { ...nativeProbe('node'), nodeVersion: ` ${nativeProbe('node').nodeVersion}` },
      { ...nativeProbe('node'), sqliteVersion: `3.49.1+${'a'.repeat(257)}` },
      { ...nativeProbe('node'), stdout: 'raw output' },
    ]) {
      expect(() => NativeAbiProbeResultSchema.parse(invalid)).toThrow();
    }
  });

  it('accepts one strict full PASS report and rejects label-only or probe-slot drift', () => {
    const report = validPreflight();
    expect(PreflightReportSchema.parse(report)).toEqual(report);
    expect(() => PreflightReportSchema.parse({ ...report, blocker: 'Contradiction.' })).toThrow();
    expect(() => PreflightReportSchema.parse({ ...report, checks: report.checks.slice(0, -1) }))
      .toThrow();
    expect(() => PreflightReportSchema.parse({
      ...report,
      nativeAbi: { node: nativeProbe('electron-run-as-node'), electron: nativeProbe('node') },
    })).toThrow();
    expect(() => PreflightReportSchema.parse({
      ...report,
      tests: { ...report.tests, skipped: 1 },
    })).toThrow();
    expect(() => PreflightReportSchema.parse({ ...report, reportSha256: SHA })).toThrow();
  });

  it('requires exact uint32-or-null machine command failure categories', () => {
    const report = validPreflight();
    report.commands = COMMAND_IDS.map((id) => machineCommand(id));
    expect(PreflightReportSchema.parse(report)).toEqual(report);

    for (const category of ['child-nonzero', 'timeout', 'output-limit', 'execution', 'cleanup-unconfirmed', 'invalid-output', 'verification-failed'] as const) {
      const failed = failedPreflightAt(3);
      failed.commands = COMMAND_IDS.slice(0, 4).map((id, index) => machineCommand(
        id,
        index === 3 ? 'FAIL' : 'PASS',
        index === 3 ? category : null,
        index === 3 && category === 'child-nonzero' ? 0xffff_ffff : index === 3 ? null : 0,
      ));
      failed.tests = category === 'child-nonzero' || category === 'verification-failed' ? testCounts() : null;
      expect(PreflightReportSchema.parse(failed)).toEqual(failed);
    }

    for (const invalid of [
      { ...machineCommand('test', 'FAIL', 'child-nonzero', 0), status: 'FAIL' },
      machineCommand('test', 'FAIL', 'child-nonzero', -1),
      machineCommand('test', 'FAIL', 'child-nonzero', 1.5),
      machineCommand('test', 'FAIL', 'child-nonzero', 0x1_0000_0000),
      machineCommand('test', 'FAIL', 'timeout', 1),
      machineCommand('test', 'PASS', null, null),
      { ...machineCommand('test'), category: 'unknown-category' },
      { ...machineCommand('test'), rawOutput: 'must-not-serialize' },
    ]) {
      const mutated = validPreflight();
      mutated.commands = COMMAND_IDS.map((id) => machineCommand(id));
      mutated.commands[3] = invalid as ReturnType<typeof machineCommand>;
      mutated.status = 'FAIL';
      mutated.blocker = 'The reviewed test command failed.';
      mutated.commands = mutated.commands.slice(0, 4);
      mutated.checks = [];
      mutated.tests = testCounts();
      mutated.nativeAbi = { node: null, electron: null };
      expect(() => PreflightReportSchema.parse(mutated)).toThrow();
    }
  });

  it('retains reconciled zero-count test FAIL summaries but rejects them for PASS', () => {
    const emptyDiscovery = { files: 0, tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0 };
    const collectionFailure = { files: 1, tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0 };
    for (const tests of [emptyDiscovery, collectionFailure]) {
      const failed = failedPreflightAt(3);
      failed.commands = COMMAND_IDS.slice(0, 4).map((id, index) => machineCommand(
        id,
        index === 3 ? 'FAIL' : 'PASS',
        index === 3 ? 'child-nonzero' : null,
        index === 3 ? 1 : 0,
      ));
      failed.tests = tests;
      expect(PreflightReportSchema.parse(failed)).toEqual(failed);

      const verificationFailure = failedPreflightAt(3);
      verificationFailure.commands = COMMAND_IDS.slice(0, 4).map((id, index) => machineCommand(
        id,
        index === 3 ? 'FAIL' : 'PASS',
        index === 3 ? 'verification-failed' : null,
        index === 3 ? null : 0,
      ));
      verificationFailure.tests = tests;
      expect(PreflightReportSchema.parse(verificationFailure)).toEqual(verificationFailure);

      const laterFailure = failedPreflightAt(4);
      laterFailure.commands = COMMAND_IDS.map((id, index) => machineCommand(
        id,
        index === 4 ? 'FAIL' : 'PASS',
        index === 4 ? 'child-nonzero' : null,
        index === 4 ? 1 : 0,
      ));
      laterFailure.tests = tests;
      expect(PreflightReportSchema.parse(laterFailure)).toEqual(laterFailure);
    }

    const passWithEmptyDiscovery = validPreflight();
    passWithEmptyDiscovery.commands = COMMAND_IDS.map((id) => machineCommand(id));
    passWithEmptyDiscovery.tests = emptyDiscovery;
    expect(() => PreflightReportSchema.parse(passWithEmptyDiscovery)).toThrow();
  });

  it('rejects URLs and machine-local paths from bounded report text', () => {
    const report = failedPreflightAt(1);
    for (const invalid of [
      { ...report, blocker: 'failed at (C:/Users/alice/private.txt)' },
      { ...report, blocker: 'failed at https://secret.invalid/private' },
      { ...report, blocker: 'failed at /Users/alice/private.txt' },
      { ...report, blocker: 'failed at </Users/alice/private.txt>' },
      { ...report, blocker: 'failed at,/Users/alice/private.txt' },
      { ...report, blocker: 'failed at "C:\\Users\\alice\\private.txt"' },
      { ...report, toolchain: { ...report.toolchain, nodeVersion: 'C:/Users/alice/node.exe' } },
      { ...report, toolchain: { ...report.toolchain, npmVersion: 'https://secret.invalid/npm' } },
      { ...report, toolchain: { ...report.toolchain, electronVersion: '\\\\server\\share\\electron.exe' } },
      { ...report, toolchain: { ...report.toolchain, electronBuilderVersion: `${' '.repeat(10_000)}26.0.12` } },
    ]) {
      expect(() => PreflightReportSchema.parse(invalid)).toThrow();
    }
  });

  it('accepts every exact terminal-failure prefix and nothing after the first failure', () => {
    for (let position = 0; position < COMMAND_IDS.length + CHECK_IDS.length; position += 1) {
      const failed = failedPreflightAt(position);
      expect(PreflightReportSchema.parse(failed)).toEqual(failed);
      if (position < COMMAND_IDS.length) {
        failed.commands.push(command(COMMAND_IDS[Math.min(position + 1, COMMAND_IDS.length - 1)]));
      } else {
        const checkPosition = position - COMMAND_IDS.length;
        failed.checks.push(check(CHECK_IDS[Math.min(checkPosition + 1, CHECK_IDS.length - 1)]));
      }
      expect(() => PreflightReportSchema.parse(failed)).toThrow();
    }
    const allPassLabeledFail = validPreflight();
    allPassLabeledFail.status = 'FAIL';
    allPassLabeledFail.blocker = 'Contradictory state.';
    expect(() => PreflightReportSchema.parse(allPassLabeledFail)).toThrow();
  });
});

describe('strict build inventory and report schemas', () => {
  it('binds the canonical staging inventory and all three metadata hashes', () => {
    const inventory = validInventory();
    expect(BuildInventorySchema.parse(inventory)).toEqual(inventory);
    for (const key of [
      'releaseMetadataSha256',
      'embeddedMainReleaseMetadataSha256',
      'resourceReleaseMetadataSha256',
    ] as const) {
      const mutated = structuredClone(inventory);
      mutated.metadata[key] = SHA_B;
      expect(() => BuildInventorySchema.parse(mutated)).toThrow();
    }
    for (const artifactId of [
      'release/ClaudeWorkbench.exe',
      'C:/private/ClaudeWorkbench.exe',
      '../outside.exe',
      'release-validation\\staging\\build-output\\app.exe',
      'release-validation/staging/build-output/%2e%2e/outside.exe',
      'release-validation/staging/build-output/payload:installer.exe',
      'release-validation/staging/build-output/CON.exe',
      'release-validation/staging/build-output/COM¹.exe',
    ]) {
      expect(() => BuildInventorySchema.parse({
        ...inventory,
        installer: { ...inventory.installer, artifactId },
      })).toThrow();
    }
    expect(() => BuildInventorySchema.parse({
      ...inventory,
      unpackedTree: { ...inventory.unpackedTree, fileCount: 0 },
    })).toThrow();
    for (const rootId of [
      'release-validation/staging/build-output/CON ',
      'release-validation/staging/build-output/NUL',
      'release-validation/staging/build-output/LPT².folder',
      'release-validation/staging/build-output/win-unpacked.',
    ]) {
      expect(() => BuildInventorySchema.parse({
        ...inventory,
        unpackedTree: { ...inventory.unpackedTree, rootId },
      })).toThrow();
    }
  });

  it('accepts only the authoritative preflight reference and exact publish-never builder argv', () => {
    const report = validBuildReport();
    expect(BuildReportSchema.parse(report)).toEqual(report);
    for (const argumentsValue of [
      ['--publish', 'never', '--win'],
      ['--win', '--publish=never'],
      ['--win', '--publish', 'always'],
      ['--win', '--publish', 'never', '--config', 'other.yml'],
    ]) {
      expect(() => BuildReportSchema.parse({
        ...report,
        builder: { ...report.builder, arguments: argumentsValue },
      })).toThrow();
    }
    for (const preflightReference of [
      { ...report.preflightReference, itemId: 'ARTIFACT-BUILD-WIN' },
      { ...report.preflightReference, reportPath: 'release-validation/reports/build-win.json' },
      { ...report.preflightReference, reportPath: 'release/fake.json' },
    ]) {
      expect(() => BuildReportSchema.parse({ ...report, preflightReference })).toThrow();
    }
    expect(() => BuildReportSchema.parse({ ...report, evidence: [reference()] })).toThrow();
  });
});

describe('final gate semantics', () => {
  it('accepts a closed-Beta pass while GA-only MAN-DIAG-REVIEW remains explicit', () => {
    expect(FinalGateSchema.parse(validClosedBetaGate())).toEqual(validClosedBetaGate());
  });

  it('requires every fixed closed-Beta report row exactly once despite extra detailed evidence', () => {
    const missing = validClosedBetaGate();
    missing.evidence = missing.evidence.filter((item) => item.itemId !== '7');
    missing.evidence.push(requiredItem({ itemId: 'A1', evidence: [reference('A1')] }));
    expect(() => FinalGateSchema.parse(missing)).toThrow(/fixed|7/iu);

    const wrongScope = validClosedBetaGate();
    const row7 = wrongScope.evidence.find((item) => item.itemId === '7')!;
    Object.assign(row7, { scope: 'ga_only', gateInput: false });
    expect(() => FinalGateSchema.parse(wrongScope)).toThrow(/fixed|7/iu);

    const duplicate = validClosedBetaGate();
    duplicate.evidence.push(requiredItem({ itemId: '7', evidence: [reference('FINAL-ROW-7')] }));
    expect(() => FinalGateSchema.parse(duplicate)).toThrow('unique');
  });

  it.each(['P0', 'P1'])('rejects closed-Beta readiness with any unresolved %s', (severity) => {
    const gate = validClosedBetaGate();
    gate.blockers.push({
      id: `UNRESOLVED-${severity}`,
      scope: 'ga_only',
      severity,
      reason: 'Unresolved release finding.',
    });
    expect(() => FinalGateSchema.parse(gate)).toThrow(severity);
  });

  it.each(['FAIL', 'BLOCKED', 'NOT_RUN', 'NEEDS_MANUAL_EVIDENCE']) (
    'rejects closed-Beta readiness when a required gate input is %s',
    (status) => {
      const gate = validClosedBetaGate();
      gate.evidence[0] = requiredItem({
        status,
        evidence: [],
        blocker: 'Required evidence is incomplete.',
      });
      expect(() => FinalGateSchema.parse(gate)).toThrow(status);
    },
  );

  it('requires orthogonal blocker semantics for every gate evidence status', () => {
    for (const status of ['FAIL', 'BLOCKED', 'NOT_RUN', 'NEEDS_MANUAL_EVIDENCE']) {
      const gate = validClosedBetaGate();
      gate.closedBetaReady = false;
      gate.statusLabels = ['PASS_FOR_INTERNAL_DEVELOPMENT', 'BLOCKED_FOR_PUBLIC_GA'];
      gate.evidence[0] = requiredItem({
        status,
        evidence: [reference('DETAILED-NEGATIVE')],
        blocker: null,
      });
      expect(() => FinalGateSchema.parse(gate)).toThrow('blocker');
    }

    const requiredPassWithBlocker = validClosedBetaGate();
    const row7 = requiredPassWithBlocker.evidence.find((item) => item.itemId === '7')!;
    row7.blocker = 'Contradictory blocker on a required PASS.';
    expect(() => FinalGateSchema.parse(requiredPassWithBlocker)).toThrow('blocker');

    const informational = validClosedBetaGate();
    informational.evidence.push({
      itemId: '38',
      scope: 'informational',
      status: 'INFORMATIONAL',
      gateInput: false,
      evidence: [reference('FINAL-ROW-38')],
      blocker: null,
    });
    expect(FinalGateSchema.parse(informational)).toEqual(informational);
  });

  it('does not allow GA-only or informational evidence to satisfy a required gate', () => {
    const gate = validClosedBetaGate();
    gate.evidence[0] = requiredItem({ scope: 'ga_only' });
    expect(() => FinalGateSchema.parse(gate)).toThrow('required gate');
    gate.evidence[0] = requiredItem({
      scope: 'informational', status: 'INFORMATIONAL', gateInput: true,
    });
    expect(() => FinalGateSchema.parse(gate)).toThrow('informational');
  });

  it('always blocks public GA and keeps the two readiness decisions orthogonal', () => {
    const gate = validClosedBetaGate();
    expect(() => FinalGateSchema.parse({ ...gate, publicGaReady: true })).toThrow();
    expect(() => FinalGateSchema.parse({
      ...gate,
      statusLabels: ['PASS_FOR_CLOSED_BETA'],
    })).toThrow('BLOCKED_FOR_PUBLIC_GA');
    expect(() => FinalGateSchema.parse({
      ...gate,
      closedBetaReady: false,
      statusLabels: ['PASS_FOR_CLOSED_BETA', 'BLOCKED_FOR_PUBLIC_GA'],
    })).toThrow('PASS_FOR_CLOSED_BETA');
  });

  it('requires truthful row-20 decision evidence and a separate final-license GA blocker', () => {
    for (const invalidLicense of [
      licenseItem({ licenseDecision: undefined }),
      licenseItem({
        licenseDecision: {
          status: 'decision_required',
          documentPath: 'docs/legal/LICENSE-DECISION-REQUIRED.md',
          bundledCatalogMatched: false,
          licenseGrantMade: false,
        },
      }),
      licenseItem({ evidence: [reference('LICENSE-DECISION-REQUIRED')] }),
      licenseItem({
        licenseDecision: {
          status: 'decision_required',
          documentPath: 'docs/legal/LICENSE-DECISION-REQUIRED.md',
          bundledCatalogMatched: true,
          licenseGrantMade: true,
        },
      }),
    ]) {
      const gate = validClosedBetaGate();
      gate.evidence[1] = invalidLicense;
      expect(() => FinalGateSchema.parse(gate)).toThrow();
    }

    const missingGaBlocker = validClosedBetaGate();
    missingGaBlocker.blockers = missingGaBlocker.blockers.filter(
      (blocker) => blocker.id !== 'FINAL_PROJECT_LICENSE',
    );
    expect(() => FinalGateSchema.parse(missingGaBlocker)).toThrow('final project license');
  });

  it('prevents derived rows and final-report bytes from becoming gate inputs', () => {
    for (const itemId of ['34', '35', '38', '39', '40']) {
      const gate = validClosedBetaGate();
      gate.evidence[0] = requiredItem({ itemId, gateInput: true });
      expect(() => FinalGateSchema.parse(gate)).toThrow('derived');
    }
    const gate = validClosedBetaGate();
    gate.evidence[0] = requiredItem({
      evidence: [{
        ...reference(),
        reportPath: 'release-validation/delivery/context/final-report.json',
      }],
    });
    expect(() => FinalGateSchema.parse(gate)).toThrow('self-reference');
  });
});
