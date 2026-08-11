export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  lastOpenedAt: string;
}

export interface ProjectSettings {
  projectId: string;
  displayName: string | null;
  defaultModel: string | null;
  defaultPermission: string | null;
  agentMode: 'normal' | 'plan' | 'develop' | 'review';
  favorite: boolean;
  disabledMcpServers: string[];
  updatedAt: string;
}

export interface ProjectInspection {
  claudeMdExists: boolean;
  mcpCount: number;
  skillCount: number;
  git: {
    branch: string | null;
    hasChanges: boolean;
    isRepo: boolean;
    ahead: number;
    behind: number;
  };
}
