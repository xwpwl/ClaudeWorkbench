import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isProxy } from 'node:util/types';

import { createReleaseMetadata } from '../lib/release-metadata.mjs';
import { createReleaseContext } from './lib/release-context.mjs';
import {
  loadReleaseToolchainPolicy,
  runTrustedWindowsCommand,
} from './lib/trusted-windows-runner.mjs';

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function deepFreezeExact(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const member of Object.values(value)) deepFreezeExact(member);
    Object.freeze(value);
  }
  return value;
}

function productionStat(value) {
  return {
    kind: value.isDirectory() ? 'directory' : value.isFile() ? 'file' : 'other',
    symbolicLink: value.isSymbolicLink(),
    dev: value.dev.toString(),
    ino: value.ino.toString(),
    size: value.size.toString(),
    mode: value.mode.toString(),
    mtimeNs: value.mtimeNs.toString(),
  };
}

const PRODUCTION_DEPS = deepFreezeExact({
  canonicalWorkspaceRoot: WORKSPACE_ROOT,
  isProxyObject: (value) => isProxy(value),
  pathJoin: (...members) => path.join(...members),
  pathBasename: (value) => path.basename(value),
  pathDirname: (value) => path.dirname(value),
  pathResolve: (...members) => path.resolve(...members),
  pathRelative: (from, to) => path.relative(from, to),
  pathToFileUrl: (value) => pathToFileURL(value).href,
  utf8Bytes: (value) => new TextEncoder().encode(value),
  utf8Text: (value) => new TextDecoder('utf-8', { fatal: true }).decode(value),
  sha256Bytes: (value) => createHash('sha256').update(value).digest('hex'),
  expectedPreLifecycleTree: {
    fileCount: 26863,
    totalBytes: 673636131,
    treeSha256: '075e9bc083e4e2010b46f97b31c5a07c8b4ee5dbbd825e572f2252c578f6e939',
  },
  expectedFinalTree: {
    fileCount: 26939,
    totalBytes: 973620188,
    treeSha256: '7cfa28860bfdce9c3ddc289b1aefcb84989eb84cb88585ac95021110a0349a39',
  },
  readPathStat: async (filePath) => productionStat(await fs.lstat(filePath, { bigint: true })),
  readRealPath: async (filePath) => await fs.realpath(filePath),
  readDirectoryNames: async (directory) => await fs.readdir(directory),
  makeDirectory: async (directory) => await fs.mkdir(directory),
  openPath: async (filePath, flags) => {
    const handle = await fs.open(filePath, flags);
    let closed = false;
    return deepFreezeExact({
      stat: async () => productionStat(await handle.stat({ bigint: true })),
      read: async () => {
        const observed = await handle.stat({ bigint: true });
        if (!observed.isFile() || observed.size > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error('Release file is too large or not ordinary.');
        }
        const bytes = Buffer.alloc(Number(observed.size));
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (bytesRead === 0) throw new Error('Release file read was incomplete.');
          offset += bytesRead;
        }
        return new Uint8Array(bytes);
      },
      write: async (bytes) => await handle.writeFile(bytes),
      sync: async () => await handle.sync(),
      close: async () => {
        if (closed) throw new Error('Release file handle was already closed.');
        closed = true;
        await handle.close();
      },
    });
  },
  renamePath: async (source, destination) => await fs.rename(source, destination),
  randomId: () => randomBytes(12).toString('hex'),
  importProtectedModule: async (specifier) => await import(specifier),
  readClockMs: () => Date.now(),
  readEnvironmentEntries: () => Object.entries(process.env),
  dependencyIdentity: () => PRODUCTION_DEPS,
  loadReleaseToolchainPolicy: async () => await loadReleaseToolchainPolicy(),
  runTrustedCommand: async (descriptorId) => await runTrustedWindowsCommand(descriptorId),
  createReleaseMetadataValue: async (input) => createReleaseMetadata(input),
  createReleaseContext: async (input) => createReleaseContext(input),
});

