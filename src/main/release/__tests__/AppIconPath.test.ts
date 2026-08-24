import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAppIconPath } from '../AppIcon';

describe('resolveAppIconPath', () => {
  it('resolves the packaged window icon only from the fixed resources file', () => {
    expect(resolveAppIconPath({
      packaged: true,
      resourcesPath: 'R',
      appPath: 'A',
    })).toBe(path.join('R', 'app-icon.png'));
  });

  it('resolves the development window icon only from the tracked project asset', () => {
    expect(resolveAppIconPath({
      packaged: false,
      resourcesPath: 'R',
      appPath: 'A',
    })).toBe(path.join('A', 'build-resources', 'app-icon.png'));
  });
});
