export type BatchSettlement<TItem, TResult> =
  | { item: TItem; status: 'fulfilled'; value: TResult }
  | { item: TItem; status: 'rejected'; reason: unknown };

/** Runs one explicitly requested diff batch without exceeding the configured concurrency. */
export async function runBoundedBatch<TItem, TResult>(
  items: readonly TItem[],
  maxConcurrency: number,
  task: (item: TItem) => Promise<TResult>,
  onSettled: (settlement: BatchSettlement<TItem, TResult>) => void,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error('Batch concurrency must be a positive integer.');
  }

  let cursor = 0;
  const worker = async () => {
    while (shouldContinue()) {
      const index = cursor;
      if (index >= items.length) return;
      cursor += 1;
      const item = items[index];
      try {
        const value = await task(item);
        if (shouldContinue()) onSettled({ item, status: 'fulfilled', value });
      } catch (reason) {
        if (shouldContinue()) onSettled({ item, status: 'rejected', reason });
      }
    }
  };

  await Promise.all(Array.from(
    { length: Math.min(maxConcurrency, items.length) },
    () => worker(),
  ));
}
