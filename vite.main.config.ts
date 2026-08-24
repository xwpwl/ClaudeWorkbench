import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

const workspaceRoot = path.resolve(__dirname);
const expectedMetadataPath = path.join(
  workspaceRoot,
  'release-validation',
  'staging',
  'release-metadata.json',
);
const configuredMetadataPath = process.env.WORKBENCH_RELEASE_METADATA_PATH;
let releaseMetadataJson = 'null';

if (configuredMetadataPath) {
  const resolvedMetadataPath = path.resolve(configuredMetadataPath);
  if (resolvedMetadataPath !== expectedMetadataPath) {
    throw new Error('WORKBENCH_RELEASE_METADATA_PATH must name the fixed staging snapshot.');
  }
  releaseMetadataJson = fs.readFileSync(resolvedMetadataPath, 'utf8');
  JSON.parse(releaseMetadataJson);
}

export default defineConfig({
  define: {
    __WORKBENCH_RELEASE_METADATA_JSON__: JSON.stringify(releaseMetadataJson),
    __WORKBENCH_LOCAL_UPDATE_FIXTURE__: 'false',
  },
  build: {
    outDir: 'dist/main',
    emptyOutDir: true,
    lib: {
      entry: {
        index: path.resolve(__dirname, 'src/main/index.ts'),
        'permission-mcp': path.resolve(
          __dirname,
          'src/main/permissions/PermissionMcpHelper.ts',
        ),
      },
      formats: ['cjs'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: [
        /^node:/,
        'electron',
        'chokidar',
        'simple-git',
        'fs',
        'path',
        'os',
        'child_process',
        'events',
        'util',
        'crypto',
        'stream',
        'buffer',
        'url',
        'net',
        'http',
        'https',
        'zlib',
        'assert',
        'tty',
        'worker_threads',
        'readline',
        '@anthropic-ai/claude-agent-sdk',
        'better-sqlite3',
        'electron-updater',
      ],
    },
    minify: false,
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@main': path.resolve(__dirname, 'src/main'),
    },
  },
});
