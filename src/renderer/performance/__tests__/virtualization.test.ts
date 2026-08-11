import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppDatabase } from '../../../main/database/Database';
import {
  computeVirtualWindow,
  mergeStablePages,
  percentile,
} from '../virtualization';

const TEMP_PREFIX = 'claude-workbench-performance-test-';

describe('performance foundations', () => {
  let directory: string;
  let database: AppDatabase;

  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    database = new AppDatabase(path.join(directory, 'performance.db'));
    database.createProject('project', 'Performance', directory);
    database.runInTransaction(() => {
      for (let index = 0; index < 1_000; index += 1) {
        database.createSession(`session-${String(index).padStart(4, '0')}`, 'project', `Task ${index}`);
      }
    });
  });

  afterAll(() => {
    database.close();
    const target = path.resolve(directory);
    if (
      path.dirname(target) !== path.resolve(os.tmpdir())
      || !path.basename(target).startsWith(TEMP_PREFIX)
    ) throw new Error(`Refusing to remove unexpected test directory: ${target}`);
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('[PF-01] computes the initial virtual window', () => {
    expect(computeVirtualWindow({ itemCount: 1_000, itemHeight: 32, viewportHeight: 320, scrollTop: 0 })).toMatchObject({ start: 0, end: 14 });
  });

  it('[PF-02] moves the virtual window with scroll position', () => {
    expect(computeVirtualWindow({ itemCount: 1_000, itemHeight: 32, viewportHeight: 320, scrollTop: 3_200 })).toMatchObject({ start: 96, end: 114 });
  });

  it('[PF-03] clamps virtual overscan at both list boundaries', () => {
    expect(computeVirtualWindow({ itemCount: 5, itemHeight: 30, viewportHeight: 300, scrollTop: 999, overscan: 20 })).toMatchObject({ start: 0, end: 5 });
  });

  it('[PF-04] returns a stable empty virtual window', () => {
    expect(computeVirtualWindow({ itemCount: 0, itemHeight: 30, viewportHeight: 300, scrollTop: 100 })).toEqual({ start: 0, end: 0, offsetTop: 0, totalHeight: 0 });
  });

  it('[PF-05] keeps the rendered row budget bounded for 1000 tasks', () => {
    const window = computeVirtualWindow({ itemCount: 1_000, itemHeight: 32, viewportHeight: 640, scrollTop: 16_000, overscan: 8 });
    expect(window.end - window.start).toBeLessThanOrEqual(36);
  });

  it('[PF-06] merges paginated and live rows without duplicates', () => {
    const merged = mergeStablePages(
      [{ id: 'a', value: 1 }, { id: 'b', value: 1 }],
      [{ id: 'b', value: 2 }, { id: 'c', value: 3 }],
      (item) => item.id,
    );
    expect(merged).toEqual([{ id: 'a', value: 1 }, { id: 'b', value: 2 }, { id: 'c', value: 3 }]);
  });

  it('[PF-07] calculates a deterministic p95 after warm-up samples', () => {
    expect(percentile([1, 3, 2, 100, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19], 0.95)).toBe(19);
  });

  it('[PF-08] queries the first 50 of 1000 tasks within the local budget', () => {
    database.listSessions('project', { limit: 50 });
    const samples: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const started = performance.now();
      expect(database.listSessions('project', { limit: 50 })).toHaveLength(50);
      samples.push(performance.now() - started);
    }
    expect(percentile(samples, 0.95)).toBeLessThan(50);
  });

  it('[PF-09] paginates 1000 tasks without duplicates or omissions', () => {
    const ids: string[] = [];
    for (let offset = 0; offset < 1_000; offset += 50) {
      ids.push(...database.listSessions('project', { limit: 50, offset }).map((row) => row.id));
    }
    expect(ids).toHaveLength(1_000);
    expect(new Set(ids).size).toBe(1_000);
  });

  it('[PF-10] limits message pages without loading the full transcript', () => {
    database.runInTransaction(() => {
      for (let index = 0; index < 500; index += 1) {
        database.createMessage(`message-${index}`, 'session-0000', 'assistant', String(index));
      }
    });
    expect(database.listMessages('session-0000', { limit: 100 })).toHaveLength(100);
    expect(database.countMessages('session-0000')).toBe(500);
  });

  it('[PF-11] floors fractional item counts before calculating total height', () => {
    expect(computeVirtualWindow({ itemCount: 10.9, itemHeight: 20, viewportHeight: 100, scrollTop: 0 }))
      .toMatchObject({ start: 0, end: 9, totalHeight: 200 });
  });

  it.each([0, -1, -100])('[PF-12] clamps non-positive row height %s to one pixel', (itemHeight) => {
    const window = computeVirtualWindow({ itemCount: 10, itemHeight, viewportHeight: 3, scrollTop: 0 });
    expect(window).toMatchObject({ start: 0, end: 7, totalHeight: 10 });
  });

  it('[PF-13] clamps negative scroll offsets at the first row', () => {
    expect(computeVirtualWindow({ itemCount: 100, itemHeight: 20, viewportHeight: 100, scrollTop: -5_000 }))
      .toMatchObject({ start: 0, end: 9, offsetTop: 0 });
  });

  it('[PF-14] clamps scroll offsets beyond the document at the final viewport', () => {
    expect(computeVirtualWindow({ itemCount: 100, itemHeight: 20, viewportHeight: 100, scrollTop: 999_999 }))
      .toMatchObject({ start: 91, end: 100, offsetTop: 1_820, totalHeight: 2_000 });
  });

  it('[PF-15] floors fractional overscan without exceeding the row budget', () => {
    const window = computeVirtualWindow({ itemCount: 1_000, itemHeight: 25, viewportHeight: 250, scrollTop: 2_500, overscan: 3.9 });
    expect(window).toMatchObject({ start: 97, end: 113 });
  });

  it('[PF-16] keeps a 100000-event timeline virtual window bounded', () => {
    const window = computeVirtualWindow({ itemCount: 100_000, itemHeight: 28, viewportHeight: 840, scrollTop: 1_400_000, overscan: 10 });
    expect(window.end - window.start).toBeLessThanOrEqual(50);
    expect(window.totalHeight).toBe(2_800_000);
  });

  it('[PF-17] preserves established row order across multiple live-page merges', () => {
    const first = mergeStablePages(
      [{ id: 'a', value: 1 }, { id: 'b', value: 1 }],
      [{ id: 'c', value: 1 }, { id: 'a', value: 2 }],
      (item) => item.id,
    );
    expect(mergeStablePages(first, [{ id: 'b', value: 3 }, { id: 'd', value: 1 }], (item) => item.id))
      .toEqual([{ id: 'a', value: 2 }, { id: 'b', value: 3 }, { id: 'c', value: 1 }, { id: 'd', value: 1 }]);
  });

  it('[PF-18] applies the final incoming value when a page repeats a key', () => {
    expect(mergeStablePages(
      [{ id: 'row', value: 0 }],
      [{ id: 'row', value: 1 }, { id: 'row', value: 2 }],
      (item) => item.id,
    )).toEqual([{ id: 'row', value: 2 }]);
  });

  it('[PF-19] treats empty page merges as stable no-op values', () => {
    expect(mergeStablePages([{ id: 'row' }], [], (item) => item.id)).toEqual([{ id: 'row' }]);
    expect(mergeStablePages([], [{ id: 'row' }], (item) => item.id)).toEqual([{ id: 'row' }]);
  });

  it('[PF-20] returns zero for an empty percentile sample', () => {
    expect(percentile([], 0.95)).toBe(0);
  });

  it.each([
    { fraction: -1, expected: 1 },
    { fraction: 0, expected: 1 },
    { fraction: 1, expected: 5 },
    { fraction: 2, expected: 5 },
  ])('[PF-21] clamps percentile fraction $fraction', ({ fraction, expected }) => {
    expect(percentile([5, 1, 4, 2, 3], fraction)).toBe(expected);
  });

  it('[PF-22] calculates percentiles without mutating the sample order', () => {
    const samples = [9, 1, 7, 3, 5];
    expect(percentile(samples, 0.5)).toBe(5);
    expect(samples).toEqual([9, 1, 7, 3, 5]);
  });

  it('[PF-23] returns an empty page beyond the 1000-session boundary', () => {
    expect(database.listSessions('project', { limit: 50, offset: 1_000 })).toEqual([]);
  });

  it('[PF-24] returns the exact final partial page at a non-aligned offset', () => {
    const rows = database.listSessions('project', { limit: 50, offset: 975 });
    expect(rows).toHaveLength(25);
    expect(new Set(rows.map((row) => row.id)).size).toBe(25);
  });
});
