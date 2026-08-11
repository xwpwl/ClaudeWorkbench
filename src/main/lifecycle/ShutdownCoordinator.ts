export type ShutdownReason = 'user' | 'window_closed' | 'system' | 'test';

export interface ShutdownStepResult {
  name: string;
  status: 'completed' | 'failed' | 'timed_out' | 'skipped';
  error?: string;
}

export interface ShutdownResult {
  reason: ShutdownReason;
  clean: boolean;
  steps: ShutdownStepResult[];
}

export interface ShutdownDependencies {
  stopAcceptingWork(): void | Promise<void>;
  closePermissions(): void | Promise<void>;
  stopTasks(): void | Promise<void>;
  stopTerminals(): void | Promise<void>;
  stopProcesses(): void | Promise<void>;
  waitForMutations(): void | Promise<void>;
  markCleanShutdown(): void | Promise<void>;
  closeDatabase(): void | Promise<void>;
}

export interface ShutdownCoordinatorOptions {
  stepTimeoutMs?: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Serializes graceful application shutdown and makes repeated quit events idempotent. */
export class ShutdownCoordinator {
  private readonly timeoutMs: number;
  private inFlight: Promise<ShutdownResult> | null = null;
  private completed: ShutdownResult | null = null;

  constructor(
    private readonly dependencies: ShutdownDependencies,
    options: ShutdownCoordinatorOptions = {},
  ) {
    this.timeoutMs = Math.max(1, Math.min(60_000, Math.floor(options.stepTimeoutMs ?? 10_000)));
  }

  shutdown(reason: ShutdownReason): Promise<ShutdownResult> {
    if (this.completed) return Promise.resolve(this.completed);
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run(reason).then((result) => {
      this.completed = result;
      return result;
    });
    return this.inFlight;
  }

  private async run(reason: ShutdownReason): Promise<ShutdownResult> {
    const steps: ShutdownStepResult[] = [];
    let clean = true;
    let timedOut = false;
    const runStep = async (name: string, operation: () => void | Promise<void>): Promise<boolean> => {
      const result = await this.withTimeout(operation);
      steps.push({ name, ...result });
      if (result.status !== 'completed') clean = false;
      if (result.status === 'timed_out') timedOut = true;
      return result.status === 'completed';
    };

    await runStep('stop_accepting_work', () => this.dependencies.stopAcceptingWork());
    await runStep('close_permissions', () => this.dependencies.closePermissions());
    await runStep('stop_tasks', () => this.dependencies.stopTasks());
    await runStep('stop_terminals', () => this.dependencies.stopTerminals());
    await runStep('stop_processes', () => this.dependencies.stopProcesses());
    await runStep('wait_for_mutations', () => this.dependencies.waitForMutations());

    if (clean) {
      await runStep('mark_clean_shutdown', () => this.dependencies.markCleanShutdown());
    } else {
      steps.push({ name: 'mark_clean_shutdown', status: 'skipped' });
    }
    if (timedOut) {
      // A timed-out operation is still running. Do not close the database under
      // work that may later try to persist its terminal state.
      steps.push({ name: 'close_database', status: 'skipped' });
    } else {
      await runStep('close_database', () => this.dependencies.closeDatabase());
    }
    return { reason, clean: clean && steps.every((step) => step.status === 'completed'), steps };
  }

  private async withTimeout(
    operation: () => void | Promise<void>,
  ): Promise<Omit<ShutdownStepResult, 'name'>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<'timed_out'>((resolve) => {
        timer = setTimeout(() => resolve('timed_out'), this.timeoutMs);
        timer.unref?.();
      });
      const outcome = await Promise.race([
        Promise.resolve().then(operation).then(() => 'completed' as const),
        timeout,
      ]);
      return { status: outcome };
    } catch (error) {
      return { status: 'failed', error: message(error) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
