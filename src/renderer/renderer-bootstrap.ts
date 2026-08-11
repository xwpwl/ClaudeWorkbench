import { installMainWorldPublicApi } from './public-api-facade';

export interface RendererBootstrapControls {
  installApi(): unknown;
  loadAppRenderer(): Promise<{ renderApp(): void }>;
}

const DEFAULT_CONTROLS: RendererBootstrapControls = {
  installApi: () => installMainWorldPublicApi(),
  loadAppRenderer: () => import('./render-app'),
};

export async function bootstrapRenderer(
  controls: RendererBootstrapControls = DEFAULT_CONTROLS,
): Promise<void> {
  controls.installApi();
  const renderer = await controls.loadAppRenderer();
  renderer.renderApp();
}
