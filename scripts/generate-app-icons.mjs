import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ICO_SIZES = Object.freeze([16, 20, 24, 32, 40, 48, 64, 128, 256]);
const RENDER_SIZE = 512;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const WORKSPACE = path.resolve(path.dirname(SCRIPT_PATH), '..');
const SVG_PATH = path.join(WORKSPACE, 'build-resources', 'app-icon.svg');
const PNG_PATH = path.join(WORKSPACE, 'build-resources', 'app-icon.png');
const ICO_PATH = path.join(WORKSPACE, 'build-resources', 'app-icon.ico');
const DISALLOWED_PNG_CHUNKS = new Set(['eXIf', 'iTXt', 'tEXt', 'tIME', 'zTXt']);
const EPHEMERAL_USER_DATA = path.join(
  os.tmpdir(),
  `claude-workbench-app-icon-generator-${process.pid}`,
);
const CLEANUP_MODE_ENV = 'WORKBENCH_APP_ICON_CLEANUP';
let electronApiPromise;

function loadElectronApi() {
  electronApiPromise ??= import('electron').then((electron) => {
    if (!electron.app || !electron.BrowserWindow) {
      throw new Error('The icon generator must run under the locked Electron runtime.');
    }
    return electron;
  });
  return electronApiPromise;
}

function normalizedWindowsPath(value) {
  return path.resolve(value).replace(/^\\\\\?\\/u, '').toLowerCase();
}

function privateUserDataPath(parentPid) {
  if (!Number.isSafeInteger(parentPid) || parentPid < 1) {
    throw new Error('Cleanup parent process ID is invalid.');
  }
  const temporaryRoot = path.resolve(os.tmpdir());
  const basename = `claude-workbench-app-icon-generator-${parentPid}`;
  const target = path.resolve(temporaryRoot, basename);
  if (
    path.basename(target) !== basename
    || normalizedWindowsPath(path.dirname(target)) !== normalizedWindowsPath(temporaryRoot)
  ) {
    throw new Error('Cleanup target is outside the fixed temporary root.');
  }
  return target;
}

function assertOwnedCleanupDirectory(target) {
  const stats = fs.lstatSync(target);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Cleanup target is not an owned plain directory.');
  }
  if (normalizedWindowsPath(fs.realpathSync.native(target)) !== normalizedWindowsPath(target)) {
    throw new Error('Cleanup target resolves through a reparse point.');
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === 'ESRCH') return false;
    if (error && error.code === 'EPERM') return true;
    throw error;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function cleanupUserDataAfterParentExit(parentPid) {
  const target = privateUserDataPath(parentPid);
  const parentDeadline = Date.now() + 15_000;
  while (processIsAlive(parentPid)) {
    if (Date.now() >= parentDeadline) {
      throw new Error('Cleanup parent process did not exit within the bounded wait.');
    }
    await delay(25);
  }

  const cleanupDeadline = Date.now() + 10_000;
  while (fs.existsSync(target)) {
    assertOwnedCleanupDirectory(target);
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (error) {
      if (!error || !['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
    }
    if (!fs.existsSync(target)) return;
    if (Date.now() >= cleanupDeadline) {
      throw new Error('Private Electron user-data cleanup did not complete.');
    }
    await delay(25);
  }
}

function scheduleUserDataCleanup(parentPid) {
  const target = privateUserDataPath(parentPid);
  if (!fs.existsSync(target)) return;
  assertOwnedCleanupDirectory(target);

  const helper = spawn(
    process.execPath,
    [SCRIPT_PATH, '--cleanup-user-data', String(parentPid)],
    {
      cwd: WORKSPACE,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        [CLEANUP_MODE_ENV]: '1',
        SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
        TEMP: os.tmpdir(),
        TMP: os.tmpdir(),
        WINDIR: process.env.WINDIR ?? 'C:\\Windows',
      },
    },
  );
  if (!helper.pid) throw new Error('Private user-data cleanup helper did not start.');
  helper.unref();
}

function pngDimensions(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Icon frame is not a PNG.');
  }
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function assertMetadataFreePng(bytes) {
  pngDimensions(bytes);
  let offset = PNG_SIGNATURE.length;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error('PNG chunk directory is truncated.');
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const next = offset + 12 + length;
    if (next > bytes.length) throw new Error('PNG chunk exceeds the frame boundary.');
    if (DISALLOWED_PNG_CHUNKS.has(type)) {
      throw new Error(`PNG metadata chunk ${type} is not allowed.`);
    }
    offset = next;
  }
  if (offset !== bytes.length) throw new Error('PNG has trailing bytes.');
}

