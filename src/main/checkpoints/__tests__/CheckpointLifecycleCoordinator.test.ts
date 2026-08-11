import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClaudeEvent,
  ClaudeEventEnvelope,
  ClaudeRunOptions,
} from '../../../shared/types/claude';
import { AppDatabase } from '../../database/Database';
import {
  CheckpointLifecycleCoordinator,
  CheckpointManager,
} from '../CheckpointManager';

const TEMP_PREFIX = 'claude-workbench-checkpoint-lifecycle-test-';
const PROJECT_ID = 'project-lifecycle';
const TASK_ID = 'task-lifecycle';

function safelyRemove(directory: string): void {
  const target = path.resolve(directory);
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith(TEMP_PREFIX)) {
    throw new Error(`Refusing to remove unexpected lifecycle test directory: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
  }).trim();
}

describe('CheckpointLifecycleCoordinator with real Git and SQLite', () => {
  let templateDirectory: string;
  let templateProject: string;
  let directory: string;
  let projectPath: string;
  let snapshotRoot: string;
  let database: AppDatabase;
  let manager: CheckpointManager;
  let coordinator: CheckpointLifecycleCoordinator;
  let idSequence: number;

  beforeAll(() => {
    templateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `${TEMP_PREFIX}template-`));
    templateProject = path.join(templateDirectory, 'repository');
    fs.mkdirSync(path.join(templateProject, 'src'), { recursive: true });
    git(templateProject, ['init']);
    git(templateProject, ['config', 'user.email', 'lifecycle-tests@example.invalid']);
    git(templateProject, ['config', 'user.name', 'Lifecycle Tests']);
    git(templateProject, ['config', 'core.autocrlf', 'false']);
    fs.writeFileSync(path.join(templateProject, 'src', 'app.txt'), 'committed app\n');
    git(templateProject, ['add', '--', 'src/app.txt']);
    git(templateProject, ['commit', '-m', 'test: initial lifecycle fixture']);
  });

  afterAll(() => {
    safelyRemove(templateDirectory);
  });

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    projectPath = path.join(directory, 'repository');
    snapshotRoot = path.join(directory, 'snapshots');
    fs.cpSync(templateProject, projectPath, { recursive: true });

    database = new AppDatabase(path.join(directory, 'workbench.sqlite'));
    database.createProject(PROJECT_ID, 'Lifecycle fixture', projectPath);
    database.createSession(TASK_ID, PROJECT_ID, 'Implement lifecycle checkpoints');
    idSequence = 0;
    manager = new CheckpointManager(database, snapshotRoot, {
      now: () => new Date('2026-03-04T05:06:07.000Z'),
      randomUUID: () => `lifecycle-id-${String(++idSequence).padStart(4, '0')}`,
    });
    coordinator = new CheckpointLifecycleCoordinator(manager);
  });

  afterEach(() => {
    database.close();
    vi.restoreAllMocks();
    safelyRemove(directory);
  });

  function runOptions(
    runId = 'run-1',
    taskId = TASK_ID,
  ): ClaudeRunOptions {
    return {
      runId,
      projectKey: projectPath,
      sessionKey: `${projectPath}::${taskId}`,
      projectPath,
      prompt: 'run lifecycle test',
      agentMode: 'develop',
    };
  }

  function envelope(
    event: ClaudeEvent,
    runId = 'run-1',
    taskId = TASK_ID,
  ): ClaudeEventEnvelope {
    return {
      runId,
      projectKey: projectPath,
      sessionKey: `${projectPath}::${taskId}`,
      event,
    };
  }

  function chronologicalTypes(taskId = TASK_ID): string[] {
    return manager.listCheckpoints(taskId).reverse().map((checkpoint) => checkpoint.type);
  }

  function checkpointsAfterBeforeTask(taskId = TASK_ID) {
    return manager.listCheckpoints(taskId).filter((checkpoint) => checkpoint.type !== 'before_task');
  }

  function configureIgnoredEnv(value: string): void {
    fs.writeFileSync(path.join(projectPath, '.gitignore'), '.env\n');
    git(projectPath, ['add', '--', '.gitignore']);
    git(projectPath, ['commit', '-m', 'test: ignore environment file']);
    fs.writeFileSync(path.join(projectPath, '.env'), value);
  }

  it('beforeRun creates a before_task checkpoint with the run id', async () => {
    const checkpoint = await coordinator.beforeRun(runOptions());

    expect(checkpoint).toMatchObject({
      taskId: TASK_ID,
      type: 'before_task',
      metadata: { runId: 'run-1', title: 'Implement lifecycle checkpoints' },
    });
    expect(chronologicalTypes()).toEqual(['before_task']);
  });

  it('beforeRun supports a plain session key without a workspace prefix', async () => {
    const options = { ...runOptions(), sessionKey: TASK_ID };
    const checkpoint = await coordinator.beforeRun(options);

    expect(checkpoint?.taskId).toBe(TASK_ID);
    expect(checkpoint?.type).toBe('before_task');
  });

  it('beforeRun rejects an unknown task without creating a checkpoint', async () => {
    await expect(coordinator.beforeRun(runOptions('run-missing', 'missing-task'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(manager.listCheckpoints(TASK_ID)).toEqual([]);
  });

  it('creates after_edit when a Write tool completes', async () => {
    await coordinator.beforeRun(runOptions());
    coordinator.handleEvent(envelope({
      type: 'tool_started',
      toolName: 'Write',
      toolUseId: 'write-1',
      input: { file_path: 'src/app.txt' },
      timestamp: 1,
    }));
    fs.writeFileSync(path.join(projectPath, 'src', 'app.txt'), 'written by tool\n');
    coordinator.handleEvent(envelope({
      type: 'tool_completed',
      toolName: 'Write',
      toolUseId: 'write-1',
      timestamp: 2,
    }));
    await coordinator.waitForIdle('run-1');

    expect(chronologicalTypes()).toEqual(['before_task', 'after_edit']);
    expect(checkpointsAfterBeforeTask()[0]?.metadata.touchedFiles).toEqual(['src/app.txt']);
  });

  it('creates after_edit when an Edit tool fails after touching a file', async () => {
    await coordinator.beforeRun(runOptions());
    coordinator.handleEvent(envelope({
      type: 'tool_started',
      toolName: 'Edit',
      toolUseId: 'edit-1',
      input: { file_path: 'src/app.txt' },
      timestamp: 1,
    }));
    coordinator.handleEvent(envelope({
      type: 'tool_failed',
      toolName: 'Edit',
      toolUseId: 'edit-1',
      error: 'simulated failure after edit',
      timestamp: 2,
    }));
    await coordinator.waitForIdle('run-1');

    expect(chronologicalTypes()).toEqual(['before_task', 'after_edit']);
    expect(checkpointsAfterBeforeTask()[0]?.metadata.runId).toBe('run-1');
  });

  it.each([
    ['MultiEdit', { path: 'src/app.txt' }],
    ['NotebookEdit', { notebook_path: 'src/notebook.ipynb' }],
  ])('extracts touched paths from %s tool input', async (toolName, input) => {
    await coordinator.beforeRun(runOptions());
    coordinator.handleEvent(envelope({
      type: 'tool_started',
      toolName,
      toolUseId: 'mutation-1',
      input,
      timestamp: 1,
    }));
    coordinator.handleEvent(envelope({
      type: 'tool_completed',
      toolName,
      toolUseId: 'mutation-1',
      timestamp: 2,
    }));
    await coordinator.waitForIdle('run-1');

    const expectedPath = toolName === 'MultiEdit' ? 'src/app.txt' : 'src/notebook.ipynb';
    expect(checkpointsAfterBeforeTask()[0]).toMatchObject({
      type: 'after_edit',
      metadata: { touchedFiles: [expectedPath] },
    });
  });

  it('creates after_edit directly from a file_changed event', async () => {
    await coordinator.beforeRun(runOptions());
    fs.writeFileSync(path.join(projectPath, 'src', 'app.txt'), 'changed event bytes\n');
    coordinator.handleEvent(envelope({
      type: 'file_changed',
      filePath: 'src/app.txt',
      toolUseId: 'edit-file-1',
      timestamp: 1,
    }));
    await coordinator.waitForIdle('run-1');

    expect(chronologicalTypes()).toEqual(['before_task', 'after_edit']);
    expect(checkpointsAfterBeforeTask()[0]?.files).toEqual([
      expect.objectContaining({ filePath: 'src/app.txt', exists: true }),
    ]);
  });

  it('treats an asynchronous tool_started ignored path as an unknown baseline', async () => {
    configureIgnoredEnv('USER_SECRET=original\r\n');
    const before = await coordinator.beforeRun(runOptions('run-ignored-before'));
    coordinator.handleEvent(envelope({
      type: 'tool_started',
      toolName: 'Write',
      toolUseId: 'ignored-write-1',
      input: { file_path: '.env' },
      timestamp: 1,
    }, 'run-ignored-before'));
    await coordinator.waitForIdle('run-ignored-before');
    fs.writeFileSync(path.join(projectPath, '.env'), 'USER_SECRET=claude\n');
    coordinator.handleEvent(envelope({
      type: 'file_changed',
      filePath: '.env',
      toolUseId: 'ignored-write-1',
      timestamp: 2,
    }, 'run-ignored-before'));
    await coordinator.waitForIdle('run-ignored-before');

    const impact = await manager.previewRestore(before!.id);
    expect(impact.restoreFiles).toEqual([]);
    expect(impact.deleteFiles).toEqual([]);
    expect(impact.blockedFiles).toEqual([expect.objectContaining({ filePath: '.env' })]);
    await expect(manager.restoreCheckpoint(before!.id, impact.confirmationToken))
      .rejects.toMatchObject({ code: 'RESTORE_BLOCKED' });
    expect(fs.readFileSync(path.join(projectPath, '.env')))
      .toEqual(Buffer.from('USER_SECRET=claude\n'));
  });

  it('marks a file_changed-only ignored path unavailable instead of deleting it', async () => {
    configureIgnoredEnv('USER_SECRET=original\n');
    const before = await coordinator.beforeRun(runOptions('run-ignored-after'));
    fs.writeFileSync(path.join(projectPath, '.env'), 'USER_SECRET=already-written\n');
    coordinator.handleEvent(envelope({
      type: 'file_changed',
      filePath: '.env',
      toolUseId: 'ignored-write-post-only',
      timestamp: 1,
    }, 'run-ignored-after'));
    await coordinator.waitForIdle('run-ignored-after');

    const impact = await manager.previewRestore(before!.id);
    expect(impact.restoreFiles).toEqual([]);
    expect(impact.deleteFiles).toEqual([]);
    expect(impact.blockedFiles).toEqual([
      expect.objectContaining({ filePath: '.env' }),
    ]);
    expect(fs.readFileSync(path.join(projectPath, '.env'), 'utf8'))
      .toBe('USER_SECRET=already-written\n');
  });

  it('does not duplicate after_edit when completion follows a checkpointed file_changed event', async () => {
    await coordinator.beforeRun(runOptions());
    coordinator.handleEvent(envelope({
      type: 'tool_started',
      toolName: 'Edit',
      toolUseId: 'edit-file-1',
      input: { file_path: 'src/app.txt' },
      timestamp: 1,
    }));
    coordinator.handleEvent(envelope({
      type: 'file_changed',
      filePath: 'src/app.txt',
      toolUseId: 'edit-file-1',
      timestamp: 2,
    }));
    await coordinator.waitForIdle('run-1');
    coordinator.handleEvent(envelope({
      type: 'tool_completed',
      toolName: 'Edit',
      toolUseId: 'edit-file-1',
      timestamp: 3,
    }));
    await coordinator.waitForIdle('run-1');

    expect(checkpointsAfterBeforeTask().map((checkpoint) => checkpoint.type)).toEqual(['after_edit']);
    expect(manager.listCheckpoints(TASK_ID)).toHaveLength(2);
  });

  it('does not duplicate after_edit when file_changed and completion arrive back-to-back', async () => {
    await coordinator.beforeRun(runOptions());
    coordinator.handleEvent(envelope({
      type: 'tool_started',
      toolName: 'Edit',
      toolUseId: 'rapid-edit-1',
      input: { file_path: 'src/app.txt' },
      timestamp: 1,
    }));
    coordinator.handleEvent(envelope({
      type: 'file_changed',
      filePath: 'src/app.txt',
      toolUseId: 'rapid-edit-1',
      timestamp: 2,
    }));
    coordinator.handleEvent(envelope({
      type: 'tool_completed',
      toolName: 'Edit',
      toolUseId: 'rapid-edit-1',
      timestamp: 3,
    }));
    await coordinator.waitForIdle('run-1');

    expect(checkpointsAfterBeforeTask().map((checkpoint) => checkpoint.type)).toEqual(['after_edit']);
    expect(manager.listCheckpoints(TASK_ID)).toHaveLength(2);
  });

  it('creates after_test with test_passed for a completed npm test Bash tool', async () => {
    await coordinator.beforeRun(runOptions());
    coordinator.handleEvent(envelope({
      type: 'tool_started',
      toolName: 'Bash',
      toolUseId: 'test-1',
      input: { command: 'npm run test -- --run' },
      timestamp: 1,
    }));
    coordinator.handleEvent(envelope({
      type: 'tool_completed',
      toolName: 'Bash',
      toolUseId: 'test-1',
      timestamp: 2,
    }));
    await coordinator.waitForIdle('run-1');

    expect(checkpointsAfterBeforeTask()[0]).toMatchObject({
      type: 'after_test',
      metadata: { reason: 'test_passed', runId: 'run-1' },
    });
  });

  it('creates after_test with test_failed for a failed pytest tool', async () => {
    await coordinator.beforeRun(runOptions());
    coordinator.handleEvent(envelope({
      type: 'tool_started',
      toolName: 'Bash',
      toolUseId: 'test-1',
      input: { command: 'pytest tests/checkpoint_test.py' },
      timestamp: 1,
    }));
    coordinator.handleEvent(envelope({
      type: 'tool_failed',
      toolName: 'Bash',
      toolUseId: 'test-1',
      error: 'one failure',
      timestamp: 2,
    }));
    await coordinator.waitForIdle('run-1');

    expect(checkpointsAfterBeforeTask()[0]).toMatchObject({
      type: 'after_test',
      metadata: { reason: 'test_failed' },
    });
  });

  it('recognizes a command_started vitest process and checkpoints its completion', async () => {
    await coordinator.beforeRun(runOptions());
    coordinator.handleEvent(envelope({
      type: 'command_started',
      command: 'npx vitest run',
      toolUseId: 'command-test-1',
      timestamp: 1,
    }));
    coordinator.handleEvent(envelope({
      type: 'tool_completed',
      toolName: 'Bash',
      toolUseId: 'command-test-1',
      timestamp: 2,
    }));
    await coordinator.waitForIdle('run-1');

    expect(chronologicalTypes()).toEqual(['before_task', 'after_test']);
    expect(checkpointsAfterBeforeTask()[0]?.metadata.reason).toBe('test_passed');
  });

  it('does not create after_test for a non-test Bash command', async () => {
    await coordinator.beforeRun(runOptions());
    coordinator.handleEvent(envelope({
      type: 'tool_started',
      toolName: 'Bash',
      toolUseId: 'build-1',
      input: { command: 'npm run build' },
      timestamp: 1,
    }));
    coordinator.handleEvent(envelope({
      type: 'tool_completed',
      toolName: 'Bash',
      toolUseId: 'build-1',
      timestamp: 2,
    }));
    await coordinator.waitForIdle('run-1');

    expect(chronologicalTypes()).toEqual(['before_task']);
    expect(checkpointsAfterBeforeTask()).toEqual([]);
  });

  it('captures Bash script disk changes at the terminal checkpoint without file_changed events', async () => {
    await coordinator.beforeRun(runOptions());
    coordinator.handleEvent(envelope({
      type: 'tool_started',
      toolName: 'Bash',
      toolUseId: 'script-1',
      input: { command: 'node scripts/rewrite-worktree.js' },
      timestamp: 1,
    }));
    fs.writeFileSync(path.join(projectPath, 'src', 'app.txt'), 'script changed tracked\n');
    fs.writeFileSync(path.join(projectPath, 'script-output.txt'), 'script added untracked\n');
    coordinator.handleEvent(envelope({
      type: 'tool_completed',
      toolName: 'Bash',
      toolUseId: 'script-1',
      timestamp: 2,
    }));
    await coordinator.waitForIdle('run-1');
    expect(chronologicalTypes()).toEqual(['before_task']);

    coordinator.handleEvent(envelope({
      type: 'session_completed',
      sessionId: 'claude-session',
      duration: 25,
      timestamp: 3,
    }));
    await coordinator.waitForIdle('run-1');
    const terminal = checkpointsAfterBeforeTask()[0];

    expect(terminal).toMatchObject({
      type: 'task_completed',
      metadata: {
        reason: 'completed',
        touchedFiles: ['script-output.txt', 'src/app.txt'],
      },
    });
    expect(terminal.files.map((file) => file.filePath)).toEqual([
      'script-output.txt',
      'src/app.txt',
    ]);
  });

  it('captures test-command disk changes in after_test without file_changed events', async () => {
    await coordinator.beforeRun(runOptions());
    coordinator.handleEvent(envelope({
      type: 'tool_started',
      toolName: 'Bash',
      toolUseId: 'test-writes-files',
      input: { command: 'npm test' },
      timestamp: 1,
    }));
    fs.writeFileSync(path.join(projectPath, 'src', 'app.txt'), 'test rewrote tracked\n');
    fs.writeFileSync(path.join(projectPath, 'coverage.tmp'), 'test artifact\n');
    coordinator.handleEvent(envelope({
      type: 'tool_completed',
      toolName: 'Bash',
      toolUseId: 'test-writes-files',
      timestamp: 2,
    }));
    await coordinator.waitForIdle('run-1');
    const afterTest = checkpointsAfterBeforeTask()[0];

    expect(afterTest).toMatchObject({
      type: 'after_test',
      metadata: {
        reason: 'test_passed',
        touchedFiles: ['coverage.tmp', 'src/app.txt'],
      },
    });
    expect(afterTest.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ filePath: 'coverage.tmp', status: 'untracked' }),
      expect.objectContaining({ filePath: 'src/app.txt', status: 'modified' }),
    ]));
  });

  it('creates task_completed with completed reason on session completion', async () => {
    await coordinator.beforeRun(runOptions());
    coordinator.handleEvent(envelope({
      type: 'session_completed',
      sessionId: 'claude-session',
      duration: 50,
      timestamp: 3,
    }));
    await coordinator.waitForIdle('run-1');

    expect(checkpointsAfterBeforeTask()[0]).toMatchObject({
      type: 'task_completed',
      metadata: { reason: 'completed', runId: 'run-1' },
    });
  });

  it('creates task_completed with failed reason on session failure', async () => {
    await coordinator.beforeRun(runOptions());
    coordinator.handleEvent(envelope({
      type: 'session_failed',
      sessionId: 'claude-session',
      error: 'simulated failure',
      duration: 50,
      timestamp: 3,
    }));
    await coordinator.waitForIdle('run-1');

    expect(checkpointsAfterBeforeTask()[0]).toMatchObject({
      type: 'task_completed',
      metadata: { reason: 'failed' },
    });
  });

  it('serializes edit, test, and terminal checkpoint work in event order', async () => {
    await coordinator.beforeRun(runOptions());
    coordinator.handleEvent(envelope({
      type: 'tool_started', toolName: 'Write', toolUseId: 'edit-1',
      input: { file_path: 'src/app.txt' }, timestamp: 1,
    }));
    coordinator.handleEvent(envelope({
      type: 'tool_completed', toolName: 'Write', toolUseId: 'edit-1', timestamp: 2,
    }));
    coordinator.handleEvent(envelope({
      type: 'tool_started', toolName: 'Bash', toolUseId: 'test-1',
      input: { command: 'npm test' }, timestamp: 3,
    }));
    coordinator.handleEvent(envelope({
      type: 'tool_completed', toolName: 'Bash', toolUseId: 'test-1', timestamp: 4,
    }));
    coordinator.handleEvent(envelope({
      type: 'session_completed', sessionId: 'claude', duration: 5, timestamp: 5,
    }));
    await coordinator.waitForIdle('run-1');

    expect(chronologicalTypes()).toEqual([
      'before_task', 'after_edit', 'after_test', 'task_completed',
    ]);
    expect(manager.listCheckpoints(TASK_ID).find((item) => item.type === 'after_test')?.metadata.reason)
      .toBe('test_passed');
  });

  it('isolates lifecycle queues and checkpoints across two concurrent runs', async () => {
    database.createSession('task-2', PROJECT_ID, 'Second lifecycle task');
    await Promise.all([
      coordinator.beforeRun(runOptions('run-1', TASK_ID)),
      coordinator.beforeRun(runOptions('run-2', 'task-2')),
    ]);
    coordinator.handleEvent(envelope({
      type: 'session_completed', sessionId: 'one', duration: 1, timestamp: 1,
    }, 'run-1', TASK_ID));
    coordinator.handleEvent(envelope({
      type: 'session_failed', sessionId: 'two', error: 'failed', timestamp: 1,
    }, 'run-2', 'task-2'));
    await Promise.all([
      coordinator.waitForIdle('run-1'),
      coordinator.waitForIdle('run-2'),
    ]);

    expect(chronologicalTypes(TASK_ID)).toEqual(['before_task', 'task_completed']);
    expect(chronologicalTypes('task-2')).toEqual(['before_task', 'task_completed']);
    expect(checkpointsAfterBeforeTask(TASK_ID)[0]?.metadata.reason).toBe('completed');
    expect(checkpointsAfterBeforeTask('task-2')[0]?.metadata.reason).toBe('failed');
  });

  it('waitForIdle resolves harmlessly when a run has no queued event work', async () => {
    await coordinator.beforeRun(runOptions());
    await expect(coordinator.waitForIdle('unknown-run')).resolves.toBeUndefined();
    await expect(coordinator.waitForIdle('run-1')).resolves.toBeUndefined();
    expect(chronologicalTypes()).toEqual(['before_task']);
  });

  it('recovers the serialized queue after an unsafe path event fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await coordinator.beforeRun(runOptions());
    coordinator.handleEvent(envelope({
      type: 'tool_started', toolName: 'Write', toolUseId: 'bad-edit',
      input: { file_path: '../outside.txt' }, timestamp: 1,
    }));
    coordinator.handleEvent(envelope({
      type: 'tool_completed', toolName: 'Write', toolUseId: 'bad-edit', timestamp: 2,
    }));
    coordinator.handleEvent(envelope({
      type: 'session_completed', sessionId: 'claude', duration: 3, timestamp: 3,
    }));
    await coordinator.waitForIdle('run-1');

    expect(errorSpy).toHaveBeenCalledWith(
      '[CheckpointLifecycleCoordinator] checkpoint failed:',
      expect.objectContaining({ code: 'UNSAFE_PATH' }),
    );
    expect(chronologicalTypes()).toEqual(['before_task', 'after_edit', 'task_completed']);
  });

  it('ignores file_read and unknown completion events', async () => {
    await coordinator.beforeRun(runOptions());
    coordinator.handleEvent(envelope({
      type: 'file_read', filePath: 'src/app.txt', toolUseId: 'read-1', timestamp: 1,
    }));
    coordinator.handleEvent(envelope({
      type: 'tool_completed', toolName: 'Read', toolUseId: 'unknown', timestamp: 2,
    }));
    await coordinator.waitForIdle('run-1');

    expect(chronologicalTypes()).toEqual(['before_task']);
    expect(checkpointsAfterBeforeTask()).toEqual([]);
  });

  it('does not checkpoint a mutation until completion or file_changed arrives', async () => {
    await coordinator.beforeRun(runOptions());
    coordinator.handleEvent(envelope({
      type: 'tool_started', toolName: 'Edit', toolUseId: 'pending-edit',
      input: { file_path: 'src/app.txt' }, timestamp: 1,
    }));
    await coordinator.waitForIdle('run-1');

    expect(chronologicalTypes()).toEqual(['before_task']);
    expect(checkpointsAfterBeforeTask()).toEqual([]);
  });

  it('clears pending tool state after the terminal checkpoint completes', async () => {
    await coordinator.beforeRun(runOptions());
    coordinator.handleEvent(envelope({
      type: 'tool_started', toolName: 'Edit', toolUseId: 'pending-edit',
      input: { file_path: 'src/app.txt' }, timestamp: 1,
    }));
    coordinator.handleEvent(envelope({
      type: 'session_completed', sessionId: 'claude', duration: 2, timestamp: 2,
    }));
    await coordinator.waitForIdle('run-1');
    coordinator.handleEvent(envelope({
      type: 'tool_completed', toolName: 'Edit', toolUseId: 'pending-edit', timestamp: 3,
    }));
    await coordinator.waitForIdle('run-1');

    expect(chronologicalTypes()).toEqual(['before_task', 'task_completed']);
    expect(checkpointsAfterBeforeTask()).toHaveLength(1);
  });
});
