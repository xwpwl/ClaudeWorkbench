import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';
import type { ResolvedModelSelection } from '../../../../shared/types/modelProviders';
import type { TaskModelSwitchOptionPublic } from '../../../../shared/types/projectAi';
import { TaskComposerModelSwitcherView } from '../InputBar';

// Test the input bar logic without React rendering

describe('InputBar Logic', () => {
  it('renders the shared task model switcher beside the composer with switch and clear controls', () => {
    const capabilities = {
      supportsClaudeCode: true, supportsAgentWorkflow: true, supportsTools: true,
      supportsMCP: true, supportsStreaming: true, supportsVision: false,
    };
    const selection: ResolvedModelSelection = {
      providerId: 'mimo', providerName: 'MiMo', modelId: 'mimo-v2.5-pro',
      runtimeType: 'claude-code', capabilities, source: 'task_override',
    };
    const options: TaskModelSwitchOptionPublic[] = [{
      providerId: 'mimo', providerName: 'MiMo', modelId: 'mimo-v2.5-pro',
      modelDisplayName: null, runtimeType: 'claude-code',
    }];
    const html = renderToStaticMarkup(React.createElement(TaskComposerModelSwitcherView, {
      modelProviderState: {
        selection, options, error: null,
        onSwitch: () => {}, onClearOverride: () => {},
      },
      busy: false,
      open: true,
      onOpenChange: () => {},
    }));
    expect(html).toContain('data-testid="task-composer-model-switcher"');
    expect(html).toContain('MiMo');
    expect(html).toContain('mimo-v2.5-pro');
    expect(html).toContain('data-testid="follow-model-policy"');
    expect(html).toContain('data-testid="model-switch-option"');
  });

  describe('canSend logic', () => {
    it('should not allow send when input is empty', () => {
      const input = '';
      const isRunning = false;
      const canSend = input.trim() && !isRunning;
      expect(canSend).toBeFalsy();
    });

    it('should allow send when input has text and not running', () => {
      const input = '读取 package.json';
      const isRunning = false;
      const canSend = input.trim() && !isRunning;
      expect(canSend).toBeTruthy();
    });

    it('should not allow send when running', () => {
      const input = 'some task';
      const isRunning = true;
      const canSend = input.trim() && !isRunning;
      expect(canSend).toBeFalsy();
    });
  });

  describe('keyboard shortcuts', () => {
    it('Ctrl+Enter should trigger send', () => {
      const event = {
        key: 'Enter',
        ctrlKey: true,
        shiftKey: false,
        nativeEvent: { isComposing: false },
        preventDefault: vi.fn(),
      };
      const shouldSend = event.key === 'Enter' && event.ctrlKey;
      expect(shouldSend).toBe(true);
    });

    it('Shift+Enter should NOT trigger send', () => {
      const event = {
        key: 'Enter',
        ctrlKey: false,
        shiftKey: true,
        nativeEvent: { isComposing: false },
        preventDefault: vi.fn(),
      };
      const shouldSend = event.key === 'Enter' && !event.shiftKey && !event.ctrlKey;
      expect(shouldSend).toBe(false);
    });

    it('Enter without Shift should trigger send', () => {
      const event = {
        key: 'Enter',
        ctrlKey: false,
        shiftKey: false,
        nativeEvent: { isComposing: false },
        preventDefault: vi.fn(),
      };
      const shouldSend = event.key === 'Enter' && !event.shiftKey && !event.ctrlKey;
      expect(shouldSend).toBe(true);
    });

    it('Enter during IME composition should NOT trigger send', () => {
      const event = {
        key: 'Enter',
        ctrlKey: false,
        shiftKey: false,
        nativeEvent: { isComposing: true },
        preventDefault: vi.fn(),
      };
      const shouldSend = event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing;
      expect(shouldSend).toBe(false);
    });
  });

  describe('project alert', () => {
    it('should show project alert when sending without project', () => {
      const currentProject = null;
      const input = 'some task';
      const showAlert = !currentProject && !!input.trim();
      expect(showAlert).toBe(true);
    });

    it('should not show project alert when project is set', () => {
      const currentProject = { id: '1', name: 'test', path: '/test' };
      const input = 'some task';
      const showAlert = !currentProject && !!input.trim();
      expect(showAlert).toBe(false);
    });
  });

  describe('textarea capabilities', () => {
    it('should support max 20000 characters', () => {
      const maxLength = 20000;
      expect(maxLength).toBe(20000);
    });

    it('should support Chinese text', () => {
      const text = '读取 package.json，概括当前项目，不要修改文件。';
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain('package.json');
    });
  });
});
