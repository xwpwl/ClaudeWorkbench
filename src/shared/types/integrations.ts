export const REDACTED_INTEGRATION_VALUE = '[REDACTED]';

export type IntegrationSource = 'project' | 'user';

export type McpTransport = 'stdio' | 'http' | 'sse' | 'unknown';

export type McpIntegrationStatus = 'configured' | 'disabled' | 'invalid';

export interface IntegrationDiagnostic {
  source: IntegrationSource;
  path: string;
  code:
    | 'invalid_json'
    | 'invalid_config'
    | 'inaccessible'
    | 'outside_allowed_root'
    | 'too_large'
    | 'invalid_utf8'
    | 'symlink_escape';
  message: string;
}

/** A display-safe MCP configuration. Secret-bearing values are never exposed. */
export interface McpServerIntegration {
  id: string;
  name: string;
  source: IntegrationSource;
  configPath: string;
  status: McpIntegrationStatus;
  transport: McpTransport;
  command?: string;
  args: string[];
  url?: string;
  redactedEnv: Record<string, string>;
  error?: string;
}

export interface McpDiscoveryResult {
  servers: McpServerIntegration[];
  diagnostics: IntegrationDiagnostic[];
}

export interface McpTestResult {
  serverId: string;
  ok: boolean;
  checkedAt: string;
  message: string;
  /** Workbench performs a safe configuration probe and never executes config commands here. */
  probe: 'configuration';
}

export type SkillIntegrationStatus =
  | 'available'
  | 'too_large'
  | 'invalid_utf8'
  | 'inaccessible';

export interface SkillIntegration {
  id: string;
  name: string;
  description?: string;
  source: IntegrationSource;
  rootPath: string;
  skillPath: string;
  status: SkillIntegrationStatus;
  sizeBytes: number;
  error?: string;
}

export interface SkillDocument extends SkillIntegration {
  /** UTF-8 content loaded on demand. There is intentionally no write API. */
  content: string;
}

export interface SkillDiscoveryResult {
  skills: SkillIntegration[];
  diagnostics: IntegrationDiagnostic[];
}
