const freeze = (value) => Object.freeze(value);

const CASE_DESCRIPTIONS = freeze([
  ['VER-01', 'single version source'], ['VER-02', 'higher than known installed version'],
  ['VER-03', 'RC channel'], ['VER-04', 'invalid version blocks'], ['VER-05', 'dirty blocks'],
  ['VER-06', 'unknown commit blocks'], ['VER-07', 'Build ID parses as version + short SHA + UTC'],
  ['META-08', 'complete metadata'], ['META-09', 'no absolute path'], ['META-10', 'no secret'],
  ['META-11', 'About equals Manifest public facts'], ['META-12', 'Diagnostics equals Metadata public facts'],
  ['INS-13', 'filename has real version'], ['INS-14', 'stable App ID'], ['INS-15', 'install-directory policy'],
  ['INS-16', 'shortcuts'], ['INS-17', 'uninstall retains project'], ['INS-18', 'default retains userData'],
  ['INS-19', 'any optional local-data cleanup requires explicit confirmation'], ['INS-20', 'package excludes forbidden directories'],
  ['SIG-21', 'no certificate → NotSigned'], ['SIG-22', 'never forge Signed'],
  ['SIG-23', 'signing password absent from logs'], ['SIG-24', 'signature result in Manifest'],
  ['SIG-25', 'invalid certificate blocks signing'],
  ['UPD-26', 'no feed UI'], ['UPD-27', 'Renderer cannot set URL'], ['UPD-28', 'loopback only in test'],
  ['UPD-29', 'RC channel'], ['UPD-30', 'explicit download'], ['UPD-31', 'explicit install'],
  ['UPD-32', 'no forced restart'], ['UPD-33', 'hash mismatch rejects'], ['UPD-34', 'future schema not overwritten'],
  ['UPD-35', 'pre-update backup'], ['UPD-36', 'Provider/history retained'],
  ['DIA-37', 'Release Metadata exported'], ['DIA-38', 'no API key'], ['DIA-39', 'no credential ref'],
  ['DIA-40', 'no vault path'], ['DIA-41', 'no source'], ['DIA-42', 'update logs redacted'],
  ['DIA-43', 'crash metadata redacted'], ['DIA-44', 'all sentinel secrets filtered'],
  ['SBM-45', 'SBOM generated'], ['SBM-46', 'production closure complete'],
  ['SBM-47', 'third-party notice generated'], ['SBM-48', 'unknown license flagged'],
  ['SBM-49', 'project license not auto-selected'],
  ['FDB-50', 'template has no user code'], ['FDB-51', 'diagnostics off by default'],
  ['FDB-52', 'only explicit inclusion'], ['FDB-53', 'absent URL stays local'],
  ['FDB-54', 'feedback result/path does not leak username'],
  ['SEC-55', 'release IPC sender check'], ['SEC-56', 'updater IPC sender check'],
  ['SEC-57', 'diagnostics IPC sender check'], ['SEC-58', 'release-artifact secret scan'],
  ['SEC-59', 'installer inventory scan'], ['SEC-60', 'Manifest path scan'],
].map(([id, description]) => freeze({ id, description })));

function phase(testReferences) {
  const childArgv = ['node', 'node_modules/vitest/vitest.mjs', 'run', ...testReferences];
  return freeze({ testReferences: freeze(testReferences), childArgv: freeze(childArgv) });
}

function slice(commandId, caseIds, redTestReferences, greenTestReferences, relatedSourcePaths) {
  return freeze({
    commandId,
    caseIds: freeze(caseIds),
    phases: freeze({ red: phase(redTestReferences), green: phase(greenTestReferences) }),
    relatedSourcePaths: freeze(relatedSourcePaths),
  });
}

