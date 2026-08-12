import { z } from 'zod';

export const STAGE_STATUSES = Object.freeze([
  'PASS', 'FAIL', 'BLOCKED', 'NEEDS_MANUAL_EVIDENCE',
]);
export const FINAL_REPORT_STATUSES = Object.freeze([
  'PASS', 'FAIL', 'BLOCKED', 'NOT_RUN', 'NEEDS_MANUAL_EVIDENCE', 'INFORMATIONAL',
]);
export const SIGNATURE_STATUSES = Object.freeze([
  'Signed', 'NotSigned', 'UnknownError', 'HashMismatch', 'NotTrusted', 'Expired',
]);

const SCOPES = Object.freeze(['closed_beta_required', 'ga_only', 'informational']);
const STATUS_LABELS = Object.freeze([
  'PASS_FOR_INTERNAL_DEVELOPMENT', 'PASS_FOR_CLOSED_BETA', 'BLOCKED_FOR_PUBLIC_GA',
]);
const SHA256 = /^[0-9a-f]{64}$/u;
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DERIVED_ITEM_IDS = new Set(['34', '35', '38', '39', '40']);

function isWorkspaceRelativePosix(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')
    || value.startsWith('/') || /^[A-Za-z]:/u.test(value) || value.includes('\0')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function hasLicenseDecisionEvidence(value) {
  return value.evidence.some((evidence) => (
    evidence.reportPath === 'docs/legal/LICENSE-DECISION-REQUIRED.md'
      && evidence.itemId === 'LICENSE-DECISION-REQUIRED'
  )) && value.evidence.some((evidence) => (
    evidence.reportPath === 'build-resources/bundled-documents.json'
      && evidence.itemId === 'BUNDLED-DOCUMENT-CATALOG'
  ));
}

export const EvidenceReferenceSchema = z.object({
  reportPath: z.string().refine(isWorkspaceRelativePosix, 'Evidence path must be workspace-relative POSIX.'),
  reportSha256: z.string().regex(SHA256),
  itemId: z.string().regex(ITEM_ID),
}).strict();

const MAX_BOUNDED_INTEGER = 2_147_483_647;
const MAX_ARTIFACT_INTEGER = Number.MAX_SAFE_INTEGER;
const FORBIDDEN_REPORT_TEXT = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
const COMMAND_IDS = Object.freeze(['npm-ci', 'typecheck', 'lint', 'test', 'build']);
const CHECK_IDS = Object.freeze([
  'security-static-checks',
  'icon-verify',
  'node-native-abi',
  'electron-native-abi',
  'release-invariants',
]);
const EXECUTION_IDS = Object.freeze([...COMMAND_IDS, ...CHECK_IDS]);

function isCanonicalText(value) {
  return value === value.trim() && !FORBIDDEN_REPORT_TEXT.test(value);
}

function containsMachineLocation(value) {
  return value.includes('://')
    || /(?:^|[^0-9A-Za-z])[A-Za-z]:[\\/]/u.test(value)
    || value.includes('\\\\')
    || /(?:^|[\s([{=:])\/[^\s]/u.test(value);
}

const VersionTextSchema = z.string().min(1).max(128).refine(
  (value) => isCanonicalText(value)
    && !containsMachineLocation(value)
    && /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,64})?$/u.test(value),
  'Version text must be a canonical bounded version without a machine path or URL.',
);
const BlockerTextSchema = z.string().min(1).max(1_024).refine(
  (value) => isCanonicalText(value)
    && !containsMachineLocation(value)
    && !/[\\/]/u.test(value),
  'Blocker text must be bounded and must not contain raw machine paths or URLs.',
);
const CountSchema = z.number().int().min(0).max(MAX_BOUNDED_INTEGER);
const PositiveArtifactIntegerSchema = z.number().int().min(1).max(MAX_ARTIFACT_INTEGER);
const DurationSchema = z.number().int().min(0).max(MAX_BOUNDED_INTEGER);
const ExitCodeSchema = z.number().int().min(0).max(0xffff_ffff);
const HashSchema = z.string().regex(SHA256);

export const NativeAbiProbeResultSchema = z.object({
  schemaVersion: z.literal(1),
  runtime: z.enum(['node', 'electron-run-as-node']),
  nodeVersion: VersionTextSchema,
  electronVersion: VersionTextSchema.nullable(),
  modulesAbi: z.string().regex(/^\d{1,10}$/u),
  napi: z.string().regex(/^\d{1,10}$/u),
  platform: z.literal('win32'),
  arch: z.literal('x64'),
  sqliteVersion: z.string().min(1).max(32).regex(/^\d{1,5}\.\d{1,5}\.\d{1,5}$/u),
  status: z.literal('PASS'),
}).strict().superRefine((value, context) => {
  if (value.runtime === 'node' && value.electronVersion !== null) {
    context.addIssue({
      code: 'custom',
      path: ['electronVersion'],
      message: 'The Node ABI result cannot claim an Electron version.',
    });
  }
  if (value.runtime === 'electron-run-as-node' && value.electronVersion === null) {
    context.addIssue({
      code: 'custom',
      path: ['electronVersion'],
      message: 'The Electron ABI result requires its locked Electron version.',
    });
  }
});

const CommandResultBaseSchema = z.object({
  id: z.enum(COMMAND_IDS), status: z.enum(['PASS', 'FAIL']), category: z.enum([
    'child-nonzero', 'timeout', 'output-limit', 'execution', 'cleanup-unconfirmed', 'invalid-output', 'verification-failed',
  ]).nullable(), exitCode: ExitCodeSchema.nullable(), durationMs: DurationSchema,
}).strict();
const CommandResultSchema = CommandResultBaseSchema.superRefine((value, context) => {
  const pass = value.status === 'PASS' && value.category === null && value.exitCode === 0;
  const childFailure = value.status === 'FAIL' && value.category === 'child-nonzero'
    && value.exitCode !== null && value.exitCode >= 1;
  const infrastructureFailure = value.status === 'FAIL'
    && value.category !== null && value.category !== 'child-nonzero' && value.exitCode === null;
  if (!pass && !childFailure && !infrastructureFailure) addReportIssue(context, ['exitCode'], 'Command status, category, and exit code must agree.');
});

const CheckResultSchema = z.object({
  id: z.enum(CHECK_IDS),
  status: z.enum(['PASS', 'FAIL']),
  durationMs: DurationSchema,
}).strict();

const TestCountsSchema = z.object({
  files: CountSchema,
  tests: CountSchema,
  passed: CountSchema,
  failed: CountSchema,
  skipped: CountSchema,
  todo: CountSchema,
}).strict().superRefine((value, context) => {
  if (value.tests !== value.passed + value.failed + value.skipped + value.todo) {
    context.addIssue({
      code: 'custom',
      path: ['tests'],
      message: 'Test counts must reconcile exactly.',
    });
  }
});

const NativeAbiSlotsSchema = z.object({
  node: NativeAbiProbeResultSchema.nullable(),
  electron: NativeAbiProbeResultSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.node !== null && value.node.runtime !== 'node') {
    context.addIssue({ code: 'custom', path: ['node'], message: 'The Node slot requires the Node probe.' });
  }
  if (value.electron !== null && value.electron.runtime !== 'electron-run-as-node') {
    context.addIssue({
      code: 'custom',
      path: ['electron'],
      message: 'The Electron slot requires the Electron run-as-Node probe.',
    });
  }
});

const ToolchainSchema = z.object({
  nodeVersion: VersionTextSchema,
  npmVersion: VersionTextSchema,
  electronVersion: VersionTextSchema,
  electronBuilderVersion: VersionTextSchema,
  platform: z.literal('win32'),
  arch: z.literal('x64'),
}).strict();

function executionSequence(report) {
  return [...report.commands, ...report.checks];
}

function addReportIssue(context, path, message) {
  context.addIssue({ code: 'custom', path, message });
}

export const PreflightReportSchema = z.object({
  schemaVersion: z.literal(1),
  stage: z.literal('preflight'),
  contextId: HashSchema,
  status: z.enum(['PASS', 'FAIL']),
  blocker: BlockerTextSchema.nullable(),
  releaseMetadata: z.object({
    relativePath: z.literal('release-validation/staging/release-metadata.json'),
    sha256: HashSchema,
  }).strict(),
  packageLockSha256: HashSchema,
  toolchain: ToolchainSchema,
  commands: z.array(CommandResultSchema).max(COMMAND_IDS.length),
  checks: z.array(CheckResultSchema).max(CHECK_IDS.length),
  nativeAbi: NativeAbiSlotsSchema,
  tests: TestCountsSchema.nullable(),
}).strict().superRefine((value, context) => {
  const executed = executionSequence(value);
  if (value.status === 'PASS') {
    if (value.blocker !== null) addReportIssue(context, ['blocker'], 'PASS cannot carry a blocker.');
    if (value.commands.length !== COMMAND_IDS.length
      || value.checks.length !== CHECK_IDS.length
      || executed.some((result, index) => result.id !== EXECUTION_IDS[index]
        || result.status !== 'PASS')) {
      addReportIssue(context, ['commands'], 'PASS requires the exact ordered ten-stage PASS sequence.');
    }
    if (value.tests === null
      || value.tests.files < 1
      || value.tests.tests < 1
      || value.tests.failed !== 0
      || value.tests.skipped !== 0
      || value.tests.todo !== 0
      || value.tests.passed !== value.tests.tests) {
      addReportIssue(context, ['tests'], 'PASS requires complete zero-failure, zero-skip test counts.');
    }
    if (value.nativeAbi.node === null || value.nativeAbi.electron === null) {
      addReportIssue(context, ['nativeAbi'], 'PASS requires both native ABI probes.');
    }
    return;
  }

  if (value.blocker === null) addReportIssue(context, ['blocker'], 'FAIL requires a bounded blocker.');
  if (executed.length === 0
    || executed.length > EXECUTION_IDS.length
    || executed.some((result, index) => result.id !== EXECUTION_IDS[index])
    || executed.some((result, index) => (
      index === executed.length - 1 ? result.status !== 'FAIL' : result.status !== 'PASS'
    ))) {
    addReportIssue(context, ['commands'], 'FAIL requires the exact executed prefix ending in one failure.');
    return;
  }
  const failedPosition = executed.length - 1;
  if (failedPosition < COMMAND_IDS.length && value.checks.length !== 0) {
    addReportIssue(context, ['checks'], 'Checks cannot execute after a failed command.');
  }
  const failedCommand = failedPosition < COMMAND_IDS.length ? value.commands[failedPosition] : null;
  const trustworthyTestFailure = failedPosition === 3
    && (failedCommand?.category === 'child-nonzero' || failedCommand?.category === 'verification-failed');
  const shouldHaveTests = failedPosition >= 4 || trustworthyTestFailure;
  if ((value.tests !== null) !== shouldHaveTests) {
    addReportIssue(context, ['tests'], 'Test counts may appear only after a successful test stage.');
  }
  const testStageMayContainFailures = failedPosition === 3 && failedCommand?.category === 'child-nonzero';
  if (value.tests !== null && !testStageMayContainFailures && (value.tests.failed !== 0
    || value.tests.skipped !== 0
    || value.tests.todo !== 0
    || value.tests.passed !== value.tests.tests)) {
    addReportIssue(context, ['tests'], 'Completed preflight test counts must be a zero-failure result.');
  }
  const shouldHaveNodeProbe = failedPosition >= 8;
  const shouldHaveElectronProbe = failedPosition >= 9;
  if ((value.nativeAbi.node !== null) !== shouldHaveNodeProbe
    || (value.nativeAbi.electron !== null) !== shouldHaveElectronProbe) {
    addReportIssue(context, ['nativeAbi'], 'ABI probes must match their completed ordered checks.');
  }
});

function isBuildOutputIdentifier(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 512
    || value.includes('\\')
    || value.startsWith('/')
    || /^[A-Za-z]:/u.test(value)
    || /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(value)
    || /%[0-9A-Fa-f]{2}/u.test(value)) return false;
  const segments = value.split('/');
  const invalidWindowsSegment = /[<>:"|?*]/u;
  const reservedWindowsSegment = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu;
  return value.startsWith('release-validation/staging/build-output/')
    && !value.startsWith('release/')
    && segments.every((segment) => segment.length > 0
      && segment !== '.'
      && segment !== '..'
      && !invalidWindowsSegment.test(segment)
      && !/[. ]$/u.test(segment)
      && !reservedWindowsSegment.test(segment));
}

const BuildOutputIdSchema = z.string().refine(
  isBuildOutputIdentifier,
  'Artifact identifiers must remain normalized POSIX paths inside the canonical build output.',
);

export const BuildInventorySchema = z.object({
  version: z.literal('1.0.1-rc.1'),
  outputRoot: z.literal('release-validation/staging/build-output'),
  installer: z.object({
    artifactId: BuildOutputIdSchema.refine((value) => value.endsWith('.exe'), 'Installer must be an EXE.'),
    size: PositiveArtifactIntegerSchema,
    sha256: HashSchema,
  }).strict(),
  unpackedTree: z.object({
    rootId: BuildOutputIdSchema,
    fileCount: PositiveArtifactIntegerSchema,
    totalBytes: PositiveArtifactIntegerSchema,
    treeSha256: HashSchema,
  }).strict(),
  metadata: z.object({
    releaseMetadataSha256: HashSchema,
    embeddedMainReleaseMetadataSha256: HashSchema,
    resourceReleaseMetadataSha256: HashSchema,
  }).strict(),
  appUpdate: z.object({
    trackedSha256: HashSchema,
    packagedSha256: HashSchema,
  }).strict(),
}).strict().superRefine((value, context) => {
  const hashes = Object.values(value.metadata);
  if (!hashes.every((hash) => hash === hashes[0])) {
    addReportIssue(context, ['metadata'], 'All packaged release metadata hashes must be identical.');
  }
  if (value.installer.artifactId === value.unpackedTree.rootId) {
    addReportIssue(context, ['unpackedTree', 'rootId'], 'Installer and unpacked root IDs must be distinct.');
  }
});

// Task 2D computes treeSha256 over canonical JSON plus one LF for ordinally
// sorted ordinary-file entries shaped exactly as
// { relativePath, mode, size, fileSha256 }. This schema freezes the digest
// field only; it does not claim to enumerate or inspect the packaged tree.

const PreflightEvidenceReferenceSchema = z.object({
  reportPath: z.literal('release-validation/reports/preflight.json'),
  reportSha256: HashSchema,
  itemId: z.literal('ARTIFACT-PREFLIGHT'),
}).strict();

const BuilderInvocationSchema = z.object({
  nodeVersion: VersionTextSchema,
  electronBuilderVersion: VersionTextSchema,
  cliRelativePath: z.literal('node_modules/electron-builder/cli.js'),
  cliSha256: HashSchema,
  arguments: z.tuple([
    z.literal('--win'),
    z.literal('--publish'),
    z.literal('never'),
  ]),
}).strict();

export const BuildReportSchema = z.object({
  schemaVersion: z.literal(1),
  stage: z.literal('build-win'),
  contextId: HashSchema,
  preflightReference: PreflightEvidenceReferenceSchema,
  builder: BuilderInvocationSchema,
  inventory: BuildInventorySchema,
}).strict();

const ScopeSchema = z.enum(SCOPES);
const StageStatusSchema = z.enum(STAGE_STATUSES);
const FinalStatusSchema = z.enum(FINAL_REPORT_STATUSES);

export const StageResultSchema = z.object({
  stage: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  contextId: z.string().regex(SHA256),
  scope: ScopeSchema,
  status: StageStatusSchema,
  evidence: z.array(EvidenceReferenceSchema),
  blocker: z.string().trim().min(1).max(1_024).nullable(),
}).strict().superRefine((value, context) => {
  if (value.status === 'PASS') {
    if (value.evidence.length === 0) {
      context.addIssue({ code: 'custom', path: ['evidence'], message: 'PASS requires hash-bound evidence.' });
    }
    if (value.blocker !== null) {
      context.addIssue({ code: 'custom', path: ['blocker'], message: 'PASS cannot carry a blocker.' });
    }
  } else if (value.blocker === null) {
    context.addIssue({ code: 'custom', path: ['blocker'], message: `${value.status} requires a blocker.` });
  }
});

const rows = [
  [1, 'release capability audit matrix', 'closed_beta_required'],
  [2, 'reused pre-existing release capabilities', 'closed_beta_required'],
  [3, 'capabilities added in Task 15', 'closed_beta_required'],
  [4, 'target version and selection rationale', 'closed_beta_required'],
  [5, 'release channel', 'closed_beta_required'],
  [6, 'ReleaseMetadata architecture', 'closed_beta_required'],
  [7, 'Build ID and commit injection', 'closed_beta_required'],
  [8, 'release preflight', 'closed_beta_required'],
  [9, 'installer configuration', 'closed_beta_required'],
  [10, 'installer relative path, size, and SHA-256', 'closed_beta_required'],
  [11, 'signature status', 'closed_beta_required'],
  [12, 'unsigned-user warning', 'closed_beta_required'],
  [13, 'updater architecture', 'closed_beta_required'],
  [14, 'local-update acceptance', 'closed_beta_required'],
  [15, 'upgrade data-retention result', 'closed_beta_required'],
  [16, 'database migration/backup result', 'closed_beta_required'],
  [17, 'Release Manifest and checksums', 'closed_beta_required'],
  [18, 'SBOM', 'closed_beta_required'],
  [19, 'third-party notices', 'closed_beta_required'],
  [20, 'project-license status', 'closed_beta_required'],
  [21, 'privacy-draft status', 'closed_beta_required'],
  [22, 'affiliation/brand/asset audit', 'closed_beta_required'],
  [23, 'diagnostics redaction/sentinel result', 'closed_beta_required'],
  [24, 'Beta Feedback experience', 'closed_beta_required'],
  [25, 'install, upgrade, and uninstall acceptance', 'closed_beta_required'],
  [26, 'performance and package-composition measurements', 'closed_beta_required'],
  [27, 'added/modified file inventory', 'closed_beta_required'],
  [28, 'added/expanded test counts', 'closed_beta_required'],
  [29, 'full test file/case/pass/fail/skip/todo counts', 'closed_beta_required'],
  [30, 'typecheck, lint, test, and build results', 'closed_beta_required'],
  [31, 'every release-command result', 'closed_beta_required'],
  [32, 'renderer error count', 'closed_beta_required'],
  [33, 'test-owned residual-process count', 'closed_beta_required'],
  [34, 'closedBetaReady and PASS_FOR_CLOSED_BETA decision', 'informational'],
  [35, 'publicGaReady=false and BLOCKED_FOR_PUBLIC_GA reasons', 'ga_only'],
  [36, 'final task15 commit SHA', 'closed_beta_required'],
  [37, 'stable-main SHA and clean tracked status', 'closed_beta_required'],
  [38, 'unresolved issues', 'informational'],
  [39, 'future post-merge tag recommendation, explicitly not created', 'informational'],
  [40, 'next-stage recommendations', 'informational'],
];

export const FINAL_REPORT_ITEM_IDS = Object.freeze(rows.map(([id, description, scope]) => (
  Object.freeze({ id, description, scope })
)));
const ROW_BY_ID = new Map(FINAL_REPORT_ITEM_IDS.map((row) => [row.id, row]));
const FIXED_CLOSED_BETA_ITEM_IDS = Object.freeze(FINAL_REPORT_ITEM_IDS
  .filter((row) => row.scope === 'closed_beta_required')
  .map((row) => String(row.id)));

const LicenseDecisionSchema = z.object({
  status: z.literal('decision_required'),
  documentPath: z.literal('docs/legal/LICENSE-DECISION-REQUIRED.md'),
  bundledCatalogMatched: z.literal(true),
  licenseGrantMade: z.literal(false),
}).strict();

const FinalReportItemBaseSchema = z.object({
  id: z.number().int().min(1).max(40),
  scope: ScopeSchema.optional(),
  status: FinalStatusSchema,
  evidence: z.array(EvidenceReferenceSchema),
  blocker: z.string().trim().min(1).max(1_024).nullable(),
  licenseDecision: LicenseDecisionSchema.optional(),
}).strict().superRefine((value, context) => {
  const definition = ROW_BY_ID.get(value.id);
  if (!definition) return;
  if (value.scope !== undefined && value.scope !== definition.scope) {
    context.addIssue({ code: 'custom', path: ['scope'], message: 'Final report row scope is immutable.' });
  }
  if (value.evidence.length === 0 && value.blocker === null) {
    context.addIssue({ code: 'custom', path: ['evidence'], message: 'Every report row requires evidence or a blocker.' });
  }
  if (definition.scope === 'informational' && value.status !== 'INFORMATIONAL') {
    context.addIssue({ code: 'custom', path: ['status'], message: 'Informational rows must remain INFORMATIONAL.' });
  }
  if (definition.scope === 'closed_beta_required' && value.status === 'INFORMATIONAL') {
    context.addIssue({ code: 'custom', path: ['status'], message: 'Informational status cannot satisfy a required row.' });
  }
  if (value.status === 'PASS' && value.evidence.length === 0) {
    context.addIssue({ code: 'custom', path: ['evidence'], message: 'PASS requires hash-bound evidence.' });
  }
  if (value.status === 'PASS' && value.blocker !== null) {
    context.addIssue({ code: 'custom', path: ['blocker'], message: 'PASS cannot carry a blocker.' });
  }
  if (value.status !== 'PASS' && value.status !== 'INFORMATIONAL' && value.blocker === null) {
    context.addIssue({ code: 'custom', path: ['blocker'], message: `${value.status} requires a blocker.` });
  }
  if (value.id === 20 && value.status === 'PASS'
    && (!value.licenseDecision || !hasLicenseDecisionEvidence(value))) {
    context.addIssue({ code: 'custom', path: ['licenseDecision'], message: 'Row 20 PASS requires hash-bound decision_required evidence.' });
  }
}).transform((value) => ({
  ...value,
  scope: ROW_BY_ID.get(value.id).scope,
}));

export const FinalReportItemSchema = FinalReportItemBaseSchema;

const GateEvidenceItemSchema = z.object({
  itemId: z.string().regex(ITEM_ID),
  scope: ScopeSchema,
  status: FinalStatusSchema,
  gateInput: z.boolean(),
  evidence: z.array(EvidenceReferenceSchema),
  blocker: z.string().trim().min(1).max(1_024).nullable(),
  licenseDecision: LicenseDecisionSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.evidence.length === 0 && value.blocker === null) {
    context.addIssue({ code: 'custom', path: ['evidence'], message: 'Every gate item requires evidence or a blocker.' });
  }
  if (value.status === 'PASS' && value.evidence.length === 0) {
    context.addIssue({ code: 'custom', path: ['evidence'], message: 'PASS requires hash-bound evidence.' });
  }
  if (value.status === 'PASS' && value.blocker !== null) {
    context.addIssue({ code: 'custom', path: ['blocker'], message: 'PASS cannot carry a blocker.' });
  }
  if (value.status !== 'PASS' && value.status !== 'INFORMATIONAL' && value.blocker === null) {
    context.addIssue({ code: 'custom', path: ['blocker'], message: `${value.status} requires a blocker.` });
  }
  if (value.scope === 'closed_beta_required' && !value.gateInput) {
    context.addIssue({ code: 'custom', path: ['gateInput'], message: 'A closed_beta_required item must be a gate input.' });
  }
  if (value.scope !== 'closed_beta_required' && value.gateInput) {
    context.addIssue({ code: 'custom', path: ['gateInput'], message: `${value.scope} evidence cannot satisfy a required gate.` });
  }
  if (value.scope === 'informational' && value.status !== 'INFORMATIONAL') {
    context.addIssue({ code: 'custom', path: ['status'], message: 'An informational item must remain INFORMATIONAL.' });
  }
  if (DERIVED_ITEM_IDS.has(value.itemId) && value.gateInput) {
    context.addIssue({ code: 'custom', path: ['gateInput'], message: 'A derived final-report row cannot be a gate input.' });
  }
  if (value.itemId === '20' && value.status === 'PASS'
    && (!value.licenseDecision || !hasLicenseDecisionEvidence(value))) {
    context.addIssue({ code: 'custom', path: ['licenseDecision'], message: 'Row 20 PASS requires truthful hash-bound decision_required evidence.' });
  }
  if (value.evidence.some(({ reportPath }) => /(?:^|\/)final-report\.(?:json|md)$/iu.test(reportPath))) {
    context.addIssue({ code: 'custom', path: ['evidence'], message: 'Final gate evidence must not create a final-report self-reference.' });
  }
});

