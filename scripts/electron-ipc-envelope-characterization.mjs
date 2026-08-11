import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { CdpClient, waitForCdpPage } from './lib/cdp-client.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(SCRIPT_DIR, '..');
const TEMP_PREFIX = 'claude-workbench-ipc-envelope-characterization-';
const ACCEPTANCE_FLAG = '--cw-ipc-envelope-characterization=';
const TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT_BYTES = 1024 * 1024;
const FIXED_ERROR = Object.freeze({
  code: 'PATH_NOT_ALLOWED',
  message: 'Requested path is not allowed.',
  stack: 'Error: Requested path is not allowed.',
});
const RENDERER_PROBE_GATE_ERROR_TYPES = Object.freeze({
  runtime_enable: 'operation_rejected',
  page_enable: 'operation_rejected',
  ready_wait: 'operation_rejected',
  evaluate: 'operation_rejected',
  fact_schema: 'fact_schema_invalid',
  fact_assert: 'fact_assertion_failed',
  client_close: 'client_close_failed',
});
const RENDERER_ERROR_OWN_KEY_BITS = Object.freeze({
  message: 1,
  stack: 2,
  code: 4,
  cause: 8,
  extra: 16,
});
const ELECTRON_LAUNCH_GATE_ERROR_TYPES = Object.freeze({
  prerequisite: 'prerequisite_invalid',
  spawn: 'spawn_failed',
  output_bind: 'output_bind_failed',
  preliminary_transfer: 'ownership_transfer_failed',
  process_bind: 'process_identity_failed',
  devtools_wait: 'devtools_unavailable',
  output_health: 'output_unhealthy',
  devtools_file_validate: 'devtools_file_invalid',
  port_parse: 'port_invalid',
  page_wait: 'page_unavailable',
  target_validate: 'target_invalid',
  cdp_connect: 'cdp_connect_failed',
});
const ELECTRON_LAUNCH_PROGRESS_BY_GATE = Object.freeze({
  prerequisite: Object.freeze(['000000']),
  spawn: Object.freeze(['000000']),
  output_bind: Object.freeze(['000000']),
  preliminary_transfer: Object.freeze(['000000']),
  process_bind: Object.freeze(['000000']),
  devtools_wait: Object.freeze(['000000', '100000']),
  output_health: Object.freeze(['000000', '010000']),
  devtools_file_validate: Object.freeze(['110000']),
  port_parse: Object.freeze(['110000']),
  page_wait: Object.freeze(['111000']),
  target_validate: Object.freeze(['111100']),
  cdp_connect: Object.freeze(['111110']),
});
const BACKEND_ENVIRONMENT_KEYS = Object.freeze([
  'FORCE_FAKE',
  'WORKBENCH_FORCE_FAKE_CLAUDE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ROLE_ARN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_API_KEY',
  'VERTEX_API_KEY',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_VERTEX_REGION',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'AZURE_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_TENANT_ID',
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_ENABLE_LOGGING',
  'ELECTRON_ENABLE_STACK_DUMPING',
  'NODE_OPTIONS',
  'VITE_DEV_SERVER_URL',
  'WORKBENCH_OPEN_DEVTOOLS',
]);
const OWNED_ENVIRONMENT_KEYS = Object.freeze([
  'NODE_ENV', 'WORKBENCH_DATA_DIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'TEMP', 'TMP', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY',
  'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING', 'DISABLE_AUTOUPDATER',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
]);
const OWNED_TEMP_ROOTS = new Set();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} is invalid.`);
  const actual = Reflect.ownKeys(value);
  assert(actual.length === expected.length && expected.every((key) => actual.includes(key)),
    `${label} keys are invalid.`);
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32'
    ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US')
    : a === b;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function rendererObservationFrom(value) {
  return {
    schemaVersion: value.schemaVersion,
    apiPresent: value.apiPresent,
    successSettled: value.successSettled,
    successRejected: value.successRejected,
    successUndefined: value.successUndefined,
    rejectSettled: value.rejectSettled,
    rejectFulfilled: value.rejectFulfilled,
    rejectIsError: value.rejectIsError,
    codeExact: value.codeExact,
    messageExact: value.messageExact,
    stackExact: value.stackExact,
    ownKeyMask: value.ownKeyMask,
    causeAbsent: value.causeAbsent,
  };
}

function assertRendererObservationFact(fact) {
  exactKeys(fact, [
    'schemaVersion', 'apiPresent', 'successSettled', 'successRejected', 'successUndefined',
    'rejectSettled', 'rejectFulfilled', 'rejectIsError', 'codeExact', 'messageExact',
    'stackExact', 'ownKeyMask', 'causeAbsent',
  ], 'Renderer characterization fact');
  assert(fact.schemaVersion === 1 && [
    'apiPresent', 'successSettled', 'successRejected', 'successUndefined', 'rejectSettled',
    'rejectFulfilled', 'rejectIsError', 'codeExact', 'messageExact', 'stackExact', 'causeAbsent',
  ].every((key) => typeof fact[key] === 'boolean')
    && Number.isSafeInteger(fact.ownKeyMask) && fact.ownKeyMask >= 0 && fact.ownKeyMask <= 31,
  'Renderer characterization fact schema failed.');
  assert((fact.successSettled || (!fact.successRejected && !fact.successUndefined))
    && (!fact.successRejected || (fact.successSettled && !fact.successUndefined))
    && (!fact.successUndefined || (fact.successSettled && !fact.successRejected))
    && (fact.rejectSettled || (!fact.rejectFulfilled && !fact.rejectIsError
      && !fact.codeExact && !fact.messageExact && !fact.stackExact
      && fact.ownKeyMask === 0 && !fact.causeAbsent))
    && (!fact.rejectFulfilled || (fact.rejectSettled && !fact.rejectIsError
      && !fact.codeExact && !fact.messageExact && !fact.stackExact
      && fact.ownKeyMask === 0 && !fact.causeAbsent))
    && (!(fact.rejectIsError || fact.codeExact || fact.messageExact || fact.stackExact
      || fact.ownKeyMask !== 0 || fact.causeAbsent) || (fact.rejectSettled && !fact.rejectFulfilled))
    && (fact.apiPresent || (!fact.successSettled && !fact.rejectSettled)),
  'Renderer characterization outcome combination is invalid.');
  return true;
}

function assertRendererFact(fact) {
  assertRendererObservationFact(fact);
  assert(fact.apiPresent === true && fact.successSettled === true && fact.successRejected === false
    && fact.successUndefined === true && fact.rejectSettled === true
    && fact.rejectFulfilled === false && fact.rejectIsError === true && fact.codeExact === true
    && fact.messageExact === true && fact.stackExact === true
    && fact.ownKeyMask === (RENDERER_ERROR_OWN_KEY_BITS.message
      | RENDERER_ERROR_OWN_KEY_BITS.stack | RENDERER_ERROR_OWN_KEY_BITS.code)
    && fact.causeAbsent === true,
  'Renderer characterization fact failed.');
  return true;
}

function assertRendererProbeFailureFact(fact) {
  exactKeys(fact, [
    'schemaVersion', 'apiPresent', 'successSettled', 'successRejected', 'successUndefined',
    'rejectSettled', 'rejectFulfilled', 'rejectIsError', 'codeExact', 'messageExact',
    'stackExact', 'ownKeyMask', 'causeAbsent', 'gate', 'errorType', 'clientCloseAttempted',
    'clientCloseFailed',
  ], 'Renderer probe failure fact');
  assertRendererObservationFact(rendererObservationFrom(fact));
  assert(Object.prototype.hasOwnProperty.call(RENDERER_PROBE_GATE_ERROR_TYPES, fact.gate)
    && RENDERER_PROBE_GATE_ERROR_TYPES[fact.gate] === fact.errorType
    && fact.clientCloseAttempted === true && typeof fact.clientCloseFailed === 'boolean'
    && (fact.gate !== 'client_close' || fact.clientCloseFailed === true),
  'Renderer probe failure classification is invalid.');
  return true;
}

function formatRendererProbeFailureFact(fact) {
  assertRendererProbeFailureFact(fact);
  return JSON.stringify(fact);
}

function assertElectronLaunchFailureFact(fact) {
  exactKeys(fact, [
    'schemaVersion', 'gate', 'errorType', 'childExited', 'outputHealthy',
    'devtoolsObserved', 'portValid', 'pageObserved', 'targetValid', 'clientConnected',
    'cleanupAttempted', 'cleanupFailed', 'finalStopAttempted', 'finalStopFailed',
    'outputHealthChecked', 'outputHealthFailed', 'outputPrivacyChecked', 'outputPrivacyFailed',
  ], 'Electron launch failure fact');
  assert(fact.schemaVersion === 1
    && Object.prototype.hasOwnProperty.call(ELECTRON_LAUNCH_GATE_ERROR_TYPES, fact.gate)
    && ELECTRON_LAUNCH_GATE_ERROR_TYPES[fact.gate] === fact.errorType
    && [
      'childExited', 'outputHealthy', 'devtoolsObserved', 'portValid', 'pageObserved',
      'targetValid', 'clientConnected', 'cleanupAttempted', 'cleanupFailed',
      'finalStopAttempted', 'finalStopFailed', 'outputHealthChecked', 'outputHealthFailed',
      'outputPrivacyChecked', 'outputPrivacyFailed',
    ].every((key) => typeof fact[key] === 'boolean'),
  'Electron launch failure fact schema is invalid.');
  const progressSignature = [
    fact.outputHealthy,
    fact.devtoolsObserved,
    fact.portValid,
    fact.pageObserved,
    fact.targetValid,
    fact.clientConnected,
  ].map((value) => (value ? '1' : '0')).join('');
  const ownsSpawnedChild = !['prerequisite', 'spawn'].includes(fact.gate);
  assert((!fact.cleanupFailed || fact.cleanupAttempted)
    && (!fact.finalStopFailed || fact.finalStopAttempted)
    && (!fact.outputHealthFailed || fact.outputHealthChecked)
    && (!fact.outputPrivacyFailed || fact.outputPrivacyChecked)
    && ELECTRON_LAUNCH_PROGRESS_BY_GATE[fact.gate].includes(progressSignature)
    && fact.cleanupAttempted === ownsSpawnedChild
    && (ownsSpawnedChild || fact.childExited === false),
  'Electron launch failure fact combination is invalid.');
  return true;
}

function formatElectronLaunchFailureFact(fact) {
  assertElectronLaunchFailureFact(fact);
  return JSON.stringify(fact);
}

async function collectLaunchFinalCleanupEvidence(controls = {}) {
  const evidence = {
    finalStopAttempted: false,
    finalStopFailed: false,
    outputHealthChecked: false,
    outputHealthFailed: false,
    outputPrivacyChecked: false,
    outputPrivacyFailed: false,
  };
  if (typeof controls.stop === 'function') {
    evidence.finalStopAttempted = true;
    try { await controls.stop(); } catch { evidence.finalStopFailed = true; }
  }
  if (typeof controls.checkOutputHealth === 'function') {
    evidence.outputHealthChecked = true;
    try { await controls.checkOutputHealth(); } catch { evidence.outputHealthFailed = true; }
  }
  if (typeof controls.checkOutputPrivacy === 'function') {
    evidence.outputPrivacyChecked = true;
    try { await controls.checkOutputPrivacy(); } catch { evidence.outputPrivacyFailed = true; }
  }
  return evidence;
}

function finalizeElectronLaunchFailureFact(primaryFact, finalEvidence) {
  assertElectronLaunchFailureFact(primaryFact);
  exactKeys(finalEvidence, [
    'finalStopAttempted', 'finalStopFailed', 'outputHealthChecked', 'outputHealthFailed',
    'outputPrivacyChecked', 'outputPrivacyFailed',
  ], 'Electron launch final cleanup evidence');
  const combined = { ...primaryFact, ...finalEvidence };
  assertElectronLaunchFailureFact(combined);
  return Object.freeze(combined);
}

function buildRendererProbeExpression(sentinelPath) {
  assert(typeof sentinelPath === 'string' && path.isAbsolute(sentinelPath)
    && sentinelPath.length <= 4096 && !sentinelPath.includes('\0'),
  'Renderer sentinel path is invalid.');
  return `(async () => {
    const fact = {
      schemaVersion: 1,
      apiPresent: Boolean(window.api)
        && typeof window.api.openPath === 'function'
        && typeof window.api.setFirstRunCompletedVersion === 'function',
      successSettled: false,
      successRejected: false,
      successUndefined: false,
      rejectSettled: false,
      rejectFulfilled: false,
      rejectIsError: false,
      codeExact: false,
      messageExact: false,
      stackExact: false,
      ownKeyMask: 0,
      causeAbsent: false,
    };
    if (!fact.apiPresent) return fact;
    try {
      fact.successUndefined = (await window.api.setFirstRunCompletedVersion(1)) === undefined;
    } catch {
      fact.successRejected = true;
    } finally {
      fact.successSettled = true;
    }
    try {
      await window.api.openPath(${JSON.stringify(sentinelPath)});
      fact.rejectFulfilled = true;
    } catch (error) {
      try {
        const object = Object(error);
        fact.rejectIsError = error instanceof Error;
        fact.codeExact = error?.code === ${JSON.stringify(FIXED_ERROR.code)};
        fact.messageExact = error?.message === ${JSON.stringify(FIXED_ERROR.message)};
        fact.stackExact = error?.stack === ${JSON.stringify(FIXED_ERROR.stack)};
        for (const key of Reflect.ownKeys(object)) {
          if (key === 'message') fact.ownKeyMask |= ${RENDERER_ERROR_OWN_KEY_BITS.message};
          else if (key === 'stack') fact.ownKeyMask |= ${RENDERER_ERROR_OWN_KEY_BITS.stack};
          else if (key === 'code') fact.ownKeyMask |= ${RENDERER_ERROR_OWN_KEY_BITS.code};
          else if (key === 'cause') fact.ownKeyMask |= ${RENDERER_ERROR_OWN_KEY_BITS.cause};
          else fact.ownKeyMask |= ${RENDERER_ERROR_OWN_KEY_BITS.extra};
        }
        fact.causeAbsent = !Object.prototype.hasOwnProperty.call(object, 'cause');
      } catch {
        // Introspection failure remains a closed all-false/mask observation.
      }
    } finally {
      fact.rejectSettled = true;
    }
    return fact;
  })()`;
}

function privateValueVariants(value) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= 8192 && !value.includes('\0'),
    'Restricted output value is invalid.');
  const variants = new Set([
    value,
    value.replaceAll('\\', '/'),
    value.replaceAll('/', '\\'),
    JSON.stringify(value).slice(1, -1),
  ]);
  return [...variants].map((item) => item.toLocaleLowerCase('en-US'));
}

function scanOutputEvidence(streams, restrictedValues) {
  assert(Array.isArray(streams) && streams.length === 2 && streams.every(Buffer.isBuffer),
    'Characterization output streams are invalid.');
  assert(Array.isArray(restrictedValues) && restrictedValues.length > 0
    && restrictedValues.length <= 32,
  'Restricted output values are invalid.');
  let privateMatchCount = 0;
  let handlerErrorMarkerCount = 0;
  for (const stream of streams) {
    assert(stream.length <= OUTPUT_LIMIT_BYTES, 'Characterization output exceeds the byte limit.');
    const text = stream.toString('utf8');
    const folded = text.toLocaleLowerCase('en-US');
    for (const value of restrictedValues) {
      if (privateValueVariants(value).some((variant) => folded.includes(variant))) {
        privateMatchCount += 1;
      }
    }
    handlerErrorMarkerCount += (text.match(/Error occurred in handler\b/gu) ?? []).length;
  }
  return {
    schemaVersion: 1,
    streamCount: streams.length,
    privateMatchCount,
    handlerErrorMarkerCount,
  };
}

function buildChildEnvironment(base, fixture) {
  const denied = new Set([
    ...BACKEND_ENVIRONMENT_KEYS,
    ...OWNED_ENVIRONMENT_KEYS,
  ].map((key) => key.toUpperCase()));
  const environment = {
    ...Object.fromEntries(Object.entries(base)
      .filter(([key]) => !denied.has(key.toUpperCase()))),
    NODE_ENV: 'production',
    WORKBENCH_DATA_DIR: fixture.dataRoot,
    HOME: fixture.profileRoot,
    USERPROFILE: fixture.profileRoot,
    APPDATA: fixture.appData,
    LOCALAPPDATA: fixture.localAppData,
    TEMP: fixture.runtimeTemp,
    TMP: fixture.runtimeTemp,
    XDG_CONFIG_HOME: path.join(fixture.profileRoot, '.config'),
    CLAUDE_CONFIG_DIR: fixture.claudeConfigRoot,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost',
  };
  return environment;
}

function mixedCaseEnvironmentKey(key) {
  const index = [...key].findIndex((character) => character >= 'A' && character <= 'Z');
  assert(index >= 0, 'Environment key has no case alias.');
  return `${key.slice(0, index)}${key[index].toLowerCase()}${key.slice(index + 1)}`;
}

function assertChildEnvironmentCatalogIsolation(fixture) {
  const inherited = {};
  for (const key of [...BACKEND_ENVIRONMENT_KEYS, ...OWNED_ENVIRONMENT_KEYS]) {
    inherited[key] = 'private-exact-value';
    inherited[mixedCaseEnvironmentKey(key)] = 'private-case-alias-value';
  }
  const environment = buildChildEnvironment(inherited, fixture);
  const outputKeys = Object.keys(environment);
  for (const key of BACKEND_ENVIRONMENT_KEYS) {
    assert(outputKeys.filter((candidate) => candidate.toUpperCase() === key).length === 0,
      'Child environment retained a backend catalog key.');
  }
  const expectedOwnedValues = {
    NODE_ENV: 'production',
    WORKBENCH_DATA_DIR: fixture.dataRoot,
    HOME: fixture.profileRoot,
    USERPROFILE: fixture.profileRoot,
    APPDATA: fixture.appData,
    LOCALAPPDATA: fixture.localAppData,
    TEMP: fixture.runtimeTemp,
    TMP: fixture.runtimeTemp,
    XDG_CONFIG_HOME: path.join(fixture.profileRoot, '.config'),
    CLAUDE_CONFIG_DIR: fixture.claudeConfigRoot,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost',
  };
  exactKeys(expectedOwnedValues, [...OWNED_ENVIRONMENT_KEYS], 'Owned environment catalog');
  for (const key of OWNED_ENVIRONMENT_KEYS) {
    const matches = outputKeys.filter((candidate) => candidate.toUpperCase() === key);
    assert(matches.length === 1 && matches[0] === key
      && environment[key] === expectedOwnedValues[key],
    'Child environment did not replace an owned catalog key exactly once.');
  }
  return true;
}

function assertResidualFact(fact) {
  exactKeys(fact, ['schemaVersion', 'taggedProcessCount', 'tempRootCount', 'listenerCount'],
    'Cleanup residual fact');
  for (const key of ['taggedProcessCount', 'tempRootCount', 'listenerCount']) {
    assert(Number.isSafeInteger(fact[key]) && fact[key] === 0, 'Cleanup residual count is invalid.');
  }
  assert(fact.schemaVersion === 1, 'Cleanup residual schema is invalid.');
  return true;
}

function assertOutputEvidence(fact) {
  exactKeys(fact, ['schemaVersion', 'streamCount', 'privateMatchCount', 'handlerErrorMarkerCount'],
    'Characterization output evidence');
  assert(fact.schemaVersion === 1 && fact.streamCount === 2
    && fact.privateMatchCount === 0 && fact.handlerErrorMarkerCount === 0,
  'Characterization output privacy failed.');
  return true;
}

function assertOrdinaryDirectory(target, label) {
  const stats = fs.lstatSync(target);
  assert(stats.isDirectory() && !stats.isSymbolicLink(), `${label} is not an ordinary directory.`);
}

function countOwnedTempRoots() {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  assertOrdinaryDirectory(tempRoot, 'System temporary root');
  return fs.readdirSync(tempRoot, { withFileTypes: true })
    .filter((entry) => entry.name.startsWith(TEMP_PREFIX)).length;
}

function createFixture(controls = {}) {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  assertOrdinaryDirectory(tempRoot, 'System temporary root');
  const root = fs.mkdtempSync(path.join(tempRoot, TEMP_PREFIX));
  const fixture = {
    root,
    dataRoot: path.join(root, 'workbench-data'),
    browserRoot: path.join(root, 'chromium-user-data'),
    appData: path.join(root, 'app-data'),
    localAppData: path.join(root, 'local-app-data'),
    runtimeTemp: path.join(root, 'runtime-temp'),
    claudeConfigRoot: path.join(root, 'claude-config'),
    profileRoot: path.join(root, 'profile'),
  };
  OWNED_TEMP_ROOTS.add(root);
  const transferOwnership = controls.transferOwnership ?? (() => undefined);
  const mkdir = controls.mkdir ?? ((directory) => fs.mkdirSync(directory));
  try {
    transferOwnership(fixture);
    for (const [index, directory] of Object.values(fixture).slice(1).entries()) {
      mkdir(directory, index);
      assertOrdinaryDirectory(directory, 'Owned fixture directory');
    }
  } catch (error) {
    try { removeFixture(root); } catch { /* outer transferred owner remains authoritative */ }
    throw error;
  }
  return fixture;
}

function validateOwnedFixtureRoot(root) {
  assert(typeof root === 'string' && path.isAbsolute(root), 'Owned fixture root is invalid.');
  const resolved = path.resolve(root);
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  assert(OWNED_TEMP_ROOTS.has(resolved)
    && samePath(path.dirname(resolved), tempRoot)
    && path.basename(resolved).startsWith(TEMP_PREFIX)
    && path.basename(resolved).length > TEMP_PREFIX.length,
  'Owned fixture root escaped the exact temporary boundary.');
  if (fs.existsSync(resolved)) assertOrdinaryDirectory(resolved, 'Owned fixture root');
  return resolved;
}

function assertOwnedTreeHasNoReparseEntries(root) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const stats = fs.lstatSync(current);
    assert(!stats.isSymbolicLink() && samePath(fs.realpathSync.native(current), current),
      'Owned fixture tree contains a symbolic or reparse entry.');
    if (!stats.isDirectory()) continue;
    for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
  }
  return true;
}

function removeFixture(root) {
  const target = validateOwnedFixtureRoot(root);
  if (!fs.existsSync(target)) {
    OWNED_TEMP_ROOTS.delete(target);
    return true;
  }
  assertOwnedTreeHasNoReparseEntries(target);
  fs.rmSync(target, { recursive: true, force: false, maxRetries: 5, retryDelay: 50 });
  assert(!fs.existsSync(target), 'Owned fixture root remains after cleanup.');
  OWNED_TEMP_ROOTS.delete(target);
  return true;
}

function runOwnedJunctionCleanupEvidence(controls = {}) {
  const transferOwnership = controls.transferOwnership ?? (() => undefined);
  const mkdir = controls.mkdir ?? ((directory) => fs.mkdirSync(directory));
  const createJunction = controls.createJunction
    ?? ((target, link) => fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'));
  assert(typeof transferOwnership === 'function' && typeof mkdir === 'function'
    && typeof createJunction === 'function', 'Junction cleanup evidence controls are invalid.');
  const fixture = createFixture({ transferOwnership });
  let link = null;
  try {
    const target = path.join(fixture.root, 'ordinary-target');
    link = path.join(fixture.root, 'junction');
    mkdir(target);
    createJunction(target, link);
    expectThrow(() => removeFixture(fixture.root));
    assert(fs.existsSync(fixture.root) && fs.existsSync(target),
      'Unsafe temp cleanup mutated the owned tree.');
    return true;
  } finally {
    try {
      if (link && fs.existsSync(link)) fs.unlinkSync(link);
    } finally {
      if (fs.existsSync(fixture.root)) removeFixture(fixture.root);
    }
  }
}

function escapePowerShellLiteral(value) {
  return String(value).replaceAll("'", "''");
}

function countTaggedProcesses(token = null, browserRoot = null) {
  if (process.platform !== 'win32') return 0;
  const exactToken = token === null ? null : String(token);
  const exactBrowserRoot = browserRoot === null ? null : String(browserRoot);
  const predicate = exactToken === null
    ? `$_.CommandLine.Contains('${escapePowerShellLiteral(ACCEPTANCE_FLAG)}')`
    : `($_.CommandLine.Contains('${escapePowerShellLiteral(exactToken)}') -or `
      + `$_.CommandLine.Contains('${escapePowerShellLiteral(exactBrowserRoot)}'))`;
  const script = `@((Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and `
    + `$null -ne $_.CommandLine -and ${predicate} })).Count`;
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script,
  ], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 5_000, maxBuffer: 64 * 1024 });
  assert(!result.error && result.status === 0 && result.signal === null,
    'Owned process residual query failed.');
  const count = Number(result.stdout.trim());
  assert(Number.isSafeInteger(count) && count >= 0 && count <= 4096,
    'Owned process residual count is invalid.');
  return count;
}

function readProcessIdentity(pid) {
  assert(process.platform === 'win32' && Number.isInteger(pid) && pid > 0,
    'Owned Electron PID is invalid.');
  const script = `$process=Get-Process -Id ${pid} -ErrorAction Stop;`
    + `$cim=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop;`
    + `if($null -eq $cim){throw 'missing'};`
    + `[pscustomobject]@{pid=[int]$cim.ProcessId;startTicks=[string]$process.StartTime.ToUniversalTime().Ticks;`
    + `executablePath=[string]$cim.ExecutablePath;commandLine=[string]$cim.CommandLine}|ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script,
  ], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 5_000, maxBuffer: 128 * 1024 });
  assert(!result.error && result.status === 0 && result.signal === null && result.stdout.trim(),
    'Owned Electron process identity is unavailable.');
  let record = null;
  try { record = JSON.parse(result.stdout); } catch { /* fixed failure below */ }
  exactKeys(record, ['pid', 'startTicks', 'executablePath', 'commandLine'],
    'Owned Electron process identity');
  return record;
}

