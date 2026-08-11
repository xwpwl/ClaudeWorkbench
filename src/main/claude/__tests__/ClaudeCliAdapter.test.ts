import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess, SpawnOptions } from 'child_process';
import type {
  ClaudeEventEnvelope,
  ClaudeRunOptions,
} from '../../../shared/types/claude';
import {
  buildClaudeArgs,
  ClaudeCliAdapter,
  type PermissionBrokerPort,
  type ProviderEnvironmentPort,
  sanitizedClaudeArgs,
} from '../ClaudeCliAdapter';

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly pid: number;
  killed = false;
  readonly kill = vi.fn((_signal?: NodeJS.Signals | number) => {
    this.killed = true;
    if (_signal === 'SIGTERM') queueMicrotask(() => this.emit('close', 0, 'SIGTERM'));
    return true;
  });

  constructor(pid: number) {
    super();
    this.pid = pid;
  }
}

interface SpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
  child: FakeChildProcess;
}

function permissionBroker(): PermissionBrokerPort {
  return {
    registerRun: vi.fn(),
    bindProcess: vi.fn(),
    getMcpEnvironment: vi.fn((runId: string) => ({
      endpoint: 'http://127.0.0.1:43123/permission',
      token: 'permission-token',
      runId,
    })),
    cancelRun: vi.fn(),
    completeRun: vi.fn(),
  };
}

