import { create } from 'zustand';
import type { Project, ProjectSettings } from '../../shared/types/project';
import type { EnvironmentCheckResult, ConnectionStatus, ClaudeTestResult, DiagnosticsInfo } from '../../shared/types/ipc';
import type { UIPermissionMode } from '../../shared/types/claude';
import type { Locale } from '../i18n';

interface AppState {
  // Current project
  currentProject: Project | null;
  setCurrentProject: (project: Project | null) => void;
  currentProjectSettings: ProjectSettings | null;
  setCurrentProjectSettings: (settings: ProjectSettings | null) => void;

  // Claude installation status
  claudeInstalled: boolean;
  setClaudeInstalled: (installed: boolean) => void;

  // Environment check
  environmentCheck: EnvironmentCheckResult | null;
  setEnvironmentCheck: (result: EnvironmentCheckResult | null) => void;

  // UI state
  isRunning: boolean;
  setIsRunning: (running: boolean) => void;

  // Current model (empty string = follow Claude Code default)
  currentModel: string;
  setCurrentModel: (model: string) => void;

  // Detected model from system/init event
  detectedModel: string;
  setDetectedModel: (model: string) => void;

  // Model source
  modelSource: 'claude-default' | 'environment' | 'custom' | 'session';
  setModelSource: (source: 'claude-default' | 'environment' | 'custom' | 'session') => void;

  // Permission mode (UI value)
  permissionMode: UIPermissionMode;
  setPermissionMode: (mode: UIPermissionMode) => void;

  // Workbench application-layer Agent policy
  agentMode: 'normal' | 'plan' | 'develop' | 'review';
  setAgentMode: (mode: 'normal' | 'plan' | 'develop' | 'review') => void;

  // Show dangerous permissions
  showDangerousPermissions: boolean;
  setShowDangerousPermissions: (show: boolean) => void;

  // Connection status
  connectionStatus: ConnectionStatus | null;
  setConnectionStatus: (status: ConnectionStatus | null) => void;

  // Claude test result
  claudeTestResult: ClaudeTestResult | null;
  setClaudeTestResult: (result: ClaudeTestResult | null) => void;

  // Diagnostics
  diagnosticsInfo: DiagnosticsInfo | null;
  setDiagnosticsInfo: (info: DiagnosticsInfo | null) => void;

  // Theme
  theme: 'light' | 'dark' | 'system';
  setTheme: (theme: 'light' | 'dark' | 'system') => void;

  // Locale
  locale: Locale;
  setLocale: (locale: Locale) => void;

  // UI panels
  showSidebar: boolean;
  toggleSidebar: () => void;
  showTerminal: boolean;
  toggleTerminal: () => void;
  showFileDrawer: boolean;
  toggleFileDrawer: () => void;

  // Settings dialog
  showSettings: boolean;
  setShowSettings: (show: boolean) => void;
  showEnvCheck: boolean;
  setShowEnvCheck: (show: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  currentProject: null,
  setCurrentProject: (project) => set({ currentProject: project }),
  currentProjectSettings: null,
  setCurrentProjectSettings: (currentProjectSettings) => set({ currentProjectSettings }),

  claudeInstalled: false,
  setClaudeInstalled: (installed) => set({ claudeInstalled: installed }),

  environmentCheck: null,
  setEnvironmentCheck: (result) => set({ environmentCheck: result }),

  isRunning: false,
  setIsRunning: (running) => set({ isRunning: running }),

  currentModel: '',
  setCurrentModel: (model) => set({ currentModel: model }),

  detectedModel: '',
  setDetectedModel: (model) => set({ detectedModel: model }),

  modelSource: 'claude-default',
  setModelSource: (source) => set({ modelSource: source }),

  permissionMode: 'standard',
  setPermissionMode: (mode) => set({ permissionMode: mode }),

  agentMode: 'normal',
  setAgentMode: (agentMode) => set({ agentMode }),

  showDangerousPermissions: false,
  setShowDangerousPermissions: (show) => set({ showDangerousPermissions: show }),

  connectionStatus: null,
  setConnectionStatus: (status) => set({ connectionStatus: status }),

  claudeTestResult: null,
  setClaudeTestResult: (result) => set({ claudeTestResult: result }),

  diagnosticsInfo: null,
  setDiagnosticsInfo: (info) => set({ diagnosticsInfo: info }),

  theme: 'light',
  setTheme: (theme) => set({ theme }),

  locale: 'zh-CN',
  setLocale: (locale) => set({ locale }),

  showSidebar: true,
  toggleSidebar: () => set((state) => ({ showSidebar: !state.showSidebar })),
  showTerminal: false,
  toggleTerminal: () => set((state) => ({ showTerminal: !state.showTerminal })),
  showFileDrawer: false,
  toggleFileDrawer: () => set((state) => ({ showFileDrawer: !state.showFileDrawer })),

  showSettings: false,
  setShowSettings: (show) => set({ showSettings: show }),
  showEnvCheck: false,
  setShowEnvCheck: (show) => set({ showEnvCheck: show }),
}));
