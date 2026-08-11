import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Search, TerminalSquare } from 'lucide-react';
import { formatCommandShortcut, type WorkbenchCommandDefinition } from '../../../shared/commands';
import { CommandRegistry, type CommandExecutionContext } from '../../commands/CommandRegistry';

export interface CommandPaletteProps {
  open: boolean;
  registry: CommandRegistry;
  onClose: () => void;
  executionContext?: CommandExecutionContext;
}

export function CommandPalette({
  open,
  registry,
  onClose,
  executionContext = { source: 'palette', modalOpen: true },
}: CommandPaletteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const deferredQuery = useDeferredValue(query);
  const commands = useMemo(
    () => registry.search(deferredQuery),
    [deferredQuery, registry],
  );

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelectedIndex(0);
    queueMicrotask(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    setSelectedIndex((index) => Math.min(index, Math.max(0, commands.length - 1)));
  }, [commands.length]);

  if (!open) return null;

  const execute = (command: WorkbenchCommandDefinition | undefined) => {
    if (!command) return;
    void registry.execute(command.id, { ...executionContext, source: 'palette' }).then((handled) => {
      if (handled) onClose();
    });
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center pt-[12vh]"
      style={{ background: 'var(--bg-overlay)' }}
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
      data-testid="command-palette-backdrop"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        className="w-[min(680px,calc(100vw-32px))] overflow-hidden rounded-xl border shadow-xl"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}
      >
        <div className="relative border-b" style={{ borderColor: 'var(--border-primary)' }}>
          <Search
            size={16}
            className="absolute left-4 top-4"
            style={{ color: 'var(--text-tertiary)' }}
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                setSelectedIndex((index) => commands.length > 0 ? (index + 1) % commands.length : 0);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setSelectedIndex((index) => commands.length > 0 ? (index - 1 + commands.length) % commands.length : 0);
              } else if (event.key === 'Enter' && !event.repeat) {
                event.preventDefault();
                execute(commands[selectedIndex]);
              }
            }}
            className="w-full bg-transparent py-3.5 pl-11 pr-4 text-sm focus:outline-none"
            placeholder="输入命令或操作名称"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={commands[selectedIndex] ? `command-option:${commands[selectedIndex].id}` : undefined}
          />
        </div>

        <div
          id="command-palette-list"
          role="listbox"
          className="max-h-[min(55vh,480px)] overflow-y-auto p-2"
        >
          {commands.map((command, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              id={`command-option:${command.id}`}
              key={command.id}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => execute(command)}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left"
              style={{ background: index === selectedIndex ? 'var(--bg-hover)' : 'transparent' }}
            >
              <TerminalSquare size={14} style={{ color: 'var(--accent)' }} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{command.title}</span>
                <span className="block truncate text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                  {command.description}
                </span>
              </span>
              {command.shortcut ? (
                <kbd
                  className="rounded border px-1.5 py-0.5 text-[10px]"
                  style={{ color: 'var(--text-tertiary)', borderColor: 'var(--border-primary)' }}
                >
                  {formatCommandShortcut(command.shortcut)}
                </kbd>
              ) : null}
            </button>
          ))}
          {commands.length === 0 ? (
            <div className="py-10 text-center text-xs" style={{ color: 'var(--text-disabled)' }}>
              没有匹配的命令
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