export const TDD_COMMAND_SLICES = freeze([
  slice('foundation-version-metadata',
    ['VER-01', 'VER-02', 'VER-03', 'VER-04', 'VER-05', 'VER-06', 'VER-07', 'META-08', 'META-09', 'META-10', 'META-11', 'META-12'],
    ['src/main/release/__tests__/ReleaseMetadata.test.ts', 'tests/release/release-metadata-script.test.ts', 'src/main/release/__tests__/VersionInfo.test.ts'],
    ['src/main/release/__tests__/ReleaseMetadata.test.ts', 'tests/release/release-metadata-script.test.ts', 'src/main/release/__tests__/VersionInfo.test.ts'],
    ['package.json', 'package-lock.json', 'vite.main.config.ts', 'src/main/index.ts', 'src/shared/release-contract.json', 'src/shared/types/release.ts', 'src/main/release/ReleaseMetadata.ts', 'src/main/release/VersionInfo.ts', 'scripts/lib/release-metadata.mjs']),
  slice('foundation-installer',
    ['INS-13', 'INS-14', 'INS-15', 'INS-16', 'INS-17', 'INS-18', 'INS-19', 'INS-20'],
    ['src/main/release/__tests__/InstallerConfig.test.ts', 'src/main/release/__tests__/AppIconPath.test.ts', 'tests/release/app-update-config.test.ts'],
    ['src/main/release/__tests__/InstallerConfig.test.ts', 'src/main/release/__tests__/AppIconPath.test.ts', 'tests/release/app-update-config.test.ts'],
    ['electron-builder.yml', 'build-resources/installer.nsh', 'build-resources/app-update.yml', 'src/shared/update-bootstrap-contract.json', 'src/main/release/AppIcon.ts', 'src/main/release/UpdateBootstrapConfig.ts', 'scripts/generate-app-update-config.mjs']),
  slice('foundation-release-ipc', ['SEC-55'],
    ['src/main/ipc/__tests__/release.test.ts', 'src/preload/__tests__/index.test.ts', 'src/preload/__tests__/transport-surface.test.ts'],
    ['src/main/ipc/__tests__/release.test.ts', 'src/preload/__tests__/index.test.ts', 'src/preload/__tests__/transport-surface.test.ts'],
    ['src/main/ipc/release.ts', 'src/preload/index.ts', 'src/shared/types/ipc.ts', 'src/shared/release-contract.json']),
  slice('artifact-signing', ['SIG-21', 'SIG-22', 'SIG-23', 'SIG-24', 'SIG-25'],
    ['tests/release/release-signing.test.ts'],
    ['tests/release/release-signing.test.ts', 'src/main/release/__tests__/AuthenticodeStatusReader.test.ts', 'src/main/release/__tests__/RuntimeReleaseStatus.test.ts'],
    ['package.json', 'src/shared/authenticode-command.json', 'src/shared/release-contract.json', 'scripts/release/signing.mjs', 'scripts/release/lib/authenticode.mjs', 'src/main/release/AuthenticodeStatusReader.ts', 'src/main/release/RuntimeReleaseStatus.ts']),
  slice('artifact-sbom', ['SBM-45', 'SBM-46', 'SBM-47', 'SBM-48', 'SBM-49'],
    ['tests/release/release-sbom.test.ts'],
    ['tests/release/release-sbom.test.ts'],
    ['package.json', 'scripts/release/sbom.mjs', 'scripts/release/lib/artifact-inventory.mjs']),
  slice('artifact-package-scans', ['SEC-58', 'SEC-59', 'SEC-60'],
    ['tests/release/release-manifest.test.ts', 'tests/release/release-verify.test.ts'],
    ['tests/release/release-manifest.test.ts', 'tests/release/release-verify.test.ts'],
    ['package.json', 'scripts/release/manifest.mjs', 'scripts/release/verify.mjs']),
  slice('updater-source-policy', ['UPD-26', 'UPD-28', 'UPD-29'],
    ['src/main/release/__tests__/UpdateSourcePolicy.test.ts', 'src/main/release/__tests__/UpdateTransportGuard.test.ts', 'src/main/release/__tests__/UpdateManager.test.ts'],
    ['src/main/release/__tests__/UpdateSourcePolicy.test.ts', 'src/main/release/__tests__/UpdateTransportGuard.test.ts', 'src/main/release/__tests__/UpdateManager.test.ts'],
    ['src/main/release/UpdateSourcePolicy.ts', 'src/main/release/UpdateTransportGuard.ts', 'src/main/release/UpdateManager.ts', 'src/main/index.ts', 'vite.main.config.ts']),
  slice('updater-install-safety', ['UPD-30', 'UPD-31', 'UPD-32', 'UPD-33', 'UPD-34', 'UPD-35', 'UPD-36'],
    ['src/main/release/__tests__/UpdateSignatureInspector.test.ts', 'src/main/release/__tests__/UpdateInstallGuard.test.ts', 'src/main/release/__tests__/UpdateManager.test.ts'],
    ['src/main/release/__tests__/UpdateSignatureInspector.test.ts', 'src/main/release/__tests__/UpdateInstallGuard.test.ts', 'src/main/release/__tests__/UpdateManager.test.ts'],
    ['src/main/release/UpdateSignatureInspector.ts', 'src/main/release/UpdateInstallGuard.ts', 'src/main/release/UpdateManager.ts', 'src/shared/authenticode-command.json', 'src/shared/release-contract.json']),
  slice('updater-ipc', ['UPD-27', 'SEC-56'],
    ['src/main/ipc/__tests__/release.test.ts', 'src/main/ipc/__tests__/database-compatibility.test.ts', 'src/preload/__tests__/index.test.ts', 'src/preload/__tests__/transport-surface.test.ts'],
    ['src/main/ipc/__tests__/release.test.ts', 'src/main/ipc/__tests__/database-compatibility.test.ts', 'src/preload/__tests__/index.test.ts', 'src/preload/__tests__/transport-surface.test.ts', 'src/preload/__tests__/public-ipc-transport.test.ts', 'src/renderer/__tests__/public-api-facade.test.ts'],
    ['src/main/ipc/release.ts', 'src/main/ipc/database-compatibility.ts', 'src/preload/index.ts', 'src/shared/types/ipc.ts', 'src/main/index.ts']),
  slice('diagnostics-export', ['DIA-37', 'DIA-38', 'DIA-39', 'DIA-40', 'DIA-41', 'DIA-42', 'DIA-43', 'DIA-44'],
    ['src/main/diagnostics/__tests__/DiagnosticsSchemas.test.ts', 'src/main/diagnostics/__tests__/DiagnosticsSnapshotProvider.test.ts', 'src/main/diagnostics/__tests__/DiagnosticsExporter.test.ts', 'src/main/diagnostics/__tests__/DiagnosticsExporter.release.test.ts'],
    ['src/main/diagnostics/__tests__/DiagnosticsSchemas.test.ts', 'src/main/diagnostics/__tests__/DiagnosticsSnapshotProvider.test.ts', 'src/main/files/__tests__/SafeUserSelectedWriter.test.ts', 'src/main/diagnostics/__tests__/DiagnosticsExporter.test.ts', 'src/main/diagnostics/__tests__/DiagnosticsExporter.release.test.ts', 'src/main/ipc/__tests__/diagnostics.test.ts'],
    ['src/main/diagnostics/DiagnosticsSchemas.ts', 'src/main/diagnostics/DiagnosticsSnapshotProvider.ts', 'src/main/diagnostics/DiagnosticsExporter.ts', 'src/main/files/SafeUserSelectedWriter.ts', 'src/main/ipc/diagnostics.ts', 'src/main/index.ts']),
  slice('diagnostics-ipc', ['SEC-57'],
    ['src/main/logging/__tests__/StructuredLogger.test.ts', 'src/main/logging/__tests__/StructuredLogger.release.test.ts', 'src/main/diagnostics/__tests__/RendererErrorCollector.test.ts', 'src/main/ipc/__tests__/diagnostics.test.ts', 'src/preload/__tests__/index.test.ts', 'src/preload/__tests__/transport-surface.test.ts', 'src/preload/__tests__/public-ipc-transport.test.ts', 'src/renderer/__tests__/public-api-facade.test.ts', 'src/renderer/__tests__/renderer-bootstrap.test.ts'],
    ['src/main/logging/__tests__/StructuredLogger.test.ts', 'src/main/logging/__tests__/StructuredLogger.release.test.ts', 'src/main/diagnostics/__tests__/RendererErrorCollector.test.ts', 'src/main/ipc/__tests__/diagnostics.test.ts', 'src/preload/__tests__/index.test.ts', 'src/preload/__tests__/transport-surface.test.ts', 'src/preload/__tests__/public-ipc-transport.test.ts', 'src/renderer/__tests__/public-api-facade.test.ts', 'src/renderer/__tests__/renderer-bootstrap.test.ts'],
    ['src/main/logging/StructuredLogger.ts', 'src/main/diagnostics/RendererErrorCollector.ts', 'src/main/ipc/diagnostics.ts', 'src/preload/index.ts', 'src/shared/types/ipc.ts']),
  slice('beta-feedback', ['FDB-50', 'FDB-51', 'FDB-52', 'FDB-53', 'FDB-54'],
    ['src/main/feedback/__tests__/BetaFeedbackService.test.ts', 'src/main/ipc/__tests__/feedback.test.ts', 'src/preload/__tests__/index.test.ts', 'src/preload/__tests__/transport-surface.test.ts'],
    ['src/main/feedback/__tests__/BetaFeedbackService.test.ts', 'src/main/ipc/__tests__/feedback.test.ts', 'src/preload/__tests__/index.test.ts', 'src/preload/__tests__/transport-surface.test.ts', 'src/preload/__tests__/public-ipc-transport.test.ts', 'src/renderer/__tests__/public-api-facade.test.ts'],
    ['src/shared/types/feedback.ts', 'src/shared/feedback-config.json', 'src/main/feedback/BetaFeedbackService.ts', 'src/main/files/SafeUserSelectedWriter.ts', 'src/main/ipc/feedback.ts', 'src/preload/index.ts', 'src/shared/types/ipc.ts']),
]);