const WINDOWS_COMMAND_LINE_ARGV_SCRIPT = String.raw`$ErrorActionPreference='Stop'
$utf8=New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding=$utf8
[Console]::OutputEncoding=$utf8
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class CwIpcCharacterizationCommandLine {
  [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern IntPtr CommandLineToArgvW(string commandLine, out int argc);

  [DllImport("kernel32.dll")]
  private static extern IntPtr LocalFree(IntPtr value);

  public static string[] Parse(string commandLine) {
    int argc;
    IntPtr native = CommandLineToArgvW(commandLine, out argc);
    if (native == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      string[] result = new string[argc];
      for (int index = 0; index < argc; index++) {
        IntPtr item = Marshal.ReadIntPtr(native, index * IntPtr.Size);
        result[index] = Marshal.PtrToStringUni(item) ?? string.Empty;
      }
      return result;
    } finally {
      LocalFree(native);
    }
  }
}
'@
$line=[Console]::In.ReadToEnd()
if([string]::IsNullOrWhiteSpace($line)){throw 'empty command line'}
$parsed=[CwIpcCharacterizationCommandLine]::Parse($line)
[Console]::Out.Write((ConvertTo-Json -Compress -InputObject @($parsed)))`;

function parseWindowsCommandLineExact(commandLine) {
  assert(process.platform === 'win32' && typeof commandLine === 'string' && commandLine.length > 0
    && Buffer.byteLength(commandLine, 'utf8') <= OUTPUT_LIMIT_BYTES && !commandLine.includes('\0'),
  'Owned Electron command line cannot be parsed safely.');
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
    '-Command', WINDOWS_COMMAND_LINE_ARGV_SCRIPT,
  ], {
    input: commandLine,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: 5_000,
    maxBuffer: 2 * OUTPUT_LIMIT_BYTES,
  });
  assert(!result.error && result.status === 0 && result.signal === null
    && !result.stderr.trim() && result.stdout.trim(),
  'Owned Electron command line parsing failed.');
  let argv = null;
  try { argv = JSON.parse(result.stdout); } catch { /* fixed failure below */ }
  assert(Array.isArray(argv) && argv.length > 0 && argv.every((item) => typeof item === 'string'),
    'Owned Electron command line arguments are invalid.');
  return argv;
}