/* WORKBENCH_RELEASE_PREFLIGHT_CORE_V1_START */
function createPreflightCore(testDeps) {
  const EXPECTED_STAGE_IDS = Object.freeze([
    'npm-ci', 'typecheck', 'lint', 'test', 'build',
    'security-static-checks', 'icon-verify',
    'node-native-abi', 'electron-native-abi', 'release-invariants',
  ]);
  const EXPECTED_REQUIRED_CASES = Object.freeze([
    'migration', 'current-schema', 'future-schema', 'legacy-safety',
    'sentinel-redaction', 'diagnostics-bounds',
  ]);
  const EXPECTED_SECURITY_IDS = Object.freeze([
    'permissions-default-standard',
    'renderer-node-integration-disabled',
    'renderer-context-isolation-enabled',
    'renderer-sandbox-enabled',
    'single-instance-lock-enabled',
    'nsis-current-user',
    'code-signing-hook-prepared',
    'dangerous-git-mutations-absent',
  ]);
  const RELEASE_METADATA_KEYS = Object.freeze([
    'metadataSchemaVersion', 'purpose', 'productName', 'appId', 'version', 'channel',
    'buildId', 'branch', 'commitSha', 'commitShort', 'dirty', 'buildTimeUtc',
    'nodeVersion', 'npmVersion', 'electronVersion', 'sqliteSchemaVersion', 'platform',
    'arch', 'lockfileSha256', 'releaseNotesSha256',
  ]);
  const EXPECTED_UPDATE_CONTRACT = Object.freeze({
    schemaVersion: 1,
    provider: 'generic',
    url: 'https://updates.invalid/disabled/',
    updaterCacheDirName: 'claude-workbench-updater',
  });
  const EXPECTED_APP_UPDATE_YAML = 'provider: generic\nurl: https://updates.invalid/disabled/\nupdaterCacheDirName: claude-workbench-updater\n';
  const FIXED_GATE_PATHS = Object.freeze([
    'package.json',
    'package-lock.json',
    'docs/releases/1.0.1-rc.1.md',
    'src/shared/release-contract.json',
    'src/shared/update-bootstrap-contract.json',
    'scripts/release/release-toolchain.json',
    'scripts/release/lib/trusted-windows-runner.mjs',
    'scripts/generate-app-update-config.mjs',
    'scripts/generate-app-icons.mjs',
    'docs/legal/ASSET-NOTICES.md',
    'build-resources/app-update.yml',
    'build-resources/app-icon.svg',
    'build-resources/app-icon.png',
    'build-resources/app-icon.ico',
    'build-resources/installer.nsh',
    'electron-builder.yml',
    'vitest.config.ts',
    'vite.main.config.ts',
    'vite.preload.config.ts',
    'vite.renderer.config.ts',
    'eslint.config.mjs',
    'tsconfig.json',
    'tsconfig.node.json',
    'tests/typecheck/tsconfig.json',
  ]);
  const EXPECTED_FIXED_GATE_HASHES = Object.freeze({
    'package-lock.json': 'b6c5f49654f40045d4cff6612c004b67b4b2509cd2bd078a36ec185a11def4d3',
    'docs/releases/1.0.1-rc.1.md': 'bfa0a4dcd5dc22ab614265c4df89d199cd7ee488c64d55821fe087a7b8d414fc',
    'src/shared/release-contract.json': '1f2f933c02d7e9044b1d8589bace6a98f76bdcd7559811c33f3e433562101fa2',
    'src/shared/update-bootstrap-contract.json': '664e5635d5ba212bf0a780eda10a98e1a01588bf4ecfeced395b2e18d69a1f44',
    'scripts/release/release-toolchain.json': '7bc34cc85df605d895c51a01613fbb94ad7c328fed15bf1aeae6090d48d1fa17',
    'scripts/release/lib/trusted-windows-runner.mjs': '9bc7d0789fa581294d781d97035dadcd1f9b30876644674e91e15db14e0c2fd4',
    'scripts/generate-app-update-config.mjs': 'ae4421766bf24ec0b1ba23f97219eb2582b8aa29f6e711af94bc36277aadefb4',
    'scripts/generate-app-icons.mjs': '8ffa4aa293f85dfc5d78564e6817b5f675ec354fec0bb25c74f78aa23ecaeeaf',
    'docs/legal/ASSET-NOTICES.md': '87947993cd59c135080a06d0bfb31141b042f950a49e25e601c7098cc45aaa8a',
    'build-resources/app-update.yml': '883228a314cc013ea9d7e4f62f9859ff96c53fab0102318d13943f5562294cf4',
    'build-resources/app-icon.svg': '3d48d7bc072679da986e342f56b27bbbb7640fd64ccf31cf50e6c82ac0260107',
    'build-resources/app-icon.png': '6de378570f189a47d0850b38073d54ca16da0cde8ec35f231ecd0e7736015f45',
    'build-resources/app-icon.ico': 'dc967dc419c60b82d0d0d93ac4720eb4ada833587e54feb605f8115907fb7c84',
    'build-resources/installer.nsh': '63cea8762d24f0d8a0cf950ca9e9a7c24f62cd6b5ebd7ead57ac509427348b04',
    'electron-builder.yml': '65844860e3d54cee0a976ebfd5daf3d93d428e844084e09ab0bfad55e4a42209',
    'vitest.config.ts': 'c7e877b1573188ab25b04781da651eb4ad3674d0baf696d8b76313702a69ebff',
    'vite.main.config.ts': '9892468013514ca6e537351f5e34a6a4600a264d0730e90ff596e3d277e51d7b',
    'vite.preload.config.ts': '7121099745d5401a00200c2fe40162ebff9a4bfd97d7d808566f12cfed1f7b4d',
    'vite.renderer.config.ts': 'c7f243bde546d6a489b43ae34750bc592bfc7955c64ad72e981c9b201bfe7b9e',
    'eslint.config.mjs': '28c86477180fee94f4b601ddd9c2111ba3588c4ccc1a7a2f2f990fcf9a848f90',
    'tsconfig.json': 'c449d3ccd45ac70940025b1e921a419a36d8489baa227ac8294b57a782c02003',
    'tsconfig.node.json': '46228903de186a0607f04288399f7927ae65b4acae57ecfcefd450c474c5c45e',
    'tests/typecheck/tsconfig.json': '53877ce673543a223f9339257094391a955600f189fe9ca7bf8410a8498d3f5a',
  });
  const EXPECTED_PRE_TREE = testDeps.expectedPreLifecycleTree;
  const EXPECTED_FINAL_TREE = testDeps.expectedFinalTree;
  const EXPECTED_LIFECYCLE_ROWS = Object.freeze([
    Object.freeze({ descriptorId: 'lifecycle-electron-install', id: 'electron-install', packageName: 'electron', packageVersion: '35.7.5', workingDirectoryRelativePath: 'electron', entryRelativePath: 'electron/install.js', entrySha256: '3fa1166ed4db6831ed0d1aeec05295e460127d92b1216c794719e817eaefe0fb', arguments: Object.freeze([]) }),
    Object.freeze({ descriptorId: 'lifecycle-esbuild-install', id: 'esbuild-install', packageName: 'esbuild', packageVersion: '0.28.1', workingDirectoryRelativePath: 'esbuild', entryRelativePath: 'esbuild/install.js', entrySha256: '612294e278914443bdcf81cb17f54afec34dbdd2ebd999a6ee187912320cc315', arguments: Object.freeze([]) }),
    Object.freeze({ descriptorId: 'lifecycle-electron-winstaller', id: 'electron-winstaller-select-7z', packageName: 'electron-winstaller', packageVersion: '5.4.0', workingDirectoryRelativePath: 'electron-winstaller', entryRelativePath: 'electron-winstaller/script/select-7z-arch.js', entrySha256: '3819ea164df4ab1d23a6e3f8a551f2029974aead10422f929d2ad169ef3049f4', arguments: Object.freeze([]) }),
  ]);
  const EXPECTED_PACKAGE_ROWS = Object.freeze([
    Object.freeze({ name: 'electron', version: '35.7.5', lockIntegrity: 'sha512-dnL+JvLraKZl7iusXTVTGYs10TKfzUi30uEDTqsmTm0guN9V2tbOjTzyIZbh9n3ygUjgEYyo+igAwMRXIi3IPw==', rootRelativePath: 'node_modules/electron', treeSha256: '9eda212a301d09b8989e83732ef0240e1a5ac086a4b90f0831c97636e9dde459' }),
    Object.freeze({ name: 'electron-builder', version: '26.15.3', lockIntegrity: 'sha512-a1KM5heqS3gQCZzizXEI8RjJy3QVogULPdeSknt76uLDpBIW/HDGsMg/XgP0riP6PI9COsRvFITKKGDqA8fJxA==', rootRelativePath: 'node_modules/electron-builder', treeSha256: 'd38a29884694610279ade4f4bf1617df9e47da68b84675989bc36932e71d3f22' }),
    Object.freeze({ name: 'vitest', version: '3.2.7', lockIntegrity: 'sha512-KrxIJ62Fd89gfysR4WotlgZABiz2dqFPgqGzX7s+CwsqLFomRH7777ZcrOD6+WVAh7khPQP41A+BKbpcJFrdEg==', rootRelativePath: 'node_modules/vitest', treeSha256: 'fb8aa3d162a068e84f09b5a2cfcb1e59772067ff3a407932cb4958d049cd6046' }),
    Object.freeze({ name: 'typescript', version: '5.9.3', lockIntegrity: 'sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==', rootRelativePath: 'node_modules/typescript', treeSha256: '8b9422b44531353f953a937e4093215c5e90c051da5699f20e5c578799036584' }),
    Object.freeze({ name: 'eslint', version: '9.39.5', lockIntegrity: 'sha512-DgZS62aPLXKlnxILS/AYCoRvHaZeXceIzlXPkkGGzJWSow1aEk0lbTlxUSlyjC8jcaKxAdOnTDz+o1JFSBsyjw==', rootRelativePath: 'node_modules/eslint', treeSha256: 'ef8342aeedd83e6cc0acbae0a861126355510de8bcd7e297e4272974d6b55cbe' }),
    Object.freeze({ name: 'vite', version: '7.3.6', lockIntegrity: 'sha512-4XP60spRGjSZFf1qYH+dJIkK2znL3zQfl9KkOV9MkkRR/3Dls0dxaBsQPTloEc5BLXWPL9vsOxopxyKoMmDueg==', rootRelativePath: 'node_modules/vite', treeSha256: 'b59653125a14f0b7c9f70b402b4f36335df7856688212ee18f768aa3a97b4fd2' }),
    Object.freeze({ name: 'better-sqlite3', version: '13.0.2', lockIntegrity: 'sha512-jW6oufeDhXZaiX9Lw5A+oerVClx4iFrI6uDj1zu7SqUAjak9vbJvA0NEcKLNxHiQHb6kYCoFzzXYV0YOauhV3g==', rootRelativePath: 'node_modules/better-sqlite3', treeSha256: 'ed22ed6ad00b2ee638cae760bd05361e00c270adbf73f9972d8ead4f9a73b71d' }),
    Object.freeze({ name: 'zod', version: '4.4.3', lockIntegrity: 'sha512-ytENFjIJFl2UwYglde2jchW2Hwm4GJFLDiSXWdTrJQBIN9Fcyp7n4DhxJEiWNAJMV1/BqWfW/kkg71UDcHJyTQ==', rootRelativePath: 'node_modules/zod', treeSha256: '0c29c0a5070d1107ce01674d22d5c9b5b2e640bbdb2a681354dc799b4e8f5017' }),
    Object.freeze({ name: 'semver', version: '7.8.5', lockIntegrity: 'sha512-Y7/KDsb8LjooZpwaqGyulO6DQlksgCncchHGk+sZIY4SBvUocMBEFH5Ur1fI4dV+Jvl0w6cjvucaIi40puRioA==', rootRelativePath: 'node_modules/semver', treeSha256: '89fd78f66becbf372f2b782af8bf4bdbc77a76ac9b4454b59023466c113049f6' }),
    Object.freeze({ name: 'node-abi', version: '4.33.0', lockIntegrity: 'sha512-vLBWCKb+7LWsX+TbfzWOkw0W81m377tyx3hOweBTjO43CXZnRGS1/JPWs20fr0PgZyDXk6ROYrylsEycK8raDA==', rootRelativePath: 'node_modules/node-abi', treeSha256: '26cc3680ab464f985f1213bc14455456eb565ddb3cc9fd1fe5a1abcb9c6b5dc6' }),
  ]);
  const EXPECTED_PACKAGE_ENTRY_ROWS = Object.freeze([
    Object.freeze({ id: 'electron-executable', packageName: 'electron', relativePath: 'node_modules/electron/dist/electron.exe', fileSha256: '588bd82e36ad1acdae4615b6336284e420704389864f54ef2d10ea66c1a3cde0' }),
    Object.freeze({ id: 'electron-entry', packageName: 'electron', relativePath: 'node_modules/electron/index.js', fileSha256: '46a7d3a2da5d96cd693612e5c3ec407c38ac9c15c44f97ad2be478cbcf80b43c' }),
    Object.freeze({ id: 'electron-builder-cli', packageName: 'electron-builder', relativePath: 'node_modules/electron-builder/cli.js', fileSha256: 'b61356c9f3a890e6d1e523b15c431802d3edf4833bb625c5cedf1c8405ec1886' }),
    Object.freeze({ id: 'vitest-cli', packageName: 'vitest', relativePath: 'node_modules/vitest/vitest.mjs', fileSha256: '39db22f579acf5639bbb17a261408debbde03f4692c0c439e77e7f13aeba74d6' }),
    Object.freeze({ id: 'typescript-cli', packageName: 'typescript', relativePath: 'node_modules/typescript/bin/tsc', fileSha256: '8d5fa5bd883fec0979fc2004f1fe1d99aef40570155d550eadc0b03b55513bf0' }),
    Object.freeze({ id: 'eslint-cli', packageName: 'eslint', relativePath: 'node_modules/eslint/bin/eslint.js', fileSha256: '6280b95e2a6ab3b04be45cbd3b1627654be518e6a4da163ec0adcbba9cd5fcd8' }),
    Object.freeze({ id: 'vite-cli', packageName: 'vite', relativePath: 'node_modules/vite/bin/vite.js', fileSha256: 'fa03478846d229651a3c6aa64833ba2c6cbf580a798b92bd8f47c7480bafb5d8' }),
    Object.freeze({ id: 'better-sqlite3-win32-loader', packageName: 'better-sqlite3', relativePath: 'node_modules/better-sqlite3/lib/win32-x64.js', fileSha256: 'c25867a2e904a367743498377e6e156a653bd10bcc5f9be7cbdf8a28359012ef' }),
    Object.freeze({ id: 'better-sqlite3-prebuild', packageName: 'better-sqlite3', relativePath: 'node_modules/better-sqlite3/prebuilds/win32-x64.node', fileSha256: 'ecfb86221a674a6cdba63b1ac162b99386a61d0e38934b6c3dfcd9da11b6ee26' }),
    Object.freeze({ id: 'zod-entry', packageName: 'zod', relativePath: 'node_modules/zod/index.js', fileSha256: 'c733a1897d6b4b30dad6998597f6896b265b094a65534359ada34b08ecf8932c' }),
    Object.freeze({ id: 'semver-entry', packageName: 'semver', relativePath: 'node_modules/semver/index.js', fileSha256: '4b3e57d3d40e29e0706002eba113d09f35aea593578376bbeec83b777b9912ab' }),
    Object.freeze({ id: 'node-abi-entry', packageName: 'node-abi', relativePath: 'node_modules/node-abi/index.js', fileSha256: '9ca655944bbb3bcd347523770f9c0109823e61959c76e5ec860d93ded5251c37' }),
  ]);
  const WORKSPACE_ENTRY_PATHS = Object.freeze([
    Object.freeze(['preflight', 'scripts/release/preflight.mjs']),
    Object.freeze(['native-abi-probe', 'scripts/release/native-abi-probe.mjs']),
    Object.freeze(['vitest-preflight-reporter', 'scripts/release/vitest-preflight-reporter.mjs']),
    Object.freeze(['trusted-windows-runner', 'scripts/release/lib/trusted-windows-runner.mjs']),
    Object.freeze(['release-toolchain-policy', 'scripts/release/release-toolchain.json']),
    Object.freeze(['release-metadata', 'scripts/lib/release-metadata.mjs']),
    Object.freeze(['release-context', 'scripts/release/lib/release-context.mjs']),
    Object.freeze(['release-common', 'scripts/release/lib/common.mjs']),
    Object.freeze(['report-schema', 'scripts/release/lib/report-schema.mjs']),
    Object.freeze(['security-checklist', 'scripts/release/lib/security-checklist.mjs']),
    Object.freeze(['icon-generator', 'scripts/generate-app-icons.mjs']),
    Object.freeze(['package-manifest', 'package.json']),
    Object.freeze(['vitest-config', 'vitest.config.ts']),
    Object.freeze(['vite-main-config', 'vite.main.config.ts']),
    Object.freeze(['vite-preload-config', 'vite.preload.config.ts']),
    Object.freeze(['vite-renderer-config', 'vite.renderer.config.ts']),
    Object.freeze(['electron-builder-config', 'electron-builder.yml']),
    Object.freeze(['eslint-config', 'eslint.config.mjs']),
    Object.freeze(['tsconfig', 'tsconfig.json']),
    Object.freeze(['tsconfig-node', 'tsconfig.node.json']),
    Object.freeze(['tsconfig-ipc', 'tests/typecheck/tsconfig.json']),
    Object.freeze(['migration-test', 'src/main/database/__tests__/Migration.test.ts']),
    Object.freeze(['release-migration-test', 'src/main/database/__tests__/ReleaseMigration.test.ts']),
    Object.freeze(['legacy-safety-test', 'src/main/database/__tests__/DatabaseLegacySafety.test.ts']),
    Object.freeze(['diagnostics-release-test', 'src/main/diagnostics/__tests__/DiagnosticsExporter.release.test.ts']),
  ]);
  const EXPECTED_WORKSPACE_ENTRY_HASHES = Object.freeze({
    'vitest-preflight-reporter': '3ac428e56102490c10db9f46670941056cf22192d8ae3b672916eff583b7e126',
    'trusted-windows-runner': '9bc7d0789fa581294d781d97035dadcd1f9b30876644674e91e15db14e0c2fd4',
    'release-toolchain-policy': '7bc34cc85df605d895c51a01613fbb94ad7c328fed15bf1aeae6090d48d1fa17',
    'release-metadata': '4179fc0f9afd34b2a92c501a8d9116ed57453b3e912b48f1f5f9ce754ab4b332',
    'release-context': '7dc114be1619e3efbc56318ce79fad3f1e4ac7d1d487cb9a32372f49294f65e6',
    'release-common': 'f9e36d0dd5c40ef63c4a0b9ce5e2e8b49f973b3155bb4f54e06fc905971bc3a6',
    'report-schema': '50f15058d26e800e906dbfdf5dc1d2d40fc1866823b103c8d049afb3ce8a2c86',
    'security-checklist': '12926e49e979351480e9cb69e9848649d0220cdecdc85b28b75e84260f2eb6d4',
    'icon-generator': '8ffa4aa293f85dfc5d78564e6817b5f675ec354fec0bb25c74f78aa23ecaeeaf',
    'vitest-config': 'c7e877b1573188ab25b04781da651eb4ad3674d0baf696d8b76313702a69ebff',
    'vite-main-config': '9892468013514ca6e537351f5e34a6a4600a264d0730e90ff596e3d277e51d7b',
    'vite-preload-config': '7121099745d5401a00200c2fe40162ebff9a4bfd97d7d808566f12cfed1f7b4d',
    'vite-renderer-config': 'c7f243bde546d6a489b43ae34750bc592bfc7955c64ad72e981c9b201bfe7b9e',
    'electron-builder-config': '65844860e3d54cee0a976ebfd5daf3d93d428e844084e09ab0bfad55e4a42209',
    'eslint-config': '28c86477180fee94f4b601ddd9c2111ba3588c4ccc1a7a2f2f990fcf9a848f90',
    tsconfig: 'c449d3ccd45ac70940025b1e921a419a36d8489baa227ac8294b57a782c02003',
    'tsconfig-node': '46228903de186a0607f04288399f7927ae65b4acae57ecfcefd450c474c5c45e',
    'tsconfig-ipc': '53877ce673543a223f9339257094391a955600f189fe9ca7bf8410a8498d3f5a',
    'migration-test': 'baf022cb1ce58260ab0df9c1b4953983d4ec11ff50aa354ca6091aeee266f044',
    'release-migration-test': '110ca299ea8127de28ee59f158268675b14498478158380b1a34c96a1882575e',
    'legacy-safety-test': 'a2b8bd14a03a8ae0970e38054a537fc617baa974145a8b31debb2bfba6935c44',
    'diagnostics-release-test': 'df8cac70fa82724077872e35674632eb53a3157e0a3be316fa2c6123d08fb4af',
    'native-abi-probe': '51cd178b4c63f7710dde4623e939ff7baf450c62282d34c0f7a4cf1b0e13dd87',
  });
  const tokens = new WeakMap();
  const factOwners = new WeakMap();
  const contextOwners = new WeakSet();
  const contextBindings = new WeakMap();

  function freezeDeep(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const member of Object.values(value)) freezeDeep(member);
      Object.freeze(value);
    }
    return value;
  }

  function exactOrdinaryObject(value, keys, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || testDeps.isProxyObject(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError(`${label} must be an ordinary plain object.`);
    }
    const observed = Reflect.ownKeys(value);
    if (observed.length !== keys.length || observed.some((key) => typeof key !== 'string' || !keys.includes(key))) {
      throw new TypeError(`${label} contains unexpected or missing fields.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`${label} requires enumerable data fields.`);
      }
    }
    return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  }

  function rejectDuplicateJsonKeys(text) {
    let offset = 0;
    const skipWhitespace = () => { while (/\s/u.test(text[offset] ?? '')) offset += 1; };
    const readString = () => {
      const start = offset;
      offset += 1;
      while (offset < text.length) {
        if (text[offset] === '\\') offset += 2;
        else if (text[offset++] === '"') return JSON.parse(text.slice(start, offset));
      }
      throw new Error('invalid JSON');
    };
    const readValue = () => {
      skipWhitespace();
      if (text[offset] === '"') { readString(); return; }
      if (text[offset] === '{') {
        offset += 1;
        skipWhitespace();
        const keys = new Set();
        if (text[offset] === '}') { offset += 1; return; }
        for (;;) {
          skipWhitespace();
          if (text[offset] !== '"') throw new Error('invalid JSON');
          const key = readString();
          if (keys.has(key)) throw new Error('duplicate JSON key');
          keys.add(key);
          skipWhitespace();
          if (text[offset++] !== ':') throw new Error('invalid JSON');
          readValue();
          skipWhitespace();
          const delimiter = text[offset++];
          if (delimiter === '}') return;
          if (delimiter !== ',') throw new Error('invalid JSON');
        }
      }
      if (text[offset] === '[') {
        offset += 1;
        skipWhitespace();
        if (text[offset] === ']') { offset += 1; return; }
        for (;;) {
          readValue();
          skipWhitespace();
          const delimiter = text[offset++];
          if (delimiter === ']') return;
          if (delimiter !== ',') throw new Error('invalid JSON');
        }
      }
      const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(text.slice(offset));
      if (!primitive) throw new Error('invalid JSON');
      offset += primitive[0].length;
    };
    readValue();
    skipWhitespace();
    if (offset !== text.length) throw new Error('invalid JSON');
  }

  function parseStrictJsonObject(bytes, label) {
    try {
      if (!bytes || typeof bytes.length !== 'number'
        || (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) throw new Error('invalid JSON');
      const text = testDeps.utf8Text(bytes);
      if (text.charCodeAt(0) === 0xfeff) throw new Error('invalid JSON');
      rejectDuplicateJsonKeys(text);
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('invalid JSON');
      return value;
    } catch {
      throw new Error(`${label} is invalid.`);
    }
  }

  function validateReleaseMetadata(value, releaseFacts = null) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || testDeps.isProxyObject(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error('Published metadata schema is invalid.');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== RELEASE_METADATA_KEYS.length
      || keys.some((key, index) => key !== RELEASE_METADATA_KEYS[index])) {
      throw new Error('Published metadata fields are invalid.');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of RELEASE_METADATA_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new Error('Published metadata fields are invalid.');
      }
    }
    const metadata = Object.fromEntries(RELEASE_METADATA_KEYS.map((key) => [key, descriptors[key].value]));
    if (metadata.metadataSchemaVersion !== 1
      || metadata.purpose !== 'candidate'
      || metadata.productName !== 'Claude Workbench'
      || metadata.appId !== 'com.claudeworkbench.app'
      || metadata.version !== '1.0.1-rc.1'
      || metadata.channel !== 'rc'
      || metadata.branch !== 'task15'
      || metadata.dirty !== false
      || metadata.sqliteSchemaVersion !== 7
      || metadata.platform !== 'win32'
      || metadata.arch !== 'x64') {
      throw new Error('Published metadata candidate facts are invalid.');
    }
    if (typeof metadata.commitSha !== 'string' || !/^[a-f0-9]{40,64}$/u.test(metadata.commitSha)
      || metadata.commitShort !== metadata.commitSha.slice(0, 12)) {
      throw new Error('Published metadata commit is invalid.');
    }
    if (typeof metadata.buildTimeUtc !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(metadata.buildTimeUtc)) {
      throw new Error('Published metadata time is not canonical.');
    }
    const time = Date.parse(metadata.buildTimeUtc);
    if (!Number.isFinite(time)
      || new Date(time).toISOString().replace('.000Z', 'Z') !== metadata.buildTimeUtc
      || Math.floor(time / 1_000) < 946_684_800) {
      throw new Error('Published metadata time is invalid.');
    }
    const buildStamp = metadata.buildTimeUtc.replace(/[-:]/gu, '');
    if (metadata.buildId !== `${metadata.version}+${metadata.commitShort}.${buildStamp}`) {
      throw new Error('Published metadata Build ID is invalid.');
    }
    if (typeof metadata.nodeVersion !== 'string'
      || !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(metadata.nodeVersion)
      || typeof metadata.npmVersion !== 'string'
      || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(metadata.npmVersion)
      || typeof metadata.electronVersion !== 'string'
      || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(metadata.electronVersion)) {
      throw new Error('Published metadata toolchain is invalid.');
    }
    if (typeof metadata.lockfileSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(metadata.lockfileSha256)
      || typeof metadata.releaseNotesSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(metadata.releaseNotesSha256)) {
      throw new Error('Published metadata hashes are invalid.');
    }
    if (releaseFacts !== null) {
      if (metadata.branch !== releaseFacts.branch || metadata.dirty !== releaseFacts.dirty
        || metadata.commitSha !== releaseFacts.commitSha
        || Math.floor(time / 1_000) !== releaseFacts.sourceDateEpoch
        || metadata.lockfileSha256 !== releaseFacts.packageLockSha256
        || metadata.releaseNotesSha256 !== releaseFacts.releaseNotesSha256
        || metadata.nodeVersion !== releaseFacts.toolchain.nodeVersion
        || metadata.npmVersion !== releaseFacts.toolchain.npmVersion
        || metadata.electronVersion !== releaseFacts.toolchain.electronVersion
        || metadata.platform !== releaseFacts.toolchain.platform
        || metadata.arch !== releaseFacts.toolchain.arch) {
        throw new Error('Published metadata drifts from release facts.');
      }
    }
    return metadata;
  }

  function sameWorkspace(value) {
    return typeof value === 'string' && value === testDeps.canonicalWorkspaceRoot;
  }

  function assertWorkspace(value) {
    if (!sameWorkspace(value)) throw new Error('Release workspace identity is invalid.');
  }

  function sameStat(left, right) {
    return left.kind === right.kind && left.dev === right.dev && left.ino === right.ino
      && left.size === right.size && left.mode === right.mode && left.mtimeNs === right.mtimeNs;
  }

  function sameDirectoryIdentity(left, right) {
    return left && right && left.kind === 'directory' && right.kind === 'directory'
      && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
  }

  async function stableStat(filePath, kind) {
    const before = await testDeps.readPathStat(filePath);
    if (before.kind !== kind || before.symbolicLink) throw new Error('Release path is not an ordinary fixed path.');
    const real = await testDeps.readRealPath(filePath);
    if (testDeps.pathResolve(real).toLowerCase() !== testDeps.pathResolve(filePath).toLowerCase()) {
      throw new Error('Release path traverses a reparse point.');
    }
    const after = await testDeps.readPathStat(filePath);
    if (!sameStat(before, after)) throw new Error('Release path identity changed.');
    return after;
  }

  async function exactChildName(parent, expected) {
    const matches = (await testDeps.readDirectoryNames(parent))
      .filter((name) => name.toLowerCase() === expected.toLowerCase());
    if (matches.length > 1 || (matches.length === 1 && matches[0] !== expected)) {
      throw new Error('Release path has a casefold ambiguity.');
    }
    return matches.length === 1;
  }

  async function initializeReleaseDirectoriesCore(workspaceRoot) {
    const segments = ['release-validation', 'reports', 'staging'];
    await stableStat(workspaceRoot, 'directory');
    const releaseRoot = testDeps.pathJoin(workspaceRoot, segments[0]);
    if (!(await exactChildName(workspaceRoot, segments[0]))) await testDeps.makeDirectory(releaseRoot);
    await stableStat(releaseRoot, 'directory');
    for (const name of segments.slice(1)) {
      const child = testDeps.pathJoin(releaseRoot, name);
      if (!(await exactChildName(releaseRoot, name))) await testDeps.makeDirectory(child);
      await stableStat(child, 'directory');
    }
    const held = [];
    for (const directory of [workspaceRoot, releaseRoot, testDeps.pathJoin(releaseRoot, 'reports'), testDeps.pathJoin(releaseRoot, 'staging')]) {
      const handle = await testDeps.openPath(directory, 'r');
      try {
        const observed = await handle.stat();
        const expected = await stableStat(directory, 'directory');
        if (!sameStat(observed, expected)) throw new Error('Held release directory identity changed.');
      } finally {
        await handle.close();
      }
      held.push(directory);
    }
    return freezeDeep({ directories: held });
  }

  async function initializeReleaseDirectories(input) {
    const { workspaceRoot } = exactOrdinaryObject(input, ['workspaceRoot'], 'Release directory input');
    assertWorkspace(workspaceRoot);
    return await initializeReleaseDirectoriesCore(workspaceRoot);
  }

  async function optionalFile(filePath) {
    try { return await stableStat(filePath, 'file'); } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function stableRead(filePath) {
    const pathBefore = await stableStat(filePath, 'file');
    const handle = await testDeps.openPath(filePath, 'r');
    try {
      const heldBefore = await handle.stat();
      if (!sameStat(pathBefore, heldBefore)) throw new Error('Release file changed while opening.');
      const bytes = await handle.read();
      const heldAfter = await handle.stat();
      const pathAfter = await stableStat(filePath, 'file');
      if (!sameStat(heldBefore, heldAfter) || !sameStat(heldAfter, pathAfter)) throw new Error('Release file changed while reading.');
      return { bytes, state: heldAfter };
    } finally {
      await handle.close();
    }
  }

  async function canonicalPath(workspaceRoot, relativePath, kind = 'file') {
    const members = relativePath.split('/');
    let parent = workspaceRoot;
    for (const member of members) {
      if (!await exactChildName(parent, member)) throw new Error('Release path canonical case is invalid.');
      parent = testDeps.pathJoin(parent, member);
    }
    await stableStat(parent, kind);
    return parent;
  }

  async function scanCanonicalTree(root) {
    await stableStat(root, 'directory');
    const rows = [];
    const pending = [{ absolute: root, relative: '' }];
    while (pending.length !== 0) {
      const current = pending.pop();
      const names = await testDeps.readDirectoryNames(current.absolute);
      if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) throw new Error('Release tree enumeration is invalid.');
      if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) throw new Error('Release tree has a casefold ambiguity.');
      names.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      for (let index = names.length - 1; index >= 0; index -= 1) {
        const name = names[index];
        const absolute = testDeps.pathJoin(current.absolute, name);
        const relativePath = current.relative === '' ? name : `${current.relative}/${name}`;
        const state = await testDeps.readPathStat(absolute);
        if (state.symbolicLink || (state.kind !== 'directory' && state.kind !== 'file')) throw new Error('Release tree contains a reparse or special member.');
        if (state.kind === 'directory') {
          await stableStat(absolute, 'directory');
          pending.push({ absolute, relative: relativePath });
        } else {
          const loaded = await stableRead(absolute);
          rows.push({ relativePath, size: Number(loaded.state.size), fileSha256: testDeps.sha256Bytes(loaded.bytes) });
        }
      }
    }
    rows.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
    const bytes = `${JSON.stringify(rows)}\n`;
    return freezeDeep({
      rows,
      fileCount: rows.length,
      totalBytes: rows.reduce((total, row) => total + row.size, 0),
      treeSha256: testDeps.sha256Bytes(testDeps.utf8Bytes(bytes)),
    });
  }

  async function acquireDirectoryLease(workspaceRoot, relativePaths) {
    const held = [];
    try {
      for (const relativePath of relativePaths) {
        const absolute = relativePath === '' ? workspaceRoot : await canonicalPath(workspaceRoot, relativePath, 'directory');
        const expected = await stableStat(absolute, 'directory');
        const handle = await testDeps.openPath(absolute, 'r');
        try {
          const observed = await handle.stat();
          if (!sameDirectoryIdentity(expected, observed)) throw new Error('Release directory changed while leasing.');
          held.push({ absolute, expected, handle, kind: 'directory' });
        } catch (error) {
          try { await handle.close(); } catch { }
          throw error;
        }
      }
      let closed = false;
      const recheck = async () => {
        if (closed) throw new Error('Release directory lease is closed.');
        for (const item of held) {
          const handleState = await item.handle.stat();
          const pathState = await stableStat(item.absolute, item.kind);
          if (!sameDirectoryIdentity(item.expected, handleState)
            || !sameDirectoryIdentity(handleState, pathState)) {
            throw new Error('Release directory lease drifted.');
          }
        }
      };
      return freezeDeep({
        held,
        recheck,
        close: async () => {
          if (closed) throw new Error('Release directory lease was already closed.');
          let failure = null;
          try { await recheck(); } catch (error) { failure = error; }
          closed = true;
          for (const item of [...held].reverse()) {
            try { await item.handle.close(); } catch (error) { failure ??= error; }
          }
          if (failure) throw failure;
        },
      });
    } catch (error) {
      for (const item of [...held].reverse()) { try { await item.handle.close(); } catch { } }
      throw error;
    }
  }

  async function holdStableFile(workspaceRoot, relativePath, held) {
    const absolute = await canonicalPath(workspaceRoot, relativePath, 'file');
    const before = await stableStat(absolute, 'file');
    const handle = await testDeps.openPath(absolute, 'r');
    try {
      const opened = await handle.stat();
      if (!sameStat(before, opened)) throw new Error('Release binding changed while opening.');
      const bytes = await handle.read();
      const after = await handle.stat();
      if (!sameStat(opened, after)) throw new Error('Release binding changed while reading.');
      const entry = { absolute, relativePath, expected: after, sha256: testDeps.sha256Bytes(bytes), bytes, handle, kind: 'file' };
      held.push(entry);
      return entry;
    } catch (error) {
      try { await handle.close(); } catch { }
      throw error;
    }
  }

  async function closeHeldFiles(held) {
    let failure = null;
    for (const item of held) {
      try {
        const handleState = await item.handle.stat();
        const pathState = await stableStat(item.absolute, item.kind);
        const bytes = await item.handle.read();
        if (!sameStat(item.expected, handleState) || !sameStat(handleState, pathState)
          || testDeps.sha256Bytes(bytes) !== item.sha256) throw new Error(`Release binding lease drifted (${item.relativePath}).`);
      } catch (error) { failure ??= error; }
    }
    for (const item of [...held].reverse()) {
      try { await item.handle.close(); } catch (error) { failure ??= error; }
    }
    held.length = 0;
    if (failure) throw failure;
  }

  async function recheckHeldFiles(held) {
    for (const item of held) {
      const handleState = await item.handle.stat();
      const pathState = await stableStat(item.absolute, item.kind);
      const bytes = await item.handle.read();
      if (!sameStat(item.expected, handleState) || !sameStat(handleState, pathState)
        || testDeps.sha256Bytes(bytes) !== item.sha256) throw new Error('Release binding lease drifted.');
    }
  }

  async function quarantinePreflightEvidenceCore(workspaceRoot, retainDirectoryLease = false) {
    await initializeReleaseDirectoriesCore(workspaceRoot);
    const reports = testDeps.pathJoin(workspaceRoot, 'release-validation', 'reports');
    const canonical = testDeps.pathJoin(reports, 'preflight.json');
    const directoryLease = await acquireDirectoryLease(workspaceRoot, ['', 'release-validation', 'release-validation/reports', 'release-validation/staging']);
    const sourceHeld = [];
    const siblingHeld = [];
    let keepLease = false;
    let primary = null;
    try {
      const recheckCanonicalAbsence = async () => {
        await directoryLease.recheck();
        if ((await optionalFile(canonical)) !== null) throw new Error('Canonical report appeared during bootstrap.');
        await directoryLease.recheck();
      };
      await directoryLease.recheck();
      if ((await optionalFile(canonical)) === null) {
        await directoryLease.recheck();
        if ((await optionalFile(canonical)) !== null) throw new Error('Canonical report appeared during quarantine.');
        const evidence = freezeDeep({ quarantinedRelativePath: null, sha256: null });
        keepLease = retainDirectoryLease;
        return retainDirectoryLease ? freezeDeep({ evidence, directoryLease, recheckCanonicalAbsence }) : evidence;
      }
      const source = await holdStableFile(workspaceRoot, 'release-validation/reports/preflight.json', sourceHeld);
      const siblingName = `preflight.stale.${testDeps.randomId()}.json`;
      if (!/^[a-f0-9]{24}$/u.test(siblingName.slice(16, -5))) throw new Error('Quarantine sibling identity is invalid.');
      const siblingRelativePath = `release-validation/reports/${siblingName}`;
      const sibling = testDeps.pathJoin(reports, siblingName);
      if ((await optionalFile(sibling)) !== null) throw new Error('Quarantine sibling collision.');
      await directoryLease.recheck();
      await recheckHeldFiles(sourceHeld);
      if ((await optionalFile(sibling)) !== null) throw new Error('Quarantine sibling collision.');
      await directoryLease.recheck();
      await testDeps.renamePath(canonical, sibling);
      if ((await optionalFile(canonical)) !== null) throw new Error('Canonical report remained after quarantine.');
      const destination = await holdStableFile(workspaceRoot, siblingRelativePath, siblingHeld);
      const sourceState = await source.handle.stat();
      const sourceBytes = await source.handle.read();
      if (!sameStat(source.expected, sourceState) || !sameStat(sourceState, destination.expected)
        || testDeps.sha256Bytes(sourceBytes) !== source.sha256 || destination.sha256 !== source.sha256) {
        throw new Error('Quarantined report identity changed.');
      }
      await directoryLease.recheck();
      if ((await optionalFile(canonical)) !== null) throw new Error('Canonical report reappeared during quarantine.');
      await recheckHeldFiles(siblingHeld);
      await directoryLease.recheck();
      const evidence = freezeDeep({ quarantinedRelativePath: siblingRelativePath, sha256: source.sha256 });
      keepLease = retainDirectoryLease;
      return retainDirectoryLease ? freezeDeep({ evidence, directoryLease, recheckCanonicalAbsence }) : evidence;
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      let cleanup = null;
      for (const item of sourceHeld.splice(0)) {
        try {
          const state = await item.handle.stat();
          const bytes = await item.handle.read();
          if (!sameStat(item.expected, state) || testDeps.sha256Bytes(bytes) !== item.sha256) throw new Error('Quarantine source lease drifted.');
        } catch (error) { cleanup ??= error; }
        try { await item.handle.close(); } catch (error) { cleanup ??= error; }
      }
      try { await closeHeldFiles(siblingHeld); } catch (error) { cleanup ??= error; }
      if (!keepLease || cleanup) {
        try { await directoryLease.close(); } catch (error) { cleanup ??= error; }
      }
      if (!primary && cleanup) throw cleanup;
    }
  }

  async function quarantinePreflightEvidence(input) {
    const { workspaceRoot } = exactOrdinaryObject(input, ['workspaceRoot'], 'Quarantine input');
    assertWorkspace(workspaceRoot);
    return await quarantinePreflightEvidenceCore(workspaceRoot);
  }

  async function exclusivePublish({ workspaceRoot, directorySegments, fileName, bytes, validatePublished = null }) {
    const directory = testDeps.pathJoin(workspaceRoot, ...directorySegments);
    const directoryPaths = [''];
    for (let index = 1; index <= directorySegments.length; index += 1) {
      directoryPaths.push(directorySegments.slice(0, index).join('/'));
    }
    const directoryLease = await acquireDirectoryLease(workspaceRoot, directoryPaths);
    const destination = testDeps.pathJoin(directory, fileName);
    const temporary = testDeps.pathJoin(directory, `.${fileName}.${testDeps.randomId()}.tmp`);
    const destinationHeld = [];
    let handle = null;
    let primary = null;
    const expectedSha256 = testDeps.sha256Bytes(bytes);
    try {
      await directoryLease.recheck();
      if ((await optionalFile(destination)) !== null) throw new Error('Release destination already exists.');
      handle = await testDeps.openPath(temporary, 'wx+');
      await handle.write(bytes);
      await handle.sync();
      const tempState = await handle.stat();
      const tempBytes = await handle.read();
      const tempPathState = await stableStat(temporary, 'file');
      if (tempState.kind !== 'file' || Number(tempState.size) !== bytes.length
        || !sameStat(tempState, tempPathState) || testDeps.sha256Bytes(tempBytes) !== expectedSha256) {
        throw new Error('Release temporary write was incomplete.');
      }
      await directoryLease.recheck();
      if ((await optionalFile(destination)) !== null) throw new Error('Release destination appeared before publication.');
      const immediatelyBeforeRename = await stableStat(temporary, 'file');
      const heldBeforeRename = await handle.stat();
      const bytesBeforeRename = await handle.read();
      if (!sameStat(tempState, heldBeforeRename) || !sameStat(heldBeforeRename, immediatelyBeforeRename)
        || testDeps.sha256Bytes(bytesBeforeRename) !== expectedSha256) throw new Error('Release temporary identity drifted before publication.');
      await directoryLease.recheck();
      if ((await optionalFile(destination)) !== null) throw new Error('Release destination appeared before publication.');
      await testDeps.renamePath(temporary, destination);
      if ((await optionalFile(temporary)) !== null) throw new Error('Release temporary path remained after publication.');
      const relativeDestination = `${directorySegments.join('/')}/${fileName}`;
      const published = await holdStableFile(workspaceRoot, relativeDestination, destinationHeld);
      const heldAfter = await handle.stat();
      const heldBytesAfter = await handle.read();
      if (!sameStat(tempState, heldAfter) || !sameStat(heldAfter, published.expected)
        || testDeps.sha256Bytes(heldBytesAfter) !== expectedSha256 || published.sha256 !== expectedSha256) {
        throw new Error('Published release bytes failed stable reopen.');
      }
      await directoryLease.recheck();
      const renamedHandleState = await handle.stat();
      const renamedHandleBytes = await handle.read();
      if (!sameStat(tempState, renamedHandleState) || testDeps.sha256Bytes(renamedHandleBytes) !== expectedSha256) {
        throw new Error('Published release handle drifted after rename.');
      }
      await recheckHeldFiles(destinationHeld);
      await directoryLease.recheck();
      if (validatePublished !== null) await validatePublished(new Uint8Array(published.bytes));
      await recheckHeldFiles(destinationHeld);
      await directoryLease.recheck();
      return expectedSha256;
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      let cleanup = null;
      try { await closeHeldFiles(destinationHeld); } catch (error) { cleanup = error; }
      if (handle) {
        try { await handle.close(); } catch (error) { cleanup ??= error; }
      }
      try { await directoryLease.close(); } catch (error) { cleanup ??= error; }
      if (!primary && cleanup) throw cleanup;
    }
  }

  async function writePreparedMetadataCore(workspaceRoot, metadata, releaseFacts = null) {
    const bytes = testDeps.utf8Bytes(`${JSON.stringify(metadata, null, 2)}\n`);
    const sha256 = await exclusivePublish({
      workspaceRoot, directorySegments: ['release-validation', 'staging'], fileName: 'release-metadata.json', bytes,
      validatePublished: async (publishedBytes) => {
        const parsed = parseStrictJsonObject(publishedBytes, 'Published metadata');
        const validatedParsed = validateReleaseMetadata(parsed, releaseFacts);
        const validatedInput = validateReleaseMetadata(metadata, releaseFacts);
        if (JSON.stringify(validatedParsed) !== JSON.stringify(validatedInput)) throw new Error('Published metadata failed deep equality.');
      },
    });
    return freezeDeep({ relativePath: 'release-validation/staging/release-metadata.json', sha256 });
  }

  async function writePreparedMetadata(input) {
    const { workspaceRoot, metadata } = exactOrdinaryObject(input, ['workspaceRoot', 'metadata'], 'Metadata writer input');
    assertWorkspace(workspaceRoot);
    return await writePreparedMetadataCore(workspaceRoot, metadata);
  }

  async function importReportSchema(workspaceRoot) {
    const zod = testDeps.pathToFileUrl(testDeps.pathJoin(workspaceRoot, 'node_modules', 'zod', 'index.js'));
    const schema = testDeps.pathToFileUrl(testDeps.pathJoin(workspaceRoot, 'scripts', 'release', 'lib', 'report-schema.mjs'));
    await testDeps.importProtectedModule(zod);
    const imported = await testDeps.importProtectedModule(schema);
    if (!imported.PreflightReportSchema || typeof imported.PreflightReportSchema.parse !== 'function') throw new Error('Preflight report schema is unavailable.');
    return imported.PreflightReportSchema;
  }

  async function publishParsedPreflightReport(workspaceRoot, report, schema) {
    const parsed = schema.parse(report);
    const bytes = testDeps.utf8Bytes(`${JSON.stringify(parsed)}\n`);
    const reportSha256 = await exclusivePublish({
      workspaceRoot, directorySegments: ['release-validation', 'reports'], fileName: 'preflight.json', bytes,
      validatePublished: async (publishedBytes) => {
        const reopened = parseStrictJsonObject(publishedBytes, 'Published report');
        schema.parse(reopened);
        if (JSON.stringify(reopened) !== JSON.stringify(parsed)) throw new Error('Published report failed deep equality.');
      },
    });
    return freezeDeep({ reportPath: 'release-validation/reports/preflight.json', reportSha256, itemId: 'ARTIFACT-PREFLIGHT' });
  }

  async function publishPreflightReport(input) {
    const { workspaceRoot, report } = exactOrdinaryObject(input, ['workspaceRoot', 'report'], 'Report writer input');
    assertWorkspace(workspaceRoot);
    return await publishParsedPreflightReport(workspaceRoot, report, await importReportSchema(workspaceRoot));
  }

  function exactTree(value, expected) {
    return value && value.fileCount === expected.fileCount && value.totalBytes === expected.totalBytes && value.treeSha256 === expected.treeSha256;
  }

  async function runProtectedImportEpoch(input) {
    const { workspaceRoot, phase } = exactOrdinaryObject(input, ['workspaceRoot', 'phase'], 'Protected import epoch input');
    assertWorkspace(workspaceRoot);
    if (phase === 'pre') {
      const observed = await scanCanonicalTree(await canonicalPath(workspaceRoot, 'node_modules', 'directory'));
      if (!exactTree(observed, EXPECTED_PRE_TREE)) throw new Error('Pre-lifecycle tree is invalid.');
      await loadPreflightSchemaUnderLease(workspaceRoot);
      return;
    }
    if (phase !== 'post') throw new Error('Protected import epoch is invalid.');
    const observed = await scanCanonicalTree(await canonicalPath(workspaceRoot, 'node_modules', 'directory'));
    if (!observed || !exactTree(observed, EXPECTED_FINAL_TREE)) throw new Error('Final tree is invalid.');
    const paths = ['node_modules/semver/index.js', 'node_modules/node-abi/index.js', 'scripts/release/lib/security-checklist.mjs', 'scripts/release/native-abi-probe.mjs'];
    const held = [];
    try {
      for (const relativePath of paths) await holdStableFile(workspaceRoot, relativePath, held);
      await recheckHeldFiles(held);
      for (const entry of held) await testDeps.importProtectedModule(testDeps.pathToFileUrl(entry.absolute));
      await recheckHeldFiles(held);
    } finally { await closeHeldFiles(held); }
  }

  async function readJsonFile(workspaceRoot, relativePath, label) {
    const absolute = testDeps.pathJoin(workspaceRoot, ...relativePath.split('/'));
    const bytes = (await stableRead(absolute)).bytes;
    const value = parseStrictJsonObject(bytes, label);
    return { value, bytes, sha256: testDeps.sha256Bytes(bytes) };
  }

  function requireRunnerResult(id, result, extraKeys) {
    if (!result || typeof result !== 'object' || result.status !== 'PASS') {
      const failed = exactOrdinaryObject(result, ['status', 'category', 'exitCode'], `Release gate ${id} result`);
      if (failed.status !== 'FAIL' || typeof failed.category !== 'string'
        || (failed.category === 'child-nonzero' ? !Number.isInteger(failed.exitCode) || failed.exitCode < 1 : failed.exitCode !== null)) {
        throw new Error(`Release gate ${id} result is invalid.`);
      }
      throw new Error(`Release gate ${id} failed.`);
    }
    const keys = ['status', 'category', 'exitCode', ...extraKeys];
    const values = exactOrdinaryObject(result, keys, `Release gate ${id} result`);
    if (values.category !== null || values.exitCode !== 0) throw new Error(`Release gate ${id} failed.`);
    return values;
  }

  async function runGateDescriptor(id, extraKeys = []) {
    return requireRunnerResult(id, await testDeps.runTrustedCommand(id), extraKeys);
  }

  function releaseEpoch(environmentEntries, observedNowMs, commitEpoch, frozenEpoch) {
    if (frozenEpoch !== null) {
      if (!Number.isSafeInteger(frozenEpoch) || frozenEpoch < 946684800 || commitEpoch > frozenEpoch) throw new Error('Release epoch is invalid.');
      return frozenEpoch;
    }
    if (!Number.isSafeInteger(observedNowMs) || observedNowMs < 0) throw new Error('Release clock is invalid.');
    const names = environmentEntries.map(([name]) => typeof name === 'string' ? name.toUpperCase() : '');
    if (names.some((name) => name.length === 0) || new Set(names).size !== names.length) throw new Error('Release environment is ambiguous.');
    const npmOverrides = environmentEntries.filter(([name]) => typeof name === 'string' && name.toUpperCase().startsWith('NPM_CONFIG_'));
    if (npmOverrides.length !== 0) throw new Error('Inherited npm configuration is forbidden.');
    const epochRows = environmentEntries.filter(([name]) => typeof name === 'string' && name.toUpperCase() === 'SOURCE_DATE_EPOCH');
    if (epochRows.length > 1) throw new Error('Release epoch environment is ambiguous.');
    const nowSeconds = Math.floor(observedNowMs / 1000);
    const raw = epochRows.length === 0 ? String(nowSeconds) : epochRows[0][1];
    if (typeof raw !== 'string' || !/^[1-9]\d*$/u.test(raw)) throw new Error('Release epoch is invalid.');
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 946684800 || value > nowSeconds || commitEpoch > value) throw new Error('Release epoch is invalid.');
    return value;
  }

  async function readGateSnapshot(workspaceRoot, frozenEpoch = null) {
    assertWorkspace(workspaceRoot);
    const observedNowMs = frozenEpoch === null ? testDeps.readClockMs() : null;
    const environmentEntries = frozenEpoch === null ? testDeps.readEnvironmentEntries() : [];
    if (!Array.isArray(environmentEntries) || environmentEntries.some((row) => !Array.isArray(row) || row.length !== 2)) throw new Error('Release environment is invalid.');
    const rootBefore = await stableStat(workspaceRoot, 'directory');
    const rootEntries = await testDeps.readDirectoryNames(workspaceRoot);
    const lowered = rootEntries.map((entry) => entry.toLowerCase());
    if (new Set(lowered).size !== lowered.length || lowered.includes('.npmrc')
      || lowered.some((entry) => entry === '.env' || (entry.startsWith('.env.') && entry !== '.env.example'))) throw new Error('Release root inputs are ambiguous.');

    const branch = await runGateDescriptor('git-symbolic-head', ['branchRef']);
    const head = await runGateDescriptor('git-head', ['commitSha']);
    const status = await runGateDescriptor('git-status', ['clean']);
    const untracked = await runGateDescriptor('git-untracked-audit', ['clean']);
    const diff = await runGateDescriptor('git-diff-quiet', ['clean']);
    for (const id of ['git-config-audit', 'git-index-audit', 'git-replace-audit']) {
      if ((await runGateDescriptor(id, ['clean'])).clean !== true) throw new Error('Release candidate Git state is invalid.');
    }
    if (branch.branchRef !== 'refs/heads/task15' || !/^[a-f0-9]{40,64}$/u.test(head.commitSha)
      || status.clean !== true || untracked.clean !== true || diff.clean !== true) throw new Error('Release candidate Git state is invalid.');

    const worktrees = await runGateDescriptor('git-worktree-list', ['worktrees']);
    if (!Array.isArray(worktrees.worktrees)) throw new Error('Release worktree topology is invalid.');
    for (const row of worktrees.worktrees) {
      const parsed = exactOrdinaryObject(row, ['head', 'branch', 'bare', 'locked'], 'Release worktree row');
      if (!/^[a-f0-9]{40,64}$/u.test(parsed.head) || typeof parsed.branch !== 'string'
        || typeof parsed.bare !== 'boolean' || typeof parsed.locked !== 'boolean') throw new Error('Release worktree topology is invalid.');
    }
    const candidateRows = worktrees.worktrees.filter((row) => row.branch === 'refs/heads/task15' && row.head === head.commitSha && row.bare === false && row.locked === false);
    const mainRows = worktrees.worktrees.filter((row) => row.branch === 'refs/heads/main' && row.head === 'eb1a07bb950769cf24d0fe5c61c710fed4da0fba' && row.bare === false && row.locked === false);
    if (candidateRows.length !== 1 || mainRows.length !== 1 || worktrees.worktrees.filter((row) => row.branch === 'refs/heads/main').length !== 1) throw new Error('Release worktree topology is invalid.');
    for (const id of ['git-main-config-audit', 'git-main-index-audit', 'git-main-status', 'git-main-untracked-audit']) {
      if ((await runGateDescriptor(id, ['clean'])).clean !== true) throw new Error('Release main Git state is invalid.');
    }
    if ((await runGateDescriptor('git-main-head', ['commitSha'])).commitSha !== 'eb1a07bb950769cf24d0fe5c61c710fed4da0fba') throw new Error('Release main Git state is invalid.');
    const commitEpoch = (await runGateDescriptor('git-source-epoch', ['sourceDateEpoch'])).sourceDateEpoch;

    const fixedInputs = [];
    for (const relativePath of FIXED_GATE_PATHS) {
      const absolute = await canonicalPath(workspaceRoot, relativePath, 'file');
      const loaded = await stableRead(absolute);
      const sha256 = testDeps.sha256Bytes(loaded.bytes);
      const expectedSha256 = EXPECTED_FIXED_GATE_HASHES[relativePath];
      if (relativePath !== 'package.json' && (typeof expectedSha256 !== 'string' || sha256 !== expectedSha256)) {
        throw new Error('Release reviewed fixed input drifted.');
      }
      fixedInputs.push({ relativePath, sha256 });
    }
    const fixedHash = (relativePath) => fixedInputs.find((row) => row.relativePath === relativePath)?.sha256;
    const packageFile = await readJsonFile(workspaceRoot, 'package.json', 'package.json');
    const preflightFile = await stableRead(await canonicalPath(workspaceRoot, 'scripts/release/preflight.mjs', 'file'));
    const lockFile = await readJsonFile(workspaceRoot, 'package-lock.json', 'package-lock.json');
    if (lockFile.sha256 !== fixedHash('package-lock.json')) throw new Error('Release reviewed package-lock bytes drifted.');
    if (packageFile.value.version !== '1.0.1-rc.1' || lockFile.value.version !== '1.0.1-rc.1'
      || lockFile.value.packages?.['']?.version !== '1.0.1-rc.1'
      || packageFile.value.packageManager !== 'npm@11.12.1'
      || packageFile.value.engines?.node !== '^22.14.0 || ^24.0.0'
      || packageFile.value.engines?.npm !== '>=11.12.1 <12') throw new Error('Release package inputs are invalid.');
    const committedPackage = await runGateDescriptor('git-package-blob-hash', ['sha256']);
    if (committedPackage.sha256 !== packageFile.sha256) throw new Error('Release package bytes are not committed.');
    const policy = await testDeps.loadReleaseToolchainPolicy();
    const node = await runGateDescriptor('node-version', ['value']);
    const npm = await runGateDescriptor('npm-version', ['value']);
    const git = await runGateDescriptor('git-version', ['value']);
    if (node.value !== policy.node.version || npm.value !== policy.npm.version
      || git.value !== `git version ${policy.git.version}` || policy.platform !== 'win32' || policy.architecture !== 'x64') throw new Error('Release toolchain is invalid.');
    const rootAfter = await stableStat(workspaceRoot, 'directory');
    if (!sameStat(rootBefore, rootAfter)) throw new Error('Release workspace identity changed.');
    const facts = freezeDeep({
      branch: 'task15', dirty: false, commitSha: head.commitSha,
      packageLockSha256: lockFile.sha256,
      releaseNotesSha256: fixedHash('docs/releases/1.0.1-rc.1.md'),
      sourceDateEpoch: releaseEpoch(environmentEntries, observedNowMs, commitEpoch, frozenEpoch),
      toolchain: { nodeVersion: node.value, npmVersion: npm.value, electronVersion: policy.nativeAbi.electron.electronVersion, platform: policy.platform, arch: policy.architecture },
    });
    const binding = freezeDeep({
      workspaceState: rootAfter,
      packageSha256: packageFile.sha256,
      preflightSha256: testDeps.sha256Bytes(preflightFile.bytes),
      packageLockSha256: lockFile.sha256,
      fixedInputs,
      policyFacts: {
        schemaVersion: policy.schemaVersion,
        platform: policy.platform,
        architecture: policy.architecture,
        preLifecycleTree: policy.dependencyBootstrap.preLifecycleTree,
        lifecyclePayloads: policy.dependencyBootstrap.lifecyclePayloads,
        finalTree: policy.dependencyBootstrap.finalTree,
      },
    });
    return freezeDeep({ facts, binding });
  }

  function sameFacts(left, right) {
    return left === right || (left && right
      && left.branch === right.branch && left.dirty === right.dirty && left.commitSha === right.commitSha
      && left.packageLockSha256 === right.packageLockSha256 && left.releaseNotesSha256 === right.releaseNotesSha256
      && left.sourceDateEpoch === right.sourceDateEpoch && JSON.stringify(left.toolchain) === JSON.stringify(right.toolchain));
  }

  function sameGateBinding(left, right) {
    if (!left || !right || !sameDirectoryIdentity(left.workspaceState, right.workspaceState)) return false;
    const withoutWorkspace = (value) => ({
      packageSha256: value.packageSha256,
      preflightSha256: value.preflightSha256,
      packageLockSha256: value.packageLockSha256,
      fixedInputs: value.fixedInputs,
      policyFacts: value.policyFacts,
    });
    return canonicalKnownValue(withoutWorkspace(left)) === canonicalKnownValue(withoutWorkspace(right));
  }

  function canonicalKnownValue(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalKnownValue).join(',')}]`;
    if (!value || typeof value !== 'object') throw new Error('Release canonical value is invalid.');
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalKnownValue(value[key])}`).join(',')}}`;
  }

  function expectedBuildId(facts) {
    const stamp = new Date(facts.sourceDateEpoch * 1000).toISOString().replace(/[-:]/gu, '').replace('.000Z', 'Z');
    return `1.0.1-rc.1+${facts.commitSha.slice(0, 12)}.${stamp}`;
  }

  async function loadPreflightSchemaUnderLease(
    workspaceRoot,
    expectedLockSha256 = EXPECTED_FIXED_GATE_HASHES['package-lock.json'],
    beforeClose = null,
  ) {
    const policy = await testDeps.loadReleaseToolchainPolicy();
    if (!policy || !exactTree(policy.dependencyBootstrap?.preLifecycleTree, EXPECTED_PRE_TREE)) throw new Error('Pre-lifecycle policy is invalid.');
    const zodRow = EXPECTED_PACKAGE_ROWS.find((row) => row.name === 'zod');
    const zodRoot = await canonicalPath(workspaceRoot, zodRow.rootRelativePath, 'directory');
    const zodTree = await scanCanonicalTree(zodRoot);
    if (zodTree.treeSha256 !== zodRow.treeSha256) throw new Error('Pre-lifecycle Zod tree is invalid.');
    const directoryLease = await acquireDirectoryLease(workspaceRoot, ['', 'node_modules', 'node_modules/zod', 'scripts', 'scripts/release', 'scripts/release/lib']);
    const held = [];
    let primary = null;
    try {
      const lockEntry = await holdStableFile(workspaceRoot, 'package-lock.json', held);
      if (lockEntry.sha256 !== expectedLockSha256) throw new Error('Pre-lifecycle package-lock binding drifted.');
      const lock = parseStrictJsonObject(lockEntry.bytes, 'package-lock.json');
      const lockRow = lock.packages?.[zodRow.rootRelativePath];
      if (!lockRow || lockRow.version !== zodRow.version || lockRow.integrity !== zodRow.lockIntegrity) throw new Error('Pre-lifecycle Zod lock binding is invalid.');
      const zodEntry = await holdStableFile(workspaceRoot, 'node_modules/zod/index.js', held);
      const schemaEntry = await holdStableFile(workspaceRoot, 'scripts/release/lib/report-schema.mjs', held);
      const expectedZod = EXPECTED_PACKAGE_ENTRY_ROWS.find((row) => row.id === 'zod-entry');
      if (zodEntry.sha256 !== expectedZod.fileSha256
        || schemaEntry.sha256 !== EXPECTED_WORKSPACE_ENTRY_HASHES['report-schema']) throw new Error('Pre-lifecycle schema entry is invalid.');
      const verifyLease = async () => {
        await directoryLease.recheck();
        const repeatedTree = await scanCanonicalTree(zodRoot);
        if (repeatedTree.treeSha256 !== zodRow.treeSha256) throw new Error('Pre-lifecycle Zod tree drifted.');
        await recheckHeldFiles(held);
        await directoryLease.recheck();
      };
      await verifyLease();
      await testDeps.importProtectedModule(testDeps.pathToFileUrl(zodEntry.absolute));
      await verifyLease();
      const imported = await testDeps.importProtectedModule(testDeps.pathToFileUrl(schemaEntry.absolute));
      await verifyLease();
      if (!imported.PreflightReportSchema || typeof imported.PreflightReportSchema.parse !== 'function') throw new Error('Preflight report schema is unavailable.');
      return beforeClose === null
        ? imported.PreflightReportSchema
        : await beforeClose(imported.PreflightReportSchema, verifyLease);
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      let cleanup = null;
      try { await closeHeldFiles(held); } catch (error) { cleanup = error; }
      try { await directoryLease.close(); } catch (error) { cleanup ??= error; }
      if (!primary && cleanup) throw cleanup;
    }
  }

  async function writeBootstrapDiagnostic(workspaceRoot) {
    const report = { schemaVersion: 1, stage: 'preflight-bootstrap', status: 'FAIL', blocker: 'Dependency bootstrap failed' };
    const bytes = testDeps.utf8Bytes(`${JSON.stringify(report)}\n`);
    return await exclusivePublish({
      workspaceRoot,
      directorySegments: ['release-validation', 'reports'],
      fileName: 'preflight-bootstrap-failure.json',
      bytes,
    });
  }

  async function runEarlyGitPackageGate(input) {
    const { workspaceRoot } = exactOrdinaryObject(input, ['workspaceRoot'], 'Early gate input');
    assertWorkspace(workspaceRoot);
    const snapshot = await readGateSnapshot(workspaceRoot);
    const facts = snapshot.facts;
    factOwners.set(facts, snapshot.binding);
    return facts;
  }

  async function closeRecord(record) {
    if (record.closePromise === null) {
      record.closePromise = Promise.resolve().then(async () => {
        if (record.handle) await record.handle.close();
      }).catch((error) => {
        record.closeError = error;
        throw error;
      });
    }
    return await record.closePromise;
  }

  async function prepareDependencyBootstrap(input) {
    const values = exactOrdinaryObject(input, ['workspaceRoot', 'releaseFacts'], 'Dependency bootstrap input');
    assertWorkspace(values.workspaceRoot);
    if (!factOwners.has(values.releaseFacts)) throw new Error('Release facts are not owned by this core.');
    let handle;
    let mintedToken = null;
    let diagnosticAllowed = false;
    try {
      const quarantine = await quarantinePreflightEvidenceCore(values.workspaceRoot, true);
      handle = quarantine.directoryLease;
      await quarantine.recheckCanonicalAbsence();
      diagnosticAllowed = true;
      const install = await testDeps.runTrustedCommand('npm-ci-ignore-scripts');
      await quarantine.recheckCanonicalAbsence();
      if (!install || install.status !== 'PASS' || install.exitCode !== 0) throw new Error('Dependency bootstrap failed.');
      const repeated = await readGateSnapshot(values.workspaceRoot, values.releaseFacts.sourceDateEpoch);
      if (!sameFacts(repeated.facts, values.releaseFacts)
        || !sameGateBinding(repeated.binding, factOwners.get(values.releaseFacts))) throw new Error('Dependency bootstrap gate drifted.');
      await quarantine.recheckCanonicalAbsence();
      const preTree = await scanCanonicalTree(await canonicalPath(values.workspaceRoot, 'node_modules', 'directory'));
      if (!exactTree(preTree, EXPECTED_PRE_TREE)) throw new Error('Dependency bootstrap failed.');
      await quarantine.recheckCanonicalAbsence();
      return await loadPreflightSchemaUnderLease(
        values.workspaceRoot,
        repeated.binding.packageLockSha256,
        async (preflightSchema, verifySchemaLease) => {
          await quarantine.recheckCanonicalAbsence();
          await verifySchemaLease();
          await quarantine.recheckCanonicalAbsence();
          await verifySchemaLease();
          mintedToken = Object.freeze({});
          tokens.set(mintedToken, {
            phase: 'BOOTSTRAPPED', workspaceRoot: values.workspaceRoot, releaseFacts: values.releaseFacts,
            dependencyIdentity: testDeps.dependencyIdentity(), gateBinding: repeated.binding,
            preTree: freezeDeep({ fileCount: preTree.fileCount, totalBytes: preTree.totalBytes, treeSha256: preTree.treeSha256 }),
            handle, closePromise: null, closeError: null, preflightSchema,
          });
          return mintedToken;
        },
      );
    } catch (error) {
      if (mintedToken !== null) tokens.delete(mintedToken);
      if (handle) {
        try { await handle.recheck(); } catch { diagnosticAllowed = false; }
        try { await handle.close(); } catch { diagnosticAllowed = false; }
      }
      if (diagnosticAllowed) {
        try { await writeBootstrapDiagnostic(values.workspaceRoot); } catch { }
      }
      throw error;
    }
  }

  function knownRecord(token) {
    if (token === null || typeof token !== 'object') throw new Error('Dependency bootstrap token is invalid.');
    const record = tokens.get(token);
    if (!record) throw new Error('Dependency bootstrap token is invalid.');
    return record;
  }

  async function prepareReleaseMetadata(input) {
    const values = exactOrdinaryObject(input, ['workspaceRoot', 'releaseFacts', 'dependencyBootstrap'], 'Metadata preparation input');
    const record = knownRecord(values.dependencyBootstrap);
    if (record.phase !== 'BOOTSTRAPPED') throw new Error('Dependency bootstrap phase is invalid.');
    record.phase = 'METADATA_PREPARING';
    try {
      if (values.workspaceRoot !== record.workspaceRoot || values.releaseFacts !== record.releaseFacts
        || testDeps.dependencyIdentity() !== record.dependencyIdentity) throw new Error('Dependency bootstrap identity drifted.');
      await record.handle.recheck();
      const metadata = await testDeps.createReleaseMetadataValue({
        workspace: values.workspaceRoot,
        now: new Date(values.releaseFacts.sourceDateEpoch * 1000),
        sourceDateEpoch: String(values.releaseFacts.sourceDateEpoch),
        git: { branch: values.releaseFacts.branch, dirty: values.releaseFacts.dirty, commitSha: values.releaseFacts.commitSha },
        versions: values.releaseFacts.toolchain,
      });
      if (record.phase !== 'METADATA_PREPARING') throw new Error('Dependency bootstrap phase changed during metadata preparation.');
      await record.handle.recheck();
      const prepared = await writePreparedMetadataCore(values.workspaceRoot, metadata, values.releaseFacts);
      if (record.phase !== 'METADATA_PREPARING') throw new Error('Dependency bootstrap phase changed during metadata publication.');
      await record.handle.recheck();
      record.preparedMetadata = prepared;
      record.metadata = freezeDeep(metadata);
      record.phase = 'METADATA_PREPARED';
      return prepared;
    } catch (error) {
      record.phase = 'POISONED';
      await closeRecord(record);
      throw error;
    }
  }

  function commandRow(id, result, durationMs) {
    const pass = result && result.status === 'PASS' && result.category === null && result.exitCode === 0;
    return { id, status: pass ? 'PASS' : 'FAIL', category: pass ? null : result?.category ?? 'verification-failed', exitCode: pass ? 0 : result?.exitCode ?? null, durationMs };
  }

  function checkRow(id, passed, durationMs) {
    return { id, status: passed ? 'PASS' : 'FAIL', durationMs };
  }

  function trustworthyTestCounts(value) {
    const keys = ['files', 'tests', 'passed', 'failed', 'skipped', 'todo'];
    if (!value || keys.some((key) => !Number.isInteger(value[key]) || value[key] < 0 || value[key] > 2147483647)) {
      return null;
    }
    const reconciled = value.passed + value.failed + value.skipped + value.todo;
    if (reconciled > 2147483647 || value.tests !== reconciled) return null;
    return freezeDeep({ files: value.files, tests: value.tests, passed: value.passed, failed: value.failed, skipped: value.skipped, todo: value.todo });
  }

  function expectedContextMatches(context, record) {
    const facts = record.releaseFacts;
    const prepared = record.preparedMetadata;
    if (!context || typeof context !== 'object' || Array.isArray(context) || !Object.isFrozen(context)
      || Reflect.ownKeys(context).length !== 14 || !Object.isFrozen(context.toolchain)) return false;
    const safeFacts = {
      schemaVersion: 1,
      branch: facts.branch,
      dirty: facts.dirty,
      commitSha: facts.commitSha,
      version: '1.0.1-rc.1',
      channel: 'rc',
      buildId: expectedBuildId(facts),
      metadataPath: prepared.relativePath,
      metadataSha256: prepared.sha256,
      packageLockSha256: facts.packageLockSha256,
      releaseNotesSha256: facts.releaseNotesSha256,
      sourceDateEpoch: facts.sourceDateEpoch,
      toolchain: facts.toolchain,
    };
    const expectedContextId = testDeps.sha256Bytes(testDeps.utf8Bytes(`${canonicalKnownValue(safeFacts)}\n`));
    return context.contextId === expectedContextId && context.schemaVersion === 1
      && context.version === '1.0.1-rc.1' && context.channel === 'rc' && context.buildId === safeFacts.buildId
      && context.branch === facts.branch && context.dirty === facts.dirty
      && context.commitSha === facts.commitSha && context.metadataPath === prepared.relativePath
      && context.metadataSha256 === prepared.sha256 && context.packageLockSha256 === facts.packageLockSha256
      && context.releaseNotesSha256 === facts.releaseNotesSha256 && context.sourceDateEpoch === facts.sourceDateEpoch
      && JSON.stringify(context.toolchain) === JSON.stringify(facts.toolchain);
  }

  function probeEqual(actual, expected) {
    return JSON.stringify(actual) === JSON.stringify(expected);
  }

  function parseHeldJson(entry, label) {
    return parseStrictJsonObject(entry.bytes, label);
  }

  async function buildPostInstallBindingsLease(workspaceRoot, gateBinding) {
    const policy = await testDeps.loadReleaseToolchainPolicy();
    if (!policy || !exactTree(policy.dependencyBootstrap?.finalTree, EXPECTED_FINAL_TREE)
      || JSON.stringify(policy.dependencyBootstrap?.lifecyclePayloads) !== JSON.stringify(EXPECTED_LIFECYCLE_ROWS.map(({ descriptorId: _descriptorId, ...row }) => row))) {
      throw new Error('Post-install policy is invalid.');
    }
    const nodeModules = await canonicalPath(workspaceRoot, 'node_modules', 'directory');
    const finalTree = await scanCanonicalTree(nodeModules);
    if (!exactTree(finalTree, EXPECTED_FINAL_TREE)) throw new Error('Post-install dependency tree drifted.');

    const directoryPaths = new Set(['', 'node_modules']);
    for (const row of EXPECTED_PACKAGE_ROWS) directoryPaths.add(row.rootRelativePath);
    for (const row of [...EXPECTED_PACKAGE_ENTRY_ROWS, ...WORKSPACE_ENTRY_PATHS.map(([id, relativePath]) => ({ id, relativePath }))]) {
      const members = row.relativePath.split('/');
      for (let index = 1; index < members.length; index += 1) directoryPaths.add(members.slice(0, index).join('/'));
    }
    directoryPaths.add('scripts');
    const directoryLease = await acquireDirectoryLease(workspaceRoot, [...directoryPaths]);
    const held = [];
    let closed = false;
    try {
      const lockEntry = await holdStableFile(workspaceRoot, 'package-lock.json', held);
      if (lockEntry.sha256 !== gateBinding.packageLockSha256) throw new Error('Post-install lock binding drifted.');
      const lock = parseHeldJson(lockEntry, 'package-lock.json');
      const packages = [];
      for (const row of EXPECTED_PACKAGE_ROWS) {
        const lockRow = lock.packages?.[row.rootRelativePath];
        if (!lockRow || lockRow.version !== row.version || lockRow.integrity !== row.lockIntegrity) throw new Error('Post-install lock binding drifted.');
        const packageEntry = await holdStableFile(workspaceRoot, `${row.rootRelativePath}/package.json`, held);
        const packageJson = parseHeldJson(packageEntry, `${row.name} package.json`);
        if (packageJson.name !== row.name || packageJson.version !== row.version) throw new Error('Post-install package identity drifted.');
        const observedTree = await scanCanonicalTree(await canonicalPath(workspaceRoot, row.rootRelativePath, 'directory'));
        if (observedTree.treeSha256 !== row.treeSha256) throw new Error('Post-install package tree drifted.');
        packages.push({ ...row });
      }
      const packageEntries = [];
      for (const row of EXPECTED_PACKAGE_ENTRY_ROWS) {
        const entry = await holdStableFile(workspaceRoot, row.relativePath, held);
        if (entry.sha256 !== row.fileSha256) throw new Error('Post-install package entry drifted.');
        packageEntries.push({ ...row });
      }
      const workspaceEntries = [];
      for (const [id, relativePath] of WORKSPACE_ENTRY_PATHS) {
        const entry = await holdStableFile(workspaceRoot, relativePath, held);
        const reviewedHash = id === 'package-manifest' ? gateBinding.packageSha256
          : id === 'preflight' ? gateBinding.preflightSha256
            : EXPECTED_WORKSPACE_ENTRY_HASHES[id];
        if (reviewedHash !== undefined && entry.sha256 !== reviewedHash) throw new Error('Post-install workspace entry drifted.');
        workspaceEntries.push({ id, relativePath, fileSha256: entry.sha256 });
      }
      const projection = freezeDeep({
        schemaVersion: 1,
        nodeModulesTree: { fileCount: finalTree.fileCount, totalBytes: finalTree.totalBytes, treeSha256: finalTree.treeSha256 },
        packages,
        packageEntries,
        workspaceEntries,
      });
      const verifyLease = async () => {
        if (closed) throw new Error('Post-install binding lease is closed.');
        await directoryLease.recheck();
        const repeatedFinalTree = await scanCanonicalTree(nodeModules);
        if (!exactTree(repeatedFinalTree, EXPECTED_FINAL_TREE)) throw new Error('Post-install dependency tree drifted.');
        for (const row of EXPECTED_PACKAGE_ROWS) {
          const repeatedPackageTree = await scanCanonicalTree(await canonicalPath(workspaceRoot, row.rootRelativePath, 'directory'));
          if (repeatedPackageTree.treeSha256 !== row.treeSha256) throw new Error('Post-install package tree drifted.');
        }
        await recheckHeldFiles(held);
        await directoryLease.recheck();
      };
      await verifyLease();
      return freezeDeep({
        projection,
        recheck: verifyLease,
        close: async () => {
          if (closed) throw new Error('Post-install binding lease was already closed.');
          let failure = null;
          try { await verifyLease(); } catch (error) { failure = error; }
          closed = true;
          try { await closeHeldFiles(held); } catch (error) { failure ??= error; }
          try { await directoryLease.close(); } catch (error) { failure ??= error; }
          if (failure) throw failure;
        },
      });
    } catch (error) {
      try { await closeHeldFiles(held); } catch { }
      try { await directoryLease.close(); } catch { }
      throw error;
    }
  }

  async function withPostInstallBindingsLease(workspaceRoot, context, action) {
    if (!contextOwners.has(context)) throw new Error('Release context is not owned by this core.');
    const gateBinding = contextBindings.get(context);
    if (!gateBinding) throw new Error('Release context binding is unavailable.');
    const lease = await buildPostInstallBindingsLease(workspaceRoot, gateBinding);
    let primary = null;
    try {
      await lease.recheck();
      return await action(lease.projection, lease);
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      let cleanup = null;
      try { await lease.close(); } catch (error) { cleanup = error; }
      if (!primary && cleanup) throw cleanup;
    }
  }

  async function importPostInstallModule(workspaceRoot, lease, relativePath) {
    await lease.recheck();
    const imported = await testDeps.importProtectedModule(testDeps.pathToFileUrl(await canonicalPath(workspaceRoot, relativePath, 'file')));
    await lease.recheck();
    return imported;
  }

  async function validateLifecycleBoundary(record, row) {
    const repeated = await readGateSnapshot(record.workspaceRoot, record.releaseFacts.sourceDateEpoch);
    if (!sameFacts(repeated.facts, record.releaseFacts) || !sameGateBinding(repeated.binding, record.gateBinding)) {
      throw new Error('Lifecycle release gate drifted.');
    }
    const policy = await testDeps.loadReleaseToolchainPolicy();
    const expectedPolicyRows = EXPECTED_LIFECYCLE_ROWS.map(({ descriptorId: _descriptorId, ...item }) => item);
    if (JSON.stringify(policy.dependencyBootstrap?.lifecyclePayloads) !== JSON.stringify(expectedPolicyRows)) throw new Error('Lifecycle policy drifted.');
    const entry = await stableRead(await canonicalPath(record.workspaceRoot, `node_modules/${row.entryRelativePath}`, 'file'));
    if (testDeps.sha256Bytes(entry.bytes) !== row.entrySha256) throw new Error('Lifecycle entry drifted.');
    const packageJson = await readJsonFile(record.workspaceRoot, `node_modules/${row.workingDirectoryRelativePath}/package.json`, 'Lifecycle package');
    if (packageJson.value.name !== row.packageName || packageJson.value.version !== row.packageVersion) throw new Error('Lifecycle package drifted.');
  }

  async function assertRootDotenvAbsent(workspaceRoot) {
    const names = await testDeps.readDirectoryNames(workspaceRoot);
    const lowered = names.map((name) => name.toLowerCase());
    if (new Set(lowered).size !== lowered.length
      || lowered.some((name) => name === '.env' || (name.startsWith('.env.') && name !== '.env.example'))) {
      throw new Error('Release dotenv input is forbidden.');
    }
  }

  function runnerFailure(result, fallback = 'execution') {
    return result && typeof result === 'object' && result.status === 'FAIL'
      ? { status: 'FAIL', category: result.category ?? fallback, exitCode: result.exitCode ?? null }
      : { status: 'FAIL', category: fallback, exitCode: null };
  }

  async function safeTrustedCommand(id, record) {
    try {
      await record.handle.recheck();
      const result = await testDeps.runTrustedCommand(id);
      await record.handle.recheck();
      return result;
    } catch { return { status: 'FAIL', category: 'execution', exitCode: null }; }
  }

  function exactSubstringCount(text, needle) {
    if (needle.length === 0) return 0;
    let count = 0;
    let offset = 0;
    while ((offset = text.indexOf(needle, offset)) !== -1) {
      count += 1;
      offset += needle.length;
    }
    return count;
  }

  const RELEASE_INVARIANT_FIXED_PATHS = Object.freeze([
    'release-validation/staging/release-metadata.json',
    'src/shared/update-bootstrap-contract.json',
    'build-resources/app-update.yml',
    'scripts/generate-app-update-config.mjs',
    'scripts/generate-app-icons.mjs',
    'docs/legal/ASSET-NOTICES.md',
    'build-resources/app-icon.svg',
    'build-resources/app-icon.png',
    'build-resources/app-icon.ico',
    'package.json',
    'package-lock.json',
    'src/shared/release-contract.json',
    'docs/releases/1.0.1-rc.1.md',
    'electron-builder.yml',
    'build-resources/installer.nsh',
    'vite.main.config.ts',
    'vite.preload.config.ts',
    'vite.renderer.config.ts',
    'scripts/release/lib/trusted-windows-runner.mjs',
  ]);

  async function withReleaseInvariantLease(record, action) {
    const distRoot = await canonicalPath(record.workspaceRoot, 'dist', 'directory');
    const dist = await scanCanonicalTree(distRoot);
    const filePaths = [...RELEASE_INVARIANT_FIXED_PATHS, ...dist.rows.map((row) => `dist/${row.relativePath}`)];
    const directoryPaths = new Set(['']);
    for (const relativePath of filePaths) {
      const members = relativePath.split('/');
      for (let index = 1; index < members.length; index += 1) directoryPaths.add(members.slice(0, index).join('/'));
    }
    const directoryLease = await acquireDirectoryLease(record.workspaceRoot, [...directoryPaths]);
    const held = [];
    let primary = null;
    try {
      const entries = new Map();
      for (const relativePath of filePaths) entries.set(relativePath, await holdStableFile(record.workspaceRoot, relativePath, held));
      const reviewedFixedHash = (relativePath) => record.gateBinding.fixedInputs
        .find((row) => row.relativePath === relativePath)?.sha256;
      if (invariantEntry({ entries }, 'package.json').sha256 !== record.gateBinding.packageSha256
        || invariantEntry({ entries }, 'package-lock.json').sha256 !== record.gateBinding.packageLockSha256
        || invariantEntry({ entries }, 'src/shared/release-contract.json').sha256 !== reviewedFixedHash('src/shared/release-contract.json')
        || invariantEntry({ entries }, 'src/shared/release-contract.json').sha256 !== EXPECTED_FIXED_GATE_HASHES['src/shared/release-contract.json']
        || invariantEntry({ entries }, 'docs/releases/1.0.1-rc.1.md').sha256 !== reviewedFixedHash('docs/releases/1.0.1-rc.1.md')
        || invariantEntry({ entries }, 'docs/releases/1.0.1-rc.1.md').sha256 !== EXPECTED_FIXED_GATE_HASHES['docs/releases/1.0.1-rc.1.md']) {
        throw new Error('Release invariant gate binding drifted.');
      }
      const recheck = async () => {
        await directoryLease.recheck();
        const repeatedDist = await scanCanonicalTree(distRoot);
        if (!exactTree(repeatedDist, dist)) throw new Error('Release distribution tree drifted.');
        await recheckHeldFiles(held);
        await directoryLease.recheck();
      };
      await recheck();
      const result = await action(freezeDeep({ entries, dist }));
      await recheck();
      return result;
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      let cleanup = null;
      try { await closeHeldFiles(held); } catch (error) { cleanup = error; }
      try { await directoryLease.close(); } catch (error) { cleanup ??= error; }
      if (!primary && cleanup) throw cleanup;
    }
  }

  function invariantEntry(lease, relativePath) {
    const entry = lease.entries.get(relativePath);
    if (!entry) throw new Error(`Release invariant entry is absent (${relativePath}).`);
    return entry;
  }

  function metadataInvariant(record, context, lease) {
    const metadataEntry = invariantEntry(lease, 'release-validation/staging/release-metadata.json');
    const expectedBytes = testDeps.utf8Bytes(`${JSON.stringify(record.metadata, null, 2)}\n`);
    const metadataSha256 = metadataEntry.sha256;
    if (metadataSha256 !== record.preparedMetadata.sha256 || metadataSha256 !== context.metadataSha256
      || metadataEntry.bytes.length !== expectedBytes.length
      || !metadataEntry.bytes.every((byte, index) => byte === expectedBytes[index])
      || canonicalKnownValue(parseStrictJsonObject(metadataEntry.bytes, 'Prepared metadata')) !== canonicalKnownValue(record.metadata)) return false;
    const mainEntry = invariantEntry(lease, 'dist/main/index.js');
    const embeddedLiteral = JSON.stringify(testDeps.utf8Text(expectedBytes));
    return exactSubstringCount(testDeps.utf8Text(mainEntry.bytes), embeddedLiteral) === 1;
  }

  function updateAndIconInvariant(lease) {
    const contract = parseHeldJson(invariantEntry(lease, 'src/shared/update-bootstrap-contract.json'), 'Update bootstrap contract');
    if (canonicalKnownValue(contract) !== canonicalKnownValue(EXPECTED_UPDATE_CONTRACT)) return false;
    const yaml = invariantEntry(lease, 'build-resources/app-update.yml');
    if (testDeps.utf8Text(yaml.bytes) !== EXPECTED_APP_UPDATE_YAML) return false;
    for (const relativePath of [
      'scripts/generate-app-update-config.mjs', 'scripts/generate-app-icons.mjs', 'docs/legal/ASSET-NOTICES.md',
      'build-resources/app-icon.svg', 'build-resources/app-icon.png', 'build-resources/app-icon.ico',
    ]) {
      const loaded = invariantEntry(lease, relativePath);
      if (loaded.sha256 !== EXPECTED_FIXED_GATE_HASHES[relativePath]) return false;
    }
    return true;
  }

  function buildInputInvariant(lease) {
    const manifest = parseHeldJson(invariantEntry(lease, 'package.json'), 'package.json');
    if (invariantEntry(lease, 'build-resources/installer.nsh').sha256
      !== EXPECTED_FIXED_GATE_HASHES['build-resources/installer.nsh']) return false;
    const scripts = manifest.scripts;
    if (manifest.main !== 'dist/main/index.js' || !scripts
      || scripts['release:preflight'] !== 'node scripts/release/preflight.mjs'
      || scripts.build !== 'npm run build:main && npm run build:preload && npm run build:renderer'
      || scripts['build:main'] !== 'vite build --config vite.main.config.ts'
      || scripts['build:preload'] !== 'vite build --config vite.preload.config.ts'
      || scripts['build:renderer'] !== 'vite build --config vite.renderer.config.ts') return false;
    const loadedInputs = new Map();
    for (const relativePath of ['electron-builder.yml', 'vite.main.config.ts', 'vite.preload.config.ts', 'vite.renderer.config.ts']) {
      const loaded = invariantEntry(lease, relativePath);
      if (loaded.sha256 !== EXPECTED_FIXED_GATE_HASHES[relativePath]) return false;
      loadedInputs.set(relativePath, testDeps.utf8Text(loaded.bytes));
    }
    const builder = loadedInputs.get('electron-builder.yml');
    if (!builder.includes('directories:\n  output: release-validation/staging/build-output\n  buildResources: build-resources')
      || !builder.includes('electronDist: node_modules/electron/dist')
      || !builder.includes("files:\n  - dist/**/*\n  - '!dist/**/*.map'\n  - package.json")
      || !builder.includes('extraResources:\n  - from: build-resources/app-icon.png\n    to: app-icon.png\n  - from: release-validation/staging/release-metadata.json\n    to: release-metadata.json\n  - from: build-resources/app-update.yml\n    to: app-update.yml')
      || !builder.includes('asar: true') || !builder.includes('npmRebuild: false')
      || !builder.includes('  - node_modules/better-sqlite3/**/*')
      || !builder.includes('    - target: nsis\n      arch:\n        - x64')
      || !builder.includes('  icon: build-resources/app-icon.ico')
      || !builder.includes('  requestedExecutionLevel: asInvoker')
      || !builder.includes('  include: build-resources/installer.nsh')
      || /^publish\s*:/mu.test(builder)) return false;
    const viteMain = loadedInputs.get('vite.main.config.ts');
    const vitePreload = loadedInputs.get('vite.preload.config.ts');
    const viteRenderer = loadedInputs.get('vite.renderer.config.ts');
    if (!viteMain.includes("outDir: 'dist/main'") || !viteMain.includes("index: path.resolve(__dirname, 'src/main/index.ts')")
      || !viteMain.includes("'permission-mcp': path.resolve(") || !viteMain.includes("formats: ['cjs']")
      || !viteMain.includes('sourcemap: true')
      || !vitePreload.includes("outDir: 'dist/preload'") || !vitePreload.includes("entry: path.resolve(__dirname, 'src/preload/index.ts')")
      || !vitePreload.includes("formats: ['cjs']") || !vitePreload.includes('sourcemap: true')
      || !viteRenderer.includes("root: 'src/renderer'") || !viteRenderer.includes("base: './'")
      || !viteRenderer.includes("outDir: '../../dist/renderer'")
      || !viteRenderer.includes("input: path.resolve(__dirname, 'src/renderer/index.html')")) return false;
    const runner = invariantEntry(lease, 'scripts/release/lib/trusted-windows-runner.mjs');
    const builderDescriptor = '{"id":"electron-builder-win","executableClass":"node-workspace","argv":["node_modules/electron-builder/cli.js","--win","--publish","never"],"cwdClass":"candidate","environment":{"SOURCE_DATE_EPOCH":"@release-metadata-epoch","WORKBENCH_RELEASE_METADATA_PATH":"@fixed-release-metadata"},"timeoutMs":900000,"stdoutLimit":4194304,"stderrLimit":1048576,"closureClass":"workspace-final","parser":"zero-exit"}';
    if (exactSubstringCount(testDeps.utf8Text(runner.bytes), builderDescriptor) !== 1) return false;
    const paths = lease.dist.rows.map((row) => row.relativePath);
    const main = paths.filter((relativePath) => relativePath.startsWith('main/'));
    const preload = paths.filter((relativePath) => relativePath.startsWith('preload/'));
    const renderer = paths.filter((relativePath) => relativePath.startsWith('renderer/'));
    return JSON.stringify(main) === JSON.stringify(['main/index.js', 'main/index.js.map', 'main/permission-mcp.js', 'main/permission-mcp.js.map'])
      && JSON.stringify(preload) === JSON.stringify(['preload/index.js', 'preload/index.js.map'])
      && renderer.filter((relativePath) => relativePath === 'renderer/index.html').length === 1
      && renderer.some((relativePath) => relativePath.startsWith('renderer/assets/'))
      && renderer.every((relativePath) => relativePath === 'renderer/index.html' || relativePath.startsWith('renderer/assets/'))
      && paths.length === main.length + preload.length + renderer.length;
  }

  function nativeToolchainInvariant(policy, context, nativeAbi, bindings) {
    const expectedNode = { schemaVersion: 1, runtime: 'node', nodeVersion: policy.nativeAbi.hostNode.nodeVersion, electronVersion: null, modulesAbi: policy.nativeAbi.hostNode.modulesAbi, napi: policy.nativeAbi.hostNode.napi, platform: policy.nativeAbi.hostNode.platform, arch: policy.nativeAbi.hostNode.arch, sqliteVersion: policy.nativeAbi.sqlite.sqliteVersion, status: 'PASS' };
    const expectedElectron = { schemaVersion: 1, runtime: 'electron-run-as-node', nodeVersion: policy.nativeAbi.electron.nodeVersion, electronVersion: policy.nativeAbi.electron.electronVersion, modulesAbi: policy.nativeAbi.electron.modulesAbi, napi: policy.nativeAbi.electron.napi, platform: policy.nativeAbi.electron.platform, arch: policy.nativeAbi.electron.arch, sqliteVersion: policy.nativeAbi.sqlite.sqliteVersion, status: 'PASS' };
    const packageRow = (name) => bindings.packages.find((row) => row.name === name);
    const entry = (id) => bindings.packageEntries.find((row) => row.id === id);
    return policy.node.version === 'v24.15.0' && policy.npm.version === '11.12.1'
      && canonicalKnownValue(policy.nativeAbi.hostNode) === canonicalKnownValue({ nodeVersion: 'v24.15.0', modulesAbi: '137', napi: '10', platform: 'win32', arch: 'x64' })
      && canonicalKnownValue(policy.nativeAbi.electron) === canonicalKnownValue({ electronVersion: '35.7.5', nodeVersion: 'v22.16.0', modulesAbi: '133', napi: '10', platform: 'win32', arch: 'x64' })
      && canonicalKnownValue(policy.nativeAbi.sqlite) === canonicalKnownValue({ packageName: 'better-sqlite3', packageVersion: '13.0.2', loaderRelativePath: 'node_modules/better-sqlite3/lib/win32-x64.js', nativeRelativePath: 'node_modules/better-sqlite3/prebuilds/win32-x64.node', nativeSha256: 'ecfb86221a674a6cdba63b1ac162b99386a61d0e38934b6c3dfcd9da11b6ee26', sqliteVersion: '3.53.4' })
      && context.toolchain.nodeVersion === policy.node.version && context.toolchain.npmVersion === policy.npm.version
      && context.toolchain.electronVersion === policy.nativeAbi.electron.electronVersion
      && context.toolchain.platform === policy.platform && context.toolchain.arch === policy.architecture
      && probeEqual(nativeAbi.node, expectedNode) && probeEqual(nativeAbi.electron, expectedElectron)
      && packageRow('electron')?.version === policy.nativeAbi.electron.electronVersion
      && packageRow('electron-builder')?.version === '26.15.3'
      && packageRow('better-sqlite3')?.version === policy.nativeAbi.sqlite.packageVersion
      && entry('better-sqlite3-win32-loader')?.relativePath === policy.nativeAbi.sqlite.loaderRelativePath
      && entry('better-sqlite3-prebuild')?.relativePath === policy.nativeAbi.sqlite.nativeRelativePath
      && entry('better-sqlite3-prebuild')?.fileSha256 === policy.nativeAbi.sqlite.nativeSha256
      && entry('electron-executable')?.fileSha256 === policy.dependencyBootstrap.electronExecutableSha256;
  }

  async function runReleaseInvariantsCore(record, context, tests, requiredCases, iconVerified, nativeAbi, bindings) {
    const gate = await readGateSnapshot(record.workspaceRoot, record.releaseFacts.sourceDateEpoch);
    if (!sameFacts(gate.facts, record.releaseFacts) || !sameGateBinding(gate.binding, record.gateBinding)) return false;
    if (!expectedContextMatches(context, record) || tests === null || tests.files < 1 || tests.tests < 1
      || tests.tests !== tests.passed + tests.failed + tests.skipped + tests.todo || tests.failed !== 0 || tests.skipped !== 0
      || tests.todo !== 0 || tests.passed !== tests.tests || JSON.stringify(requiredCases) !== JSON.stringify(EXPECTED_REQUIRED_CASES)
      || iconVerified !== true
      || nativeAbi.node === null || nativeAbi.electron === null) return false;
    return await withReleaseInvariantLease(record, async (lease) => {
      if (!metadataInvariant(record, context, lease) || !updateAndIconInvariant(lease) || !buildInputInvariant(lease)) return false;
      const policy = await testDeps.loadReleaseToolchainPolicy();
      return nativeToolchainInvariant(policy, context, nativeAbi, bindings);
    });
  }

  async function runPreflight(input) {
    const values = exactOrdinaryObject(input, ['context', 'dependencyBootstrap'], 'Preflight input');
    const record = knownRecord(values.dependencyBootstrap);
    if (record.phase === 'CONSUMED') {
      if (record.closeError) throw record.closeError;
      throw new Error('Dependency bootstrap phase is invalid.');
    }
    if (record.phase !== 'METADATA_PREPARED') {
      record.phase = 'POISONED';
      await closeRecord(record);
      throw new Error('Dependency bootstrap phase is invalid.');
    }
    record.phase = 'CONSUMED';
    const context = values.context;
    try { await record.handle.recheck(); } catch (error) {
      try { await closeRecord(record); } catch { }
      throw error;
    }
    if (!expectedContextMatches(context, record)) {
      await closeRecord(record);
      throw new Error('Preflight context identity is invalid.');
    }
    if (testDeps.dependencyIdentity() !== record.dependencyIdentity) {
      await closeRecord(record);
      throw new Error('Preflight dependency identity is invalid.');
    }
    record.context = context;
    contextOwners.add(context);
    contextBindings.set(context, record.gateBinding);
    const commands = [];
    const checks = [];
    let tests = null;
    let requiredCases = null;
    let iconVerified = false;
    const nativeAbi = { node: null, electron: null };
    let failedStage = null;
    let failedCategory = null;
    try {
      for (const row of EXPECTED_LIFECYCLE_ROWS) {
        try { await validateLifecycleBoundary(record, row); } catch { failedStage = 'npm-ci'; failedCategory = 'verification-failed'; break; }
        const result = await safeTrustedCommand(row.descriptorId, record);
        if (!result || result.status !== 'PASS') { failedStage = 'npm-ci'; failedCategory = result?.category ?? 'execution'; commands.push(commandRow('npm-ci', runnerFailure(result), 0)); break; }
        try { await validateLifecycleBoundary(record, row); } catch { failedStage = 'npm-ci'; failedCategory = 'verification-failed'; break; }
      }
      if (!failedStage) {
        try {
          const finalTree = await scanCanonicalTree(await canonicalPath(record.workspaceRoot, 'node_modules', 'directory'));
          const electron = await stableRead(await canonicalPath(record.workspaceRoot, 'node_modules/electron/dist/electron.exe', 'file'));
          if (!exactTree(finalTree, EXPECTED_FINAL_TREE)
            || testDeps.sha256Bytes(electron.bytes) !== '588bd82e36ad1acdae4615b6336284e420704389864f54ef2d10ea66c1a3cde0') throw new Error('Final tree drifted.');
        } catch { failedStage = 'npm-ci'; failedCategory = 'verification-failed'; }
      }
      if (!failedStage) commands.push(commandRow('npm-ci', { status: 'PASS', category: null, exitCode: 0 }, 0));
      else if (commands.length === 0) commands.push(commandRow('npm-ci', { status: 'FAIL', category: failedCategory, exitCode: null }, 0));

      const commandAggregate = async (stageId, descriptors) => {
        if (failedStage) return;
        for (const descriptor of descriptors) {
          if (stageId === 'build') {
            try { await assertRootDotenvAbsent(record.workspaceRoot); } catch { failedStage = stageId; commands.push(commandRow(stageId, { status: 'FAIL', category: 'verification-failed', exitCode: null }, 0)); return; }
          }
          const result = await safeTrustedCommand(descriptor, record);
          if (!result || result.status !== 'PASS') {
            if (stageId === 'test') {
              const summary = trustworthyTestCounts(result?.tests);
              if (result?.category === 'child-nonzero' && summary !== null && Array.isArray(result.requiredCases)) {
                tests = summary;
                requiredCases = freezeDeep([...result.requiredCases]);
              } else if (result?.category === 'child-nonzero') {
                tests = null;
                requiredCases = null;
                failedStage = stageId;
                commands.push(commandRow(stageId, { status: 'FAIL', category: 'invalid-output', exitCode: null }, 0));
                return;
              }
            }
            failedStage = stageId;
            commands.push(commandRow(stageId, result, 0));
            return;
          }
          if (stageId === 'build') {
            try { await assertRootDotenvAbsent(record.workspaceRoot); } catch { failedStage = stageId; commands.push(commandRow(stageId, { status: 'FAIL', category: 'verification-failed', exitCode: null }, 0)); return; }
          }
          if (stageId === 'test') {
            const summary = result.tests;
            const observed = trustworthyTestCounts(summary);
            const clean = observed !== null && observed.files >= 1 && observed.tests >= 1
              && observed.failed === 0 && observed.skipped === 0 && observed.todo === 0 && observed.passed === observed.tests;
            if (!clean) {
              tests = null;
              requiredCases = null;
              failedStage = stageId;
              commands.push(commandRow(stageId, { status: 'FAIL', category: 'invalid-output', exitCode: null }, 0));
              return;
            }
            tests = observed;
            requiredCases = Array.isArray(result.requiredCases) ? freezeDeep([...result.requiredCases]) : null;
            if (JSON.stringify(requiredCases) !== JSON.stringify(EXPECTED_REQUIRED_CASES)) {
              failedStage = stageId;
              commands.push(commandRow(stageId, { status: 'FAIL', category: 'verification-failed', exitCode: null }, 0));
              return;
            }
          }
        }
        commands.push(commandRow(stageId, { status: 'PASS', category: null, exitCode: 0 }, 0));
      };
      await commandAggregate('typecheck', ['typecheck', 'typecheck-ipc']);
      await commandAggregate('lint', ['lint']);
      await commandAggregate('test', ['test-full']);
      await commandAggregate('build', ['build-main', 'build-preload', 'build-renderer']);

      const check = async (id, action) => {
        if (failedStage) return;
        let passed = false;
        try { passed = await action(); } catch { passed = false; }
        checks.push(checkRow(id, passed, 0));
        if (!passed) failedStage = id;
      };
      await check('security-static-checks', async () => {
        return await withPostInstallBindingsLease(record.workspaceRoot, context, async (_bindings, lease) => {
          const imported = await importPostInstallModule(record.workspaceRoot, lease, 'scripts/release/lib/security-checklist.mjs');
          if (typeof imported.runSecurityChecklist !== 'function') return false;
          await record.handle.recheck();
          const rows = await imported.runSecurityChecklist({ workspaceRoot: record.workspaceRoot });
          await record.handle.recheck();
          return Array.isArray(rows) && rows.length === EXPECTED_SECURITY_IDS.length
            && rows.every((row, index) => row.id === EXPECTED_SECURITY_IDS[index] && row.status === 'PASS');
        });
      });
      await check('icon-verify', async () => {
        iconVerified = (await safeTrustedCommand('icon-verify', record)).status === 'PASS';
        return iconVerified;
      });
      await check('node-native-abi', async () => {
        const result = await safeTrustedCommand('node-abi-probe', record);
        const expected = { schemaVersion: 1, runtime: 'node', nodeVersion: 'v24.15.0', electronVersion: null, modulesAbi: '137', napi: '10', platform: 'win32', arch: 'x64', sqliteVersion: '3.53.4', status: 'PASS' };
        if (!result || result.status !== 'PASS' || !probeEqual(result.result, expected)) return false;
        nativeAbi.node = result.result;
        return true;
      });
      await check('electron-native-abi', async () => {
        const result = await safeTrustedCommand('electron-abi-probe', record);
        const expected = { schemaVersion: 1, runtime: 'electron-run-as-node', nodeVersion: 'v22.16.0', electronVersion: '35.7.5', modulesAbi: '133', napi: '10', platform: 'win32', arch: 'x64', sqliteVersion: '3.53.4', status: 'PASS' };
        if (!result || result.status !== 'PASS' || !probeEqual(result.result, expected)) return false;
        nativeAbi.electron = result.result;
        return true;
      });
      await check('release-invariants', async () => await withPostInstallBindingsLease(record.workspaceRoot, context,
        async (bindings) => await runReleaseInvariantsCore(record, context, tests, requiredCases, iconVerified, nativeAbi, bindings)));

      const status = failedStage ? 'FAIL' : 'PASS';
      const report = {
        schemaVersion: 1, stage: 'preflight', contextId: context.contextId, status,
        blocker: failedStage ? `Preflight ${failedStage} failed` : null,
        releaseMetadata: { relativePath: context.metadataPath, sha256: context.metadataSha256 },
        packageLockSha256: context.packageLockSha256,
        toolchain: { ...context.toolchain, electronBuilderVersion: '26.15.3' },
        commands, checks, nativeAbi, tests,
      };
      const parsed = record.preflightSchema.parse(report);
      await record.handle.recheck();
      const evidence = await publishParsedPreflightReport(record.workspaceRoot, parsed, record.preflightSchema);
      await record.handle.recheck();
      return freezeDeep({
        stage: 'preflight', contextId: context.contextId, scope: 'closed_beta_required', status,
        evidence: [evidence], blocker: report.blocker,
      });
    } finally {
      await closeRecord(record);
    }
  }

  async function loadPostInstallBindings(input) {
    const values = exactOrdinaryObject(input, ['workspaceRoot', 'context'], 'Binding input');
    assertWorkspace(values.workspaceRoot);
    return await withPostInstallBindingsLease(values.workspaceRoot, values.context, async (bindings) => bindings);
  }

  function reportMatchesContext(report, context) {
    const expectedNode = { schemaVersion: 1, runtime: 'node', nodeVersion: 'v24.15.0', electronVersion: null, modulesAbi: '137', napi: '10', platform: 'win32', arch: 'x64', sqliteVersion: '3.53.4', status: 'PASS' };
    const expectedElectron = { schemaVersion: 1, runtime: 'electron-run-as-node', nodeVersion: 'v22.16.0', electronVersion: '35.7.5', modulesAbi: '133', napi: '10', platform: 'win32', arch: 'x64', sqliteVersion: '3.53.4', status: 'PASS' };
    return report && report.status === 'PASS' && report.blocker === null && report.contextId === context.contextId
      && report.releaseMetadata.relativePath === context.metadataPath
      && report.releaseMetadata.sha256 === context.metadataSha256
      && report.packageLockSha256 === context.packageLockSha256
      && canonicalKnownValue(report.toolchain) === canonicalKnownValue({ ...context.toolchain, electronBuilderVersion: '26.15.3' })
      && JSON.stringify(report.commands.map(({ id, status }) => ({ id, status })))
        === JSON.stringify(['npm-ci', 'typecheck', 'lint', 'test', 'build'].map((id) => ({ id, status: 'PASS' })))
      && JSON.stringify(report.checks.map(({ id, status }) => ({ id, status })))
        === JSON.stringify(EXPECTED_SECURITY_IDS.length === 8 ? ['security-static-checks', 'icon-verify', 'node-native-abi', 'electron-native-abi', 'release-invariants'].map((id) => ({ id, status: 'PASS' })) : [])
      && report.tests && report.tests.files >= 1 && report.tests.tests >= 1 && report.tests.passed === report.tests.tests
      && report.tests.failed === 0 && report.tests.skipped === 0 && report.tests.todo === 0
      && probeEqual(report.nativeAbi.node, expectedNode) && probeEqual(report.nativeAbi.electron, expectedElectron);
  }

  async function readPublishedPreflightUnderLease(workspaceRoot, context, lease, referenceSha = null) {
    const held = [];
    let primary = null;
    try {
      const reportEntry = await holdStableFile(workspaceRoot, 'release-validation/reports/preflight.json', held);
      if (referenceSha !== null && reportEntry.sha256 !== referenceSha) throw new Error('Bound preflight report hash drifted.');
      const imported = await importPostInstallModule(workspaceRoot, lease, 'scripts/release/lib/report-schema.mjs');
      if (!imported.PreflightReportSchema || typeof imported.PreflightReportSchema.parse !== 'function') throw new Error('Preflight report schema is unavailable.');
      const report = imported.PreflightReportSchema.parse(parseHeldJson(reportEntry, 'Preflight report'));
      if (!reportMatchesContext(report, context)) throw new Error('Preflight report is stale.');
      await recheckHeldFiles(held);
      return freezeDeep({ report, sha256: reportEntry.sha256 });
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      let cleanup = null;
      try { await closeHeldFiles(held); } catch (error) { cleanup = error; }
      if (!primary && cleanup) throw cleanup;
    }
  }

  function releaseFactsFromMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
      || metadata.metadataSchemaVersion !== 1 || metadata.purpose !== 'candidate'
      || metadata.version !== '1.0.1-rc.1' || metadata.channel !== 'rc'
      || metadata.branch !== 'task15' || metadata.dirty !== false
      || typeof metadata.buildTimeUtc !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(metadata.buildTimeUtc)) {
      throw new Error('Frozen release metadata is invalid.');
    }
    const time = Date.parse(metadata.buildTimeUtc);
    if (!Number.isFinite(time) || new Date(time).toISOString().replace('.000Z', 'Z') !== metadata.buildTimeUtc) throw new Error('Frozen release metadata time is invalid.');
    return freezeDeep({
      branch: metadata.branch,
      dirty: metadata.dirty,
      commitSha: metadata.commitSha,
      packageLockSha256: metadata.lockfileSha256,
      releaseNotesSha256: metadata.releaseNotesSha256,
      sourceDateEpoch: Math.floor(time / 1000),
      toolchain: {
        nodeVersion: metadata.nodeVersion,
        npmVersion: metadata.npmVersion,
        electronVersion: metadata.electronVersion,
        platform: metadata.platform,
        arch: metadata.arch,
      },
    });
  }

  async function loadFrozenPreflightContext(input) {
    const { workspaceRoot } = exactOrdinaryObject(input, ['workspaceRoot'], 'Frozen context input');
    assertWorkspace(workspaceRoot);
    const held = [];
    let primary = null;
    try {
      const metadataEntry = await holdStableFile(workspaceRoot, 'release-validation/staging/release-metadata.json', held);
      const metadata = parseHeldJson(metadataEntry, 'Frozen release metadata');
      const releaseFacts = releaseFactsFromMetadata(metadata);
      const gate = await readGateSnapshot(workspaceRoot, releaseFacts.sourceDateEpoch);
      if (!sameFacts(gate.facts, releaseFacts)) throw new Error('Frozen release gate drifted.');
      const preparedMetadata = freezeDeep({ relativePath: 'release-validation/staging/release-metadata.json', sha256: metadataEntry.sha256 });
      const context = await testDeps.createReleaseContext({ workspaceRoot, releaseFacts, preparedMetadata });
      contextOwners.add(context);
      contextBindings.set(context, gate.binding);
      const result = await withPostInstallBindingsLease(workspaceRoot, context, async (_bindings, lease) => {
        const published = await readPublishedPreflightUnderLease(workspaceRoot, context, lease);
        return freezeDeep({ context, preflightReference: { reportPath: 'release-validation/reports/preflight.json', reportSha256: published.sha256, itemId: 'ARTIFACT-PREFLIGHT' } });
      });
      await recheckHeldFiles(held);
      return result;
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      let cleanup = null;
      try { await closeHeldFiles(held); } catch (error) { cleanup = error; }
      if (!primary && cleanup) throw cleanup;
    }
  }

  async function loadBoundPreflightReport(input) {
    const values = exactOrdinaryObject(input, ['workspaceRoot', 'context', 'preflightReference'], 'Bound report input');
    assertWorkspace(values.workspaceRoot);
    const reference = exactOrdinaryObject(values.preflightReference, ['reportPath', 'reportSha256', 'itemId'], 'Preflight reference');
    if (reference.reportPath !== 'release-validation/reports/preflight.json' || reference.itemId !== 'ARTIFACT-PREFLIGHT' || !/^[a-f0-9]{64}$/u.test(reference.reportSha256)) throw new Error('Preflight reference is invalid.');
    return await withPostInstallBindingsLease(values.workspaceRoot, values.context, async (bindings, lease) => {
      const published = await readPublishedPreflightUnderLease(values.workspaceRoot, values.context, lease, reference.reportSha256);
      return freezeDeep({ report: published.report, bindings });
    });
  }

  function canonicalTreeFixture(rows) {
    const normalized = [...rows].sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0)
      .map((row) => ({ relativePath: row.relativePath, size: row.size, fileSha256: row.fileSha256 }));
    const bytes = `${JSON.stringify(normalized)}\n`;
    return { bytes, sha256: testDeps.sha256Text ? testDeps.sha256Text(bytes) : testDeps.sha256Bytes(testDeps.utf8Bytes(bytes)) };
  }

  return Object.freeze({
    runEarlyGitPackageGate,
    prepareDependencyBootstrap,
    prepareReleaseMetadata,
    runPreflight,
    loadPostInstallBindings,
    loadBoundPreflightReport,
    loadFrozenPreflightContext,
    canonicalTreeFixture,
    testOnly: Object.freeze({
      initializeReleaseDirectories,
      quarantinePreflightEvidence,
      writePreparedMetadata,
      publishPreflightReport,
      runProtectedImportEpoch,
    }),
  });
}
/* WORKBENCH_RELEASE_PREFLIGHT_CORE_V1_END */

