import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClaudeEvent, ClaudeEventEnvelope, ClaudeRunOptions } from '../../../shared/types/claude';
import { AppDatabase } from '../../database/Database';
import { TaskEventRecorder } from '../TaskEventRecorder';

const TEMP_PREFIX = 'claude-workbench-task-recorder-';
const PROJECT_ID = 'project-1';
const SESSION_ID = 'session-1';

function removeFixture(directory: string): void {
  const target = path.resolve(directory);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith(TEMP_PREFIX)) {
    throw new Error(`Refusing to remove unexpected fixture: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function options(projectPath: string): ClaudeRunOptions {
  return {
    runId: 'ordinary-run',
    projectKey: projectPath,
    sessionKey: `${projectPath}::${SESSION_ID}`,
    projectPath,
    prompt: 'Update a file',
    permissionMode: 'default',
  };
}

function envelope(run: ClaudeRunOptions, event: ClaudeEvent): ClaudeEventEnvelope {
  return {
    runId: run.runId,
    projectKey: run.projectKey,
    sessionKey: run.sessionKey,
    event,
  };
}

describe('TaskEventRecorder file lifecycle containment', () => {
  let directory: string;
  let projectPath: string;
  let database: AppDatabase;
  let recorder: TaskEventRecorder;
  let run: ClaudeRunOptions;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    projectPath = path.join(directory, 'project');
    fs.mkdirSync(projectPath);
    database = new AppDatabase(path.join(directory, 'workbench.sqlite'));
    database.createProject(PROJECT_ID, 'Project', projectPath);
    database.createSession(SESSION_ID, PROJECT_ID, 'Task', 'initial-model', 'default');
    recorder = new TaskEventRecorder(database);
    run = options(projectPath);
    recorder.recordStart(run);
  });

  afterEach(() => {
    database.close();
    removeFixture(directory);
  });

  function recordWrite(relativePath: string, mutate: () => void, toolUseId = 'write-1', targetRun = run): void {
    recorder.recordEvent(
      envelope(targetRun, {
        type: 'tool_started',
        toolName: 'Write',
        toolUseId,
        input: { file_path: relativePath },
        timestamp: 1,
      }),
    );
    mutate();
    recorder.recordEvent(
      envelope(targetRun, {
        type: 'tool_completed',
        toolName: 'Write',
        toolUseId,
        output: 'ok',
        timestamp: 2,
      }),
    );
  }

  it('records a legitimate nested project file change', () => {
    fs.mkdirSync(path.join(projectPath, 'src'));
    const filePath = path.join(projectPath, 'src', 'index.ts');
    fs.writeFileSync(filePath, 'before\n');

    recordWrite('src/index.ts', () => fs.writeFileSync(filePath, 'after\n'));

    expect(database.listFileChanges(SESSION_ID)).toEqual([
      expect.objectContaining({
        file_path: path.join('src', 'index.ts'),
        old_content: 'before\n',
        new_content: 'after\n',
      }),
    ]);
  });

  it('records a legitimate change when the project root is a filesystem alias', () => {
    fs.mkdirSync(path.join(projectPath, 'src'));
    const filePath = path.join(projectPath, 'src', 'aliased.ts');
    fs.writeFileSync(filePath, 'before\n');
    const aliasPath = path.join(directory, 'project-alias');
    fs.symlinkSync(projectPath, aliasPath, process.platform === 'win32' ? 'junction' : 'dir');
    const aliasRun = { ...options(aliasPath), runId: 'alias-run' };
    recorder.recordStart(aliasRun);

    recordWrite('src/aliased.ts', () => fs.writeFileSync(filePath, 'after\n'), 'write-alias', aliasRun);

    expect(database.listFileChanges(SESSION_ID)).toEqual([
      expect.objectContaining({
        file_path: path.join('src', 'aliased.ts'),
        old_content: 'before\n',
        new_content: 'after\n',
      }),
    ]);
  });

  it('does not snapshot a file reached through an ancestor link outside the project', () => {
    const outsidePath = path.join(directory, 'outside');
    fs.mkdirSync(outsidePath);
    const outsideFile = path.join(outsidePath, 'secret.txt');
    fs.writeFileSync(outsideFile, 'secret-before\n');
    fs.symlinkSync(
      outsidePath,
      path.join(projectPath, 'linked-outside'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    recordWrite('linked-outside/secret.txt', () => fs.writeFileSync(outsideFile, 'secret-after\n'));

    expect(database.listFileChanges(SESSION_ID)).toEqual([]);
  });

  it('does not snapshot repository metadata', () => {
    const gitPath = path.join(projectPath, '.git');
    fs.mkdirSync(gitPath);
    const configPath = path.join(gitPath, 'config');
    fs.writeFileSync(configPath, 'secret-before\n');

    recordWrite('.git/config', () => fs.writeFileSync(configPath, 'secret-after\n'));

    expect(database.listFileChanges(SESSION_ID)).toEqual([]);
  });
});