function createHarness(options: {
  permissionBroker?: PermissionBrokerPort;
  providerEnvironment?: ProviderEnvironmentPort;
} = {}) {
  const calls: SpawnCall[] = [];
  let nextPid = 4000;
  const spawnProcess = ((
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => {
    const child = new FakeChildProcess(nextPid++);
    calls.push({ command, args: [...args], options, child });
    if (command === 'taskkill') {
      queueMicrotask(() => child.emit('close', 0, null));
    }
    return child as unknown as ChildProcess;
  }) as unknown as typeof import('child_process').spawn;

  return {
    adapter: new ClaudeCliAdapter({
      executable: 'claude-test',
      spawnProcess,
      ...(options.permissionBroker
        ? {
            permissionBroker: options.permissionBroker,
            permissionMcpPath: path.join(process.cwd(), 'permission-mcp.js'),
          }
        : {}),
      ...(options.providerEnvironment ? { providerEnvironment: options.providerEnvironment } : {}),
    }),
    calls,
  };
}

function runOptions(patch: Partial<ClaudeRunOptions> = {}): ClaudeRunOptions {
  return {
    runId: 'run-1',
    projectKey: 'project-key',
    sessionKey: 'project-key::session-1',
    projectPath: process.cwd(),
    prompt: 'Inspect the project',
    ...patch,
  };
}

function permissionLaunch() {
  return {
    mcpConfigJson: '{"mcpServers":{"permissions":{"token":"mcp-secret"}}}',
    promptToolName: 'mcp__permissions__request_permission',
  };
}

describe('ClaudeCliAdapter', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds an exact one-shot argument list for a new run', () => {
    expect(buildClaudeArgs(runOptions())).toEqual([
      '-p',
      'Inspect the project',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'default',
    ]);
  });

  it('uses the exact requested session id with --resume', () => {
    const args = buildClaudeArgs(runOptions({ resumeSessionId: 'claude-session-exact' }));
    const resumeIndex = args.indexOf('--resume');

    expect(resumeIndex).toBeGreaterThan(-1);
    expect(args[resumeIndex + 1]).toBe('claude-session-exact');
    expect(args.filter((arg) => arg === '--resume')).toHaveLength(1);
  });

  it('passes an explicit permission mode to Claude', () => {
    const args = buildClaudeArgs(runOptions({ permissionMode: 'acceptEdits' }));

    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
  });

  it('passes and redacts the main-authored structured output schema', () => {
    const schema = { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } };
    const args = buildClaudeArgs(runOptions({ structuredOutputSchema: schema }));
    const index = args.indexOf('--json-schema');

    expect(index).toBeGreaterThan(-1);
    expect(JSON.parse(args[index + 1])).toEqual(schema);
    expect(sanitizedClaudeArgs(args).slice(index, index + 2))
      .toEqual(['--json-schema', '[REDACTED]']);
  });

  it('rejects an oversized structured output schema', () => {
    expect(() => buildClaudeArgs(runOptions({
      structuredOutputSchema: { description: 'x'.repeat(65 * 1024) },
    }))).toThrow('64 KiB');
  });

  it('adds the permission MCP config and prompt tool', () => {
    const permission = permissionLaunch();
    const args = buildClaudeArgs(runOptions({ permissionMode: 'default' }), permission);

    expect(args.slice(args.indexOf('--mcp-config'))).toEqual([
      '--mcp-config',
      permission.mcpConfigJson,
      '--permission-prompt-tool',
      permission.promptToolName,
    ]);
  });

  it('passes a trimmed model value', () => {
    const args = buildClaudeArgs(runOptions({ model: '  mimo-v2.5-pro  ' }));

    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2))
      .toEqual(['--model', 'mimo-v2.5-pro']);
  });

  it('uses bypass mode without installing the permission MCP callback', () => {
    const args = buildClaudeArgs(
      runOptions({ permissionMode: 'bypassPermissions' }),
      permissionLaunch(),
    );

    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--permission-prompt-tool');
  });

  it('passes trimmed allowed and disallowed tool lists', () => {
    const args = buildClaudeArgs(runOptions({
      allowedTools: [' Read ', '', 'Bash'],
      disallowedTools: [' WebFetch '],
    }));

    expect(args.slice(args.indexOf('--allowedTools'), args.indexOf('--disallowedTools')))
      .toEqual(['--allowedTools', 'Read', 'Bash']);
    expect(args.slice(args.indexOf('--disallowedTools')))
      .toEqual(['--disallowedTools', 'WebFetch']);
  });

  it('never adds --input-format to a -p invocation', () => {
    const args = buildClaudeArgs(runOptions({
      resumeSessionId: 'claude-session-1',
      permissionMode: 'plan',
      model: 'mimo-v2.5-pro',
    }), permissionLaunch());

    expect(args).not.toContain('--input-format');
    expect(args).not.toContain('stream-json-input');
  });

  it('redacts the prompt while retaining a non-sensitive length marker', () => {
    const sanitized = sanitizedClaudeArgs([
      '-p',
      'secret user prompt',
      '--output-format',
      'stream-json',
    ]);

    expect(sanitized).toEqual([
      '-p',
      '[PROMPT_REDACTED:18]',
      '--output-format',
      'stream-json',
    ]);
    expect(sanitized.join(' ')).not.toContain('secret user prompt');
  });

  it('redacts an MCP config value from diagnostic arguments', () => {
    const sanitized = sanitizedClaudeArgs([
      '--mcp-config',
      '{"token":"mcp-secret"}',
      '--permission-prompt-tool',
      'mcp__permissions__request_permission',
    ]);

    expect(sanitized).toEqual([
      '--mcp-config',
      '[REDACTED]',
      '--permission-prompt-tool',
      'mcp__permissions__request_permission',
    ]);
    expect(sanitized.join(' ')).not.toContain('mcp-secret');
  });

  it('spawns a run with cwd equal to the resolved project path', async () => {
    const harness = createHarness();
    const projectPath = process.cwd();

    await harness.adapter.runPrompt(runOptions({ projectPath }));

    expect(harness.calls[0].options.cwd).toBe(path.resolve(projectPath));
  });

  it('spawns Claude with shell disabled', async () => {
    const harness = createHarness();

    await harness.adapter.runPrompt(runOptions());

    expect(harness.calls[0].options.shell).toBe(false);
  });

  it('uses a main-process Provider environment resolver for each child only', async () => {
    const providerEnvironment: ProviderEnvironmentPort = {
      resolveChildEnvironment: vi.fn((options, inherited) => ({
        ...inherited,
        ANTHROPIC_BASE_URL: `https://${options.modelProviderId}.example`,
        ANTHROPIC_AUTH_TOKEN: `secret-${options.modelProviderId}`,
      })),
    };
    const harness = createHarness({ providerEnvironment });
    await harness.adapter.runPrompt(runOptions({
      runId: 'run-provider-one',
      sessionKey: 'project::one',
      modelProviderId: 'provider-one',
    }));
    await harness.adapter.runPrompt(runOptions({
      runId: 'run-provider-two',
      sessionKey: 'project::two',
      modelProviderId: 'provider-two',
    }));

    const first = harness.calls[0].options.env as NodeJS.ProcessEnv;
    const second = harness.calls[1].options.env as NodeJS.ProcessEnv;
    expect(first.ANTHROPIC_BASE_URL).toBe('https://provider-one.example');
    expect(first.ANTHROPIC_AUTH_TOKEN).toBe('secret-provider-one');
    expect(second.ANTHROPIC_BASE_URL).toBe('https://provider-two.example');
    expect(second.ANTHROPIC_AUTH_TOKEN).toBe('secret-provider-two');
    expect(first).not.toBe(second);
  });

  it('fails before permission registration and spawn when Provider environment resolution fails', async () => {
    const broker = permissionBroker();
    const providerEnvironment: ProviderEnvironmentPort = {
      resolveChildEnvironment: vi.fn(() => { throw new Error('Provider runtime unavailable'); }),
    };
    const harness = createHarness({ permissionBroker: broker, providerEnvironment });
    await expect(harness.adapter.runPrompt(runOptions({
      projectId: 'project-1',
      taskId: 'task-1',
      modelProviderId: 'provider-openai',
    }))).rejects.toThrow('Provider runtime unavailable');
    expect(broker.registerRun).not.toHaveBeenCalled();
    expect(harness.calls).toEqual([]);
  });

  it('does not place Provider credentials in arguments or start logs', async () => {
    const providerEnvironment: ProviderEnvironmentPort = {
      resolveChildEnvironment: vi.fn((_options, inherited) => ({
        ...inherited,
        ANTHROPIC_AUTH_TOKEN: 'provider-credential-sentinel',
      })),
    };
    const harness = createHarness({ providerEnvironment });
    await harness.adapter.runPrompt(runOptions({ modelProviderId: 'provider-mimo' }));
    expect(harness.calls[0].args.join(' ')).not.toContain('provider-credential-sentinel');
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(
      'provider-credential-sentinel',
    );
  });

  it('logs only fixed safe launch facts for runs that later complete or fail', async () => {
    const providerSecret = 'provider-log-secret-sentinel';
    const projectPath = path.resolve(process.cwd());
    const providerEnvironment: ProviderEnvironmentPort = {
      resolveChildEnvironment: vi.fn((_options, inherited) => ({
        ...inherited,
        ANTHROPIC_AUTH_TOKEN: providerSecret,
      })),
    };
    const harness = createHarness({ providerEnvironment });
    const privateOptions = {
      projectKey: 'private-project-key-sentinel',
      projectId: 'private-project-id-sentinel',
      taskId: 'private-task-id-sentinel',
      projectPath,
      prompt: 'private-prompt-sentinel',
      systemPrompt: 'private-system-prompt-sentinel',
      model: 'private-model-sentinel',
      allowedTools: ['private-tool-sentinel'],
      modelProviderId: 'private-provider-id-sentinel',
    } satisfies Partial<ClaudeRunOptions>;

    await harness.adapter.runPrompt(runOptions({
      ...privateOptions,
      runId: 'safe-complete-run',
      sessionKey: 'private-project-key-sentinel::complete-session',
    }));
    harness.calls[0].child.emit('close', 0, null);
    await harness.adapter.runPrompt(runOptions({
      ...privateOptions,
      runId: 'safe-failed-run',
      sessionKey: 'private-project-key-sentinel::failed-session',
      permissionMode: 'plan',
    }));
    harness.calls[1].child.stderr.emit(
      'data',
      Buffer.from(`fatal ${projectPath} ${providerSecret}\n`, 'utf8'),
    );
    harness.calls[1].child.emit('close', 7, null);

    expect(vi.mocked(console.info).mock.calls).toEqual([
      ['[ClaudeCliAdapter] starting', { runId: 'safe-complete-run', permissionMode: 'default' }],
      ['[ClaudeCliAdapter] starting', { runId: 'safe-failed-run', permissionMode: 'plan' }],
    ]);
    const serializedLogs = JSON.stringify([
      ...vi.mocked(console.info).mock.calls,
      ...vi.mocked(console.warn).mock.calls,
    ]);
    const pathVariants = [projectPath, projectPath.replace(/\\/gu, '/'),
      projectPath.toLocaleLowerCase('en-US'), projectPath.toLocaleUpperCase('en-US')];
    for (const value of [...pathVariants, providerSecret, privateOptions.projectKey,
      privateOptions.projectId, privateOptions.taskId, privateOptions.prompt,
      privateOptions.systemPrompt, privateOptions.model, privateOptions.allowedTools[0]]) {
      expect(serializedLogs).not.toContain(value);
    }
  });

  it('rejects an unavailable project directory without exposing any path variant', async () => {
    const missingProject = path.resolve(process.cwd(), '__cw_missing_private_project_log_test__');
    expect(fs.existsSync(missingProject)).toBe(false);
    const harness = createHarness();
    let rejection: unknown;

    try {
      await harness.adapter.runPrompt(runOptions({ projectPath: missingProject }));
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    const message = (rejection as Error).message;
    expect(message).toBe('Project directory is not available.');
    for (const value of [missingProject, missingProject.replace(/\\/gu, '/'),
      missingProject.toLocaleLowerCase('en-US'), missingProject.toLocaleUpperCase('en-US')]) {
      expect(message).not.toContain(value);
    }
    expect(harness.calls).toEqual([]);
    expect(console.info).not.toHaveBeenCalled();
  });

  it('maps a project stat race or native filesystem error to the fixed path-free rejection', async () => {
    const privateProject = path.resolve(process.cwd(), '__cw_private_project_stat_error__');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw new Error(`EACCES: native failure, stat '${privateProject}'`);
    });
    const harness = createHarness();
    let rejection: unknown;

    try {
      await harness.adapter.runPrompt(runOptions({ projectPath: privateProject }));
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    const message = (rejection as Error).message;
    expect(message).toBe('Project directory is not available.');
    for (const value of [privateProject, privateProject.replace(/\\/gu, '/'),
      privateProject.toLocaleLowerCase('en-US'), privateProject.toLocaleUpperCase('en-US')]) {
      expect(message).not.toContain(value);
    }
    expect(harness.calls).toEqual([]);
    expect(console.info).not.toHaveBeenCalled();
  });

  it('maps an existing non-directory project path to the fixed path-free rejection', async () => {
    const privateProject = path.resolve(process.cwd(), '__cw_private_project_regular_file__');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => false } as fs.Stats);
    const harness = createHarness();

    await expect(harness.adapter.runPrompt(runOptions({ projectPath: privateProject })))
      .rejects.toThrow('Project directory is not available.');
    expect(harness.calls).toEqual([]);
    expect(console.info).not.toHaveBeenCalled();
  });

  it('recursively redacts the Provider credential from normalized stdout events', async () => {
    const secret = 'provider-"quoted"-credential-sentinel';
    const providerEnvironment: ProviderEnvironmentPort = {
      resolveChildEnvironment: vi.fn((_options, inherited) => ({
        ...inherited,
        ANTHROPIC_AUTH_TOKEN: secret,
      })),
    };
    const harness = createHarness({ providerEnvironment });
    const envelopes: ClaudeEventEnvelope[] = [];
    harness.adapter.subscribe((envelope) => envelopes.push(envelope));
    await harness.adapter.runPrompt(runOptions({ modelProviderId: 'provider-mimo' }));
    const child = harness.calls[0].child;
    const output = [
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'message-secret',
          content: [
            { type: 'text', text: `assistant echoed ${secret}` },
            {
              type: 'tool_use', id: 'tool-secret', name: 'Bash',
              input: { command: `echo ${secret}` },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [{
            type: 'tool_result', tool_use_id: 'tool-secret', content: { nested: secret },
          }],
        },
      }),
    ].join('\n') + '\n';
    const splitAt = output.indexOf('provider-') + 12;

    child.stdout.emit('data', Buffer.from(output.slice(0, splitAt)));
    child.stdout.emit('data', Buffer.from(output.slice(splitAt)));

    const serialized = JSON.stringify(envelopes);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('[REDACTED]');
    expect(envelopes.some((item) => item.event.type === 'tool_completed')).toBe(true);
  });

  it('buffers split stderr and redacts the Provider credential from stream and terminal events', async () => {
    const secret = 'provider-credential-sentinel-split';
    const providerEnvironment: ProviderEnvironmentPort = {
      resolveChildEnvironment: vi.fn((_options, inherited) => ({
        ...inherited,
        ANTHROPIC_API_KEY: secret,
      })),
    };
    const harness = createHarness({ providerEnvironment });
    const envelopes: ClaudeEventEnvelope[] = [];
    harness.adapter.subscribe((envelope) => envelopes.push(envelope));
    await harness.adapter.runPrompt(runOptions({ modelProviderId: 'provider-anthropic' }));
    const child = harness.calls[0].child;

    child.stderr.emit('data', Buffer.from(`fatal: token=${secret.slice(0, 13)}`));
    expect(envelopes.some((item) => item.event.type === 'stderr')).toBe(false);
    child.stderr.emit('data', Buffer.from(`${secret.slice(13)}\n`));
    child.stderr.emit('data', Buffer.from(`final detail ${secret}`));
    child.emit('close', 7, null);

    const serialized = JSON.stringify(envelopes);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('[REDACTED]');
    const failure = envelopes.find((item) => item.event.type === 'session_failed');
    expect(failure?.event).toMatchObject({ type: 'session_failed' });
  });

  it('registers the task scope and binds the spawned Claude process', async () => {
    const broker = permissionBroker();
    const harness = createHarness({ permissionBroker: broker });

    await harness.adapter.runPrompt(runOptions({
      runId: 'run-permission',
      projectId: 'project-42',
      taskId: ' task-42 ',
      workflowContext: {
        workflowId: 'workflow-42',
        stage: 'coder',
        reviewRound: 1,
      },
    }));

    expect(broker.registerRun).toHaveBeenCalledOnce();
    expect(broker.registerRun).toHaveBeenCalledWith({
      runId: 'run-permission',
      sessionKey: 'project-key::session-1',
      projectPath: path.resolve(process.cwd()),
      projectId: 'project-42',
      taskId: 'task-42',
      workflowId: 'workflow-42',
    });
    expect(broker.bindProcess).toHaveBeenCalledOnce();
    expect(broker.bindProcess).toHaveBeenCalledWith('run-permission', 4000);
  });

  it('fails closed before permission registration when trusted task identity is absent', async () => {
    const broker = permissionBroker();
    const harness = createHarness({ permissionBroker: broker });

    await expect(harness.adapter.runPrompt(runOptions({
      projectId: undefined,
      taskId: undefined,
    }))).rejects.toThrow('Trusted task and project identity is required');

    expect(broker.registerRun).not.toHaveBeenCalled();
    expect(harness.calls).toEqual([]);
  });

  it('completes only the run registration when the child exits', async () => {
    const broker = permissionBroker();
    const harness = createHarness({ permissionBroker: broker });
    await harness.adapter.runPrompt(runOptions({ projectId: 'project-1', taskId: 'task-1' }));

    harness.calls[0].child.emit('close', 0, null);

    expect(broker.completeRun).toHaveBeenCalledOnce();
    expect(broker.completeRun).toHaveBeenCalledWith('run-1');
  });

  it('ignores stdin for one-shot -p runs', async () => {
    const harness = createHarness();

    await harness.adapter.runPrompt(runOptions());

    expect(harness.calls[0].options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('emits standalone terminal envelopes with stable task and project identity', async () => {
    const harness = createHarness();
    const envelopes: ClaudeEventEnvelope[] = [];
    harness.adapter.subscribe((envelope) => envelopes.push(envelope));

    const descriptor = await harness.adapter.runPrompt(runOptions({
      runId: 'run-envelope',
      projectId: 'project-envelope-id',
      taskId: 'task-envelope',
      projectKey: 'project-envelope',
      sessionKey: 'project-envelope::session-envelope',
    }));
    harness.calls[0].child.emit('close', 0, null);
    const terminal = envelopes.find((envelope) => envelope.event.type === 'session_completed');

    expect(descriptor).toEqual({ runId: 'run-envelope', pid: 4000 });
    expect(terminal).toMatchObject({
      runId: 'run-envelope',
      projectId: 'project-envelope-id',
      projectKey: 'project-envelope',
      sessionKey: 'project-envelope::session-envelope',
      projectPath: process.cwd(),
      taskId: 'task-envelope',
      event: { type: 'session_completed' },
    });
    expect(terminal).not.toHaveProperty('workflowId');
  });

  it('uses the real session id from system_init for the terminal event', async () => {
    const harness = createHarness();
    const envelopes: ClaudeEventEnvelope[] = [];
    harness.adapter.subscribe((envelope) => envelopes.push(envelope));
    await harness.adapter.runPrompt(runOptions({ resumeSessionId: 'old-session-id' }));
    const child = harness.calls[0].child;

    child.stdout.emit('data', Buffer.from(
      '{"type":"system","subtype":"init","session_id":"real-session-id","model":"mimo"}\n',
    ));
    child.emit('close', 0, null);

    expect(envelopes.find((item) => item.event.type === 'system_init')?.event)
      .toMatchObject({ sessionId: 'real-session-id' });
    expect(envelopes.find((item) => item.event.type === 'session_completed')?.event)
      .toMatchObject({ sessionId: 'real-session-id' });
  });

  it('emits a completed terminal event when exit code is zero without a result', async () => {
    const harness = createHarness();
    const envelopes: ClaudeEventEnvelope[] = [];
    harness.adapter.subscribe((envelope) => envelopes.push(envelope));
    await harness.adapter.runPrompt(runOptions());

    harness.calls[0].child.emit('close', 0, null);

    expect(envelopes.filter((item) => item.event.type === 'session_completed'))
      .toHaveLength(1);
    expect(await harness.adapter.stopRun('run-1')).toBe(false);
  });

  it('flushes and parses a final stdout line without a trailing newline', async () => {
    const harness = createHarness();
    const envelopes: ClaudeEventEnvelope[] = [];
    harness.adapter.subscribe((envelope) => envelopes.push(envelope));
    await harness.adapter.runPrompt(runOptions());
    const child = harness.calls[0].child;

    child.stdout.emit('data', Buffer.from(
      '{"type":"assistant","message":{"id":"message-tail","content":[{"type":"text","text":"tail answer"}]}}',
    ));
    expect(envelopes.some((item) => item.event.type === 'assistant_text')).toBe(false);

    child.emit('close', 0, null);

    expect(envelopes.find((item) => item.event.type === 'assistant_text')?.event)
      .toMatchObject({ text: 'tail answer', messageId: 'message-tail' });
  });

  it('stops only the process associated with the requested runId', async () => {
    const harness = createHarness();
    await harness.adapter.runPrompt(runOptions({ runId: 'run-a', sessionKey: 'project::a' }));
    await harness.adapter.runPrompt(runOptions({ runId: 'run-b', sessionKey: 'project::b' }));
    const childA = harness.calls[0].child;
    const childB = harness.calls[1].child;

    expect(await harness.adapter.stopRun('missing-run')).toBe(false);
    expect(await harness.adapter.stopRun('run-a')).toBe(true);

    expect(childA.kill).toHaveBeenCalledWith('SIGTERM');
    expect(harness.calls.filter((call) => call.command === 'taskkill')).toHaveLength(0);
    expect(childB.kill).not.toHaveBeenCalled();
  });

  it('turns a child process error into a failed terminal envelope', async () => {
    const harness = createHarness();
    const envelopes: ClaudeEventEnvelope[] = [];
    harness.adapter.subscribe((envelope) => envelopes.push(envelope));
    await harness.adapter.runPrompt(runOptions());
    const child = harness.calls[0].child;

    child.emit('error', new Error('spawn exploded'));

    const failure = envelopes.find((item) => item.event.type === 'session_failed');
    expect(failure?.event).toMatchObject({ type: 'session_failed' });
    expect((failure?.event as Extract<ClaudeEventEnvelope['event'], { type: 'session_failed' }>).error)
      .toContain('spawn exploded');
  });

  it('turns a non-zero exit into one failed terminal envelope with stderr detail', async () => {
    const harness = createHarness();
    const envelopes: ClaudeEventEnvelope[] = [];
    harness.adapter.subscribe((envelope) => envelopes.push(envelope));
    await harness.adapter.runPrompt(runOptions());
    const child = harness.calls[0].child;

    child.stderr.emit('data', Buffer.from('fatal: permission denied\n'));
    child.emit('close', 7, null);

    const failures = envelopes.filter((item) => item.event.type === 'session_failed');
    expect(failures).toHaveLength(1);
    expect((failures[0].event as Extract<ClaudeEventEnvelope['event'], { type: 'session_failed' }>).error)
      .toContain('fatal: permission denied');
    expect(await harness.adapter.stopRun('run-1')).toBe(false);
  });
});
