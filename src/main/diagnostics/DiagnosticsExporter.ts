import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { redactText, redactValue, structuredLoggerInternals } from '../logging/StructuredLogger';

export interface DiagnosticsDatabaseSummary {
  schemaVersion: number;
  sizeBytes: number;
  journalMode: string;
  integrity: 'ok' | 'failed' | 'unknown';
  counts: Record<string, number>;
}

export interface DiagnosticsExportInput {
  destinationPath: string;
  version: Record<string, unknown>;
  system: Record<string, unknown>;
  database: DiagnosticsDatabaseSummary;
  createdAt?: string;
  includeAnonymousPerformanceData?: boolean;
  anonymousPerformanceData?: unknown;
}

export interface DiagnosticsExporterOptions {
  maxLogBytes?: number;
  readFile?: typeof fs.promises.readFile;
  writeFile?: typeof fs.promises.writeFile;
}

interface ZipEntry {
  name: string;
  content: Buffer;
}

const aggregateCount = z.number().int().min(0).max(2_147_483_647);
const operationCountsSchema = z.object({
  total: aggregateCount,
  completed: aggregateCount,
  failed: aggregateCount,
  cancelled: aggregateCount,
  interrupted: aggregateCount,
}).strict().superRefine((value, context) => {
  const terminal = value.completed + value.failed + value.cancelled + value.interrupted;
  if (terminal > value.total) context.addIssue({ code: z.ZodIssueCode.custom });
});
const anonymousPerformanceSourceSchema = z.object({
  operations: z.object({
    direct: operationCountsSchema,
    orchestrated: operationCountsSchema,
  }).strict(),
  durationBuckets: z.object({
    underOneSecond: aggregateCount,
    oneToTenSeconds: aggregateCount,
    tenToSixtySeconds: aggregateCount,
    oneToTenMinutes: aggregateCount,
    tenMinutesOrMore: aggregateCount,
  }).strict(),
}).strict();
const anonymousPerformanceOutputSchema = z.object({
  schemaVersion: z.literal(1),
  operations: anonymousPerformanceSourceSchema.shape.operations,
  durationBuckets: anonymousPerformanceSourceSchema.shape.durationBuckets,
}).strict();

export type AnonymousPerformanceSource = z.infer<typeof anonymousPerformanceSourceSchema>;
export type AnonymousPerformanceAggregate = z.infer<typeof anonymousPerformanceOutputSchema>;

function projectAnonymousPerformanceData(input: unknown): AnonymousPerformanceAggregate {
  const parsed = anonymousPerformanceSourceSchema.safeParse(input);
  if (!parsed.success) throw new Error('Anonymous performance data is unavailable.');
  const output = anonymousPerformanceOutputSchema.safeParse({
    schemaVersion: 1,
    operations: {
      direct: { ...parsed.data.operations.direct },
      orchestrated: { ...parsed.data.operations.orchestrated },
    },
    durationBuckets: { ...parsed.data.durationBuckets },
  });
  if (!output.success) throw new Error('Anonymous performance data is unavailable.');
  return output.data;
}

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(content: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of content) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(entries: readonly ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/gu, '/'), 'utf8');
    const checksum = crc32(entry.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.content.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, entry.content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.content.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + entry.content.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function jsonEntry(name: string, value: unknown): ZipEntry {
  return {
    name,
    content: Buffer.from(`${JSON.stringify(redactValue(value), null, 2)}\n`, 'utf8'),
  };
}

function sanitizeJsonLines(raw: string): string {
  return raw
    .split(/\r?\n/gu)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.stringify(redactValue(JSON.parse(line) as unknown));
      } catch {
        return redactText(line);
      }
    })
    .join('\n');
}

function errorSummary(raw: string): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const line of raw.split(/\r?\n/gu).filter(Boolean).slice(-100)) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      result.push({
        timestamp: record.timestamp,
        level: record.level,
        event: record.event,
      });
    } catch {
      result.push({ event: 'unstructured-error-log-entry' });
    }
  }
  return result;
}

function safeTimestamp(value: string): string {
  return value.replace(/[:.]/gu, '-').replace(/[^0-9TZ-]/gu, '');
}

export class DiagnosticsExporter {
  private readonly maxLogBytes: number;
  private readonly readFile: typeof fs.promises.readFile;
  private readonly writeFile: typeof fs.promises.writeFile;

  constructor(
    private readonly logsDirectory: string,
    options: DiagnosticsExporterOptions = {},
  ) {
    this.maxLogBytes = Math.max(64 * 1024, options.maxLogBytes ?? 1024 * 1024);
    this.readFile = options.readFile ?? fs.promises.readFile.bind(fs.promises);
    this.writeFile = options.writeFile ?? fs.promises.writeFile.bind(fs.promises);
  }

  async export(input: DiagnosticsExportInput): Promise<string> {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const includeAnonymousPerformanceData = input.includeAnonymousPerformanceData === true;
    const anonymousPerformanceData = includeAnonymousPerformanceData
      ? projectAnonymousPerformanceData(input.anonymousPerformanceData)
      : null;
    const destination = path.resolve(input.destinationPath);
    const outputPath = path.extname(destination).toLocaleLowerCase('en-US') === '.zip'
      ? destination
      : path.join(destination, `ClaudeWorkbench-diagnostics-${safeTimestamp(createdAt)}.zip`);
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

    const entries: ZipEntry[] = [
      jsonEntry('manifest.json', {
        format: 'claude-workbench-diagnostics',
        formatVersion: 1,
        createdAt,
        includeAnonymousPerformanceData,
        privacy: 'Only allowlisted, redacted local diagnostics are included.',
      }),
      jsonEntry('version.json', input.version),
      jsonEntry('system.json', input.system),
      jsonEntry('database-summary.json', input.database),
    ];
    if (anonymousPerformanceData) {
      entries.push(jsonEntry('anonymous-performance.json', anonymousPerformanceData));
    }
    let errors = '';
    for (const category of structuredLoggerInternals.categories) {
      const filePath = path.join(this.logsDirectory, `${category}.log`);
      let raw: Buffer;
      try {
        raw = await this.readFile(filePath) as Buffer;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const tail = raw.subarray(Math.max(0, raw.length - this.maxLogBytes)).toString('utf8');
      const sanitized = sanitizeJsonLines(tail);
      entries.push({ name: `logs/${category}.log`, content: Buffer.from(`${sanitized}\n`, 'utf8') });
      if (category === 'error') errors = sanitized;
    }
    entries.push(jsonEntry('error-summary.json', errorSummary(errors)));
    await this.writeFile(outputPath, zipStore(entries), { mode: 0o600 });
    return outputPath;
  }
}

export const diagnosticsExporterInternals = {
  crc32,
  errorSummary,
  sanitizeJsonLines,
  projectAnonymousPerformanceData,
  zipStore,
};
