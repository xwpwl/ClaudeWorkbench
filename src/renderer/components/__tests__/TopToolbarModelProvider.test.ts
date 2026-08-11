import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ResolvedModelSelection } from '../../../shared/types/modelProviders';
import type { TaskModelSwitchOptionPublic } from '../../../shared/types/projectAi';
import { TopToolbar } from '../TopToolbar';

const capabilities = {
  supportsClaudeCode: true, supportsAgentWorkflow: true, supportsTools: true,
  supportsMCP: true, supportsStreaming: true, supportsVision: false,
};
const selection: ResolvedModelSelection = { providerId: 'mimo', providerName: 'MiMo', modelId: 'mimo-v2.5-pro', runtimeType: 'claude-code', capabilities, source: 'project_policy' };
const options: TaskModelSwitchOptionPublic[] = [{
  providerId: 'mimo', providerName: 'MiMo', modelId: 'mimo-v2.5-pro',
  modelDisplayName: null, runtimeType: 'claude-code',
}];

describe('TopToolbar Provider model surface', () => {
  it('uses the capability-aware quick switcher when a trusted model state is supplied', () => {
    const html = renderToStaticMarkup(React.createElement(TopToolbar, {
      onOpenProject: () => {},
      modelProviderState: {
        selection,
        options,
        error: null,
        onSwitch: () => {},
      },
    }));
    expect(html).toContain('data-testid="model-quick-switcher"');
    expect(html).toContain('MiMo');
    expect(html).toContain('mimo-v2.5-pro');
    expect(html).not.toContain('placeholder="输入模型名称或 ID"');
  });

  it('marks the model switcher blocked while a non-terminal Workflow owns the task', () => {
    const html = renderToStaticMarkup(React.createElement(TopToolbar, {
      onOpenProject: () => {},
      modelSwitchBlocked: true,
      modelProviderState: {
        selection,
        options,
        error: null,
        onSwitch: () => {},
      },
    }));
    expect(html).toContain('aria-disabled="true"');
  });
});