const PRODUCTION_CORE = createPreflightCore(PRODUCTION_DEPS);

export async function runEarlyGitPackageGate(input) {
  return PRODUCTION_CORE.runEarlyGitPackageGate(input);
}

export async function prepareDependencyBootstrap(input) {
  return PRODUCTION_CORE.prepareDependencyBootstrap(input);
}

export async function prepareReleaseMetadata(input) {
  return PRODUCTION_CORE.prepareReleaseMetadata(input);
}

export async function runPreflight(input) {
  return PRODUCTION_CORE.runPreflight(input);
}

export async function loadPostInstallBindings(input) {
  return PRODUCTION_CORE.loadPostInstallBindings(input);
}

export async function loadBoundPreflightReport(input) {
  return PRODUCTION_CORE.loadBoundPreflightReport(input);
}

export async function loadFrozenPreflightContext(input) {
  return PRODUCTION_CORE.loadFrozenPreflightContext(input);
}

async function directCli() {
  if (process.argv.length !== 2) throw new Error('Release preflight accepts no arguments.');
  const releaseFacts = await runEarlyGitPackageGate({ workspaceRoot: WORKSPACE_ROOT });
  const dependencyBootstrap = await prepareDependencyBootstrap({ workspaceRoot: WORKSPACE_ROOT, releaseFacts });
  const preparedMetadata = await prepareReleaseMetadata({ workspaceRoot: WORKSPACE_ROOT, releaseFacts, dependencyBootstrap });
  const context = createReleaseContext({ workspaceRoot: WORKSPACE_ROOT, releaseFacts, preparedMetadata });
  const result = await runPreflight({ context, dependencyBootstrap });
  if (result.status !== 'PASS') throw new Error('Release preflight failed.');
  process.stdout.write('Release preflight passed.\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await directCli();
  } catch {
    process.stderr.write('Release preflight failed.\n');
    process.exitCode = 1;
  }
}
