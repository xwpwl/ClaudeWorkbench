import path from "node:path";
import type { IpcMain } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckpointChangedEvent } from "../../../shared/types/checkpoint";
import { IPC_CHANNELS } from "../../../shared/types/ipc";
import { GitWorkspaceError } from "../../git/GitWorkspaceService";
import { registerGitWorkspaceIPC } from "../git-workspace";
import { publicIpcMainForTest } from "./public-invoke-test-helper";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const PROJECT_ID = "project-alpha";
const TASK_ID = "task-alpha";
const CHECKPOINT_ID = "checkpoint-alpha";
const PROJECT_PATH = path.resolve("fixtures", "project-alpha");
const OTHER_PROJECT_PATH = path.resolve("fixtures", "project-beta");

const statusResult = {
  projectPath: PROJECT_PATH,
  branch: "main",
  head: "abc1234",
  clean: false,
  files: [],
};

const diffResult = [{ filePath: "src/app.ts", patch: "@@ -1 +1 @@" }];

const checkpointResult = {
  id: CHECKPOINT_ID,
  taskId: TASK_ID,
  projectPath: PROJECT_PATH,
  type: "manual",
  files: [],
};

const restoreImpact = {
  checkpointId: CHECKPOINT_ID,
  taskId: TASK_ID,
  restoreFiles: ["src/app.ts"],
  deleteFiles: [],
  preservedUserFiles: [],
  blockedFiles: [],
  confirmationToken: "opaque-token",
  expiresAt: "2026-08-01T12:00:00.000Z",
};

const restoreResult = {
  checkpointId: CHECKPOINT_ID,
  restoredFiles: ["src/app.ts"],
  deletedFiles: [],
  preservedUserFiles: [],
  rollbackCheckpointId: "rollback-alpha",
};

const commitPreview = {
  subject: "feat(app): add checkpoint drawer",
  files: ["src/app.ts"],
};

const commitResult = {
  commit: "def5678",
  subject: commitPreview.subject,
  files: commitPreview.files,
};

