import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const SECRET_KEY_PATTERN = /(api[_-]?key|auth[_-]?token|access[_-]?token|password|secret|authorization|cookie)/iu;
const SECRET_VALUE_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{12,}\b/gu,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/._~=-]{8,}\b/giu,
  /([?&](?:api[_-]?key|token|access[_-]?token|signature|sig)=)[^&#\s]+/giu,
];

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function redact(value) {
  let output = String(value ?? '');
  for (const [key, secret] of Object.entries(process.env)) {
    if (!SECRET_KEY_PATTERN.test(key) || typeof secret !== 'string' || secret.length < 8) continue;
    output = output.split(secret).join('[REDACTED]');
  }
  for (const pattern of SECRET_VALUE_PATTERNS) output = output.replace(pattern, '$1[REDACTED]');
  return output;
}

export function safeError(error) {
  return redact(error instanceof Error ? error.message : String(error));
}

export function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeoutMs ?? 30_000,
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stderr, result.stdout]
      .filter(Boolean)
      .map(redact)
      .join('\n')
      .trim();
    throw new Error(`${path.basename(command)} failed${detail ? `:\n${detail}` : '.'}`);
  }
  return result.stdout?.trim() ?? '';
}

export async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error('Unable to reserve a local port.'));
        else resolve(port);
      });
    });
  });
}

export function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

export async function stopProcessTree(child, graceMs = 5_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return { forced: false };
  try { child.kill('SIGTERM'); } catch { /* The process already exited. */ }
  if (await waitForExit(child, graceMs)) return { forced: false };
  const pid = child.pid;
  if (!pid) return { forced: false };
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch {
      try { process.kill(pid, 'SIGKILL'); } catch { /* The process already exited. */ }
    }
  }
  await waitForExit(child, 3_000);
  return { forced: true };
}

export function disposableRoot(prefix) {
  assert(/^[a-z0-9-]+$/iu.test(prefix), 'Temporary directory prefix is invalid.');
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeDisposableRoot(root, prefix) {
  const resolvedRoot = path.resolve(root);
  const resolvedTemp = path.resolve(os.tmpdir());
  const expectedPrefix = path.join(resolvedTemp, prefix);
  assert(resolvedRoot.startsWith(expectedPrefix), `Refusing to remove a non-disposable path: ${resolvedRoot}`);
  assert(resolvedRoot !== resolvedTemp, 'Refusing to remove the operating-system temp root.');
  fs.rmSync(resolvedRoot, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
}

export function directorySize(root) {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile()) total += fs.statSync(entryPath).size;
    }
  }
  return total;
}

export function monotonicNow() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

