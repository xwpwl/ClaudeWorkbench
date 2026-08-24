import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workspace = process.cwd();
const builderConfig = fs.readFileSync(path.join(workspace, 'electron-builder.yml'), 'utf8');
const mainSource = fs.readFileSync(path.join(workspace, 'src', 'main', 'index.ts'), 'utf8');
const installerIncludePath = path.join(workspace, 'build-resources', 'installer.nsh');
const packageJson = JSON.parse(
  fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'),
) as {
  version?: string;
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
};

const EXPECTED_INSTALLER_INCLUDE = [
  '!macro customWelcomePage',
  '  !define MUI_WELCOMEPAGE_TEXT "Claude Workbench 是独立第三方软件，与 Anthropic、OpenAI 及其关联公司不存在官方隶属、授权或背书关系。$\\r$\\n$\\r$\\n这是未签名的封闭 Beta 测试版本。"',
  '  !insertmacro MUI_PAGE_WELCOME',
  '!macroend',
  '',
].join('\n');

describe('Windows installer release contract', () => {
  it('preserves the bounded per-user x64 NSIS application identity and behavior', () => {
    expect(builderConfig).toMatch(/^appId: com\.claudeworkbench\.app$/mu);
    expect(builderConfig).toMatch(/^productName: Claude Workbench$/mu);
    expect(builderConfig).toMatch(
      /^\s{2}output: release-validation\/staging\/build-output$/mu,
    );
    expect(builderConfig).toMatch(/^electronDist: node_modules\/electron\/dist$/mu);
    expect(builderConfig).toMatch(/^asar: true$/mu);
    expect(builderConfig).toContain('node_modules/better-sqlite3/**/*');
    expect(builderConfig).toContain('node_modules/@anthropic-ai/claude-agent-sdk-*');
    expect(builderConfig).toMatch(/^npmRebuild: false$/mu);
    expect(builderConfig).toMatch(/^\s{4}- target: nsis$/mu);
    expect(builderConfig).toMatch(/^\s{8}- x64$/mu);
    expect(builderConfig).toMatch(/^\s{2}requestedExecutionLevel: asInvoker$/mu);
    expect(builderConfig).toMatch(/^\s{2}forceCodeSigning: false$/mu);
    expect(builderConfig).toMatch(/^\s{2}oneClick: false$/mu);
    expect(builderConfig).toMatch(/^\s{2}perMachine: false$/mu);
    expect(builderConfig).toMatch(/^\s{2}allowToChangeInstallationDirectory: true$/mu);
    expect(builderConfig).toMatch(/^\s{2}createDesktopShortcut: true$/mu);
    expect(builderConfig).toMatch(/^\s{2}createStartMenuShortcut: true$/mu);
    expect(builderConfig).toMatch(/^\s{2}deleteAppDataOnUninstall: false$/mu);
    expect(builderConfig).toMatch(/^\s{2}artifactName: ClaudeWorkbench Setup \$\{version\}\.\$\{ext\}$/mu);
    expect(packageJson.version).toBe('1.0.1-rc.1');
    expect(packageJson.main).toBe('dist/main/index.js');
    expect(packageJson.scripts?.dist).toBe(
      'node scripts/generate-app-update-config.mjs --verify && electron-builder',
    );
    expect(packageJson.scripts?.['dist:win']).toBe(
      'node scripts/generate-app-update-config.mjs --verify && electron-builder --win',
    );
    expect(packageJson.dependencies?.['electron-updater']).toBeTruthy();
  });

  it('keeps builder output repository-relative and controlled only by tracked configuration', () => {
    const configuredOutputs = [...builderConfig.matchAll(/^\s{2}output:\s*(\S+)\s*$/gmu)]
      .map((match) => match[1]);

    expect(builderConfig.match(/^directories:\s*$/gmu)).toHaveLength(1);
    expect(configuredOutputs).toEqual(['release-validation/staging/build-output']);
    expect(configuredOutputs).not.toContain('release');
    expect(path.posix.isAbsolute(configuredOutputs[0])).toBe(false);
    expect(path.win32.isAbsolute(configuredOutputs[0])).toBe(false);
    expect(configuredOutputs[0]).not.toMatch(/\$\{|%[^%]+%|\$env:|\\\\/u);
    expect(builderConfig).not.toMatch(/^\s*publish\s*:/mu);

    for (const scriptName of ['dist', 'dist:win']) {
      const script = packageJson.scripts?.[scriptName];
      expect(script).toBeTruthy();
      expect(script).not.toMatch(
        /(?:^|\s)-c(?:\s|=)|--config(?:\.|\s|=)|--publish(?:\s|=)|--(?:output|out|directories\.output)(?:\s|=)/u,
      );
    }
  });

  it('uses only tracked release assets and exact fixed extra-resource mappings', () => {
    expect(builderConfig).toMatch(/^\s{2}buildResources: build-resources$/mu);
    expect(builderConfig.match(/build-resources\/app-icon\.ico/gu)).toHaveLength(3);
    expect(builderConfig).not.toContain('installerHeaderIcon:');
    expect(builderConfig).toMatch(/^\s{2}include: build-resources\/installer\.nsh$/mu);
    expect(builderConfig).toMatch(/^files:\r?\n\s{2}- dist\/\*\*\/\*\r?\n\s{2}- '!dist\/\*\*\/\*\.map'\r?\n\s{2}- package\.json$/mu);
    expect(builderConfig).toMatch(
      /^extraResources:\r?\n\s{2}- from: build-resources\/app-icon\.png\r?\n\s{4}to: app-icon\.png\r?\n\s{2}- from: release-validation\/staging\/release-metadata\.json\r?\n\s{4}to: release-metadata\.json\r?\n\s{2}- from: build-resources\/app-update\.yml\r?\n\s{4}to: app-update\.yml$/mu,
    );

    expect(builderConfig).not.toMatch(
      /build\/icon|ClaudeWorkbench(?:-task15)?[\\/]|C:[\\/]|AppData[\\/]|Temp[\\/]|dist[\\/].*\.(?:ico|png|yml)|release[\\/].*\.(?:ico|png|yml)|fileAssociations|protocols|license:|publisherName:|^publish:/imu,
    );
  });

  it('ships one exact UTF-8 welcome disclosure without treating draft text as a license', () => {
    const bytes = fs.readFileSync(installerIncludePath);
    const include = bytes.toString('utf8');
    expect(Buffer.from(include, 'utf8')).toEqual(bytes);
    expect(include).not.toContain('\uFFFD');
    expect(include).toBe(EXPECTED_INSTALLER_INCLUDE);
    expect(builderConfig).not.toMatch(/^\s{2}license:/mu);
  });

  it('passes the fixed resolver result into BrowserWindow without a local absolute path', () => {
    expect(mainSource).toContain("import { resolveAppIconPath } from './release/AppIcon';");
    expect(mainSource).toMatch(/new BrowserWindow\(\{[\s\S]*?icon: resolveAppIconPath\(\{[\s\S]*?packaged: app\.isPackaged,[\s\S]*?resourcesPath: process\.resourcesPath,[\s\S]*?appPath: app\.getAppPath\(\),[\s\S]*?\}\),/u);
    expect(mainSource).not.toMatch(/icon:\s*['"](?:[A-Za-z]:[\\/]|\\\\)/u);
  });

  it('wires the main-owned cache preflight immediately before updater download access', () => {
    expect(mainSource).toContain('prepareDownloadCache: () => prepareUpdaterCacheRoot(');
    expect(mainSource).toMatch(/resolveElectronUpdaterBaseCachePath\(\{[\s\S]*?platform: process\.platform,[\s\S]*?localAppData: process\.env\.LOCALAPPDATA,[\s\S]*?xdgCacheHome: process\.env\.XDG_CACHE_HOME,[\s\S]*?homeDirectory: os\.homedir\(\),/u);
    expect(mainSource).not.toContain("app.getPath('cache')");
  });
});
