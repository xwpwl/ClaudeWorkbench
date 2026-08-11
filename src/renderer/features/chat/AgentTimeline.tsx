import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  FileCode2,
  GitCompareArrows,
  ShieldAlert,
  Terminal,
  Wrench,
  XCircle,
} from 'lucide-react';
import { selectTimelinePresentations, taskToolKey } from '../../../shared/taskState';
import type { TaskTimelineEntry, TimelineTone } from '../../../shared/types/task';
import type { WorkspaceToolCall } from '../../stores/workspaceStore';

interface AgentTimelineProps {
  entries: TaskTimelineEntry[];
  tools: WorkspaceToolCall[];
}

function toneColor(tone: TimelineTone): string {
  if (tone === 'success') return 'var(--success)';
  if (tone === 'warning') return 'var(--warning)';
  if (tone === 'error') return 'var(--error)';
  if (tone === 'info') return 'var(--info)';
  return 'var(--text-tertiary)';
}

function toneStatus(tone: TimelineTone): string {
  if (tone === 'success') return '完成';
  if (tone === 'warning') return '等待';
  if (tone === 'error') return '失败';
  if (tone === 'info') return '进行中';
  return '记录';
}

function TimelineIcon({ tone, type }: { tone: TimelineTone; type: string }) {
  const style = { color: toneColor(tone) };
  if (tone === 'error') return <XCircle size={14} style={style} />;
  if (tone === 'success') return <CheckCircle size={14} style={style} />;
  if (type.startsWith('permission_')) return <ShieldAlert size={14} style={style} />;
  if (type.startsWith('file_')) return <FileCode2 size={14} style={style} />;
  if (type.startsWith('command_')) return <Terminal size={14} style={style} />;
  if (type.startsWith('git_')) return <GitCompareArrows size={14} style={style} />;
  if (type.startsWith('tool_')) return <Wrench size={14} style={style} />;
  if (type === 'stderr') return <AlertCircle size={14} style={style} />;
  if (type.startsWith('session_')) return <Clock3 size={14} style={style} />;
  return <Circle size={10} style={style} />;
}

function clock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function AgentTimeline({ entries, tools }: AgentTimelineProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const presentations = useMemo(() => selectTimelinePresentations(entries), [entries]);
  const toolsByKey = useMemo(
    () => new Map(tools.map((tool) => [tool.key, tool])),
    [tools],
  );

  if (presentations.length === 0) {
    return (
      <div className="rounded-lg border border-dashed px-4 py-5 text-center text-xs" style={{ color: 'var(--text-disabled)' }}>
        等待 Claude 返回工作进度…
      </div>
    );
  }

  return (
    <ol className="relative ml-3 border-l pl-5" style={{ borderColor: 'var(--border-secondary)' }}>
      {presentations.map((item) => {
        const eventType = item.event.type;
        const toolKey = item.toolUseId ? taskToolKey(item.runId, item.toolUseId) : null;
        const tool = toolKey ? toolsByKey.get(toolKey) : undefined;
        const gitFiles = 'files' in item.event && Array.isArray(item.event.files)
          ? [
            ...item.event.files,
            ...(item.event.type === 'git_restore_completed' ? item.event.deletedFiles : []),
          ]
          : [];
        const expansionKey = toolKey ?? (gitFiles.length > 0 ? item.id : null);
        const canExpand = Boolean(
          (tool && (tool.input !== undefined || tool.output !== undefined || tool.error))
          || gitFiles.length > 0,
        );
        const isExpanded = expansionKey ? expanded.has(expansionKey) : false;
        return (
          <li key={item.id} className="relative pb-4 last:pb-1" data-timeline-id={item.id}>
            <span className="absolute -left-[27px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full" style={{ background: 'var(--bg-primary)' }}>
              <TimelineIcon tone={item.tone} type={eventType} />
            </span>
            <div className="flex min-w-0 items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium" style={{ color: toneColor(item.tone) }}>{item.title}</span>
                  <span className="rounded-full px-1.5 py-0.5 text-[9px]" style={{ color: toneColor(item.tone), background: 'var(--bg-hover)' }}>{toneStatus(item.tone)}</span>
                  <time className="text-[10px]" style={{ color: 'var(--text-disabled)' }}>{clock(item.timestamp)}</time>
                </div>
                {item.detail ? (
                  <div className="selectable mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    {item.detail}
                  </div>
                ) : null}
              </div>
              {canExpand && expansionKey ? (
                <button
                  type="button"
                  onClick={() => setExpanded((previous) => {
                    const next = new Set(previous);
                    if (next.has(expansionKey)) next.delete(expansionKey);
                    else next.add(expansionKey);
                    return next;
                  })}
                  className="flex-shrink-0 rounded p-1"
                  style={{ color: 'var(--text-tertiary)' }}
                  aria-label={isExpanded ? '收起工具详情' : '展开工具详情'}
                >
                  {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
              ) : null}
            </div>
            {isExpanded && (tool || gitFiles.length > 0) ? (
              <pre className="selectable mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg px-3 py-2 text-[10px]" style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}>
                {tool
                  ? JSON.stringify({ input: tool.input, output: tool.output, error: tool.error }, null, 2)
                  : gitFiles.join('\n')}
              </pre>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
