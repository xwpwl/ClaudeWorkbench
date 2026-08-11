import { spawn } from 'child_process';
import { createServer } from 'vite';
import electron from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

async function main() {
  // Start Vite dev server for renderer
  const viteServer = await createServer({
    configFile: path.join(root, 'vite.renderer.config.ts'),
    server: { port: 5173 },
  });
  await viteServer.listen();
  const viteUrl = viteServer.resolvedUrls?.local[0] || 'http://localhost:5173';
  console.log(`Vite dev server running at ${viteUrl}`);

  // Build main process
  const { build } = await import('vite');
  await build({
    configFile: path.join(root, 'vite.main.config.ts'),
    mode: 'development',
  });

  // Build preload
  await build({
    configFile: path.join(root, 'vite.preload.config.ts'),
    mode: 'development',
  });

  // Start Electron
  const electronPath = electron.default || electron;
  const electronProc = spawn(electronPath, ['.'], {
    cwd: root,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: viteUrl,
      NODE_ENV: 'development',
    },
    stdio: 'inherit',
  });

  electronProc.on('close', () => {
    viteServer.close();
    process.exit(0);
  });

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    electronProc.kill();
    viteServer.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Dev server failed:', err);
  process.exit(1);
});
