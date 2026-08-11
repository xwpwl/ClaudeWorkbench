import {
  WORKBENCH_COMMANDS,
  type WorkbenchCommandDefinition,
  type WorkbenchCommandId,
} from '../../shared/commands';

export interface CommandExecutionContext {
  source?: 'shortcut' | 'palette' | 'programmatic';
  modalOpen?: boolean;
}

export interface CommandKeyboardEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  target?: EventTarget | null;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

export type CommandHandler = (
  context: CommandExecutionContext,
) => void | Promise<void>;

export interface ShortcutResolutionOptions {
  modalOpen?: boolean;
  editableTarget?: boolean;
}

interface CommandRegistryOptions {
  onError?: (error: unknown, commandId: WorkbenchCommandId) => void;
}

function normalizedKey(key: string): string {
  return key.toLocaleLowerCase();
}

export function isEditableCommandTarget(target: EventTarget | null | undefined): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as {
    tagName?: string;
    isContentEditable?: boolean;
    getAttribute?: (name: string) => string | null;
    closest?: (selector: string) => unknown;
  };
  const tagName = element.tagName?.toLocaleLowerCase();
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') return true;
  if (element.isContentEditable) return true;
  if (element.getAttribute?.('role') === 'textbox') return true;
  return Boolean(element.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"]'));
}

function shortcutMatches(
  event: CommandKeyboardEvent,
  command: WorkbenchCommandDefinition,
): boolean {
  const shortcut = command.shortcut;
  if (!shortcut) return false;
  const ctrlOrMeta = Boolean(event.ctrlKey || event.metaKey);
  return normalizedKey(event.key) === normalizedKey(shortcut.key)
    && ctrlOrMeta === shortcut.ctrlOrMeta
    && Boolean(event.shiftKey) === Boolean(shortcut.shift)
    && Boolean(event.altKey) === Boolean(shortcut.alt);
}

export function resolveCommandShortcut(
  event: CommandKeyboardEvent,
  commands: readonly WorkbenchCommandDefinition[] = WORKBENCH_COMMANDS,
  options: ShortcutResolutionOptions = {},
): WorkbenchCommandDefinition | null {
  if (event.isComposing || event.repeat) return null;
  const editableTarget = options.editableTarget ?? isEditableCommandTarget(event.target);
  const candidates = commands
    .filter((command) => {
      const shortcut = command.shortcut;
      if (!shortcut || !shortcutMatches(event, command)) return false;
      if (editableTarget && !shortcut.allowInEditable) return false;
      if (options.modalOpen && !shortcut.allowWhenModalOpen) return false;
      return true;
    })
    .sort(
      (left, right) => (right.shortcut?.priority ?? 0) - (left.shortcut?.priority ?? 0),
    );
  return candidates[0] ?? null;
}

function searchText(command: WorkbenchCommandDefinition): string {
  return [
    command.id,
    command.title,
    command.description,
    command.category,
    ...command.keywords,
  ].join(' ').toLocaleLowerCase();
}

function searchScore(command: WorkbenchCommandDefinition, query: string): number {
  if (!query) return 0;
  const title = command.title.toLocaleLowerCase();
  const id = command.id.toLocaleLowerCase();
  if (title === query || id === query) return 100;
  if (title.startsWith(query)) return 80;
  if (id.startsWith(query)) return 70;
  if (command.keywords.some((keyword) => keyword.toLocaleLowerCase().startsWith(query))) {
    return 60;
  }
  return searchText(command).includes(query) ? 40 : -1;
}

export class CommandRegistry {
  private readonly definitions: readonly WorkbenchCommandDefinition[];
  private readonly definitionsById: ReadonlyMap<WorkbenchCommandId, WorkbenchCommandDefinition>;
  private readonly handlers = new Map<WorkbenchCommandId, CommandHandler>();
  private readonly onError: (error: unknown, commandId: WorkbenchCommandId) => void;

  constructor(
    definitions: readonly WorkbenchCommandDefinition[] = WORKBENCH_COMMANDS,
    options: CommandRegistryOptions = {},
  ) {
    const definitionsById = new Map<WorkbenchCommandId, WorkbenchCommandDefinition>();
    for (const definition of definitions) {
      if (definitionsById.has(definition.id)) {
        throw new Error(`Duplicate command id: ${definition.id}`);
      }
      definitionsById.set(definition.id, definition);
    }
    this.definitions = [...definitions];
    this.definitionsById = definitionsById;
    this.onError = options.onError ?? (() => undefined);
  }

  list(): readonly WorkbenchCommandDefinition[] {
    return this.definitions;
  }

  get(commandId: WorkbenchCommandId): WorkbenchCommandDefinition | undefined {
    return this.definitionsById.get(commandId);
  }

  register(commandId: WorkbenchCommandId, handler: CommandHandler): () => void {
    if (!this.definitionsById.has(commandId)) {
      throw new Error(`Unknown command id: ${commandId}`);
    }
    this.handlers.set(commandId, handler);
    return () => {
      if (this.handlers.get(commandId) === handler) this.handlers.delete(commandId);
    };
  }

  async execute(
    commandId: WorkbenchCommandId,
    context: CommandExecutionContext = { source: 'programmatic' },
  ): Promise<boolean> {
    const handler = this.handlers.get(commandId);
    if (!handler) return false;
    await handler(context);
    return true;
  }

  search(query: string): WorkbenchCommandDefinition[] {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [...this.definitions];
    return this.definitions
      .map((command, index) => ({
        command,
        index,
        score: searchScore(command, normalized),
      }))
      .filter((entry) => entry.score >= 0)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .map((entry) => entry.command);
  }

  handleKeyDown(
    event: CommandKeyboardEvent,
    context: CommandExecutionContext = { source: 'shortcut' },
  ): boolean {
    const command = resolveCommandShortcut(event, this.definitions, {
      modalOpen: context.modalOpen,
    });
    if (!command || !this.handlers.has(command.id)) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    void this.execute(command.id, { ...context, source: 'shortcut' }).catch((error) => {
      this.onError(error, command.id);
    });
    return true;
  }

  attach(
    target: Window | Document,
    contextProvider: () => CommandExecutionContext = () => ({ source: 'shortcut' }),
  ): () => void {
    const listener: EventListener = (event) => {
      this.handleKeyDown(event as KeyboardEvent, contextProvider());
    };
    target.addEventListener('keydown', listener);
    return () => target.removeEventListener('keydown', listener);
  }
}

