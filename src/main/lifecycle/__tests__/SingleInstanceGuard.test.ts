import { describe, expect, it, vi } from 'vitest';
import {
  focusPrimaryWindow,
  installSingleInstanceGuard,
  type PrimaryWindow,
  type SingleInstanceApp,
} from '../SingleInstanceGuard';

function createApp(requestSingleInstanceLock?: () => boolean): {
  app: SingleInstanceApp;
  on: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
} {
  const on = vi.fn();
  const quit = vi.fn();
  return {
    app: { requestSingleInstanceLock, on, quit },
    on,
    quit,
  };
}

function createWindow(overrides: Partial<PrimaryWindow> = {}): PrimaryWindow {
  return {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    ...overrides,
  };
}

describe('installSingleInstanceGuard', () => {
  it('quits without registering lifecycle work when another instance owns the lock', () => {
    const { app, on, quit } = createApp(() => false);

    expect(installSingleInstanceGuard(app, () => null)).toBe(false);
    expect(quit).toHaveBeenCalledOnce();
    expect(on).not.toHaveBeenCalled();
  });

  it('fails closed when the Electron lock API is missing', () => {
    const { app, on, quit } = createApp();

    expect(installSingleInstanceGuard(app, () => null)).toBe(false);
    expect(quit).toHaveBeenCalledOnce();
    expect(on).not.toHaveBeenCalled();
  });

  it('fails closed when acquiring the lock throws', () => {
    const { app, on, quit } = createApp(() => {
      throw new Error('lock unavailable');
    });

    expect(installSingleInstanceGuard(app, () => null)).toBe(false);
    expect(quit).toHaveBeenCalledOnce();
    expect(on).not.toHaveBeenCalled();
  });

  it('allows an explicitly configured missing API for lightweight unit-test mocks', () => {
    const { app, on, quit } = createApp();

    expect(installSingleInstanceGuard(app, () => null, { allowMissingApi: true })).toBe(true);
    expect(quit).not.toHaveBeenCalled();
    expect(on).not.toHaveBeenCalled();
  });

  it('registers a second-instance handler after acquiring the lock', () => {
    const { app, on, quit } = createApp(() => true);
    const window = createWindow({ isMinimized: vi.fn(() => true) });

    expect(installSingleInstanceGuard(app, () => window)).toBe(true);
    expect(quit).not.toHaveBeenCalled();
    expect(on).toHaveBeenCalledWith('second-instance', expect.any(Function));

    const handler = on.mock.calls[0]?.[1] as (() => void) | undefined;
    expect(handler).toBeTypeOf('function');
    handler?.();
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });
});

describe('focusPrimaryWindow', () => {
  it('does nothing when the primary window is unavailable or destroyed', () => {
    expect(() => focusPrimaryWindow(null)).not.toThrow();
    const destroyed = createWindow({ isDestroyed: vi.fn(() => true) });

    focusPrimaryWindow(destroyed);

    expect(destroyed.isMinimized).not.toHaveBeenCalled();
    expect(destroyed.restore).not.toHaveBeenCalled();
    expect(destroyed.show).not.toHaveBeenCalled();
    expect(destroyed.focus).not.toHaveBeenCalled();
  });

  it('shows and focuses a non-minimized primary window without restoring it', () => {
    const window = createWindow();

    focusPrimaryWindow(window);

    expect(window.restore).not.toHaveBeenCalled();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });
});
