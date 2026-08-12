import type { IpcMain } from 'electron';
import type { ReleaseVersionInfo } from '../../src/shared/types/ipc';
import { registerClaudeIPC } from '../../src/main/ipc/claude';
import { registerDiagnosticsExportIPC } from '../../src/main/ipc/diagnostics';
import { registerFileChangesIPC } from '../../src/main/ipc/file-changes';
import { registerGitWorkspaceIPC } from '../../src/main/ipc/git-workspace';
import { registerHistoryIPC } from '../../src/main/ipc/history';
import { registerIntegrationsIPC } from '../../src/main/ipc/integrations';
import { registerModelProviderIPC } from '../../src/main/ipc/model-providers';
import { registerPermissionIPC } from '../../src/main/ipc/permissions';
import { registerProjectIPC } from '../../src/main/ipc/projects';
import { registerRecoveryIPC } from '../../src/main/ipc/recovery';
import { registerReleaseIPC } from '../../src/main/ipc/release';
import { registerSessionIPC } from '../../src/main/ipc/sessions';
import { registerSettingsIPC } from '../../src/main/ipc/settings';
import { registerSystemIPC } from '../../src/main/ipc/system';
import { registerTaskIPC } from '../../src/main/ipc/tasks';
import { registerTerminalIPC } from '../../src/main/ipc/terminal';
import { registerWorkflowIPC } from '../../src/main/ipc/workflows';
import type { PublicIpcRegistrar } from '../../src/main/ipc/public-invoke-boundary';
import type { TrustedRendererIPCDependencies } from '../../src/main/ipc/trusted-frame';

type AssertTrue<Value extends true> = Value;
type AssertFalse<Value extends false> = Value;
type IsExact<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
        (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;
type RegistrarIsExact<Register extends (...args: never[]) => unknown> =
  IsExact<Parameters<Register>[0], PublicIpcRegistrar>;

type RawRegistrarRejected = AssertFalse<IpcMain extends PublicIpcRegistrar ? true : false>;
type ClaudeExact = AssertTrue<RegistrarIsExact<typeof registerClaudeIPC>>;
type DiagnosticsExact = AssertTrue<RegistrarIsExact<typeof registerDiagnosticsExportIPC>>;
type FileChangesExact = AssertTrue<RegistrarIsExact<typeof registerFileChangesIPC>>;
type GitWorkspaceExact = AssertTrue<RegistrarIsExact<typeof registerGitWorkspaceIPC>>;
type HistoryExact = AssertTrue<RegistrarIsExact<typeof registerHistoryIPC>>;
type IntegrationsExact = AssertTrue<RegistrarIsExact<typeof registerIntegrationsIPC>>;
type ModelProvidersExact = AssertTrue<RegistrarIsExact<typeof registerModelProviderIPC>>;
type PermissionsExact = AssertTrue<RegistrarIsExact<typeof registerPermissionIPC>>;
type ProjectsExact = AssertTrue<RegistrarIsExact<typeof registerProjectIPC>>;
type RecoveryExact = AssertTrue<RegistrarIsExact<typeof registerRecoveryIPC>>;
type ReleaseExact = AssertTrue<RegistrarIsExact<typeof registerReleaseIPC>>;
type ReleaseDependencies = Parameters<typeof registerReleaseIPC>[1];
type ReleaseTrustRequired = AssertTrue<
  ReleaseDependencies extends TrustedRendererIPCDependencies ? true : false
>;
type ReleaseProjectionExact = AssertTrue<
  IsExact<Awaited<ReturnType<ReleaseDependencies['getVersionInfo']>>, ReleaseVersionInfo>
>;
type SessionsExact = AssertTrue<RegistrarIsExact<typeof registerSessionIPC>>;
type SettingsExact = AssertTrue<RegistrarIsExact<typeof registerSettingsIPC>>;
type SystemExact = AssertTrue<RegistrarIsExact<typeof registerSystemIPC>>;
type TasksExact = AssertTrue<RegistrarIsExact<typeof registerTaskIPC>>;
type TerminalExact = AssertTrue<RegistrarIsExact<typeof registerTerminalIPC>>;
type WorkflowsExact = AssertTrue<RegistrarIsExact<typeof registerWorkflowIPC>>;

export type PublicIpcRegistrarTypeGate = [
  RawRegistrarRejected,
  ClaudeExact,
  DiagnosticsExact,
  FileChangesExact,
  GitWorkspaceExact,
  HistoryExact,
  IntegrationsExact,
  ModelProvidersExact,
  PermissionsExact,
  ProjectsExact,
  RecoveryExact,
  ReleaseExact,
  ReleaseTrustRequired,
  ReleaseProjectionExact,
  SessionsExact,
  SettingsExact,
  SystemExact,
  TasksExact,
  TerminalExact,
  WorkflowsExact,
];
