import { describe, expect, it } from 'vitest';
import { runBoundedBatch } from './diffBatch';

describe('runBoundedBatch', () => {
  it('never exceeds the requested concurrency while processing every item', async () => {
    let active = 0;
    let peak = 0;
    const settled: number[] = [];

    await runBoundedBatch(
      [1, 2, 3, 4, 5],
      2,
      async (item) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return item * 10;
      },
      (result) => {
        if (result.status === 'fulfilled') settled.push(result.value);
      },
    );

    expect(peak).toBe(2);
    expect(settled.sort((left, right) => left - right)).toEqual([10, 20, 30, 40, 50]);
  });

  it('reports an item failure and continues the rest of the batch', async () => {
    const fulfilled: number[] = [];
    const rejected: number[] = [];

    await runBoundedBatch(
      [1, 2, 3],
      2,
      async (item) => {
        if (item === 2) throw new Error('expected');
        return item;
      },
      (result) => {
        if (result.status === 'fulfilled') fulfilled.push(result.value);
        else rejected.push(result.item);
      },
    );

    expect(fulfilled.sort()).toEqual([1, 3]);
    expect(rejected).toEqual([2]);
  });

  it('drops late settlements after its view generation is cancelled', async () => {
    let current = true;
    const settled: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const running = runBoundedBatch(
      [1, 2],
      1,
      async (item) => {
        await gate;
        return item;
      },
      (result) => settled.push(result.item),
      () => current,
    );
    current = false;
    release();
    await running;

    expect(settled).toEqual([]);
  });

  it('rejects an invalid concurrency before starting work', async () => {
    const task = async () => 'unused';
    await expect(runBoundedBatch([1], 0, task, () => undefined))
      .rejects.toThrow('positive integer');
  });
});
