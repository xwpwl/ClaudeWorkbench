import fs from 'node:fs';
import path from 'node:path';

export const SECURITY_CHECK_IDS = Object.freeze([
  'permissions-default-standard',
  'renderer-node-integration-disabled',
  'renderer-context-isolation-enabled',
  'renderer-sandbox-enabled',
  'single-instance-lock-enabled',
  'nsis-current-user',
  'code-signing-hook-prepared',
  'dangerous-git-mutations-absent',
]);

const FIXED_SOURCE_PATHS = Object.freeze({
  settings: 'src/main/ipc/settings.ts',
  main: 'src/main/index.ts',
  singleInstance: 'src/main/lifecycle/SingleInstanceGuard.ts',
  builder: 'electron-builder.yml',
});
const MUTATION_SOURCE_DIRECTORIES = Object.freeze([
  'src/main/checkpoints',
  'src/main/file-changes',
]);

function readTextDefault(workspaceRoot, relativePath) {
  return fs.readFileSync(path.join(workspaceRoot, ...relativePath.split('/')), 'utf8');
}

function collectTypescriptSources(workspaceRoot, relativeDirectory) {
  const absoluteDirectory = path.join(workspaceRoot, ...relativeDirectory.split('/'));
  const sources = [];
  for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const childRelative = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      sources.push(...collectTypescriptSources(workspaceRoot, childRelative));
    } else if (entry.isFile() && /\.tsx?$/u.test(entry.name)) {
      sources.push(readTextDefault(workspaceRoot, childRelative));
    }
  }
  return sources;
}

function readProductionSourcesDefault(workspaceRoot, relativeDirectories) {
  return relativeDirectories.flatMap((directory) => (
    collectTypescriptSources(workspaceRoot, directory)
  ));
}

function result(id, passed) {
  return Object.freeze({ id, status: passed ? 'PASS' : 'FAIL' });
}

export function assertSecurityChecklistResults(results) {
  if (!Array.isArray(results) || results.length !== SECURITY_CHECK_IDS.length) {
    throw new TypeError('Security checklist must contain the exact eight results.');
  }
  for (let index = 0; index < SECURITY_CHECK_IDS.length; index += 1) {
    const item = results[index];
    const keys = item && typeof item === 'object' ? Reflect.ownKeys(item) : [];
    const descriptors = item && typeof item === 'object'
      ? Object.getOwnPropertyDescriptors(item)
      : {};
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.getPrototypeOf(item) !== Object.prototype
      || keys.length !== 2
      || !keys.includes('id')
      || !keys.includes('status')
      || Object.values(descriptors).some((descriptor) => (
        !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
      ))
      || item.id !== SECURITY_CHECK_IDS[index]
      || (item.status !== 'PASS' && item.status !== 'FAIL')) {
      throw new TypeError('Security checklist result shape or order is invalid.');
    }
  }
  return results;
}

export async function runSecurityChecklist({ workspaceRoot, deps = {} }) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
    throw new TypeError('Security checklist workspace root is required.');
  }
  const readText = deps.readText ?? ((relativePath) => (
    readTextDefault(workspaceRoot, relativePath)
  ));
  const readProductionSources = deps.readProductionSources ?? ((relativeDirectories) => (
    readProductionSourcesDefault(workspaceRoot, relativeDirectories)
  ));

  const settingsSource = readText(FIXED_SOURCE_PATHS.settings);
  const mainSource = readText(FIXED_SOURCE_PATHS.main);
  const singleInstanceSource = readText(FIXED_SOURCE_PATHS.singleInstance);
  const builderConfig = readText(FIXED_SOURCE_PATHS.builder);
  const mutationSources = readProductionSources(MUTATION_SOURCE_DIRECTORIES).join('\n');

  const results = [
    result(SECURITY_CHECK_IDS[0], /defaultPermissionMode:\s*'standard'/u.test(settingsSource)),
    result(SECURITY_CHECK_IDS[1], /nodeIntegration:\s*false/u.test(mainSource)),
    result(SECURITY_CHECK_IDS[2], /contextIsolation:\s*true/u.test(mainSource)),
    result(SECURITY_CHECK_IDS[3], /sandbox:\s*true/u.test(mainSource)),
    result(SECURITY_CHECK_IDS[4], /installSingleInstanceGuard/u.test(mainSource)
      && /requestSingleInstanceLock/u.test(singleInstanceSource)),
    result(SECURITY_CHECK_IDS[5], /requestedExecutionLevel:\s*asInvoker/u.test(builderConfig)),
    result(SECURITY_CHECK_IDS[6], /CSC_LINK\/CSC_KEY_PASSWORD/u.test(builderConfig)),
    result(SECURITY_CHECK_IDS[7], !/(?:reset.{0,40}--hard|clean.{0,40}(?:-f|--force)|push.{0,40}--force)/isu
      .test(mutationSources)),
  ];
  assertSecurityChecklistResults(results);
  return Object.freeze(results);
}
