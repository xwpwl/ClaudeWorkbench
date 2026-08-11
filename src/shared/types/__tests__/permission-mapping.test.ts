import { describe, it, expect } from 'vitest';
import { PERMISSION_MODE_MAP, PERMISSION_MODES, LEGACY_PERMISSION_MAP } from '../claude';
import type { CliPermissionMode } from '../claude';

describe('Permission Mode Mapping', () => {
  describe('PERMISSION_MODE_MAP', () => {
    it('should map standard to default', () => {
      expect(PERMISSION_MODE_MAP['standard']).toBe('default');
    });

    it('should map accept-edits to acceptEdits', () => {
      expect(PERMISSION_MODE_MAP['accept-edits']).toBe('acceptEdits');
    });

    it('should map plan to plan', () => {
      expect(PERMISSION_MODE_MAP['plan']).toBe('plan');
    });

    it('should map bypass to bypassPermissions', () => {
      expect(PERMISSION_MODE_MAP['bypass']).toBe('bypassPermissions');
    });

    it('should have exactly 4 entries', () => {
      expect(Object.keys(PERMISSION_MODE_MAP)).toHaveLength(4);
    });
  });

  describe('CLI values are valid --permission-mode args', () => {
    const validCliValues = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

    it.each(Object.entries(PERMISSION_MODE_MAP))(
      'UI value "%s" maps to valid CLI value "%s"',
      (_uiValue, cliValue) => {
        expect(validCliValues).toContain(cliValue);
      },
    );

    it('should never map to "safe" (invalid CLI value)', () => {
      const cliValues = Object.values(PERMISSION_MODE_MAP);
      expect(cliValues).not.toContain('safe');
    });

    it('should never map to "custom" (invalid CLI value)', () => {
      const cliValues = Object.values(PERMISSION_MODE_MAP);
      expect(cliValues).not.toContain('custom');
    });
  });

  describe('LEGACY_PERMISSION_MAP', () => {
    it('should map legacy "safe" to "standard"', () => {
      expect(LEGACY_PERMISSION_MAP['safe']).toBe('standard');
    });

    it('should map legacy "acceptEdits" to "accept-edits"', () => {
      expect(LEGACY_PERMISSION_MAP['acceptEdits']).toBe('accept-edits');
    });

    it('should map legacy "plan" to "plan"', () => {
      expect(LEGACY_PERMISSION_MAP['plan']).toBe('plan');
    });

    it('should map legacy "custom" to "standard"', () => {
      expect(LEGACY_PERMISSION_MAP['custom']).toBe('standard');
    });

    it('should pass through new values unchanged', () => {
      expect(LEGACY_PERMISSION_MAP['standard']).toBe('standard');
      expect(LEGACY_PERMISSION_MAP['accept-edits']).toBe('accept-edits');
      expect(LEGACY_PERMISSION_MAP['bypass']).toBe('bypass');
    });
  });

  describe('PERMISSION_MODES array', () => {
    it('should have exactly 4 modes', () => {
      expect(PERMISSION_MODES).toHaveLength(4);
    });

    it('each mode should have unique uiValue', () => {
      const uiValues = PERMISSION_MODES.map((m) => m.uiValue);
      expect(new Set(uiValues).size).toBe(uiValues.length);
    });

    it('each mode should have unique cliValue', () => {
      const cliValues = PERMISSION_MODES.map((m) => m.cliValue);
      expect(new Set(cliValues).size).toBe(cliValues.length);
    });

    it('only bypass should be marked dangerous', () => {
      const dangerous = PERMISSION_MODES.filter((m) => m.dangerous);
      expect(dangerous).toHaveLength(1);
      expect(dangerous[0].uiValue).toBe('bypass');
    });

    it('each mode should match PERMISSION_MODE_MAP', () => {
      for (const mode of PERMISSION_MODES) {
        expect(PERMISSION_MODE_MAP[mode.uiValue]).toBe(mode.cliValue);
      }
    });
  });

  describe('CLI args construction simulation', () => {
    // Simulates what ClaudeCliAdapter.buildArgs does
    function buildTestArgs(model: string | undefined, permissionMode: CliPermissionMode | undefined): string[] {
      const args = ['-p', 'test', '--output-format', 'stream-json', '--verbose'];
      if (model) args.push('--model', model);
      if (permissionMode) args.push('--permission-mode', permissionMode);
      return args;
    }

    it('should construct correct args for standard mode', () => {
      const args = buildTestArgs('mimo-v2.5-pro', PERMISSION_MODE_MAP['standard']);
      expect(args).toContain('--permission-mode');
      expect(args).toContain('default');
      expect(args).not.toContain('safe');
      expect(args).toContain('--model');
      expect(args).toContain('mimo-v2.5-pro');
    });

    it('should construct correct args for plan mode', () => {
      const args = buildTestArgs(undefined, PERMISSION_MODE_MAP['plan']);
      expect(args).toContain('--permission-mode');
      expect(args).toContain('plan');
      expect(args).not.toContain('--model');
    });

    it('should construct correct args for accept-edits mode', () => {
      const args = buildTestArgs(undefined, PERMISSION_MODE_MAP['accept-edits']);
      expect(args).toContain('--permission-mode');
      expect(args).toContain('acceptEdits');
    });

    it('should construct correct args for bypass mode', () => {
      const args = buildTestArgs(undefined, PERMISSION_MODE_MAP['bypass']);
      expect(args).toContain('--permission-mode');
      expect(args).toContain('bypassPermissions');
    });

    it('should not pass --model when empty', () => {
      const args = buildTestArgs('', PERMISSION_MODE_MAP['standard']);
      expect(args).not.toContain('--model');
    });
  });
});
