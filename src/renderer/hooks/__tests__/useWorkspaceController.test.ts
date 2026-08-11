import { describe, expect, it } from 'vitest';
import { shouldSelectCreatedSession } from '../useWorkspaceController';

describe('shouldSelectCreatedSession', () => {
  it('selects a new session when project identity and generation still match', () => {
    expect(shouldSelectCreatedSession('project-a', 'request-a', 'project-a', 'request-a'))
      .toBe(true);
  });

  it('does not select a late session after the user switches projects', () => {
    expect(shouldSelectCreatedSession('project-b', 'request-b', 'project-a', 'request-a'))
      .toBe(false);
  });

  it('does not select a late session from an older load of the same project', () => {
    expect(shouldSelectCreatedSession('project-a', 'request-new', 'project-a', 'request-old'))
      .toBe(false);
  });
});
