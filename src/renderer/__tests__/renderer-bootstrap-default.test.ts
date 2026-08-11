import { beforeEach, describe, expect, it, vi } from 'vitest';

const bootstrapMocks = vi.hoisted(() => ({
  failInstall: false,
  order: [] as string[],
  renderApp: vi.fn(),
}));

vi.mock('../public-api-facade', () => ({
  installMainWorldPublicApi: () => {
    bootstrapMocks.order.push('install');
    if (bootstrapMocks.failInstall) throw new Error('fixed install failure');
    return Object.freeze({ fixed: true });
  },
}));

vi.mock('../render-app', () => {
  bootstrapMocks.order.push('load');
  return {
    renderApp: () => {
      bootstrapMocks.order.push('render');
      bootstrapMocks.renderApp();
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  bootstrapMocks.failInstall = false;
  bootstrapMocks.order.length = 0;
  bootstrapMocks.renderApp.mockReset();
});

describe('production Renderer bootstrap controls', () => {
  it('installs the Main-World facade before dynamically evaluating and rendering App', async () => {
    const { bootstrapRenderer } = await import('../renderer-bootstrap');

    await bootstrapRenderer();

    expect(bootstrapMocks.order).toStrictEqual(['install', 'load', 'render']);
    expect(bootstrapMocks.renderApp).toHaveBeenCalledTimes(1);
  });

  it('does not evaluate the App renderer when the production installer fails closed', async () => {
    bootstrapMocks.failInstall = true;
    const { bootstrapRenderer } = await import('../renderer-bootstrap');

    await expect(bootstrapRenderer()).rejects.toThrow('fixed install failure');

    expect(bootstrapMocks.order).toStrictEqual(['install']);
    expect(bootstrapMocks.renderApp).not.toHaveBeenCalled();
  });
});
