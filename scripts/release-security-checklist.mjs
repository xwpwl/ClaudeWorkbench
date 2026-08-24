import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAtomicJson } from './release/lib/common.mjs';
import {
  assertSecurityChecklistResults,
  runSecurityChecklist,
} from './release/lib/security-checklist.mjs';

const REPORT_PATH = 'release-validation/reports/security-checklist-diagnostic.json';
const ARGUMENT_ERROR = 'Release security checklist accepts no arguments.';

function samePath(left, right) {
  const normalize = (value) => path.resolve(value).replace(/[\\/]+$/u, '').toLowerCase();
  return normalize(left) === normalize(right);
}

function assertOrdinaryDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || !samePath(fs.realpathSync.native(directory), directory)) {
    throw new Error(`${label} must be an ordinary directory.`);
  }
}

export function ensureFixedReportDirectory(workspaceRoot) {
  assertOrdinaryDirectory(workspaceRoot, 'Release workspace');
  let current = workspaceRoot;
  for (const segment of ['release-validation', 'reports']) {
    current = path.join(current, segment);
    try {
      assertOrdinaryDirectory(current, 'Security diagnostic report directory');
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      fs.mkdirSync(current, { recursive: false, mode: 0o700 });
      assertOrdinaryDirectory(current, 'Security diagnostic report directory');
    }
  }
}

function workspaceRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export async function runDiagnosticCli({
  argv = process.argv.slice(2),
  deps = {},
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) throw new Error(ARGUMENT_ERROR);

  const root = workspaceRoot();
  const runChecklist = deps.runSecurityChecklist ?? runSecurityChecklist;
  const validateResults = deps.assertSecurityChecklistResults ?? assertSecurityChecklistResults;
  const ensureDirectory = deps.ensureFixedReportDirectory ?? ensureFixedReportDirectory;
  const writeReport = deps.writeAtomicJson ?? writeAtomicJson;
  const results = validateResults(await runChecklist({ workspaceRoot: root, deps: deps.checklist }));
  const report = Object.freeze({
    schemaVersion: 1,
    kind: 'security-checklist-diagnostic',
    authoritative: false,
    results,
  });
  ensureDirectory(root);
  const reportPath = writeReport(root, REPORT_PATH, report);
  return Object.freeze({
    exitCode: results.every((item) => item.status === 'PASS') ? 0 : 1,
    reportPath,
    report,
  });
}

function isDirectExecution() {
  return Boolean(process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
  runDiagnosticCli().then((result) => {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
    process.exitCode = result.exitCode;
  }).catch((error) => {
    process.stderr.write(error?.message === ARGUMENT_ERROR
      ? `${ARGUMENT_ERROR}\n`
      : 'Release security checklist failed.\n');
    process.exitCode = 1;
  });
}