function validateProcessIdentityRecord(instance, record, tokenize = parseWindowsCommandLineExact) {
  exactKeys(record, ['pid', 'startTicks', 'executablePath', 'commandLine'],
    'Owned Electron process identity');
  assert(record.pid === instance.child.pid
    && typeof record.startTicks === 'string' && /^\d+$/u.test(record.startTicks)
    && typeof record.executablePath === 'string' && path.isAbsolute(record.executablePath)
    && samePath(record.executablePath, instance.executablePath)
    && typeof record.commandLine === 'string' && record.commandLine.length > 0
    && !record.commandLine.includes('\0') && typeof tokenize === 'function',
  'Owned Electron process identity does not match the child.');
  const argv = tokenize(record.commandLine);
  const tagMentions = argv.filter((token) => token.includes('--cw-ipc-envelope-characterization'));
  assert(argv.length > 0 && samePath(argv[0], instance.executablePath)
    && tagMentions.length === 1 && tagMentions[0] === instance.acceptanceToken,
  'Owned Electron process tag is ambiguous or invalid.');
  assert(instance.startTicks === null || instance.startTicks === record.startTicks,
    'Owned Electron process start identity changed.');
  instance.startTicks = record.startTicks;
  return true;
}

async function bindProcessIdentity(instance, controls = {}) {
  const deadline = Date.now() + 5_000;
  let record = null;
  const readIdentity = controls.readIdentity ?? readProcessIdentity;
  const tokenize = controls.tokenize ?? parseWindowsCommandLineExact;
  while (Date.now() < deadline && instance.child.exitCode === null && instance.child.signalCode === null) {
    try {
      record = readIdentity(instance.child.pid);
      break;
    } catch {
      await delay(50);
    }
  }
  assert(record !== null, 'Owned Electron process identity is unavailable.');
  return validateProcessIdentityRecord(instance, record, tokenize);
}

function bindChildCloseDrain(child) {
  assert(child && typeof child.once === 'function', 'Electron child close binding is invalid.');
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function bindOutputCapture(child, closed = null) {
  assert(child && typeof child.once === 'function', 'Electron child output binding is invalid.');
  const closeBoundary = closed ?? bindChildCloseDrain(child);
  assert(closeBoundary && typeof closeBoundary.then === 'function',
    'Electron child close-drain boundary is invalid.');
  const state = {
    stdout: [],
    stderr: [],
    byteCount: 0,
    overflow: false,
    childError: false,
    stdoutError: false,
    stderrError: false,
    pipeUnavailable: !child.stdout || !child.stderr
      || typeof child.stdout.on !== 'function' || typeof child.stderr.on !== 'function',
  };
  const capture = (target) => (chunk) => {
    const buffer = Buffer.from(chunk);
    state.byteCount += buffer.length;
    if (state.byteCount <= OUTPUT_LIMIT_BYTES) target.push(buffer);
    else state.overflow = true;
  };
  child.once('error', () => { state.childError = true; });
  if (child.stdout && typeof child.stdout.on === 'function') {
    child.stdout.on('data', capture(state.stdout));
    child.stdout.on('error', () => { state.stdoutError = true; });
  }
  if (child.stderr && typeof child.stderr.on === 'function') {
    child.stderr.on('data', capture(state.stderr));
    child.stderr.on('error', () => { state.stderrError = true; });
  }
  return { state, closed: closeBoundary };
}

function assertOutputCaptureHealthy(output) {
  const state = output?.state;
  assert(state && state.pipeUnavailable === false && state.childError === false
    && state.stdoutError === false && state.stderrError === false && state.overflow === false,
  'Electron child output capture failed closed.');
  return true;
}

async function waitForPromise(promise, timeoutMs, controls = {}) {
  assert(promise && typeof promise.then === 'function'
    && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= TIMEOUT_MS,
  'Bounded wait is invalid.');
  const setTimer = controls.setTimer ?? setTimeout;
  const clearTimer = controls.clearTimer ?? clearTimeout;
  return new Promise((resolve) => {
    let finished = false;
    let timer = null;
    const finish = (settled, value) => {
      if (finished) return;
      finished = true;
      if (timer !== null) clearTimer(timer);
      resolve({ settled, value });
    };
    timer = setTimer(() => finish(false, null), timeoutMs);
    promise.then((value) => finish(true, value), () => finish(false, null));
  });
}

async function stopElectron(instance, controls = {}) {
  if (!instance || instance.stopped) return true;
  const waitForClose = controls.waitForClose ?? waitForPromise;
  const bindIdentity = controls.bindIdentity ?? bindProcessIdentity;
  const terminateTree = controls.terminateTree ?? ((pid) => (
    process.platform === 'win32'
      ? spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore', shell: false, timeout: 5_000,
      })
      : (() => {
        try { process.kill(pid, 'SIGTERM'); return { status: 0, error: null, signal: null }; }
        catch { return { status: 1, error: null, signal: null }; }
      })()
  ));
  if (instance.client) {
    try { await instance.client.evaluate('window.close()', { timeoutMs: 2_000 }); } catch { /* closed or blocked */ }
    try { instance.client.close(); } catch { /* already closed */ }
    instance.client = null;
  }
  if (!instance.outputClosed || typeof instance.outputClosed.then !== 'function') {
    instance.outputClosed = bindChildCloseDrain(instance.child);
  }
  let closeResult = await waitForClose(instance.outputClosed, 3_000);
  if (!closeResult.settled) {
    const alreadyExited = instance.child.exitCode !== null || instance.child.signalCode !== null;
    if (alreadyExited) {
      closeResult = await waitForClose(instance.outputClosed, 10_000);
      assert(closeResult.settled, 'Exited Electron output close timed out.');
    } else {
      await bindIdentity(instance);
      const termination = terminateTree(instance.child.pid);
      if (termination.error || termination.signal || termination.status !== 0) {
        closeResult = await waitForClose(instance.outputClosed, 2_000);
        assert(closeResult.settled, 'Owned Electron tree termination failed.');
      } else {
        closeResult = await waitForClose(instance.outputClosed, 10_000);
        assert(closeResult.settled, 'Owned Electron output close timed out.');
      }
    }
  }
  assert(closeResult.settled, 'Owned Electron output was not drained.');
  instance.stopped = true;
  return true;
}

async function isListenerOpen(port) {
  assert(Number.isInteger(port) && port > 0 && port <= 65535, 'Listener port is invalid.');
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function waitForListenerClose(port) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!await isListenerOpen(port)) return true;
    await delay(75);
  }
  return !await isListenerOpen(port);
}

async function closeOwnedLoopbackServer(server) {
  await new Promise((resolve, reject) => {
    try {
      server.close((error) => {
        if (error) reject(new Error('Owned loopback listener close failed.'));
        else resolve();
      });
    } catch {
      reject(new Error('Owned loopback listener close failed.'));
    }
  });
}

