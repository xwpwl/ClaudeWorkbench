import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';

const WORKSPACE = path.resolve(__dirname, '../../../..');
const SVG_PATH = path.join(WORKSPACE, 'build-resources', 'app-icon.svg');
const PNG_PATH = path.join(WORKSPACE, 'build-resources', 'app-icon.png');
const ICO_PATH = path.join(WORKSPACE, 'build-resources', 'app-icon.ico');
const GENERATOR_PATH = path.join(WORKSPACE, 'scripts', 'generate-app-icons.mjs');
const NOTICE_PATH = path.join(WORKSPACE, 'docs', 'legal', 'ASSET-NOTICES.md');
const ELECTRON_PATH = path.join(
  WORKSPACE,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);

const REQUIRED_ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const REJECTED_LEGACY_HASHES = new Set([
  'e1a4cd6d87d43e10781ac79bf5ba33869a74304a3156c3a32ab1c70c05746066',
  '95c49caa682233197e515571de5962d3f4d55ec809f3cba236c63d730d104ead',
  '047f755c7398181395c273afed6bf65dc190435ca0073f7358b339ab11dc5047',
]);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const REQUIRED_NOTICE_FIELDS: Record<string, string> = {
  ASSET_NAME: 'Workbench Workflow',
  RIGHTS_BASIS: 'PROJECT_OWNER_ATTESTATION_IN_TASK',
  COMMERCIAL_REDISTRIBUTION: 'AUTHORIZED_FOR_THIS_ORIGINAL_PROJECT_ASSET',
  AUTHORIZATION_EVIDENCE: 'TASK15_USER_INSTRUCTION_2026-08-12',
  AUTHORIZATION_RECORD_LOCATION: 'EXTERNAL_TASK_CONVERSATION_NOT_REPOSITORY',
  AUTHORIZATION_TEXT_HASH: 'NOT_RECORDED',
  AUTHORIZING_IDENTITY: 'NOT_RECORDED_IN_REPOSITORY',
  ATTESTATION_SCOPE: 'APP_ICON_ONLY',
  LEGAL_CONCLUSION: 'NONE',
  LEGAL_REVIEW: 'NOT_COMPLETED',
  CREATOR_CONTRIBUTOR_ROLE: 'IMPLEMENTATION_AGENT_UNDER_PROJECT_OWNER_INSTRUCTION',
  COMMISSIONING_AUTHORIZING_ROLE: 'PROJECT_OWNER_IN_TASK',
  LEGACY_ASSET_DECISION: 'DO_NOT_COPY',
  LEGACY_ASSET_PROVENANCE: 'UNKNOWN',
  LEGACY_ASSET_RIGHTS: 'NOT_ESTABLISHED',
  LEGACY_PIXEL_INSPECTION_DURING_TASK2: 'NOT_PERFORMED',
  LEGACY_ASSET_REUSE: 'NONE',
  REFERENCE_IMAGES_USED_FOR_FINAL_ASSET: 'NONE',
  EXTERNAL_MATERIAL: 'NONE',
  NETWORK_ACCESS: 'NONE',
  ATTESTATION_LIMIT: 'NOT_A_SOFTWARE_LICENSE_PRODUCT_NAME_CLEARANCE_VENDOR_AUTHORIZATION_OR_PUBLIC_GA_LEGAL_APPROVAL',
  REVIEW_RESULT: 'NO_KNOWN_FORBIDDEN_MATCH',
};

interface DecodedPng {
  width: number;
  height: number;
  rgba: Buffer;
}

interface IcoFrame {
  size: number;
  bytes: Buffer;
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readChunks(png: Buffer): Array<{ type: string; data: Buffer }> {
  expect(png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)).toBe(true);
  const chunks: Array<{ type: string; data: Buffer }> = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    expect(dataEnd + 4).toBeLessThanOrEqual(png.length);
    chunks.push({ type, data: png.subarray(dataStart, dataEnd) });
    offset = dataEnd + 4;
  }
  expect(offset).toBe(png.length);
  return chunks;
}