const slicesById = new Map(TDD_COMMAND_SLICES.map((entry) => [entry.commandId, entry]));
const casesById = new Map(CASE_DESCRIPTIONS.map((entry) => [entry.id, entry]));

export const TDD_REQUIREMENT_CASES = freeze(CASE_DESCRIPTIONS.map((entry) => {
  const slices = TDD_COMMAND_SLICES.filter((candidate) => candidate.caseIds.includes(entry.id));
  if (slices.length !== 1) throw new Error(`Requirement assignment must be unique: ${entry.id}`);
  const assigned = slices[0];
  return freeze({
    ...entry,
    commandId: assigned.commandId,
    phaseTestReferences: assigned.phases,
    relatedSourcePaths: assigned.relatedSourcePaths,
  });
}));

const greenPathObservationSlices = new Map();
for (const sliceDefinition of TDD_COMMAND_SLICES) {
  for (const observedPath of [...sliceDefinition.phases.green.testReferences, ...sliceDefinition.relatedSourcePaths]) {
    const observations = greenPathObservationSlices.get(observedPath) ?? [];
    observations.push(sliceDefinition.commandId);
    greenPathObservationSlices.set(observedPath, observations);
  }
}

export const TDD_GREEN_PATH_OBSERVATION_SLICES = freeze(Object.fromEntries(
  [...greenPathObservationSlices.entries()].map(([observedPath, observations]) => [observedPath, freeze([...observations])]),
));

