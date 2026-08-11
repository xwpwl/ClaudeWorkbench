import { describe, expect, it } from 'vitest';
import { canonicalProjectKey, sessionKeyOf } from '../sessionIdentity';

describe('session identity', () => {
  it('normalizes Windows separators and trailing separators', () => {
    expect(canonicalProjectKey('C:\\Work\\Demo\\')).toBe('c:/work/demo');
  });

  it('keeps identical session ids isolated by project path', () => {
    expect(sessionKeyOf('C:\\A', { id: 'same' })).not.toBe(
      sessionKeyOf('C:\\B', { id: 'same' }),
    );
  });
});