function paeth(left: number, above: number, upperLeft: number): number {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function decodeRgbaPng(png: Buffer): DecodedPng {
  const chunks = readChunks(png);
  const ihdr = chunks.find(({ type }) => type === 'IHDR')?.data;
  expect(ihdr?.length).toBe(13);
  if (!ihdr) throw new Error('PNG is missing IHDR.');

  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  expect(ihdr[8]).toBe(8);
  expect(ihdr[9]).toBe(6);
  expect(ihdr[10]).toBe(0);
  expect(ihdr[11]).toBe(0);
  expect(ihdr[12]).toBe(0);

  const compressed = Buffer.concat(
    chunks.filter(({ type }) => type === 'IDAT').map(({ data }) => data),
  );
  const filtered = zlib.inflateSync(compressed);
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  expect(filtered.length).toBe((stride + 1) * height);

  const rgba = Buffer.alloc(width * height * bytesPerPixel);
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[y * (stride + 1) + x + 1];
      const outputOffset = y * stride + x;
      const left = x >= bytesPerPixel ? rgba[outputOffset - bytesPerPixel] : 0;
      const above = y > 0 ? rgba[outputOffset - stride] : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel
        ? rgba[outputOffset - stride - bytesPerPixel]
        : 0;
      switch (filter) {
        case 0:
          rgba[outputOffset] = raw;
          break;
        case 1:
          rgba[outputOffset] = (raw + left) & 0xff;
          break;
        case 2:
          rgba[outputOffset] = (raw + above) & 0xff;
          break;
        case 3:
          rgba[outputOffset] = (raw + Math.floor((left + above) / 2)) & 0xff;
          break;
        case 4:
          rgba[outputOffset] = (raw + paeth(left, above, upperLeft)) & 0xff;
          break;
        default:
          throw new Error(`Unsupported PNG filter ${filter}.`);
      }
    }
  }
  return { width, height, rgba };
}

function readIcoFrames(ico: Buffer): IcoFrame[] {
  expect(ico.length).toBeGreaterThanOrEqual(6);
  expect(ico.readUInt16LE(0)).toBe(0);
  expect(ico.readUInt16LE(2)).toBe(1);
  const count = ico.readUInt16LE(4);
  expect(count).toBe(REQUIRED_ICO_SIZES.length);
  expect(ico.length).toBeGreaterThanOrEqual(6 + count * 16);

  const frames: IcoFrame[] = [];
  let previousEnd = 6 + count * 16;
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const width = ico[entry] === 0 ? 256 : ico[entry];
    const height = ico[entry + 1] === 0 ? 256 : ico[entry + 1];
    expect(height).toBe(width);
    expect(ico[entry + 2]).toBe(0);
    expect(ico[entry + 3]).toBe(0);
    expect(ico.readUInt16LE(entry + 4)).toBe(1);
    expect(ico.readUInt16LE(entry + 6)).toBe(32);
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    expect(offset).toBeGreaterThanOrEqual(previousEnd);
    expect(offset + length).toBeLessThanOrEqual(ico.length);
    const bytes = ico.subarray(offset, offset + length);
    expect(bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)).toBe(true);
    const decoded = decodeRgbaPng(bytes);
    expect([decoded.width, decoded.height]).toEqual([width, height]);
    frames.push({ size: width, bytes });
    previousEnd = offset + length;
  }
  expect(previousEnd).toBe(ico.length);
  return frames;
}

function parseNotice(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (match) {
      expect(fields.has(match[1])).toBe(false);
      fields.set(match[1], match[2]);
    }
  }
  return fields;
}

function fileSnapshot(filePath: string): { hash: string; size: number; mtimeNs: bigint } {
  const stat = fs.statSync(filePath, { bigint: true });
  return {
    hash: sha256(fs.readFileSync(filePath)),
    size: Number(stat.size),
    mtimeNs: stat.mtimeNs,
  };
}

function spawnGenerator(arguments_: string[], timeout: number) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-icon-run-'));
  const result = spawnSync(ELECTRON_PATH, [GENERATOR_PATH, ...arguments_], {
    cwd: WORKSPACE,
    encoding: 'utf8',
    env: {
      SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
      WINDIR: process.env.WINDIR ?? 'C:\\Windows',
      TEMP: temporaryRoot,
      TMP: temporaryRoot,
    },
    timeout,
    windowsHide: true,
  });
  return { result, temporaryRoot };
}

