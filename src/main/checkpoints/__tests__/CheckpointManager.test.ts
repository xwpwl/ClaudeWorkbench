import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Checkpoint, CheckpointType } from '../../../shared/types/checkpoint';
import { AppDatabase } from '../../database/Database';
import {
  FileMutationManager,
  type FileMutationEvent,
} from '../../file-mutations/FileMutationManager';
import { GitWorkspaceService } from '../../git/GitWorkspaceService';
import {
  CheckpointError,
  CheckpointManager,
  checkpointInternals,
} from '../CheckpointManager';

const TEMP_PREFIX = 'claude-workbench-checkpoint-manager-test-';
const PROJECT_ID = 'project-1';
const TASK_ID = 'task-1';

type ManagerOptions = NonNullable<ConstructorParameters<typeof CheckpointManager>[2]>;

function safelyRemove(directory: string): void {
  const target = path.resolve(directory);
  const root = path.resolve(os.tmpdir());
  if (path.dirname(target) !== root || !path.basename(target).startsWith(TEMP_PREFIX)) {
    throw new Error(`Refusing to remove unexpected test directory: ${target}`);
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

describe('CheckpointManager with a real Git repository', () => {
  let templateDirectory: string;
  let templateProject: string;
  let directory: string;
  let projectPath: string;
  let snapshotRoot: string;
  let databasePath: string;
  let database: AppDatabase;
  let manager: CheckpointManager;
  let nowMs: number;
  let idSequence: number;

  beforeAll(() => {
    templateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `${TEMP_PREFIX}template-`));
    templateProject = path.join(templateDirectory, 'repository');
    fs.mkdirSync(path.join(templateProject, 'src'), { recursive: true });
    git(templateProject, ['init']);
    git(templateProject, ['config', 'user.email', 'checkpoint-tests@example.invalid']);
    git(templateProject, ['config', 'user.name', 'Checkpoint Tests']);
    git(templateProject, ['config', 'core.autocrlf', 'false']);
    fs.writeFileSync(path.join(templateProject, 'src', 'app.txt'), 'committed app\n');
    fs.writeFileSync(path.join(templateProject, 'user.txt'), 'committed user\n');
    git(templateProject, ['add', '--', 'src/app.txt', 'user.txt']);
    git(templateProject, ['commit', '-m', 'test: initial fixture']);
  });

  afterAll(() => {
    safelyRemove(templateDirectory);
  });

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    projectPath = path.join(directory, 'repository');
    snapshotRoot = path.join(directory, 'snapshots');
    databasePath = path.join(directory, 'workbench.sqlite');
    fs.cpSync(templateProject, projectPath, { recursive: true });

    database = new AppDatabase(databasePath);
    database.createProject(PROJECT_ID, 'Checkpoint fixture', projectPath);
    database.createSession(TASK_ID, PROJECT_ID, 'Add checkpoint workflow');
    nowMs = Date.parse('2026-02-03T04:05:06.000Z');
    idSequence = 0;
    manager = makeManager();
  });

  afterEach(() => {
    database.close();
    vi.restoreAllMocks();
    safelyRemove(directory);
  });

  function makeManager(options: ManagerOptions = {}): CheckpointManager {
    return new CheckpointManager(database, snapshotRoot, {
      now: () => new Date(nowMs),
      randomUUID: () => `test-id-${String(++idSequence).padStart(4, '0')}`,
      ...options,
    });
  }

  function write(filePath: string, value: string | Buffer): void {
    const absolute = path.join(projectPath, ...filePath.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, value);
  }

  function read(filePath: string): Buffer {
    return fs.readFileSync(path.join(projectPath, ...filePath.split('/')));
  }

  function text(filePath: string): string {
    return read(filePath).toString('utf8');
  }

  function remove(filePath: string): void {
    fs.unlinkSync(path.join(projectPath, ...filePath.split('/')));
  }

  function exists(filePath: string): boolean {
    return fs.existsSync(path.join(projectPath, ...filePath.split('/')));
  }

  function currentHead(): string {
    return git(projectPath, ['rev-parse', 'HEAD']);
  }

  function commitIgnoreRules(...patterns: string[]): void {
    write('.gitignore', `${patterns.join('\n')}\n`);
    git(projectPath, ['add', '--', '.gitignore']);
    git(projectPath, ['commit', '-m', 'test: configure ignored files']);
  }

  function storedSnapshotPath(checkpointId: string): string {
    const stored = database.getCheckpoint(checkpointId)?.snapshot_path;
    if (!stored) throw new Error(`Missing stored snapshot path for ${checkpointId}`);
    return stored;
  }

  function storedSnapshotFile(checkpointId: string, filePath: string): string {
    return path.join(
      storedSnapshotPath(checkpointId),
      'files',
      checkpointInternals.snapshotName(filePath),
    );
  }

  async function createBaseline(
    touchedFiles: string[] = ['src/app.txt'],
    context: { dirty?: Record<string, string | Buffer>; type?: CheckpointType } = {},
  ): Promise<Checkpoint> {
    for (const [filePath, value] of Object.entries(context.dirty ?? {})) write(filePath, value);
    return manager.createCheckpoint(
      projectPath,
      TASK_ID,
      context.type ?? 'before_task',
      { runId: 'run-1', title: 'Add checkpoint workflow', touchedFiles },
    );
  }

  async function restore(checkpoint: Checkpoint) {
    const impact = await manager.previewRestore(checkpoint.id);
    const result = await manager.restoreCheckpoint(checkpoint.id, impact.confirmationToken);
    return { impact, result };
  }

  describe('checkpoint creation and persistence (25+ cases)', () => {
    it.each<CheckpointType>([
      'before_task',
      'after_edit',
      'after_test',
      'task_completed',
      'manual',
      'accepted',
    ])('persists a %s checkpoint with deterministic task metadata', async (type) => {
      const checkpoint = await manager.createTaskCheckpoint(TASK_ID, type, {
        runId: `run-${type}`,
        reason: `reason-${type}`,
      });

      expect(checkpoint).toMatchObject({
        taskId: TASK_ID,
        projectPath: fs.realpathSync(projectPath),
        type,
        gitCommit: currentHead(),
        metadata: {
          runId: `run-${type}`,
          title: 'Add checkpoint workflow',
          reason: `reason-${type}`,
        },
      });
      expect(manager.getCheckpoint(checkpoint.id)?.type).toBe(type);
    });

    it('startTask creates before_task and extracts the task id from a workspace session key', async () => {
      const checkpoint = await manager.startTask({
        runId: 'run-start',
        projectKey: projectPath,
        sessionKey: `${projectPath}::${TASK_ID}`,
        projectPath,
        prompt: 'test',
        agentMode: 'develop',
      });

      expect(checkpoint).toMatchObject({
        taskId: TASK_ID,
        type: 'before_task',
        metadata: { runId: 'run-start', title: 'Add checkpoint workflow' },
      });
      expect(database.getTask(TASK_ID)).toMatchObject({ agent_mode: 'normal' });
    });

    it('snapshots binary files as exact raw bytes with a SHA-256 hash', async () => {
      const bytes = Buffer.from([0, 255, 13, 10, 128, 42]);
      write('binary.dat', bytes);
      const checkpoint = await createBaseline(['binary.dat']);
      const file = checkpoint.files.find((item) => item.filePath === 'binary.dat');

      expect(file).toMatchObject({
        exists: true,
        size: bytes.length,
        hash: crypto.createHash('sha256').update(bytes).digest('hex'),
        status: 'untracked',
      });
      expect(fs.readFileSync(storedSnapshotFile(checkpoint.id, 'binary.dat'))).toEqual(bytes);
    });

    it('snapshots modified text without newline or encoding transformations', async () => {
      const content = Buffer.from('modified\r\nwithout-final-newline', 'utf8');
      write('src/app.txt', content);
      const checkpoint = await createBaseline();
      const file = checkpoint.files.find((item) => item.filePath === 'src/app.txt');

      expect(file?.size).toBe(content.length);
      expect(file?.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(fs.readFileSync(storedSnapshotFile(checkpoint.id, 'src/app.txt'))).toEqual(content);
    });

    it('writes a manifest containing the row, metadata, and file index', async () => {
      write('src/app.txt', 'dirty app\n');
      const checkpoint = await createBaseline(['src/app.txt']);
      const manifest = JSON.parse(fs.readFileSync(
        path.join(storedSnapshotPath(checkpoint.id), 'manifest.json'),
        'utf8',
      )) as Record<string, unknown>;

      expect(manifest).toMatchObject({
        id: checkpoint.id,
        task_id: TASK_ID,
        project_path: fs.realpathSync(projectPath),
        type: 'before_task',
        metadata: { runId: 'run-1', touchedFiles: ['src/app.txt'] },
      });
      expect(manifest.files).toEqual(expect.arrayContaining([
        expect.objectContaining({ file_path: 'src/app.txt', size: 10 }),
      ]));
    });

    it('rejects a file above the per-file snapshot limit and removes partial artifacts', async () => {
      manager = makeManager({ maxSnapshotFileBytes: 3, maxSnapshotTotalBytes: 100 });
      write('too-large.txt', '1234');

      await expect(createBaseline(['too-large.txt'])).rejects.toMatchObject({
        code: 'SNAPSHOT_LIMIT',
      });
      expect(database.listCheckpoints(TASK_ID)).toEqual([]);
      expect(fs.existsSync(snapshotRoot) ? fs.readdirSync(snapshotRoot) : []).toEqual([]);
    });

    it('rejects aggregate snapshots above the total limit atomically', async () => {
      manager = makeManager({ maxSnapshotFileBytes: 10, maxSnapshotTotalBytes: 7 });
      write('one.txt', '1234');
      write('two.txt', '5678');

      await expect(createBaseline(['one.txt', 'two.txt'])).rejects.toMatchObject({
        code: 'SNAPSHOT_LIMIT',
      });
      expect(database.listCheckpoints(TASK_ID)).toEqual([]);
      expect(fs.existsSync(snapshotRoot) ? fs.readdirSync(snapshotRoot) : []).toEqual([]);
    });

    it('allows an aggregate snapshot exactly at the configured total limit', async () => {
      manager = makeManager({ maxSnapshotFileBytes: 4, maxSnapshotTotalBytes: 8 });
      write('one.txt', '1234');
      write('two.txt', '5678');

      const checkpoint = await createBaseline(['one.txt', 'two.txt']);
      expect(checkpoint.files.map((file) => file.size).reduce((sum, size) => sum + size, 0)).toBe(8);
      expect(checkpoint.files.map((file) => file.filePath)).toEqual(['one.txt', 'two.txt']);
    });

    it('records modified Git status details in baseline metadata', async () => {
      write('src/app.txt', 'dirty app\n');
      const checkpoint = await createBaseline();
      const status = checkpoint.metadata.baselineFiles.find((file) => file.filePath === 'src/app.txt');

      expect(status).toMatchObject({ changeType: 'modified', staged: false, unstaged: true });
      expect(checkpoint.files.find((file) => file.filePath === 'src/app.txt')?.status).toBe('modified');
    });

    it('records untracked files and their bytes in the baseline', async () => {
      write('new-file.txt', 'new baseline\n');
      const checkpoint = await createBaseline(['new-file.txt']);

      expect(checkpoint.metadata.baselineFiles).toEqual(expect.arrayContaining([
        expect.objectContaining({ filePath: 'new-file.txt', changeType: 'untracked', untracked: true }),
      ]));
      expect(checkpoint.files.find((file) => file.filePath === 'new-file.txt')).toMatchObject({
        exists: true,
        size: 13,
      });
    });

    it('records deleted files as absent without manufacturing snapshot bytes', async () => {
      remove('src/app.txt');
      const checkpoint = await createBaseline();
      const file = checkpoint.files.find((item) => item.filePath === 'src/app.txt');

      expect(file).toMatchObject({ exists: false, hash: 'absent', size: 0 });
      expect(file).not.toHaveProperty('snapshotFile');
      expect(checkpoint.metadata.baselineFiles).toEqual(expect.arrayContaining([
        expect.objectContaining({ filePath: 'src/app.txt', changeType: 'deleted' }),
      ]));
    });

    it('normalizes noted files to repository-relative forward-slash paths', async () => {
      const noted = await manager.noteTaskFile(TASK_ID, projectPath, 'src/nested/new.txt');
      const checkpoint = await manager.createTaskCheckpoint(TASK_ID, 'after_edit');

      expect(noted).toBe('src/nested/new.txt');
      expect(checkpoint.metadata.touchedFiles).toEqual(['src/nested/new.txt']);
    });

    it('deduplicates and sorts touched files deterministically', async () => {
      await manager.noteTaskFile(TASK_ID, projectPath, 'z.txt');
      await manager.noteTaskFile(TASK_ID, projectPath, 'a.txt');
      await manager.noteTaskFile(TASK_ID, projectPath, 'z.txt');
      const checkpoint = await manager.createTaskCheckpoint(TASK_ID, 'after_edit');

      expect(checkpoint.metadata.touchedFiles).toEqual(['a.txt', 'z.txt']);
      expect(new Set(checkpoint.metadata.touchedFiles).size).toBe(2);
    });

    it.each([
      ['parent traversal', '../outside.txt'],
      ['absolute POSIX path', '/outside.txt'],
      ['absolute Windows path', 'C:\\outside.txt'],
      ['Git metadata', '.git/config'],
      ['null-byte path', 'src/bad\0name.txt'],
      ['empty path', ''],
    ])('rejects unsafe noted path: %s', async (_label, unsafePath) => {
      await expect(manager.noteTaskFile(TASK_ID, projectPath, unsafePath)).rejects.toMatchObject({
        code: 'UNSAFE_PATH',
      });
      expect(manager.listCheckpoints(TASK_ID)).toEqual([]);
    });

    it('rejects startTask when the requested root differs from the registered project', async () => {
      const otherProject = path.join(directory, 'other-repository');
      fs.mkdirSync(otherProject);

      await expect(manager.startTask({
        runId: 'run-mismatch',
        projectKey: otherProject,
        sessionKey: `other::${TASK_ID}`,
        projectPath: otherProject,
        prompt: 'test',
      })).rejects.toMatchObject({ code: 'PROJECT_MISMATCH' });
      expect(database.listCheckpoints(TASK_ID)).toEqual([]);
    });

    it('rejects startTask for a session that is not registered', async () => {
      await expect(manager.startTask({
        runId: 'run-missing',
        projectKey: projectPath,
        sessionKey: `${projectPath}::missing-task`,
        projectPath,
        prompt: 'test',
      })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(database.listCheckpoints(TASK_ID)).toEqual([]);
    });

    it('isolates checkpoint listing by task and orders newest first', async () => {
      database.createSession('task-2', PROJECT_ID, 'Other task');
      const first = await manager.createTaskCheckpoint(TASK_ID, 'before_task');
      nowMs += 1_000;
      const second = await manager.createTaskCheckpoint(TASK_ID, 'after_edit');
      const other = await manager.createTaskCheckpoint('task-2', 'manual');

      expect(manager.listCheckpoints(TASK_ID).map((item) => item.id)).toEqual([second.id, first.id]);
      expect(manager.listCheckpoints('task-2').map((item) => item.id)).toEqual([other.id]);
    });

    it('reconstructs metadata and snapshot files after a database restart', async () => {
      write('src/app.txt', 'dirty persisted bytes\n');
      const checkpoint = await manager.createCheckpoint(projectPath, TASK_ID, 'after_edit', {
        runId: 'run-persisted',
        title: 'Persisted title',
        touchedFiles: ['src/app.txt'],
        reason: 'persisted_reason',
      });
      database.close();
      database = new AppDatabase(databasePath);
      manager = makeManager();

      const reloaded = manager.getCheckpoint(checkpoint.id);
      expect(reloaded).toMatchObject({
        id: checkpoint.id,
        type: 'after_edit',
        metadata: {
          runId: 'run-persisted',
          title: 'Persisted title',
          touchedFiles: ['src/app.txt'],
          reason: 'persisted_reason',
        },
      });
      expect(fs.readFileSync(storedSnapshotFile(checkpoint.id, 'src/app.txt'))).toEqual(
        Buffer.from('dirty persisted bytes\n'),
      );
      expect(reloaded).not.toHaveProperty('snapshotPath');
      expect(reloaded?.files[0]).not.toHaveProperty('snapshotFile');
    });

    it('emits created events until the subscriber unsubscribes', async () => {
      const events: Array<{ action: string; checkpointId?: string }> = [];
      const unsubscribe = manager.subscribe((event) => events.push(event));
      const first = await manager.createTaskCheckpoint(TASK_ID, 'manual');
      unsubscribe();
      await manager.createTaskCheckpoint(TASK_ID, 'after_test');

      expect(events).toEqual([
        expect.objectContaining({ action: 'created', checkpointId: first.id }),
      ]);
    });

    it('persists a human-readable timeline event for checkpoint creation', async () => {
      const checkpoint = await manager.createTaskCheckpoint(TASK_ID, 'after_test', {
        runId: 'timeline-run',
        touchedFiles: ['src/app.txt'],
      });
      const events = database.listEvents(TASK_ID);
      const payload = JSON.parse(events.at(-1)?.payload_json ?? '{}') as Record<string, unknown>;

      expect(events.at(-1)?.event_type).toBe('git_checkpoint_created');
      expect(payload).toMatchObject({
        runId: 'timeline-run',
        checkpointId: checkpoint.id,
        checkpointType: 'after_test',
      });
    });

    it('detects clean tracked edits and new untracked files without structured file events', async () => {
      await manager.startTask({
        runId: 'run-script-detect',
        projectKey: projectPath,
        sessionKey: `${projectPath}::${TASK_ID}`,
        projectPath,
        prompt: 'run an external script',
      });
      write('src/app.txt', 'script changed tracked content\n');
      write('generated-by-script.txt', 'script generated content\n');

      const completed = await manager.createTaskCheckpoint(TASK_ID, 'task_completed', {
        runId: 'run-script-detect',
        reason: 'completed',
      });

      expect(completed.metadata.touchedFiles).toEqual([
        'generated-by-script.txt',
        'src/app.txt',
      ]);
      expect(completed.files.map((file) => file.filePath)).toEqual([
        'generated-by-script.txt',
        'src/app.txt',
      ]);
    });

    it('excludes unchanged pre-task dirty and untracked files from detected task changes', async () => {
      write('src/app.txt', 'user dirty before task\n');
      write('user-scratch.txt', 'user untracked before task\n');
      const before = await manager.startTask({
        runId: 'run-unchanged-baseline',
        projectKey: projectPath,
        sessionKey: `${projectPath}::${TASK_ID}`,
        projectPath,
        prompt: 'do not change baseline files',
      });

      const completed = await manager.createTaskCheckpoint(TASK_ID, 'task_completed', {
        runId: 'run-unchanged-baseline',
        reason: 'completed',
      });
      const impact = await manager.previewRestore((before as Checkpoint).id);

      expect(completed.metadata.touchedFiles).toEqual([]);
      expect(impact.restoreFiles).toEqual([]);
      expect(impact.deleteFiles).toEqual([]);
      expect(impact.preservedUserFiles).toEqual(['src/app.txt', 'user-scratch.txt']);
    });

    it('detects a script changing an already dirty file and restores the exact user baseline', async () => {
      const userBaseline = Buffer.from('user dirty baseline\r\nraw bytes', 'utf8');
      write('src/app.txt', userBaseline);
      const before = await manager.startTask({
        runId: 'run-dirty-rewrite',
        projectKey: projectPath,
        sessionKey: `${projectPath}::${TASK_ID}`,
        projectPath,
        prompt: 'script rewrites a dirty file',
      });
      write('src/app.txt', Buffer.from('script replacement\n', 'utf8'));

      const completed = await manager.createTaskCheckpoint(TASK_ID, 'task_completed', {
        runId: 'run-dirty-rewrite',
      });
      const { impact } = await restore(before as Checkpoint);

      expect(completed.metadata.touchedFiles).toEqual(['src/app.txt']);
      expect(impact.restoreFiles).toEqual(['src/app.txt']);
      expect(read('src/app.txt')).toEqual(userBaseline);
      expect(git(projectPath, ['status', '--porcelain=v1', '--', 'src/app.txt'])).toBe('M src/app.txt');
    });

    it('detects a script changing pre-task untracked bytes and restores that user baseline', async () => {
      write('user-scratch.txt', Buffer.from([0, 1, 2, 3, 255]));
      const before = await manager.startTask({
        runId: 'run-untracked-rewrite',
        projectKey: projectPath,
        sessionKey: `${projectPath}::${TASK_ID}`,
        projectPath,
        prompt: 'script rewrites untracked bytes',
      });
      write('user-scratch.txt', Buffer.from([9, 8, 7]));

      const completed = await manager.createTaskCheckpoint(TASK_ID, 'task_completed', {
        runId: 'run-untracked-rewrite',
      });
      await restore(before as Checkpoint);

      expect(completed.metadata.touchedFiles).toEqual(['user-scratch.txt']);
      expect(read('user-scratch.txt')).toEqual(Buffer.from([0, 1, 2, 3, 255]));
      expect(git(projectPath, ['status', '--porcelain=v1', '--', 'user-scratch.txt']))
        .toBe('?? user-scratch.txt');
    });

    it('uses safe defaults when persisted checkpoint metadata is malformed JSON', () => {
      database.createCheckpoint({
        id: 'malformed',
        task_id: TASK_ID,
        project_path: fs.realpathSync(projectPath),
        type: 'manual',
        created_at: new Date(nowMs).toISOString(),
        git_commit: currentHead(),
        snapshot_path: null,
        metadata_json: '{not-json',
      });

      expect(manager.getCheckpoint('malformed')?.metadata).toEqual({
        branch: null,
        baselineFiles: [],
        touchedFiles: [],
      });
    });
  });

  describe('restore workflow (20+ cases)', () => {
    it('rejects preview for an unknown checkpoint', async () => {
      await expect(manager.previewRestore('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(manager.listCheckpoints(TASK_ID)).toEqual([]);
    });

    it('requires a confirmation token before restoring', async () => {
      const checkpoint = await createBaseline();
      await expect(manager.restoreCheckpoint(checkpoint.id, '')).rejects.toMatchObject({
        code: 'CONFIRMATION_REQUIRED',
      });
      expect(text('src/app.txt')).toBe('committed app\n');
    });

    it('blocks restore behind an active project writer without consuming confirmation', async () => {
      const mutations = new FileMutationManager();
      manager = makeManager({ mutations } as ManagerOptions);
      const checkpoint = await createBaseline();
      write('src/app.txt', 'AI change while task is running\n');
      const impact = await manager.previewRestore(checkpoint.id);
      const activeWriter = await mutations.acquireExternalProcessLease({
        mutationId: 'active-claude-run',
        kind: 'claude_run',
        projectPath,
        taskId: TASK_ID,
        sessionId: TASK_ID,
        filePaths: ['src/app.txt'],
      });

      try {
        await expect(manager.restoreCheckpoint(checkpoint.id, impact.confirmationToken))
          .rejects.toMatchObject({ code: 'TASK_PROJECT_BUSY' });
        expect(text('src/app.txt')).toBe('AI change while task is running\n');
      } finally {
        activeWriter.release();
      }

      await expect(manager.restoreCheckpoint(checkpoint.id, impact.confirmationToken))
        .resolves.toMatchObject({ checkpointId: checkpoint.id });
      expect(text('src/app.txt')).toBe('committed app\n');
    });

    it.each(['starting', 'running', 'waiting_permission'])(
      'blocks restore while the persisted task is %s without consuming confirmation',
      async (status) => {
        const checkpoint = await createBaseline();
        write('src/app.txt', `AI change while task is ${status}\n`);
        const impact = await manager.previewRestore(checkpoint.id);
        database.updateTask(TASK_ID, { status });

        await expect(manager.restoreCheckpoint(checkpoint.id, impact.confirmationToken))
          .rejects.toMatchObject({ code: 'TASK_ACTIVE' });
        expect(text('src/app.txt')).toBe(`AI change while task is ${status}\n`);

        database.updateTask(TASK_ID, { status: 'completed' });
        await expect(manager.restoreCheckpoint(checkpoint.id, impact.confirmationToken))
          .resolves.toMatchObject({ checkpointId: checkpoint.id });
        expect(text('src/app.txt')).toBe('committed app\n');
      },
    );

    it('rejects a token issued for a different checkpoint and consumes it', async () => {
      const first = await createBaseline();
      const second = await manager.createTaskCheckpoint(TASK_ID, 'manual', {
        touchedFiles: ['src/app.txt'],
      });
      write('src/app.txt', 'AI change\n');
      const impact = await manager.previewRestore(first.id);

      await expect(manager.restoreCheckpoint(second.id, impact.confirmationToken)).rejects.toMatchObject({
        code: 'CONFIRMATION_REQUIRED',
      });
      await expect(manager.restoreCheckpoint(first.id, impact.confirmationToken)).rejects.toMatchObject({
        code: 'CONFIRMATION_REQUIRED',
      });
    });

    it('expires confirmation tokens after the configured TTL', async () => {
      manager = makeManager({ tokenTtlMs: 100 });
      const checkpoint = await createBaseline();
      write('src/app.txt', 'AI change\n');
      const impact = await manager.previewRestore(checkpoint.id);
      nowMs += 101;

      await expect(manager.restoreCheckpoint(checkpoint.id, impact.confirmationToken)).rejects.toMatchObject({
        code: 'STALE_CONFIRMATION',
      });
      expect(text('src/app.txt')).toBe('AI change\n');
    });

    it('accepts a token exactly at its expiration timestamp', async () => {
      manager = makeManager({ tokenTtlMs: 100 });
      const checkpoint = await createBaseline();
      write('src/app.txt', 'AI change\n');
      const impact = await manager.previewRestore(checkpoint.id);
      nowMs += 100;

      await expect(manager.restoreCheckpoint(checkpoint.id, impact.confirmationToken)).resolves.toMatchObject({
        checkpointId: checkpoint.id,
      });
      expect(text('src/app.txt')).toBe('committed app\n');
    });

    it('invalidates a preview when a restore file changes afterward', async () => {
      const checkpoint = await createBaseline();
      write('src/app.txt', 'AI version one\n');
      const impact = await manager.previewRestore(checkpoint.id);
      write('src/app.txt', 'AI version two\n');

      await expect(manager.restoreCheckpoint(checkpoint.id, impact.confirmationToken)).rejects.toMatchObject({
        code: 'STALE_CONFIRMATION',
      });
      expect(text('src/app.txt')).toBe('AI version two\n');
    });

    it('invalidates a preview when a restore file is deleted afterward', async () => {
      const checkpoint = await createBaseline();
      write('src/app.txt', 'AI version\n');
      const impact = await manager.previewRestore(checkpoint.id);
      remove('src/app.txt');

      await expect(manager.restoreCheckpoint(checkpoint.id, impact.confirmationToken)).rejects.toMatchObject({
        code: 'STALE_CONFIRMATION',
      });
      expect(exists('src/app.txt')).toBe(false);
    });

    it('invalidates a restore preview when the branch changes at the same HEAD', async () => {
      const checkpoint = await createBaseline();
      write('src/app.txt', 'AI version on the original branch\n');
      const impact = await manager.previewRestore(checkpoint.id);
      git(projectPath, ['checkout', '-b', 'restore-preview-drift']);

      await expect(manager.restoreCheckpoint(checkpoint.id, impact.confirmationToken))
        .rejects.toMatchObject({ code: 'STALE_CONFIRMATION' });
      expect(text('src/app.txt')).toBe('AI version on the original branch\n');
    });

    it('invalidates a restore preview when HEAD moves without changing an impacted file', async () => {
      const checkpoint = await createBaseline();
      write('src/app.txt', 'AI version before unrelated commit\n');
      const impact = await manager.previewRestore(checkpoint.id);
      write('unrelated-head-change.txt', 'unrelated commit\n');
      git(projectPath, ['add', '--', 'unrelated-head-change.txt']);
      git(projectPath, ['commit', '-m', 'test: move HEAD after restore preview']);

      await expect(manager.restoreCheckpoint(checkpoint.id, impact.confirmationToken))
        .rejects.toMatchObject({ code: 'STALE_CONFIRMATION' });
      expect(text('src/app.txt')).toBe('AI version before unrelated commit\n');
    });

    it('previews a tracked file restore from the checkpoint Git commit', async () => {
      const checkpoint = await createBaseline();
      write('src/app.txt', 'AI change\n');
      const impact = await manager.previewRestore(checkpoint.id);

      expect(impact).toMatchObject({
        restoreFiles: ['src/app.txt'],
        deleteFiles: [],
        blockedFiles: [],
      });
      expect(new Date(impact.expiresAt).getTime()).toBeGreaterThan(nowMs);
    });

    it('restores a tracked file to its committed before-task bytes', async () => {
      const checkpoint = await createBaseline();
      write('src/app.txt', 'AI change\n');
      const { result } = await restore(checkpoint);

      expect(text('src/app.txt')).toBe('committed app\n');
      expect(result).toMatchObject({ restoredFiles: ['src/app.txt'], deletedFiles: [] });
    });

    it('previews a task-created ordinary untracked file as a deletion', async () => {
      const checkpoint = await createBaseline(['generated.txt']);
      write('generated.txt', 'generated by AI\n');
      const impact = await manager.previewRestore(checkpoint.id);

      expect(impact.restoreFiles).toEqual([]);
      expect(impact.deleteFiles).toEqual(['generated.txt']);
      expect(impact.blockedFiles).toEqual([]);
    });

    it('deletes a task-created ordinary file after confirmation', async () => {
      const checkpoint = await createBaseline(['generated.txt']);
      write('generated.txt', 'generated by AI\n');
      const { result } = await restore(checkpoint);

      expect(exists('generated.txt')).toBe(false);
      expect(result.deletedFiles).toEqual(['generated.txt']);
    });

    it('deletes an ordinary new untracked path discovered through a task file event', async () => {
      const before = await manager.startTask({
        runId: 'run-new-ordinary-file',
        projectKey: projectPath,
        sessionKey: `${projectPath}::${TASK_ID}`,
        projectPath,
        prompt: 'create a normal source file',
      });
      await manager.noteTaskFile(TASK_ID, projectPath, 'generated-source.ts');
      write('generated-source.ts', 'export const generated = true;\n');
      await manager.createTaskCheckpoint(TASK_ID, 'after_edit', {
        runId: 'run-new-ordinary-file',
      });

      const { impact, result } = await restore(before as Checkpoint);

      expect(impact.blockedFiles).toEqual([]);
      expect(impact.deleteFiles).toEqual(['generated-source.ts']);
      expect(result.deletedFiles).toEqual(['generated-source.ts']);
      expect(exists('generated-source.ts')).toBe(false);
    });

    it('treats an already absent ordinary task-created file as a safe idempotent deletion', async () => {
      const checkpoint = await createBaseline(['generated.txt']);
      const { impact, result } = await restore(checkpoint);

      expect(impact.deleteFiles).toEqual(['generated.txt']);
      expect(result.deletedFiles).toEqual(['generated.txt']);
      expect(exists('generated.txt')).toBe(false);
    });

    it('restores a touched dirty file to the user dirty baseline snapshot', async () => {
      write('src/app.txt', 'user dirty baseline\n');
      const checkpoint = await createBaseline();
      write('src/app.txt', 'AI overwrote it\n');
      await restore(checkpoint);

      expect(text('src/app.txt')).toBe('user dirty baseline\n');
      expect(git(projectPath, ['status', '--porcelain=v1', '--', 'src/app.txt'])).toBe('M src/app.txt');
    });

    it('restores a touched untracked file to the user original untracked bytes', async () => {
      write('user-untracked.txt', 'user untracked baseline\n');
      const checkpoint = await createBaseline(['user-untracked.txt']);
      write('user-untracked.txt', 'AI overwrote untracked\n');
      await restore(checkpoint);

      expect(text('user-untracked.txt')).toBe('user untracked baseline\n');
      expect(git(projectPath, ['status', '--porcelain=v1', '--', 'user-untracked.txt'])).toContain('?? user-untracked.txt');
    });

    it.each<CheckpointType>(['after_edit', 'after_test', 'manual'])('restores a %s snapshot instead of HEAD', async (type) => {
      write('src/app.txt', `${type} checkpoint bytes\n`);
      const checkpoint = await createBaseline(['src/app.txt'], { type });
      write('src/app.txt', 'later bytes\n');
      await restore(checkpoint);

      expect(text('src/app.txt')).toBe(`${type} checkpoint bytes\n`);
      expect(checkpoint.files.find((file) => file.filePath === 'src/app.txt')?.exists).toBe(true);
    });

    it('creates a manual rollback checkpoint before applying a restore', async () => {
      const checkpoint = await createBaseline();
      write('src/app.txt', 'AI state before restore\n');
      const { result } = await restore(checkpoint);
      const rollback = manager.getCheckpoint(result.rollbackCheckpointId);

      expect(rollback).toMatchObject({
        taskId: TASK_ID,
        type: 'manual',
        metadata: { reason: 'before_restore', touchedFiles: ['src/app.txt'] },
      });
      expect(fs.readFileSync(storedSnapshotFile(result.rollbackCheckpointId, 'src/app.txt'))).toEqual(
        Buffer.from('AI state before restore\n'),
      );
    });

    describe('generated rollback restoration', () => {
      let rollback: Checkpoint;

      beforeEach(async () => {
        const checkpoint = await createBaseline();
        write('src/app.txt', 'AI state before restore\n');
        const { result } = await restore(checkpoint);
        rollback = manager.getCheckpoint(result.rollbackCheckpointId) as Checkpoint;

        expect(text('src/app.txt')).toBe('committed app\n');
        expect(rollback).toMatchObject({
          id: result.rollbackCheckpointId,
          type: 'manual',
          metadata: { reason: 'before_restore' },
        });
      });

      it('can restore the generated rollback checkpoint to return to the pre-restore state', async () => {
        await restore(rollback);

        expect(text('src/app.txt')).toBe('AI state before restore\n');
        expect(manager.listCheckpoints(TASK_ID).filter((item) => item.type === 'manual').length).toBeGreaterThanOrEqual(2);
      });
    });

    it('returns deterministic sorted restore and delete file arrays', async () => {
      const checkpoint = await createBaseline(['z-new.txt', 'src/app.txt', 'a-new.txt']);
      write('z-new.txt', 'z');
      write('a-new.txt', 'a');
      write('src/app.txt', 'AI');
      const impact = await manager.previewRestore(checkpoint.id);

      expect(impact.restoreFiles).toEqual(['src/app.txt']);
      expect(impact.deleteFiles).toEqual(['a-new.txt', 'z-new.txt']);
    });

    it('persists a restore-completed timeline event', async () => {
      const checkpoint = await createBaseline();
      write('src/app.txt', 'AI change\n');
      await restore(checkpoint);
      const event = database.listEvents(TASK_ID).find((item) => item.event_type === 'git_restore_completed');
      const payload = JSON.parse(event?.payload_json ?? '{}') as Record<string, unknown>;

      expect(event).toBeTruthy();
      expect(payload).toMatchObject({ checkpointId: checkpoint.id, files: ['src/app.txt'], deletedFiles: [] });
    });

    it('emits exactly one restored event after a successful restore', async () => {
      const checkpoint = await createBaseline();
      write('src/app.txt', 'AI change\n');
      const events: string[] = [];
      manager.subscribe((event) => events.push(event.action));
      await restore(checkpoint);

      expect(events.filter((action) => action === 'restored')).toEqual(['restored']);
      expect(events.filter((action) => action === 'created')).toEqual(['created']);
    });

    it('detects snapshot hash tampering and retains current work through rollback', async () => {
      write('src/app.txt', 'checkpoint bytes\n');
      const checkpoint = await createBaseline(['src/app.txt'], { type: 'after_edit' });
      write('src/app.txt', 'current valuable work\n');
      const impact = await manager.previewRestore(checkpoint.id);
      fs.writeFileSync(storedSnapshotFile(checkpoint.id, 'src/app.txt'), 'tampered snapshot\n');

      await expect(manager.restoreCheckpoint(checkpoint.id, impact.confirmationToken)).rejects.toMatchObject({
        code: 'RESTORE_BLOCKED',
      });
      expect(text('src/app.txt')).toBe('current valuable work\n');
      expect(manager.listCheckpoints(TASK_ID)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'manual', metadata: expect.objectContaining({ reason: 'before_restore' }) }),
      ]));
    });

    it('blocks captured content when its persisted snapshot path is unavailable', async () => {
      database.createCheckpoint({
        id: 'missing-snapshot',
        task_id: TASK_ID,
        project_path: fs.realpathSync(projectPath),
        type: 'after_edit',
        created_at: new Date(nowMs).toISOString(),
        git_commit: currentHead(),
        snapshot_path: null,
        metadata_json: JSON.stringify({
          runId: 'run-missing-snapshot',
          branch: 'main',
          baselineFiles: [],
          touchedFiles: ['src/app.txt'],
        }),
      }, [{
        checkpoint_id: 'missing-snapshot',
        file_path: 'src/app.txt',
        hash: crypto.createHash('sha256').update('unavailable').digest('hex'),
        size: 11,
        modified_at: new Date(nowMs).toISOString(),
      }]);
      write('src/app.txt', 'current valuable work\n');

      const impact = await manager.previewRestore('missing-snapshot');

      expect(impact.restoreFiles).toEqual([]);
      expect(impact.blockedFiles).toEqual([
        expect.objectContaining({ filePath: 'src/app.txt' }),
      ]);
      await expect(manager.restoreCheckpoint('missing-snapshot', impact.confirmationToken))
        .rejects.toMatchObject({ code: 'RESTORE_BLOCKED' });
      expect(text('src/app.txt')).toBe('current valuable work\n');
    });

    it('rollback removes a file that was absent before a partially failed restore', async () => {
      write('a-created.txt', 'checkpoint A\n');
      write('z-created.txt', 'checkpoint Z\n');
      const checkpoint = await createBaseline(
        ['a-created.txt', 'z-created.txt'],
        { type: 'after_edit' },
      );
      const mutationEvents: FileMutationEvent[] = [];
      const mutations = new FileMutationManager({
        recordEvent: (event) => mutationEvents.push(event),
      });
      manager = makeManager({ mutations } as ManagerOptions);
      remove('a-created.txt');
      write('z-created.txt', 'valuable current Z\n');
      const impact = await manager.previewRestore(checkpoint.id);
      const originalWriteFile = fs.promises.writeFile.bind(fs.promises);
      const failingPath = path.resolve(projectPath, 'z-created.txt');
      let injectedFailure = false;
      vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
        if (!injectedFailure && path.resolve(String(file)) === failingPath) {
          injectedFailure = true;
          const error = new Error('injected restore write failure') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return originalWriteFile(file, data, options);
      });

      await expect(manager.restoreCheckpoint(checkpoint.id, impact.confirmationToken))
        .rejects.toThrow('injected restore write failure');

      expect(injectedFailure).toBe(true);
      expect(exists('a-created.txt')).toBe(false);
      expect(text('z-created.txt')).toBe('valuable current Z\n');
      const rollback = manager.listCheckpoints(TASK_ID).find(
        (item) => item.type === 'manual' && item.metadata.reason === 'before_restore',
      );
      expect(rollback?.metadata.touchedFiles).toEqual(['a-created.txt', 'z-created.txt']);
      expect(mutationEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'checkpoint_restore',
          status: 'rolled_back',
          projectPath: fs.realpathSync(projectPath),
          taskId: TASK_ID,
          sessionId: TASK_ID,
          filePaths: ['a-created.txt', 'z-created.txt'],
        }),
      ]));

      await mutations.runMutation({
        kind: 'apply_patch',
        projectPath,
        filePaths: ['lease-probe.txt'],
      }, {
        mutate: (context) => context.writeFile('lease-probe.txt', 'lease released\n'),
      });
      expect(text('lease-probe.txt')).toBe('lease released\n');
    });

    it('restores committed binary files as raw bytes via the Git object fallback', async () => {
      const original = Buffer.from([0, 1, 255, 64, 13, 10]);
      write('binary-committed.dat', original);
      git(projectPath, ['add', '--', 'binary-committed.dat']);
      git(projectPath, ['commit', '-m', 'test: add binary fixture']);
      const checkpoint = await createBaseline(['binary-committed.dat']);
      write('binary-committed.dat', Buffer.from([9, 8, 7]));
      await restore(checkpoint);

      expect(read('binary-committed.dat')).toEqual(original);
      expect(manager.getCheckpoint(checkpoint.id)?.gitCommit).toBe(currentHead());
    });

    it('recreates a missing nested directory when restoring a committed file', async () => {
      write('nested/deep/file.txt', 'nested committed\n');
      git(projectPath, ['add', '--', 'nested/deep/file.txt']);
      git(projectPath, ['commit', '-m', 'test: add nested fixture']);
      const checkpoint = await createBaseline(['nested/deep/file.txt']);
      remove('nested/deep/file.txt');
      fs.rmdirSync(path.join(projectPath, 'nested', 'deep'));
      fs.rmdirSync(path.join(projectPath, 'nested'));
      await restore(checkpoint);

      expect(text('nested/deep/file.txt')).toBe('nested committed\n');
      expect(exists('nested/deep/file.txt')).toBe(true);
    });

    it('consumes a confirmation token after one successful restore', async () => {
      const checkpoint = await createBaseline();
      write('src/app.txt', 'AI change\n');
      const impact = await manager.previewRestore(checkpoint.id);
      await manager.restoreCheckpoint(checkpoint.id, impact.confirmationToken);

      await expect(manager.restoreCheckpoint(checkpoint.id, impact.confirmationToken)).rejects.toMatchObject({
        code: 'CONFIRMATION_REQUIRED',
      });
      expect(text('src/app.txt')).toBe('committed app\n');
    });
  });

  describe('user modification protection (15+ cases)', () => {
    it('lists an unrelated dirty tracked baseline file as preserved', async () => {
      write('user.txt', 'user dirty baseline\n');
      const checkpoint = await createBaseline(['src/app.txt']);
      write('src/app.txt', 'AI change\n');
      const impact = await manager.previewRestore(checkpoint.id);

      expect(impact.preservedUserFiles).toContain('user.txt');
      expect(impact.restoreFiles).toEqual(['src/app.txt']);
    });

    it('lists an unrelated user untracked baseline file as preserved', async () => {
      write('notes.local', 'private user notes\n');
      const checkpoint = await createBaseline(['src/app.txt']);
      write('src/app.txt', 'AI change\n');
      const impact = await manager.previewRestore(checkpoint.id);

      expect(impact.preservedUserFiles).toContain('notes.local');
      expect(impact.deleteFiles).toEqual([]);
    });

    it('sorts and deduplicates preserved baseline paths', async () => {
      write('z-user.txt', 'z\n');
      write('a-user.txt', 'a\n');
      const checkpoint = await createBaseline(['src/app.txt']);
      write('src/app.txt', 'AI\n');
      const impact = await manager.previewRestore(checkpoint.id);

      expect(impact.preservedUserFiles).toEqual(['a-user.txt', 'z-user.txt']);
      expect(new Set(impact.preservedUserFiles).size).toBe(2);
    });

    it('does not alter an unrelated dirty tracked file during restore', async () => {
      write('user.txt', 'valuable user dirty content\n');
      const checkpoint = await createBaseline(['src/app.txt']);
      write('src/app.txt', 'AI change\n');
      await restore(checkpoint);

      expect(text('user.txt')).toBe('valuable user dirty content\n');
      expect(git(projectPath, ['status', '--porcelain=v1', '--', 'user.txt'])).toBe('M user.txt');
    });

    it('does not alter an unrelated user untracked file during restore', async () => {
      write('private.env', 'SECRET=user-value\n');
      const checkpoint = await createBaseline(['src/app.txt']);
      write('src/app.txt', 'AI change\n');
      await restore(checkpoint);

      expect(text('private.env')).toBe('SECRET=user-value\n');
      expect(git(projectPath, ['status', '--porcelain=v1', '--', 'private.env'])).toContain('?? private.env');
    });

    it('restores the user dirty baseline when Claude touched that same file', async () => {
      write('src/app.txt', 'user baseline on shared file\n');
      const checkpoint = await createBaseline(['src/app.txt']);
      write('src/app.txt', 'Claude content\n');
      await restore(checkpoint);

      expect(text('src/app.txt')).toBe('user baseline on shared file\n');
      expect(text('src/app.txt')).not.toBe('committed app\n');
    });

    it('restores the user untracked baseline when Claude touched that same file', async () => {
      write('scratch.txt', 'user scratch baseline\n');
      const checkpoint = await createBaseline(['scratch.txt']);
      write('scratch.txt', 'Claude scratch content\n');
      await restore(checkpoint);

      expect(text('scratch.txt')).toBe('user scratch baseline\n');
      expect(exists('scratch.txt')).toBe(true);
    });

    it('blocks an existing ignored text file while later checkpoints keep current bytes', async () => {
      commitIgnoreRules('.env');
      write('.env', 'TOKEN=user-secret\r\n');
      const before = await manager.startTask({
        runId: 'run-ignored-text',
        projectKey: projectPath,
        sessionKey: `${projectPath}::${TASK_ID}`,
        projectPath,
        prompt: 'update ignored environment configuration',
      });
      expect((before as Checkpoint).files.map((file) => file.filePath)).not.toContain('.env');

      await manager.noteTaskFile(TASK_ID, projectPath, '.env');
      write('.env', 'TOKEN=claude-secret\n');
      const afterEdit = await manager.createTaskCheckpoint(TASK_ID, 'after_edit', {
        runId: 'run-ignored-text',
      });
      const impact = await manager.previewRestore((before as Checkpoint).id);

      expect(impact.restoreFiles).toEqual([]);
      expect(impact.deleteFiles).toEqual([]);
      expect(impact.blockedFiles).toEqual([expect.objectContaining({ filePath: '.env' })]);
      await expect(manager.restoreCheckpoint(
        (before as Checkpoint).id,
        impact.confirmationToken,
      )).rejects.toMatchObject({ code: 'RESTORE_BLOCKED' });
      expect(read('.env')).toEqual(Buffer.from('TOKEN=claude-secret\n'));
      expect(fs.readFileSync(storedSnapshotFile(afterEdit.id, '.env')))
        .toEqual(Buffer.from('TOKEN=claude-secret\n'));
    });

    it('blocks existing ignored binary bytes without classifying them as absent', async () => {
      commitIgnoreRules('*.ignored.bin');
      const original = Buffer.from([0, 255, 1, 254, 2, 128, 3]);
      const claudeBytes = Buffer.from([9, 8, 0, 7, 6]);
      write('private.ignored.bin', original);
      const before = await manager.startTask({
        runId: 'run-ignored-binary',
        projectKey: projectPath,
        sessionKey: `${projectPath}::${TASK_ID}`,
        projectPath,
        prompt: 'update ignored binary',
      });

      await manager.noteTaskFile(TASK_ID, projectPath, 'private.ignored.bin');
      write('private.ignored.bin', claudeBytes);
      const afterEdit = await manager.createTaskCheckpoint(TASK_ID, 'after_edit', {
        runId: 'run-ignored-binary',
      });
      const impact = await manager.previewRestore((before as Checkpoint).id);

      expect(impact.restoreFiles).toEqual([]);
      expect(impact.deleteFiles).toEqual([]);
      expect(impact.blockedFiles).toEqual([
        expect.objectContaining({ filePath: 'private.ignored.bin' }),
      ]);
      await expect(manager.restoreCheckpoint(
        (before as Checkpoint).id,
        impact.confirmationToken,
      )).rejects.toMatchObject({ code: 'RESTORE_BLOCKED' });
      expect(read('private.ignored.bin')).toEqual(claudeBytes);
      expect(read('private.ignored.bin')).not.toEqual(original);
      expect(fs.readFileSync(storedSnapshotFile(afterEdit.id, 'private.ignored.bin')))
        .toEqual(claudeBytes);
    });

    it('blocks a newly created ignored file because asynchronous events cannot prove absence', async () => {
      commitIgnoreRules('generated.ignored');
      const before = await manager.startTask({
        runId: 'run-new-ignored',
        projectKey: projectPath,
        sessionKey: `${projectPath}::${TASK_ID}`,
        projectPath,
        prompt: 'create ignored output',
      });

      await manager.noteTaskFile(TASK_ID, projectPath, 'generated.ignored');
      write('generated.ignored', Buffer.from([4, 3, 2, 1, 0]));
      const afterEdit = await manager.createTaskCheckpoint(TASK_ID, 'after_edit', {
        runId: 'run-new-ignored',
      });
      const impact = await manager.previewRestore((before as Checkpoint).id);

      expect(impact.restoreFiles).toEqual([]);
      expect(impact.deleteFiles).toEqual([]);
      expect(impact.blockedFiles).toEqual([
        expect.objectContaining({ filePath: 'generated.ignored' }),
      ]);
      await expect(manager.restoreCheckpoint(
        (before as Checkpoint).id,
        impact.confirmationToken,
      )).rejects.toMatchObject({ code: 'RESTORE_BLOCKED' });
      expect(exists('generated.ignored')).toBe(true);
      expect(fs.readFileSync(storedSnapshotFile(afterEdit.id, 'generated.ignored')))
        .toEqual(Buffer.from([4, 3, 2, 1, 0]));
    });

    it.each([
      ['existing', true],
      ['new', false],
    ])('blocks a post-write-only observation of an %s ignored file', async (_label, existing) => {
      commitIgnoreRules('.env');
      if (existing) write('.env', 'user bytes that are no longer observable\n');
      const before = await manager.startTask({
        runId: `run-post-ignored-${String(existing)}`,
        projectKey: projectPath,
        sessionKey: `${projectPath}::${TASK_ID}`,
        projectPath,
        prompt: 'receive only a post-write file event',
      });
      write('.env', 'Claude already wrote these bytes\n');

      await manager.noteTaskFile(TASK_ID, projectPath, '.env');
      await manager.createTaskCheckpoint(TASK_ID, 'after_edit', {
        runId: `run-post-ignored-${String(existing)}`,
      });
      const impact = await manager.previewRestore((before as Checkpoint).id);
      const manifest = JSON.parse(fs.readFileSync(
        path.join(storedSnapshotPath((before as Checkpoint).id), 'manifest.json'),
        'utf8',
      )) as { files: Array<Record<string, unknown>> };

      expect(impact.restoreFiles).toEqual([]);
      expect(impact.deleteFiles).toEqual([]);
      expect(impact.blockedFiles).toEqual([
        expect.objectContaining({ filePath: '.env' }),
      ]);
      await expect(manager.restoreCheckpoint(
        (before as Checkpoint).id,
        impact.confirmationToken,
      )).rejects.toMatchObject({ code: 'RESTORE_BLOCKED' });
      expect(text('.env')).toBe('Claude already wrote these bytes\n');
      expect(manifest.files).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file_path: '.env',
          hash: 'absent',
          modified_at: '0001-01-01T00:00:00.000Z',
        }),
      ]));
      expect(fs.existsSync(storedSnapshotFile((before as Checkpoint).id, '.env'))).toBe(false);
    });

    it('blocks an uncaptured ignored path discovered only from a persisted post-write change', async () => {
      commitIgnoreRules('.env');
      write('.env', 'user bytes hidden from Git status\n');
      const before = await manager.startTask({
        runId: 'run-persisted-post-ignored',
        projectKey: projectPath,
        sessionKey: `${projectPath}::${TASK_ID}`,
        projectPath,
        prompt: 'receive a persisted post-write path only',
      });
      write('.env', 'Claude post-write bytes\n');
      database.createFileChange(
        `${TASK_ID}:run-persisted-post-ignored:1`,
        TASK_ID,
        '.env',
        'modified',
        1,
        1,
      );

      const impact = await manager.previewRestore((before as Checkpoint).id);

      expect(impact.restoreFiles).toEqual([]);
      expect(impact.deleteFiles).toEqual([]);
      expect(impact.blockedFiles).toEqual([
        expect.objectContaining({ filePath: '.env' }),
      ]);
      expect(text('.env')).toBe('Claude post-write bytes\n');
    });

    it('blocks a formerly ignored path when a nested .gitignore changed during the task', async () => {
      write('config/.gitignore', 'secret.env\n');
      git(projectPath, ['add', '--', 'config/.gitignore']);
      git(projectPath, ['commit', '-m', 'test: add nested ignore rule']);
      write('config/secret.env', 'user nested secret\n');
      const before = await manager.startTask({
        runId: 'run-changed-nested-ignore',
        projectKey: projectPath,
        sessionKey: `${projectPath}::${TASK_ID}`,
        projectPath,
        prompt: 'change an ignore rule before touching its file',
      });
      write('config/.gitignore', 'other.env\n');
      write('config/secret.env', 'Claude nested secret\n');
      database.createFileChange(
        `${TASK_ID}:run-changed-nested-ignore:1`,
        TASK_ID,
        'config/secret.env',
        'modified',
        1,
        1,
      );

      const impact = await manager.previewRestore((before as Checkpoint).id);

      expect(impact.restoreFiles).toEqual([]);
      expect(impact.deleteFiles).toEqual([]);
      expect(impact.blockedFiles).toEqual([
        expect.objectContaining({ filePath: 'config/secret.env' }),
      ]);
      expect(text('config/secret.env')).toBe('Claude nested secret\n');
    });

    it('blocks a user file hidden by a pre-task dirty .gitignore after Agent restores ignore rules to HEAD', async () => {
      commitIgnoreRules('head-only.ignored');
      write('.gitignore', '.env\n');
      write('.env', 'valuable user bytes\r\n');
      expect(git(projectPath, ['status', '--porcelain=v1', '--untracked-files=all']))
        .toBe('M .gitignore');
      const before = await manager.startTask({
        runId: 'run-dirty-ignore-restored',
        projectKey: projectPath,
        sessionKey: `${projectPath}::${TASK_ID}`,
        projectPath,
        prompt: 'restore ignore rules before touching a hidden user file',
      });
      expect((before as Checkpoint).metadata.baselineFiles).toEqual(expect.arrayContaining([
        expect.objectContaining({ filePath: '.gitignore', changeType: 'modified' }),
      ]));

      write('.gitignore', 'head-only.ignored\n');
      expect(git(projectPath, ['status', '--porcelain=v1', '--untracked-files=all']))
        .toBe('?? .env');
      await manager.noteTaskFile(TASK_ID, projectPath, '.env');
      await manager.createTaskCheckpoint(TASK_ID, 'after_edit', {
        runId: 'run-dirty-ignore-restored',
      });
      const impact = await manager.previewRestore((before as Checkpoint).id);

      expect(impact.restoreFiles).toEqual(['.gitignore']);
      expect(impact.deleteFiles).toEqual([]);
      expect(impact.blockedFiles).toEqual([
        expect.objectContaining({ filePath: '.env' }),
      ]);
      await expect(manager.restoreCheckpoint(
        (before as Checkpoint).id,
        impact.confirmationToken,
      )).rejects.toMatchObject({ code: 'RESTORE_BLOCKED' });
      expect(read('.env')).toEqual(Buffer.from('valuable user bytes\r\n'));
      expect(text('.gitignore')).toBe('head-only.ignored\n');
    });

    it('persists an unknown ignored marker across a manager and database restart', async () => {
      commitIgnoreRules('.env');
      write('.env', 'persistent user secret\r\n');
      const before = await manager.startTask({
        runId: 'run-persisted-ignored-baseline',
        projectKey: projectPath,
        sessionKey: `${projectPath}::${TASK_ID}`,
        projectPath,
        prompt: 'capture ignored baseline before restart',
      });
      await manager.noteTaskFile(TASK_ID, projectPath, '.env');
      const manifestPath = path.join(storedSnapshotPath((before as Checkpoint).id), 'manifest.json');
      const beforeRestartManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        files: unknown[];
      };
      expect(beforeRestartManifest.files).toEqual(
        database.listCheckpointFiles((before as Checkpoint).id),
      );

      database.close();
      database = new AppDatabase(databasePath);
      manager = makeManager();
      const afterRestartManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        files: unknown[];
      };
      expect(afterRestartManifest.files).toEqual(
        database.listCheckpointFiles((before as Checkpoint).id),
      );
      write('.env', 'Claude after restart\n');
      const impact = await manager.previewRestore((before as Checkpoint).id);

      expect(impact.restoreFiles).toEqual([]);
      expect(impact.deleteFiles).toEqual([]);
      expect(impact.blockedFiles).toEqual([expect.objectContaining({ filePath: '.env' })]);
      expect(read('.env')).toEqual(Buffer.from('Claude after restart\n'));
    });

    it('does not trust or copy ignored bytes from an asynchronous tool_started observation', async () => {
      commitIgnoreRules('.env');
      write('.env', 'user bytes at tool start\n');
      const before = await manager.startTask({
        runId: 'run-racing-ignored-baseline',
        projectKey: projectPath,
        sessionKey: `${projectPath}::${TASK_ID}`,
        projectPath,
        prompt: 'race an ignored write against baseline capture',
      });
      const copyFile = vi.spyOn(fs.promises, 'copyFile');

      await manager.noteTaskFile(TASK_ID, projectPath, '.env');
      expect(copyFile).not.toHaveBeenCalled();
      write('.env', 'Claude raced the snapshot\n');
      const impact = await manager.previewRestore((before as Checkpoint).id);

      expect(impact.restoreFiles).toEqual([]);
      expect(impact.deleteFiles).toEqual([]);
      expect(impact.blockedFiles).toEqual([
        expect.objectContaining({ filePath: '.env' }),
      ]);
      expect(text('.env')).toBe('Claude raced the snapshot\n');
    });

    it('leaves an ignored Bash-only change untouched when no path event made it observable', async () => {
      commitIgnoreRules('.env');
      write('.env', 'user baseline\n');
      const before = await manager.startTask({
        runId: 'run-bash-ignored-unobservable',
        projectKey: projectPath,
        sessionKey: `${projectPath}::${TASK_ID}`,
        projectPath,
        prompt: 'run a Bash script without file events',
      });
      write('.env', 'Bash changed ignored bytes\n');

      const completed = await manager.createTaskCheckpoint(TASK_ID, 'task_completed', {
        runId: 'run-bash-ignored-unobservable',
      });
      const impact = await manager.previewRestore((before as Checkpoint).id);

      expect(completed.metadata.touchedFiles).toEqual([]);
      expect(impact.restoreFiles).toEqual([]);
      expect(impact.deleteFiles).toEqual([]);
      expect(text('.env')).toBe('Bash changed ignored bytes\n');
    });

    it('deletes only a Claude-created file while preserving another user untracked file', async () => {
      write('user-note.txt', 'keep me\n');
      const checkpoint = await createBaseline(['generated.txt']);
      write('generated.txt', 'delete me\n');
      await restore(checkpoint);

      expect(exists('generated.txt')).toBe(false);
      expect(text('user-note.txt')).toBe('keep me\n');
    });

    it('blocks a touched staged file in the restore preview', async () => {
      const checkpoint = await createBaseline(['src/app.txt']);
      write('src/app.txt', 'staged AI change\n');
      git(projectPath, ['add', '--', 'src/app.txt']);
      const impact = await manager.previewRestore(checkpoint.id);

      expect(impact.blockedFiles).toEqual([
        expect.objectContaining({ filePath: 'src/app.txt' }),
      ]);
      expect(impact.restoreFiles).toEqual([]);
    });

    it('rejects a restore containing staged blockers without changing bytes', async () => {
      const checkpoint = await createBaseline(['src/app.txt']);
      write('src/app.txt', 'staged valuable content\n');
      git(projectPath, ['add', '--', 'src/app.txt']);
      const impact = await manager.previewRestore(checkpoint.id);

      await expect(manager.restoreCheckpoint(checkpoint.id, impact.confirmationToken)).rejects.toMatchObject({
        code: 'RESTORE_BLOCKED',
      });
      expect(text('src/app.txt')).toBe('staged valuable content\n');
    });

    it('allows restoring a touched file when only an unrelated file is staged', async () => {
      const checkpoint = await createBaseline(['src/app.txt']);
      write('src/app.txt', 'AI change\n');
      write('user.txt', 'unrelated staged user change\n');
      git(projectPath, ['add', '--', 'user.txt']);
      const impact = await manager.previewRestore(checkpoint.id);
      await manager.restoreCheckpoint(checkpoint.id, impact.confirmationToken);

      expect(impact.blockedFiles).toEqual([]);
      expect(text('src/app.txt')).toBe('committed app\n');
      expect(text('user.txt')).toBe('unrelated staged user change\n');
    });

    it('blocks an unmerged touched file reported by Git', async () => {
      const checkpoint = await createBaseline(['src/app.txt']);
      write('src/app.txt', 'conflicted work\n');
      const status = await new GitWorkspaceService().getStatus(projectPath);
      const mockedGit = new GitWorkspaceService();
      vi.spyOn(mockedGit, 'getStatus').mockResolvedValue({
        ...status,
        files: status.files.map((file) => file.filePath === 'src/app.txt'
          ? { ...file, changeType: 'unmerged' as const }
          : file),
      });
      manager = makeManager({ git: mockedGit });
      const impact = await manager.previewRestore(checkpoint.id);

      expect(impact.blockedFiles).toEqual([
        expect.objectContaining({ filePath: 'src/app.txt' }),
      ]);
      expect(text('src/app.txt')).toBe('conflicted work\n');
    });

    it.each([
      ['parent traversal', '../outside.txt'],
      ['absolute Windows path', 'C:\\outside.txt'],
      ['Git metadata', '.git/config'],
      ['null-byte path', 'bad\0path.txt'],
    ])('blocks malicious persisted touched metadata: %s', async (_label, maliciousPath) => {
      database.createCheckpoint({
        id: `unsafe-${idSequence++}`,
        task_id: TASK_ID,
        project_path: fs.realpathSync(projectPath),
        type: 'manual',
        created_at: new Date(nowMs).toISOString(),
        git_commit: currentHead(),
        snapshot_path: null,
        metadata_json: JSON.stringify({
          branch: 'main',
          baselineFiles: [],
          touchedFiles: [maliciousPath],
        }),
      });
      const checkpoint = manager.listCheckpoints(TASK_ID)[0];
      const impact = await manager.previewRestore(checkpoint.id);

      expect(impact.blockedFiles).toEqual([
        expect.objectContaining({ filePath: maliciousPath }),
      ]);
      expect(impact.restoreFiles).toEqual([]);
      expect(impact.deleteFiles).toEqual([]);
    });

    it('cannot use malicious metadata to modify a file outside the repository', async () => {
      const outside = path.join(directory, 'outside.txt');
      fs.writeFileSync(outside, 'outside valuable content\n');
      database.createCheckpoint({
        id: 'unsafe-outside',
        task_id: TASK_ID,
        project_path: fs.realpathSync(projectPath),
        type: 'manual',
        created_at: new Date(nowMs).toISOString(),
        git_commit: currentHead(),
        snapshot_path: null,
        metadata_json: JSON.stringify({ branch: null, baselineFiles: [], touchedFiles: ['../outside.txt'] }),
      });
      const impact = await manager.previewRestore('unsafe-outside');

      await expect(manager.restoreCheckpoint('unsafe-outside', impact.confirmationToken)).rejects.toMatchObject({
        code: 'RESTORE_BLOCKED',
      });
      expect(fs.readFileSync(outside, 'utf8')).toBe('outside valuable content\n');
    });

    it('ignores unsafe legacy file-change paths while keeping legitimate touched files', async () => {
      const checkpoint = await createBaseline(['src/app.txt']);
      database.createFileChange('unsafe-change', TASK_ID, '../outside.txt', 'modified', 1, 1);
      write('src/app.txt', 'AI change\n');
      const impact = await manager.previewRestore(checkpoint.id);

      expect(impact.restoreFiles).toEqual(['src/app.txt']);
      expect(impact.blockedFiles).toEqual([]);
    });

    it('restores only the touched subset of multiple modified files', async () => {
      const checkpoint = await createBaseline(['src/app.txt']);
      write('src/app.txt', 'AI touched\n');
      write('user.txt', 'user changed later\n');
      await restore(checkpoint);

      expect(text('src/app.txt')).toBe('committed app\n');
      expect(text('user.txt')).toBe('user changed later\n');
    });

    it('restores multiple touched files while preserving a third user file', async () => {
      write('second.txt', 'second committed\n');
      git(projectPath, ['add', '--', 'second.txt']);
      git(projectPath, ['commit', '-m', 'test: add second fixture']);
      write('user.txt', 'user baseline dirty\n');
      const checkpoint = await createBaseline(['src/app.txt', 'second.txt']);
      write('src/app.txt', 'AI first\n');
      write('second.txt', 'AI second\n');
      await restore(checkpoint);

      expect(text('src/app.txt')).toBe('committed app\n');
      expect(text('second.txt')).toBe('second committed\n');
      expect(text('user.txt')).toBe('user baseline dirty\n');
    });

    it('keeps user baseline protection metadata after an application restart', async () => {
      write('user.txt', 'persistent user dirty\n');
      const checkpoint = await createBaseline(['src/app.txt']);
      database.close();
      database = new AppDatabase(databasePath);
      manager = makeManager();
      write('src/app.txt', 'AI after restart\n');
      const impact = await manager.previewRestore(checkpoint.id);

      expect(impact.preservedUserFiles).toContain('user.txt');
      expect(impact.restoreFiles).toEqual(['src/app.txt']);
    });

    it('filters before-task restore scope to the checkpoint runId', async () => {
      const first = await manager.startTask({
        runId: 'run-old', projectKey: projectPath, sessionKey: `${projectPath}::${TASK_ID}`,
        projectPath, prompt: 'old run',
      });
      await manager.noteTaskFile(TASK_ID, projectPath, 'src/app.txt');
      write('src/app.txt', 'old run path changed\n');
      await manager.createTaskCheckpoint(TASK_ID, 'after_edit', { runId: 'run-old' });
      const second = await manager.startTask({
        runId: 'run-current', projectKey: projectPath, sessionKey: `${projectPath}::${TASK_ID}`,
        projectPath, prompt: 'current run',
      });
      await manager.noteTaskFile(TASK_ID, projectPath, 'user.txt');
      write('user.txt', 'current run changed\n');
      await manager.createTaskCheckpoint(TASK_ID, 'after_edit', { runId: 'run-current' });

      const impact = await manager.previewRestore((second ?? first)!.id);

      expect(impact.restoreFiles).toEqual(['user.txt']);
      expect(impact.restoreFiles).not.toContain('src/app.txt');
      expect(manager.listCheckpoints(TASK_ID).filter((item) => item.metadata.runId === 'run-old'))
        .toHaveLength(2);
    });
  });

  describe('commitTaskChanges integration (15+ cases)', () => {
    async function beginCommitRun(runId = 'run-commit'): Promise<void> {
      await manager.startTask({
        runId,
        projectKey: projectPath,
        sessionKey: `${projectPath}::${TASK_ID}`,
        projectPath,
        prompt: 'prepare commit integration test',
      });
    }

    async function prepareTrackedCommit(content = 'task commit content\n'): Promise<void> {
      await beginCommitRun();
      await manager.noteTaskFile(TASK_ID, projectPath, 'src/app.txt');
      write('src/app.txt', content);
      database.updateTask(TASK_ID, { status: 'completed' });
    }

    function committedFiles(): string[] {
      return git(projectPath, ['show', '--pretty=format:', '--name-only', 'HEAD'])
        .split(/\r?\n/u)
        .filter(Boolean)
        .sort();
    }

    it('requires createCommitPreview before a confirmed commit', async () => {
      await prepareTrackedCommit();
      const originalHead = currentHead();

      await expect(manager.commitTaskChanges(TASK_ID, 'feat(app): ungranted', true))
        .rejects.toMatchObject({ code: 'STALE_CONFIRMATION' });
      expect(currentHead()).toBe(originalHead);
      expect(text('src/app.txt')).toBe('task commit content\n');
    });

    it('holds the manager-level project mutation lease for the complete commit', async () => {
      const mutations = new FileMutationManager();
      manager = makeManager({ mutations } as ManagerOptions);
      await prepareTrackedCommit();
      const preview = await manager.createCommitPreview(TASK_ID);
      const originalHead = currentHead();
      const activeWriter = await mutations.acquireExternalProcessLease({
        mutationId: 'active-writer-during-commit',
        kind: 'claude_run',
        projectPath,
        taskId: TASK_ID,
        sessionId: TASK_ID,
        filePaths: ['src/app.txt'],
      });

      try {
        await expect(manager.commitTaskChanges(TASK_ID, preview.subject, true))
          .rejects.toMatchObject({ code: 'TASK_PROJECT_BUSY' });
        expect(currentHead()).toBe(originalHead);
      } finally {
        activeWriter.release();
      }

      await expect(manager.commitTaskChanges(TASK_ID, preview.subject, true))
        .resolves.toMatchObject({ files: ['src/app.txt'] });
    });

    it('requires explicit confirmed=true without consuming a valid preview grant', async () => {
      await prepareTrackedCommit();
      const preview = await manager.createCommitPreview(TASK_ID);

      await expect(manager.commitTaskChanges(TASK_ID, preview.subject, false))
        .rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
      const committed = await manager.commitTaskChanges(TASK_ID, preview.subject, true);

      expect(committed.subject).toBe(preview.subject);
      expect(committed.files).toEqual(['src/app.txt']);
    });

    it('rejects a subject different from the granted preview and consumes the grant', async () => {
      await prepareTrackedCommit();
      const preview = await manager.createCommitPreview(TASK_ID);

      await expect(manager.commitTaskChanges(TASK_ID, `${preview.subject} changed`, true))
        .rejects.toMatchObject({ code: 'STALE_CONFIRMATION' });
      await expect(manager.commitTaskChanges(TASK_ID, preview.subject, true))
        .rejects.toMatchObject({ code: 'STALE_CONFIRMATION' });
      expect(committedFiles()).toEqual(['src/app.txt', 'user.txt']);
    });

    it('rejects task content changed after preview using the content fingerprint', async () => {
      await prepareTrackedCommit('previewed bytes\n');
      const preview = await manager.createCommitPreview(TASK_ID);
      const originalHead = currentHead();
      write('src/app.txt', 'changed after preview\n');

      await expect(manager.commitTaskChanges(TASK_ID, preview.subject, true))
        .rejects.toMatchObject({ code: 'STALE_CONFIRMATION' });
      expect(currentHead()).toBe(originalHead);
      expect(text('src/app.txt')).toBe('changed after preview\n');
    });

    it('rejects a commit when the branch changes at the previewed HEAD', async () => {
      await prepareTrackedCommit();
      const preview = await manager.createCommitPreview(TASK_ID);
      const originalHead = currentHead();
      git(projectPath, ['checkout', '-b', 'commit-preview-drift']);

      await expect(manager.commitTaskChanges(TASK_ID, preview.subject, true))
        .rejects.toMatchObject({ code: 'STALE_CONFIRMATION' });
      expect(currentHead()).toBe(originalHead);
      expect(git(projectPath, ['status', '--porcelain=v1', '--', 'src/app.txt']))
        .toBe('M src/app.txt');
    });

    it('rejects a commit when HEAD moves without changing a previewed file', async () => {
      await prepareTrackedCommit();
      const preview = await manager.createCommitPreview(TASK_ID);
      write('unrelated-head-change.txt', 'unrelated commit\n');
      git(projectPath, ['add', '--', 'unrelated-head-change.txt']);
      git(projectPath, ['commit', '-m', 'test: move HEAD after commit preview']);
      const movedHead = currentHead();

      await expect(manager.commitTaskChanges(TASK_ID, preview.subject, true))
        .rejects.toMatchObject({ code: 'STALE_CONFIRMATION' });
      expect(currentHead()).toBe(movedHead);
      expect(git(projectPath, ['status', '--porcelain=v1', '--', 'src/app.txt']))
        .toBe('M src/app.txt');
    });

    it('rejects deleting a task file after its preview', async () => {
      await prepareTrackedCommit('will be deleted\n');
      const preview = await manager.createCommitPreview(TASK_ID);
      remove('src/app.txt');

      await expect(manager.commitTaskChanges(TASK_ID, preview.subject, true))
        .rejects.toMatchObject({ code: 'STALE_CONFIRMATION' });
      expect(exists('src/app.txt')).toBe(false);
      expect(git(projectPath, ['status', '--porcelain=v1', '--', 'src/app.txt'])).toBe('D src/app.txt');
    });

    it('rejects a changed preview file set after another path becomes touched', async () => {
      await prepareTrackedCommit();
      const preview = await manager.createCommitPreview(TASK_ID);
      await manager.noteTaskFile(TASK_ID, projectPath, 'new-after-preview.txt');
      write('new-after-preview.txt', 'late file\n');

      await expect(manager.commitTaskChanges(TASK_ID, preview.subject, true))
        .rejects.toMatchObject({ code: 'STALE_CONFIRMATION' });
      expect(exists('new-after-preview.txt')).toBe(true);
      expect(currentHead()).toBe(database.getCheckpoint(database.listCheckpoints(TASK_ID).at(-1)?.id ?? '')?.git_commit);
    });

    it('keeps a preview grant while the task is active and allows it after completion', async () => {
      await prepareTrackedCommit();
      const preview = await manager.createCommitPreview(TASK_ID);
      database.updateTask(TASK_ID, { status: 'running' });

      await expect(manager.commitTaskChanges(TASK_ID, preview.subject, true))
        .rejects.toMatchObject({ code: 'TASK_ACTIVE' });
      database.updateTask(TASK_ID, { status: 'completed' });
      await expect(manager.commitTaskChanges(TASK_ID, preview.subject, true)).resolves.toMatchObject({
        subject: preview.subject,
        files: ['src/app.txt'],
      });
    });

    it('rejects a commit preview with no current-run files', async () => {
      await beginCommitRun();
      database.updateTask(TASK_ID, { status: 'completed' });
      const preview = await manager.createCommitPreview(TASK_ID);

      expect(preview.files).toEqual([]);
      await expect(manager.commitTaskChanges(TASK_ID, preview.subject, true))
        .rejects.toMatchObject({ code: 'COMMIT_FAILED' });
      expect(git(projectPath, ['status', '--porcelain=v1'])).toBe('');
    });

    it('commits only touched files from the current run', async () => {
      await beginCommitRun('run-old');
      await manager.noteTaskFile(TASK_ID, projectPath, 'user.txt');
      write('user.txt', 'old run dirty file\n');
      await manager.createTaskCheckpoint(TASK_ID, 'after_edit', { runId: 'run-old' });
      await beginCommitRun('run-current');
      await manager.noteTaskFile(TASK_ID, projectPath, 'src/app.txt');
      write('src/app.txt', 'current run task file\n');
      database.updateTask(TASK_ID, { status: 'completed' });
      const preview = await manager.createCommitPreview(TASK_ID);
      const result = await manager.commitTaskChanges(TASK_ID, preview.subject, true);

      expect(result.files).toEqual(['src/app.txt']);
      expect(committedFiles()).toEqual(['src/app.txt']);
      expect(text('user.txt')).toBe('old run dirty file\n');
      expect(git(projectPath, ['status', '--porcelain=v1', '--', 'user.txt'])).toBe('M user.txt');
    });

    it('preserves an unrelated dirty tracked file after a successful commit', async () => {
      await prepareTrackedCommit();
      write('user.txt', 'unrelated dirty user work\n');
      const preview = await manager.createCommitPreview(TASK_ID);
      await manager.commitTaskChanges(TASK_ID, preview.subject, true);

      expect(committedFiles()).toEqual(['src/app.txt']);
      expect(text('user.txt')).toBe('unrelated dirty user work\n');
      expect(git(projectPath, ['status', '--porcelain=v1', '--', 'user.txt'])).toBe('M user.txt');
    });

    it('preserves an unrelated untracked file after a successful commit', async () => {
      await prepareTrackedCommit();
      write('private-notes.txt', 'untracked user work\n');
      const preview = await manager.createCommitPreview(TASK_ID);
      await manager.commitTaskChanges(TASK_ID, preview.subject, true);

      expect(committedFiles()).toEqual(['src/app.txt']);
      expect(text('private-notes.txt')).toBe('untracked user work\n');
      expect(git(projectPath, ['status', '--porcelain=v1', '--', 'private-notes.txt']))
        .toBe('?? private-notes.txt');
    });

    it('preserves an unrelated staged file and its exact index entry', async () => {
      await prepareTrackedCommit();
      write('user.txt', 'staged user work\n');
      git(projectPath, ['add', '--', 'user.txt']);
      const stagedBlob = git(projectPath, ['rev-parse', ':user.txt']);
      const preview = await manager.createCommitPreview(TASK_ID);
      await manager.commitTaskChanges(TASK_ID, preview.subject, true);

      expect(committedFiles()).toEqual(['src/app.txt']);
      expect(git(projectPath, ['diff', '--cached', '--name-only'])).toBe('user.txt');
      expect(git(projectPath, ['rev-parse', ':user.txt'])).toBe(stagedBlob);
      expect(text('user.txt')).toBe('staged user work\n');
    });

    it('returns the new HEAD, exact subject, and sorted file list on success', async () => {
      await beginCommitRun();
      await manager.noteTaskFile(TASK_ID, projectPath, 'z-new.txt');
      await manager.noteTaskFile(TASK_ID, projectPath, 'a-new.txt');
      write('z-new.txt', 'z task\n');
      write('a-new.txt', 'a task\n');
      database.updateTask(TASK_ID, { status: 'completed' });
      const oldHead = currentHead();
      const preview = await manager.createCommitPreview(TASK_ID);
      const result = await manager.commitTaskChanges(TASK_ID, preview.subject, true);

      expect(result).toEqual({
        commit: currentHead(),
        subject: preview.subject,
        files: ['a-new.txt', 'z-new.txt'],
      });
      expect(result.commit).not.toBe(oldHead);
      expect(git(projectPath, ['log', '-1', '--pretty=%s'])).toBe(preview.subject);
    });

    it('persists a git_commit_created timeline event after success', async () => {
      await prepareTrackedCommit();
      const preview = await manager.createCommitPreview(TASK_ID);
      const result = await manager.commitTaskChanges(TASK_ID, preview.subject, true);
      const event = database.listEvents(TASK_ID).find((item) => item.event_type === 'git_commit_created');
      const payload = JSON.parse(event?.payload_json ?? '{}') as Record<string, unknown>;

      expect(event).toBeTruthy();
      expect(payload).toMatchObject({
        commit: result.commit,
        subject: preview.subject,
        files: ['src/app.txt'],
      });
    });

    it('emits one committed event and consumes the preview grant after success', async () => {
      await prepareTrackedCommit();
      const actions: string[] = [];
      manager.subscribe((event) => actions.push(event.action));
      const preview = await manager.createCommitPreview(TASK_ID);
      await manager.commitTaskChanges(TASK_ID, preview.subject, true);

      expect(actions.filter((action) => action === 'committed')).toEqual(['committed']);
      await expect(manager.commitTaskChanges(TASK_ID, preview.subject, true))
        .rejects.toMatchObject({ code: 'STALE_CONFIRMATION' });
    });

    it('restores the Git index byte-for-byte when git commit fails', async () => {
      await beginCommitRun();
      await manager.noteTaskFile(TASK_ID, projectPath, 'src/app.txt');
      write('src/app.txt', 'task file before failing commit\n');
      write('user.txt', 'pre-staged user work\n');
      git(projectPath, ['add', '--', 'user.txt']);
      const indexText = git(projectPath, ['rev-parse', '--git-path', 'index']);
      const indexPath = path.isAbsolute(indexText)
        ? indexText
        : path.resolve(projectPath, indexText);
      const indexBefore = fs.readFileSync(indexPath);
      database.updateTask(TASK_ID, { status: 'completed' });
      const preview = await manager.createCommitPreview(TASK_ID);
      git(projectPath, ['config', 'commit.gpgSign', 'true']);
      git(projectPath, ['config', 'gpg.program', 'definitely-not-a-real-gpg-program']);

      await expect(manager.commitTaskChanges(TASK_ID, preview.subject, true))
        .rejects.toMatchObject({ code: 'COMMIT_FAILED' });

      expect(fs.readFileSync(indexPath)).toEqual(indexBefore);
      expect(git(projectPath, ['diff', '--cached', '--name-only'])).toBe('user.txt');
      expect(git(projectPath, ['status', '--porcelain=v1', '--', 'src/app.txt'])).toBe('M src/app.txt');
      expect(text('src/app.txt')).toBe('task file before failing commit\n');
      await expect(manager.commitTaskChanges(TASK_ID, preview.subject, true))
        .rejects.toMatchObject({ code: 'STALE_CONFIRMATION' });
    });
  });

  describe('public helper and accept guards', () => {
    it('keeps helper path hashing deterministic and collision-resistant for fixture paths', () => {
      const first = checkpointInternals.snapshotName('src/App.tsx');
      const repeated = checkpointInternals.snapshotName('src/App.tsx');
      const other = checkpointInternals.snapshotName('src/app.tsx');
      expect(first).toBe(repeated);
      expect(first).toMatch(/^[a-f0-9]{64}$/);
      expect(other).not.toBe(first);
    });

    it('rejects accepting changes while a task is active', async () => {
      database.updateTask(TASK_ID, { status: 'running' });
      await expect(manager.acceptTaskChanges(TASK_ID)).rejects.toEqual(
        expect.objectContaining<Partial<CheckpointError>>({ code: 'TASK_ACTIVE' }),
      );
      expect(manager.listCheckpoints(TASK_ID)).toEqual([]);
    });

    it('creates an accepted checkpoint and deterministic preview after task completion', async () => {
      await manager.noteTaskFile(TASK_ID, projectPath, 'src/app.txt');
      write('src/app.txt', 'accepted AI change\n');
      database.updateTask(TASK_ID, { status: 'completed' });
      const result = await manager.acceptTaskChanges(TASK_ID);

      expect(result.checkpoint).toMatchObject({ type: 'accepted', metadata: { reason: 'user_accepted' } });
      expect(result.preview.files).toEqual(['src/app.txt']);
      expect(result.preview.subject).toMatch(/^[a-z]+\(app\): add checkpoint workflow$/);
    });
  });
});
