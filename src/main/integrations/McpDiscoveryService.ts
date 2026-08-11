import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  REDACTED_INTEGRATION_VALUE,
  type IntegrationDiagnostic,
  type IntegrationSource,
  type McpDiscoveryResult,
  type McpServerIntegration,
  type McpTransport,
} from '../../shared/types/integrations';

const DEFAULT_MAX_CONFIG_BYTES = 1024 * 1024;
const SENSITIVE_KEY = /(?:api[_-]?key|token|secret|password|passwd|auth|authorization|credential|cookie|private[_-]?key)/i;
const SENSITIVE_FLAG = /^(?:--?(?:api[-_]?key|token|secret|password|passwd|auth|authorization|credential|cookie|header)|-H)$/i;
const INLINE_SENSITIVE_FLAG = /^((?:--?(?:api[-_]?key|token|secret|password|passwd|auth|authorization|credential|cookie|header)|-H))(?:=|:)(.*)$/i;
const INLINE_SENSITIVE_ASSIGNMENT = /^([^=]*(?:api[_-]?key|token|secret|password|passwd|auth|authorization|credential|cookie|private[_-]?key)[^=]*)=(.*)$/i;
const SECRET_SHAPE = /(?:\bBearer\s+\S+|\b(?:sk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,})/gi;

interface McpDiscoveryOptions {
  userHome?: string;
  maxConfigBytes?: number;
}

interface ConfigCandidate {
  filePath: string;
  source: IntegrationSource;
  priority: number;
  allowedRoot: string;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
}

function redactUrl(value: string): string {
  let output = value.replace(SECRET_SHAPE, REDACTED_INTEGRATION_VALUE);
  try {
    const parsed = new URL(output);
    if (parsed.username) parsed.username = REDACTED_INTEGRATION_VALUE;
    if (parsed.password) parsed.password = REDACTED_INTEGRATION_VALUE;
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key)) parsed.searchParams.set(key, REDACTED_INTEGRATION_VALUE);
    }
    output = parsed.toString();
  } catch {
    output = output.replace(
      /([?&](?:api[_-]?key|token|secret|password|auth|credential)=)[^&\s]+/gi,
      `$1${REDACTED_INTEGRATION_VALUE}`,
    );
  }
  return output;
}

function redactScalar(value: string): string {
  if (SECRET_SHAPE.test(value)) {
    SECRET_SHAPE.lastIndex = 0;
    return value.replace(SECRET_SHAPE, REDACTED_INTEGRATION_VALUE);
  }
  SECRET_SHAPE.lastIndex = 0;
  return redactUrl(value);
}

/** Returns display-safe arguments. The original array is never mutated. */
export function redactMcpArguments(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  let redactNext = false;

  for (const item of value) {
    const argument = typeof item === 'string' ? item : String(item);
    if (redactNext) {
      result.push(REDACTED_INTEGRATION_VALUE);
      redactNext = false;
      continue;
    }
    if (SENSITIVE_FLAG.test(argument)) {
      result.push(argument);
      redactNext = true;
      continue;
    }
    const inline = argument.match(INLINE_SENSITIVE_FLAG);
    if (inline) {
      result.push(`${inline[1]}=${REDACTED_INTEGRATION_VALUE}`);
      continue;
    }
    const assignment = argument.match(INLINE_SENSITIVE_ASSIGNMENT);
    if (assignment) {
      result.push(`${assignment[1]}=${REDACTED_INTEGRATION_VALUE}`);
      continue;
    }
    result.push(redactScalar(argument));
  }

  return result;
}

/** Returns display-safe environment values while retaining useful non-secret metadata. */
export function redactMcpEnvironment(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const stringValue = typeof rawValue === 'string' ? rawValue : String(rawValue);
    result[key] = SENSITIVE_KEY.test(key)
      ? REDACTED_INTEGRATION_VALUE
      : redactScalar(stringValue);
  }
  return result;
}

function transportOf(config: UnknownRecord): McpTransport {
  const declared = typeof config.type === 'string' ? config.type.toLocaleLowerCase() : '';
  if (declared === 'sse') return 'sse';
  if (declared === 'http' || declared === 'streamable-http') return 'http';
  if (declared === 'stdio' || typeof config.command === 'string') return 'stdio';
  if (typeof config.url === 'string') return 'http';
  return 'unknown';
}

function serverId(source: IntegrationSource, name: string, configPath: string): string {
  return crypto
    .createHash('sha256')
    .update(`${source}\0${name}\0${canonicalPath(configPath)}`)
    .digest('hex')
    .slice(0, 20);
}

function serverFromConfig(
  name: string,
  rawConfig: unknown,
  candidate: ConfigCandidate,
): McpServerIntegration {
  if (!isRecord(rawConfig)) {
    return {
      id: serverId(candidate.source, name, candidate.filePath),
      name,
      source: candidate.source,
      configPath: candidate.filePath,
      status: 'invalid',
      transport: 'unknown',
      args: [],
      redactedEnv: {},
      error: 'MCP 服务配置必须是对象',
    };
  }

  const disabled = rawConfig.disabled === true || rawConfig.enabled === false;
  const transport = transportOf(rawConfig);
  const command = typeof rawConfig.command === 'string'
    ? redactScalar(rawConfig.command)
    : undefined;
  const url = typeof rawConfig.url === 'string' ? redactUrl(rawConfig.url) : undefined;
  const hasEndpoint = Boolean(command || url);

  return {
    id: serverId(candidate.source, name, candidate.filePath),
    name,
    source: candidate.source,
    configPath: candidate.filePath,
    status: disabled ? 'disabled' : hasEndpoint ? 'configured' : 'invalid',
    transport,
    command,
    args: redactMcpArguments(rawConfig.args),
    url,
    redactedEnv: redactMcpEnvironment(rawConfig.env),
    error: disabled || hasEndpoint ? undefined : 'MCP 服务缺少 command 或 url',
  };
}

