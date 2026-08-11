export interface SingleInstanceApp {
  requestSingleInstanceLock?: () => boolean;
  on(event: 'second-instance', listener: () => void): unknown;
  quit(): void;
}

export interface PrimaryWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export interface SingleInstanceGuardOptions {
  /** Allows lightweight Electron mocks to import the main entrypoint in unit tests. */
  allowMissingApi?: boolean;
}

export function focusPrimaryWindow(window: PrimaryWindow | null): void {
  if (!window || window.isDestroyed()) return;

  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/**
 * Acquires Electron's process-wide application lock before any services or IPC
 * handlers are initialized. A missing or throwing API fails closed outside the
 * explicitly opted-in unit-test compatibility path.
 */
export function installSingleInstanceGuard(
  application: SingleInstanceApp,
  getWindow: () => PrimaryWindow | null,
  options: SingleInstanceGuardOptions = {},
): boolean {
  const requestLock = application.requestSingleInstanceLock;
  if (typeof requestLock !== 'function') {
    if (options.allowMissingApi) return true;
    application.quit();
    return false;
  }

  let acquired = false;
  try {
    acquired = requestLock.call(application);
  } catch {
    application.quit();
    return false;
  }

  if (!acquired) {
    application.quit();
    return false;
  }

  application.on('second-instance', () => {
    focusPrimaryWindow(getWindow());
  });
  return true;
}
