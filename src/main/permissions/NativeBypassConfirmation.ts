import type {
  BrowserWindow,
  MessageBoxOptions,
  MessageBoxReturnValue,
} from 'electron';
import type { BypassNativeConfirmationRequest } from './PermissionAudit';

export interface NativeBypassDialog {
  showMessageBox(
    owner: BrowserWindow,
    options: MessageBoxOptions,
  ): Promise<MessageBoxReturnValue>;
}

/**
 * Builds the trusted Electron confirmation boundary for bypassPermissions.
 * A missing window, window teardown, dialog dismissal, or dialog error can
 * never be interpreted as approval.
 */
export function createNativeBypassConfirmation(
  nativeDialog: NativeBypassDialog,
  getOwner: () => BrowserWindow | null,
): (request: BypassNativeConfirmationRequest) => Promise<boolean> {
  return async (request) => {
    const owner = getOwner();
    if (!owner || owner.isDestroyed()) return false;

    const result = await nativeDialog.showMessageBox(owner, {
      type: 'warning',
      title: 'Claude Workbench Security Confirmation / 高风险权限确认',
      message: '仅为本次任务启用绕过权限模式？',
      detail: [
        '该模式允许 Claude Code 跳过普通工具权限询问，并可能修改或删除项目文件。',
        `项目：${request.projectPath}`,
        `任务：${request.taskId}`,
        '请仅在你理解并接受风险时启用。',
      ].join('\n'),
      buttons: ['Enable once / 仅本次启用', 'Cancel / 取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    return result.response === 0;
  };
}
