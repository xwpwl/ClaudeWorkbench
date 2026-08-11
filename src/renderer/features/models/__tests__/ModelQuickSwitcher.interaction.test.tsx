// @vitest-environment jsdom

import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModelSelection } from '../../../../shared/types/modelProviders';
import type { TaskModelSwitchOptionPublic } from '../../../../shared/types/projectAi';
import { ModelQuickSwitcher } from '../ModelQuickSwitcher';

afterEach(cleanup);

const capabilities = {
  supportsClaudeCode: true,
  supportsAgentWorkflow: true,
  supportsTools: true,
  supportsMCP: true,
  supportsStreaming: true,
  supportsVision: false,
};
const selection: ResolvedModelSelection = {
  providerId: `synthetic:v1:${'a'.repeat(64)}`,
  providerName: 'Claude Code',
  modelId: 'sonnet',
  runtimeType: 'claude-code',
  capabilities,
  source: 'claude_code',
  executionSource: 'claude_code',
};
const options: TaskModelSwitchOptionPublic[] = [{
  providerId: 'mimo',
  providerName: 'MiMo',
  modelId: 'mimo-v2.5-pro',
  modelDisplayName: 'MiMo Pro',
  runtimeType: 'claude-code',
}, {
  providerId: 'claude',
  providerName: 'Claude',
  modelId: 'sonnet',
  modelDisplayName: null,
  runtimeType: 'claude-code',
}];

function Harness({
  running = false,
  error = null,
  currentSelection = selection,
  switchOptions = options,
  onSwitch = vi.fn(async () => undefined),
  onClearOverride,
}: {
  running?: boolean;
  error?: string | null;
  currentSelection?: ResolvedModelSelection;
  switchOptions?: TaskModelSwitchOptionPublic[];
  onSwitch?: (option: { providerId: string; modelId: string }) => Promise<void>;
  onClearOverride?: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return <div>
    <ModelQuickSwitcher
      selection={currentSelection}
      options={switchOptions}
      isTaskRunning={running}
      error={error}
      open={open}
      onOpenChange={setOpen}
      onSwitch={onSwitch}
      onClearOverride={onClearOverride}
      confirmSwitch={() => true}
    />
    <button type="button">Outside control</button>
  </div>;
}

describe('ModelQuickSwitcher accessible interactions', () => {
  it('uses one button/listbox/option interaction with keyboard selection', async () => {
    const user = userEvent.setup();
    const onSwitch = vi.fn(async () => undefined);
    render(<Harness onSwitch={onSwitch} />);
    const trigger = screen.getByRole('button', { name: /Claude Code.*sonnet/iu });

    await user.click(trigger);
    expect(screen.getByRole('listbox', { name: /model|模型/iu })).toBeTruthy();
    const renderedOptions = screen.getAllByRole('option');
    expect(renderedOptions).toHaveLength(2);
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(renderedOptions[0]));
    fireEvent.keyDown(renderedOptions[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(renderedOptions[1]);
    fireEvent.keyDown(renderedOptions[1], { key: 'Enter' });

    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith({
      providerId: 'claude', modelId: 'sonnet',
    }));
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  it('closes on Escape and outside pointer, returning focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: /Claude Code.*sonnet/iu });

    await user.click(trigger);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await user.click(trigger);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside control' }));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows mutation failures and blocks active work without committing a selection', async () => {
    const user = userEvent.setup();
    const onSwitch = vi.fn(async () => undefined);
    render(<Harness running error="The current task is active. Try again after it finishes." onSwitch={onSwitch} />);

    await user.click(screen.getByRole('button', { name: /Claude Code.*sonnet/iu }));
    expect(screen.getByRole('alert').textContent).toContain('The current task is active');
    await user.click(screen.getAllByRole('option')[0]);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('renders only main-projected safe options and never exposes synthetic identity text', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    await user.click(screen.getByRole('button', { name: /Claude Code.*sonnet/iu }));
    expect(screen.getByRole('option', { name: 'MiMo / mimo-v2.5-pro' })).toBeTruthy();
    expect(container.innerHTML).not.toMatch(/synthetic:v1|DeepSeek|credential|private-path/iu);
  });

  it('focuses the selected first option and prevents a redundant mutation', async () => {
    const user = userEvent.setup();
    const onSwitch = vi.fn(async () => undefined);
    const selectedFirst = {
      ...selection,
      providerId: 'mimo',
      providerName: 'MiMo',
      modelId: 'mimo-v2.5-pro',
      source: 'task_override' as const,
    };
    render(<Harness currentSelection={selectedFirst} onSwitch={onSwitch} />);
    const trigger = screen.getByRole('button', { name: /MiMo.*mimo-v2.5-pro/iu });
    await user.click(trigger);

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const selectedOption = screen.getAllByRole('option')[0];
    await waitFor(() => expect(document.activeElement).toBe(selectedOption));
    fireEvent.keyDown(selectedOption, { key: 'Enter' });

    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('opens on the selected middle option and gives Home and End deterministic targets', async () => {
    const user = userEvent.setup();
    const threeOptions = [options[0], options[1], {
      providerId: 'other', providerName: 'Other', modelId: 'other-model',
      modelDisplayName: null, runtimeType: 'claude-code' as const,
    }];
    const selectedMiddle = {
      ...selection,
      providerId: 'claude',
      providerName: 'Claude',
      modelId: 'sonnet',
      source: 'task_override' as const,
    };
    render(<Harness currentSelection={selectedMiddle} switchOptions={threeOptions} />);
    const trigger = screen.getByRole('button', { name: /Claude.*sonnet/iu });
    await user.click(trigger);
    const renderedOptions = screen.getAllByRole('option');

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(renderedOptions[1]));
    fireEvent.keyDown(renderedOptions[1], { key: 'End' });
    expect(document.activeElement).toBe(renderedOptions[2]);
    fireEvent.keyDown(renderedOptions[2], { key: 'Home' });
    expect(document.activeElement).toBe(renderedOptions[0]);
  });

  it('keeps focus on the trigger when every option is unavailable', async () => {
    const user = userEvent.setup();
    const onSwitch = vi.fn(async () => undefined);
    render(<Harness running onSwitch={onSwitch} />);
    const trigger = screen.getByRole('button', { name: /Claude Code.*sonnet/iu });
    await user.click(trigger);

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await Promise.resolve();

    expect(document.activeElement).toBe(trigger);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('keeps reset and empty-state controls outside the listbox ownership tree', async () => {
    const user = userEvent.setup();
    const onClearOverride = vi.fn(async () => undefined);
    const taskOverride = { ...selection, source: 'task_override' as const };
    render(<Harness
      currentSelection={taskOverride}
      switchOptions={[]}
      onClearOverride={onClearOverride}
    />);
    await user.click(screen.getByRole('button', { name: /Claude Code.*sonnet/iu }));

    const reset = screen.getByTestId('follow-model-policy');
    const empty = screen.getByText(/No model supports the Claude Code Runtime|没有支持 Claude Code Runtime 的模型/iu);
    expect(reset.closest('[role="listbox"]')).toBeNull();
    expect(empty.closest('[role="listbox"]')).toBeNull();
    const listbox = screen.queryByRole('listbox');
    if (listbox) {
      expect(within(listbox).queryAllByRole('option')).toHaveLength(0);
      expect(listbox.children).toHaveLength(0);
    }
  });
});