function assertCanonicalSvg(svg) {
  if (!svg.startsWith('<svg ') || !svg.endsWith('</svg>\n')) {
    throw new Error('Canonical icon SVG must be one UTF-8 SVG document.');
  }
  if (!svg.includes('viewBox="0 0 256 256"')) {
    throw new Error('Canonical icon SVG must use the 256 by 256 viewBox.');
  }
  if (!svg.includes('xmlns="http://www.w3.org/2000/svg"')) {
    throw new Error('Canonical icon SVG must use the fixed SVG namespace.');
  }
  const referenceSurface = svg.replace('xmlns="http://www.w3.org/2000/svg"', '');
  if (/<(?:script|image|text|a|use|foreignObject|style|defs)\b|(?:href|src)\s*=|url\s*\(|data:|https?:|<!DOCTYPE|<!ENTITY/iu.test(referenceSurface)) {
    throw new Error('Canonical icon SVG contains external or active material.');
  }
}

function htmlForSvg(svg) {
  assertCanonicalSvg(svg);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>html,body{width:${RENDER_SIZE}px;height:${RENDER_SIZE}px;margin:0;overflow:hidden;background:transparent}svg{display:block;width:${RENDER_SIZE}px;height:${RENDER_SIZE}px}</style>
</head>
<body>${svg}</body>
</html>`;
}

function bytesEqual(left, right) {
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function atomicWrite(filePath, bytes) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export async function renderIconFrames(svgPath, sizes) {
  const { BrowserWindow } = await loadElectronApi();
  const normalizedSizes = [...new Set(sizes)].sort((left, right) => left - right);
  if (
    normalizedSizes.length === 0
    || normalizedSizes.some((size) => !Number.isInteger(size) || size < 1 || size > RENDER_SIZE)
  ) {
    throw new Error('Icon frame sizes must be unique integers from 1 through 512.');
  }

  const svgBytes = fs.readFileSync(svgPath);
  const svg = svgBytes.toString('utf8');
  if (!Buffer.from(svg, 'utf8').equals(svgBytes)) {
    throw new Error('Canonical icon SVG must be valid UTF-8.');
  }

  const window = new BrowserWindow({
    width: RENDER_SIZE,
    height: RENDER_SIZE,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      partition: `app-icon-generator-${process.pid}`,
    },
  });

  try {
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlForSvg(svg))}`);
    await window.webContents.executeJavaScript(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      true,
    );
    const capture = await window.webContents.capturePage({
      x: 0,
      y: 0,
      width: RENDER_SIZE,
      height: RENDER_SIZE,
    });
    const captureSize = capture.getSize();
    if (captureSize.width !== RENDER_SIZE || captureSize.height !== RENDER_SIZE) {
      throw new Error(`Unexpected capture size ${captureSize.width}x${captureSize.height}.`);
    }

    const frames = new Map();
    for (const size of normalizedSizes) {
      const image = size === RENDER_SIZE
        ? capture
        : capture.resize({ width: size, height: size, quality: 'best' });
      const bytes = image.toPNG();
      assertMetadataFreePng(bytes);
      const [width, height] = pngDimensions(bytes);
      if (width !== size || height !== size) {
        throw new Error(`Electron rendered ${width}x${height} for requested ${size}px frame.`);
      }
      frames.set(size, bytes);
    }
    return frames;
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

export function writeIco(frames) {
  const ordered = [...frames.entries()].sort(([left], [right]) => left - right);
  if (ordered.length === 0 || ordered.length > 0xffff) {
    throw new Error('ICO must contain between 1 and 65535 frames.');
  }

  const directorySize = 6 + ordered.length * 16;
  let imageOffset = directorySize;
  const header = Buffer.alloc(directorySize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(ordered.length, 4);

  ordered.forEach(([size, bytes], index) => {
    if (!Number.isInteger(size) || size < 1 || size > 256) {
      throw new Error(`ICO size ${size} is outside the supported range.`);
    }
    assertMetadataFreePng(bytes);
    const [width, height] = pngDimensions(bytes);
    if (width !== size || height !== size) {
      throw new Error(`ICO frame key ${size} does not match PNG dimensions ${width}x${height}.`);
    }
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header[entry + 2] = 0;
    header[entry + 3] = 0;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(bytes.length, entry + 8);
    header.writeUInt32LE(imageOffset, entry + 12);
    imageOffset += bytes.length;
  });

  return Buffer.concat([header, ...ordered.map(([, bytes]) => bytes)]);
}

async function runCli() {
  const flags = process.argv.slice(2);
  if (flags.length !== 1 || !['--write', '--verify'].includes(flags[0])) {
    throw new Error('Usage: electron scripts/generate-app-icons.mjs --write|--verify');
  }

  const { app } = await loadElectronApi();
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.setPath('userData', EPHEMERAL_USER_DATA);
  await app.whenReady();

  const frames = await renderIconFrames(SVG_PATH, [...ICO_SIZES, RENDER_SIZE]);
  const png = frames.get(RENDER_SIZE);
  if (!png) throw new Error('The 512px application PNG was not rendered.');
  const ico = writeIco(new Map(ICO_SIZES.map((size) => [size, frames.get(size)])));

  if (flags[0] === '--write') {
    fs.mkdirSync(path.dirname(PNG_PATH), { recursive: true });
    atomicWrite(PNG_PATH, png);
    atomicWrite(ICO_PATH, ico);
    console.log('app-icon.png: WRITTEN');
    console.log('app-icon.ico: WRITTEN');
    return 0;
  }

  let mismatch = false;
  for (const [filePath, generated] of [[PNG_PATH, png], [ICO_PATH, ico]]) {
    const name = path.basename(filePath);
    const tracked = fs.existsSync(filePath) ? fs.readFileSync(filePath) : Buffer.alloc(0);
    const matches = bytesEqual(tracked, generated);
    console.log(`${name}: ${matches ? 'MATCH' : 'MISMATCH'}`);
    mismatch ||= !matches;
  }
  return mismatch ? 1 : 0;
}

const isCli = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isCli) {
  const cleanupMode = process.env[CLEANUP_MODE_ENV] === '1';
  if (cleanupMode) {
    const cleanupArguments = process.argv.slice(2);
    const parentPid = cleanupArguments.length === 2
      && cleanupArguments[0] === '--cleanup-user-data'
      && /^[1-9]\d{0,9}$/u.test(cleanupArguments[1])
      ? Number(cleanupArguments[1])
      : Number.NaN;
    void cleanupUserDataAfterParentExit(parentPid).then(
      () => process.exit(0),
      (error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      },
    );
  } else {
    void runCli().then(
      async (exitCode) => {
        const { app } = await loadElectronApi();
        let finalExitCode = exitCode;
        try {
          scheduleUserDataCleanup(process.pid);
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          finalExitCode = 1;
        }
        app.exit(finalExitCode);
      },
      async (error) => {
        console.error(error instanceof Error ? error.message : String(error));
        const { app } = await loadElectronApi();
        try {
          scheduleUserDataCleanup(process.pid);
        } catch (cleanupError) {
          console.error(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
        }
        app.exit(1);
      },
    );
  }
}
