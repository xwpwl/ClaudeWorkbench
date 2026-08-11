import { describe, expect, it } from 'vitest';
import { createDiffModelPaths } from './diffModelIdentity';

describe('Monaco diff model identity', () => {
  it('gives simultaneous viewers distinct original and modified models', () => {
    const first = createDiffModelPaths('C:\\Project', 'src/index.ts', ':viewer-1:');
    const second = createDiffModelPaths('C:\\Project', 'src/index.ts', ':viewer-2:');

    expect(first.original).not.toBe(first.modified);
    expect(second.original).not.toBe(second.modified);
    expect(new Set([first.original, first.modified, second.original, second.modified])).toHaveLength(4);
  });

  it('isolates the same relative file path across projects', () => {
    const projectA = createDiffModelPaths('C:\\Project-A', 'src/index.ts', ':viewer:');
    const projectB = createDiffModelPaths('D:\\Project-B', 'src/index.ts', ':viewer:');

    expect(projectA.original).not.toBe(projectB.original);
    expect(projectA.modified).not.toBe(projectB.modified);
  });

  it('uses URI-safe paths without exposing a raw Windows path delimiter', () => {
    const paths = createDiffModelPaths('C:\\Project A', 'src\\feature file.ts', ':r1:');

    expect(paths.original).toMatch(/^inmemory:\/\/claude-workbench\/diff\//);
    expect(paths.original).not.toContain('\\');
    expect(paths.original).toContain('C%3A%2FProject%20A');
    expect(paths.original).toContain('src%2Ffeature%20file.ts');
  });

  it('is deterministic for a mounted viewer identity', () => {
    expect(createDiffModelPaths('C:\\Project', 'src/index.ts', ':viewer:'))
      .toEqual(createDiffModelPaths('C:\\Project', 'src/index.ts', ':viewer:'));
  });
});
