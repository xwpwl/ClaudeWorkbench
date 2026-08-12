import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedModelSelection } from '../../../../shared/types/modelProviders';
import type { TaskModelSwitchOptionPublic } from '../../../../shared/types/projectAi';
import { setLocale } from '../../../i18n';
import { ModelQuickSwitcher, confirmFutureModelReset, confirmFutureModelSwitch } from '../ModelQuickSwitcher';

const capabilities = {
  supportsClaudeCode: true, supportsAgentWorkflow: true, supportsTools: true,
  supportsMCP: true, supportsStreaming: true, supportsVision: false,
};

const options: TaskModelSwitchOptionPublic[] = [{
  providerId: 'mimo', providerName: 'MiMo', modelId: 'mimo-v2.5-pro',
  modelDisplayName: null, runtimeType: 'claude-code',
}];
const selection: ResolvedModelSelection = {
  providerId: 'mimo', providerName: 'MiMo', modelId: 'mimo-v2.5-pro', runtimeType: 'claude-code',
  capabilities, source: 'task_override',
};

describe('ModelQuickSwitcher', () => {
  it('shows Provider / Model in the top-level control', () => {
    const html = renderToStaticMarkup(React.createElement(ModelQuickSwitcher, {
      selection, options, isTaskRunning: false,
      open: false, onOpenChange: () => {}, onSwitch: () => {},
    }));
    expect(html).toContain('MiMo');
    expect(html).toContain('/');
    expect(html).toContain('mimo-v2.5-pro');
  });

  it('shows Provider, Runtime, capabilities, and effective source details when open', () => {
    const html = renderToStaticMarkup(React.createElement(ModelQuickSwitcher, {
      selection, options, isTaskRunning: false,
      open: true, onOpenChange: () => {}, onSwitch: () => {},
    }));
    expect(html).toContain('Claude Code Agent Runtime');
    expect(html).toContain('任务覆盖');
    expect(html).toContain('Capabilities');
    expect(html).toContain('Agent Workflow');
    expect(html).toContain('MCP');
  });

  it.each([
    ['project_policy', '项目策略'],
    ['global_agent_policy', '全局默认'],
    ['global_default', '全局默认'],
    ['environment', '环境变量'],
    ['claude_code', 'Claude Code'],
  ] as const)('shows effective source %s as %s', (source, label) => {
    const html = renderToStaticMarkup(React.createElement(ModelQuickSwitcher, {
      selection: { ...selection, source }, options,
      isTaskRunning: false, open: true, onOpenChange: () => {}, onSwitch: () => {},
    }));
    expect(html).toContain(label);
  });

  it('disables model switching while a task is active', () => {
    const html = renderToStaticMarkup(React.createElement(ModelQuickSwitcher, {
      selection, options, isTaskRunning: true,
      open: true, onOpenChange: () => {}, onSwitch: () => {},
    }));
    expect(html).toContain('正在运行任务时不能切换模型');
    expect(html).toContain('data-testid="model-switch-option" disabled=""');
  });

  it('offers returning a task override to its configured policy', () => {
    const html = renderToStaticMarkup(React.createElement(ModelQuickSwitcher, {
      selection, options, isTaskRunning: false,
      open: true, onOpenChange: () => {}, onSwitch: () => {}, onClearOverride: () => {},
    }));
    expect(html).toContain('data-testid="follow-model-policy"');
    expect(html).toContain('恢复跟随项目 / 全局策略');
  });

  it('keeps invalid task override recovery visible without showing a fake fallback model', () => {
    const html = renderToStaticMarkup(React.createElement(ModelQuickSwitcher, {
      selection: null,
      options,
      error: '该模型当前不能用于 Agent，请重新选择。',
      isTaskRunning: false,
      open: true,
      onOpenChange: () => {},
      onSwitch: () => {},
      onClearOverride: () => {},
    }));
    expect(html).toContain('需要重新配置');
    expect(html).toContain('该模型当前不能用于 Agent，请重新选择。');
    expect(html).toContain('data-testid="follow-model-policy"');
  });

  it('warns idle users that a switch changes future calls only', async () => {
    const confirm = vi.fn(() => true);
    const switchModel = vi.fn(async () => {});
    await expect(confirmFutureModelSwitch({ providerId: 'mimo', modelId: 'mimo-v2.5-pro' }, false, confirm, switchModel)).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith('模型改变只影响后续 Agent 调用。是否继续？');
    expect(switchModel).toHaveBeenCalledWith({ providerId: 'mimo', modelId: 'mimo-v2.5-pro' });
  });

  it('refuses active-task switches before asking for confirmation', async () => {
    const confirm = vi.fn(() => true);
    const switchModel = vi.fn(async () => {});
    await expect(confirmFutureModelSwitch({ providerId: 'mimo', modelId: 'mimo-v2.5-pro' }, true, confirm, switchModel)).resolves.toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(switchModel).not.toHaveBeenCalled();
  });

  it('uses the same future-call acknowledgement before clearing an override', async () => {
    const confirm = vi.fn(() => true);
    const clear = vi.fn(async () => {});
    await expect(confirmFutureModelReset(false, confirm, clear)).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith('模型改变只影响后续 Agent 调用。是否继续？');
    expect(clear).toHaveBeenCalledOnce();
  });

  it('renders only the main-projected task switch options', () => {
    const html = renderToStaticMarkup(React.createElement(ModelQuickSwitcher, {
      selection, options, isTaskRunning: false, open: true,
      onOpenChange: () => {}, onSwitch: () => {},
    }));
    expect(html).toContain('MiMo');
    expect(html).toContain('用途：Task Agent override');
    expect(html).toContain('来源：已配置 Provider');
    expect(html).not.toContain('DeepSeek');
  });

  it('renders all touched switcher instructions in the selected locale', () => {
    setLocale('en-US');
    try {
      const html = renderToStaticMarkup(React.createElement(ModelQuickSwitcher, {
        selection, options, isTaskRunning: false, open: true,
        onOpenChange: () => {}, onSwitch: () => {}, onClearOverride: () => {},
      }));
      expect(html).toContain('Available models');
      expect(html).toContain('Model changes affect subsequent Agent calls only.');
      expect(html).toContain('Follow project / global policy again');
      expect(html).not.toMatch(/可切换模型|恢复跟随|模型改变只影响/iu);
    } finally {
      setLocale('zh-CN');
    }
  });

  it.each([
    ['task_override', 'Task override'],
    ['project_policy', 'Project policy'],
    ['global_agent_policy', 'Global Agent role policy'],
    ['global_default', 'Global default Provider'],
    ['environment', 'Environment variables'],
    ['claude_code', 'Claude Code'],
  ] as const)('localizes effective source %s in English', (source, expected) => {
    setLocale('en-US');
    try {
      const html = renderToStaticMarkup(React.createElement(ModelQuickSwitcher, {
        selection: { ...selection, source }, options, isTaskRunning: false, open: true,
        onOpenChange: () => {}, onSwitch: () => {},
      }));
      expect(html).toContain(expected);
      expect(html).not.toMatch(/任务覆盖|项目策略|全局默认|环境变量/iu);
    } finally {
      setLocale('zh-CN');
    }
  });

  it('bounds the panel to the viewport and preserves full accessible names for long options', () => {
    const longProvider = 'Provider-with-an-extremely-long-display-name-that-must-not-overflow';
    const longModel = 'model-with-an-extremely-long-identifier-that-must-not-overflow';
    const html = renderToStaticMarkup(React.createElement(ModelQuickSwitcher, {
      selection,
      options: [{
        providerId: 'long', providerName: longProvider, modelId: longModel,
        modelDisplayName: null, runtimeType: 'claude-code',
      }],
      isTaskRunning: false, open: true, onOpenChange: () => {}, onSwitch: () => {},
    }));
    expect(html).toContain('data-narrow-safe="true"');
    expect(html).toMatch(/max-w-\[calc\(100vw-16px\)\]/u);
    expect(html).not.toContain('w-[330px]');
    expect(html).toContain(`aria-label="${longProvider} / ${longModel}"`);
    expect(html).toMatch(/min-w-0[^"']*truncate|truncate[^"']*min-w-0/u);
  });
});