function configuredServers(
  document: UnknownRecord,
  source: IntegrationSource,
  projectPath: string,
): UnknownRecord[] {
  const groups: UnknownRecord[] = [];
  const direct = document.mcpServers ?? document.mcp_servers;
  if (isRecord(direct)) groups.push(direct);

  if (source === 'user' && isRecord(document.projects)) {
    const target = canonicalPath(projectPath);
    for (const [configuredPath, rawProject] of Object.entries(document.projects)) {
      if (canonicalPath(configuredPath) !== target || !isRecord(rawProject)) continue;
      const projectServers = rawProject.mcpServers ?? rawProject.mcp_servers;
      if (isRecord(projectServers)) groups.push(projectServers);
    }
  }

  return groups;
}

export class McpDiscoveryService {
  private readonly userHome: string;
  private readonly maxConfigBytes: number;

  constructor(options: McpDiscoveryOptions = {}) {
    this.userHome = path.resolve(options.userHome ?? os.homedir());
    this.maxConfigBytes = options.maxConfigBytes ?? DEFAULT_MAX_CONFIG_BYTES;
  }

  discover(projectPath: string): McpDiscoveryResult {
    const projectRoot = path.resolve(projectPath);
    const candidates: ConfigCandidate[] = [
      {
        filePath: path.join(this.userHome, '.claude.json'),
        source: 'user',
        priority: 10,
        allowedRoot: this.userHome,
      },
      {
        filePath: path.join(this.userHome, '.claude', 'settings.json'),
        source: 'user',
        priority: 20,
        allowedRoot: this.userHome,
      },
      {
        filePath: path.join(projectRoot, '.mcp.json'),
        source: 'project',
        priority: 100,
        allowedRoot: projectRoot,
      },
      {
        filePath: path.join(projectRoot, '.claude', 'settings.json'),
        source: 'project',
        priority: 110,
        allowedRoot: projectRoot,
      },
      {
        filePath: path.join(projectRoot, '.claude', 'settings.local.json'),
        source: 'project',
        priority: 120,
        allowedRoot: projectRoot,
      },
    ];
    const diagnostics: IntegrationDiagnostic[] = [];
    const discovered = new Map<string, { priority: number; server: McpServerIntegration }>();

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate.filePath)) continue;
      const document = this.readConfig(candidate, diagnostics);
      if (!document) continue;
      const groups = configuredServers(document, candidate.source, projectRoot);
      for (const group of groups) {
        for (const [name, rawConfig] of Object.entries(group)) {
          const key = `${candidate.source}:${name.toLocaleLowerCase()}`;
          const previous = discovered.get(key);
          if (previous && previous.priority > candidate.priority) continue;
          discovered.set(key, {
            priority: candidate.priority,
            server: serverFromConfig(name, rawConfig, candidate),
          });
        }
      }
    }

    const servers = [...discovered.values()]
      .map((entry) => entry.server)
      .sort((left, right) => {
        if (left.source !== right.source) return left.source === 'project' ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
    return { servers, diagnostics };
  }

  private readConfig(
    candidate: ConfigCandidate,
    diagnostics: IntegrationDiagnostic[],
  ): UnknownRecord | null {
    try {
      const realRoot = fs.realpathSync(candidate.allowedRoot);
      const realFile = fs.realpathSync(candidate.filePath);
      if (!isContained(realRoot, realFile)) {
        diagnostics.push({
          source: candidate.source,
          path: candidate.filePath,
          code: 'outside_allowed_root',
          message: '配置文件位于允许目录之外，已跳过',
        });
        return null;
      }
      const stats = fs.statSync(realFile);
      if (!stats.isFile()) return null;
      if (stats.size > this.maxConfigBytes) {
        diagnostics.push({
          source: candidate.source,
          path: candidate.filePath,
          code: 'too_large',
          message: 'MCP 配置超过读取上限',
        });
        return null;
      }
      const bytes = fs.readFileSync(realFile);
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        diagnostics.push({
          source: candidate.source,
          path: candidate.filePath,
          code: 'invalid_utf8',
          message: 'MCP 配置不是有效 UTF-8',
        });
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        diagnostics.push({
          source: candidate.source,
          path: candidate.filePath,
          code: 'invalid_json',
          message: 'MCP 配置不是有效 JSON',
        });
        return null;
      }
      if (!isRecord(parsed)) {
        diagnostics.push({
          source: candidate.source,
          path: candidate.filePath,
          code: 'invalid_config',
          message: 'MCP 配置根节点必须是对象',
        });
        return null;
      }
      return parsed;
    } catch {
      diagnostics.push({
        source: candidate.source,
        path: candidate.filePath,
        code: 'inaccessible',
        message: '无法读取 MCP 配置',
      });
      return null;
    }
  }
}