async function runLoopbackListenerEvidence(controls = {}) {
  const createServer = controls.createServer ?? (() => net.createServer());
  const openCheck = controls.isOpen ?? isListenerOpen;
  const closeCheck = controls.waitForClose ?? waitForListenerClose;
  assert(typeof createServer === 'function' && typeof openCheck === 'function'
    && typeof closeCheck === 'function', 'Loopback listener evidence controls are invalid.');
  const server = createServer();
  await new Promise((resolve, reject) => {
    const onError = () => reject(new Error('Owned loopback listener launch failed.'));
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  let address = null;
  try {
    address = server.address();
    assert(address && typeof address === 'object' && await openCheck(address.port),
      'Open loopback listener was not detected.');
  } finally {
    await closeOwnedLoopbackServer(server);
  }
  assert(await closeCheck(address.port), 'Closed loopback listener remained detectable.');
  return true;
}

function validateProductionCdpTarget(page, port, rendererFile) {
  assert(page !== null && typeof page === 'object' && page.type === 'page'
    && page.title === 'Claude Workbench'
    && Number.isInteger(port) && port > 0 && port <= 65535
    && typeof rendererFile === 'string' && path.isAbsolute(rendererFile),
  'Production CDP target identity is invalid.');
  let pageUrl = null;
  let webSocketUrl = null;
  try {
    pageUrl = new URL(page.url);
    webSocketUrl = new URL(page.webSocketDebuggerUrl);
  } catch {
    throw new Error('Production CDP endpoint URL is invalid.');
  }
  assert(pageUrl.protocol === 'file:' && pageUrl.username === '' && pageUrl.password === ''
    && pageUrl.host === '' && pageUrl.search === '' && pageUrl.hash === ''
    && samePath(fileURLToPath(pageUrl), rendererFile),
  'CDP page is not the exact production renderer.');
  assert(webSocketUrl.protocol === 'ws:' && webSocketUrl.hostname === '127.0.0.1'
    && Number(webSocketUrl.port) === port && webSocketUrl.username === '' && webSocketUrl.password === ''
    && webSocketUrl.search === '' && webSocketUrl.hash === ''
    && /^\/devtools\/page\/[a-z0-9-]+$/iu.test(webSocketUrl.pathname),
  'CDP WebSocket is not the exact loopback page endpoint.');
  return true;
}

function buildRestrictedOutputValues(fixture, secret, sentinelPath, workspaceRoot, realProfile) {
  const values = [
    secret,
    sentinelPath,
    fixture.root,
    fixture.dataRoot,
    fixture.browserRoot,
    workspaceRoot,
    realProfile,
  ];
  assert(values.every((value) => typeof value === 'string' && value.length > 0),
    'Restricted characterization values are invalid.');
  return [...new Set(values)];
}

function emptyElectronLaunchProgress() {
  return {
    childExited: false,
    outputHealthy: false,
    devtoolsObserved: false,
    portValid: false,
    pageObserved: false,
    targetValid: false,
    clientConnected: false,
    cleanupAttempted: false,
    cleanupFailed: false,
    finalStopAttempted: false,
    finalStopFailed: false,
    outputHealthChecked: false,
    outputHealthFailed: false,
    outputPrivacyChecked: false,
    outputPrivacyFailed: false,
  };
}

class ElectronLaunchClosedFailure extends Error {
  constructor(closedFact, ownedInstance) {
    assertElectronLaunchFailureFact(closedFact);
    super('Electron launch failed closed.');
    this.closedFact = Object.freeze({ ...closedFact });
    Object.defineProperty(this, 'ownedInstance', {
      configurable: false,
      enumerable: false,
      value: ownedInstance,
      writable: false,
    });
    this.stack = 'Error: Electron launch failed closed.';
  }
}

async function runElectronLaunchSequence(controls) {
  const required = [
    'prerequisite', 'spawnChild', 'bindClose', 'transferOwnership', 'bindOutput',
    'bindIdentity', 'waitForDevTools', 'assertOutput', 'validateDevToolsFile', 'parsePort',
    'waitForPage', 'validateTarget', 'connectClient', 'stopOwned',
  ];
  assert(controls !== null && typeof controls === 'object'
    && required.every((key) => typeof controls[key] === 'function'),
  'Electron launch controls are invalid.');
  const progress = emptyElectronLaunchProgress();
  let currentGate = 'prerequisite';
  let instance = null;
  try {
    currentGate = 'prerequisite';
    assert(typeof controls.acceptanceTag === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
        .test(controls.acceptanceTag)
      && controls.acceptanceToken === `${ACCEPTANCE_FLAG}${controls.acceptanceTag}`,
    'Electron launch acceptance identity is invalid.');
    const executablePath = await controls.prerequisite();

    currentGate = 'spawn';
    const child = controls.spawnChild(executablePath);
    assert(child && typeof child.once === 'function'
      && (typeof child.then !== 'function'),
    'Electron spawn did not synchronously return an owned child.');
    instance = {
      child,
      client: null,
      port: null,
      output: null,
      outputClosed: null,
      startTicks: null,
      acceptanceTag: controls.acceptanceTag,
      acceptanceToken: controls.acceptanceToken,
      executablePath,
      stopped: false,
    };

    currentGate = 'output_bind';
    const outputClosed = controls.bindClose(child);
    assert(outputClosed && typeof outputClosed.then === 'function',
      'Electron close-drain boundary is invalid.');
    instance.outputClosed = outputClosed;
    const output = controls.bindOutput(child, outputClosed);
    assert(output && output.state && output.closed === outputClosed,
      'Electron output binding did not retain the close-drain boundary.');
    instance.output = output;

    currentGate = 'preliminary_transfer';
    await controls.transferOwnership(instance);

    currentGate = 'process_bind';
    await controls.bindIdentity(instance);

    currentGate = 'devtools_wait';
    progress.devtoolsObserved = await controls.waitForDevTools(instance) === true;

    currentGate = 'output_health';
    await controls.assertOutput(instance.output);
    progress.outputHealthy = true;

    currentGate = 'devtools_wait';
    assert(progress.devtoolsObserved, 'Electron did not publish a bounded DevTools endpoint.');

    currentGate = 'devtools_file_validate';
    const portText = await controls.validateDevToolsFile(instance);

    currentGate = 'port_parse';
    const port = await controls.parsePort(portText);
    assert(Number.isInteger(port) && port > 0 && port <= 65535,
      'DevTools endpoint port is invalid.');
    progress.portValid = true;
    instance.port = port;

    currentGate = 'page_wait';
    const page = await controls.waitForPage(instance, port);
    assert(page !== null && typeof page === 'object', 'Production CDP page is unavailable.');
    progress.pageObserved = true;

    currentGate = 'target_validate';
    await controls.validateTarget(page, port);
    progress.targetValid = true;

    currentGate = 'cdp_connect';
    const client = await controls.connectClient(page, port);
    assert(client && typeof client.close === 'function', 'Electron CDP client is unavailable.');
    progress.clientConnected = true;
    instance.client = client;
    return instance;
  } catch {
    if (instance?.child) {
      progress.childExited = instance.child.exitCode !== null || instance.child.signalCode !== null;
      progress.cleanupAttempted = true;
      try { await controls.stopOwned(instance); } catch { progress.cleanupFailed = true; }
    }
    const fact = {
      schemaVersion: 1,
      gate: currentGate,
      errorType: ELECTRON_LAUNCH_GATE_ERROR_TYPES[currentGate],
      ...progress,
    };
    throw new ElectronLaunchClosedFailure(fact, instance);
  }
}

async function runOwnedLaunchReadiness(
  instance,
  transferOwnership,
  bindIdentity,
  readiness,
  stopOwned,
) {
  assert(instance && typeof transferOwnership === 'function' && typeof bindIdentity === 'function'
    && typeof readiness === 'function' && typeof stopOwned === 'function',
  'Owned Electron launch readiness controls are invalid.');
  transferOwnership(instance);
  try {
    await bindIdentity(instance);
    return await readiness(instance);
  } catch (error) {
    await stopOwned(instance);
    throw error;
  }
}

function emptyRendererObservation() {
  return {
    schemaVersion: 1,
    apiPresent: false,
    successSettled: false,
    successRejected: false,
    successUndefined: false,
    rejectSettled: false,
    rejectFulfilled: false,
    rejectIsError: false,
    codeExact: false,
    messageExact: false,
    stackExact: false,
    ownKeyMask: 0,
    causeAbsent: false,
  };
}

class RendererProbeClosedFailure extends Error {
  constructor(closedFact) {
    assertRendererProbeFailureFact(closedFact);
    super('Renderer probe failed closed.');
    this.closedFact = Object.freeze({ ...closedFact });
    this.stack = 'Error: Renderer probe failed closed.';
  }
}

async function runRendererProbe(client, sentinelPath) {
  assert(client && typeof client.send === 'function' && typeof client.waitFor === 'function'
    && typeof client.evaluate === 'function' && typeof client.close === 'function',
  'Renderer probe client is invalid.');
  let observation = emptyRendererObservation();
  let failureGate = null;
  let failureType = null;
  let currentGate = 'runtime_enable';
  let currentErrorType = RENDERER_PROBE_GATE_ERROR_TYPES[currentGate];
  let clientCloseAttempted = false;
  let clientCloseFailed = false;
  let cleanupGate = null;
  let cleanupErrorType = null;
  try {
    currentGate = 'runtime_enable';
    currentErrorType = RENDERER_PROBE_GATE_ERROR_TYPES[currentGate];
    await client.send('Runtime.enable');

    currentGate = 'page_enable';
    currentErrorType = RENDERER_PROBE_GATE_ERROR_TYPES[currentGate];
    await client.send('Page.enable');

    currentGate = 'ready_wait';
    currentErrorType = RENDERER_PROBE_GATE_ERROR_TYPES[currentGate];
    await client.waitFor(`document.readyState === 'complete' && Boolean(window.api)
      && typeof window.api.openPath === 'function'
      && typeof window.api.setFirstRunCompletedVersion === 'function'`, {
      description: 'production Workbench public API',
      timeoutMs: TIMEOUT_MS,
    });

    currentGate = 'evaluate';
    currentErrorType = RENDERER_PROBE_GATE_ERROR_TYPES[currentGate];
    const candidate = await client.evaluate(buildRendererProbeExpression(sentinelPath), {
      timeoutMs: TIMEOUT_MS,
    });

    currentGate = 'fact_schema';
    currentErrorType = RENDERER_PROBE_GATE_ERROR_TYPES[currentGate];
    assertRendererObservationFact(candidate);
    observation = candidate;

    currentGate = 'fact_assert';
    currentErrorType = RENDERER_PROBE_GATE_ERROR_TYPES[currentGate];
    assertRendererFact(observation);
  } catch {
    failureGate = currentGate;
    failureType = currentErrorType;
  } finally {
    clientCloseAttempted = true;
    cleanupGate = 'client_close';
    cleanupErrorType = RENDERER_PROBE_GATE_ERROR_TYPES[cleanupGate];
    try {
      client.close();
    } catch {
      clientCloseFailed = true;
      if (failureGate === null) {
        failureGate = cleanupGate;
        failureType = cleanupErrorType;
      }
    }
  }
  if (failureGate !== null) {
    throw new RendererProbeClosedFailure({
      ...observation,
      gate: failureGate,
      errorType: failureType,
      clientCloseAttempted,
      clientCloseFailed,
    });
  }
  return observation;
}

async function runOwnedRendererProbe(instance, sentinelPath) {
  assert(instance?.client, 'Owned renderer probe client is unavailable.');
  try {
    return await runRendererProbe(instance.client, sentinelPath);
  } finally {
    instance.client = null;
  }
}

async function launchElectron(fixture, transferOwnership) {
  const acceptanceTag = crypto.randomUUID();
  const acceptanceToken = `${ACCEPTANCE_FLAG}${acceptanceTag}`;
  const devToolsFile = path.join(fixture.browserRoot, 'DevToolsActivePort');
  return runElectronLaunchSequence({
    acceptanceTag,
    acceptanceToken,
    prerequisite: () => {
      const executablePath = path.resolve(electron.default || electron);
      assert(process.platform === 'win32' && path.isAbsolute(executablePath)
        && typeof transferOwnership === 'function',
      'Electron launch prerequisites are invalid.');
      const stats = fs.lstatSync(executablePath);
      assert(stats.isFile() && !stats.isSymbolicLink(),
        'Electron launch executable is invalid.');
      return executablePath;
    },
    spawnChild: (executablePath) => spawn(executablePath, [
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${fixture.browserRoot}`,
      acceptanceToken,
      '.',
    ], {
      cwd: WORKSPACE_ROOT,
      env: buildChildEnvironment(process.env, fixture),
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    transferOwnership,
    bindClose: bindChildCloseDrain,
    bindOutput: bindOutputCapture,
    bindIdentity: bindProcessIdentity,
    waitForDevTools: async (instance) => {
      const deadline = Date.now() + TIMEOUT_MS;
      while (!fs.existsSync(devToolsFile) && Date.now() < deadline
        && instance.child.exitCode === null && instance.child.signalCode === null
        && !instance.output.state.overflow && !instance.output.state.childError
        && !instance.output.state.stdoutError && !instance.output.state.stderrError) {
        await delay(50);
      }
      return fs.existsSync(devToolsFile);
    },
    assertOutput: assertOutputCaptureHealthy,
    validateDevToolsFile: () => {
      const stats = fs.lstatSync(devToolsFile);
      assert(stats.isFile() && !stats.isSymbolicLink() && stats.size > 0 && stats.size <= 4096,
        'DevTools endpoint file is invalid.');
      return fs.readFileSync(devToolsFile, 'utf8').split(/\r?\n/u)[0];
    },
    parsePort: (portText) => Number(portText),
    waitForPage: (instance, port) => waitForCdpPage(port, {
      timeoutMs: TIMEOUT_MS,
      processExited: () => instance.child.exitCode !== null || instance.child.signalCode !== null,
    }),
    validateTarget: (page, port) => validateProductionCdpTarget(
      page,
      port,
      path.join(WORKSPACE_ROOT, 'dist', 'renderer', 'index.html'),
    ),
    connectClient: (page) => CdpClient.connect(page.webSocketDebuggerUrl, TIMEOUT_MS),
    stopOwned: stopElectron,
  });
}

const selfTests = [];
function test(name, operation) {
  selfTests.push({ name, operation });
}

function expectThrow(operation) {
  let threw = false;
  try { operation(); } catch { threw = true; }
  assert(threw, 'Expected operation to fail closed.');
}

async function expectThrowAsync(operation) {
  let threw = false;
  try { await operation(); } catch { threw = true; }
  assert(threw, 'Expected async operation to fail closed.');
}

function validClosedRendererObservation() {
  return {
    schemaVersion: 1,
    apiPresent: true,
    successSettled: true,
    successRejected: false,
    successUndefined: true,
    rejectSettled: true,
    rejectFulfilled: false,
    rejectIsError: true,
    codeExact: true,
    messageExact: true,
    stackExact: true,
    ownKeyMask: 7,
    causeAbsent: true,
  };
}

async function captureRendererProbeClosedFailure(client) {
  try {
    await runRendererProbe(client, 'C:\\Users\\PrivateProfile\\characterization-private-path');
  } catch (error) {
    return error !== null && typeof error === 'object' && 'closedFact' in error
      ? error.closedFact
      : null;
  }
  return null;
}

async function captureElectronLaunchClosedFailure(controls) {
  try {
    await runElectronLaunchSequence(controls);
  } catch (error) {
    return error !== null && typeof error === 'object' && 'closedFact' in error
      ? error.closedFact
      : null;
  }
  return null;
}

function fakeLaunchControls(failureGate = null, cleanupFails = false) {
  const calls = [];
  const fail = (gate) => {
    calls.push(gate);
    if (failureGate === gate) throw new Error('fixed injected launch failure');
  };
  const child = new EventEmitter();
  child.pid = 901;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const output = {
    state: {
      stdout: [], stderr: [], byteCount: 0, overflow: false, childError: false,
      stdoutError: false, stderrError: false, pipeUnavailable: false,
    },
    closed: Promise.resolve({ code: 0, signal: null }),
  };
  return {
    calls,
    child,
    acceptanceTag: '11111111-1111-4111-8111-111111111111',
    acceptanceToken: `${ACCEPTANCE_FLAG}11111111-1111-4111-8111-111111111111`,
    fixture: { browserRoot: 'D:\\owned\\browser' },
    transferOwnership: () => fail('preliminary_transfer'),
    prerequisite: () => { fail('prerequisite'); return 'C:\\Electron\\electron.exe'; },
    spawnChild: () => { fail('spawn'); return child; },
    bindClose: () => output.closed,
    bindOutput: () => { fail('output_bind'); return output; },
    bindIdentity: async () => { fail('process_bind'); },
    waitForDevTools: async () => { fail('devtools_wait'); return true; },
    assertOutput: () => { fail('output_health'); return true; },
    validateDevToolsFile: () => { fail('devtools_file_validate'); return '43123'; },
    parsePort: () => { fail('port_parse'); return 43123; },
    waitForPage: async () => { fail('page_wait'); return { fixed: true }; },
    validateTarget: () => { fail('target_validate'); return true; },
    connectClient: async () => { fail('cdp_connect'); return { close: () => undefined }; },
    stopOwned: async () => {
      calls.push('cleanup');
      if (cleanupFails) throw new Error('fixed injected cleanup failure');
      return true;
    },
  };
}

test('renderer probe executes one fixed rejection and one undefined success', async () => {
  const sentinelPath = 'C:\\Users\\PrivateProfile\\characterization-private-path';
  const expression = buildRendererProbeExpression(sentinelPath);
  const localError = Object.assign(new Error(FIXED_ERROR.message), { code: FIXED_ERROR.code });
  localError.stack = FIXED_ERROR.stack;
  const fakeWindow = {
    api: {
      setFirstRunCompletedVersion: async () => undefined,
      openPath: async (received) => {
        assert(received === sentinelPath, 'Renderer probe changed the sentinel path.');
        throw localError;
      },
    },
  };
  const fact = await Function('window', `return ${expression}`)(fakeWindow);
  assertRendererFact(fact);
});

test('renderer fact rejects raw, extra, and negative evidence', () => {
  const valid = validClosedRendererObservation();
  assertRendererFact(valid);
  expectThrow(() => assertRendererFact({ ...valid, raw: 'private' }));
  expectThrow(() => assertRendererFact({ ...valid, stackExact: false }));
  expectThrow(() => assertRendererFact({ ...valid, ownKeyMask: -1 }));
});

test('output scan counts private variants and Electron handler markers without retaining raw text', () => {
  const privatePath = 'C:\\Users\\PrivateProfile\\characterization-private-path';
  const secret = 'characterization-private-secret';
  const fact = scanOutputEvidence([
    Buffer.from('safe stdout', 'utf8'),
    Buffer.from(`${privatePath.toUpperCase()}\nError occurred in handler for 'system:open-path': ${secret}`, 'utf8'),
  ], [privatePath, secret]);
  exactKeys(fact, ['schemaVersion', 'streamCount', 'privateMatchCount', 'handlerErrorMarkerCount'],
    'Output evidence');
  assert(fact.schemaVersion === 1 && fact.streamCount === 2
    && fact.privateMatchCount === 2 && fact.handlerErrorMarkerCount === 1,
  'Output evidence did not detect the private boundary violation.');
});

test('child environment isolates app state and removes inherited backend authority', () => {
  const fixture = {
    dataRoot: 'D:\\owned\\data', browserRoot: 'D:\\owned\\browser', appData: 'D:\\owned\\appdata',
    localAppData: 'D:\\owned\\local', runtimeTemp: 'D:\\owned\\temp', claudeConfigRoot: 'D:\\owned\\claude',
    profileRoot: 'D:\\owned\\profile',
  };
  const environment = buildChildEnvironment({
    FORCE_FAKE: '1',
    ANTHROPIC_API_KEY: 'private',
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_PROFILE: 'private',
    GOOGLE_CLOUD_PROJECT: 'private',
    ANTHROPIC_FOUNDRY_API_KEY: 'private',
    AZURE_CLIENT_SECRET: 'private',
    ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: '--private',
    VITE_DEV_SERVER_URL: 'http://private',
    WORKBENCH_OPEN_DEVTOOLS: '1',
    force_fake: '1',
    Anthropic_Api_Key: 'private',
    claude_code_use_vertex: '1',
    Aws_Profile: 'private',
    google_cloud_project: 'private',
    anthropic_foundry_api_key: 'private',
    azure_client_secret: 'private',
    electron_run_as_node: '1',
    Node_Options: '--private',
    vite_dev_server_url: 'http://private',
    workbench_open_devtools: '1',
  }, fixture);
  assert(environment.WORKBENCH_DATA_DIR === fixture.dataRoot
    && environment.APPDATA === fixture.appData && environment.LOCALAPPDATA === fixture.localAppData
    && environment.TEMP === fixture.runtimeTemp && environment.TMP === fixture.runtimeTemp
    && environment.CLAUDE_CONFIG_DIR === fixture.claudeConfigRoot
    && environment.HOME === fixture.profileRoot && environment.USERPROFILE === fixture.profileRoot,
  'Child environment isolation is incomplete.');
  for (const key of [
    'FORCE_FAKE', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'AWS_PROFILE',
    'GOOGLE_CLOUD_PROJECT', 'ANTHROPIC_FOUNDRY_API_KEY', 'AZURE_CLIENT_SECRET',
    'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'VITE_DEV_SERVER_URL', 'WORKBENCH_OPEN_DEVTOOLS',
  ]) {
    assert(environment[key] === undefined, 'Child environment retained inherited backend authority.');
  }
  const denied = new Set(BACKEND_ENVIRONMENT_KEYS.map((key) => key.toUpperCase()));
  assert(!Object.keys(environment).some((key) => denied.has(key.toUpperCase())),
    'Child environment retained a mixed-case backend authority key.');
});

test('child environment scrubs every backend and owned key across case aliases', () => {
  assertChildEnvironmentCatalogIsolation({
    dataRoot: 'D:\\owned\\data', browserRoot: 'D:\\owned\\browser', appData: 'D:\\owned\\appdata',
    localAppData: 'D:\\owned\\local', runtimeTemp: 'D:\\owned\\temp',
    claudeConfigRoot: 'D:\\owned\\claude', profileRoot: 'D:\\owned\\profile',
  });
});

test('process identity requires one exact argv token and rejects embedded or rogue tags', () => {
  const executablePath = 'C:\\Program Files\\Electron\\electron.exe';
  const acceptanceToken = `${ACCEPTANCE_FLAG}11111111-1111-4111-8111-111111111111`;
  const instance = {
    child: { pid: 702 }, executablePath, acceptanceToken, startTicks: null,
  };
  const record = {
    pid: 702,
    startTicks: '70200',
    executablePath,
    commandLine: 'fixed-command-line',
  };
  assert(validateProcessIdentityRecord(instance, record,
    () => [executablePath, acceptanceToken, '.']) === true,
  'Exact owned process argv was rejected.');
  for (const argv of [
    [executablePath, acceptanceToken, `${acceptanceToken}.rogue`, '.'],
    [executablePath, `embedded-${acceptanceToken}`, '.'],
    [executablePath, '--cw-ipc-envelope-characterization', '.'],
    [executablePath, `${ACCEPTANCE_FLAG}22222222-2222-4222-8222-222222222222`, '.'],
  ]) {
    expectThrow(() => validateProcessIdentityRecord({ ...instance, startTicks: null }, record, () => argv));
  }
});

test('Windows command-line parser preserves exact quoted argv tokens', () => {
  if (process.platform !== 'win32') return;
  const argv = parseWindowsCommandLineExact(
    '"C:\\Program Files\\Electron\\electron.exe" --fixed "value with space"',
  );
  assert(JSON.stringify(argv) === JSON.stringify([
    'C:\\Program Files\\Electron\\electron.exe', '--fixed', 'value with space',
  ]), 'Windows command-line parser changed exact arguments.');
});

test('launch readiness transfers ownership before binding and cleans a bind failure', async () => {
  const order = [];
  const owned = { child: { pid: 703 } };
  let outer = null;
  await expectThrowAsync(() => runOwnedLaunchReadiness(
    owned,
    (instance) => { outer = instance; order.push('transfer'); },
    async () => { order.push('bind'); throw new Error('fixed bind failure'); },
    async () => { order.push('ready'); },
    async () => { order.push('stop'); return true; },
  ));
  assert(outer === owned && JSON.stringify(order) === JSON.stringify(['transfer', 'bind', 'stop']),
    'Launch bind failure escaped preliminary cleanup ownership.');
});

test('CDP target binds the exact production file and loopback WebSocket endpoint', () => {
  const rendererFile = path.join(WORKSPACE_ROOT, 'dist', 'renderer', 'index.html');
  const port = 43123;
  const valid = {
    title: 'Claude Workbench',
    type: 'page',
    url: new URL(`file:///${rendererFile.replaceAll('\\', '/')}`).href,
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/ABC123`,
  };
  assert(validateProductionCdpTarget(valid, port, rendererFile) === true,
    'Exact production CDP target was rejected.');
  for (const candidate of [
    { ...valid, url: 'http://localhost:5173/' },
    { ...valid, url: `${valid.url}?dev=true` },
    { ...valid, webSocketDebuggerUrl: `ws://localhost:${port}/devtools/page/ABC123` },
    { ...valid, webSocketDebuggerUrl: `ws://127.0.0.1:${port + 1}/devtools/page/ABC123` },
  ]) expectThrow(() => validateProductionCdpTarget(candidate, port, rendererFile));
});

test('renderer probe uses the exact CDP enable-ready-evaluate order', async () => {
  const calls = [];
  const fact = validClosedRendererObservation();
  const client = {
    send: async (method) => { calls.push(`send:${method}`); },
    waitFor: async () => { calls.push('wait'); },
    evaluate: async (expression) => {
      calls.push('evaluate');
      assert(expression.includes('window.api.openPath')
        && expression.includes('window.api.setFirstRunCompletedVersion'),
      'Renderer probe expression is incomplete.');
      return fact;
    },
    close: () => { calls.push('close'); },
  };
  const result = await runRendererProbe(
    client,
    'C:\\Users\\PrivateProfile\\characterization-private-path',
  );
  assert(result === fact && JSON.stringify(calls) === JSON.stringify([
    'send:Runtime.enable', 'send:Page.enable', 'wait', 'evaluate', 'close',
  ]), 'Renderer probe CDP call order drifted.');
});

test('renderer probe closes CDP when evaluation fails', async () => {
  let closed = 0;
  const client = {
    send: async () => undefined,
    waitFor: async () => undefined,
    evaluate: async () => { throw new Error('fixed evaluate failure'); },
    close: () => { closed += 1; },
  };
  await expectThrowAsync(() => runRendererProbe(
    client,
    'C:\\Users\\PrivateProfile\\characterization-private-path',
  ));
  assert(closed === 1, 'Renderer probe failure left CDP open.');
});

test('renderer probe clears the owned client even when client close throws', async () => {
  const fact = validClosedRendererObservation();
  const instance = {
    client: {
      send: async () => undefined,
      waitFor: async () => undefined,
      evaluate: async () => fact,
      close: () => { throw new Error('C:\\Users\\PrivateProfile\\private-close-error'); },
    },
  };
  await expectThrowAsync(() => runOwnedRendererProbe(instance,
    'C:\\Users\\PrivateProfile\\characterization-private-path'));
  assert(instance.client === null, 'Closed or failed CDP client remained in cleanup ownership.');
});

test('renderer probe closed failure fact rejects raw, extra, unknown, and negative evidence', () => {
  const valid = {
    ...validClosedRendererObservation(),
    gate: 'fact_assert',
    errorType: 'fact_assertion_failed',
    clientCloseAttempted: true,
    clientCloseFailed: false,
  };
  assertRendererProbeFailureFact(valid);
  expectThrow(() => assertRendererProbeFailureFact({ ...valid, raw: 'private' }));
  expectThrow(() => assertRendererProbeFailureFact({ ...valid, gate: 'unknown' }));
  expectThrow(() => assertRendererProbeFailureFact({ ...valid, errorType: 'raw-error' }));
  expectThrow(() => assertRendererProbeFailureFact({ ...valid, ownKeyMask: -1 }));
  expectThrow(() => assertRendererProbeFailureFact({ ...valid, codeExact: 'true' }));
  expectThrow(() => assertRendererProbeFailureFact({
    ...valid, successSettled: false, successRejected: true, successUndefined: false,
  }));
  expectThrow(() => assertRendererProbeFailureFact({
    ...valid, successRejected: true, successUndefined: true,
  }));
  expectThrow(() => assertRendererProbeFailureFact({
    ...valid, rejectSettled: false, rejectFulfilled: true, rejectIsError: false,
    codeExact: false, messageExact: false, stackExact: false, ownKeyMask: 0, causeAbsent: false,
  }));
  expectThrow(() => assertRendererProbeFailureFact({
    ...valid, rejectFulfilled: true, rejectIsError: true,
  }));
  expectThrow(() => assertRendererProbeFailureFact({
    ...valid, gate: 'client_close', errorType: 'client_close_failed', clientCloseFailed: false,
  }));
});

test('renderer probe records operation gates before failure and skips downstream calls', async () => {
  const cases = [
    ['runtime_enable', 'Runtime.enable', ['send:Runtime.enable', 'close']],
    ['page_enable', 'Page.enable', ['send:Runtime.enable', 'send:Page.enable', 'close']],
    ['ready_wait', 'ready', ['send:Runtime.enable', 'send:Page.enable', 'wait', 'close']],
    ['evaluate', 'evaluate', ['send:Runtime.enable', 'send:Page.enable', 'wait', 'evaluate', 'close']],
  ];
  for (const [expectedGate, failureAt, expectedCalls] of cases) {
    const calls = [];
    const client = {
      send: async (method) => {
        calls.push(`send:${method}`);
        if (method === failureAt) throw new Error('fixed injected command failure');
      },
      waitFor: async () => {
        calls.push('wait');
        if (failureAt === 'ready') throw new Error('fixed injected ready failure');
      },
      evaluate: async () => {
        calls.push('evaluate');
        if (failureAt === 'evaluate') throw new Error('fixed injected evaluate failure');
        return validClosedRendererObservation();
      },
      close: () => { calls.push('close'); },
    };
    const failure = await captureRendererProbeClosedFailure(client);
    assertRendererProbeFailureFact(failure);
    assert(failure.gate === expectedGate && failure.errorType === 'operation_rejected'
      && failure.clientCloseAttempted === true
      && JSON.stringify(calls) === JSON.stringify(expectedCalls),
    'Renderer probe operation failure was attributed after a downstream operation.');
  }
});

test('renderer probe separates fact schema from the bridged Error assertion', async () => {
  const baseClient = {
    send: async () => undefined,
    waitFor: async () => undefined,
    close: () => undefined,
  };
  const schemaFailure = await captureRendererProbeClosedFailure({
    ...baseClient,
    evaluate: async () => ({ schemaVersion: 1, raw: 'private' }),
  });
  assertRendererProbeFailureFact(schemaFailure);
  assert(schemaFailure.gate === 'fact_schema' && schemaFailure.errorType === 'fact_schema_invalid',
    'Malformed renderer evidence was not attributed to its schema gate.');

  const expression = buildRendererProbeExpression(
    'C:\\Users\\PrivateProfile\\characterization-private-path',
  );
  const bridgedError = new Error(FIXED_ERROR.message);
  const bridgedFact = await Function('window', `return ${expression}`)({
    api: {
      setFirstRunCompletedVersion: async () => undefined,
      openPath: async () => { throw bridgedError; },
    },
  });
  const assertionFailure = await captureRendererProbeClosedFailure({
    ...baseClient,
    evaluate: async () => bridgedFact,
  });
  assertRendererProbeFailureFact(assertionFailure);
  assert(assertionFailure.gate === 'fact_assert'
    && assertionFailure.errorType === 'fact_assertion_failed'
    && assertionFailure.apiPresent === true
    && assertionFailure.successSettled === true
    && assertionFailure.successUndefined === true
    && assertionFailure.rejectSettled === true
    && assertionFailure.rejectIsError === true
    && assertionFailure.codeExact === false
    && assertionFailure.messageExact === true
    && assertionFailure.stackExact === false
    && assertionFailure.ownKeyMask === 3
    && assertionFailure.causeAbsent === true,
  'Context-bridge Error shape was not retained as closed fact-assert evidence.');
});

test('renderer probe preserves the original gate when close also fails', async () => {
  const primaryFailure = await captureRendererProbeClosedFailure({
    send: async () => { throw new Error('fixed primary failure'); },
    waitFor: async () => undefined,
    evaluate: async () => validClosedRendererObservation(),
    close: () => { throw new Error('private close failure'); },
  });
  assertRendererProbeFailureFact(primaryFailure);
  assert(primaryFailure.gate === 'runtime_enable'
    && primaryFailure.errorType === 'operation_rejected'
    && primaryFailure.clientCloseAttempted === true,
  'Renderer probe cleanup failure suppressed the original gate.');

  const closeFailure = await captureRendererProbeClosedFailure({
    send: async () => undefined,
    waitFor: async () => undefined,
    evaluate: async () => validClosedRendererObservation(),
    close: () => { throw new Error('private close failure'); },
  });
  assertRendererProbeFailureFact(closeFailure);
  assert(closeFailure.gate === 'client_close' && closeFailure.errorType === 'client_close_failed'
    && closeFailure.clientCloseAttempted === true,
  'A sole renderer client close failure was not attributed exactly.');
});

test('renderer probe failure output contains only the exact closed fact', () => {
  const fact = {
    ...validClosedRendererObservation(),
    gate: 'fact_assert',
    errorType: 'fact_assertion_failed',
    clientCloseAttempted: true,
    clientCloseFailed: false,
  };
  const serialized = formatRendererProbeFailureFact(fact);
  assert(JSON.stringify(JSON.parse(serialized)) === JSON.stringify(fact)
    && !serialized.includes('PrivateProfile') && !serialized.includes('private'),
  'Renderer probe failure output retained raw or non-closed evidence.');
});

test('renderer observation distinguishes every success and rejection outcome', async () => {
  const sentinelPath = 'C:\\Users\\PrivateProfile\\characterization-private-path';
  const expression = buildRendererProbeExpression(sentinelPath);
  const fixedError = Object.assign(new Error(FIXED_ERROR.message), { code: FIXED_ERROR.code });
  fixedError.stack = FIXED_ERROR.stack;
  const fulfilledNonUndefined = await Function('window', `return ${expression}`)({
    api: {
      setFirstRunCompletedVersion: async () => 1,
      openPath: async () => undefined,
    },
  });
  const successRejected = await Function('window', `return ${expression}`)({
    api: {
      setFirstRunCompletedVersion: async () => { throw new Error('fixed success rejection'); },
      openPath: async () => { throw fixedError; },
    },
  });
  assert(fulfilledNonUndefined.successSettled === true
    && fulfilledNonUndefined.successRejected === false
    && fulfilledNonUndefined.successUndefined === false
    && fulfilledNonUndefined.rejectSettled === true
    && fulfilledNonUndefined.rejectFulfilled === true,
  'Fulfilled non-undefined or unexpectedly fulfilled rejection outcome was ambiguous.');
  assert(successRejected.successSettled === true && successRejected.successRejected === true
    && successRejected.successUndefined === false && successRejected.rejectSettled === true
    && successRejected.rejectFulfilled === false,
  'Rejected success or expected rejection outcome was ambiguous.');
});

test('renderer probe records secondary client close success and failure independently', async () => {
  const primaryWithCloseSuccess = await captureRendererProbeClosedFailure({
    send: async () => { throw new Error('fixed primary failure'); },
    waitFor: async () => undefined,
    evaluate: async () => validClosedRendererObservation(),
    close: () => undefined,
  });
  const primaryWithCloseFailure = await captureRendererProbeClosedFailure({
    send: async () => { throw new Error('fixed primary failure'); },
    waitFor: async () => undefined,
    evaluate: async () => validClosedRendererObservation(),
    close: () => { throw new Error('fixed close failure'); },
  });
  assert(primaryWithCloseSuccess?.gate === 'runtime_enable'
    && primaryWithCloseSuccess.clientCloseAttempted === true
    && primaryWithCloseSuccess.clientCloseFailed === false,
  'Successful secondary client close was not retained independently.');
  assert(primaryWithCloseFailure?.gate === 'runtime_enable'
    && primaryWithCloseFailure.clientCloseAttempted === true
    && primaryWithCloseFailure.clientCloseFailed === true,
  'Failed secondary client close was not retained independently.');
});

test('Electron launch closed fact rejects raw, extra, unknown, and nonboolean evidence', () => {
  const valid = {
    schemaVersion: 1,
    gate: 'target_validate',
    errorType: 'target_invalid',
    childExited: false,
    outputHealthy: true,
    devtoolsObserved: true,
    portValid: true,
    pageObserved: true,
    targetValid: false,
    clientConnected: false,
    cleanupAttempted: true,
    cleanupFailed: false,
    finalStopAttempted: false,
    finalStopFailed: false,
    outputHealthChecked: false,
    outputHealthFailed: false,
    outputPrivacyChecked: false,
    outputPrivacyFailed: false,
  };
  assertElectronLaunchFailureFact(valid);
  expectThrow(() => assertElectronLaunchFailureFact({ ...valid, raw: 'private' }));
  expectThrow(() => assertElectronLaunchFailureFact({ ...valid, gate: 'unknown' }));
  expectThrow(() => assertElectronLaunchFailureFact({ ...valid, errorType: 'raw-error' }));
  expectThrow(() => assertElectronLaunchFailureFact({ ...valid, childExited: 0 }));
  expectThrow(() => assertElectronLaunchFailureFact({
    ...valid, cleanupAttempted: false, cleanupFailed: true,
  }));
});

test('Electron launch closed fact rejects impossible gate progress combinations', () => {
  const impossible = {
    schemaVersion: 1,
    gate: 'process_bind',
    errorType: 'process_identity_failed',
    childExited: false,
    outputHealthy: true,
    devtoolsObserved: false,
    portValid: false,
    pageObserved: false,
    targetValid: false,
    clientConnected: false,
    cleanupAttempted: true,
    cleanupFailed: false,
    finalStopAttempted: false,
    finalStopFailed: false,
    outputHealthChecked: false,
    outputHealthFailed: false,
    outputPrivacyChecked: false,
    outputPrivacyFailed: false,
  };
  expectThrow(() => assertElectronLaunchFailureFact(impossible));
  expectThrow(() => assertElectronLaunchFailureFact({
    ...impossible,
    gate: 'page_wait',
    errorType: 'page_unavailable',
    outputHealthy: true,
    devtoolsObserved: true,
    portValid: false,
  }));
  expectThrow(() => assertElectronLaunchFailureFact({
    ...impossible,
    gate: 'spawn',
    errorType: 'spawn_failed',
    outputHealthy: false,
    cleanupAttempted: true,
  }));
});

test('Electron launch records every gate before its operation and skips downstream calls', async () => {
  const gates = [
    'prerequisite', 'spawn', 'output_bind', 'preliminary_transfer', 'process_bind',
    'devtools_wait', 'output_health', 'devtools_file_validate', 'port_parse', 'page_wait',
    'target_validate', 'cdp_connect',
  ];
  for (const gate of gates) {
    const controls = fakeLaunchControls(gate);
    const failure = await captureElectronLaunchClosedFailure(controls);
    assertElectronLaunchFailureFact(failure);
    const expectedPrefix = gates.slice(0, gates.indexOf(gate) + 1);
    const expectedCalls = ['prerequisite', 'spawn'].includes(gate)
      ? expectedPrefix
      : [...expectedPrefix, 'cleanup'];
    assert(failure.gate === gate
      && JSON.stringify(controls.calls) === JSON.stringify(expectedCalls),
    'Electron launch failure was attributed after a downstream operation.');
  }
});

test('Electron launch preserves its primary gate when exact cleanup also fails', async () => {
  const controls = fakeLaunchControls('page_wait', true);
  const failure = await captureElectronLaunchClosedFailure(controls);
  assertElectronLaunchFailureFact(failure);
  assert(failure.gate === 'page_wait' && failure.errorType === 'page_unavailable'
    && failure.cleanupAttempted === true && failure.cleanupFailed === true
    && controls.calls.at(-1) === 'cleanup',
  'Electron launch cleanup failure suppressed the original gate.');
});

test('Electron launch binds child error capture synchronously before the first yield', async () => {
  const controls = fakeLaunchControls();
  let listenerCountAtYield = -1;
  controls.spawnChild = () => {
    controls.calls.push('spawn');
    queueMicrotask(() => {
      listenerCountAtYield = controls.child.listenerCount('error');
      if (listenerCountAtYield > 0) {
        controls.child.emit('error', new Error('C:\\Users\\PrivateProfile\\fixed-spawn-error'));
      }
    });
    return controls.child;
  };
  controls.bindClose = bindChildCloseDrain;
  controls.bindOutput = bindOutputCapture;
  controls.waitForDevTools = async () => {
    controls.calls.push('devtools_wait');
    return true;
  };
  controls.assertOutput = (output) => {
    controls.calls.push('output_health');
    return assertOutputCaptureHealthy(output);
  };
  const failure = await captureElectronLaunchClosedFailure(controls);
  assert(failure?.gate === 'output_health' && listenerCountAtYield === 1,
    'Electron spawn yielded before its fixed output/error ownership was bound.');
});

test('Electron launch attributes an output fault during DevTools wait to output health', async () => {
  const controls = fakeLaunchControls();
  controls.bindClose = bindChildCloseDrain;
  controls.bindOutput = bindOutputCapture;
  controls.waitForDevTools = async () => {
    controls.calls.push('devtools_wait');
    controls.child.emit('error', new Error('C:\\Users\\PrivateProfile\\fixed-output-fault'));
    return false;
  };
  controls.assertOutput = (output) => {
    controls.calls.push('output_health');
    return assertOutputCaptureHealthy(output);
  };
  const failure = await captureElectronLaunchClosedFailure(controls);
  assert(failure?.gate === 'output_health' && failure.outputHealthy === false
    && failure.devtoolsObserved === false,
  'DevTools endpoint absence suppressed a known Electron output fault.');
});

test('Electron launch binds close-drain and exact identity before fallible ownership transfer', async () => {
  const controls = fakeLaunchControls();
  const acceptanceTag = '11111111-1111-4111-8111-111111111111';
  const acceptanceToken = `${ACCEPTANCE_FLAG}${acceptanceTag}`;
  controls.acceptanceTag = acceptanceTag;
  controls.acceptanceToken = acceptanceToken;
  controls.transferOwnership = () => {
    controls.calls.push('preliminary_transfer');
    throw new Error('fixed preliminary ownership transfer failure');
  };
  let terminated = false;
  let cleanedInstance = null;
  controls.stopOwned = async (owned) => {
    controls.calls.push('cleanup');
    cleanedInstance = owned;
    assert(owned.acceptanceToken === acceptanceToken
      && owned.executablePath === 'C:\\Electron\\electron.exe'
      && owned.output?.closed === owned.outputClosed,
    'Preliminary ownership did not include exact identity and close-drain state.');
    return stopElectron(owned, {
      waitForClose: async (promise) => (
        terminated
          ? { settled: true, value: await promise }
          : { settled: false, value: null }
      ),
      bindIdentity: async (instance) => {
        assert(instance.acceptanceToken === acceptanceToken,
          'Preliminary cleanup lost its exact acceptance identity.');
      },
      terminateTree: () => {
        terminated = true;
        controls.child.exitCode = 0;
        queueMicrotask(() => controls.child.emit('close', 0, null));
        return { status: 0, error: null, signal: null };
      },
    });
  };
  const failure = await captureElectronLaunchClosedFailure(controls);
  assertElectronLaunchFailureFact(failure);
  assert(failure.gate === 'preliminary_transfer' && failure.cleanupAttempted === true
    && failure.cleanupFailed === false && cleanedInstance?.stopped === true
    && JSON.stringify(controls.calls) === JSON.stringify([
      'prerequisite', 'spawn', 'output_bind', 'preliminary_transfer', 'cleanup',
    ]),
  'A spawned child was left outside exact close-drain and process cleanup ownership.');
});

test('Electron launch failure output contains only the exact closed fact', () => {
  const fact = {
    schemaVersion: 1,
    gate: 'process_bind',
    errorType: 'process_identity_failed',
    childExited: false,
    outputHealthy: false,
    devtoolsObserved: false,
    portValid: false,
    pageObserved: false,
    targetValid: false,
    clientConnected: false,
    cleanupAttempted: true,
    cleanupFailed: false,
    finalStopAttempted: false,
    finalStopFailed: false,
    outputHealthChecked: false,
    outputHealthFailed: false,
    outputPrivacyChecked: false,
    outputPrivacyFailed: false,
  };
  const serialized = formatElectronLaunchFailureFact(fact);
  assert(JSON.stringify(JSON.parse(serialized)) === JSON.stringify(fact)
    && !serialized.includes('PrivateProfile') && !serialized.includes('private'),
  'Electron launch failure output retained raw or non-closed evidence.');
});

test('Electron launch final cleanup records every attempted secondary check independently', async () => {
  const unexecuted = await collectLaunchFinalCleanupEvidence({});
  assert(JSON.stringify(unexecuted) === JSON.stringify({
    finalStopAttempted: false,
    finalStopFailed: false,
    outputHealthChecked: false,
    outputHealthFailed: false,
    outputPrivacyChecked: false,
    outputPrivacyFailed: false,
  }), 'Unexecuted final cleanup checks were reported as successful.');
  const failed = await collectLaunchFinalCleanupEvidence({
    stop: async () => { throw new Error('fixed stop failure'); },
    checkOutputHealth: () => { throw new Error('fixed output health failure'); },
    checkOutputPrivacy: () => { throw new Error('fixed output privacy failure'); },
  });
  assert(failed.finalStopAttempted === true && failed.finalStopFailed === true
    && failed.outputHealthChecked === true && failed.outputHealthFailed === true
    && failed.outputPrivacyChecked === true && failed.outputPrivacyFailed === true,
  'A final cleanup failure suppressed a later closed secondary check.');
});

test('Electron launch final cleanup augments but never replaces its primary closed gate', async () => {
  const primary = {
    schemaVersion: 1,
    gate: 'page_wait',
    errorType: 'page_unavailable',
    childExited: false,
    outputHealthy: true,
    devtoolsObserved: true,
    portValid: true,
    pageObserved: false,
    targetValid: false,
    clientConnected: false,
    cleanupAttempted: true,
    cleanupFailed: true,
    finalStopAttempted: false,
    finalStopFailed: false,
    outputHealthChecked: false,
    outputHealthFailed: false,
    outputPrivacyChecked: false,
    outputPrivacyFailed: false,
  };
  const finalEvidence = await collectLaunchFinalCleanupEvidence({
    stop: async () => { throw new Error('fixed stop failure'); },
    checkOutputHealth: () => undefined,
    checkOutputPrivacy: () => { throw new Error('fixed privacy failure'); },
  });
  const merged = finalizeElectronLaunchFailureFact(primary, finalEvidence);
  assert(merged.gate === 'page_wait' && merged.errorType === 'page_unavailable'
    && merged.cleanupFailed === true && merged.finalStopFailed === true
    && merged.outputHealthChecked === true && merged.outputHealthFailed === false
    && merged.outputPrivacyChecked === true && merged.outputPrivacyFailed === true,
  'A secondary final cleanup result replaced or obscured the primary launch gate.');
});

test('spawn output binding fails closed when required pipes are unavailable', () => {
  const child = { once: () => undefined, stdout: null, stderr: null };
  const output = bindOutputCapture(child);
  assert(output.state.pipeUnavailable === true,
    'Missing Electron output pipes were not recorded as a closed failure.');
});

test('spawn and pipe errors are captured as fixed state instead of escaping', () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const output = bindOutputCapture(child);
  child.emit('error', new Error('C:\\Users\\PrivateProfile\\private-spawn-error'));
  child.stdout.emit('error', new Error('private-stdout-error'));
  child.stderr.emit('error', new Error('private-stderr-error'));
  expectThrow(() => assertOutputCaptureHealthy(output));
  assert(output.state.childError && output.state.stdoutError && output.state.stderrError,
    'Spawn or pipe error state was not retained as fixed booleans.');
});

test('live termination failure and close timeout both fail closed', async () => {
  const makeInstance = () => ({
    child: { pid: 704, exitCode: null, signalCode: null },
    client: null,
    outputClosed: new Promise(() => {}),
    stopped: false,
  });
  let bindCalls = 0;
  let terminateCalls = 0;
  const killFailure = makeInstance();
  await expectThrowAsync(() => stopElectron(killFailure, {
    waitForClose: async () => ({ settled: false, value: null }),
    bindIdentity: async () => { bindCalls += 1; },
    terminateTree: () => { terminateCalls += 1; return { status: 1, error: null, signal: null }; },
  }));
  assert(bindCalls === 1 && terminateCalls === 1 && killFailure.stopped === false,
    'Tree-kill failure did not preserve owned cleanup state.');

  const closeTimeout = makeInstance();
  await expectThrowAsync(() => stopElectron(closeTimeout, {
    waitForClose: async () => ({ settled: false, value: null }),
    bindIdentity: async () => undefined,
    terminateTree: () => ({ status: 0, error: null, signal: null }),
  }));
  assert(closeTimeout.stopped === false, 'Output-close timeout falsely completed cleanup.');
});

test('late split output is retained through child close and overflow fails at the byte boundary', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 705;
  child.exitCode = 0;
  child.signalCode = null;
  const output = bindOutputCapture(child);
  const instance = { child, client: null, outputClosed: output.closed, stopped: false };
  setTimeout(() => {
    child.stdout.emit('data', Buffer.from('late-private-', 'utf8'));
    child.stdout.emit('data', Buffer.from('split', 'utf8'));
    child.emit('close', 0, null);
  }, 5);
  await stopElectron(instance);
  assert(Buffer.concat(output.state.stdout).equals(Buffer.from('late-private-split', 'utf8')),
    'Electron output was retained before close drained split chunks.');

  const capped = new EventEmitter();
  capped.stdout = new EventEmitter();
  capped.stderr = new EventEmitter();
  const cappedOutput = bindOutputCapture(capped);
  capped.stdout.emit('data', Buffer.alloc(OUTPUT_LIMIT_BYTES));
  assert(cappedOutput.state.overflow === false
    && Buffer.concat(cappedOutput.state.stdout).length === OUTPUT_LIMIT_BYTES,
  'Exact output byte limit was rejected.');
  capped.stderr.emit('data', Buffer.from('x'));
  assert(cappedOutput.state.overflow === true
    && Buffer.concat(cappedOutput.state.stderr).length === 0,
  'Output over the byte limit did not fail without retaining excess bytes.');
});

test('loopback listener evidence distinguishes open from closed', async () => {
  await runLoopbackListenerEvidence();
});

test('loopback listener evidence closes the owned listener when its open check throws', async () => {
  let observedPort = null;
  await expectThrowAsync(() => runLoopbackListenerEvidence({
    isOpen: async (port) => {
      observedPort = port;
      throw new Error('fixed injected listener check failure');
    },
  }));
  assert(Number.isSafeInteger(observedPort) && observedPort > 0
    && await waitForListenerClose(observedPort),
  'Listener evidence failure left the exact owned loopback listener open.');
});

test('failure-path restricted values retain the generated secret and sentinel', () => {
  const fixture = {
    root: 'D:\\owned', dataRoot: 'D:\\owned\\data', browserRoot: 'D:\\owned\\browser',
  };
  const secret = 'private-characterization-secret';
  const sentinelPath = 'D:\\owned\\private-characterization-secret\\unauthorized';
  const values = buildRestrictedOutputValues(
    fixture, secret, sentinelPath, 'C:\\workspace', 'C:\\Users\\PrivateProfile',
  );
  assert(values.includes(secret) && values.includes(sentinelPath),
    'Failure output rescan lost the private secret or sentinel.');
});

test('partial fixture setup transfers ownership and rolls back its exact root', () => {
  let transferred = null;
  let created = null;
  let failed = false;
  try {
    created = createFixture({
      transferOwnership: (owned) => { transferred = owned; },
      mkdir: (directory, index) => {
        if (index === 2) throw new Error('fixed setup failure');
        fs.mkdirSync(directory);
      },
    });
  } catch {
    failed = true;
  } finally {
    if (created?.root && fs.existsSync(created.root)) removeFixture(created.root);
  }
  assert(failed && transferred?.root && !fs.existsSync(transferred.root),
    'Partial fixture setup did not transfer ownership and roll back exactly.');
});

test('fixture ownership-transfer failure rolls back the exact created root', () => {
  let transferred = null;
  let rolledBackBeforeTestCleanup = false;
  try {
    expectThrow(() => createFixture({
      transferOwnership: (owned) => {
        transferred = owned;
        throw new Error('fixed transfer failure');
      },
    }));
    rolledBackBeforeTestCleanup = Boolean(transferred?.root) && !fs.existsSync(transferred.root);
  } finally {
    if (transferred?.root && fs.existsSync(transferred.root)) removeFixture(transferred.root);
  }
  assert(rolledBackBeforeTestCleanup, 'Ownership-transfer failure orphaned the exact fixture root.');
});

test('an exited Electron child waits for close-drained output without PID rebind or kill', async () => {
  let bindCalls = 0;
  let terminateCalls = 0;
  const waits = [
    { settled: false, value: null },
    { settled: true, value: { code: 0, signal: null } },
  ];
  const instance = {
    child: { pid: 701, exitCode: 0, signalCode: null },
    client: null,
    outputClosed: new Promise(() => {}),
    stopped: false,
  };
  await stopElectron(instance, {
    waitForClose: async () => waits.shift(),
    bindIdentity: async () => { bindCalls += 1; },
    terminateTree: () => { terminateCalls += 1; return { status: 0, error: null, signal: null }; },
  });
  assert(instance.stopped === true && bindCalls === 0 && terminateCalls === 0,
    'Exited Electron child was rebound or terminated before output close.');
});

test('bounded output wait clears its timeout after early close', async () => {
  let created = 0;
  let cleared = 0;
  const result = await waitForPromise(Promise.resolve('closed'), 50, {
    setTimer: () => { created += 1; return 77; },
    clearTimer: (timer) => { assert(timer === 77, 'Wrong bounded wait timer was cleared.'); cleared += 1; },
  });
  assert(result.settled === true && result.value === 'closed' && created === 1 && cleared === 1,
    'Bounded close wait retained a live timeout after settlement.');
});

test('owned temp cleanup rejects an internal junction before recursive deletion', () => {
  runOwnedJunctionCleanupEvidence();
});

test('junction self-test setup failure removes the exact owned temp root', () => {
  const before = countOwnedTempRoots();
  let fixture = null;
  expectThrow(() => runOwnedJunctionCleanupEvidence({
    transferOwnership: (owned) => { fixture = owned; },
    createJunction: () => { throw new Error('fixed injected junction setup failure'); },
  }));
  assert(fixture?.root && !fs.existsSync(fixture.root)
    && countOwnedTempRoots() === before,
  'Junction self-test setup failure left an owned temp root behind.');
});

test('cleanup residual fact rejects extra and nonzero counts', () => {
  const valid = { schemaVersion: 1, taggedProcessCount: 0, tempRootCount: 0, listenerCount: 0 };
  assertResidualFact(valid);
  expectThrow(() => assertResidualFact({ ...valid, rawPath: 'private' }));
  expectThrow(() => assertResidualFact({ ...valid, listenerCount: 1 }));
  expectThrow(() => assertResidualFact({ ...valid, taggedProcessCount: -1 }));
});

async function runSelfTests() {
  let passed = 0;
  const failed = [];
  for (const entry of selfTests) {
    try {
      await entry.operation();
      passed += 1;
    } catch {
      failed.push(entry.name);
    }
  }
  process.stdout.write(`IPC envelope characterization self-test: ${passed}/${selfTests.length} passed.\n`);
  for (const name of failed) process.stdout.write(`FAIL: ${name}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

async function main() {
  let phase = 'preflight';
  let fixture = null;
  let instance = null;
  let rendererFact = null;
  let rendererProbeFailureFact = null;
  let electronLaunchFailureFact = null;
  let launchFinalCleanupEvidence = {
    finalStopAttempted: false,
    finalStopFailed: false,
    outputHealthChecked: false,
    outputHealthFailed: false,
    outputPrivacyChecked: false,
    outputPrivacyFailed: false,
  };
  let outputFact = null;
  let secret = null;
  let sentinelPath = null;
  let restrictedValues = [];
  let failure = false;
  let taggedProcessCount = 0;
  let listenerCount = 0;
  let tempRootCount = 0;
  try {
    assert(countTaggedProcesses() === 0 && countOwnedTempRoots() === 0,
      'Characterization preflight residual is nonzero.');
    for (const target of [
      path.join(WORKSPACE_ROOT, 'dist', 'main', 'index.js'),
      path.join(WORKSPACE_ROOT, 'dist', 'preload', 'index.js'),
      path.join(WORKSPACE_ROOT, 'dist', 'renderer', 'index.html'),
    ]) {
      const stats = fs.lstatSync(target);
      assert(stats.isFile() && !stats.isSymbolicLink(), 'Production build input is unavailable.');
    }

    phase = 'fixture_create';
    fixture = createFixture({ transferOwnership: (owned) => { fixture = owned; } });
    secret = `ipc-envelope-${crypto.randomUUID()}`;
    sentinelPath = path.join(fixture.root, secret, 'unauthorized');
    restrictedValues = buildRestrictedOutputValues(
      fixture,
      secret,
      sentinelPath,
      WORKSPACE_ROOT,
      path.resolve(process.env.USERPROFILE || os.homedir()),
    );

    phase = 'electron_launch';
    instance = await launchElectron(fixture, (owned) => { instance = owned; });

    phase = 'renderer_probe';
    rendererFact = await runOwnedRendererProbe(instance, sentinelPath);

    phase = 'electron_stop';
    await stopElectron(instance);

    phase = 'output_privacy';
    assertOutputCaptureHealthy(instance.output);
    const streams = [
      Buffer.concat(instance.output.state.stdout),
      Buffer.concat(instance.output.state.stderr),
    ];
    outputFact = scanOutputEvidence(streams, restrictedValues);
    assertOutputEvidence(outputFact);
  } catch (error) {
    if (error instanceof RendererProbeClosedFailure) {
      rendererProbeFailureFact = error.closedFact;
    }
    if (error instanceof ElectronLaunchClosedFailure) {
      electronLaunchFailureFact = error.closedFact;
      if (error.ownedInstance) instance = error.ownedInstance;
    }
    failure = true;
  } finally {
    phase = failure ? phase : 'cleanup';
    launchFinalCleanupEvidence = await collectLaunchFinalCleanupEvidence({
      ...(instance && !instance.stopped ? {
        stop: () => stopElectron(instance),
      } : {}),
      ...(instance?.output ? {
        checkOutputHealth: () => assertOutputCaptureHealthy(instance.output),
      } : {}),
      ...(instance?.output && outputFact === null && fixture ? {
        checkOutputPrivacy: () => {
          assert(instance.stopped, 'Electron output privacy cannot precede close-drain cleanup.');
        const streams = [
          Buffer.concat(instance.output.state.stdout),
          Buffer.concat(instance.output.state.stderr),
        ];
        outputFact = scanOutputEvidence(streams, restrictedValues.length > 0
          ? restrictedValues
          : [fixture.root, fixture.dataRoot, fixture.browserRoot, WORKSPACE_ROOT,
             path.resolve(process.env.USERPROFILE || os.homedir())]);
        assertOutputEvidence(outputFact);
        },
      } : {}),
    });
    if (launchFinalCleanupEvidence.finalStopFailed
      || launchFinalCleanupEvidence.outputHealthFailed
      || launchFinalCleanupEvidence.outputPrivacyFailed) failure = true;
    try {
      taggedProcessCount = instance && fixture
        ? countTaggedProcesses(instance.acceptanceToken, fixture.browserRoot)
        : countTaggedProcesses();
    } catch {
      taggedProcessCount = 4096;
      failure = true;
    }
    if (instance?.port) {
      try {
        listenerCount = await waitForListenerClose(instance.port) ? 0 : 1;
      } catch {
        listenerCount = 1;
      }
    }
    if (taggedProcessCount === 0 && fixture && fs.existsSync(fixture.root)) {
      try { removeFixture(fixture.root); } catch { failure = true; }
    }
    try { tempRootCount = countOwnedTempRoots(); } catch { tempRootCount = 4096; failure = true; }
    if (taggedProcessCount !== 0 || listenerCount !== 0 || tempRootCount !== 0
      || OWNED_TEMP_ROOTS.size !== 0) failure = true;
  }

  if (electronLaunchFailureFact !== null) {
    electronLaunchFailureFact = finalizeElectronLaunchFailureFact(
      electronLaunchFailureFact,
      launchFinalCleanupEvidence,
    );
  }

  const residual = { schemaVersion: 1, taggedProcessCount, tempRootCount, listenerCount };
  if (!failure) {
    assertRendererFact(rendererFact);
    assertOutputEvidence(outputFact);
    assertResidualFact(residual);
    phase = 'complete';
    process.stdout.write('IPC envelope characterization: PASS renderer=9/9 private=0 handler=0 '
      + 'tagged=0 temp=0 listener=0.\n');
    return;
  }
  const rendererProbeEvidence = rendererProbeFailureFact === null
    ? ''
    : ` rendererProbe=${formatRendererProbeFailureFact(rendererProbeFailureFact)}`;
  const electronLaunchEvidence = electronLaunchFailureFact === null
    ? ''
    : ` electronLaunch=${formatElectronLaunchFailureFact(electronLaunchFailureFact)}`;
  process.stdout.write(`IPC envelope characterization: FAIL phase=${phase}${rendererProbeEvidence}${electronLaunchEvidence} `
    + `tagged=${taggedProcessCount} temp=${tempRootCount} listener=${listenerCount}.\n`);
  process.exitCode = 1;
}

if (process.argv.includes('--self-test')) {
  await runSelfTests();
} else {
  await main();
}
