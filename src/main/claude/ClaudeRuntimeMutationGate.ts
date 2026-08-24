export type ClaudeRuntimeLeaseKind = "ordinary" | "update";

export interface ClaudeRuntimeLease {
  readonly kind: ClaudeRuntimeLeaseKind;
  release(): void;
}

export class ClaudeRuntimeBusyError extends Error {
  readonly code = "CLAUDE_RUNTIME_BUSY";
}

export class ClaudeRuntimeMutationGate {
  private ordinaryLeaseCount = 0;
  private updateActive = false;

  tryAcquireOrdinary(): ClaudeRuntimeLease | null {
    if (this.updateActive) return null;

    this.ordinaryLeaseCount += 1;
    return this.createLease("ordinary", () => {
      this.ordinaryLeaseCount -= 1;
    });
  }

  tryAcquireUpdate(): ClaudeRuntimeLease | null {
    if (this.updateActive || this.ordinaryLeaseCount > 0) return null;

    this.updateActive = true;
    return this.createLease("update", () => {
      this.updateActive = false;
    });
  }

  isUpdateActive(): boolean {
    return this.updateActive;
  }

  snapshot(): Readonly<{
    ordinaryLeaseCount: number;
    updateActive: boolean;
  }> {
    return Object.freeze({
      ordinaryLeaseCount: this.ordinaryLeaseCount,
      updateActive: this.updateActive,
    });
  }

  private createLease(
    kind: ClaudeRuntimeLeaseKind,
    onRelease: () => void,
  ): ClaudeRuntimeLease {
    let released = false;

    return Object.freeze({
      kind,
      release: () => {
        if (released) return;
        released = true;
        onRelease();
      },
    });
  }
}
