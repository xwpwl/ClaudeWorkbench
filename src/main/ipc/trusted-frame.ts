import type { IpcMainInvokeEvent, WebContents } from 'electron';

export interface TrustedRendererIPCDependencies {
  getTrustedWebContents(): WebContents | null;
  getTrustedFrameUrl(): string | null;
}

export function assertTrustedMainFrame(
  event: IpcMainInvokeEvent,
  dependencies: TrustedRendererIPCDependencies,
  message = 'IPC requires the trusted main frame.',
): WebContents {
  const trusted = dependencies.getTrustedWebContents();
  const trustedFrameUrl = dependencies.getTrustedFrameUrl();
  const frame = event.senderFrame;
  if (
    !trusted
    || !trustedFrameUrl
    || trusted.isDestroyed()
    || event.sender.id !== trusted.id
    || !frame
    || frame !== trusted.mainFrame
    || frame.url !== trusted.getURL()
    || frame.url !== trustedFrameUrl
  ) {
    throw new Error(message);
  }
  return trusted;
}
