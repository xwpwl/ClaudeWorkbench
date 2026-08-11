import React, { useEffect, useRef, useState, useCallback } from 'react';
import { X, Trash2, Copy } from 'lucide-react';
import { t } from '../../i18n';

interface TerminalPanelProps {
  projectPath?: string;
  onClose: () => void;
}

export function TerminalPanel({ projectPath, onClose }: TerminalPanelProps) {
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [output, setOutput] = useState('');
  const [input, setInput] = useState('');
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!projectPath) return;

    const createTerminal = async () => {
      try {
        const id = await window.api.createTerminal(projectPath);
        setTerminalId(id);

        const unsubscribeOutput = window.api.onTerminalOutput(id, (data: string) => {
          setOutput((prev) => prev + data);
        });

        const unsubscribeExit = window.api.onTerminalExit(id, (code: number) => {
          setOutput((prev) => prev + `\n[${t('terminal.exit')} ${code}]\n`);
        });

        return () => {
          unsubscribeOutput();
          unsubscribeExit();
        };
      } catch (err) {
        console.error('Failed to create terminal:', err);
      }
    };

    const cleanup = createTerminal();
    return () => {
      cleanup?.then((fn) => fn?.());
    };
  }, [projectPath]);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  const handleSendInput = useCallback(async () => {
    if (!terminalId || !input) return;
    try {
      await window.api.writeToTerminal(terminalId, input + '\n');
      setInput('');
    } catch (err) {
      console.error('Failed to write to terminal:', err);
    }
  }, [terminalId, input]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSendInput();
      }
    },
    [handleSendInput],
  );

  const handleClear = useCallback(() => setOutput(''), []);
  const handleCopy = useCallback(() => navigator.clipboard.writeText(output), [output]);

  return (
    <div
      className="h-full flex flex-col"
      style={{ backgroundColor: 'var(--bg-secondary)', borderTop: '1px solid var(--border-primary)' }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-1.5 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--border-secondary)' }}
      >
        <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
          {t('terminal.title')}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleClear}
            className="p-1 rounded transition-colors"
            style={{ color: 'var(--text-disabled)' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-secondary)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-disabled)')}
            title={t('terminal.clear')}
          >
            <Trash2 size={13} />
          </button>
          <button
            onClick={handleCopy}
            className="p-1 rounded transition-colors"
            style={{ color: 'var(--text-disabled)' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-secondary)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-disabled)')}
            title={t('terminal.copy')}
          >
            <Copy size={13} />
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded transition-colors"
            style={{ color: 'var(--text-disabled)' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-secondary)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-disabled)')}
            title={t('terminal.close')}
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Output */}
      <div
        ref={outputRef}
        className="flex-1 overflow-y-auto p-2 text-xs whitespace-pre-wrap break-all scrollbar-hidden"
        style={{
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-primary)',
          backgroundColor: 'var(--bg-tertiary)',
        }}
      >
        {output || (
          <span style={{ color: 'var(--text-disabled)' }}>{t('terminal.ready')}</span>
        )}
      </div>

      {/* Input */}
      <div
        className="flex items-center gap-2 px-2 py-1.5 flex-shrink-0"
        style={{ borderTop: '1px solid var(--border-secondary)', backgroundColor: 'var(--bg-tertiary)' }}
      >
        <span className="text-xs font-mono" style={{ color: 'var(--accent)' }}>$</span>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('terminal.placeholder')}
          className="flex-1 bg-transparent text-xs focus:outline-none"
          style={{
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-primary)',
          }}
        />
      </div>
    </div>
  );
}
