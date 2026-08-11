import { describe, expect, it, vi } from 'vitest';

type BootstrapModule = {
  bootstrapRenderer(controls: {
    installApi(): unknown;
    loadAppRenderer(): Promise<{ renderApp(): void }>;
  }): Promise<void>;
};

async function loadBootstrapModule(): Promise<BootstrapModule> {
  return await import('../renderer-bootstrap') as unknown as BootstrapModule;
}

describe('Renderer bootstrap ordering', () => {
  it('installs window.api before the App renderer module is evaluated', async () => {
    const { bootstrapRenderer } = await loadBootstrapModule();
    const order: string[] = [];
    const target: { api?: { locked: true } } = {};
    const renderApp = vi.fn(() => {
      expect(target.api).toStrictEqual({ locked: true });
      order.push('render');
    });

    await bootstrapRenderer({
      installApi: () => {
        order.push('install');
        Object.defineProperty(target, 'api', {
          configurable: false,
          enumerable: true,
          value: Object.freeze({ locked: true as const }),
          writable: false,
        });
        return target.api;
      },
      loadAppRenderer: async () => {
        expect(target.api).toStrictEqual({ locked: true });
        order.push('load');
        return { renderApp };
      },
    });

    expect(order).toStrictEqual(['install', 'load', 'render']);
    expect(renderApp).toHaveBeenCalledTimes(1);
  });

  it('does not evaluate or render App when API installation fails closed', async () => {
    const { bootstrapRenderer } = await loadBootstrapModule();
    const loadAppRenderer = vi.fn(async () => ({ renderApp: vi.fn() }));

    await expect(bootstrapRenderer({
      installApi: () => { throw new Error('fixed install failure'); },
      loadAppRenderer,
    })).rejects.toThrow('fixed install failure');
    expect(loadAppRenderer).not.toHaveBeenCalled();
  });
});
