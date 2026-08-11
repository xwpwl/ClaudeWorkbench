import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { createNativeBypassConfirmation } from '../NativeBypassConfirmation';

const request = {
  auditId: 'audit-1',
  runId: 'run-1',
  risk: 'high' as const,
  projectId: 'project-1',
  projectPath: 'C:\\projects\\fixture',
  sessionId: 'session-1',
  taskId: 'task-1',
};

function owner(destroyed = false): BrowserWindow {
  return { isDestroyed: () => destroyed } as BrowserWindow;
}

describe('createNativeBypassConfirmation', () => {
  it('uses a warning modal with cancel as the default and allows only response zero', async () => {
    const window = owner();
    const nativeDialog = {
      showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
    };
    const confirm = createNativeBypassConfirmation(nativeDialog, () => window);

    await expect(confirm(request)).resolves.toBe(true);
    expect(nativeDialog.showMessageBox).toHaveBeenCalledWith(
      window,
      expect.objectContaining({
        type: 'warning',
        title: 'Claude Workbench Security Confirmation / 高风险权限确认',
        buttons: ['Enable once / 仅本次启用', 'Cancel / 取消'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      }),
    );
  });

  it('denies cancellation, missing owners, and destroyed owners', async () => {
    const nativeDialog = {
      showMessageBox: vi.fn(async () => ({ response: 1, checkboxChecked: false })),
    };

    await expect(createNativeBypassConfirmation(nativeDialog, () => owner())(request))
      .resolves.toBe(false);
    await expect(createNativeBypassConfirmation(nativeDialog, () => null)(request))
      .resolves.toBe(false);
    await expect(createNativeBypassConfirmation(nativeDialog, () => owner(true))(request))
      .resolves.toBe(false);
    expect(nativeDialog.showMessageBox).toHaveBeenCalledOnce();
  });

  it('propagates native dialog failures so PermissionAudit can deny and audit them', async () => {
    const nativeDialog = {
      showMessageBox: vi.fn(async () => {
        throw new Error('native dialog unavailable');
      }),
    };
    const confirm = createNativeBypassConfirmation(nativeDialog, () => owner());

    await expect(confirm(request)).rejects.toThrow('native dialog unavailable');
  });
});
