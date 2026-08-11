import { describe, expect, it, vi } from 'vitest';
import {
  WORKBENCH_COMMANDS,
  formatCommandShortcut,
  type WorkbenchCommandDefinition,
} from '../../../shared/commands';
import {
  CommandRegistry,
  isEditableCommandTarget,
  resolveCommandShortcut,
  type CommandKeyboardEvent,
} from '../CommandRegistry';

function keyboard(
  key: string,
  overrides: Partial<CommandKeyboardEvent> = {},
): CommandKeyboardEvent {
  return {
    key,
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    isComposing: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  };
}

describe('CommandRegistry shortcuts', () => {
  it('[SC-01] includes every command required by the task and command palette', () => {
    expect(WORKBENCH_COMMANDS.map((command) => command.id)).toEqual(expect.arrayContaining([
      'project.open',
      'task.switch',
      'history.refresh',
      'settings.open',
      'model.switch',
      'permission.switch',
      'terminal.open',
      'diff.open',
      'task.new',
      'project.search',
      'task.search',
      'command-palette.open',
      'task.send',
      'task.send-plan',
    ]));
  });

  it('[SC-02] resolves Ctrl+N to new task', () => {
    expect(resolveCommandShortcut(keyboard('n'))?.id).toBe('task.new');
  });

  it('[SC-03] resolves Ctrl+P to project search', () => {
    expect(resolveCommandShortcut(keyboard('P'))?.id).toBe('project.search');
  });

  it('[SC-04] resolves Ctrl+K to task search', () => {
    expect(resolveCommandShortcut(keyboard('k'))?.id).toBe('task.search');
  });

  it('[SC-05] gives Ctrl+Shift+P command palette exact-modifier priority', () => {
    const command = resolveCommandShortcut(keyboard('p', { shiftKey: true }));
    expect(command?.id).toBe('command-palette.open');
  });

  it('[SC-06] resolves Ctrl+Enter to normal send', () => {
    expect(resolveCommandShortcut(keyboard('Enter'))?.id).toBe('task.send');
  });

  it('[SC-07] resolves Ctrl+Shift+Enter to plan send instead of normal send', () => {
    expect(resolveCommandShortcut(keyboard('Enter', { shiftKey: true }))?.id)
      .toBe('task.send-plan');
  });

  it('[SC-08] supports Meta as the platform command modifier', () => {
    expect(resolveCommandShortcut(keyboard('n', { ctrlKey: false, metaKey: true }))?.id)
      .toBe('task.new');
  });

  it('[SC-09] ignores IME composition before resolving any shortcut', () => {
    expect(resolveCommandShortcut(keyboard('Enter', { isComposing: true }))).toBeNull();
  });

  it('[SC-10] ignores repeated keyboard events', () => {
    expect(resolveCommandShortcut(keyboard('n', { repeat: true }))).toBeNull();
  });

  it('[SC-11] detects inputs, textareas, contenteditable elements, and textbox roles', () => {
    expect(isEditableCommandTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(isEditableCommandTarget({ tagName: 'textarea' } as unknown as EventTarget)).toBe(true);
    expect(isEditableCommandTarget({ isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isEditableCommandTarget({
      getAttribute: (name: string) => name === 'role' ? 'textbox' : null,
    } as unknown as EventTarget)).toBe(true);
    expect(isEditableCommandTarget({ tagName: 'button' } as unknown as EventTarget)).toBe(false);
  });

  it('[SC-12] suppresses commands that did not opt into editable targets', () => {
    const command: WorkbenchCommandDefinition = {
      ...WORKBENCH_COMMANDS.find((candidate) => candidate.id === 'task.new')!,
      shortcut: {
        key: 'n',
        ctrlOrMeta: true,
        allowInEditable: false,
      },
    };
    const event = keyboard('n', { target: { tagName: 'INPUT' } as unknown as EventTarget });

    expect(resolveCommandShortcut(event, [command])).toBeNull();
  });

  it('[SC-13] allows only modal-safe shortcuts while a command surface owns focus', () => {
    expect(resolveCommandShortcut(keyboard('n'), WORKBENCH_COMMANDS, { modalOpen: true }))
      .toBeNull();
    expect(resolveCommandShortcut(
      keyboard('p', { shiftKey: true }),
      WORKBENCH_COMMANDS,
      { modalOpen: true },
    )?.id).toBe('command-palette.open');
  });

  it('[SC-14] rejects extra Alt or Shift modifiers', () => {
    expect(resolveCommandShortcut(keyboard('n', { altKey: true }))).toBeNull();
    expect(resolveCommandShortcut(keyboard('n', { shiftKey: true }))).toBeNull();
  });

  it('[SC-15] prevents default exactly when a registered shortcut executes', () => {
    const registry = new CommandRegistry();
    const handler = vi.fn();
    registry.register('task.new', handler);
    const handled = keyboard('n');
    const unhandled = keyboard('k');

    expect(registry.handleKeyDown(handled)).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    expect(handled.preventDefault).toHaveBeenCalledOnce();
    expect(handled.stopPropagation).toHaveBeenCalledOnce();
    expect(registry.handleKeyDown(unhandled)).toBe(false);
    expect(unhandled.preventDefault).not.toHaveBeenCalled();
  });

  it('[SC-16] unregisters only the currently registered handler', async () => {
    const registry = new CommandRegistry();
    const first = vi.fn();
    const second = vi.fn();
    const removeFirst = registry.register('task.new', first);
    const removeSecond = registry.register('task.new', second);

    removeFirst();
    expect(await registry.execute('task.new')).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    removeSecond();
    expect(await registry.execute('task.new')).toBe(false);
  });

  it('[SC-17] searches titles, ids, descriptions, and keywords in stable relevance order', () => {
    const registry = new CommandRegistry();

    expect(registry.search('切换模型')[0].id).toBe('model.switch');
    expect(registry.search('permission')[0].id).toBe('permission.switch');
    expect(registry.search('代码审查')[0].id).toBe('diff.open');
    expect(registry.search('missing-command')).toEqual([]);
  });

  it('[SC-18] formats user-facing shortcut labels', () => {
    const palette = WORKBENCH_COMMANDS.find((command) => command.id === 'command-palette.open');
    const sendPlan = WORKBENCH_COMMANDS.find((command) => command.id === 'task.send-plan');

    expect(formatCommandShortcut(palette?.shortcut)).toBe('Ctrl+Shift+P');
    expect(formatCommandShortcut(sendPlan?.shortcut)).toBe('Ctrl+Shift+Enter');
  });

  it('[SC-19] rejects duplicate command ids at construction', () => {
    expect(() => new CommandRegistry([WORKBENCH_COMMANDS[0], WORKBENCH_COMMANDS[0]]))
      .toThrow('Duplicate command id');
  });

  it('[SC-20] routes asynchronous shortcut failures through the error boundary', async () => {
    const onError = vi.fn();
    const registry = new CommandRegistry(WORKBENCH_COMMANDS, { onError });
    registry.register('task.new', async () => {
      throw new Error('expected failure');
    });

    registry.handleKeyDown(keyboard('n'));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0][1]).toBe('task.new');
  });
});

