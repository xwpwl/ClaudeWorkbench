export interface VirtualWindowOptions {
  itemCount: number;
  itemHeight: number;
  viewportHeight: number;
  scrollTop: number;
  overscan?: number;
}

export interface VirtualWindow {
  start: number;
  end: number;
  offsetTop: number;
  totalHeight: number;
}

export function computeVirtualWindow(options: VirtualWindowOptions): VirtualWindow {
  const itemCount = Math.max(0, Math.floor(options.itemCount));
  const itemHeight = Math.max(1, options.itemHeight);
  const viewportHeight = Math.max(0, options.viewportHeight);
  const overscan = Math.max(0, Math.floor(options.overscan ?? 4));
  const maxScroll = Math.max(0, itemCount * itemHeight - viewportHeight);
  const scrollTop = Math.max(0, Math.min(maxScroll, options.scrollTop));
  const firstVisible = Math.floor(scrollTop / itemHeight);
  const visibleCount = Math.ceil(viewportHeight / itemHeight);
  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(itemCount, firstVisible + visibleCount + overscan);
  return {
    start,
    end,
    offsetTop: start * itemHeight,
    totalHeight: itemCount * itemHeight,
  };
}

export function mergeStablePages<T>(
  existing: T[],
  incoming: T[],
  keyOf: (item: T) => string,
): T[] {
  const output = [...existing];
  const indexes = new Map(output.map((item, index) => [keyOf(item), index]));
  for (const item of incoming) {
    const key = keyOf(item);
    const index = indexes.get(key);
    if (index === undefined) {
      indexes.set(key, output.length);
      output.push(item);
    } else {
      output[index] = item;
    }
  }
  return output;
}

export function percentile(samples: number[], fraction: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const clamped = Math.max(0, Math.min(1, fraction));
  return sorted[Math.ceil(clamped * sorted.length) - 1] ?? sorted[0];
}
