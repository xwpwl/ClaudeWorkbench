import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REDACTED_INTEGRATION_VALUE } from '../../../shared/types/integrations';
import {
  McpDiscoveryService,
  redactMcpArguments,
  redactMcpEnvironment,
} from '../McpDiscoveryService';

const TEMP_PREFIX = 'claude-workbench-mcp-discovery-';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function safelyRemove(directory: string): void {
  const target = path.resolve(directory);
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith(TEMP_PREFIX)) {
    throw new Error(`Refusing to remove unexpected directory: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

describe('McpDiscoveryService', () => {
  let root: string;
  let projectPath: string;
  let userHome: string;
  let service: McpDiscoveryService;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    projectPath = path.join(root, 'project');
    userHome = path.join(root, 'user');
    fs.mkdirSync(projectPath, { recursive: true });
    fs.mkdirSync(userHome, { recursive: true });
    service = new McpDiscoveryService({ userHome });
  });

  afterEach(() => safelyRemove(root));

  it('[MCP-01] discovers a project stdio server from .mcp.json', () => {
    writeJson(path.join(projectPath, '.mcp.json'), {
      mcpServers: { filesystem: { command: 'node', args: ['server.mjs'] } },
    });

    const result = service.discover(projectPath);

    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]).toMatchObject({
      name: 'filesystem',
      source: 'project',
      status: 'configured',
      transport: 'stdio',
      command: 'node',
      args: ['server.mjs'],
    });
  });

  it('[MCP-02] discovers a user server without writing the config', () => {
    const configPath = path.join(userHome, '.claude', 'settings.json');
    writeJson(configPath, {
      mcpServers: { browser: { type: 'sse', url: 'https://localhost/mcp' } },
    });
    const before = fs.readFileSync(configPath);

    const result = service.discover(projectPath);

    expect(result.servers[0]).toMatchObject({ name: 'browser', source: 'user', transport: 'sse' });
    expect(fs.readFileSync(configPath)).toEqual(before);
  });

  it('[MCP-03] reads only the matching project entry in user .claude.json', () => {
    writeJson(path.join(userHome, '.claude.json'), {
      projects: {
        [projectPath]: { mcpServers: { matching: { command: 'matching-command' } } },
        [path.join(root, 'other')]: { mcpServers: { other: { command: 'other-command' } } },
      },
    });

    const result = service.discover(projectPath);

    expect(result.servers.map((server) => server.name)).toEqual(['matching']);
  });

  it('[MCP-04] retains project and user sources when server names collide', () => {
    writeJson(path.join(userHome, '.claude.json'), {
      mcpServers: { github: { command: 'user-github' } },
    });
    writeJson(path.join(projectPath, '.mcp.json'), {
      mcpServers: { github: { command: 'project-github' } },
    });

    const result = service.discover(projectPath);

    expect(result.servers.map((server) => [server.source, server.command])).toEqual([
      ['project', 'project-github'],
      ['user', 'user-github'],
    ]);
  });

  it('[MCP-05] gives settings.local.json precedence within project scope', () => {
    writeJson(path.join(projectPath, '.mcp.json'), {
      mcpServers: { api: { command: 'base-command' } },
    });
    writeJson(path.join(projectPath, '.claude', 'settings.local.json'), {
      mcpServers: { api: { command: 'local-command' } },
    });

    expect(service.discover(projectPath).servers[0].command).toBe('local-command');
  });

  it('[MCP-06] classifies HTTP, SSE, and unknown transports', () => {
    writeJson(path.join(projectPath, '.mcp.json'), {
      mcpServers: {
        http: { type: 'http', url: 'https://example.test/mcp' },
        sse: { type: 'sse', url: 'https://example.test/events' },
        broken: { args: [] },
      },
    });

    const byName = new Map(service.discover(projectPath).servers.map((server) => [server.name, server]));

    expect(byName.get('http')?.transport).toBe('http');
    expect(byName.get('sse')?.transport).toBe('sse');
    expect(byName.get('broken')).toMatchObject({ transport: 'unknown', status: 'invalid' });
  });

  it('[MCP-07] represents disabled servers without dropping their metadata', () => {
    writeJson(path.join(projectPath, '.mcp.json'), {
      mcpServers: { disabled: { command: 'node', enabled: false, args: ['safe.mjs'] } },
    });

    expect(service.discover(projectPath).servers[0]).toMatchObject({
      name: 'disabled',
      status: 'disabled',
      args: ['safe.mjs'],
    });
  });

  it('[MCP-08] redacts sensitive environment keys and secret-shaped values', () => {
    const redacted = redactMcpEnvironment({
      API_KEY: 'api-secret',
      AUTH_TOKEN: 'token-secret',
      MODE: 'safe',
      HEADER: 'Bearer hidden-bearer-value',
    });

    expect(redacted).toEqual({
      API_KEY: REDACTED_INTEGRATION_VALUE,
      AUTH_TOKEN: REDACTED_INTEGRATION_VALUE,
      MODE: 'safe',
      HEADER: REDACTED_INTEGRATION_VALUE,
    });
    expect(JSON.stringify(redacted)).not.toContain('hidden-bearer-value');
  });

  it('[MCP-09] redacts separated and inline sensitive arguments', () => {
    const redacted = redactMcpArguments([
      '--safe',
      'visible',
      '--token',
      'hidden-one',
      '--api-key=hidden-two',
      '--header',
      'Authorization: Bearer hidden-three',
      '-H',
      'X-Api-Key: hidden-four',
      'ACCESS_TOKEN=hidden-five',
    ]);

    expect(redacted).toEqual([
      '--safe',
      'visible',
      '--token',
      REDACTED_INTEGRATION_VALUE,
      `--api-key=${REDACTED_INTEGRATION_VALUE}`,
      '--header',
      REDACTED_INTEGRATION_VALUE,
      '-H',
      REDACTED_INTEGRATION_VALUE,
      `ACCESS_TOKEN=${REDACTED_INTEGRATION_VALUE}`,
    ]);
  });

  it('[MCP-10] redacts URL credentials and sensitive query parameters', () => {
    writeJson(path.join(projectPath, '.mcp.json'), {
      mcpServers: {
        remote: {
          url: 'https://alice:password@example.test/mcp?token=top-secret&mode=safe',
        },
      },
    });

    const server = service.discover(projectPath).servers[0];

    expect(server.url).not.toContain('alice');
    expect(server.url).not.toContain('password');
    expect(server.url).not.toContain('top-secret');
    expect(server.url).toContain('mode=safe');
  });

  it('[MCP-11] reports invalid JSON without echoing its contents', () => {
    const secret = 'do-not-echo-this-secret';
    fs.writeFileSync(path.join(projectPath, '.mcp.json'), `{ "token": "${secret}"`, 'utf8');

    const result = service.discover(projectPath);

    expect(result.servers).toEqual([]);
    expect(result.diagnostics).toMatchObject([{ code: 'invalid_json' }]);
    expect(JSON.stringify(result.diagnostics)).not.toContain(secret);
  });

  it('[MCP-12] rejects oversized and invalid UTF-8 config files', () => {
    const smallService = new McpDiscoveryService({ userHome, maxConfigBytes: 8 });
    fs.writeFileSync(path.join(projectPath, '.mcp.json'), Buffer.alloc(9, 0x61));
    expect(smallService.discover(projectPath).diagnostics[0].code).toBe('too_large');

    fs.writeFileSync(path.join(projectPath, '.mcp.json'), Buffer.from([0xc3, 0x28]));
    expect(service.discover(projectPath).diagnostics[0].code).toBe('invalid_utf8');
  });

  it('[MCP-13] returns a stable empty result when config files are absent', () => {
    expect(service.discover(projectPath)).toEqual({ servers: [], diagnostics: [] });
  });
});