interface HarnessOptions {
  activeTasks?: Array<{ projectKey: string; writable: boolean }>;
  includeSend?: boolean;
  includeTasks?: boolean;
  gitStatusError?: unknown;
  projectPath?: string;
  publicTransport?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const handlers = new Map<string, Handler>();
  const listeners = new Set<(event: CheckpointChangedEvent) => void>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    }),
  } as unknown as IpcMain;
  const database = {
    getProject: vi.fn((id: string) =>
      id === PROJECT_ID
        ? { id: PROJECT_ID, path: options.projectPath ?? PROJECT_PATH }
        : null,
    ),
    getTask: vi.fn((id: string) =>
      id === TASK_ID ? { id: TASK_ID, project_id: PROJECT_ID } : null,
    ),
  };
  const git = {
    initialize: vi.fn(async () => statusResult),
    getStatus: vi.fn(async () => {
      if (options.gitStatusError !== undefined) throw options.gitStatusError;
      return statusResult;
    }),
    getDiff: vi.fn(async () => diffResult),
  };
  const unsubscribe = vi.fn(
    (listener: (event: CheckpointChangedEvent) => void) => {
      listeners.delete(listener);
    },
  );
  const checkpoints = {
    listCheckpoints: vi.fn(() => [checkpointResult]),
    createTaskCheckpoint: vi.fn(async () => checkpointResult),
    previewRestore: vi.fn(async () => restoreImpact),
    getCheckpoint: vi.fn((id: string) =>
      id === CHECKPOINT_ID ? checkpointResult : null,
    ),
    restoreCheckpoint: vi.fn(async () => restoreResult),
    acceptTaskChanges: vi.fn(async () => ({
      checkpoint: checkpointResult,
      preview: commitPreview,
    })),
    createCommitPreview: vi.fn(async () => commitPreview),
    commitTaskChanges: vi.fn(async () => commitResult),
    subscribe: vi.fn((listener: (event: CheckpointChangedEvent) => void) => {
      listeners.add(listener);
      return () => unsubscribe(listener);
    }),
  };
  const tasks = {
    runProjectMutation: vi.fn(async <T>(projectPath: string, operation: () => Promise<T>) => {
      const canonical = path.resolve(projectPath).toLocaleLowerCase("en-US");
      const active = (options.activeTasks ?? []).find((task) => (
        task.writable
        && path.resolve(task.projectKey).toLocaleLowerCase("en-US") === canonical
      ));
      if (active) throw new Error("该项目仍有写任务运行，不能恢复或提交。");
      return operation();
    }),
  };
  const send = vi.fn();

  const dispose = registerGitWorkspaceIPC(
    options.publicTransport ? publicIpcMainForTest(ipcMain) : ipcMain,
    database as never,
    checkpoints as never,
    {
      git: git as never,
      ...(options.includeTasks === false ? {} : { tasks: tasks as never }),
      ...(options.includeSend === false ? {} : { send }),
    },
  );

  const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing IPC handler for ${channel}`);
    return (await handler({}, ...args)) as T;
  };

  return {
    checkpoints,
    database,
    dispose,
    emit: (event: CheckpointChangedEvent) => {
      for (const listener of listeners) listener(event);
    },
    git,
    handlers,
    invoke,
    ipcMain,
    listeners,
    send,
    tasks,
    unsubscribe,
  };
}

function checkpointEvent(): CheckpointChangedEvent {
  return {
    taskId: TASK_ID,
    projectPath: PROJECT_PATH,
    action: "created",
    checkpointId: CHECKPOINT_ID,
    timestamp: 100,
  };
}

describe("registerGitWorkspaceIPC", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a closed non-repository envelope through the production registrar", async () => {
    const harness = createHarness({
      publicTransport: true,
      gitStatusError: new GitWorkspaceError(
        "private C:\\Users\\Profile project is not a Git working tree.",
        "NOT_A_REPOSITORY",
      ),
    });

    const result = await harness.invoke(IPC_CHANNELS.GIT_WORKSPACE_STATUS, PROJECT_ID, PROJECT_PATH)
      .catch(() => ({ transportRejected: true }));
    expect(result).toEqual({
      schemaVersion: 1,
      ok: false,
      error: { code: "NOT_A_REPOSITORY", message: "Selected project is not a Git working tree." },
    });
    expect(JSON.stringify(result)).not.toContain("Users");
  });

  it("registers every Git workspace and checkpoint handler", () => {
    const harness = createHarness();

    expect([...harness.handlers.keys()]).toEqual(
      expect.arrayContaining([
        IPC_CHANNELS.GIT_WORKSPACE_STATUS,
        IPC_CHANNELS.GIT_WORKSPACE_INIT,
        IPC_CHANNELS.GIT_WORKSPACE_DIFF,
        IPC_CHANNELS.CHECKPOINT_LIST,
        IPC_CHANNELS.CHECKPOINT_CREATE,
        IPC_CHANNELS.CHECKPOINT_RESTORE_PREVIEW,
        IPC_CHANNELS.CHECKPOINT_RESTORE,
        IPC_CHANNELS.CHECKPOINT_ACCEPT,
        IPC_CHANNELS.CHECKPOINT_COMMIT_PREVIEW,
        IPC_CHANNELS.CHECKPOINT_COMMIT,
      ]),
    );
    expect(harness.handlers).toHaveLength(10);
  });

  it("initializes the currently registered project under a git_init mutation lease", async () => {
    const harness = createHarness();

    await expect(harness.invoke(
      IPC_CHANNELS.GIT_WORKSPACE_INIT,
      PROJECT_ID,
      path.join(PROJECT_PATH, "."),
    )).resolves.toBe(statusResult);

    expect(harness.git.initialize).toHaveBeenCalledWith(PROJECT_PATH);
    expect(harness.tasks.runProjectMutation).toHaveBeenCalledWith(
      PROJECT_PATH,
      expect.any(Function),
      { kind: "git_init", projectId: PROJECT_ID },
    );
  });

  it("reloads project identity and canonical path when initialization is invoked", async () => {
    const harness = createHarness();
    const movedPath = path.resolve("fixtures", "project-alpha-moved");
    harness.database.getProject.mockImplementation((id: string) => (
      id === PROJECT_ID ? { id: PROJECT_ID, path: movedPath } : null
    ));

    await harness.invoke(IPC_CHANNELS.GIT_WORKSPACE_INIT, PROJECT_ID, movedPath);

    expect(harness.database.getProject).toHaveBeenCalledWith(PROJECT_ID);
    expect(harness.git.initialize).toHaveBeenCalledWith(movedPath);
    expect(harness.tasks.runProjectMutation).toHaveBeenCalledWith(
      movedPath,
      expect.any(Function),
      { kind: "git_init", projectId: PROJECT_ID },
    );
  });

  it("fails closed when initialization has no project mutation coordinator", async () => {
    const harness = createHarness({ includeTasks: false });

    await expect(harness.invoke(
      IPC_CHANNELS.GIT_WORKSPACE_INIT,
      PROJECT_ID,
      PROJECT_PATH,
    )).rejects.toThrow("Project mutation coordinator is unavailable.");
    expect(harness.git.initialize).not.toHaveBeenCalled();
  });

  it("maps workspace status to the registered project path", async () => {
    const harness = createHarness();

    await expect(
      harness.invoke(
        IPC_CHANNELS.GIT_WORKSPACE_STATUS,
        PROJECT_ID,
        path.join(PROJECT_PATH, "."),
      ),
    ).resolves.toBe(statusResult);
    expect(harness.git.getStatus).toHaveBeenCalledWith(PROJECT_PATH);
  });

  it("maps workspace diff options without transforming them", async () => {
    const harness = createHarness();
    const options = {
      mode: "staged",
      filePaths: ["src/app.ts"],
      contextLines: 8,
    };

    await expect(
      harness.invoke(
        IPC_CHANNELS.GIT_WORKSPACE_DIFF,
        PROJECT_ID,
        PROJECT_PATH,
        options,
      ),
    ).resolves.toBe(diffResult);
    expect(harness.git.getDiff).toHaveBeenCalledWith(PROJECT_PATH, options);
  });

  it("defaults omitted workspace diff options to an empty object", async () => {
    const harness = createHarness();

    await harness.invoke(
      IPC_CHANNELS.GIT_WORKSPACE_DIFF,
      PROJECT_ID,
      PROJECT_PATH,
    );

    expect(harness.git.getDiff).toHaveBeenCalledWith(PROJECT_PATH, {});
  });

  it("rejects a project id and path that belong to different projects", async () => {
    const harness = createHarness();

    await expect(
      harness.invoke(
        IPC_CHANNELS.GIT_WORKSPACE_STATUS,
        PROJECT_ID,
        OTHER_PROJECT_PATH,
      ),
    ).rejects.toThrow("Project path does not match the registered project.");
    expect(harness.git.getStatus).not.toHaveBeenCalled();
  });

  it("rejects workspace diff for a mismatched project path", async () => {
    const harness = createHarness();

    await expect(
      harness.invoke(
        IPC_CHANNELS.GIT_WORKSPACE_DIFF,
        PROJECT_ID,
        OTHER_PROJECT_PATH,
      ),
    ).rejects.toThrow("Project path does not match the registered project.");
    expect(harness.git.getDiff).not.toHaveBeenCalled();
  });

  it("rejects an unknown project id before accessing Git", async () => {
    const harness = createHarness();

    await expect(
      harness.invoke(
        IPC_CHANNELS.GIT_WORKSPACE_STATUS,
        "unknown-project",
        PROJECT_PATH,
      ),
    ).rejects.toThrow("Project is not registered in Workbench.");
    expect(harness.git.getStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["", PROJECT_PATH],
    ["   ", PROJECT_PATH],
    ["project\0alpha", PROJECT_PATH],
    [PROJECT_ID, ""],
    [PROJECT_ID, "   "],
    [PROJECT_ID, `${PROJECT_PATH}\0escape`],
  ])(
    "rejects invalid project identity or path input %#",
    async (projectId, projectPathInput) => {
      const harness = createHarness();

      await expect(
        harness.invoke(
          IPC_CHANNELS.GIT_WORKSPACE_STATUS,
          projectId,
          projectPathInput,
        ),
      ).rejects.toThrow();
      expect(harness.git.getStatus).not.toHaveBeenCalled();
    },
  );

  it("maps checkpoint listing with the trimmed task id", async () => {
    const harness = createHarness();

    await expect(
      harness.invoke(IPC_CHANNELS.CHECKPOINT_LIST, `  ${TASK_ID}  `),
    ).resolves.toEqual([checkpointResult]);
    expect(harness.checkpoints.listCheckpoints).toHaveBeenCalledWith(TASK_ID);
  });

  it("rejects an invalid checkpoint list task id", async () => {
    const harness = createHarness();

    await expect(
      harness.invoke(IPC_CHANNELS.CHECKPOINT_LIST, "task\0alpha"),
    ).rejects.toThrow();
    expect(harness.checkpoints.listCheckpoints).not.toHaveBeenCalled();
  });

  it("maps an omitted checkpoint type to a user-created manual checkpoint", async () => {
    const harness = createHarness();

    await expect(
      harness.invoke(IPC_CHANNELS.CHECKPOINT_CREATE, TASK_ID),
    ).resolves.toBe(checkpointResult);
    expect(harness.checkpoints.createTaskCheckpoint).toHaveBeenCalledWith(
      TASK_ID,
      "manual",
      { reason: "user_created" },
    );
  });

  it("allows the renderer to request an explicit manual checkpoint", async () => {
    const harness = createHarness();

    await harness.invoke(IPC_CHANNELS.CHECKPOINT_CREATE, TASK_ID, "manual");

    expect(harness.checkpoints.createTaskCheckpoint).toHaveBeenCalledWith(
      TASK_ID,
      "manual",
      { reason: "user_created" },
    );
  });

  it.each([
    "before_task",
    "after_edit",
    "after_test",
    "task_completed",
    "accepted",
  ])(
    "rejects renderer creation of the protected %s checkpoint type",
    async (type) => {
      const harness = createHarness();

      await expect(
        harness.invoke(IPC_CHANNELS.CHECKPOINT_CREATE, TASK_ID, type),
      ).rejects.toThrow("Renderer may only create manual checkpoints.");
      expect(harness.checkpoints.createTaskCheckpoint).not.toHaveBeenCalled();
    },
  );

  it("maps checkpoint restore preview by opaque checkpoint id", async () => {
    const harness = createHarness();

    await expect(
      harness.invoke(IPC_CHANNELS.CHECKPOINT_RESTORE_PREVIEW, CHECKPOINT_ID),
    ).resolves.toBe(restoreImpact);
    expect(harness.checkpoints.previewRestore).toHaveBeenCalledWith(
      CHECKPOINT_ID,
    );
  });

  it("forwards the restore confirmation token unchanged", async () => {
    const harness = createHarness();
    const token = "Opaque.Token_ABC-123";

    await expect(
      harness.invoke(IPC_CHANNELS.CHECKPOINT_RESTORE, CHECKPOINT_ID, token),
    ).resolves.toBe(restoreResult);
    expect(harness.checkpoints.restoreCheckpoint).toHaveBeenCalledWith(
      CHECKPOINT_ID,
      token,
    );
    expect(harness.tasks.runProjectMutation).toHaveBeenCalledWith(
      PROJECT_PATH,
      expect.any(Function),
      expect.objectContaining({
        kind: "checkpoint_restore",
        taskId: TASK_ID,
        sessionId: TASK_ID,
      }),
    );
  });

  it("rejects restore when the checkpoint cannot be resolved", async () => {
    const harness = createHarness();

    await expect(
      harness.invoke(
        IPC_CHANNELS.CHECKPOINT_RESTORE,
        "missing-checkpoint",
        "opaque-token",
      ),
    ).rejects.toThrow("Checkpoint was not found.");
    expect(harness.checkpoints.restoreCheckpoint).not.toHaveBeenCalled();
  });

  it("fails closed when restore has no project mutation coordinator", async () => {
    const harness = createHarness({ includeTasks: false });

    await expect(harness.invoke(
      IPC_CHANNELS.CHECKPOINT_RESTORE,
      CHECKPOINT_ID,
      "opaque-token",
    )).rejects.toThrow("Project mutation coordinator is unavailable.");
    expect(harness.checkpoints.restoreCheckpoint).not.toHaveBeenCalled();
  });

  it("blocks restore while a writable task is active in the same project", async () => {
    const harness = createHarness({
      activeTasks: [
        { projectKey: path.join(PROJECT_PATH, "."), writable: true },
      ],
    });

    await expect(
      harness.invoke(
        IPC_CHANNELS.CHECKPOINT_RESTORE,
        CHECKPOINT_ID,
        "opaque-token",
      ),
    ).rejects.toThrow();
    expect(harness.checkpoints.restoreCheckpoint).not.toHaveBeenCalled();
  });

  it("allows restore when the active task in the same project is read-only", async () => {
    const harness = createHarness({
      activeTasks: [{ projectKey: PROJECT_PATH, writable: false }],
    });

    await expect(
      harness.invoke(
        IPC_CHANNELS.CHECKPOINT_RESTORE,
        CHECKPOINT_ID,
        "opaque-token",
      ),
    ).resolves.toBe(restoreResult);
  });

  it("allows restore while a writable task is active in another project", async () => {
    const harness = createHarness({
      activeTasks: [{ projectKey: OTHER_PROJECT_PATH, writable: true }],
    });

    await expect(
      harness.invoke(
        IPC_CHANNELS.CHECKPOINT_RESTORE,
        CHECKPOINT_ID,
        "opaque-token",
      ),
    ).resolves.toBe(restoreResult);
  });

  it("maps accept changes to the checkpoint manager", async () => {
    const harness = createHarness();

    await expect(
      harness.invoke(IPC_CHANNELS.CHECKPOINT_ACCEPT, TASK_ID),
    ).resolves.toEqual({
      checkpoint: checkpointResult,
      preview: commitPreview,
    });
    expect(harness.checkpoints.acceptTaskChanges).toHaveBeenCalledWith(TASK_ID);
  });

  it("maps commit preview to the checkpoint manager", async () => {
    const harness = createHarness();

    await expect(
      harness.invoke(IPC_CHANNELS.CHECKPOINT_COMMIT_PREVIEW, TASK_ID),
    ).resolves.toBe(commitPreview);
    expect(harness.checkpoints.createCommitPreview).toHaveBeenCalledWith(
      TASK_ID,
    );
  });

  it("maps a confirmed, single-line commit subject without modification", async () => {
    const harness = createHarness();

    await expect(
      harness.invoke(
        IPC_CHANNELS.CHECKPOINT_COMMIT,
        TASK_ID,
        commitPreview.subject,
        true,
      ),
    ).resolves.toBe(commitResult);
    expect(harness.checkpoints.commitTaskChanges).toHaveBeenCalledWith(
      TASK_ID,
      commitPreview.subject,
      true,
    );
    expect(harness.tasks.runProjectMutation).toHaveBeenCalledWith(
      PROJECT_PATH,
      expect.any(Function),
      expect.objectContaining({
        kind: "git_commit",
        taskId: TASK_ID,
        sessionId: TASK_ID,
      }),
    );
  });

  it.each([false, undefined, null, "true"])(
    "rejects commit without the literal confirmed=true value (%s)",
    async (confirmed) => {
      const harness = createHarness();

      await expect(
        harness.invoke(
          IPC_CHANNELS.CHECKPOINT_COMMIT,
          TASK_ID,
          commitPreview.subject,
          confirmed,
        ),
      ).rejects.toThrow("Commit requires explicit confirmation.");
      expect(harness.checkpoints.commitTaskChanges).not.toHaveBeenCalled();
    },
  );

  it.each([
    "",
    "   ",
    "feat: first line\nsecond line",
    "feat: first line\rsecond line",
    "feat: nul\0subject",
    "x".repeat(201),
  ])("rejects an unsafe commit subject %#", async (subject) => {
    const harness = createHarness();

    await expect(
      harness.invoke(IPC_CHANNELS.CHECKPOINT_COMMIT, TASK_ID, subject, true),
    ).rejects.toThrow();
    expect(harness.checkpoints.commitTaskChanges).not.toHaveBeenCalled();
  });

  it("rejects commit when the task has no registered project", async () => {
    const harness = createHarness();

    await expect(
      harness.invoke(
        IPC_CHANNELS.CHECKPOINT_COMMIT,
        "missing-task",
        commitPreview.subject,
        true,
      ),
    ).rejects.toThrow("Task project was not found.");
    expect(harness.checkpoints.commitTaskChanges).not.toHaveBeenCalled();
  });

  it("blocks commit while a writable task is active in the same project", async () => {
    const harness = createHarness({
      activeTasks: [{ projectKey: PROJECT_PATH, writable: true }],
    });

    await expect(
      harness.invoke(
        IPC_CHANNELS.CHECKPOINT_COMMIT,
        TASK_ID,
        commitPreview.subject,
        true,
      ),
    ).rejects.toThrow();
    expect(harness.checkpoints.commitTaskChanges).not.toHaveBeenCalled();
  });

  it("subscribes exactly once to checkpoint changes during registration", () => {
    const harness = createHarness();

    expect(harness.checkpoints.subscribe).toHaveBeenCalledOnce();
    expect(harness.listeners).toHaveLength(1);
  });

  it("forwards checkpoint changes to the supplied sender", () => {
    const harness = createHarness();
    const event = checkpointEvent();

    harness.emit(event);

    expect(harness.send).toHaveBeenCalledOnce();
    expect(harness.send).toHaveBeenCalledWith(event);
  });

  it("supports registration without a checkpoint event sender", () => {
    const harness = createHarness({ includeSend: false });

    expect(() => harness.emit(checkpointEvent())).not.toThrow();
  });

  it("unsubscribes checkpoint changes when disposed", () => {
    const harness = createHarness();

    harness.dispose();

    expect(harness.unsubscribe).toHaveBeenCalledOnce();
    expect(harness.listeners).toHaveLength(0);
  });

  it("does not send checkpoint changes after disposal", () => {
    const harness = createHarness();
    harness.emit(checkpointEvent());
    harness.dispose();

    harness.emit({ ...checkpointEvent(), timestamp: 200 });

    expect(harness.send).toHaveBeenCalledOnce();
  });
});
