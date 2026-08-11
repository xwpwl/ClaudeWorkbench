import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { McpDiscoveryResult, SkillIntegration } from '../../shared/types/integrations';
import type { AppDatabase } from '../database/Database';
import { McpDiscoveryService } from '../integrations/McpDiscoveryService';
import { SkillDiscoveryService } from '../integrations/SkillDiscoveryService';
import { canonicalizeProjectPath } from '../projects/ProjectService';
import { ensureProjectSettings, projectSettingsView } from '../projects/ProjectSettingsService';
import type { PublicIpcRegistrar } from './public-invoke-boundary';

function registeredProjectPath(
  database: AppDatabase,
  projectId: string,
  claimedPath: string,
): string {
  const project = database.getProject(projectId);
  if (!project) throw new Error('项目索引不存在');
  const stored = canonicalizeProjectPath(project.path).canonicalPath;
  const claimed = canonicalizeProjectPath(claimedPath).canonicalPath;
  if (stored !== claimed) throw new Error('项目路径与索引不匹配');
  return project.path;
}

function applyWorkbenchMcpState(
  result: McpDiscoveryResult,
  disabledNames: readonly string[],
): McpDiscoveryResult {
  const disabled = new Set(disabledNames.map((name) => name.toLocaleLowerCase()));
  return {
    ...result,
    servers: result.servers.map((server) => (
      server.status !== 'invalid' && disabled.has(server.name.toLocaleLowerCase())
        ? { ...server, status: 'disabled' as const }
        : server
    )),
  };
}

export function registerIntegrationsIPC(
  ipcMain: PublicIpcRegistrar,
  database: AppDatabase,
): void {
  const mcp = new McpDiscoveryService();
  const skills = new SkillDiscoveryService();

  ipcMain.handle(
    IPC_CHANNELS.INTEGRATIONS_DISCOVER_MCP,
    (_event, projectId: string, projectPath: string) => {
      const safePath = registeredProjectPath(database, projectId, projectPath);
      const settings = ensureProjectSettings(database, projectId);
      return applyWorkbenchMcpState(mcp.discover(safePath), settings.disabled_mcp_servers);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.INTEGRATIONS_DISCOVER_SKILLS,
    (_event, projectId: string, projectPath: string) => {
      const safePath = registeredProjectPath(database, projectId, projectPath);
      return skills.discover(safePath);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.INTEGRATIONS_READ_SKILL,
    (_event, projectId: string, projectPath: string, skill: SkillIntegration) => {
      const safePath = registeredProjectPath(database, projectId, projectPath);
      return skills.readSkill(safePath, skill);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.INTEGRATIONS_SET_MCP_ENABLED,
    (_event, projectId: string, serverName: string, enabled: boolean) => {
      const project = database.getProject(projectId);
      if (!project) throw new Error('项目索引不存在');
      const settings = ensureProjectSettings(database, projectId);
      const normalized = serverName.trim().toLocaleLowerCase();
      if (!normalized) throw new Error('MCP 名称不能为空');
      const discoveredNames = new Set(
        mcp.discover(project.path).servers.map((server) => server.name.toLocaleLowerCase()),
      );
      const alreadyDisabled = settings.disabled_mcp_servers.some(
        (name) => name.toLocaleLowerCase() === normalized,
      );
      if (!discoveredNames.has(normalized) && !alreadyDisabled) {
        throw new Error('MCP 配置不存在');
      }
      const disabledMcpServers = enabled
        ? settings.disabled_mcp_servers.filter((name) => name.toLocaleLowerCase() !== normalized)
        : [...settings.disabled_mcp_servers.filter((name) => name.toLocaleLowerCase() !== normalized), serverName.trim()];
      return projectSettingsView(database.setProjectSettings(projectId, {
        disabled_mcp_servers: disabledMcpServers,
      }));
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.INTEGRATIONS_TEST_MCP,
    (_event, projectId: string, projectPath: string, serverId: string) => {
      const safePath = registeredProjectPath(database, projectId, projectPath);
      const settings = ensureProjectSettings(database, projectId);
      const result = applyWorkbenchMcpState(
        mcp.discover(safePath),
        settings.disabled_mcp_servers,
      );
      const server = result.servers.find((candidate) => candidate.id === serverId);
      const ok = Boolean(server && server.status === 'configured');
      return {
        serverId,
        ok,
        checkedAt: new Date().toISOString(),
        message: !server
          ? '未找到 MCP 配置'
          : server.status === 'configured'
            ? '配置格式有效；出于安全考虑，测试不会执行 MCP 命令'
            : server.status === 'disabled'
              ? 'MCP 当前已禁用'
              : server.error || 'MCP 配置无效',
        probe: 'configuration' as const,
      };
    },
  );
}

export const integrationsIpcInternals = { applyWorkbenchMcpState, registeredProjectPath };
