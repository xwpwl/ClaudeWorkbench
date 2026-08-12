import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { readSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTddChildArgv, getTddPhase } from './requirements-contract.mjs';
import {
  assertCanonicalWorkspace,
  minimalChildEnvironment,
  runObservedTddCommand,
  runTrustedGit,
} from './lib/tdd-evidence.mjs';

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVIDENCE_PATH = path.join(WORKSPACE_ROOT, 'release-validation', 'tdd', 'requirements-tdd-evidence.json');

function assertLauncherAttestation() {
  const expected = process.env.WORKBENCH_TDD_LAUNCH_TOKEN;
  delete process.env.WORKBENCH_TDD_LAUNCH_TOKEN;
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/u.test(expected)) {
    throw new Error('The direct Node recorder entry is unsupported.');
  }
  if (process.stdin.isTTY) throw new Error('The direct Node recorder entry is unsupported.');
  const input = Buffer.alloc(67);
  let length = 0;
  while (length < input.length) {
    const count = readSync(0, input, length, input.length - length, null);
    if (count === 0) break;
    length += count;
  }
  const supplied = input.subarray(0, length).toString('utf8').replace(/\r?\n$/u, '');
  const expectedBytes = Buffer.from(expected, 'utf8');
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  if (length > 66 || suppliedBytes.length !== expectedBytes.length
    || !timingSafeEqual(suppliedBytes, expectedBytes)) {
    throw new Error('The direct Node recorder entry is unsupported.');
  }
  const forbiddenEnvironment = Object.keys(process.env).some((key) => /^(?:NODE|NPM|YARN|PNPM|ELECTRON|VSCODE|OPENSSL|SSL_CERT|UV_|COMPLUS_|COR_)/iu.test(key));
  if (forbiddenEnvironment) throw new Error('Caller runtime injection is not permitted.');
}

function parseArguments(argv) {
  const separator = argv.indexOf('--');
  if (separator < 0 || separator === argv.length - 1) throw new Error('invalid command');
  const options = {};
  const optionArgs = argv.slice(0, separator);
  for (let index = 0; index < optionArgs.length; index += 1) {
    const option = optionArgs[index];
    const value = optionArgs[index + 1];
    if (!['--phase', '--case-ids', '--command-id'].includes(option) || !value || value.startsWith('--')) {
      throw new Error('invalid command');
    }
    const key = option.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    if (options[key]) throw new Error('invalid command');
    options[key] = value;
    index += 1;
  }
  if (!options.phase || !options.caseIds || !options.commandId) throw new Error('invalid command');
  const caseIds = options.caseIds.split(',');
  if (caseIds.some((caseId) => !caseId)) throw new Error('invalid command');
  return { phase: options.phase, caseIds, commandId: options.commandId, childArgv: argv.slice(separator + 1) };
}

function runArgumentVector(childArgv, workspaceRoot) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, childArgv.slice(1), {
      cwd: workspaceRoot,
      env: minimalChildEnvironment(),
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', () => resolve({ exitCode: 1 }));
    child.once('exit', (code) => resolve({ exitCode: Number.isInteger(code) ? code : 1 }));
  });
}

async function main() {
  assertLauncherAttestation();
  const { phase, caseIds, commandId, childArgv } = parseArguments(process.argv.slice(2));
  const phaseDefinition = assertTddChildArgv(commandId, phase, childArgv);
  const canonicalWorkspaceRoot = await assertCanonicalWorkspace(WORKSPACE_ROOT);
  const { stdout } = await runTrustedGit(['-C', canonicalWorkspaceRoot, 'rev-parse', '--show-toplevel']);
  const gitWorkspaceRoot = await fs.realpath(stdout.trim());
  if (path.relative(canonicalWorkspaceRoot, gitWorkspaceRoot) !== '') throw new Error('invalid workspace root');
  const record = await runObservedTddCommand({
    phase,
    caseIds,
    commandId,
    observedTestReferences: phaseDefinition.testReferences,
    evidencePath: EVIDENCE_PATH,
    workspaceRoot: canonicalWorkspaceRoot,
    runner: () => runArgumentVector(childArgv, canonicalWorkspaceRoot),
  });
  process.stdout.write(`Recorded ${record.phase} evidence for ${record.commandId} (${record.caseIds.join(',')}).\n`);
}

main().catch(() => {
  process.stderr.write('TDD evidence command failed.\n');
  process.exitCode = 1;
});
