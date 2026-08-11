// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../shared/types/project';
import { setLocale } from '../../i18n';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { ChatTimeline } from '../chat/ChatTimeline';
import { ProjectSidebar } from '../projects/ProjectSidebar';

const controller = vi.hoisted(() => ({
  createTask: vi.fn(),
  selectProject: vi.fn(),
  selectSession: vi.fn(),
  renameSession: vi.fn(),
  setArchived: vi.fn(),
  setFavorite: vi.fn(),
  fork: vi.fn(),
}));

vi.mock('../../hooks/useWorkspaceController', () => ({
  useWorkspaceController: () => controller,
}));

const project: Project = {
  id: 'project-1',
  name: 'Fixture project',
  path: 'C:\\Projects\\fixture',
  createdAt: '2026-08-09T00:00:00.000Z',
  lastOpenedAt: '2026-08-09T00:00:00.000Z',
};

beforeEach(() => {
  setLocale('en-US');
  useWorkspaceStore.getState().reset();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  useWorkspaceStore.getState().reset();
  setLocale('zh-CN');
});

describe('actionable workspace empty states', () => {
  it('opens a project from the Chat timeline no-project state', async () => {
    const onOpenProject = vi.fn();
    render(<ChatTimeline onOpenProject={onOpenProject} />);

    const emptyState = screen.getByRole('region', { name: 'Start with a Project' });
    await userEvent.click(within(emptyState).getByRole('button', { name: 'Open Project' }));

    expect(onOpenProject).toHaveBeenCalledOnce();
  });

  it('creates a task from the Chat timeline no-task state', async () => {
    const onCreateTask = vi.fn();
    useWorkspaceStore.setState({ currentProject: project, projects: [project], projectLoading: false });
    render(<ChatTimeline onCreateTask={onCreateTask} />);

    const emptyState = screen.getByRole('region', { name: 'No tasks yet' });
    await userEvent.click(within(emptyState).getByRole('button', { name: 'New Task' }));

    expect(onCreateTask).toHaveBeenCalledOnce();
  });

  it('opens a project from the compact Sidebar no-project state', async () => {
    const onOpenProject = vi.fn();
    render(<ProjectSidebar onOpenProject={onOpenProject} />);

    const emptyState = screen.getByRole('region', { name: 'No projects yet' });
    expect(emptyState.getAttribute('data-compact')).toBe('true');
    await userEvent.click(within(emptyState).getByRole('button', { name: 'Open Project' }));

    expect(onOpenProject).toHaveBeenCalledOnce();
  });

  it('creates a task from the compact Sidebar state for a selected project with no tasks', async () => {
    useWorkspaceStore.setState({
      currentProject: project,
      projects: [project],
      sessionsByProject: { [project.id]: [] },
      projectLoading: false,
      projectError: null,
    });
    render(<ProjectSidebar onOpenProject={vi.fn()} />);

    const emptyState = screen.getByRole('region', { name: 'No tasks yet' });
    expect(emptyState.getAttribute('data-compact')).toBe('true');
    await userEvent.click(within(emptyState).getByRole('button', { name: 'New Task' }));

    expect(controller.createTask).toHaveBeenCalledOnce();
  });
});
