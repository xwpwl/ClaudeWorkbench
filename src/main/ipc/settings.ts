import type { AppDatabase } from '../database/Database';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { FIRST_RUN_RESUME_STEPS, type AppSettings } from '../../shared/types/ipc';
import type { UIPermissionMode } from '../../shared/types/claude';
import { LEGACY_PERMISSION_MAP } from '../../shared/types/claude';
import { z } from 'zod';
import { assertTrustedMainFrame, type TrustedRendererIPCDependencies } from './trusted-frame';
import type { PublicIpcRegistrar } from './public-invoke-boundary';

const FIRST_RUN_COMPLETED_VERSION_KEY = 'firstRunCompletedVersion';
const FIRST_RUN_RESUME_STEP_KEY = 'firstRunResumeStep';
const firstRunResumeStepSchema = z.enum(FIRST_RUN_RESUME_STEPS);

const DEFAULT_SETTINGS: AppSettings = {
  // Claude Code
  claudePath: 'claude',
  autoDetectClaude: true,
  claudeGitBashPath: '',

  // Model
  defaultModel: '',
  detectedModel: '',
  modelSource: 'claude-default',

  // Permissions
  defaultPermissionMode: 'standard',
  showDangerousPermissions: false,

  // Tools
  gitPath: 'git',
  vscodePath: 'code',

  // Terminal
  terminalShell: 'powershell',

  // Appearance
  theme: 'light',
  fontSize: 14,
  language: 'zh-CN',

  // Data
  dataPath: '',

  // Updates
  autoCheckUpdates: false,
};

const boundedString = z.string().max(4_096);
const settingsUpdateSchema = z.object({
  claudePath: boundedString,
  autoDetectClaude: z.boolean(),
  claudeGitBashPath: boundedString,
  defaultModel: z.string().max(256),
  detectedModel: z.string().max(256),
  modelSource: z.enum(['claude-default', 'environment', 'custom', 'session']),
  defaultPermissionMode: z.enum(['standard', 'accept-edits', 'plan', 'bypass']),
  showDangerousPermissions: z.boolean(),
  gitPath: boundedString,
  vscodePath: boundedString,
  terminalShell: z.enum(['powershell', 'powershell7', 'cmd', 'git-bash', 'wsl']),
  theme: z.enum(['dark', 'light', 'system']),
  fontSize: z.number().int().min(8).max(64),
  language: z.enum(['zh-CN', 'en-US']),
  dataPath: boundedString,
  autoCheckUpdates: z.boolean(),
}).strict().partial();

/**
 * Migrate legacy permission mode values to the new UIPermissionMode format.
 */
function migratePermissionMode(value: string): UIPermissionMode {
  if (value in LEGACY_PERMISSION_MAP) {
    return LEGACY_PERMISSION_MAP[value];
  }
  return 'standard';
}

export function registerSettingsIPC(
  ipcMain: PublicIpcRegistrar,
  db: AppDatabase,
  trustedRenderer: TrustedRendererIPCDependencies,
): void {
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async () => {
    const stored = db.getAllSettings();
    const settings: AppSettings = { ...DEFAULT_SETTINGS };

    for (const [key, value] of Object.entries(stored)) {
      if (!(key in settings)) continue;
      const k = key as keyof AppSettings;
      const defaultVal = settings[k];

      if (typeof defaultVal === 'number') {
        (settings as unknown as Record<string, unknown>)[k] = Number(value);
      } else if (typeof defaultVal === 'boolean') {
        (settings as unknown as Record<string, unknown>)[k] = value === 'true';
      } else if (k === 'defaultPermissionMode') {
        // Migrate legacy permission mode values
        (settings as unknown as Record<string, unknown>)[k] = migratePermissionMode(value);
      } else {
        (settings as unknown as Record<string, unknown>)[k] = value;
      }
    }

    return settings;
  });

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_SET,
    async (_event, input: unknown) => {
      if (
        input !== null
        && typeof input === 'object'
        && Object.prototype.hasOwnProperty.call(input, 'autoCheckUpdates')
        && typeof (input as Record<string, unknown>).autoCheckUpdates !== 'boolean'
      ) {
        throw new Error('autoCheckUpdates must be a boolean.');
      }
      const parsed = settingsUpdateSchema.safeParse(input);
      if (!parsed.success) {
        throw new Error('Unsupported or invalid settings payload.');
      }
      const partial: Partial<AppSettings> = parsed.data;
      for (const [key, value] of Object.entries(partial)) {
        if (value !== undefined) {
          db.setSetting(key, String(value));
        }
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.FIRST_RUN_GET_COMPLETED_VERSION, async (event, ...args) => {
    assertTrustedMainFrame(event, trustedRenderer);
    if (!z.tuple([]).safeParse(args).success) {
      throw new Error('Invalid first-run completion request.');
    }
    const stored = db.getSetting(FIRST_RUN_COMPLETED_VERSION_KEY);
    if (stored === null || !/^(0|[1-9]\d*)$/u.test(stored)) return 0;
    const version = Number(stored);
    return Number.isSafeInteger(version) && version >= 0 ? version : 0;
  });

  ipcMain.handle(IPC_CHANNELS.FIRST_RUN_SET_COMPLETED_VERSION, async (event, ...args) => {
    assertTrustedMainFrame(event, trustedRenderer);
    const parsed = z.tuple([z.literal(1)]).safeParse(args);
    if (!parsed.success) throw new Error('Invalid first-run completion version.');
    db.setSetting(FIRST_RUN_COMPLETED_VERSION_KEY, '1');
  });

  ipcMain.handle(IPC_CHANNELS.FIRST_RUN_GET_RESUME_STEP, async (event, ...args) => {
    assertTrustedMainFrame(event, trustedRenderer);
    if (!z.tuple([]).safeParse(args).success) {
      throw new Error('Invalid first-run resume request.');
    }
    const parsed = firstRunResumeStepSchema.safeParse(db.getSetting(FIRST_RUN_RESUME_STEP_KEY));
    return parsed.success ? parsed.data : 'welcome';
  });

  ipcMain.handle(IPC_CHANNELS.FIRST_RUN_SET_RESUME_STEP, async (event, ...args) => {
    assertTrustedMainFrame(event, trustedRenderer);
    const parsed = z.tuple([firstRunResumeStepSchema]).safeParse(args);
    if (!parsed.success) throw new Error('Invalid first-run resume step.');
    db.setSetting(FIRST_RUN_RESUME_STEP_KEY, parsed.data[0]);
  });
}
