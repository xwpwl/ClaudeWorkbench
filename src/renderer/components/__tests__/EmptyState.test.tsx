// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FolderOpen } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmptyState } from '../EmptyState';

afterEach(cleanup);

describe('EmptyState', () => {
  it('labels a semantic region and invokes its real primary action', async () => {
    const action = vi.fn();
    render(<EmptyState
      icon={FolderOpen}
      title="Open a project"
      description="Choose a local folder to start."
      action={{ label: 'Open project', onClick: action }}
    />);
    const region = screen.getByRole('region', { name: 'Open a project' });
    expect(region.textContent).toContain('Choose a local folder to start.');
    await userEvent.click(screen.getByRole('button', { name: 'Open project' }));
    expect(action).toHaveBeenCalledOnce();
    expect(region.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('supports compact layout, a secondary action, and disabled controls', () => {
    render(<EmptyState
      icon={FolderOpen}
      title="No tasks"
      description="Create a task to continue."
      compact
      action={{ label: 'Create task', onClick: vi.fn(), disabled: true }}
      secondaryAction={{ label: 'Open project', onClick: vi.fn() }}
    />);
    expect(screen.getByRole('region', { name: 'No tasks' }).getAttribute('data-compact')).toBe('true');
    expect(screen.getByRole('button', { name: 'Create task' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Open project' }).hasAttribute('disabled')).toBe(false);
  });
});
