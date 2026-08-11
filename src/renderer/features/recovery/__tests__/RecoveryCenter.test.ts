import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RecoveryItem } from '../../../../shared/types/recovery';
import { RecoveryCenter } from '../RecoveryCenter';

const item: RecoveryItem = {
  id: 'recovery-1', kind: 'workflow', resourceId: 'workflow-1', projectId: 'project',
  sessionId: 'task', taskId: 'task', lastState: 'executing', reason: 'unclean_shutdown',
  status: 'pending', detectedAt: '2026-08-01T00:00:00.000Z', resolvedAt: null,
};

describe('RecoveryCenter', () => {
  it('is a controlled component that does not execute recovery during render', () => {
    let resumed = false;
    const html = renderToStaticMarkup(React.createElement(RecoveryCenter, {
      items: [item],
      onResume: async () => { resumed = true; },
      onAbandon: async () => undefined,
      onViewLogs: () => undefined,
      onDismiss: () => undefined,
    }));
    expect(html).toContain('role="dialog"');
    expect(resumed).toBe(false);
  });

  it('renders safely with an empty recovery list', () => {
    expect(() => renderToStaticMarkup(React.createElement(RecoveryCenter, {
      items: [],
      onResume: async () => undefined,
      onAbandon: async () => undefined,
      onViewLogs: () => undefined,
      onDismiss: () => undefined,
    }))).not.toThrow();
  });
});
