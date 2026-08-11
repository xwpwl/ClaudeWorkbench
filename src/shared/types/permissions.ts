import type { UIPermissionMode } from './claude';

export interface PermissionPreset {
  id: UIPermissionMode;
  name: string;
  description: string;
  allowedTools: string[];
  disallowedTools: string[];
}

export const PERMISSION_PRESETS: PermissionPreset[] = [
  {
    id: 'plan',
    name: 'Plan',
    description: 'Read-only analysis. No file modifications or command execution.',
    allowedTools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
    disallowedTools: [
      'Write',
      'Edit',
      'Bash',
      'NotebookEdit',
      'Agent',
    ],
  },
  {
    id: 'standard',
    name: 'Standard',
    description:
      'Reads are automatic. File edits, commands, installs, and deletes require confirmation.',
    allowedTools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
    disallowedTools: [],
  },
  {
    id: 'accept-edits',
    name: 'Accept Edits',
    description:
      'File edits are automatic. Commands are checked against an allowlist. Dangerous operations still need confirmation.',
    allowedTools: [
      'Read',
      'Glob',
      'Grep',
      'WebSearch',
      'WebFetch',
      'Write',
      'Edit',
      'NotebookEdit',
    ],
    disallowedTools: [],
  },
  {
    id: 'bypass',
    name: 'Bypass Permissions',
    description: 'Skip all permission prompts. Dangerous.',
    allowedTools: [],
    disallowedTools: [],
  },
];

/** Dangerous command patterns that always require confirmation */
export const DANGEROUS_COMMANDS = [
  'rm ',
  'rm\t',
  'rmdir ',
  'del ',
  'format ',
  'diskpart',
  'shutdown',
  'reboot',
  'git reset --hard',
  'git clean',
  'git push --force',
  'git push -f',
  'git checkout -- .',
  'Remove-Item -Recurse',
  'Remove-Item -r',
  'npm publish',
  'pnpm publish',
  'yarn publish',
  'npx ',
];

export interface CustomPermissionConfig {
  allowedTools: string[];
  disallowedTools: string[];
  autoAllowCommandPrefixes: string[];
  alwaysAskCommands: string[];
  allowedDirectories: string[];
  allowNetworkAccess: boolean;
}
