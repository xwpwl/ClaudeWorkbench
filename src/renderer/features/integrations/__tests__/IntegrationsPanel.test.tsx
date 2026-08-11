// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntegrationsPanel } from '../IntegrationsPanel';

afterEach(cleanup);

describe('IntegrationsPanel initial tab', () => {
  it('opens the typed Skills tab without duplicating project integration logic', () => {
    render(<IntegrationsPanel
      initialTab="skills"
      mcpServers={[]}
      skills={[]}
      onRefresh={vi.fn()}
      onViewSkill={vi.fn()}
    />);
    expect(screen.getByRole('textbox', { name: '搜索 Skills' })).not.toBeNull();
  });
});