function generatorUserDataEntries(temporaryRoot: string): string[] {
  return fs.readdirSync(temporaryRoot, { withFileTypes: true })
    .filter((entry) => /^claude-workbench-app-icon-generator-\d+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function expectGeneratorUserDataRemoved(temporaryRoot: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let entries = generatorUserDataEntries(temporaryRoot);
  while (entries.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    entries = generatorUserDataEntries(temporaryRoot);
  }
  expect(entries).toEqual([]);
}

describe.sequential('original application icon assets', () => {
  it('contains a constrained editable primitive SVG without external or vendor material', () => {
    const bytes = fs.readFileSync(SVG_PATH);
    const svg = bytes.toString('utf8');
    expect(Buffer.from(svg, 'utf8').equals(bytes)).toBe(true);
    expect(svg).not.toContain('\uFFFD');
    expect(svg).toMatch(/^<svg[\s\S]*<\/svg>\n$/u);
    expect(svg).toContain('viewBox="0 0 256 256"');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="Workbench workflow"');
    const referenceSurface = svg.replace('xmlns="http://www.w3.org/2000/svg"', '');
    expect(referenceSurface).not.toMatch(
      /anthropic|claude|openai|chatgpt|codex|microsoft|github|visual studio|<text\b|<image\b|<a\b|<script\b|<style\b|<defs\b|<use\b|<foreignObject\b|font-|(?:href|src)\s*=|url\s*\(|data:|https?:|transform\s*=|mask\s*=|filter\s*=/iu,
    );
    expect([...svg.matchAll(/<([a-z][\w:-]*)\b/giu)].map((match) => match[1]))
      .toEqual(['svg', 'rect', 'rect', 'path', 'path', 'rect', 'circle', 'path']);
    expect(svg.match(/<circle\b/gu)).toHaveLength(1);
    expect(svg.match(/<rect\b/gu)).toHaveLength(3);
    expect(svg.match(/<path\b/gu)).toHaveLength(3);
    expect(svg).not.toMatch(/<ellipse\b|<polygon\b|<polyline\b|<line\b|<g\b/iu);
    expect(
      svg.split('\n').filter((line) => /^  <(?:rect|path|circle)\b/u.test(line)),
    ).toEqual([
      '  <rect x="24" y="30" width="208" height="164" rx="30" fill="#0B1F3A"/>',
      '  <rect x="43" y="49" width="170" height="126" rx="20" fill="#F4FAFF"/>',
      '  <path d="M38 194h180a14 14 0 0 1 14 14v12H24v-12a14 14 0 0 1 14-14Z" fill="#123B73"/>',
      '  <path d="M78 105H128M128 105H178" stroke="#16B8C8" stroke-width="14" stroke-linecap="round"/>',
      '  <rect x="57" y="84" width="42" height="42" rx="11" fill="#1467E8"/>',
      '  <circle cx="128" cy="105" r="23" fill="#16B8C8"/>',
      '  <path d="m178 78 27 27-27 27-27-27Z" fill="#F2A51A"/>',
    ]);
    expect([...svg.matchAll(/(?:fill|stroke)="(#[0-9A-F]{6})"/gu)].map((match) => match[1]))
      .toEqual(['#0B1F3A', '#F4FAFF', '#123B73', '#16B8C8', '#1467E8', '#16B8C8', '#F2A51A']);
  });

  it('contains a 512px transparent PNG and every required PNG-compressed ICO frame', () => {
    const png = decodeRgbaPng(fs.readFileSync(PNG_PATH));
    expect([png.width, png.height]).toEqual([512, 512]);
    expect([...png.rgba.subarray(3).filter((_, index) => index % 4 === 0)])
      .toContain(0);

    const frames = readIcoFrames(fs.readFileSync(ICO_PATH));
    expect(frames.map(({ size }) => size)).toEqual(REQUIRED_ICO_SIZES);
  });

  it.each([16, 24, 32])(
    'keeps a centered recognizable foreground silhouette at %ipx',
    (size) => {
      const frame = readIcoFrames(fs.readFileSync(ICO_PATH)).find(
        (candidate) => candidate.size === size,
      );
      expect(frame).toBeDefined();
      if (!frame) return;
      const { rgba } = decodeRgbaPng(frame.bytes);
      const points: Array<[number, number]> = [];
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          if (rgba[(y * size + x) * 4 + 3] >= 8) points.push([x, y]);
        }
      }
      expect(points.length).toBeGreaterThanOrEqual(Math.ceil(size * size * 0.25));
      expect(points.length).toBeLessThanOrEqual(Math.floor(size * size * 0.90));
      const xs = points.map(([x]) => x);
      const ys = points.map(([, y]) => y);
      const bounds = {
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minY: Math.min(...ys),
        maxY: Math.max(...ys),
      };
      expect(bounds.maxX - bounds.minX + 1).toBeGreaterThanOrEqual(Math.floor(size * 0.7));
      expect(bounds.maxY - bounds.minY + 1).toBeGreaterThanOrEqual(Math.floor(size * 0.6));
      expect(Math.abs((bounds.minX + bounds.maxX) / 2 - (size - 1) / 2)).toBeLessThanOrEqual(1);
      expect(Math.abs((bounds.minY + bounds.maxY) / 2 - (size - 1) / 2)).toBeLessThanOrEqual(1.5);
      expect(rgba[(Math.floor(size / 2) * size + Math.floor(size / 2)) * 4 + 3])
        .toBeGreaterThan(0);
    },
  );

  it('does not reuse any rejected legacy hash', () => {
    const hashes = [SVG_PATH, PNG_PATH, ICO_PATH].map((filePath) => (
      sha256(fs.readFileSync(filePath))
    ));
    for (const hash of hashes) expect(REJECTED_LEGACY_HASHES.has(hash)).toBe(false);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('records complete scoped provenance and exact current asset hashes in UTF-8', () => {
    const bytes = fs.readFileSync(NOTICE_PATH);
    const notice = bytes.toString('utf8');
    expect(Buffer.from(notice, 'utf8').equals(bytes)).toBe(true);
    expect(notice).not.toContain('\uFFFD');
    expect(notice).toContain(
      '该图标为 Claude Workbench 项目自有的通用工作流图形，不是 Anthropic、OpenAI 或其他厂商的官方商标或品牌资产。',
    );
    expect(notice).toContain(
      'Three temporary AI direction sketches were viewed for high-level direction only; no pixels or paths were copied, traced, or packaged.',
    );
    expect(notice).toContain(
      'This record does not claim vendor authorization, endorsement, trademark clearance, or a legal conclusion.',
    );
    const fields = parseNotice(notice);
    for (const [field, expected] of Object.entries(REQUIRED_NOTICE_FIELDS)) {
      expect(fields.get(field), `${field} must carry its approved value`).toBe(expected);
    }
    for (const field of [
      'RECORD_DATE',
      'CREATION_DATE',
      'CREATION_METHOD',
      'CREATION_TOOL',
      'CREATION_TOOL_VERSION',
      'PROMPT_DISCLOSURE',
      'DIRECTION_SKETCH_DISCLOSURE',
      'USE_SITES',
      'REVIEWER_ROLE',
      'REVIEW_DATE',
      'REVIEW_SCOPE',
      'REVIEW_BINDING',
    ]) {
      expect(fields.get(field), `${field} must be recorded`).toBeTruthy();
    }
    expect(fields.get('USE_SITES')).toBe(
      'CANONICAL_EDITABLE_SOURCE=build-resources/app-icon.svg;WINDOW_RASTER_SOURCE=build-resources/app-icon.png;WINDOWS_EXECUTABLE_INSTALLER_UNINSTALLER_SHORTCUT_HEADER_SOURCE=build-resources/app-icon.ico;GENERATOR=scripts/generate-app-icons.mjs',
    );
    expect(fields.get('SVG_SHA256')).toBe(sha256(fs.readFileSync(SVG_PATH)));
    expect(fields.get('PNG_SHA256')).toBe(sha256(fs.readFileSync(PNG_PATH)));
    expect(fields.get('ICO_SHA256')).toBe(sha256(fs.readFileSync(ICO_PATH)));
    expect(fields.get('GENERATOR_SHA256')).toBe(sha256(fs.readFileSync(GENERATOR_PATH)));
    expect(fields.get('REVIEW_BINDING')).toBe(
      `SVG_SHA256=${fields.get('SVG_SHA256')};PNG_SHA256=${fields.get('PNG_SHA256')};ICO_SHA256=${fields.get('ICO_SHA256')}`,
    );
  });

  it('writes identical tracked derivatives and removes its private user-data', async () => {
    const originalPng = fs.readFileSync(PNG_PATH);
    const originalIco = fs.readFileSync(ICO_PATH);
    const { result, temporaryRoot } = spawnGenerator(['--write'], 60_000);
    try {
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('app-icon.png: WRITTEN');
      expect(result.stdout).toContain('app-icon.ico: WRITTEN');
      expect(fs.readFileSync(PNG_PATH)).toEqual(originalPng);
      expect(fs.readFileSync(ICO_PATH)).toEqual(originalIco);
      await expectGeneratorUserDataRemoved(temporaryRoot);
    } finally {
      fs.writeFileSync(PNG_PATH, originalPng);
      fs.writeFileSync(ICO_PATH, originalIco);
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 70_000);

  it('verifies regenerated bytes without writing tracked outputs and removes its private user-data', async () => {
    const before = new Map([
      [PNG_PATH, fileSnapshot(PNG_PATH)],
      [ICO_PATH, fileSnapshot(ICO_PATH)],
    ]);
    const { result, temporaryRoot } = spawnGenerator(['--verify'], 60_000);
    try {
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('app-icon.png: MATCH');
      expect(result.stdout).toContain('app-icon.ico: MATCH');
      expect(fileSnapshot(PNG_PATH)).toEqual(before.get(PNG_PATH));
      expect(fileSnapshot(ICO_PATH)).toEqual(before.get(ICO_PATH));
      await expectGeneratorUserDataRemoved(temporaryRoot);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 70_000);

  it('returns a failure for a real tracked PNG mismatch without rewriting either asset or retaining private user-data', async () => {
    const originalPng = fs.readFileSync(PNG_PATH);
    const originalIco = fs.readFileSync(ICO_PATH);
    const tamperedPng = Buffer.concat([originalPng, Buffer.from([0x00])]);
    fs.writeFileSync(PNG_PATH, tamperedPng);
    let temporaryRoot: string | undefined;

    try {
      const before = new Map([
        [PNG_PATH, fileSnapshot(PNG_PATH)],
        [ICO_PATH, fileSnapshot(ICO_PATH)],
      ]);
      const run = spawnGenerator(['--verify'], 60_000);
      const { result } = run;
      temporaryRoot = run.temporaryRoot;
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(result.stdout).toContain('app-icon.png: MISMATCH');
      expect(result.stdout).toContain('app-icon.ico: MATCH');
      expect(result.stderr).toBe('');
      expect(fileSnapshot(PNG_PATH)).toEqual(before.get(PNG_PATH));
      expect(fileSnapshot(ICO_PATH)).toEqual(before.get(ICO_PATH));
      await expectGeneratorUserDataRemoved(temporaryRoot);
    } finally {
      fs.writeFileSync(PNG_PATH, originalPng);
      expect(fs.readFileSync(PNG_PATH)).toEqual(originalPng);
      expect(fs.readFileSync(ICO_PATH)).toEqual(originalIco);
      if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 70_000);

  it('rejects an unsupported mode without touching tracked outputs or retaining private user-data', async () => {
    const before = new Map([
      [PNG_PATH, fileSnapshot(PNG_PATH)],
      [ICO_PATH, fileSnapshot(ICO_PATH)],
    ]);
    const { result, temporaryRoot } = spawnGenerator(['--unsupported'], 10_000);
    try {
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(result.stdout.trim()).toBe('');
      expect(result.stderr.trim()).toBe(
        'Usage: electron scripts/generate-app-icons.mjs --write|--verify',
      );
      expect(fileSnapshot(PNG_PATH)).toEqual(before.get(PNG_PATH));
      expect(fileSnapshot(ICO_PATH)).toEqual(before.get(ICO_PATH));
      await expectGeneratorUserDataRemoved(temporaryRoot);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 15_000);
});
