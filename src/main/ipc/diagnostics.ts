import path from 'node:path';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type {
  DiagnosticsDatabaseSummary,
  DiagnosticsExporter,
} from '../diagnostics/DiagnosticsExporter';
import { assertTrustedMainFrame, type TrustedRendererIPCDependencies } from './trusted-frame';
import type { PublicIpcRegistrar } from './public-invoke-boundary';

export interface DiagnosticsExportDependencies extends TrustedRendererIPCDependencies {
  exporter: DiagnosticsExporter;
  chooseDestination(defaultName: string): Promise<string | null>;
  version(): Record<string, unknown> | Promise<Record<string, unknown>>;
  system(): Record<string, unknown> | Promise<Record<string, unknown>>;
  database(): DiagnosticsDatabaseSummary | Promise<DiagnosticsDatabaseSummary>;
  anonymousPerformance(): unknown | Promise<unknown>;
  now?: () => Date;
}

const exportIntentTuple = z.tuple([
  z.object({ includeAnonymousPerformanceData: z.boolean() }).strict(),
]);

function fileName(date: Date): string {
  const timestamp = date.toISOString().replace(/[:.]/gu, '-');
  return `ClaudeWorkbench-diagnostics-${timestamp}.zip`;
}

export function registerDiagnosticsExportIPC(
  ipcMain: PublicIpcRegistrar,
  dependencies: DiagnosticsExportDependencies,
): () => void {
  ipcMain.handle(IPC_CHANNELS.SYSTEM_EXPORT_DIAGNOSTICS, async (event, ...args) => {
    assertTrustedMainFrame(
      event,
      dependencies,
      'Diagnostics IPC requires the trusted main frame.',
    );
    const parsed = exportIntentTuple.safeParse(args);
    if (!parsed.success) throw new Error('Invalid diagnostics export request.');
    const { includeAnonymousPerformanceData } = parsed.data[0];
    try {
      const now = (dependencies.now ?? (() => new Date()))();
      const selected = await dependencies.chooseDestination(fileName(now));
      if (!selected) return null;
      const destination = path.extname(selected).toLocaleLowerCase('en-US') === '.zip'
        ? selected
        : `${selected}.zip`;
      const [version, system, database, anonymousPerformanceData] = await Promise.all([
        dependencies.version(),
        dependencies.system(),
        dependencies.database(),
        includeAnonymousPerformanceData ? dependencies.anonymousPerformance() : undefined,
      ]);
      await dependencies.exporter.export({
        destinationPath: destination,
        version,
        system,
        database,
        createdAt: now.toISOString(),
        includeAnonymousPerformanceData,
        anonymousPerformanceData,
      });
      return true;
    } catch {
      throw new Error('Unable to export diagnostics.');
    }
  });
  return () => ipcMain.removeHandler(IPC_CHANNELS.SYSTEM_EXPORT_DIAGNOSTICS);
}

export const diagnosticsIpcInternals = { fileName };
