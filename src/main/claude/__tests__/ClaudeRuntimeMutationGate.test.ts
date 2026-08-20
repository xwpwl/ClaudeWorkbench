import { describe, expect, it } from "vitest";
import { ClaudeRuntimeMutationGate } from "../ClaudeRuntimeMutationGate";

describe("ClaudeRuntimeMutationGate", () => {
  it("mutually excludes ordinary and update leases without queueing", () => {
    const gate = new ClaudeRuntimeMutationGate();
    const first = gate.tryAcquireOrdinary();
    const second = gate.tryAcquireOrdinary();
    expect(first?.kind).toBe("ordinary");
    expect(second?.kind).toBe("ordinary");
    expect(gate.tryAcquireUpdate()).toBeNull();

    first?.release();
    second?.release();
    const update = gate.tryAcquireUpdate();
    expect(update?.kind).toBe("update");
    expect(gate.tryAcquireOrdinary()).toBeNull();
    expect(gate.tryAcquireUpdate()).toBeNull();

    update?.release();
    expect(gate.tryAcquireOrdinary()?.kind).toBe("ordinary");
  });

  it("makes release idempotent", () => {
    const gate = new ClaudeRuntimeMutationGate();
    const lease = gate.tryAcquireOrdinary()!;
    lease.release();
    lease.release();
    expect(gate.snapshot()).toEqual({
      ordinaryLeaseCount: 0,
      updateActive: false,
    });
  });

  it("returns frozen leases and reports update activity synchronously", () => {
    const gate = new ClaudeRuntimeMutationGate();
    const lease = gate.tryAcquireUpdate()!;

    expect(Object.isFrozen(lease)).toBe(true);
    expect(gate.isUpdateActive()).toBe(true);

    lease.release();
    expect(gate.isUpdateActive()).toBe(false);
  });
});