const BlockerSchema = z.object({
  id: z.string().regex(ITEM_ID),
  scope: z.enum(['closed_beta_required', 'ga_only']),
  severity: z.enum(['P0', 'P1', 'P2']),
  reason: z.string().trim().min(1).max(1_024),
}).strict();

export const FinalGateSchema = z.object({
  closedBetaReady: z.boolean(),
  publicGaReady: z.literal(false),
  statusLabels: z.array(z.enum(STATUS_LABELS)).min(1),
  blockers: z.array(BlockerSchema),
  evidence: z.array(GateEvidenceItemSchema).min(1),
}).strict().superRefine((value, context) => {
  const uniqueLabels = new Set(value.statusLabels);
  if (uniqueLabels.size !== value.statusLabels.length) {
    context.addIssue({ code: 'custom', path: ['statusLabels'], message: 'Status labels must be unique.' });
  }
  if (!uniqueLabels.has('BLOCKED_FOR_PUBLIC_GA')) {
    context.addIssue({ code: 'custom', path: ['statusLabels'], message: 'BLOCKED_FOR_PUBLIC_GA is mandatory.' });
  }
  if (value.closedBetaReady) {
    if (!uniqueLabels.has('PASS_FOR_CLOSED_BETA')) {
      context.addIssue({ code: 'custom', path: ['statusLabels'], message: 'PASS_FOR_CLOSED_BETA is required for a Beta pass.' });
    }
    if (uniqueLabels.has('PASS_FOR_INTERNAL_DEVELOPMENT')) {
      context.addIssue({ code: 'custom', path: ['statusLabels'], message: 'Internal-only label contradicts a closed-Beta pass.' });
    }
  } else {
    if (uniqueLabels.has('PASS_FOR_CLOSED_BETA')) {
      context.addIssue({ code: 'custom', path: ['statusLabels'], message: 'PASS_FOR_CLOSED_BETA requires closedBetaReady=true.' });
    }
    if (!uniqueLabels.has('PASS_FOR_INTERNAL_DEVELOPMENT')) {
      context.addIssue({ code: 'custom', path: ['statusLabels'], message: 'A non-passing candidate remains internal development only.' });
    }
  }

  const seenItems = new Set();
  for (const [index, item] of value.evidence.entries()) {
    if (seenItems.has(item.itemId)) {
      context.addIssue({ code: 'custom', path: ['evidence', index, 'itemId'], message: 'Gate item IDs must be unique.' });
    }
    seenItems.add(item.itemId);
    if (value.closedBetaReady && item.scope === 'closed_beta_required' && item.status !== 'PASS') {
      context.addIssue({
        code: 'custom',
        path: ['evidence', index, 'status'],
        message: `closed_beta_required item ${item.itemId} is ${item.status}.`,
      });
    }
    if (item.scope === 'ga_only' && item.status !== 'PASS'
      && !value.blockers.some((blocker) => blocker.scope === 'ga_only' && blocker.id === item.itemId)) {
      context.addIssue({ code: 'custom', path: ['blockers'], message: `GA blocker ${item.itemId} must be explicit.` });
    }
  }

  if (value.closedBetaReady) {
    for (const requiredId of FIXED_CLOSED_BETA_ITEM_IDS) {
      const matching = value.evidence.filter((item) => item.itemId === requiredId);
      if (matching.length !== 1
        || matching[0].scope !== 'closed_beta_required'
        || matching[0].gateInput !== true
        || matching[0].status !== 'PASS'
        || matching[0].evidence.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['evidence'],
          message: `Fixed closed-Beta report row ${requiredId} must appear exactly once with hash-bound PASS evidence.`,
        });
      }
    }
    for (const [index, blocker] of value.blockers.entries()) {
      if (blocker.severity === 'P0' || blocker.severity === 'P1') {
        context.addIssue({
          code: 'custom',
          path: ['blockers', index, 'severity'],
          message: `Unresolved ${blocker.severity} prevents closed-Beta readiness.`,
        });
      }
      if (blocker.scope === 'closed_beta_required') {
        context.addIssue({ code: 'custom', path: ['blockers', index], message: 'A closed-Beta blocker prevents readiness.' });
      }
    }
    const license = value.evidence.find((item) => item.itemId === '20');
    if (license && license.status === 'PASS'
      && !value.blockers.some((blocker) => blocker.scope === 'ga_only'
        && blocker.id === 'FINAL_PROJECT_LICENSE')) {
      context.addIssue({ code: 'custom', path: ['blockers'], message: 'The missing final project license must remain a GA blocker.' });
    }
  }
});
