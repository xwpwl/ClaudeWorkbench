import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('default TypeScript gate composition', () => {
  it('runs the root project before the exact public IPC registrar type gate', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, unknown> };

    expect(packageJson.scripts?.['typecheck:ipc']).toBe(
      'tsc --noEmit -p tests/typecheck/tsconfig.json',
    );
    expect(packageJson.scripts?.typecheck).toBe(
      'tsc --noEmit -p tsconfig.json && npm run typecheck:ipc',
    );
  });
});
