import { expect, it, vi } from 'vitest';

const entryMocks = vi.hoisted(() => ({
  appEvaluated: vi.fn(),
  bootstrapRenderer: vi.fn(async () => undefined),
  createRoot: vi.fn(() => ({ render: vi.fn() })),
}));

vi.mock('../renderer-bootstrap', () => ({
  bootstrapRenderer: entryMocks.bootstrapRenderer,
}));

vi.mock('../App', () => {
  entryMocks.appEvaluated();
  return { default: () => null };
});

vi.mock('react-dom/client', () => ({
  default: { createRoot: entryMocks.createRoot },
  createRoot: entryMocks.createRoot,
}));

vi.stubGlobal('document', {
  getElementById: vi.fn(() => ({ fixedRoot: true })),
});

await import('../main');

it('production entry delegates to bootstrap without evaluating App first', () => {
  expect(entryMocks.bootstrapRenderer).toHaveBeenCalledTimes(1);
  expect(entryMocks.appEvaluated).not.toHaveBeenCalled();
  expect(entryMocks.createRoot).not.toHaveBeenCalled();
});
