import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workspace = process.cwd();
const builderConfig = fs.readFileSync(path.join(workspace, 'electron-builder.yml'), 'utf8');
const packageJson = JSON.parse(
  fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'),
) as {
  version?: string;
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
};

describe('Windows installer release contract', () => {
  it('uses the production application id', () => {
    expect(builderConfig).toMatch(/^appId: com\.claudeworkbench\.app$/mu);
  });

  it('uses the approved product name', () => {
    expect(builderConfig).toMatch(/^productName: Claude Workbench$/mu);
  });

  it('writes artifacts to the release directory', () => {
    expect(builderConfig).toMatch(/^\s{2}output: release$/mu);
  });

  it('loads icons from the build resources directory', () => {
    expect(builderConfig).toMatch(/^\s{2}buildResources: build$/mu);
  });

  it('packages only production bundles and package metadata', () => {
    expect(builderConfig).toMatch(/^files:\r?\n\s{2}- dist\/\*\*\/\*\r?\n\s{2}- package\.json$/mu);
  });

  it('uses the lockfile Electron distribution', () => {
    expect(builderConfig).toMatch(/^electronDist: node_modules\/electron\/dist$/mu);
  });

  it('packages application code in ASAR', () => {
    expect(builderConfig).toMatch(/^asar: true$/mu);
  });

  it('unpacks the native SQLite binding', () => {
    expect(builderConfig).toContain('node_modules/better-sqlite3/**/*');
  });

  it('unpacks the Claude Agent SDK executable', () => {
    expect(builderConfig).toContain('node_modules/@anthropic-ai/claude-agent-sdk-*');
  });

  it('does not perform an environment-dependent native rebuild', () => {
    expect(builderConfig).toMatch(/^npmRebuild: false$/mu);
  });

  it('builds an NSIS installer', () => {
    expect(builderConfig).toMatch(/^\s{4}- target: nsis$/mu);
  });

  it('targets 64-bit Windows', () => {
    expect(builderConfig).toMatch(/^\s{8}- x64$/mu);
  });

  it('runs without administrator elevation', () => {
    expect(builderConfig).toMatch(/^\s{2}requestedExecutionLevel: asInvoker$/mu);
  });

  it('uses the generated application icon', () => {
    expect(builderConfig.match(/build\/icon\.ico/gu)?.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps local release-candidate signing optional', () => {
    expect(builderConfig).toMatch(/^\s{2}forceCodeSigning: false$/mu);
  });

  it('uses an assisted installer', () => {
    expect(builderConfig).toMatch(/^\s{2}oneClick: false$/mu);
  });

  it('allows the user to select an installation directory', () => {
    expect(builderConfig).toMatch(/^\s{2}allowToChangeInstallationDirectory: true$/mu);
  });

  it('creates both desktop and Start menu shortcuts', () => {
    expect(builderConfig).toMatch(/^\s{2}createDesktopShortcut: true$/mu);
    expect(builderConfig).toMatch(/^\s{2}createStartMenuShortcut: true$/mu);
  });

  it('emits a versioned Setup executable', () => {
    expect(builderConfig).toMatch(/^\s{2}artifactName: ClaudeWorkbench Setup \$\{version\}\.\$\{ext\}$/mu);
    expect(packageJson.version).toBe('1.0.0');
  });

  it('exposes production packaging and optional update foundations', () => {
    expect(packageJson.main).toBe('dist/main/index.js');
    expect(packageJson.scripts?.['dist:win']).toContain('electron-builder --win');
    expect(packageJson.dependencies?.['electron-updater']).toBeTruthy();
  });
});
