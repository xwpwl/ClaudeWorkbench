import React, { useState } from 'react';
import { AlertTriangle, Check, ShieldAlert, Square, X } from 'lucide-react';
import type { PermissionDecision, PermissionRequest } from '../../../shared/types/permissionBroker';

interface PermissionDialogProps {
  request: PermissionRequest;
  onResolved: (requestId: string) => void;
  onStop: () => Promise<void>;
  onSwitchTargetProject?: () => Promise<void>;
}

function actionLabel(toolName: string): string {
  const labels: Record<string, string> = {
    BypassPermissions: '启用绕过权限模式',
    Bash: '运行命令',
    Read: '读取文件',
    Edit: '修改文件',
    Write: '写入文件',
    WebSearch: '联网搜索',
    WebFetch: '读取网页',
  };
  return labels[toolName] || `使用 ${toolName}`;
}

function conciseTarget(input: Record<string, unknown>): string {
  for (const key of ['command', 'file_path', 'path', 'query', 'url', 'pattern']) {
    if (typeof input[key] === 'string') return String(input[key]);
  }
  return JSON.stringify(input);
}

export function PermissionDialog({
  request,
  onResolved,
  onStop,
  onSwitchTargetProject,
}: PermissionDialogProps) {
  const [submitting, setSubmitting] = useState<PermissionDecision | 'stop' | 'switch' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isBypassRequest = request.kind === 'bypass_permissions'
    || request.toolName === 'BypassPermissions';
  const canReuseForTask = !isBypassRequest
    && request.risk !== 'high'
    && (request.cacheStatus !== 'not_cacheable' || request.outsideProject === true);
  const canPersistForProject = !isBypassRequest
    && request.projectRulePersistable === true
    && request.risk !== 'high'
    && request.outsideProject !== true;

  const decide = async (decision: PermissionDecision) => {
    setSubmitting(decision);
    setError(null);
    try {
      const receipt = await window.api.decidePermission(request.requestId, decision);
      if (!receipt.accepted) throw new Error(receipt.reason || '该权限请求已失效');
      onResolved(request.requestId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '权限决定提交失败');
      setSubmitting(null);
    }
  };

  const stop = async () => {
    setSubmitting('stop');
    setError(null);
    try {
      await onStop();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '停止任务失败');
      setSubmitting(null);
    }
  };

  const switchTargetProject = async () => {
    if (!onSwitchTargetProject) return;
    setSubmitting('switch');
    setError(null);
    try {
      await onSwitchTargetProject();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '切换目标项目失败');
      setSubmitting(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6" style={{ background: 'var(--bg-overlay)' }}>
      <div className="w-full max-w-xl rounded-2xl border p-5 shadow-lg" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }} role="dialog" aria-modal="true" aria-label="Claude 工具权限请求">
        <div className="flex items-start gap-3">
          <div className="rounded-xl p-2" style={{ background: 'var(--warning-bg)', color: 'var(--warning)' }}>
            {request.risk === 'high' ? <ShieldAlert size={22} /> : <AlertTriangle size={22} />}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">Claude 请求{actionLabel(request.toolName)}</h2>
            <p className="mt-1 text-xs" style={{ color: 'var(--text-tertiary)' }}>
              风险级别：{request.risk === 'high' ? '高' : request.risk === 'medium' ? '中' : '低'}
              {request.capability ? ` · ${request.capability}` : ''}
            </p>
            <p className="mt-1 truncate text-[11px]" style={{ color: 'var(--text-tertiary)' }} title={`${request.projectPath} · ${request.sessionKey}`}>
              {request.projectPath} · 会话 {request.sessionKey.split('::').at(-1)}
            </p>
          </div>
        </div>

        {!isBypassRequest && request.outsideProject && (
          <div
            className="mt-3 rounded-xl border p-3 text-xs"
            style={{ borderColor: 'var(--warning)', background: 'var(--warning-bg)' }}
            data-testid="permission-cross-project-warning"
          >
            <div className="font-semibold" style={{ color: 'var(--warning)' }}>跨项目访问</div>
            <div className="mt-2 break-all"><span style={{ color: 'var(--text-tertiary)' }}>当前项目：</span>{request.projectPath}</div>
            <div className="mt-1 break-all"><span style={{ color: 'var(--text-tertiary)' }}>实际工作目录：</span>{request.effectiveCwd ?? '无法确定'}</div>
            {(request.targetPaths?.length ?? 0) > 0 ? (
              <div className="mt-1 break-all" data-testid="permission-cross-project-targets">
                <span style={{ color: 'var(--text-tertiary)' }}>目标路径：</span>
                {request.targetPaths?.join('；')}
              </div>
            ) : null}
            <div className="mt-2" style={{ color: 'var(--text-tertiary)' }}>
              普通任务规则不会扩展到任意目录；授权只绑定当前任务和上面的外部目录根。
            </div>
          </div>
        )}

        <div className="mt-4 rounded-xl border p-3" style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-secondary)' }}>
          <div className="text-[11px] mb-1" style={{ color: 'var(--text-tertiary)' }}>目标 / 参数</div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs selectable" style={{ color: 'var(--text-primary)' }}>
            {conciseTarget(request.input)}
          </pre>
          <details className="mt-2 text-[11px]">
            <summary className="cursor-pointer" style={{ color: 'var(--text-tertiary)' }}>查看完整结构化输入</summary>
            <pre className="mt-2 overflow-auto whitespace-pre-wrap selectable">{JSON.stringify(request.input, null, 2)}</pre>
          </details>
        </div>

        {isBypassRequest ? (
          <p
            className="mt-3 rounded-lg border p-3 text-xs"
            style={{ color: 'var(--error)', borderColor: 'var(--error)', background: 'var(--warning-bg)' }}
            data-testid="bypass-permission-warning"
          >
            启用后，本次 Claude 运行的文件修改和命令将跳过逐项权限确认。该授权仅限本次运行，
            不会被记忆；请仅在你理解并接受全部风险时明确启用。
          </p>
        ) : request.risk === 'high' && (
          <p className="mt-3 text-xs" style={{ color: 'var(--warning)' }}>
            高风险命令不会被任务或项目规则记忆，每次都必须明确确认。
          </p>
        )}
        {!isBypassRequest && !canPersistForProject && request.projectRuleDisabledReason && (
          <p className="mt-3 text-xs" style={{ color: 'var(--text-tertiary)' }} data-testid="permission-project-rule-disabled-reason">
            无法创建项目规则：{request.projectRuleDisabledReason}
          </p>
        )}
        {!isBypassRequest && request.outsideProject && (
          <button
            type="button"
            data-testid="permission-switch-project"
            disabled={Boolean(submitting) || !onSwitchTargetProject}
            onClick={() => void switchTargetProject()}
            className="mt-3 w-full rounded-lg px-3 py-2 text-xs disabled:opacity-50"
            style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}
            title={onSwitchTargetProject
              ? '停止当前任务，切换项目后由新任务重新执行'
              : '实际工作目录尚未注册为 Workbench 项目'}
          >
            切换到目标项目并停止当前任务
          </button>
        )}
        {error && <p className="mt-3 text-xs" style={{ color: 'var(--error)' }}>{error}</p>}

        <div className={`mt-5 grid gap-2 ${isBypassRequest ? 'grid-cols-2' : 'grid-cols-2'}`}>
          {!isBypassRequest && (
            <button data-testid="permission-stop" disabled={Boolean(submitting)} onClick={() => void stop()} className="flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:opacity-50" style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}>
              <Square size={12} /> 停止任务
            </button>
          )}
          <button data-testid="permission-deny" disabled={Boolean(submitting)} onClick={() => void decide('deny')} className="flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:opacity-50" style={{ background: 'var(--bg-hover)', color: 'var(--error)' }}>
            <X size={13} /> 拒绝
          </button>
          <button
            data-testid={isBypassRequest ? 'bypass-permission-allow-once' : 'permission-allow-once'}
            disabled={Boolean(submitting)}
            onClick={() => void decide('allow_once')}
            className="flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:opacity-50"
            style={{
              background: isBypassRequest ? 'var(--error)' : 'var(--accent-light)',
              color: isBypassRequest ? 'white' : 'var(--accent)',
            }}
          >
            <Check size={13} /> {isBypassRequest ? '明确启用一次' : '允许一次'}
          </button>
          {canReuseForTask && (
            <button data-testid="permission-allow-task" disabled={Boolean(submitting)} onClick={() => void decide('allow_for_task')} className="flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:opacity-50" style={{ background: 'var(--accent)', color: 'var(--accent-text)' }} title={request.outsideProject ? '仅当前任务、当前项目和显示的外部目录根' : '仅当前任务、当前项目和相同风险类别'}>
              <Check size={13} /> {request.outsideProject ? '本任务允许访问该外部目录' : '本任务允许此类操作'}
            </button>
          )}
          {canPersistForProject && (
            <button data-testid="permission-allow-project" disabled={Boolean(submitting)} onClick={() => void decide('allow_for_project')} className="flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:opacity-50" style={{ background: 'var(--accent)', color: 'var(--accent-text)' }} title="以后在此项目中执行匹配规则时自动允许，可在项目设置中撤销">
              <Check size={13} /> 此项目始终允许此规则
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
