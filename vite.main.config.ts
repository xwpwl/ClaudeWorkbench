import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
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
