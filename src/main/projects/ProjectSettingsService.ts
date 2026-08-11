import type { ProjectSettings } from '../../shared/types/project';
import type { AppDatabase, ProjectSettingsRow } from '../database/Database';

export function projectSettingsView(row: ProjectSettingsRow): ProjectSettings {
  return {
    projectId: row.project_id,
    displayName: row.display_name,
    defaultModel: row.default_model,
    defaultPermission: row.default_permission,
    agentMode: ['normal', 'plan', 'develop', 'review'].includes(row.agent_mode)
      ? row.agent_mode as ProjectSettings['agentMode']
      : 'normal',
    favorite: row.favorite,
    disabledMcpServers: [...row.disabled_mcp_servers],
    updatedAt: row.updated_at,
  };
}

export function ensureProjectSettings(
  database: AppDatabase,
  projectId: string,
): ProjectSettingsRow {
  return database.getProjectSettings(projectId) ?? database.setProjectSettings(projectId, {});
}