export const TDD_FINAL_GREEN_ORDER = freeze(TDD_COMMAND_SLICES.map(({ commandId }) => commandId));

export const TDD_FINAL_PATH_OBSERVATION_SLICE = freeze(Object.fromEntries(
  Object.entries(TDD_GREEN_PATH_OBSERVATION_SLICES).map(([observedPath, observations]) => [
    observedPath,
    observations[observations.length - 1],
  ]),
));

if (TDD_REQUIREMENT_CASES.length !== 60 || new Set(TDD_REQUIREMENT_CASES.map(({ id }) => id)).size !== 60) {
  throw new Error('The TDD requirement contract must contain exactly 60 unique IDs.');
}

export function getTddCommandSlice(commandId) {
  return slicesById.get(commandId) ?? null;
}

export function assertTddCommandAssignment({ commandId, caseIds }) {
  const sliceDefinition = getTddCommandSlice(commandId);
  if (!sliceDefinition || !Array.isArray(caseIds) || caseIds.length !== sliceDefinition.caseIds.length
    || caseIds.some((caseId, index) => caseId !== sliceDefinition.caseIds[index])
    || caseIds.some((caseId) => !casesById.has(caseId))) {
    throw new Error('The command ID and requirement case IDs are not allowlisted.');
  }
  return sliceDefinition;
}

function sameArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((item, index) => item === expected[index]);
}

export function getTddPhase(commandId, phaseName) {
  const sliceDefinition = getTddCommandSlice(commandId);
  return sliceDefinition?.phases[phaseName] ?? null;
}

export function assertTddTestReferences(commandId, phaseName, testReferences) {
  const phaseDefinition = getTddPhase(commandId, phaseName);
  if (!phaseDefinition || !sameArray(testReferences, phaseDefinition.testReferences)) {
    throw new Error('The focused test references must exactly match the approved phase vector.');
  }
  return phaseDefinition;
}

export function assertTddChildArgv(commandId, phaseName, childArgv) {
  const phaseDefinition = getTddPhase(commandId, phaseName);
  if (!phaseDefinition || !sameArray(childArgv, phaseDefinition.childArgv)) {
    throw new Error('The child command must exactly match the approved Vitest argument vector.');
  }
  return phaseDefinition;
}
