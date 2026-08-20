import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isProxy } from 'node:util/types'
import vm from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { PreflightReportSchema } from '../../scripts/release/lib/report-schema.mjs'

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const preflightPath = path.join(workspaceRoot, 'scripts', 'release', 'preflight.mjs')
const probePath = path.join(workspaceRoot, 'scripts', 'release', 'native-abi-probe.mjs')
const runnerPath = path.join(workspaceRoot, 'scripts', 'release', 'lib', 'trusted-windows-runner.mjs')
const packagePath = path.join(workspaceRoot, 'package.json')
const CORE_START = '/* WORKBENCH_RELEASE_PREFLIGHT_CORE_V1_START */'
const CORE_END = '/* WORKBENCH_RELEASE_PREFLIGHT_CORE_V1_END */'
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b6c5f49654f40045d4cff6612c004b67b4b2509cd2bd078a36ec185a11def4d3'
const SHA_C = 'bfa0a4dcd5dc22ab614265c4df89d199cd7ee488c64d55821fe087a7b8d414fc'
const SHA_D = '0778d80a4d4db6389d39c6364ae3b7a5742fc291429feffc62a0ce53942ed774'
const SHA_E = '071f4e1c4913155b09998294675f870d5633c68e34edeb165e4e116263a9e6ed'
const REQUIRED_CASES = [
  'migration', 'current-schema', 'future-schema', 'legacy-safety',
  'sentinel-redaction', 'diagnostics-bounds',
]
const STAGE_IDS = [
  'npm-ci', 'typecheck', 'lint', 'test', 'build',
  'security-static-checks', 'icon-verify',
  'node-native-abi', 'electron-native-abi', 'release-invariants',
] as const
const SECURITY_IDS = [
  'permissions-default-standard',
  'renderer-node-integration-disabled',
  'renderer-context-isolation-enabled',
  'renderer-sandbox-enabled',
  'single-instance-lock-enabled',
  'nsis-current-user',
  'code-signing-hook-prepared',
  'dangerous-git-mutations-absent',
]
const PRE_LIFECYCLE_TREE = {
  fileCount: 26_863,
  totalBytes: 673_636_131,
  treeSha256: '075e9bc083e4e2010b46f97b31c5a07c8b4ee5dbbd825e572f2252c578f6e939',
}
const FINAL_TREE = {
  fileCount: 26_939,
  totalBytes: 973_620_188,
  treeSha256: '7cfa28860bfdce9c3ddc289b1aefcb84989eb84cb88585ac95021110a0349a39',
}
const LIFECYCLE_ROWS = [
  {
    descriptorId: 'lifecycle-electron-install',
    id: 'electron-install',
    packageName: 'electron',
    packageVersion: '35.7.5',
    workingDirectoryRelativePath: 'electron',
    entryRelativePath: 'electron/install.js',
    entrySha256: '3fa1166ed4db6831ed0d1aeec05295e460127d92b1216c794719e817eaefe0fb',
    arguments: [],
  },
  {
    descriptorId: 'lifecycle-esbuild-install',
    id: 'esbuild-install',
    packageName: 'esbuild',
    packageVersion: '0.28.1',
    workingDirectoryRelativePath: 'esbuild',
    entryRelativePath: 'esbuild/install.js',
    entrySha256: '612294e278914443bdcf81cb17f54afec34dbdd2ebd999a6ee187912320cc315',
    arguments: [],
  },
  {
    descriptorId: 'lifecycle-electron-winstaller',
    id: 'electron-winstaller-select-7z',
    packageName: 'electron-winstaller',
    packageVersion: '5.4.0',
    workingDirectoryRelativePath: 'electron-winstaller',
    entryRelativePath: 'electron-winstaller/script/select-7z-arch.js',
    entrySha256: '3819ea164df4ab1d23a6e3f8a551f2029974aead10422f929d2ad169ef3049f4',
    arguments: [],
  },
] as const

const PACKAGE_ROWS = [
  ['electron', '35.7.5', 'sha512-dnL+JvLraKZl7iusXTVTGYs10TKfzUi30uEDTqsmTm0guN9V2tbOjTzyIZbh9n3ygUjgEYyo+igAwMRXIi3IPw==', 'node_modules/electron', '9eda212a301d09b8989e83732ef0240e1a5ac086a4b90f0831c97636e9dde459'],
  ['electron-builder', '26.15.3', 'sha512-a1KM5heqS3gQCZzizXEI8RjJy3QVogULPdeSknt76uLDpBIW/HDGsMg/XgP0riP6PI9COsRvFITKKGDqA8fJxA==', 'node_modules/electron-builder', 'd38a29884694610279ade4f4bf1617df9e47da68b84675989bc36932e71d3f22'],
  ['vitest', '3.2.7', 'sha512-KrxIJ62Fd89gfysR4WotlgZABiz2dqFPgqGzX7s+CwsqLFomRH7777ZcrOD6+WVAh7khPQP41A+BKbpcJFrdEg==', 'node_modules/vitest', 'fb8aa3d162a068e84f09b5a2cfcb1e59772067ff3a407932cb4958d049cd6046'],
  ['typescript', '5.9.3', 'sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==', 'node_modules/typescript', '8b9422b44531353f953a937e4093215c5e90c051da5699f20e5c578799036584'],
  ['eslint', '9.39.5', 'sha512-DgZS62aPLXKlnxILS/AYCoRvHaZeXceIzlXPkkGGzJWSow1aEk0lbTlxUSlyjC8jcaKxAdOnTDz+o1JFSBsyjw==', 'node_modules/eslint', 'ef8342aeedd83e6cc0acbae0a861126355510de8bcd7e297e4272974d6b55cbe'],
  ['vite', '7.3.6', 'sha512-4XP60spRGjSZFf1qYH+dJIkK2znL3zQfl9KkOV9MkkRR/3Dls0dxaBsQPTloEc5BLXWPL9vsOxopxyKoMmDueg==', 'node_modules/vite', 'b59653125a14f0b7c9f70b402b4f36335df7856688212ee18f768aa3a97b4fd2'],
  ['better-sqlite3', '13.0.2', 'sha512-jW6oufeDhXZaiX9Lw5A+oerVClx4iFrI6uDj1zu7SqUAjak9vbJvA0NEcKLNxHiQHb6kYCoFzzXYV0YOauhV3g==', 'node_modules/better-sqlite3', 'ed22ed6ad00b2ee638cae760bd05361e00c270adbf73f9972d8ead4f9a73b71d'],
  ['zod', '4.4.3', 'sha512-ytENFjIJFl2UwYglde2jchW2Hwm4GJFLDiSXWdTrJQBIN9Fcyp7n4DhxJEiWNAJMV1/BqWfW/kkg71UDcHJyTQ==', 'node_modules/zod', '0c29c0a5070d1107ce01674d22d5c9b5b2e640bbdb2a681354dc799b4e8f5017'],
  ['semver', '7.8.5', 'sha512-Y7/KDsb8LjooZpwaqGyulO6DQlksgCncchHGk+sZIY4SBvUocMBEFH5Ur1fI4dV+Jvl0w6cjvucaIi40puRioA==', 'node_modules/semver', '89fd78f66becbf372f2b782af8bf4bdbc77a76ac9b4454b59023466c113049f6'],
  ['node-abi', '4.33.0', 'sha512-vLBWCKb+7LWsX+TbfzWOkw0W81m377tyx3hOweBTjO43CXZnRGS1/JPWs20fr0PgZyDXk6ROYrylsEycK8raDA==', 'node_modules/node-abi', '26cc3680ab464f985f1213bc14455456eb565ddb3cc9fd1fe5a1abcb9c6b5dc6'],
] as const
const PACKAGE_ENTRY_ROWS = [
  ['electron-executable', 'electron', 'node_modules/electron/dist/electron.exe', '588bd82e36ad1acdae4615b6336284e420704389864f54ef2d10ea66c1a3cde0'],
  ['electron-entry', 'electron', 'node_modules/electron/index.js', '46a7d3a2da5d96cd693612e5c3ec407c38ac9c15c44f97ad2be478cbcf80b43c'],
  ['electron-builder-cli', 'electron-builder', 'node_modules/electron-builder/cli.js', 'b61356c9f3a890e6d1e523b15c431802d3edf4833bb625c5cedf1c8405ec1886'],
  ['vitest-cli', 'vitest', 'node_modules/vitest/vitest.mjs', '39db22f579acf5639bbb17a261408debbde03f4692c0c439e77e7f13aeba74d6'],
  ['typescript-cli', 'typescript', 'node_modules/typescript/bin/tsc', '8d5fa5bd883fec0979fc2004f1fe1d99aef40570155d550eadc0b03b55513bf0'],
  ['eslint-cli', 'eslint', 'node_modules/eslint/bin/eslint.js', '6280b95e2a6ab3b04be45cbd3b1627654be518e6a4da163ec0adcbba9cd5fcd8'],
  ['vite-cli', 'vite', 'node_modules/vite/bin/vite.js', 'fa03478846d229651a3c6aa64833ba2c6cbf580a798b92bd8f47c7480bafb5d8'],
  ['better-sqlite3-win32-loader', 'better-sqlite3', 'node_modules/better-sqlite3/lib/win32-x64.js', 'c25867a2e904a367743498377e6e156a653bd10bcc5f9be7cbdf8a28359012ef'],
  ['better-sqlite3-prebuild', 'better-sqlite3', 'node_modules/better-sqlite3/prebuilds/win32-x64.node', 'ecfb86221a674a6cdba63b1ac162b99386a61d0e38934b6c3dfcd9da11b6ee26'],
  ['zod-entry', 'zod', 'node_modules/zod/index.js', 'c733a1897d6b4b30dad6998597f6896b265b094a65534359ada34b08ecf8932c'],
  ['semver-entry', 'semver', 'node_modules/semver/index.js', '4b3e57d3d40e29e0706002eba113d09f35aea593578376bbeec83b777b9912ab'],
  ['node-abi-entry', 'node-abi', 'node_modules/node-abi/index.js', '9ca655944bbb3bcd347523770f9c0109823e61959c76e5ec860d93ded5251c37'],
] as const
const WORKSPACE_ENTRY_ROWS = [
  ['preflight', 'scripts/release/preflight.mjs'],
  ['native-abi-probe', 'scripts/release/native-abi-probe.mjs'],
  ['vitest-preflight-reporter', 'scripts/release/vitest-preflight-reporter.mjs'],
  ['trusted-windows-runner', 'scripts/release/lib/trusted-windows-runner.mjs'],
  ['release-toolchain-policy', 'scripts/release/release-toolchain.json'],
  ['release-metadata', 'scripts/lib/release-metadata.mjs'],
  ['release-context', 'scripts/release/lib/release-context.mjs'],
  ['release-common', 'scripts/release/lib/common.mjs'],
  ['report-schema', 'scripts/release/lib/report-schema.mjs'],
  ['security-checklist', 'scripts/release/lib/security-checklist.mjs'],
  ['icon-generator', 'scripts/generate-app-icons.mjs'],
  ['package-manifest', 'package.json'],
  ['vitest-config', 'vitest.config.ts'],
  ['vite-main-config', 'vite.main.config.ts'],
  ['vite-preload-config', 'vite.preload.config.ts'],
  ['vite-renderer-config', 'vite.renderer.config.ts'],
  ['electron-builder-config', 'electron-builder.yml'],
  ['eslint-config', 'eslint.config.mjs'],
  ['tsconfig', 'tsconfig.json'],
  ['tsconfig-node', 'tsconfig.node.json'],
  ['tsconfig-ipc', 'tests/typecheck/tsconfig.json'],
  ['migration-test', 'src/main/database/__tests__/Migration.test.ts'],
  ['release-migration-test', 'src/main/database/__tests__/ReleaseMigration.test.ts'],
  ['legacy-safety-test', 'src/main/database/__tests__/DatabaseLegacySafety.test.ts'],
  ['diagnostics-release-test', 'src/main/diagnostics/__tests__/DiagnosticsExporter.release.test.ts'],
] as const
const REVIEWED_TASK2C1_RUNNER_SHA256 = '0a76dee989f1d5fd612f2ed6fa881252b4f7b3355a1a72cd9c9138cc8918e62d'
const REVIEWED_TASK2C1_POLICY_SHA256 = 'fc50d2c63b4f3ea0049853ab6965fc96c6dc9397a35ab1b277a858b7b287eb8a'
const PRE_ACL_DEDUP_REVIEWED_RUNNER_SHA256 = 'c9c86598c36581f09d23e44c62c177a49d164fd513c495437fa09de954eb1fb5'
const PRE_HANDLE_FIX_REVIEWED_RUNNER_SHA256 = '2c2967f3e19cf1ea96e9ac4ceb074ff1572ead1617e3aeae82c9e8cdd0e74f5a'
const PRE_TASK2C1_REVIEWED_INPUT_HASHES = Object.freeze({
  'scripts/release/lib/trusted-windows-runner.mjs': '9bc7d0789fa581294d781d97035dadcd1f9b30876644674e91e15db14e0c2fd4',
  'scripts/release/release-toolchain.json': '7bc34cc85df605d895c51a01613fbb94ad7c328fed15bf1aeae6090d48d1fa17',
})
const FIXED_WORKSPACE_HASHES: Readonly<Record<string, string>> = Object.freeze({
  'vitest-preflight-reporter': '3ac428e56102490c10db9f46670941056cf22192d8ae3b672916eff583b7e126',
  'trusted-windows-runner': REVIEWED_TASK2C1_RUNNER_SHA256,
  'release-toolchain-policy': REVIEWED_TASK2C1_POLICY_SHA256,
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
})

const FIXED_GATE_HASHES = Object.freeze([
  ['package-lock.json', 'b6c5f49654f40045d4cff6612c004b67b4b2509cd2bd078a36ec185a11def4d3'],
  ['docs/releases/1.0.1-rc.1.md', 'bfa0a4dcd5dc22ab614265c4df89d199cd7ee488c64d55821fe087a7b8d414fc'],
  ['src/shared/release-contract.json', '1f2f933c02d7e9044b1d8589bace6a98f76bdcd7559811c33f3e433562101fa2'],
  ['src/shared/update-bootstrap-contract.json', '664e5635d5ba212bf0a780eda10a98e1a01588bf4ecfeced395b2e18d69a1f44'],
  ['scripts/release/release-toolchain.json', REVIEWED_TASK2C1_POLICY_SHA256],
  ['scripts/release/lib/trusted-windows-runner.mjs', REVIEWED_TASK2C1_RUNNER_SHA256],
  ['scripts/generate-app-update-config.mjs', 'ae4421766bf24ec0b1ba23f97219eb2582b8aa29f6e711af94bc36277aadefb4'],
  ['scripts/generate-app-icons.mjs', '8ffa4aa293f85dfc5d78564e6817b5f675ec354fec0bb25c74f78aa23ecaeeaf'],
  ['docs/legal/ASSET-NOTICES.md', '87947993cd59c135080a06d0bfb31141b042f950a49e25e601c7098cc45aaa8a'],
  ['build-resources/app-update.yml', '883228a314cc013ea9d7e4f62f9859ff96c53fab0102318d13943f5562294cf4'],
  ['build-resources/app-icon.svg', '3d48d7bc072679da986e342f56b27bbbb7640fd64ccf31cf50e6c82ac0260107'],
  ['build-resources/app-icon.png', '6de378570f189a47d0850b38073d54ca16da0cde8ec35f231ecd0e7736015f45'],
  ['build-resources/app-icon.ico', 'dc967dc419c60b82d0d0d93ac4720eb4ada833587e54feb605f8115907fb7c84'],
  ['build-resources/installer.nsh', '63cea8762d24f0d8a0cf950ca9e9a7c24f62cd6b5ebd7ead57ac509427348b04'],
  ['electron-builder.yml', '65844860e3d54cee0a976ebfd5daf3d93d428e844084e09ab0bfad55e4a42209'],
  ['vitest.config.ts', 'c7e877b1573188ab25b04781da651eb4ad3674d0baf696d8b76313702a69ebff'],
  ['vite.main.config.ts', '9892468013514ca6e537351f5e34a6a4600a264d0730e90ff596e3d277e51d7b'],
  ['vite.preload.config.ts', '7121099745d5401a00200c2fe40162ebff9a4bfd97d7d808566f12cfed1f7b4d'],
  ['vite.renderer.config.ts', 'c7f243bde546d6a489b43ae34750bc592bfc7955c64ad72e981c9b201bfe7b9e'],
  ['eslint.config.mjs', '28c86477180fee94f4b601ddd9c2111ba3588c4ccc1a7a2f2f990fcf9a848f90'],
  ['tsconfig.json', 'c449d3ccd45ac70940025b1e921a419a36d8489baa227ac8294b57a782c02003'],
  ['tsconfig.node.json', '46228903de186a0607f04288399f7927ae65b4acae57ecfcefd450c474c5c45e'],
  ['tests/typecheck/tsconfig.json', '53877ce673543a223f9339257094391a955600f189fe9ca7bf8410a8498d3f5a'],
] as const)

type TestState = {
  calls: string[]
  writes: string[]
  contexts: unknown[]
  failAt?: string
  commandFailures: Record<string, unknown>
  gatePatch: Record<string, unknown>
  metadataBarrier?: Promise<void>
  metadataValue?: unknown
  directoryCloseFailure?: string
  dependencyIdentity: object
  createdContext?: ReturnType<typeof expectedContext>
  preTreePatch?: Record<string, unknown>
  finalTreePatch?: Record<string, unknown>
  canonicalRoot?: string
  virtualModel?: boolean
  realRelativePaths?: Set<string>
  capabilityCalls: string[]
  importCalls: string[]
  clockReads: number
  environmentReads: number
  virtualFiles?: Map<string, Uint8Array>
  virtualDirectories?: Set<string>
  virtualIdentities?: Map<string, string>
  directoryIdentityOverrides?: Record<string, string>
  openReadOverrides?: Record<string, { bytes: Uint8Array, afterReads: number }>
  invariantReadOverrides?: Record<string, { bytes: Uint8Array, afterReads: number }>
  openIdentityOverrides?: Record<string, string>
  readCounts?: Record<string, number>
  packageTreeDriftRoot?: string
  lastVirtualPath?: string
  currentTreeRoot?: string
  lifecycleCommands?: number
  policyPatch?: (value: Record<string, any>) => Record<string, any>
  hashOverrides?: Record<string, string>
  invariantHashOverrides?: Record<string, string>
  buildRootReads?: number
  electronHashReads?: number
  activeLifecycleDescriptor?: string
  lastLifecycleCommandCall?: string
  testSummaryMutation?: 'after-test'
  fixtureTree?: { fileCount: number, totalBytes: number, treeSha256: string }
}

const disposableRoots: string[] = []

afterEach(async () => {
  for (const root of disposableRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true })
  }
})

async function disposableRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  disposableRoots.push(root)
  return root
}

async function filesystemSnapshot(root: string): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = []
  const walk = async (directory: string) => {
    const names = await fs.readdir(directory)
    names.sort((left, right) => left.localeCompare(right, 'en', { sensitivity: 'variant' }))
    for (const name of names) {
      const absolute = path.join(directory, name)
      const relativePath = path.relative(root, absolute).replaceAll('\\', '/')
      const stat = await fs.lstat(absolute)
      if (stat.isSymbolicLink()) {
        rows.push({ relativePath, kind: 'reparse', target: await fs.readlink(absolute) })
      } else if (stat.isDirectory()) {
        rows.push({ relativePath, kind: 'directory' })
        await walk(absolute)
      } else {
        const bytes = await fs.readFile(absolute)
        rows.push({
          relativePath,
          kind: 'file',
          size: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        })
      }
    }
  }
  await walk(root)
  return rows
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const member of Object.values(value)) deepFreeze(member)
    Object.freeze(value)
  }
  return value
}

function expectedFacts() {
  return deepFreeze({
    branch: 'task15',
    dirty: false,
    commitSha: SHA_A,
    packageLockSha256: SHA_B,
    releaseNotesSha256: SHA_C,
    sourceDateEpoch: 1_700_000_000,
    toolchain: {
      nodeVersion: 'v24.15.0',
      npmVersion: '11.12.1',
      electronVersion: '35.7.5',
      platform: 'win32',
      arch: 'x64',
    },
  })
}

function expectedPrepared() {
  return deepFreeze({
    relativePath: 'release-validation/staging/release-metadata.json',
    sha256: SHA_E,
  })
}

function validMetadata(overrides: Record<string, unknown> = {}) {
  return deepFreeze({
    metadataSchemaVersion: 1, purpose: 'candidate', productName: 'Claude Workbench', appId: 'com.claudeworkbench.app',
    version: '1.0.1-rc.1', channel: 'rc', buildId: '1.0.1-rc.1+aaaaaaaaaaaa.20231114T221320Z',
    branch: 'task15', commitSha: SHA_A, commitShort: 'aaaaaaaaaaaa', dirty: false, buildTimeUtc: '2023-11-14T22:13:20Z',
    nodeVersion: 'v24.15.0', npmVersion: '11.12.1', electronVersion: '35.7.5', sqliteSchemaVersion: 7,
    platform: 'win32', arch: 'x64', lockfileSha256: SHA_B, releaseNotesSha256: SHA_C,
    ...overrides,
  })
}

function expectedContext() {
  return deepFreeze({
    contextId: SHA_D,
    schemaVersion: 1,
    branch: 'task15',
    dirty: false,
    commitSha: SHA_A,
    version: '1.0.1-rc.1',
    channel: 'rc',
    buildId: '1.0.1-rc.1+aaaaaaaaaaaa.20231114T221320Z',
    metadataPath: 'release-validation/staging/release-metadata.json',
    metadataSha256: SHA_E,
    packageLockSha256: SHA_B,
    releaseNotesSha256: SHA_C,
    sourceDateEpoch: 1_700_000_000,
    toolchain: {
      nodeVersion: 'v24.15.0',
      npmVersion: '11.12.1',
      electronVersion: '35.7.5',
      platform: 'win32',
      arch: 'x64',
    },
  })
}

function nodeProbe() {
  return deepFreeze({
    schemaVersion: 1,
    runtime: 'node',
    nodeVersion: 'v24.15.0',
    electronVersion: null,
    modulesAbi: '137',
    napi: '10',
    platform: 'win32',
    arch: 'x64',
    sqliteVersion: '3.53.4',
    status: 'PASS',
  })
}

function electronProbe() {
  return deepFreeze({
    schemaVersion: 1,
    runtime: 'electron-run-as-node',
    nodeVersion: 'v22.16.0',
    electronVersion: '35.7.5',
    modulesAbi: '133',
    napi: '10',
    platform: 'win32',
    arch: 'x64',
    sqliteVersion: '3.53.4',
    status: 'PASS',
  })
}

function expectedBindings() {
  return deepFreeze({
    schemaVersion: 1,
    nodeModulesTree: { fileCount: 26_939, totalBytes: 973_620_188, treeSha256: '7cfa28860bfdce9c3ddc289b1aefcb84989eb84cb88585ac95021110a0349a39' },
    packages: PACKAGE_ROWS.map(([name, version, lockIntegrity, rootRelativePath, treeSha256]) => ({
      name, version, lockIntegrity, rootRelativePath, treeSha256,
    })),
    packageEntries: PACKAGE_ENTRY_ROWS.map(([id, packageName, relativePath, fileSha256]) => ({
      id, packageName, relativePath, fileSha256,
    })),
    workspaceEntries: WORKSPACE_ENTRY_ROWS.map(([id, relativePath]) => ({
      id,
      relativePath,
      fileSha256: FIXED_WORKSPACE_HASHES[id] ?? crypto.createHash('sha256').update(`workspace-${id}`).digest('hex'),
    })),
  })
}

function gateSnapshot(patch: Record<string, unknown> = {}) {
  return {
    workspaceIdentity: 'workspace-identity',
    branchRef: 'refs/heads/task15',
    head: SHA_A,
    candidateClean: true,
    packageBlobMatches: true,
    commitEpoch: 1_699_999_999,
    mainWorktrees: [{ branch: 'refs/heads/main', head: 'eb1a07bb950769cf24d0fe5c61c710fed4da0fba', bare: false, locked: false, prunable: false, clean: true }],
    packageVersion: '1.0.1-rc.1',
    lockVersion: '1.0.1-rc.1',
    rootLockVersion: '1.0.1-rc.1',
    packageLockSha256: SHA_B,
    releaseNotesSha256: SHA_C,
    fixedInputsValid: true,
    rootEntries: ['package.json', 'package-lock.json', '.env.example'],
    trackedEnvExample: true,
    ambientEnvironment: {},
    observedNowMs: 1_700_000_000_999,
    toolchain: expectedFacts().toolchain,
    ...patch,
  }
}

function newState(patch: Partial<TestState> = {}): TestState {
  return {
    calls: [],
    writes: [],
    contexts: [],
    commandFailures: {},
    gatePatch: {},
    dependencyIdentity: {},
    capabilityCalls: [],
    importCalls: [],
    clockReads: 0,
    environmentReads: 0,
    ...patch,
  }
}

function heldHandleCounts(state: TestState) {
  return [
    state.capabilityCalls.filter((call) => call.startsWith('open:')).length,
    state.capabilityCalls.filter((call) => call.startsWith('close:')).length,
  ]
}

type InvariantHandleAudit = {
  opened: Array<{ id: string, relativePath: string }>
  wrapperCloseCalls: Map<string, number>
  lowLevelCloseCalls: Map<string, number>
}

function assertEveryInvariantHandleClosedOnce(audit: InvariantHandleAudit) {
  expect(audit.opened.length).toBeGreaterThan(0)
  for (const { id } of audit.opened) {
    expect(audit.wrapperCloseCalls.get(id), `${id} wrapper close count`).toBe(1)
    expect(audit.lowLevelCloseCalls.get(id), `${id} low-level close count`).toBe(1)
  }
}

function makeDeps(state = newState()) {
  const record = (name: string) => state.calls.push(name)
  const model = state.virtualModel ?? state.canonicalRoot === undefined
  const canonicalRoot = state.canonicalRoot ?? workspaceRoot
  const posix = (value: string) => path.relative(canonicalRoot, value).replaceAll('\\', '/')
  const realFixturePath = (filePath: string) => state.realRelativePaths?.has(posix(filePath)) === true
  const encoder = new TextEncoder()
  if (model && !state.virtualFiles) {
    state.virtualFiles = new Map<string, Uint8Array>()
    for (const [name, version, _integrity, rootRelativePath] of PACKAGE_ROWS) {
      state.virtualFiles.set(`${rootRelativePath}/package.json`, encoder.encode(JSON.stringify({ name, version })))
    }
    for (const [id, _packageName, relativePath] of PACKAGE_ENTRY_ROWS) {
      state.virtualFiles.set(relativePath, encoder.encode(`fixture:${id}`))
    }
    for (const row of LIFECYCLE_ROWS) {
      state.virtualFiles.set(`node_modules/${row.entryRelativePath}`, encoder.encode(`fixture:${row.id}`))
      const packagePath = `node_modules/${row.workingDirectoryRelativePath}/package.json`
      if (!state.virtualFiles.has(packagePath)) state.virtualFiles.set(packagePath, encoder.encode(JSON.stringify({ name: row.packageName, version: row.packageVersion })))
    }
    const metadataText = `${JSON.stringify(validMetadata(), null, 2)}\n`
    state.virtualFiles.set('dist/main/index.js', encoder.encode(`const embedded=${JSON.stringify(metadataText)};\n`))
    state.virtualFiles.set('dist/main/permission-mcp.js', encoder.encode('module.exports = {};\n'))
    state.virtualFiles.set('dist/main/index.js.map', encoder.encode('{}\n'))
    state.virtualFiles.set('dist/main/permission-mcp.js.map', encoder.encode('{}\n'))
    state.virtualFiles.set('dist/preload/index.js', encoder.encode('module.exports = {};\n'))
    state.virtualFiles.set('dist/preload/index.js.map', encoder.encode('{}\n'))
    state.virtualFiles.set('dist/renderer/index.html', encoder.encode('<!doctype html><script src="./assets/app.js"></script>\n'))
    state.virtualFiles.set('dist/renderer/assets/app.js', encoder.encode('globalThis.__app = true;\n'))
    state.virtualDirectories = new Set(['release-validation', 'release-validation/reports', 'release-validation/staging'])
    state.virtualIdentities = new Map([...state.virtualFiles.keys()].map((entry) => [entry, crypto.createHash('sha256').update(`file:${entry}`).digest('hex')]))
  }
  const fixtureFileSha = (relativePath: string, bytes: Uint8Array) => {
    if (state.hashOverrides?.[relativePath]) return state.hashOverrides[relativePath]
    const packageEntry = PACKAGE_ENTRY_ROWS.find(([, , entryPath]) => entryPath === relativePath)
    if (packageEntry) return packageEntry[3]
    const lifecycle = LIFECYCLE_ROWS.find((row) => `node_modules/${row.entryRelativePath}` === relativePath)
    if (lifecycle) return lifecycle.entrySha256
    return crypto.createHash('sha256').update(bytes).digest('hex')
  }
  const fixtureRows = (rootRelativePath: string) => {
    const prefix = `${rootRelativePath}/`
    return [...(state.virtualFiles?.entries() ?? [])]
      .filter(([relativePath]) => relativePath.startsWith(prefix))
      .map(([relativePath, bytes]) => ({
        relativePath: relativePath.slice(prefix.length),
        size: bytes.length,
        fileSha256: fixtureFileSha(relativePath, bytes),
      }))
      .sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0)
  }
  const virtualWholeFact = () => {
    const rows = fixtureRows('node_modules')
    return {
      fileCount: rows.length,
      totalBytes: rows.reduce((total, row) => total + row.size, 0),
      treeSha256: crypto.createHash('sha256').update(`${JSON.stringify(rows)}\n`).digest('hex'),
    }
  }
  const packageTreeFixtures = new Map(PACKAGE_ROWS.map(([, , , rootRelativePath, treeSha256]) => [
    `${JSON.stringify(fixtureRows(rootRelativePath))}\n`,
    { rootRelativePath, treeSha256 },
  ]))
  const fixtureTree = virtualWholeFact()
  state.fixtureTree = fixtureTree
  const expectedPreTree = model ? { ...fixtureTree, ...state.preTreePatch } : PRE_LIFECYCLE_TREE
  const expectedFinalTree = model ? {
    ...fixtureTree,
    fileCount: (state.finalTreePatch?.fileCount as number | undefined) ?? fixtureTree.fileCount,
    totalBytes: (state.finalTreePatch?.totalBytes as number | undefined) ?? fixtureTree.totalBytes,
    treeSha256: (state.finalTreePatch?.treeSha256 as string | undefined) ?? fixtureTree.treeSha256,
  } : FINAL_TREE
  const virtualFile = (filePath: string) => model && !realFixturePath(filePath) ? state.virtualFiles?.get(posix(filePath)) : undefined
  const virtualDirectory = (filePath: string) => model && !realFixturePath(filePath) && (posix(filePath) === 'node_modules'
    || [...(state.virtualFiles?.keys() ?? [])].some((entry) => entry.startsWith(`${posix(filePath)}/`))
    || state.virtualDirectories?.has(posix(filePath)))
  const virtualState = (filePath: string, kind: 'file' | 'directory') => ({
    kind,
    symbolicLink: false,
    dev: 'fixture-volume',
    ino: kind === 'file' ? state.virtualIdentities?.get(posix(filePath)) ?? 'fixture-file'
      : state.directoryIdentityOverrides?.[posix(filePath)] ?? crypto.createHash('sha256').update(posix(filePath)).digest('hex'),
    size: kind === 'file' ? String(virtualFile(filePath)?.length ?? 0) : '0',
    mode: '33188',
    mtimeNs: '1700000000000000000',
  })
  const missing = () => Object.assign(new Error('fixture path absent'), { code: 'ENOENT' })
  const virtualChildren = (directory: string) => {
    const relative = posix(directory)
    const prefix = relative === '' ? '' : `${relative}/`
    const names = new Set<string>()
    for (const entry of state.virtualFiles?.keys() ?? []) {
      if (entry.startsWith(prefix)) names.add(entry.slice(prefix.length).split('/')[0])
    }
    for (const entry of state.virtualDirectories ?? []) {
      if (entry.startsWith(prefix) && entry !== relative) names.add(entry.slice(prefix.length).split('/')[0])
    }
    return [...names]
  }
  const policy = () => deepFreeze({
    schemaVersion: 1,
    platform: 'win32', architecture: 'x64',
    node: { version: 'v24.15.0' }, npm: { version: '11.12.1' }, git: { version: '2.44.0.windows.1' },
    nativeAbi: {
      hostNode: { nodeVersion: 'v24.15.0', modulesAbi: '137', napi: '10', platform: 'win32', arch: 'x64' },
      electron: { electronVersion: '35.7.5', nodeVersion: 'v22.16.0', modulesAbi: '133', napi: '10', platform: 'win32', arch: 'x64' },
      sqlite: { packageName: 'better-sqlite3', packageVersion: '13.0.2', loaderRelativePath: 'node_modules/better-sqlite3/lib/win32-x64.js', nativeRelativePath: 'node_modules/better-sqlite3/prebuilds/win32-x64.node', nativeSha256: PACKAGE_ENTRY_ROWS.find(([id]) => id === 'better-sqlite3-prebuild')![3], sqliteVersion: '3.53.4' },
    },
    dependencyBootstrap: {
      installArguments: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      preLifecycleTree: expectedPreTree, lifecyclePayloads: LIFECYCLE_ROWS.map(({ descriptorId: _descriptorId, ...row }) => row),
      finalTree: expectedFinalTree, electronExecutableSha256: PACKAGE_ENTRY_ROWS.find(([id]) => id === 'electron-executable')![3],
    },
  })
  return deepFreeze({
    canonicalWorkspaceRoot: canonicalRoot,
    isProxyObject: (value: object) => isProxy(value),
    pathJoin: (...members: string[]) => path.join(...members),
    pathBasename: (value: string) => path.basename(value),
    pathDirname: (value: string) => path.dirname(value),
    pathResolve: (...members: string[]) => path.resolve(...members),
    pathRelative: (from: string, to: string) => path.relative(from, to),
    pathToFileUrl: (value: string) => pathToFileURL(value).href,
    utf8Bytes: (value: string) => new TextEncoder().encode(value),
    utf8Text: (value: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(value),
    expectedPreLifecycleTree: expectedPreTree,
    expectedFinalTree: expectedFinalTree,
    sha256Bytes: (value: Uint8Array) => {
      const text = Buffer.from(value).toString('utf8')
      const relative = state.lastVirtualPath
      state.lastVirtualPath = undefined
      if (relative && state.hashOverrides?.[relative]) return state.hashOverrides[relative]
      if (relative === 'node_modules/electron/dist/electron.exe'
        && (state.lifecycleCommands ?? 0) >= 3 && state.finalTreePatch?.electronExecutableSha256) {
        state.electronHashReads = (state.electronHashReads ?? 0) + 1
        if (state.electronHashReads > 1) return state.finalTreePatch.electronExecutableSha256 as string
      }
      const packageEntry = PACKAGE_ENTRY_ROWS.find(([, , entryPath]) => entryPath === relative)
      if (packageEntry && text === `fixture:${packageEntry[0]}`) return packageEntry[3]
      const lifecycle = LIFECYCLE_ROWS.find((row) => `node_modules/${row.entryRelativePath}` === relative)
      if (lifecycle && text === `fixture:${lifecycle.id}`) return lifecycle.entrySha256
      if (text.startsWith('[{"relativePath":')) {
        const packageTree = packageTreeFixtures.get(text)
        if (packageTree) return state.packageTreeDriftRoot === packageTree.rootRelativePath
          ? '0'.repeat(64)
          : packageTree.treeSha256
      }
      return crypto.createHash('sha256').update(value).digest('hex')
    },
    readPathStat: async (filePath: string) => {
      state.capabilityCalls.push(`lstat:${filePath}`)
      if (state.failAt === 'quarantine:throw' && posix(filePath) === 'release-validation/reports/preflight.json') throw new Error('fixture quarantine failure')
      if (virtualFile(filePath)) return virtualState(filePath, 'file')
      if (virtualDirectory(filePath)) return virtualState(filePath, 'directory')
      if (model && !realFixturePath(filePath) && posix(filePath).startsWith('release-validation')) throw missing()
      const value = await fs.lstat(filePath, { bigint: true })
      return {
        kind: value.isDirectory() ? 'directory' : value.isFile() ? 'file' : 'other',
        symbolicLink: value.isSymbolicLink(),
        dev: value.dev.toString(),
        ino: value.ino.toString(),
        size: value.size.toString(),
        mode: value.mode.toString(),
        mtimeNs: value.mtimeNs.toString(),
      }
    },
    readRealPath: async (filePath: string) => {
      state.capabilityCalls.push(`realpath:${filePath}`)
      if (virtualFile(filePath) || virtualDirectory(filePath)) return filePath
      return await fs.realpath(filePath)
    },
    readDirectoryNames: async (directory: string) => {
      state.capabilityCalls.push(`readdir:${directory}`)
      if (state.failAt === 'validate-pre-tree:throw' && posix(directory) === 'node_modules') throw new Error('fixture pre-tree failure')
      if (model && path.resolve(directory) === path.resolve(canonicalRoot) && Array.isArray(state.gatePatch.rootEntries)) return state.gatePatch.rootEntries as string[]
      if (model && path.resolve(directory) === path.resolve(canonicalRoot)) {
        record('root-enumeration')
        if (state.failAt?.startsWith('dotenv:') && state.calls.includes('command:test-full')) {
          state.buildRootReads = (state.buildRootReads ?? 0) + 1
          const positions = [
            'before:build-main', 'after:build-main',
            'before:build-preload', 'after:build-preload',
            'before:build-renderer', 'after:build-renderer',
          ]
          const names = [...new Set([...await fs.readdir(directory), ...virtualChildren(directory)])]
          return state.failAt === `dotenv:${positions[state.buildRootReads - 1]}` ? [...names, '.env'] : names
        }
        const names = await fs.readdir(directory)
        return [...new Set([...names, ...virtualChildren(directory)])]
      }
      if (virtualDirectory(directory)) {
        return virtualChildren(directory)
      }
      return await fs.readdir(directory)
    },
    makeDirectory: async (directory: string) => {
      state.capabilityCalls.push(`mkdir:${directory}`)
      if (model && !realFixturePath(directory) && posix(directory).startsWith('release-validation')) {
        state.virtualDirectories?.add(posix(directory))
        return
      }
      await fs.mkdir(directory)
    },
    openPath: async (filePath: string, flags: string) => {
      state.capabilityCalls.push(`open:${flags}:${filePath}`)
      if (model && (virtualFile(filePath) || virtualDirectory(filePath) || (flags.startsWith('wx') && posix(filePath).startsWith('release-validation/')))) {
        const relative = posix(filePath)
        if (flags.startsWith('wx')) {
          if (state.virtualFiles?.has(relative)) throw Object.assign(new Error('fixture collision'), { code: 'EEXIST' })
          state.virtualFiles?.set(relative, new Uint8Array())
          state.virtualIdentities?.set(relative, crypto.randomBytes(16).toString('hex'))
        }
        let heldBytes = state.virtualFiles?.get(relative) ?? new Uint8Array()
        const heldDirectoryState = virtualDirectory(filePath) ? virtualState(filePath, 'directory') : null
        const heldIdentity = state.openIdentityOverrides?.[relative]
          ?? state.virtualIdentities?.get(relative) ?? virtualState(filePath, 'file').ino
        let closed = false
        return Object.freeze({
          stat: async () => heldDirectoryState ?? ({ ...virtualState(filePath, 'file'), ino: heldIdentity, size: String(heldBytes.length) }),
          read: async () => {
            if (virtualDirectory(filePath)) throw new Error('cannot read directory fixture')
            state.lastVirtualPath = relative
            const override = state.openReadOverrides?.[relative]
            if (override) {
              state.readCounts ??= {}
              const count = (state.readCounts[relative] ?? 0) + 1
              state.readCounts[relative] = count
              if (count > override.afterReads) return new Uint8Array(override.bytes)
            }
            return new Uint8Array(heldBytes)
          },
          write: async (bytes: Uint8Array) => {
            heldBytes = new Uint8Array(bytes)
            state.virtualFiles?.set(relative, heldBytes)
            state.writes.push(relative.includes('metadata') ? 'metadata' : relative.includes('bootstrap-failure') ? 'bootstrap-diagnostic' : 'preflight-report')
          },
          sync: async () => {},
          close: async () => {
            if (closed) throw new Error('fixture file handle closed twice')
            closed = true
            state.capabilityCalls.push(`close:${filePath}`)
            if (virtualDirectory(filePath) && state.directoryCloseFailure === relative) throw new Error(`fixture close failure: ${relative}`)
          },
        })
      }
      const handle = await fs.open(filePath, flags)
      let closed = false
      return Object.freeze({
        stat: async () => {
          state.capabilityCalls.push(`fstat:${filePath}`)
          const value = await handle.stat({ bigint: true })
          const stateValue = {
            kind: value.isDirectory() ? 'directory' : value.isFile() ? 'file' : 'other',
            dev: value.dev.toString(),
            ino: value.ino.toString(),
            size: value.size.toString(),
            mode: value.mode.toString(),
            mtimeNs: value.mtimeNs.toString(),
          }
          const identity = state.openIdentityOverrides?.[posix(filePath)]
          return identity ? { ...stateValue, ino: identity } : stateValue
        },
        read: async () => {
          state.capabilityCalls.push(`read:${filePath}`)
          const relative = posix(filePath)
          state.lastVirtualPath = relative
          const override = state.openReadOverrides?.[relative]
          if (override) {
            state.readCounts ??= {}
            const count = (state.readCounts[relative] ?? 0) + 1
            state.readCounts[relative] = count
            if (count > override.afterReads) return new Uint8Array(override.bytes)
          }
          const observed = await handle.stat()
          const bytes = Buffer.alloc(observed.size)
          let offset = 0
          while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
            if (bytesRead === 0) throw new Error('fixture read incomplete')
            offset += bytesRead
          }
          return new Uint8Array(bytes)
        },
        write: async (bytes: Uint8Array) => {
          state.capabilityCalls.push(`write:${filePath}`)
          await handle.writeFile(bytes)
        },
        sync: async () => {
          state.capabilityCalls.push(`sync:${filePath}`)
          await handle.sync()
        },
        close: async () => {
          if (closed) throw new Error('fixture file handle closed twice')
          closed = true
          state.capabilityCalls.push(`close:${filePath}`)
          await handle.close()
        },
      })
    },
    renamePath: async (source: string, destination: string) => {
      state.capabilityCalls.push(`rename:${source}:${destination}`)
      if (model && !realFixturePath(source) && !realFixturePath(destination)
        && (posix(source).startsWith('release-validation/') || posix(destination).startsWith('release-validation/'))) {
        const sourceRelative = posix(source)
        const destinationRelative = posix(destination)
        const bytes = state.virtualFiles?.get(sourceRelative)
        if (!bytes) throw missing()
        const identity = state.virtualIdentities?.get(sourceRelative)
        state.virtualFiles?.set(destinationRelative, bytes)
        state.virtualFiles?.delete(sourceRelative)
        if (identity) state.virtualIdentities?.set(destinationRelative, identity)
        state.virtualIdentities?.delete(sourceRelative)
        if (state.failAt === 'report-rename-ambiguity'
          && destinationRelative === 'release-validation/reports/preflight.json') {
          throw new Error('fixture report rename outcome is ambiguous')
        }
        return
      }
      await fs.rename(source, destination)
    },
    randomId: () => crypto.randomBytes(12).toString('hex'),
    importProtectedModule: async (specifier: string) => {
      state.importCalls.push(specifier)
      if (state.failAt === 'pre-report-schema:throw' && specifier.endsWith('/report-schema.mjs')) throw new Error('fixture schema import failure')
      if (specifier.endsWith('/security-checklist.mjs')) return {
        runSecurityChecklist: async () => SECURITY_IDS.map((id) => ({ id, status: state.failAt === 'security' ? 'FAIL' : 'PASS' })),
      }
      const relativeSpecifier = model && specifier.startsWith('file:') ? posix(fileURLToPath(specifier)) : null
      const reviewedSpecifier = relativeSpecifier !== null && state.virtualFiles?.has(relativeSpecifier)
        ? pathToFileURL(path.join(workspaceRoot, ...relativeSpecifier.split('/'))).href
        : specifier
      return await import(reviewedSpecifier)
    },
    readClockMs: () => {
      state.clockReads += 1
      return Number((state.gatePatch.observedNowMs as number | undefined) ?? 1_700_000_000_999)
    },
    readEnvironmentEntries: () => {
      state.environmentReads += 1
      return Object.entries((state.gatePatch.ambientEnvironment as Record<string, string> | undefined) ?? {})
    },
    sha256Text: (text: string) => crypto.createHash('sha256').update(text).digest('hex'),
    dependencyIdentity: () => state.dependencyIdentity,
    loadReleaseToolchainPolicy: async () => {
      const value = policy()
      return state.policyPatch ? deepFreeze(state.policyPatch(structuredClone(value) as Record<string, any>)) : value
    },
    runTrustedCommand: async (id: string) => {
      record(`command:${id}`)
      state.capabilityCalls.push(`runner:${id}`)
      if (state.failAt === `command:${id}:throw`) throw new Error('fixture runner failure')
      const failed = state.commandFailures[id]
      if (failed) return failed
      const patch = state.gatePatch as Record<string, any>
      const unsupportedGateMutation = Object.keys(patch).some((key) => [
        'workspaceIdentity', 'candidateClean', 'packageBlobMatches', 'mainWorktrees',
        'packageVersion', 'lockVersion', 'rootLockVersion', 'fixedInputsValid', 'trackedEnvExample',
      ].includes(key) && patch[key] !== gateSnapshot()[key as keyof ReturnType<typeof gateSnapshot>])
      if (id === 'git-symbolic-head') {
        if (unsupportedGateMutation) return { status: 'FAIL', category: 'invalid-output', exitCode: null }
        return {
          status: 'PASS', category: null, exitCode: 0,
          branchRef: Object.hasOwn(patch, 'branchRef') ? patch.branchRef : 'refs/heads/task15',
        }
      }
      if (id === 'git-head') return { status: 'PASS', category: null, exitCode: 0, commitSha: patch.head ?? SHA_A }
      if (['git-status', 'git-untracked-audit', 'git-diff-quiet', 'git-config-audit', 'git-index-audit', 'git-replace-audit'].includes(id)) return { status: 'PASS', category: null, exitCode: 0, clean: true }
      if (id === 'git-worktree-list') return { status: 'PASS', category: null, exitCode: 0, worktrees: [
        { head: patch.head ?? SHA_A, branch: 'refs/heads/task15', bare: false, locked: false },
        { head: 'eb1a07bb950769cf24d0fe5c61c710fed4da0fba', branch: 'refs/heads/main', bare: false, locked: false },
      ] }
      if (['git-main-config-audit', 'git-main-index-audit', 'git-main-status', 'git-main-untracked-audit'].includes(id)) return { status: 'PASS', category: null, exitCode: 0, clean: true }
      if (id === 'git-main-head') return { status: 'PASS', category: null, exitCode: 0, commitSha: 'eb1a07bb950769cf24d0fe5c61c710fed4da0fba' }
      if (id === 'git-source-epoch') return { status: 'PASS', category: null, exitCode: 0, sourceDateEpoch: patch.commitEpoch ?? 1_699_999_999 }
      if (id === 'git-package-blob-hash') return {
        status: 'PASS', category: null, exitCode: 0,
        sha256: patch.packageBlobSha256 ?? crypto.createHash('sha256').update(await fs.readFile(packagePath)).digest('hex'),
      }
      if (id === 'node-version') return { status: 'PASS', category: null, exitCode: 0, value: 'v24.15.0' }
      if (id === 'npm-version') return { status: 'PASS', category: null, exitCode: 0, value: '11.12.1' }
      if (id === 'git-version') return { status: 'PASS', category: null, exitCode: 0, value: 'git version 2.44.0.windows.1' }
      if (id.startsWith('lifecycle-')) {
        state.lifecycleCommands = (state.lifecycleCommands ?? 0) + 1
        state.activeLifecycleDescriptor = id
        state.lastLifecycleCommandCall = `command:${id}`
      }
      if (id === 'test-full') {
        return { status: 'PASS', category: null, exitCode: 0, tests: { files: 99, tests: 777, passed: 777, failed: 0, skipped: 0, todo: 0 }, requiredCases: [...REQUIRED_CASES] }
      }
      if (id === 'node-abi-probe') return { status: 'PASS', category: null, exitCode: 0, result: nodeProbe() }
      if (id === 'electron-abi-probe') {
        if (state.invariantReadOverrides) state.openReadOverrides = state.invariantReadOverrides
        if (state.invariantHashOverrides) state.hashOverrides = state.invariantHashOverrides
        if (state.failAt === 'invariant-toolchain-parity') {
          state.policyPatch = (value) => {
            value.nativeAbi.hostNode.modulesAbi = '999'
            return value
          }
        }
        const result = { status: 'PASS', category: null, exitCode: 0, result: electronProbe() }
        if (state.failAt === 'invariants') state.gatePatch.head = 'd'.repeat(40)
        return result
      }
      return { status: 'PASS', category: null, exitCode: 0 }
    },
    createReleaseMetadataValue: async () => {
      record('metadata')
      if (state.metadataBarrier) await state.metadataBarrier
      if (state.failAt === 'metadata') throw new Error('fixture metadata failure')
      return state.metadataValue ?? validMetadata()
    },
    createReleaseContext: async () => {
      record('create-context')
      state.createdContext ??= expectedContext()
      return state.createdContext
    },
  })
}

function makeInvariantHandleAuditedDeps(
  state: TestState,
  options: { throwFromAction?: boolean, closeFailureRelativePath?: string } = {},
) {
  const base = makeDeps(state)
  const audit: InvariantHandleAudit = {
    opened: [],
    wrapperCloseCalls: new Map(),
    lowLevelCloseCalls: new Map(),
  }
  let armed = false
  let policyCallsAfterArm = 0
  let closeFailureInjected = false
  const deps = {
    ...base,
    runTrustedCommand: async (id: string) => {
      const result = await base.runTrustedCommand(id)
      if (id === 'electron-abi-probe') armed = true
      return result
    },
    loadReleaseToolchainPolicy: async () => {
      if (armed) {
        policyCallsAfterArm += 1
        if (options.throwFromAction && policyCallsAfterArm === 3) throw new Error('fixture invariant action sentinel')
      }
      return await base.loadReleaseToolchainPolicy()
    },
    openPath: async (filePath: string, flags: string) => {
      const handle = await base.openPath(filePath, flags)
      if (!armed) return handle
      const relativePath = path.relative(workspaceRoot, filePath).replaceAll('\\', '/') || '.'
      const id = `${audit.opened.length}:${flags}:${relativePath}`
      audit.opened.push({ id, relativePath })
      return Object.freeze({
        stat: async () => await handle.stat(),
        read: async () => await handle.read(),
        write: async (bytes: Uint8Array) => await handle.write(bytes),
        sync: async () => await handle.sync(),
        close: async () => {
          audit.wrapperCloseCalls.set(id, (audit.wrapperCloseCalls.get(id) ?? 0) + 1)
          audit.lowLevelCloseCalls.set(id, (audit.lowLevelCloseCalls.get(id) ?? 0) + 1)
          await handle.close()
          if (!closeFailureInjected && relativePath === options.closeFailureRelativePath) {
            closeFailureInjected = true
            throw new Error(`fixture invariant close sentinel: ${relativePath}`)
          }
        },
      })
    },
  }
  return { deps, audit }
}

function passingReport() {
  const context = expectedContext()
  return {
    schemaVersion: 1,
    stage: 'preflight',
    contextId: context.contextId,
    status: 'PASS',
    blocker: null,
    releaseMetadata: { relativePath: context.metadataPath, sha256: context.metadataSha256 },
    packageLockSha256: context.packageLockSha256,
    toolchain: { ...context.toolchain, electronBuilderVersion: '26.15.3' },
    commands: ['npm-ci', 'typecheck', 'lint', 'test', 'build'].map((id) => ({ id, status: 'PASS', category: null, exitCode: 0, durationMs: 0 })),
    checks: ['security-static-checks', 'icon-verify', 'node-native-abi', 'electron-native-abi', 'release-invariants'].map((id) => ({ id, status: 'PASS', durationMs: 0 })),
    nativeAbi: { node: nodeProbe(), electron: electronProbe() },
    tests: { files: 99, tests: 777, passed: 777, failed: 0, skipped: 0, todo: 0 },
  }
}

function publishedReport(state: TestState) {
  const bytes = state.virtualFiles?.get('release-validation/reports/preflight.json')
  expect(bytes, 'production report writer must publish the canonical virtual file').toBeDefined()
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  expect(text.endsWith('\n')).toBe(true)
  return PreflightReportSchema.parse(JSON.parse(text))
}

async function sourceOrFail(filePath = preflightPath): Promise<string> {
  const source = await fs.readFile(filePath, 'utf8').catch(() => '')
  expect(source.length, `${path.basename(filePath)} must exist`).toBeGreaterThan(0)
  return source
}

function occurrences(source: string, marker: string): number {
  return source.split(marker).length - 1
}

let extractedCoreFactory: ((testDeps: unknown) => ReturnType<typeof _createCoreShape>) | undefined
let extractedCoreBlock: string | undefined

async function extractedCore(deps = makeDeps()) {
  const source = await sourceOrFail()
  expect(occurrences(source, CORE_START), 'preflight core start marker count').toBe(1)
  expect(occurrences(source, CORE_END), 'preflight core end marker count').toBe(1)
  const start = source.indexOf(CORE_START) + CORE_START.length
  const end = source.indexOf(CORE_END, start)
  const markerBlock = source.slice(start, end)
  const executedBlock = markerBlock
  expect(executedBlock, 'test core must execute the exact production marker bytes').toBe(markerBlock)
  if (extractedCoreFactory === undefined) {
    extractedCoreBlock = executedBlock
    extractedCoreFactory = new vm.Script(`${executedBlock}\ncreatePreflightCore`).runInNewContext({
      Array, BigInt, Boolean, Date, Error, JSON, Map, Math, Number, Object, Promise,
      Reflect, Set, String, TypeError, WeakMap, WeakSet,
    }) as (testDeps: unknown) => ReturnType<typeof _createCoreShape>
  } else {
    expect(executedBlock, 'cached test core must remain byte-identical').toBe(extractedCoreBlock)
  }
  return extractedCoreFactory(deps)
}

function _createCoreShape() {
  return {
    runEarlyGitPackageGate: async (_input: unknown) => expectedFacts(),
    prepareDependencyBootstrap: async (_input: unknown) => Object.freeze({}),
    prepareReleaseMetadata: async (_input: unknown) => expectedPrepared(),
    runPreflight: async (_input: unknown) => ({}),
    loadPostInstallBindings: async (_input: unknown) => expectedBindings(),
    loadBoundPreflightReport: async (_input: unknown) => ({}),
    loadFrozenPreflightContext: async (_input: unknown) => ({}),
    canonicalTreeFixture: (_rows: unknown[]) => ({ bytes: '', sha256: '' }),
    testOnly: {
      initializeReleaseDirectories: async (_input: unknown) => ({}),
      quarantinePreflightEvidence: async (_input: unknown) => ({}),
      writePreparedMetadata: async (_input: unknown) => ({}),
      publishPreflightReport: async (_input: unknown) => ({}),
      runProtectedImportEpoch: async (_input: unknown) => ({}),
    },
  }
}

async function bootstrapped(core: Awaited<ReturnType<typeof extractedCore>>) {
  const releaseFacts = await core.runEarlyGitPackageGate({ workspaceRoot })
  const dependencyBootstrap = await core.prepareDependencyBootstrap({ workspaceRoot, releaseFacts })
  const preparedMetadata = await core.prepareReleaseMetadata({ workspaceRoot, releaseFacts, dependencyBootstrap })
  return { releaseFacts, dependencyBootstrap, preparedMetadata }
}

async function completedPreflight(core: Awaited<ReturnType<typeof extractedCore>>, state: TestState) {
  const { dependencyBootstrap } = await bootstrapped(core)
  const context = expectedContext()
  const result = await core.runPreflight({ context, dependencyBootstrap })
  expect(result.status).toBe('PASS')
  const report = publishedReport(state)
  const evidence = result.evidence[0]
  const preflightReference = {
    reportPath: evidence.reportPath,
    reportSha256: evidence.reportSha256,
    itemId: evidence.itemId,
  }
  return { context, report, preflightReference }
}

async function ownedBindingContextAfterEarlyChildFailure(
  core: Awaited<ReturnType<typeof extractedCore>>,
  state: TestState,
) {
  const { dependencyBootstrap } = await bootstrapped(core)
  const context = expectedContext()
  state.commandFailures['lifecycle-electron-install'] = {
    status: 'FAIL', category: 'child-nonzero', exitCode: 7,
  }
  const result = await core.runPreflight({ context, dependencyBootstrap })
  expect(result.status).toBe('FAIL')
  expect(publishedReport(state).blocker).toBe('Preflight npm-ci failed')
  expect(state.calls).toContain('command:lifecycle-electron-install')
  expect(state.calls.some((call) => call.startsWith('command:typecheck'))).toBe(false)
  return { context }
}

async function expectedBindingsForState(state: TestState) {
  const workspaceEntries = await Promise.all(WORKSPACE_ENTRY_ROWS.map(async ([id, relativePath]) => {
    const actual = crypto.createHash('sha256').update(await fs.readFile(path.join(workspaceRoot, ...relativePath.split('/')))).digest('hex')
    if (FIXED_WORKSPACE_HASHES[id] !== undefined) expect(actual, `${id} reviewed workspace hash`).toBe(FIXED_WORKSPACE_HASHES[id])
    return { id, relativePath, fileSha256: actual }
  }))
  return {
    schemaVersion: 1,
    nodeModulesTree: state.fixtureTree,
    packages: PACKAGE_ROWS.map(([name, version, lockIntegrity, rootRelativePath, treeSha256]) => ({
      name, version, lockIntegrity, rootRelativePath, treeSha256,
    })),
    packageEntries: PACKAGE_ENTRY_ROWS.map(([id, packageName, relativePath, fileSha256]) => ({
      id, packageName, relativePath, fileSha256,
    })),
    workspaceEntries,
  }
}

function exactReference(sha256 = SHA_B) {
  return { reportPath: 'release-validation/reports/preflight.json', reportSha256: sha256, itemId: 'ARTIFACT-PREFLIGHT' }
}

type ProbeFixtureBehavior = {
  constructorThrows?: boolean
  prepareThrows?: boolean
  getThrows?: boolean
  closeThrows?: boolean
  rowExpression?: string
}

async function runProbeFixture(behavior: ProbeFixtureBehavior = {}) {
  await sourceOrFail(probePath)
  const root = await disposableRoot('workbench-preflight-probe-')
  const packageRoot = path.join(root, 'node_modules', 'better-sqlite3')
  await fs.mkdir(packageRoot, { recursive: true })
  await fs.copyFile(probePath, path.join(root, 'native-abi-probe.mjs'))
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'better-sqlite3',
    version: '13.0.2',
    type: 'module',
    exports: { './win32-x64': './win32-x64.js' },
  }))
  const rowExpression = behavior.rowExpression ?? "{version:'3.53.4'}"
  await fs.writeFile(path.join(packageRoot, 'win32-x64.js'), [
    "import fs from 'node:fs'",
    'const trace=[]',
    "const save=()=>fs.writeFileSync('probe-trace.json',JSON.stringify(trace))",
    "const mark=(value)=>{trace.push(value);save()}",
    'export default class Database {',
    `constructor(name){ mark(['open',name]); ${behavior.constructorThrows ? "throw new Error('constructor secret path C:\\\\secret')" : ''} }`,
    `prepare(sql){ mark(['prepare',sql]); ${behavior.prepareThrows ? "throw new Error('prepare secret');" : ''} return {get(){mark(['get']); ${behavior.getThrows ? "throw new Error('get secret')" : `return ${rowExpression}`} }} }`,
    `close(){ mark(['close']); ${behavior.closeThrows ? "throw new Error('close secret')" : ''} }`,
    '}',
  ].join('\n'))
  const result = await runChild('C:\\Program Files\\nodejs\\node.exe', [path.join(root, 'native-abi-probe.mjs')], { cwd: root })
  const trace = JSON.parse(await fs.readFile(path.join(root, 'probe-trace.json'), 'utf8')) as unknown[]
  return { root, result, trace }
}

async function runChild(
  executable: string,
  args: string[],
  options: { cwd?: string, env?: Record<string, string>, timeoutMs?: number, maxStreamBytes?: number } = {},
) {
  return await new Promise<{ code: number | null, stdout: string, stderr: string }>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? workspaceRoot,
      env: options.env ?? { LANG: 'C', LC_ALL: 'C' },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let terminationStarted = false
    let terminationReason: Error | undefined
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined
    const cap = options.maxStreamBytes ?? 256 * 1024
    const taskkillPath = 'C:\\Windows\\System32\\taskkill.exe'
    const terminateTree = (reason: Error) => {
      if (terminationStarted) return
      terminationStarted = true
      terminationReason = reason
      if (child.pid === undefined) {
        child.kill()
        return
      }
      const killer = spawn(taskkillPath, ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        shell: false,
        stdio: 'ignore',
      })
      const killerTimer = setTimeout(() => {
        killer.kill()
        child.kill()
      }, 2_000)
      killer.once('error', () => {
        clearTimeout(killerTimer)
        child.kill()
      })
      killer.once('close', () => clearTimeout(killerTimer))
      cleanupTimer = setTimeout(() => {
        child.kill()
        finish(() => reject(new Error('Child cleanup was not confirmed.')))
      }, 5_000)
    }
    const timer = setTimeout(() => {
      if (!settled) terminateTree(new Error('Child timed out.'))
    }, options.timeoutMs ?? 20_000)
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (cleanupTimer) clearTimeout(cleanupTimer)
      callback()
    }
    child.stdout.on('data', (chunk) => {
      const bytes = Buffer.from(chunk)
      stdoutBytes += bytes.length
      if (stdoutBytes > cap) terminateTree(new Error('Child stdout exceeded its byte limit.'))
      else stdout.push(bytes)
    })
    child.stderr.on('data', (chunk) => {
      const bytes = Buffer.from(chunk)
      stderrBytes += bytes.length
      if (stderrBytes > cap) terminateTree(new Error('Child stderr exceeded its byte limit.'))
      else stderr.push(bytes)
    })
    child.once('error', (error) => finish(() => reject(error)))
    child.once('close', (code) => finish(() => {
      if (terminationReason) {
        reject(terminationReason)
        return
      }
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    }))
  })
}

async function runExactCliTailFixture(_args: string[] = []) {
  const root = await disposableRoot('workbench-preflight-cli-tail-')
  const scriptPath = path.join(root, 'preflight-cli-tail.mjs')
  const tracePath = path.join(root, 'cli-trace.json')
  const fixtureWorkspaceRoot = path.join(root, 'workspace')
  const sourceBytes = await fs.readFile(preflightPath)
  const tailNeedle = Buffer.from('export async function runEarlyGitPackageGate(input) {', 'utf8')
  const tailStart = sourceBytes.indexOf(tailNeedle)
  expect(tailStart, 'production CLI tail start').toBeGreaterThan(-1)
  expect(sourceBytes.indexOf(tailNeedle, tailStart + 1), 'production CLI tail start must be unique').toBe(-1)
  const tailBytes = sourceBytes.subarray(tailStart)
  const prefixBytes = Buffer.from([
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    `const WORKSPACE_ROOT = ${JSON.stringify(fixtureWorkspaceRoot)};`,
    `const TRACE_PATH = ${JSON.stringify(tracePath)};`,
    "const releaseFacts = Object.freeze({ fixture: 'release-facts' });",
    "const dependencyBootstrap = Object.freeze({ fixture: 'dependency-bootstrap' });",
    "const preparedMetadata = Object.freeze({ fixture: 'prepared-metadata' });",
    "const context = Object.freeze({ fixture: 'context' });",
    'const trace = [];',
    "function fail(message) { throw new Error(message); }",
    "function assertExactInput(value, keys) {",
    "  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('fixture input shape');",
    "  const actual = Reflect.ownKeys(value);",
    "  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) fail('fixture input keys');",
    '}',
    "function record(stage) { trace.push(stage); fs.writeFileSync(TRACE_PATH, JSON.stringify(trace) + '\\n', { encoding: 'utf8' }); }",
    'const PRODUCTION_CORE = Object.freeze({',
    '  async runEarlyGitPackageGate(input) {',
    "    assertExactInput(input, ['workspaceRoot']);",
    "    if (input.workspaceRoot !== WORKSPACE_ROOT) fail('early gate workspace identity');",
    "    record('early-gate');",
    '    return releaseFacts;',
    '  },',
    '  async prepareDependencyBootstrap(input) {',
    "    assertExactInput(input, ['workspaceRoot', 'releaseFacts']);",
    "    if (input.workspaceRoot !== WORKSPACE_ROOT || input.releaseFacts !== releaseFacts) fail('bootstrap identity');",
    "    record('dependency-bootstrap');",
    '    return dependencyBootstrap;',
    '  },',
    '  async prepareReleaseMetadata(input) {',
    "    assertExactInput(input, ['workspaceRoot', 'releaseFacts', 'dependencyBootstrap']);",
    "    if (input.workspaceRoot !== WORKSPACE_ROOT || input.releaseFacts !== releaseFacts || input.dependencyBootstrap !== dependencyBootstrap) fail('metadata identity');",
    "    record('release-metadata');",
    '    return preparedMetadata;',
    '  },',
    '  async runPreflight(input) {',
    "    assertExactInput(input, ['context', 'dependencyBootstrap']);",
    "    if (input.context !== context || input.dependencyBootstrap !== dependencyBootstrap) fail('preflight identity');",
    "    record('preflight');",
    "    return Object.freeze({ status: 'PASS' });",
    '  },',
    "  async loadPostInstallBindings() { fail('unexpected post-install loader'); },",
    "  async loadBoundPreflightReport() { fail('unexpected report loader'); },",
    "  async loadFrozenPreflightContext() { fail('unexpected frozen loader'); },",
    '});',
    'function createReleaseContext(input) {',
    "  assertExactInput(input, ['workspaceRoot', 'releaseFacts', 'preparedMetadata']);",
    "  if (input.workspaceRoot !== WORKSPACE_ROOT || input.releaseFacts !== releaseFacts || input.preparedMetadata !== preparedMetadata) fail('context identity');",
    "  record('release-context');",
    '  return context;',
    '}',
    '',
  ].join('\n'), 'utf8')
  await fs.writeFile(scriptPath, Buffer.concat([prefixBytes, tailBytes]), { flag: 'wx' })
  const result = await runChild('C:\\Program Files\\nodejs\\node.exe', [scriptPath, ..._args], { cwd: root })
  const copiedBytes = await fs.readFile(scriptPath)
  expect(copiedBytes.subarray(prefixBytes.length).equals(tailBytes), 'copied production CLI tail bytes').toBe(true)
  const trace = await fs.readFile(tracePath, 'utf8')
    .then((text) => JSON.parse(text) as string[])
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
  const exists = async (candidate: string) => await fs.stat(candidate).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  return {
    root,
    result,
    trace,
    snapshot: await filesystemSnapshot(root),
    workspaceExists: await exists(fixtureWorkspaceRoot),
    releaseValidationExists: await exists(path.join(root, 'release-validation')),
  }
}

describe('bounded child fixture harness', () => {
  it('kills a timed-out child tree and settles only after close', async () => {
    const started = Date.now()
    await expect(runChild(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { timeoutMs: 250, maxStreamBytes: 1_024 },
    )).rejects.toThrow('Child timed out.')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('caps each child stream and performs the same bounded cleanup', async () => {
    await expect(runChild(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(65536)); setInterval(() => {}, 1000)"],
      { timeoutMs: 5_000, maxStreamBytes: 1_024 },
    )).rejects.toThrow('Child stdout exceeded its byte limit.')
  })
})

describe('preflight production surface and private core', () => {
  it('exports exactly seven one-object production functions and rejects unknown input fields', async () => {
    await sourceOrFail()
    const loaded = await import(`${pathToFileURL(preflightPath).href}?exports=${crypto.randomUUID()}`)
    expect(Object.keys(loaded).sort()).toEqual([
      'loadBoundPreflightReport',
      'loadFrozenPreflightContext',
      'loadPostInstallBindings',
      'prepareDependencyBootstrap',
      'prepareReleaseMetadata',
      'runEarlyGitPackageGate',
      'runPreflight',
    ])
    for (const name of Object.keys(loaded)) expect(loaded[name].length, name).toBe(1)
    await expect(loaded.runEarlyGitPackageGate({ workspaceRoot, deps: {} })).rejects.toThrow()
    await expect(loaded.loadFrozenPreflightContext({ workspaceRoot, mode: 'unsafe' })).rejects.toThrow()
  })

  it.each([
    ['runEarlyGitPackageGate', () => ({ workspaceRoot })],
    ['prepareDependencyBootstrap', () => ({ workspaceRoot, releaseFacts: expectedFacts() })],
    ['prepareReleaseMetadata', () => ({ workspaceRoot, releaseFacts: expectedFacts(), dependencyBootstrap: Object.freeze({}) })],
    ['runPreflight', () => ({ context: expectedContext(), dependencyBootstrap: Object.freeze({}) })],
    ['loadPostInstallBindings', () => ({ workspaceRoot, context: expectedContext() })],
    ['loadBoundPreflightReport', () => ({ workspaceRoot, context: expectedContext(), preflightReference: exactReference() })],
    ['loadFrozenPreflightContext', () => ({ workspaceRoot })],
  ])('rejects every hostile %s argument shape before evaluating getters', async (name, validInput) => {
    await sourceOrFail()
    const loaded = await import(`${pathToFileURL(preflightPath).href}?hostile=${crypto.randomUUID()}`)
    const valid = validInput()
    let getterCalls = 0
    const accessor = Object.create(Object.prototype)
    for (const key of Reflect.ownKeys(valid)) {
      Object.defineProperty(accessor, key, {
        configurable: true,
        enumerable: true,
        get() {
          getterCalls += 1
          return Reflect.get(valid, key)
        },
      })
    }
    const inherited = Object.assign(Object.create({ inherited: true }), valid)
    const nullPrototype = Object.assign(Object.create(null), valid)
    const symbolExtra = { ...valid, [Symbol('hidden')]: true }
    const nonEnumerableExtra = { ...valid }
    Object.defineProperty(nonEnumerableExtra, 'hidden', { value: true, enumerable: false })
    class ArgumentObject {}
    const classInstance = Object.assign(new ArgumentObject(), valid)
    const proxied = new Proxy({ ...valid }, {})
    const attempts = [
      undefined,
      {},
      { ...valid, extra: true },
      inherited,
      nullPrototype,
      symbolExtra,
      nonEnumerableExtra,
      classInstance,
      Object.assign([], valid),
      proxied,
      accessor,
    ]
    for (const attempt of attempts) {
      await expect(loaded[name](attempt)).rejects.toThrow()
    }
    expect(getterCalls).toBe(0)
  })

  it('binds one marker-delimited core and constructs production once from frozen private dependencies', async () => {
    const source = await sourceOrFail()
    expect(occurrences(source, CORE_START)).toBe(1)
    expect(occurrences(source, CORE_END)).toBe(1)
    expect(occurrences(source, 'createPreflightCore(PRODUCTION_DEPS)')).toBe(1)
    expect(source).not.toMatch(/export\s+(?:const|function)\s+(?:createPreflightCore|PRODUCTION_DEPS)/u)
  })

  it('lexically binds every production wrapper to one core and one exact deeply frozen low-level dependency singleton', async () => {
    const source = await sourceOrFail()
    expect(occurrences(source, 'const PRODUCTION_CORE = createPreflightCore(PRODUCTION_DEPS)')).toBe(1)
    expect(source).toContain('const PRODUCTION_DEPS = deepFreezeExact({')
    expect(source).not.toMatch(/PRODUCTION_DEPS\s*=\s*\{|\.\.\.PRODUCTION_DEPS|deps\s*:/u)
    for (const name of [
      'runEarlyGitPackageGate', 'prepareDependencyBootstrap', 'prepareReleaseMetadata', 'runPreflight',
      'loadPostInstallBindings', 'loadBoundPreflightReport', 'loadFrozenPreflightContext',
    ]) {
      expect(occurrences(source, `return PRODUCTION_CORE.${name}(input)`), `${name} wrapper binding`).toBe(1)
    }
    for (const forbidden of [
      'quarantinePreflightEvidence:', 'createAndWriteMetadata:', 'withPostInstallBindings:',
      'parsePreflightReport:', 'publishPreflightReport:', 'loadFrozenMetadata:',
      'loadPublishedPreflight:', 'validatePreLifecycleTree:', 'validateLifecyclePayload:',
      'validatePostLifecycleTree:',
    ]) expect(source).not.toContain(forbidden)
    const loaded = await import(`${pathToFileURL(preflightPath).href}?binding=${crypto.randomUUID()}`)
    const input = { workspaceRoot }
    await expect(loaded.loadFrozenPreflightContext(input)).rejects.toThrow()
    expect(Reflect.ownKeys(input)).toEqual(['workspaceRoot'])
  })

  it('Task2C2 rename surface exposes only fs.rename for pathname mutation and no link or unlink capability', async () => {
    const source = await sourceOrFail()
    const productionPrefix = source.slice(0, source.indexOf(CORE_START))
    expect(productionPrefix).toContain('renamePath: async (source, destination) => await fs.rename(source, destination)')
    expect(productionPrefix).not.toContain('linkPath:')
    expect(productionPrefix).not.toContain('unlinkPath:')
  })

  it('rejects a noncanonical workspace before dependency activity', async () => {
    const state = newState()
    const core = await extractedCore(makeDeps(state))
    await expect(core.runEarlyGitPackageGate({ workspaceRoot: `${workspaceRoot}-other` })).rejects.toThrow()
    expect(state.calls).toEqual([])
    expect(state.writes).toEqual([])
  })

  it.each([
    ['detached HEAD', { branchRef: null }],
    ['wrong branch', { branchRef: 'refs/heads/main' }],
    ['dirty candidate', { candidateClean: false }],
    ['wrong committed package bytes', { packageBlobMatches: false }],
    ['wrong main SHA', { mainWorktrees: [{ branch: 'refs/heads/main', head: SHA_A, bare: false, locked: false, prunable: false, clean: true }] }],
    ['duplicate main', { mainWorktrees: [gateSnapshot().mainWorktrees[0], gateSnapshot().mainWorktrees[0]] }],
    ['dirty main', { mainWorktrees: [{ ...gateSnapshot().mainWorktrees[0], clean: false }] }],
    ['package drift', { packageVersion: '1.0.0' }],
    ['lock drift', { lockVersion: '1.0.0' }],
    ['contract or asset drift', { fixedInputsValid: false }],
  ])('fails the early gate for %s without writes', async (_label, patch) => {
    const state = newState({ gatePatch: patch })
    const core = await extractedCore(makeDeps(state))
    await expect(core.runEarlyGitPackageGate({ workspaceRoot })).rejects.toThrow()
    expect(state.writes).toEqual([])
  })

  it.each(FIXED_GATE_HASHES)('rejects reviewed fixed-input byte drift for %s before npm or writes', async (relativePath) => {
    const original = await fs.readFile(path.join(workspaceRoot, ...relativePath.split('/')))
    const state = newState({
      openReadOverrides: {
        [relativePath]: { bytes: new Uint8Array(Buffer.concat([original, Buffer.from('\n')])), afterReads: 0 },
      },
    })
    const core = await extractedCore(makeDeps(state))
    await expect(core.runEarlyGitPackageGate({ workspaceRoot })).rejects.toThrow(/fixed|reviewed|input/iu)
    expect(state.calls).not.toContain('command:npm-ci-ignore-scripts')
    expect(state.writes).toEqual([])
  })

  it.each([
    ['complete pair', { ...PRE_TASK2C1_REVIEWED_INPUT_HASHES }],
    ['runner only', {
      'scripts/release/lib/trusted-windows-runner.mjs': PRE_TASK2C1_REVIEWED_INPUT_HASHES['scripts/release/lib/trusted-windows-runner.mjs'],
      'scripts/release/release-toolchain.json': REVIEWED_TASK2C1_POLICY_SHA256,
    }],
    ['policy only', {
      'scripts/release/lib/trusted-windows-runner.mjs': REVIEWED_TASK2C1_RUNNER_SHA256,
      'scripts/release/release-toolchain.json': PRE_TASK2C1_REVIEWED_INPUT_HASHES['scripts/release/release-toolchain.json'],
    }],
  ])('rejects pre-Task2C1 reviewed-input hashes (%s) before npm or writes', async (_label, hashOverrides) => {
    const state = newState({ hashOverrides })
    const core = await extractedCore(makeDeps(state))

    await expect(core.runEarlyGitPackageGate({ workspaceRoot })).rejects.toThrow(/fixed|reviewed|input/iu)
    expect(state.calls).not.toContain('command:npm-ci-ignore-scripts')
    expect(state.writes).toEqual([])
  })

  it('rejects the pre-handle-fix reviewed runner SHA before npm or writes', async () => {
    const state = newState({
      hashOverrides: {
        'scripts/release/lib/trusted-windows-runner.mjs': PRE_HANDLE_FIX_REVIEWED_RUNNER_SHA256,
        'scripts/release/release-toolchain.json': REVIEWED_TASK2C1_POLICY_SHA256,
      },
    })
    const core = await extractedCore(makeDeps(state))

    await expect(core.runEarlyGitPackageGate({ workspaceRoot })).rejects.toThrow(/fixed|reviewed|input/iu)
    expect(state.calls).not.toContain('command:npm-ci-ignore-scripts')
    expect(state.writes).toEqual([])
  })

  it('rejects the pre-ACL-dedup reviewed runner SHA before npm or writes', async () => {
    const state = newState({
      hashOverrides: {
        'scripts/release/lib/trusted-windows-runner.mjs': PRE_ACL_DEDUP_REVIEWED_RUNNER_SHA256,
        'scripts/release/release-toolchain.json': REVIEWED_TASK2C1_POLICY_SHA256,
      },
    })
    const core = await extractedCore(makeDeps(state))

    await expect(core.runEarlyGitPackageGate({ workspaceRoot })).rejects.toThrow(/fixed|reviewed|input/iu)
    expect(state.calls).not.toContain('command:npm-ci-ignore-scripts')
    expect(state.writes).toEqual([])
  })

  it('rejects swapped Task2C1 reviewed-input hashes before npm or writes', async () => {
    const state = newState({
      hashOverrides: {
        'scripts/release/lib/trusted-windows-runner.mjs': REVIEWED_TASK2C1_POLICY_SHA256,
        'scripts/release/release-toolchain.json': REVIEWED_TASK2C1_RUNNER_SHA256,
      },
    })
    const core = await extractedCore(makeDeps(state))

    await expect(core.runEarlyGitPackageGate({ workspaceRoot })).rejects.toThrow(/fixed|reviewed|input/iu)
    expect(state.calls).not.toContain('command:npm-ci-ignore-scripts')
    expect(state.writes).toEqual([])
  })

  it('Task2C2 lock gate rejects a valid second package-lock read whose complete bytes differ from the reviewed fixed read', async () => {
    const lock = JSON.parse(await fs.readFile(path.join(workspaceRoot, 'package-lock.json'), 'utf8'))
    lock.task2c2UnreviewedTopLevel = true
    const changed = new TextEncoder().encode(JSON.stringify(lock))
    const state = newState({
      openReadOverrides: { 'package-lock.json': { bytes: changed, afterReads: 1 } },
    })
    const core = await extractedCore(makeDeps(state))

    await expect(core.runEarlyGitPackageGate({ workspaceRoot })).rejects.toThrow(/lock|fixed|reviewed|drift/iu)
    expect(state.readCounts?.['package-lock.json']).toBeGreaterThanOrEqual(2)
    expect(state.calls).not.toContain('command:npm-ci-ignore-scripts')
    expect(state.writes).toEqual([])
  })

  it.each(['UTF-8 BOM', 'duplicate top-level key'])('strictly rejects package.json %s before npm or writes', async (mutation) => {
    const original = await fs.readFile(packagePath)
    const manifest = JSON.parse(original.toString('utf8'))
    const bytes = mutation === 'UTF-8 BOM'
      ? new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]))
      : new TextEncoder().encode(`{"version":"1.0.1-rc.1","version":"1.0.1-rc.1",${JSON.stringify(manifest).slice(1)}`)
    const state = newState({
      gatePatch: { packageBlobSha256: crypto.createHash('sha256').update(bytes).digest('hex') },
      openReadOverrides: { 'package.json': { bytes, afterReads: 0 } },
    })
    const core = await extractedCore(makeDeps(state))
    await expect(core.runEarlyGitPackageGate({ workspaceRoot })).rejects.toThrow(/package\.json is invalid/iu)
    expect(state.calls).not.toContain('command:npm-ci-ignore-scripts')
    expect(state.writes).toEqual([])
  })

  it.each([
    ['future', { ambientEnvironment: { SOURCE_DATE_EPOCH: '1700000001' } }],
    ['leading zero', { ambientEnvironment: { SOURCE_DATE_EPOCH: '01700000000' } }],
    ['sign', { ambientEnvironment: { SOURCE_DATE_EPOCH: '+1700000000' } }],
    ['fraction', { ambientEnvironment: { SOURCE_DATE_EPOCH: '1700000000.0' } }],
    ['duplicate case', { ambientEnvironment: { SOURCE_DATE_EPOCH: '1700000000', source_date_epoch: '1700000000' } }],
    ['commit after release epoch', { ambientEnvironment: { SOURCE_DATE_EPOCH: '1699999998' } }],
  ])('rejects a noncanonical release epoch: %s', async (_label, patch) => {
    const core = await extractedCore(makeDeps(newState({ gatePatch: patch })))
    await expect(core.runEarlyGitPackageGate({ workspaceRoot })).rejects.toThrow()
  })

  it.each([
    ['workspace npmrc', ['package.json', '.npmrc']],
    ['mixed-case npmrc', ['package.json', '.NPMRC']],
    ['dotenv', ['package.json', '.env']],
    ['mixed dotenv', ['package.json', '.Env.production']],
    ['casefold config ambiguity', ['package.json', 'vitest.config.ts', 'VITEST.CONFIG.TS']],
  ])('rejects root input ambiguity before npm: %s', async (_label, rootEntries) => {
    const state = newState({ gatePatch: { rootEntries } })
    const core = await extractedCore(makeDeps(state))
    await expect(core.runEarlyGitPackageGate({ workspaceRoot })).rejects.toThrow()
    expect(state.calls).toEqual([])
    expect(state.writes).toEqual([])
  })

  it.each(['NPM_CONFIG_REGISTRY', 'npm_config_token', 'Npm_Config_Proxy', 'NPM_CONFIG_CACHE', 'NPM_CONFIG_PREFIX', 'NPM_CONFIG_WORKSPACE'])('rejects inherited npm override %s', async (name) => {
    const state = newState({ gatePatch: { ambientEnvironment: { [name]: 'private' } } })
    const core = await extractedCore(makeDeps(state))
    await expect(core.runEarlyGitPackageGate({ workspaceRoot })).rejects.toThrow()
  })
})

describe('bootstrap token state machine', () => {
  it('mints a frozen opaque token only after quarantine, exact script-disabled install, and pre-tree validation', async () => {
    const state = newState()
    const core = await extractedCore(makeDeps(state))
    const releaseFacts = await core.runEarlyGitPackageGate({ workspaceRoot })
    const token = await core.prepareDependencyBootstrap({ workspaceRoot, releaseFacts })
    expect(Object.isFrozen(token)).toBe(true)
    expect(Reflect.ownKeys(token)).toEqual([])
    expect(state.calls.filter((call) => call === 'command:npm-ci-ignore-scripts')).toEqual(['command:npm-ci-ignore-scripts'])
    expect(state.calls.filter((call) => call === 'command:git-symbolic-head')).toHaveLength(2)
    expect(state.capabilityCalls.some((call) => call.includes('node_modules'))).toBe(true)
    expect(state.importCalls.some((call) => call.endsWith('/node_modules/zod/index.js'))).toBe(true)
    expect(state.writes).toEqual([])
    await expect(core.runPreflight({ context: expectedContext(), dependencyBootstrap: token })).rejects.toThrow(/phase/iu)
    expect(state.calls.some((name) => name.startsWith('command:lifecycle-'))).toBe(false)
    expect(heldHandleCounts(state)[0]).toBe(heldHandleCounts(state)[1])
  })

  it('Task2C2 lock gate refuses to mint after unrelated lock bytes drift in the held schema-lease window', async () => {
    const lock = JSON.parse(await fs.readFile(path.join(workspaceRoot, 'package-lock.json'), 'utf8'))
    lock.packages['node_modules/task2c2-unreviewed'] = {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/task2c2-unreviewed/-/task2c2-unreviewed-1.0.0.tgz',
      integrity: 'sha512-unreviewed',
    }
    const changed = new TextEncoder().encode(JSON.stringify(lock))
    const state = newState({
      openReadOverrides: { 'package-lock.json': { bytes: changed, afterReads: 4 } },
    })
    const core = await extractedCore(makeDeps(state))
    const releaseFacts = await core.runEarlyGitPackageGate({ workspaceRoot })

    await expect(core.prepareDependencyBootstrap({ workspaceRoot, releaseFacts })).rejects.toThrow()

    expect(state.readCounts?.['package-lock.json']).toBeGreaterThan(4)
    expect(state.calls.filter((call) => call === 'command:npm-ci-ignore-scripts')).toHaveLength(1)
    expect(state.writes).not.toContain('metadata')
    expect(state.writes).not.toContain('preflight-report')
  })

  it('holds the complete reviewed package-lock through the first schema import boundary', async () => {
    const state = newState()
    const base = makeDeps(state)
    const original = new Uint8Array(await fs.readFile(path.join(workspaceRoot, 'package-lock.json')))
    expect(crypto.createHash('sha256').update(original).digest('hex')).toBe(SHA_B)
    state.virtualFiles!.set('package-lock.json', original)
    state.virtualIdentities!.set('package-lock.json', 'reviewed-lock-inode')
    const changedLock = JSON.parse(new TextDecoder().decode(original))
    changedLock.task2c2SchemaLeaseDrift = true
    const changed = new TextEncoder().encode(`${JSON.stringify(changedLock, null, 2)}\n`)
    let replaced = false
    const deps = {
      ...base,
      openPath: async (filePath: string, flags: string) => {
        const relativePath = path.relative(workspaceRoot, filePath).replaceAll('\\', '/')
        if (!replaced && relativePath === 'scripts/release/lib/report-schema.mjs') {
          state.virtualFiles!.set('package-lock.json', changed)
          state.virtualIdentities!.set('package-lock.json', 'replacement-lock-inode')
          replaced = true
        }
        return await base.openPath(filePath, flags)
      },
    }
    const core = await extractedCore(deps)
    const releaseFacts = await core.runEarlyGitPackageGate({ workspaceRoot })

    await expect(core.prepareDependencyBootstrap({ workspaceRoot, releaseFacts })).rejects.toThrow()

    expect(replaced).toBe(true)
    expect(state.importCalls).toEqual([])
    expect(state.writes).not.toContain('metadata')
    expect(state.writes).not.toContain('preflight-report')
    expect(heldHandleCounts(state)[0]).toBe(heldHandleCounts(state)[1])
  })

  it('rechecks the complete held package-lock after a schema import callback returns', async () => {
    const state = newState()
    const base = makeDeps(state)
    const original = new Uint8Array(await fs.readFile(path.join(workspaceRoot, 'package-lock.json')))
    state.virtualFiles!.set('package-lock.json', original)
    state.virtualIdentities!.set('package-lock.json', 'reviewed-lock-inode')
    const changedLock = JSON.parse(new TextDecoder().decode(original))
    changedLock.packages['node_modules/task2c2-schema-lease-drift'] = {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/task2c2-schema-lease-drift/-/task2c2-schema-lease-drift-1.0.0.tgz',
      integrity: 'sha512-task2c2-schema-lease-drift',
    }
    const changed = new TextEncoder().encode(`${JSON.stringify(changedLock, null, 2)}\n`)
    let replaced = false
    const deps = {
      ...base,
      importProtectedModule: async (specifier: string) => {
        const imported = await base.importProtectedModule(specifier)
        if (!replaced && specifier.endsWith('/node_modules/zod/index.js')) {
          state.virtualFiles!.set('package-lock.json', changed)
          state.virtualIdentities!.set('package-lock.json', 'replacement-lock-inode')
          replaced = true
        }
        return imported
      },
    }
    const core = await extractedCore(deps)
    const releaseFacts = await core.runEarlyGitPackageGate({ workspaceRoot })

    await expect(core.prepareDependencyBootstrap({ workspaceRoot, releaseFacts })).rejects.toThrow()

    expect(replaced).toBe(true)
    expect(state.importCalls).toEqual([pathToFileURL(path.join(workspaceRoot, 'node_modules', 'zod', 'index.js')).href])
    expect(state.writes).not.toContain('metadata')
    expect(state.writes).not.toContain('preflight-report')
    expect(heldHandleCounts(state)[0]).toBe(heldHandleCounts(state)[1])
  })

  it('keeps the complete package-lock lease held through the final pre-mint absence callback', async () => {
    const state = newState()
    const base = makeDeps(state)
    const original = new Uint8Array(await fs.readFile(path.join(workspaceRoot, 'package-lock.json')))
    state.virtualFiles!.set('package-lock.json', original)
    state.virtualIdentities!.set('package-lock.json', 'reviewed-lock-inode')
    const changedLock = JSON.parse(new TextDecoder().decode(original))
    changedLock.task2c2PreMintLockDrift = { strict: true }
    const changed = new TextEncoder().encode(`${JSON.stringify(changedLock, null, 2)}\n`)
    const canonicalReport = path.join(workspaceRoot, 'release-validation', 'reports', 'preflight.json')
    let schemaImported = false
    let replaced = false
    const deps = {
      ...base,
      importProtectedModule: async (specifier: string) => {
        const imported = await base.importProtectedModule(specifier)
        if (specifier.endsWith('/scripts/release/lib/report-schema.mjs')) schemaImported = true
        return imported
      },
      readPathStat: async (filePath: string) => {
        try { return await base.readPathStat(filePath) } catch (error) {
          if (!replaced && schemaImported && filePath === canonicalReport
            && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            state.virtualFiles!.set('package-lock.json', changed)
            state.virtualIdentities!.set('package-lock.json', 'pre-mint-replacement-lock-inode')
            replaced = true
          }
          throw error
        }
      },
    }
    const core = await extractedCore(deps)
    const releaseFacts = await core.runEarlyGitPackageGate({ workspaceRoot })

    await expect(core.prepareDependencyBootstrap({ workspaceRoot, releaseFacts })).rejects.toThrow()

    expect(replaced).toBe(true)
    expect(state.importCalls).toHaveLength(2)
    expect(state.writes).not.toContain('metadata')
    expect(state.writes).not.toContain('preflight-report')
    expect(heldHandleCounts(state)[0]).toBe(heldHandleCounts(state)[1])
  })

  it.each([
    ['after npm', 'npm', 1, 0],
    ['after the repeated gate', 'repeated-gate', 2, 0],
    ['after the pre-lifecycle tree digest', 'pre-tree', 2, 0],
    ['after both schema imports and before mint', 'schema-imports', 2, 2],
  ])('preserves fresh canonical-report absence %s', async (_label, boundary, expectedGateReads, expectedImports) => {
    const state = newState()
    const base = makeDeps(state)
    let injected = false
    const inject = () => {
      if (injected) return
      const relativePath = 'release-validation/reports/preflight.json'
      state.virtualFiles!.set(relativePath, new TextEncoder().encode(`${JSON.stringify(passingReport())}\n`))
      state.virtualIdentities!.set(relativePath, `stale-${boundary}`)
      injected = true
    }
    const deps = {
      ...base,
      runTrustedCommand: async (id: string) => {
        const result = await base.runTrustedCommand(id)
        if (boundary === 'npm' && id === 'npm-ci-ignore-scripts') inject()
        if (boundary === 'repeated-gate' && id === 'git-version'
          && state.calls.filter((call) => call === 'command:git-version').length === 2) inject()
        return result
      },
      sha256Bytes: (bytes: Uint8Array) => {
        const digest = base.sha256Bytes(bytes)
        if (boundary === 'pre-tree') {
          const text = Buffer.from(bytes).toString('utf8')
          if (text.startsWith('[') && text.includes('"relativePath":"electron/') && text.includes('"relativePath":"zod/')) inject()
        }
        return digest
      },
      importProtectedModule: async (specifier: string) => {
        const imported = await base.importProtectedModule(specifier)
        if (boundary === 'schema-imports' && specifier.endsWith('/scripts/release/lib/report-schema.mjs')) inject()
        return imported
      },
    }
    const core = await extractedCore(deps)
    const releaseFacts = await core.runEarlyGitPackageGate({ workspaceRoot })

    await expect(core.prepareDependencyBootstrap({ workspaceRoot, releaseFacts })).rejects.toThrow()

    expect(injected).toBe(true)
    expect(state.calls.filter((call) => call === 'command:npm-ci-ignore-scripts')).toHaveLength(1)
    expect(state.calls.filter((call) => call === 'command:git-symbolic-head')).toHaveLength(expectedGateReads)
    expect(state.importCalls).toHaveLength(expectedImports)
    expect(state.writes).not.toContain('metadata')
    expect(state.writes).not.toContain('preflight-report')
  })

  it('Task2C2 fresh absence rejects a stale canonical PASS injected after the second ENOENT before npm or token mint', async () => {
    const state = newState()
    const base = makeDeps(state)
    const canonical = path.join(workspaceRoot, 'release-validation', 'reports', 'preflight.json')
    let absenceObservations = 0
    const deps = {
      ...base,
      readPathStat: async (filePath: string) => {
        try {
          return await base.readPathStat(filePath)
        } catch (error) {
          if (filePath === canonical && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            absenceObservations += 1
            if (absenceObservations === 2) {
              const relativePath = 'release-validation/reports/preflight.json'
              state.virtualFiles!.set(relativePath, new TextEncoder().encode(`${JSON.stringify(passingReport())}\n`))
              state.virtualIdentities!.set(relativePath, 'injected-stale-pass')
            }
          }
          throw error
        }
      },
    }
    const core = await extractedCore(deps)
    const releaseFacts = await core.runEarlyGitPackageGate({ workspaceRoot })

    await expect(core.prepareDependencyBootstrap({ workspaceRoot, releaseFacts })).rejects.toThrow()

    expect(absenceObservations).toBe(2)
    expect(state.calls).not.toContain('command:npm-ci-ignore-scripts')
    expect(state.writes).toEqual([])
  })

  it('Task2C2 fresh absence rejects a canonical PASS that reappears immediately after stale quarantine before npm', async () => {
    const state = newState()
    const base = makeDeps(state)
    const relativePath = 'release-validation/reports/preflight.json'
    const stale = new TextEncoder().encode(`${JSON.stringify(passingReport())}\n`)
    state.virtualFiles!.set(relativePath, stale)
    state.virtualIdentities!.set(relativePath, 'original-stale-pass')
    const deps = {
      ...base,
      renamePath: async (source: string, destination: string) => {
        await base.renamePath(source, destination)
        if (destination.includes('preflight.stale.')) {
          state.virtualFiles!.set(relativePath, stale)
          state.virtualIdentities!.set(relativePath, 'reappeared-stale-pass')
        }
      },
    }
    const core = await extractedCore(deps)
    const releaseFacts = await core.runEarlyGitPackageGate({ workspaceRoot })

    await expect(core.prepareDependencyBootstrap({ workspaceRoot, releaseFacts })).rejects.toThrow(/canonical report/iu)
    expect(state.calls).not.toContain('command:npm-ci-ignore-scripts')
    expect(state.writes).toEqual([])
  })

  it('on bootstrap failure writes only the fixed diagnostic and permits no metadata or report action', async () => {
    const state = newState({ commandFailures: { 'npm-ci-ignore-scripts': { status: 'FAIL', category: 'child-nonzero', exitCode: 9 } } })
    const core = await extractedCore(makeDeps(state))
    const releaseFacts = await core.runEarlyGitPackageGate({ workspaceRoot })
    await expect(core.prepareDependencyBootstrap({ workspaceRoot, releaseFacts })).rejects.toThrow()
    expect(state.writes).toEqual(['bootstrap-diagnostic'])
    expect(state.calls).not.toContain('metadata')
    expect(state.calls).not.toContain('publish-report')
  })

  it('rejects unknown, cloned, forged, cross-core, and cross-facts tokens before metadata writes', async () => {
    const state = newState()
    const deps = makeDeps(state)
    const first = await extractedCore(deps)
    const second = await extractedCore(deps)
    const facts = await first.runEarlyGitPackageGate({ workspaceRoot })
    const token = await first.prepareDependencyBootstrap({ workspaceRoot, releaseFacts: facts })
    const attempts = [
      first.prepareReleaseMetadata({ workspaceRoot, releaseFacts: facts, dependencyBootstrap: {} }),
      first.prepareReleaseMetadata({ workspaceRoot, releaseFacts: facts, dependencyBootstrap: { ...token } }),
      second.prepareReleaseMetadata({ workspaceRoot, releaseFacts: facts, dependencyBootstrap: token }),
      first.prepareReleaseMetadata({ workspaceRoot, releaseFacts: { ...facts }, dependencyBootstrap: token }),
    ]
    for (const attempt of attempts) await expect(attempt).rejects.toThrow()
    expect(state.writes).toEqual([])
  })

  it('moves to metadata-preparing before await and makes failure or concurrent reuse terminal', async () => {
    let releaseBarrier: (() => void) | undefined
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve })
    const state = newState({ metadataBarrier: barrier })
    const core = await extractedCore(makeDeps(state))
    const facts = await core.runEarlyGitPackageGate({ workspaceRoot })
    const token = await core.prepareDependencyBootstrap({ workspaceRoot, releaseFacts: facts })
    const first = core.prepareReleaseMetadata({ workspaceRoot, releaseFacts: facts, dependencyBootstrap: token })
    await expect(core.prepareReleaseMetadata({ workspaceRoot, releaseFacts: facts, dependencyBootstrap: token })).rejects.toThrow()
    releaseBarrier?.()
    await expect(first).resolves.toEqual(expectedPrepared())
    await expect(core.prepareReleaseMetadata({ workspaceRoot, releaseFacts: facts, dependencyBootstrap: token })).rejects.toThrow()
    state.dependencyIdentity = {}
    await expect(core.runPreflight({ context: expectedContext(), dependencyBootstrap: token })).rejects.toThrow(/identity/iu)
    expect(heldHandleCounts(state)[0]).toBe(heldHandleCounts(state)[1])

    const poisonedState = newState({ failAt: 'metadata' })
    const poisonedCore = await extractedCore(makeDeps(poisonedState))
    const poisonedFacts = await poisonedCore.runEarlyGitPackageGate({ workspaceRoot })
    const poisoned = await poisonedCore.prepareDependencyBootstrap({ workspaceRoot, releaseFacts: poisonedFacts })
    await expect(poisonedCore.prepareReleaseMetadata({ workspaceRoot, releaseFacts: poisonedFacts, dependencyBootstrap: poisoned })).rejects.toThrow()
    await expect(poisonedCore.prepareReleaseMetadata({ workspaceRoot, releaseFacts: poisonedFacts, dependencyBootstrap: poisoned })).rejects.toThrow()
  })

  it('rejects changed dependency identity and all lifecycle action before valid one-time consumption', async () => {
    const state = newState()
    const core = await extractedCore(makeDeps(state))
    const { dependencyBootstrap } = await bootstrapped(core)
    state.dependencyIdentity = {}
    await expect(core.runPreflight({ context: expectedContext(), dependencyBootstrap })).rejects.toThrow()
    expect(state.calls.filter((name) => name.startsWith('command:lifecycle-'))).toEqual([])
    expect(state.calls).not.toContain('publish-report')
    expect(heldHandleCounts(state)[0]).toBe(heldHandleCounts(state)[1])
  })

  it.each([
    ['cross-workspace', (facts: ReturnType<typeof expectedFacts>) => ({ workspaceRoot: `${workspaceRoot}-other`, releaseFacts: facts })],
    ['cross-facts', (facts: ReturnType<typeof expectedFacts>) => ({ workspaceRoot, releaseFacts: { ...facts } })],
  ])('poisons a known token on %s metadata use and closes its held record once', async (_label, input) => {
    const state = newState()
    const core = await extractedCore(makeDeps(state))
    const facts = await core.runEarlyGitPackageGate({ workspaceRoot })
    const token = await core.prepareDependencyBootstrap({ workspaceRoot, releaseFacts: facts })
    await expect(core.prepareReleaseMetadata({ ...input(facts), dependencyBootstrap: token })).rejects.toThrow()
    await expect(core.prepareReleaseMetadata({ workspaceRoot, releaseFacts: facts, dependencyBootstrap: token })).rejects.toThrow()
    expect(state.writes).toEqual([])
    expect(heldHandleCounts(state)[0]).toBe(heldHandleCounts(state)[1])
  })

  it('makes a wrong-phase preflight attempt terminal before lifecycle or report activity', async () => {
    const state = newState()
    const core = await extractedCore(makeDeps(state))
    const facts = await core.runEarlyGitPackageGate({ workspaceRoot })
    const token = await core.prepareDependencyBootstrap({ workspaceRoot, releaseFacts: facts })
    await expect(core.runPreflight({ context: expectedContext(), dependencyBootstrap: token })).rejects.toThrow()
    await expect(core.prepareReleaseMetadata({ workspaceRoot, releaseFacts: facts, dependencyBootstrap: token })).rejects.toThrow()
    expect(state.calls.some((name) => name.startsWith('command:lifecycle-'))).toBe(false)
    expect(state.calls).not.toContain('publish-report')
    expect(heldHandleCounts(state)[0]).toBe(heldHandleCounts(state)[1])
  })

  it.each([
    ['commit', { commitSha: 'f'.repeat(40) }],
    ['metadata path', { metadataPath: 'release-validation/staging/other.json' }],
    ['metadata hash', { metadataSha256: '0'.repeat(64) }],
    ['lock hash', { packageLockSha256: '0'.repeat(64) }],
    ['release notes hash', { releaseNotesSha256: '0'.repeat(64) }],
    ['epoch', { sourceDateEpoch: 1_700_000_001 }],
    ['toolchain', { toolchain: { ...expectedContext().toolchain, nodeVersion: 'v24.14.0' } }],
  ])('consumes and closes token A before rejecting context-B %s drift', async (_label, patch) => {
    const state = newState()
    const core = await extractedCore(makeDeps(state))
    const { dependencyBootstrap } = await bootstrapped(core)
    await expect(core.runPreflight({ context: { ...expectedContext(), ...patch }, dependencyBootstrap })).rejects.toThrow()
    await expect(core.runPreflight({ context: expectedContext(), dependencyBootstrap })).rejects.toThrow()
    expect(state.calls.some((name) => name.startsWith('command:lifecycle-'))).toBe(false)
    expect(state.calls).not.toContain('publish-report')
    expect(heldHandleCounts(state)[0]).toBe(heldHandleCounts(state)[1])
  })

  it.each([
    ['quarantine exception', 'quarantine:throw', 0],
    ['install exception', 'command:npm-ci-ignore-scripts:throw', 1],
    ['pre-tree exception', 'validate-pre-tree:throw', 1],
    ['schema-import exception', 'pre-report-schema:throw', 1],
  ])('closes every opened bootstrap record once on %s', async (_label, failAt, _expectedOpens) => {
    const state = newState({ failAt })
    const core = await extractedCore(makeDeps(state))
    const facts = await core.runEarlyGitPackageGate({ workspaceRoot })
    await expect(core.prepareDependencyBootstrap({ workspaceRoot, releaseFacts: facts })).rejects.toThrow()
    expect(heldHandleCounts(state)[0]).toBe(heldHandleCounts(state)[1])
    expect(state.calls).not.toContain('metadata')
    expect(state.calls).not.toContain('publish-report')
  })

  it.each([
    ['PASS', undefined, undefined],
    ['npm-ci child failure', undefined, ['lifecycle-electron-install', { status: 'FAIL', category: 'child-nonzero', exitCode: 7 }]],
    ['typecheck timeout', undefined, ['typecheck', { status: 'FAIL', category: 'timeout', exitCode: null }]],
    ['lint output limit', undefined, ['lint', { status: 'FAIL', category: 'output-limit', exitCode: null }]],
    ['test child failure', undefined, ['test-full', {
      status: 'FAIL', category: 'child-nonzero', exitCode: 2,
      tests: { files: 99, tests: 777, passed: 776, failed: 1, skipped: 0, todo: 0 },
    }]],
    ['build execution failure', undefined, ['build-main', { status: 'FAIL', category: 'execution', exitCode: null }]],
    ['security failure', 'security', undefined],
    ['icon cleanup failure', undefined, ['icon-verify', { status: 'FAIL', category: 'cleanup-unconfirmed', exitCode: null }]],
    ['node ABI invalid output', undefined, ['node-abi-probe', { status: 'FAIL', category: 'invalid-output', exitCode: null }]],
    ['Electron ABI verification failure', undefined, ['electron-abi-probe', { status: 'FAIL', category: 'verification-failed', exitCode: null }]],
    ['invariant failure', 'invariants', undefined],
    ['publication ambiguity', 'report-rename-ambiguity', undefined],
  ])('keeps a consumed token terminal and closes its record once after %s', async (_label, failAt, commandFailure) => {
    const state = newState({ failAt })
    if (commandFailure) state.commandFailures[commandFailure[0] as string] = commandFailure[1]
    const core = await extractedCore(makeDeps(state))
    const { dependencyBootstrap } = await bootstrapped(core)
    const first = core.runPreflight({ context: expectedContext(), dependencyBootstrap })
    if (failAt === 'report-rename-ambiguity') await expect(first).rejects.toThrow()
    else await expect(first).resolves.toMatchObject({ status: expect.stringMatching(/^(?:PASS|FAIL)$/u) })
    await expect(core.runPreflight({ context: expectedContext(), dependencyBootstrap })).rejects.toThrow()
    if (failAt === 'report-rename-ambiguity') {
      expect(state.calls).not.toContain('publish-report')
      expect(state.capabilityCalls.some((call) => call.startsWith('rename:') && call.endsWith('release-validation\\reports\\preflight.json'))).toBe(true)
    }
    expect(heldHandleCounts(state)[0]).toBe(heldHandleCounts(state)[1])
  })
})

describe('marker-extracted production filesystem and import boundaries', () => {
  it('creates only the three fixed fresh directories one component at a time and closes every held handle', async () => {
    const root = await disposableRoot('workbench-preflight-fs-fresh-')
    const state = newState({ canonicalRoot: root })
    const core = await extractedCore(makeDeps(state))
    await core.testOnly.initializeReleaseDirectories({ workspaceRoot: root })
    expect(await filesystemSnapshot(root)).toEqual([
      { relativePath: 'release-validation', kind: 'directory' },
      { relativePath: 'release-validation/reports', kind: 'directory' },
      { relativePath: 'release-validation/staging', kind: 'directory' },
    ])
    expect(state.capabilityCalls.filter((call) => call.startsWith('mkdir:')).map((call) => path.basename(call.slice('mkdir:'.length)))).toEqual([
      'release-validation', 'reports', 'staging',
    ])
    expect(state.capabilityCalls.filter((call) => call.startsWith('open:r:'))).toHaveLength(4)
    expect(state.capabilityCalls.filter((call) => call.startsWith('close:'))).toHaveLength(4)
  })

  it.each(['casefold alias', 'junction reparse'])('rejects a real Windows %s before runner or writes and leaves the root unchanged', async (kind) => {
    const root = await disposableRoot('workbench-preflight-fs-reject-')
    if (kind === 'casefold alias') {
      await fs.mkdir(path.join(root, 'Release-Validation'))
    } else {
      const target = path.join(root, 'junction-target')
      await fs.mkdir(target)
      await fs.symlink(target, path.join(root, 'release-validation'), 'junction')
    }
    const before = await filesystemSnapshot(root)
    const state = newState({ canonicalRoot: root })
    const core = await extractedCore(makeDeps(state))
    await expect(core.testOnly.initializeReleaseDirectories({ workspaceRoot: root })).rejects.toThrow()
    expect(await filesystemSnapshot(root)).toEqual(before)
    expect(state.calls.filter((call) => call.startsWith('command:'))).toEqual([])
    expect(state.capabilityCalls.some((call) => call.startsWith('write:') || call.startsWith('rename:'))).toBe(false)
  })

  it('Task2C2 rename quarantines a held stale PASS by one rename, stable reopen, same bytes, and canonical absence', async () => {
    const root = await disposableRoot('workbench-preflight-fs-quarantine-')
    const state = newState({ canonicalRoot: root })
    const core = await extractedCore(makeDeps(state))
    await core.testOnly.initializeReleaseDirectories({ workspaceRoot: root })
    const canonical = path.join(root, 'release-validation', 'reports', 'preflight.json')
    const staleBytes = Buffer.from('{"status":"PASS","authority":false}\n')
    await fs.writeFile(canonical, staleBytes)
    const result = await core.testOnly.quarantinePreflightEvidence({ workspaceRoot: root })
    await expect(fs.stat(canonical)).rejects.toMatchObject({ code: 'ENOENT' })
    const names = await fs.readdir(path.dirname(canonical))
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^preflight\.stale\.[a-f0-9]{24}\.json$/u)
    expect(await fs.readFile(path.join(path.dirname(canonical), names[0]))).toEqual(staleBytes)
    expect(result).toEqual({ quarantinedRelativePath: `release-validation/reports/${names[0]}`, sha256: crypto.createHash('sha256').update(staleBytes).digest('hex') })
    expect(state.capabilityCalls.filter((call) => call.startsWith('rename:'))).toHaveLength(1)
    expect(state.capabilityCalls.filter((call) => call.startsWith('read:')).length).toBeGreaterThanOrEqual(2)
  })

  it('Task2C2 rename rejects a same-byte stale-report replacement at the quarantine rename boundary', async () => {
    const root = await disposableRoot('workbench-preflight-fs-quarantine-race-')
    const state = newState({ canonicalRoot: root })
    const base = makeDeps(state)
    const core = await extractedCore(deepFreeze({
      ...base,
      renamePath: async (source: string, destination: string) => {
        if (source.endsWith(`${path.sep}preflight.json`)) {
          const bytes = await fs.readFile(source)
          await fs.rename(source, `${source}.replaced`)
          await fs.writeFile(source, bytes)
        }
        return await base.renamePath(source, destination)
      },
    }))
    await core.testOnly.initializeReleaseDirectories({ workspaceRoot: root })
    const canonical = path.join(root, 'release-validation', 'reports', 'preflight.json')
    await fs.writeFile(canonical, '{"status":"PASS"}\n')

    await expect(core.testOnly.quarantinePreflightEvidence({ workspaceRoot: root })).rejects.toThrow()
  })

  it('Task2C2 rename rejects a quarantine sibling visible at the final pre-rename absence check', async () => {
    const root = await disposableRoot('workbench-preflight-fs-quarantine-collision-')
    const state = newState({ canonicalRoot: root })
    const base = makeDeps(state)
    let collisionPath = ''
    const sentinel = Buffer.from('collision-owner')
    let siblingAbsenceReads = 0
    const core = await extractedCore(deepFreeze({
      ...base,
      readPathStat: async (filePath: string) => {
        if (/preflight\.stale\.[a-f0-9]{24}\.json$/u.test(filePath)) {
          collisionPath = filePath
          siblingAbsenceReads += 1
          if (siblingAbsenceReads === 2) await fs.writeFile(filePath, sentinel)
        }
        return await base.readPathStat(filePath)
      },
    }))
    await core.testOnly.initializeReleaseDirectories({ workspaceRoot: root })
    const canonical = path.join(root, 'release-validation', 'reports', 'preflight.json')
    const stale = Buffer.from('{"status":"PASS"}\n')
    await fs.writeFile(canonical, stale)
    await expect(core.testOnly.quarantinePreflightEvidence({ workspaceRoot: root })).rejects.toThrow()
    expect(await fs.readFile(canonical)).toEqual(stale)
    expect(await fs.readFile(collisionPath)).toEqual(sentinel)
    expect(state.capabilityCalls.filter((call) => call.startsWith('rename:'))).toEqual([])
  })

  it('rechecks the retained reports-directory identity after quarantine and before npm', async () => {
    const state = newState()
    const baseDeps = makeDeps(state)
    const reports = path.join(workspaceRoot, 'release-validation', 'reports')
    let reportHandleStats = 0
    const deps = {
      ...baseDeps,
      openPath: async (filePath: string, flags: string) => {
        const handle = await baseDeps.openPath(filePath, flags)
        if (filePath !== reports || flags !== 'r') return handle
        return Object.freeze({
          ...handle,
          stat: async () => {
            reportHandleStats += 1
            if (reportHandleStats === 4) {
              state.directoryIdentityOverrides = { 'release-validation/reports': 'rebound-reports-directory' }
            }
            return await handle.stat()
          },
        })
      },
    }
    const core = await extractedCore(deps)
    const releaseFacts = await core.runEarlyGitPackageGate({ workspaceRoot })
    await expect(core.prepareDependencyBootstrap({ workspaceRoot, releaseFacts })).rejects.toThrow(/directory lease/iu)
    expect(reportHandleStats).toBeGreaterThanOrEqual(4)
    expect(state.calls).not.toContain('command:npm-ci-ignore-scripts')
  })

  it('Task2C2 rename publishes metadata with exact pretty LF bytes, sync, one rename, stable reopen/hash, and refuses an old destination', async () => {
    const root = await disposableRoot('workbench-preflight-fs-metadata-')
    const state = newState({ canonicalRoot: root })
    const core = await extractedCore(makeDeps(state))
    await core.testOnly.initializeReleaseDirectories({ workspaceRoot: root })
    const metadata = validMetadata()
    const published = await core.testOnly.writePreparedMetadata({ workspaceRoot: root, metadata })
    const bytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`)
    const destination = path.join(root, 'release-validation', 'staging', 'release-metadata.json')
    expect(await fs.readFile(destination)).toEqual(bytes)
    expect(published).toEqual({ relativePath: 'release-validation/staging/release-metadata.json', sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
    expect(state.capabilityCalls.some((call) => call.startsWith('sync:'))).toBe(true)
    expect(state.capabilityCalls.filter((call) => call.startsWith('rename:'))).toHaveLength(1)
    expect(state.capabilityCalls.filter((call) => call === `read:${destination}`)).toHaveLength(4)
    const before = await fs.readFile(destination)
    await expect(core.testOnly.writePreparedMetadata({ workspaceRoot: root, metadata: { ...metadata, buildId: 'replacement' } })).rejects.toThrow()
    expect(await fs.readFile(destination)).toEqual(before)
  })

  it.each([
    ['missing field', (() => { const value = { ...validMetadata() } as Record<string, unknown>; delete value.purpose; return value })()],
    ['extra field', validMetadata({ extra: true })],
    ['reordered field', Object.fromEntries([...Object.entries(validMetadata()).slice(1), Object.entries(validMetadata())[0]])],
    ['wrong type', validMetadata({ metadataSchemaVersion: '1' })],
    ['noncanonical time', validMetadata({ buildTimeUtc: '2023-11-14T22:13:20.000Z', buildId: '1.0.1-rc.1+aaaaaaaaaaaa.20231114T221320.000Z' })],
    ['invalid time', validMetadata({ buildTimeUtc: '2023-02-30T22:13:20Z', buildId: '1.0.1-rc.1+aaaaaaaaaaaa.20230230T221320Z' })],
    ['build ID mismatch', validMetadata({ buildId: '1.0.1-rc.1+aaaaaaaaaaaa.20231114T221321Z' })],
    ['commit relation drift', validMetadata({ commitShort: 'aaaaaaaaaaa' })],
    ['commit fact drift', validMetadata({ commitSha: 'b'.repeat(40), commitShort: 'b'.repeat(12), buildId: '1.0.1-rc.1+bbbbbbbbbbbb.20231114T221320Z' })],
    ['hash syntax drift', validMetadata({ lockfileSha256: 'A'.repeat(64) })],
    ['hash fact drift', validMetadata({ releaseNotesSha256: 'd'.repeat(64) })],
    ['toolchain fact drift', validMetadata({ npmVersion: '11.12.2' })],
  ])('rejects post-rename metadata schema case: %s without PreparedMetadata or a reusable token', async (_label, metadataValue) => {
    const state = newState({ metadataValue })
    const core = await extractedCore(makeDeps(state))
    const releaseFacts = await core.runEarlyGitPackageGate({ workspaceRoot })
    const dependencyBootstrap = await core.prepareDependencyBootstrap({ workspaceRoot, releaseFacts })

    await expect(core.prepareReleaseMetadata({ workspaceRoot, releaseFacts, dependencyBootstrap })).rejects.toThrow()

    expect(state.writes).toContain('metadata')
    await expect(core.runPreflight({ context: expectedContext(), dependencyBootstrap })).rejects.toThrow()
    expect(state.calls.some((name) => name.startsWith('command:lifecycle-'))).toBe(false)
    expect(state.writes).not.toContain('preflight-report')
    expect(heldHandleCounts(state)[0]).toBe(heldHandleCounts(state)[1])
  })

  it('Task2C2 rename rejects a metadata destination visible at the final pre-rename absence check', async () => {
    const root = await disposableRoot('workbench-preflight-fs-metadata-collision-')
    const state = newState({ canonicalRoot: root })
    const base = makeDeps(state)
    const sentinel = Buffer.from('collision-owner')
    const destination = path.join(root, 'release-validation', 'staging', 'release-metadata.json')
    let destinationAbsenceReads = 0
    const core = await extractedCore(deepFreeze({
      ...base,
      readPathStat: async (filePath: string) => {
        if (filePath === destination) {
          destinationAbsenceReads += 1
          if (destinationAbsenceReads === 3) await fs.writeFile(filePath, sentinel)
        }
        return await base.readPathStat(filePath)
      },
    }))
    await core.testOnly.initializeReleaseDirectories({ workspaceRoot: root })
    await expect(core.testOnly.writePreparedMetadata({ workspaceRoot: root, metadata: { schemaVersion: 1 } })).rejects.toThrow()
    expect(await fs.readFile(destination)).toEqual(sentinel)
  })

  it('Task2C2 rename rejects a staging-parent identity swap after publication even when the file inode and bytes remain stable', async () => {
    const state = newState()
    const baseDeps = makeDeps(state)
    const destination = path.join(workspaceRoot, 'release-validation', 'staging', 'release-metadata.json')
    const deps = {
      ...baseDeps,
      renamePath: async (source: string, target: string) => {
        await baseDeps.renamePath(source, target)
        if (target === destination) {
          state.directoryIdentityOverrides = { 'release-validation/staging': 'rebound-staging-directory' }
        }
      },
    }
    const core = await extractedCore(deps)
    await expect(core.testOnly.writePreparedMetadata({ workspaceRoot, metadata: { schemaVersion: 1 } })).rejects.toThrow(/directory lease/iu)
    expect(state.writes).not.toEqual([])
  })

  it('Task2C2 rename strictly parses and publishes a canonical report after one rename and stable reopen', async () => {
    const root = await disposableRoot('workbench-preflight-fs-report-')
    await fs.mkdir(path.join(root, 'scripts', 'release', 'lib'), { recursive: true })
    await fs.mkdir(path.join(root, 'node_modules'), { recursive: true })
    await fs.copyFile(path.join(workspaceRoot, 'scripts', 'release', 'lib', 'report-schema.mjs'), path.join(root, 'scripts', 'release', 'lib', 'report-schema.mjs'))
    await fs.cp(path.join(workspaceRoot, 'node_modules', 'zod'), path.join(root, 'node_modules', 'zod'), { recursive: true })
    const state = newState({ canonicalRoot: root })
    const core = await extractedCore(makeDeps(state))
    await core.testOnly.initializeReleaseDirectories({ workspaceRoot: root })
    const report = passingReport()
    const result = await core.testOnly.publishPreflightReport({ workspaceRoot: root, report })
    const destination = path.join(root, 'release-validation', 'reports', 'preflight.json')
    const bytes = await fs.readFile(destination)
    expect(result).toEqual({ reportPath: 'release-validation/reports/preflight.json', reportSha256: crypto.createHash('sha256').update(bytes).digest('hex'), itemId: 'ARTIFACT-PREFLIGHT' })
    expect(bytes.at(-1)).toBe(0x0a)
    expect(state.importCalls).toEqual([
      pathToFileURL(path.join(root, 'node_modules', 'zod', 'index.js')).href,
      pathToFileURL(path.join(root, 'scripts', 'release', 'lib', 'report-schema.mjs')).href,
    ])
    expect(state.capabilityCalls.filter((call) => call.startsWith('rename:'))).toHaveLength(1)
    await expect(core.testOnly.publishPreflightReport({ workspaceRoot: root, report: { ...report, status: 'PASS', checks: [] } })).rejects.toThrow()
    expect(await fs.readFile(destination)).toEqual(bytes)
  })

  it('Task2C2 rename rejects a report destination visible at the final pre-rename absence check without overwriting it', async () => {
    const root = await disposableRoot('workbench-preflight-fs-report-collision-')
    await fs.mkdir(path.join(root, 'scripts', 'release', 'lib'), { recursive: true })
    await fs.mkdir(path.join(root, 'node_modules'), { recursive: true })
    await fs.copyFile(path.join(workspaceRoot, 'scripts', 'release', 'lib', 'report-schema.mjs'), path.join(root, 'scripts', 'release', 'lib', 'report-schema.mjs'))
    await fs.cp(path.join(workspaceRoot, 'node_modules', 'zod'), path.join(root, 'node_modules', 'zod'), { recursive: true })
    const state = newState({ canonicalRoot: root })
    const base = makeDeps(state)
    const destination = path.join(root, 'release-validation', 'reports', 'preflight.json')
    const sentinel = Buffer.from('report-collision-owner')
    let destinationAbsenceReads = 0
    const core = await extractedCore(deepFreeze({
      ...base,
      readPathStat: async (filePath: string) => {
        if (filePath === destination) {
          destinationAbsenceReads += 1
          if (destinationAbsenceReads === 3) await fs.writeFile(filePath, sentinel)
        }
        return await base.readPathStat(filePath)
      },
    }))
    await core.testOnly.initializeReleaseDirectories({ workspaceRoot: root })
    await expect(core.testOnly.publishPreflightReport({ workspaceRoot: root, report: passingReport() })).rejects.toThrow(/destination appeared/iu)
    expect(await fs.readFile(destination)).toEqual(sentinel)
    expect(state.capabilityCalls.filter((call) => call.startsWith('rename:'))).toEqual([])
  })

  it.each([
    ['quarantine', 'before'], ['quarantine', 'after'],
    ['metadata', 'before'], ['metadata', 'after'],
    ['report', 'before'], ['report', 'after'],
  ])('Task2C2 rename returns no %s success object when rename throws %s the move and performs no cleanup', async (operation, timing) => {
    const root = await disposableRoot(`workbench-preflight-rename-${operation}-${timing}-`)
    if (operation === 'report') {
      await fs.mkdir(path.join(root, 'scripts', 'release', 'lib'), { recursive: true })
      await fs.mkdir(path.join(root, 'node_modules'), { recursive: true })
      await fs.copyFile(path.join(workspaceRoot, 'scripts', 'release', 'lib', 'report-schema.mjs'), path.join(root, 'scripts', 'release', 'lib', 'report-schema.mjs'))
      await fs.cp(path.join(workspaceRoot, 'node_modules', 'zod'), path.join(root, 'node_modules', 'zod'), { recursive: true })
    }
    const state = newState({ canonicalRoot: root })
    const base = makeDeps(state)
    let renameAttempts = 0
    const core = await extractedCore(deepFreeze({
      ...base,
      renamePath: async (source: string, destination: string) => {
        renameAttempts += 1
        if (timing === 'before') throw new Error('fixture rename before move')
        await base.renamePath(source, destination)
        throw new Error('fixture rename after move')
      },
    }))
    await core.testOnly.initializeReleaseDirectories({ workspaceRoot: root })
    if (operation === 'quarantine') {
      await fs.writeFile(path.join(root, 'release-validation', 'reports', 'preflight.json'), '{"status":"PASS"}\n')
      await expect(core.testOnly.quarantinePreflightEvidence({ workspaceRoot: root })).rejects.toThrow(/rename/iu)
    } else if (operation === 'metadata') {
      await expect(core.testOnly.writePreparedMetadata({ workspaceRoot: root, metadata: { schemaVersion: 1 } })).rejects.toThrow(/rename/iu)
    } else {
      await expect(core.testOnly.publishPreflightReport({ workspaceRoot: root, report: passingReport() })).rejects.toThrow(/rename/iu)
    }
    expect(renameAttempts).toBe(1)
    expect(heldHandleCounts(state)[0]).toBe(heldHandleCounts(state)[1])
  })

  it.each(['metadata', 'report'])('Task2C2 rename rejects a same-byte %s temp inode replacement at the rename boundary', async (operation) => {
    const root = await disposableRoot(`workbench-preflight-rename-same-bytes-${operation}-`)
    if (operation === 'report') {
      await fs.mkdir(path.join(root, 'scripts', 'release', 'lib'), { recursive: true })
      await fs.mkdir(path.join(root, 'node_modules'), { recursive: true })
      await fs.copyFile(path.join(workspaceRoot, 'scripts', 'release', 'lib', 'report-schema.mjs'), path.join(root, 'scripts', 'release', 'lib', 'report-schema.mjs'))
      await fs.cp(path.join(workspaceRoot, 'node_modules', 'zod'), path.join(root, 'node_modules', 'zod'), { recursive: true })
    }
    const state = newState({ canonicalRoot: root })
    const base = makeDeps(state)
    const core = await extractedCore(deepFreeze({
      ...base,
      renamePath: async (source: string, destination: string) => {
        const bytes = await fs.readFile(source)
        await fs.rename(source, `${source}.held-original`)
        await fs.writeFile(source, bytes)
        await base.renamePath(source, destination)
      },
    }))
    await core.testOnly.initializeReleaseDirectories({ workspaceRoot: root })
    const action = operation === 'metadata'
      ? core.testOnly.writePreparedMetadata({ workspaceRoot: root, metadata: { schemaVersion: 1 } })
      : core.testOnly.publishPreflightReport({ workspaceRoot: root, report: passingReport() })
    await expect(action).rejects.toThrow(/identity|stable reopen|drift/iu)
  })

  it.each(['identity', 'hash'])('Task2C2 rename rejects metadata stable-reopen %s drift after the move', async (kind) => {
    const root = await disposableRoot(`workbench-preflight-rename-reopen-${kind}-`)
    const state = newState({ canonicalRoot: root })
    const core = await extractedCore(makeDeps(state))
    await core.testOnly.initializeReleaseDirectories({ workspaceRoot: root })
    const relativePath = 'release-validation/staging/release-metadata.json'
    if (kind === 'identity') state.openIdentityOverrides = { [relativePath]: 'replacement-destination-inode' }
    else state.openReadOverrides = { [relativePath]: { bytes: new TextEncoder().encode('{"schemaVersion":2}\n'), afterReads: 0 } }
    await expect(core.testOnly.writePreparedMetadata({ workspaceRoot: root, metadata: { schemaVersion: 1 } })).rejects.toThrow()
  })

  it('Task2C2 rename validates report schema again under the destination lease after rename', async () => {
    const root = await disposableRoot('workbench-preflight-rename-report-schema-')
    await fs.mkdir(path.join(root, 'scripts', 'release', 'lib'), { recursive: true })
    await fs.mkdir(path.join(root, 'node_modules'), { recursive: true })
    await fs.copyFile(path.join(workspaceRoot, 'scripts', 'release', 'lib', 'report-schema.mjs'), path.join(root, 'scripts', 'release', 'lib', 'report-schema.mjs'))
    await fs.cp(path.join(workspaceRoot, 'node_modules', 'zod'), path.join(root, 'node_modules', 'zod'), { recursive: true })
    const state = newState({ canonicalRoot: root })
    const base = makeDeps(state)
    let reportParseCalls = 0
    const core = await extractedCore(deepFreeze({
      ...base,
      importProtectedModule: async (specifier: string) => {
        const imported = await base.importProtectedModule(specifier)
        if (!specifier.endsWith('/report-schema.mjs')) return imported
        return {
          ...imported,
          PreflightReportSchema: {
            parse: (value: unknown) => {
              reportParseCalls += 1
              if (reportParseCalls === 2) throw new Error('fixture destination schema drift')
              return imported.PreflightReportSchema.parse(value)
            },
          },
        }
      },
    }))
    await core.testOnly.initializeReleaseDirectories({ workspaceRoot: root })
    await expect(core.testOnly.publishPreflightReport({ workspaceRoot: root, report: passingReport() })).rejects.toThrow(/schema drift/iu)
    expect(reportParseCalls).toBe(2)
  })

  it('fires protected import sentinels only after exact pre/final validation and never on a failed epoch', async () => {
    const sentinelRoot = await disposableRoot('workbench-preflight-import-')
    const paths = [
      'node_modules/zod/index.js',
      'scripts/release/lib/report-schema.mjs',
      'node_modules/semver/index.js',
      'node_modules/node-abi/index.js',
      'scripts/release/lib/security-checklist.mjs',
      'scripts/release/native-abi-probe.mjs',
    ]
    const markerBytes = [
      new TextEncoder().encode('fixture:zod-entry'),
      new TextEncoder().encode('task2c2:report-schema'),
      new TextEncoder().encode('fixture:semver-entry'),
      new TextEncoder().encode('fixture:node-abi-entry'),
      new TextEncoder().encode('task2c2:security-checklist'),
      new TextEncoder().encode('task2c2:native-abi-probe'),
    ]
    const makeSentinelDeps = (state: TestState) => {
      const base = makeDeps(state)
      for (const [index, relativePath] of paths.entries()) {
        state.virtualFiles!.set(relativePath, markerBytes[index])
        state.virtualIdentities!.set(relativePath, `sentinel-module-${index}`)
      }
      state.hashOverrides = {
        ...state.hashOverrides,
        'scripts/release/lib/report-schema.mjs': FIXED_WORKSPACE_HASHES['report-schema'],
      }
      return {
        ...base,
        importProtectedModule: async (specifier: string) => {
          const relativePath = paths.find((candidate) => specifier === pathToFileURL(path.join(workspaceRoot, ...candidate.split('/'))).href)
          if (!relativePath) throw new Error('unexpected protected import')
          const index = paths.indexOf(relativePath)
          expect(state.virtualFiles!.get(relativePath)).toEqual(markerBytes[index])
          state.importCalls.push(specifier)
          await fs.writeFile(path.join(sentinelRoot, `sentinel-${index}`), markerBytes[index])
          return relativePath.endsWith('/report-schema.mjs') ? { PreflightReportSchema: { parse: (value: unknown) => value } } : { fixture: true }
        },
      }
    }
    const rejectedState = newState({ preTreePatch: { treeSha256: '0'.repeat(64) } })
    const rejectedCore = await extractedCore(makeSentinelDeps(rejectedState))
    await expect(rejectedCore.testOnly.runProtectedImportEpoch({ workspaceRoot, phase: 'pre' })).rejects.toThrow()
    expect(rejectedState.importCalls).toEqual([])
    for (let index = 0; index < paths.length; index += 1) await expect(fs.stat(path.join(sentinelRoot, `sentinel-${index}`))).rejects.toMatchObject({ code: 'ENOENT' })

    const acceptedState = newState()
    const acceptedCore = await extractedCore(makeSentinelDeps(acceptedState))
    await acceptedCore.testOnly.runProtectedImportEpoch({ workspaceRoot, phase: 'pre' })
    await acceptedCore.testOnly.runProtectedImportEpoch({ workspaceRoot, phase: 'post' })
    expect(acceptedState.importCalls).toEqual(paths.map((relativePath) => pathToFileURL(path.join(workspaceRoot, ...relativePath.split('/'))).href))
    for (let index = 0; index < paths.length; index += 1) expect(await fs.readFile(path.join(sentinelRoot, `sentinel-${index}`))).toEqual(Buffer.from(markerBytes[index]))
  })

  it('rejects pre-lifecycle transitive drift after the first tree scan and before any protected import', async () => {
    const state = newState()
    const baseDeps = makeDeps(state)
    let armed = true
    const deps = {
      ...baseDeps,
      openPath: async (filePath: string, flags: string) => {
        const relativePath = path.relative(workspaceRoot, filePath).replaceAll('\\', '/')
        if (armed && relativePath === 'scripts/release/lib/report-schema.mjs') {
          const target = 'node_modules/zod/package.json'
          const changed = new Uint8Array(state.virtualFiles!.get(target)!)
          changed[0] ^= 1
          state.virtualFiles!.set(target, changed)
          armed = false
        }
        return await baseDeps.openPath(filePath, flags)
      },
    }
    const core = await extractedCore(deps)
    await expect(core.testOnly.runProtectedImportEpoch({ workspaceRoot, phase: 'pre' })).rejects.toThrow(/tree/iu)
    expect(state.importCalls).toEqual([])
  })

  it('rejects pre-lifecycle transitive drift immediately after the first protected import', async () => {
    const state = newState()
    const baseDeps = makeDeps(state)
    let armed = true
    const deps = {
      ...baseDeps,
      importProtectedModule: async (specifier: string) => {
        const imported = await baseDeps.importProtectedModule(specifier)
        if (armed && specifier.endsWith('/node_modules/zod/index.js')) {
          const target = 'node_modules/zod/package.json'
          const changed = new Uint8Array(state.virtualFiles!.get(target)!)
          changed[0] ^= 1
          state.virtualFiles!.set(target, changed)
          armed = false
        }
        return imported
      },
    }
    const core = await extractedCore(deps)
    await expect(core.testOnly.runProtectedImportEpoch({ workspaceRoot, phase: 'pre' })).rejects.toThrow(/tree/iu)
    expect(state.importCalls).toEqual([pathToFileURL(path.join(workspaceRoot, 'node_modules', 'zod', 'index.js')).href])
  })

  it('rejects final-tree transitive drift after lease creation and before a protected import', async () => {
    const state = newState()
    const baseDeps = makeDeps(state)
    let armed = false
    const deps = {
      ...baseDeps,
      openPath: async (filePath: string, flags: string) => {
        const relativePath = path.relative(workspaceRoot, filePath).replaceAll('\\', '/')
        if (armed && relativePath === 'release-validation/reports/preflight.json') {
          const target = 'node_modules/electron/install.js'
          const changed = new Uint8Array(state.virtualFiles!.get(target)!)
          changed[0] ^= 1
          state.virtualFiles!.set(target, changed)
          armed = false
        }
        return await baseDeps.openPath(filePath, flags)
      },
    }
    const core = await extractedCore(deps)
    const { context, preflightReference } = await completedPreflight(core, state)
    const importsBefore = [...state.importCalls]
    const writesBefore = [...state.writes]
    armed = true
    await expect(core.loadBoundPreflightReport({ workspaceRoot, context, preflightReference })).rejects.toThrow(/tree/iu)
    expect(state.importCalls).toEqual(importsBefore)
    expect(state.writes).toEqual(writesBefore)
  })

  it('rejects final-tree transitive drift immediately after a protected import', async () => {
    const state = newState()
    const baseDeps = makeDeps(state)
    let armed = false
    const deps = {
      ...baseDeps,
      importProtectedModule: async (specifier: string) => {
        const imported = await baseDeps.importProtectedModule(specifier)
        if (armed && specifier.endsWith('/scripts/release/lib/report-schema.mjs')) {
          const target = 'node_modules/electron/install.js'
          const changed = new Uint8Array(state.virtualFiles!.get(target)!)
          changed[0] ^= 1
          state.virtualFiles!.set(target, changed)
          armed = false
        }
        return imported
      },
    }
    const core = await extractedCore(deps)
    const { context, preflightReference } = await completedPreflight(core, state)
    const importsBefore = state.importCalls.length
    const writesBefore = [...state.writes]
    armed = true
    await expect(core.loadBoundPreflightReport({ workspaceRoot, context, preflightReference })).rejects.toThrow(/tree/iu)
    expect(state.importCalls).toHaveLength(importsBefore + 1)
    expect(state.writes).toEqual(writesBefore)
  })

  it('loads a frozen context with a byte-identical real root and zero fs-write, clock, environment, bootstrap, lifecycle, or quarantine capability', async () => {
    const root = await fs.realpath(await disposableRoot('workbench-preflight-frozen-'))
    await fs.mkdir(path.join(root, 'release-validation', 'reports'), { recursive: true })
    await fs.mkdir(path.join(root, 'release-validation', 'staging'), { recursive: true })
    await fs.writeFile(path.join(root, 'release-validation', 'reports', 'preflight.json'), JSON.stringify(passingReport()))
    await fs.writeFile(
      path.join(root, 'release-validation', 'staging', 'release-metadata.json'),
      `${JSON.stringify(validMetadata(), null, 2)}\n`,
    )
    const before = await filesystemSnapshot(root)
    const realRelativePaths = new Set([
      'release-validation',
      'release-validation/reports',
      'release-validation/reports/preflight.json',
      'release-validation/staging',
      'release-validation/staging/release-metadata.json',
    ])
    const state = newState({ canonicalRoot: root, virtualModel: true, realRelativePaths, report: passingReport() })
    const deps = makeDeps(state)
    const fixtureInputs = new Set([
      'package.json',
      ...FIXED_GATE_HASHES.map(([relativePath]) => relativePath),
      ...WORKSPACE_ENTRY_ROWS.map(([, relativePath]) => relativePath),
    ])
    for (const relativePath of fixtureInputs) {
      const bytes = await fs.readFile(path.join(workspaceRoot, ...relativePath.split('/')))
      state.virtualFiles!.set(relativePath, new Uint8Array(bytes))
      state.virtualIdentities!.set(relativePath, crypto.createHash('sha256').update(`frozen:${relativePath}`).digest('hex'))
    }
    const core = await extractedCore(deps)
    await core.loadFrozenPreflightContext({ workspaceRoot: root })
    expect(await filesystemSnapshot(root)).toEqual(before)
    expect(state.capabilityCalls.some((call) => /^(?:mkdir|write|rename):/u.test(call))).toBe(false)
    expect([state.clockReads, state.environmentReads]).toEqual([0, 0])
    expect(state.calls.filter((call) => call.startsWith('command:'))).toEqual([
      'command:git-symbolic-head', 'command:git-head', 'command:git-status', 'command:git-untracked-audit',
      'command:git-diff-quiet', 'command:git-config-audit', 'command:git-index-audit', 'command:git-replace-audit',
      'command:git-worktree-list', 'command:git-main-config-audit', 'command:git-main-index-audit',
      'command:git-main-status', 'command:git-main-untracked-audit', 'command:git-main-head',
      'command:git-source-epoch', 'command:git-package-blob-hash', 'command:node-version',
      'command:npm-version', 'command:git-version',
    ])
    expect(state.calls.some((call) => call === 'quarantine' || call === 'metadata' || call === 'publish-report')).toBe(false)
  })
})

describe('ordered lifecycle, report, ABI, and context behavior', { timeout: 120_000 }, () => {
  it('executes the immutable ten-stage PASS sequence with one full suite and one exact context identity', async () => {
    const state = newState()
    const core = await extractedCore(makeDeps(state))
    const { dependencyBootstrap } = await bootstrapped(core)
    const context = expectedContext()
    const result = await core.runPreflight({ context, dependencyBootstrap })
    expect(result).toEqual({
      stage: 'preflight', contextId: SHA_D, scope: 'closed_beta_required', status: 'PASS',
      evidence: [{ reportPath: 'release-validation/reports/preflight.json', reportSha256: expect.stringMatching(/^[a-f0-9]{64}$/u), itemId: 'ARTIFACT-PREFLIGHT' }],
      blocker: null,
    })
    const report = publishedReport(state)
    expect([...report.commands, ...report.checks].map((row) => row.id)).toEqual(STAGE_IDS)
    expect(report.tests).toEqual({ files: 99, tests: 777, passed: 777, failed: 0, skipped: 0, todo: 0 })
    expect(report.nativeAbi).toEqual({ node: nodeProbe(), electron: electronProbe() })
    expect(state.calls.filter((name) => name === 'command:test-full')).toHaveLength(1)
    await expect(core.loadPostInstallBindings({ workspaceRoot, context })).resolves.toBeDefined()
    await expect(core.loadPostInstallBindings({ workspaceRoot, context: { ...context } })).rejects.toThrow(/owned/iu)
  })

  it('surrounds each exact lifecycle payload with independent pre/post observations and reaches only the exact final tree', async () => {
    const state = newState()
    const core = await extractedCore(makeDeps(state))
    const { dependencyBootstrap } = await bootstrapped(core)
    state.calls.length = 0
    await core.runPreflight({ context: expectedContext(), dependencyBootstrap })
    expect(state.calls.filter((name) => name.startsWith('command:lifecycle-'))).toEqual([
      'command:lifecycle-electron-install',
      'command:lifecycle-esbuild-install',
      'command:lifecycle-electron-winstaller',
    ])
    for (const row of LIFECYCLE_ROWS) {
      const entry = path.join(workspaceRoot, 'node_modules', ...row.entryRelativePath.split('/'))
      const descriptorIndex = state.capabilityCalls.indexOf(`runner:${row.descriptorId}`)
      const openIndexes = state.capabilityCalls
        .map((call, index) => call === `open:r:${entry}` ? index : -1)
        .filter((index) => index >= 0)
      expect(descriptorIndex, `${row.id} descriptor capability`).toBeGreaterThan(-1)
      expect(openIndexes.some((index) => index < descriptorIndex), `${row.id} before read`).toBe(true)
      expect(openIndexes.some((index) => index > descriptorIndex), `${row.id} after read`).toBe(true)
    }
  })

  it.each([
    ['payload id', { id: 'electron-install-extra' }],
    ['package name', { packageName: 'better-sqlite3' }],
    ['package version', { packageVersion: '35.7.4' }],
    ['working directory', { workingDirectoryRelativePath: 'node_modules/electron' }],
    ['entry path', { entryRelativePath: 'electron/other.js' }],
    ['entry hash', { entrySha256: '0'.repeat(64) }],
    ['arguments', { arguments: ['--unsafe'] }],
    ['node identity', { nodeSha256: '0'.repeat(64) }],
    ['cmd identity', { cmdSha256: '0'.repeat(64) }],
    ['Git drift', { gitClean: false }],
    ['fixed input drift', { fixedInputsValid: false }],
    ['dotenv drift', { dotenvAbsent: false }],
  ])('fails npm-ci before invoking a payload whose pre-observation has %s drift', async (_label, patch) => {
    const state = newState()
    let injectDotenv = false
    const baseDeps = makeDeps(state)
    const deps = _label === 'dotenv drift' ? Object.freeze({
      ...baseDeps,
      readDirectoryNames: async (directory: string) => {
        if (injectDotenv && path.resolve(directory) === path.resolve(workspaceRoot)) {
          injectDotenv = false
          state.capabilityCalls.push(`readdir:${directory}`)
          return ['.env']
        }
        return await baseDeps.readDirectoryNames(directory)
      },
    }) : baseDeps
    const core = await extractedCore(deps)
    const { dependencyBootstrap } = await bootstrapped(core)
    if (_label === 'package name' || _label === 'package version') {
      state.virtualFiles?.set('node_modules/electron/package.json', new TextEncoder().encode(JSON.stringify({
        name: patch.packageName ?? 'electron', version: patch.packageVersion ?? '35.7.5',
      })))
    } else if (_label === 'entry hash') {
      state.hashOverrides = { 'node_modules/electron/install.js': patch.entrySha256 }
    } else if (_label === 'node identity') {
      state.policyPatch = (value) => { value.node.version = 'v24.15.1'; return value }
    } else if (_label === 'cmd identity') {
      state.hashOverrides = { 'scripts/release/lib/trusted-windows-runner.mjs': patch.cmdSha256 }
    } else if (_label === 'Git drift') {
      state.gatePatch.head = 'd'.repeat(40)
    } else if (_label === 'fixed input drift') {
      state.hashOverrides = { 'src/shared/release-contract.json': '0'.repeat(64) }
    } else if (_label === 'dotenv drift') {
      injectDotenv = true
    } else {
      state.policyPatch = (value) => {
        Object.assign(value.dependencyBootstrap.lifecyclePayloads[0], patch)
        return value
      }
    }
    await core.runPreflight({ context: expectedContext(), dependencyBootstrap })
    const report = publishedReport(state)
    expect(report.commands).toEqual([expect.objectContaining({ id: 'npm-ci', status: 'FAIL', category: 'verification-failed', exitCode: null })])
    if (_label === 'package name' || _label === 'package version') {
      expect(state.capabilityCalls.some((call) => call.startsWith(`open:r:${path.join(workspaceRoot, 'node_modules', 'electron', 'package.json')}`))).toBe(true)
    }
    expect(state.calls.some((call) => call.startsWith('payload:'))).toBe(false)
    expect(state.calls).not.toContain('command:lifecycle-electron-install')
    expect(state.calls).not.toContain('command:typecheck')
  })

  it.each([
    ['pre-tree count', { preTreePatch: { fileCount: PRE_LIFECYCLE_TREE.fileCount + 1 } }],
    ['pre-tree bytes', { preTreePatch: { totalBytes: PRE_LIFECYCLE_TREE.totalBytes + 1 } }],
    ['pre-tree digest', { preTreePatch: { treeSha256: '0'.repeat(64) } }],
    ['final-tree count', { finalTreePatch: { fileCount: FINAL_TREE.fileCount + 1 } }],
    ['final-tree bytes', { finalTreePatch: { totalBytes: FINAL_TREE.totalBytes + 1 } }],
    ['final-tree digest', { finalTreePatch: { treeSha256: '0'.repeat(64) } }],
    ['Electron executable', { finalTreePatch: { electronExecutableSha256: '0'.repeat(64) } }],
  ])('rejects exact %s mismatch and never advances beyond npm-ci', async (_label, patch) => {
    const state = newState(patch)
    const core = await extractedCore(makeDeps(state))
    const facts = await core.runEarlyGitPackageGate({ workspaceRoot })
    if ('preTreePatch' in patch) {
      await expect(core.prepareDependencyBootstrap({ workspaceRoot, releaseFacts: facts })).rejects.toThrow()
      expect(state.calls.some((name) => name.startsWith('command:lifecycle-'))).toBe(false)
      return
    }
    const dependencyBootstrap = await core.prepareDependencyBootstrap({ workspaceRoot, releaseFacts: facts })
    await core.prepareReleaseMetadata({ workspaceRoot, releaseFacts: facts, dependencyBootstrap })
    await core.runPreflight({ context: expectedContext(), dependencyBootstrap })
    const report = publishedReport(state)
    expect(report.commands).toEqual([expect.objectContaining({ id: 'npm-ci', status: 'FAIL', category: 'verification-failed', exitCode: null })])
    expect(state.calls).not.toContain('command:typecheck')
  })

  it('aggregates both typechecks, one full suite, three builds, and exact dotenv checks without a second Vitest', async () => {
    const state = newState()
    const core = await extractedCore(makeDeps(state))
    const { dependencyBootstrap } = await bootstrapped(core)
    await core.runPreflight({ context: expectedContext(), dependencyBootstrap })
    const orchestrationCommands = new Set([
      'command:typecheck', 'command:typecheck-ipc', 'command:lint', 'command:test-full',
      'command:build-main', 'command:build-preload', 'command:build-renderer',
      'command:icon-verify', 'command:node-abi-probe', 'command:electron-abi-probe',
    ])
    expect(state.calls.filter((name) => orchestrationCommands.has(name))).toEqual([
      'command:typecheck',
      'command:typecheck-ipc',
      'command:lint',
      'command:test-full',
      'command:build-main',
      'command:build-preload',
      'command:build-renderer',
      'command:icon-verify',
      'command:node-abi-probe',
      'command:electron-abi-probe',
    ])
    const buildCalls = state.calls
    for (const descriptor of ['build-main', 'build-preload', 'build-renderer']) {
      const index = buildCalls.indexOf(`command:${descriptor}`)
      expect(buildCalls[index - 1]).toBe('root-enumeration')
      expect(buildCalls[index + 1]).toBe('root-enumeration')
    }
    expect(state.calls.filter((name) => name === 'command:test-full')).toHaveLength(1)
  })

  it.each([
    'before:build-main', 'after:build-main',
    'before:build-preload', 'after:build-preload',
    'before:build-renderer', 'after:build-renderer',
  ])('stops the build row on exact dotenv recheck %s', async (position) => {
    const state = newState({ failAt: `dotenv:${position}` })
    const core = await extractedCore(makeDeps(state))
    const { dependencyBootstrap } = await bootstrapped(core)
    await core.runPreflight({ context: expectedContext(), dependencyBootstrap })
    const report = publishedReport(state)
    expect(report.commands.at(-1)).toMatchObject({ id: 'build', status: 'FAIL', category: 'verification-failed', exitCode: null })
    const [where, descriptor] = position.split(':')
    if (where === 'before') expect(state.calls).not.toContain(`command:${descriptor}`)
    expect(state.calls).not.toContain('security')
  })

  it.each(STAGE_IDS)('freezes the exact first-failure prefix at %s', async (stageId) => {
    const state = newState()
    if (stageId === 'npm-ci') state.commandFailures['lifecycle-electron-install'] = { status: 'FAIL', category: 'child-nonzero', exitCode: 7 }
    else if (stageId === 'typecheck') state.commandFailures.typecheck = { status: 'FAIL', category: 'timeout', exitCode: null }
    else if (stageId === 'lint') state.commandFailures.lint = { status: 'FAIL', category: 'output-limit', exitCode: null }
    else if (stageId === 'test') state.commandFailures['test-full'] = { status: 'FAIL', category: 'child-nonzero', exitCode: 2, tests: { files: 3, tests: 4, passed: 3, failed: 1, skipped: 0, todo: 0 }, requiredCases: REQUIRED_CASES }
    else if (stageId === 'build') state.commandFailures['build-main'] = { status: 'FAIL', category: 'execution', exitCode: null }
    else if (stageId === 'security-static-checks') state.failAt = 'security'
    else if (stageId === 'icon-verify') state.commandFailures['icon-verify'] = { status: 'FAIL', category: 'cleanup-unconfirmed', exitCode: null }
    else if (stageId === 'node-native-abi') state.commandFailures['node-abi-probe'] = { status: 'FAIL', category: 'invalid-output', exitCode: null }
    else if (stageId === 'electron-native-abi') state.commandFailures['electron-abi-probe'] = { status: 'FAIL', category: 'verification-failed', exitCode: null }
    else state.failAt = 'invariants'
    const core = await extractedCore(makeDeps(state))
    const { dependencyBootstrap } = await bootstrapped(core)
    const result = await core.runPreflight({ context: expectedContext(), dependencyBootstrap })
    expect(result.status).toBe('FAIL')
    const report = publishedReport(state)
    const executed = [...report.commands, ...report.checks]
    const position = STAGE_IDS.indexOf(stageId)
    expect(executed.map((row) => row.id)).toEqual(STAGE_IDS.slice(0, position + 1))
    expect(executed.slice(0, -1).every((row) => row.status === 'PASS')).toBe(true)
    expect(executed.at(-1)?.status).toBe('FAIL')
    expect(PreflightReportSchema.safeParse(report).success).toBe(true)
    expect(report.contextId).toBe(expectedContext().contextId)
    expect(report.releaseMetadata).toEqual({ relativePath: expectedContext().metadataPath, sha256: expectedContext().metadataSha256 })
    expect(report.packageLockSha256).toBe(expectedContext().packageLockSha256)
    expect(report.toolchain).toEqual({ ...expectedContext().toolchain, electronBuilderVersion: '26.15.3' })
    expect(report.blocker).toBe(`Preflight ${stageId} failed`)
    expect(report.tests === null).toBe(position < 3)
    expect(report.nativeAbi.node === null).toBe(position < 8)
    expect(report.nativeAbi.electron === null).toBe(position < 9)
  })

  it('rejects a malformed or unknown-field report before any report-writer capability', async () => {
    const root = await disposableRoot('workbench-preflight-report-invalid-')
    const state = newState({ canonicalRoot: root })
    const core = await extractedCore(makeDeps(state))
    await core.testOnly.initializeReleaseDirectories({ workspaceRoot: root })
    const invalid = { ...passingReport(), unknown: true }
    await expect(core.testOnly.publishPreflightReport({ workspaceRoot: root, report: invalid })).rejects.toThrow()
    expect(state.capabilityCalls.some((call) => call.startsWith('open:wx') || call.startsWith('write:') || call.startsWith('rename:'))).toBe(false)
    await expect(fs.stat(path.join(root, 'release-validation', 'reports', 'preflight.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['child-nonzero', 23], ['timeout', null], ['output-limit', null], ['execution', null],
    ['cleanup-unconfirmed', null], ['invalid-output', null], ['verification-failed', null],
  ])('preserves command failure category %s and real-or-null exit code', async (category, exitCode) => {
    const state = newState({ commandFailures: { lint: { status: 'FAIL', category, exitCode } } })
    const core = await extractedCore(makeDeps(state))
    const { dependencyBootstrap } = await bootstrapped(core)
    await core.runPreflight({ context: expectedContext(), dependencyBootstrap })
    const report = publishedReport(state)
    expect(report.commands.at(-1)).toMatchObject({ id: 'lint', status: 'FAIL', category, exitCode })
  })

  it.each([
    ['failed count in a contradictory PASS result', { files: 3, tests: 4, passed: 3, failed: 1, skipped: 0, todo: 0 }, REQUIRED_CASES, null, 'invalid-output'],
    ['skipped count in a contradictory PASS result', { files: 3, tests: 4, passed: 3, failed: 0, skipped: 1, todo: 0 }, REQUIRED_CASES, null, 'invalid-output'],
    ['unreconciled count', { files: 3, tests: 4, passed: 3, failed: 0, skipped: 0, todo: 0 }, REQUIRED_CASES, null, 'invalid-output'],
    ['missing discovery', { files: 3, tests: 4, passed: 4, failed: 0, skipped: 0, todo: 0 }, REQUIRED_CASES.slice(0, -1), { files: 3, tests: 4, passed: 4, failed: 0, skipped: 0, todo: 0 }, 'verification-failed'],
  ])('fails the test row without synthesizing a machine summary: %s', async (_label, tests, requiredCases, expectedReportTests, category) => {
    const state = newState({ commandFailures: { 'test-full': { status: 'PASS', category: null, exitCode: 0, tests, requiredCases } } })
    const core = await extractedCore(makeDeps(state))
    const { dependencyBootstrap } = await bootstrapped(core)
    await core.runPreflight({ context: expectedContext(), dependencyBootstrap })
    const report = publishedReport(state)
    expect(report.status).toBe('FAIL')
    expect(report.commands.at(-1)).toMatchObject({ id: 'test', status: 'FAIL', category, exitCode: null })
    expect(report.tests).toEqual(expectedReportTests)
  })

  it('preserves a trustworthy child-nonzero full-suite summary with its real failed and skipped counts', async () => {
    const tests = { files: 9, tests: 12, passed: 8, failed: 2, skipped: 1, todo: 1 }
    const state = newState({ commandFailures: { 'test-full': {
      status: 'FAIL', category: 'child-nonzero', exitCode: 1, tests, requiredCases: REQUIRED_CASES,
    } } })
    const core = await extractedCore(makeDeps(state))
    const { dependencyBootstrap } = await bootstrapped(core)
    await core.runPreflight({ context: expectedContext(), dependencyBootstrap })
    const report = publishedReport(state)
    expect(report.commands.at(-1)).toMatchObject({ id: 'test', status: 'FAIL', category: 'child-nonzero', exitCode: 1 })
    expect(report.tests).toEqual(tests)
  })

  it('revalidates candidate and main Git plus reviewed fixed inputs at the final invariant boundary', async () => {
    const state = newState({ failAt: 'invariants' })
    const core = await extractedCore(makeDeps(state))
    const { dependencyBootstrap } = await bootstrapped(core)
    await core.runPreflight({ context: expectedContext(), dependencyBootstrap })
    const report = publishedReport(state)
    expect(report.checks.at(-1)).toEqual(expect.objectContaining({ id: 'release-invariants', status: 'FAIL' }))
    expect(state.calls.filter((call) => call === 'command:test-full')).toHaveLength(1)
  })

  it.each([
    ['staging metadata bytes', (state: TestState) => {
      state.virtualFiles!.set('release-validation/staging/release-metadata.json', new TextEncoder().encode(`${JSON.stringify(validMetadata({ buildId: 'forged' }), null, 2)}\n`))
    }],
    ['compiled Main duplicate metadata embedding', (state: TestState) => {
      const metadataText = `${JSON.stringify(validMetadata(), null, 2)}\n`
      state.virtualFiles!.set('dist/main/index.js', new TextEncoder().encode(`${JSON.stringify(metadataText)}\n${JSON.stringify(metadataText)}\n`))
    }],
  ])('fails release-invariants when %s breaks metadata staging/context/dist parity', async (_label, mutate) => {
    const state = newState()
    const core = await extractedCore(makeDeps(state))
    const { dependencyBootstrap } = await bootstrapped(core)
    mutate(state)
    await core.runPreflight({ context: expectedContext(), dependencyBootstrap })
    expect(publishedReport(state).checks.at(-1)).toEqual(expect.objectContaining({ id: 'release-invariants', status: 'FAIL' }))
  })

  it.each([
    ['tracked app-update YAML', 'build-resources/app-update.yml', new TextEncoder().encode('provider: generic\nurl: https://updates.invalid/changed/\nupdaterCacheDirName: claude-workbench-updater\n')],
    ['tracked generated PNG', 'build-resources/app-icon.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
  ])('fails release-invariants when %s changes after the final fixed gate read', async (_label, relativePath, bytes) => {
    const state = newState()
    const core = await extractedCore(makeDeps(state))
    const { dependencyBootstrap } = await bootstrapped(core)
    state.invariantReadOverrides = { [relativePath]: { bytes, afterReads: 1 } }
    await core.runPreflight({ context: expectedContext(), dependencyBootstrap })
    expect(publishedReport(state).checks.at(-1)).toEqual(expect.objectContaining({ id: 'release-invariants', status: 'FAIL' }))
  })

  it.each([
    ['app-update generator', 'scripts/generate-app-update-config.mjs'],
    ['NSIS installer include', 'build-resources/installer.nsh'],
  ])('fails only the final release-invariants row when the %s is replaced after the final gate', async (_label, relativePath) => {
    const original = await fs.readFile(path.join(workspaceRoot, ...relativePath.split('/')))
    const replacement = new Uint8Array(Buffer.concat([original, Buffer.from('\nlate invariant replacement\n')]))
    const state = newState({ invariantReadOverrides: { [relativePath]: { bytes: replacement, afterReads: 1 } } })
    const core = await extractedCore(makeDeps(state))
    const { dependencyBootstrap } = await bootstrapped(core)
    await core.runPreflight({ context: expectedContext(), dependencyBootstrap })
    const report = publishedReport(state)
    expect(report.status).toBe('FAIL')
    expect(report.commands.every((row) => row.status === 'PASS')).toBe(true)
    expect(report.checks).toEqual([
      { id: 'security-static-checks', status: 'PASS', durationMs: 0 },
      { id: 'icon-verify', status: 'PASS', durationMs: 0 },
      { id: 'node-native-abi', status: 'PASS', durationMs: 0 },
      { id: 'electron-native-abi', status: 'PASS', durationMs: 0 },
      { id: 'release-invariants', status: 'FAIL', durationMs: 0 },
    ])
  })

  it.each([
    ['package bytes with unchanged allowed semantics', 'package.json', 2],
    ['reviewed release notes', 'docs/releases/1.0.1-rc.1.md', 1],
  ])('holds %s from the final gate through release-invariants', async (_label, relativePath, afterReads) => {
    const bytes = relativePath === 'package.json'
      ? new TextEncoder().encode(`${await fs.readFile(packagePath, 'utf8')}\n`)
      : new TextEncoder().encode('late replacement\n')
    const state = newState({ invariantReadOverrides: { [relativePath]: { bytes, afterReads } } })
    const core = await extractedCore(makeDeps(state))
    const { dependencyBootstrap } = await bootstrapped(core)
    await core.runPreflight({ context: expectedContext(), dependencyBootstrap })
    expect(publishedReport(state).checks.at(-1)).toEqual(expect.objectContaining({ id: 'release-invariants', status: 'FAIL' }))
  })

  it('closes every invariant file and directory handle once when the marker-extracted action returns false', async () => {
    const state = newState()
    const { deps, audit } = makeInvariantHandleAuditedDeps(state)
    const core = await extractedCore(deps)
    const { dependencyBootstrap } = await bootstrapped(core)
    state.virtualFiles!.set(
      'release-validation/staging/release-metadata.json',
      new TextEncoder().encode(`${JSON.stringify(validMetadata({ buildId: 'false-action' }), null, 2)}\n`),
    )
    await core.runPreflight({ context: expectedContext(), dependencyBootstrap })
    const report = publishedReport(state)
    expect(report.status).toBe('FAIL')
    expect(report.checks.at(-1)).toEqual({ id: 'release-invariants', status: 'FAIL', durationMs: 0 })
    expect(audit.opened.some(({ relativePath }) => relativePath === 'build-resources/installer.nsh')).toBe(true)
    expect(audit.opened.some(({ relativePath }) => relativePath === 'dist')).toBe(true)
    assertEveryInvariantHandleClosedOnce(audit)
  })

  it('closes every invariant file and directory handle once when the marker-extracted action throws', async () => {
    const state = newState()
    const { deps, audit } = makeInvariantHandleAuditedDeps(state, { throwFromAction: true })
    const core = await extractedCore(deps)
    const { dependencyBootstrap } = await bootstrapped(core)
    await core.runPreflight({ context: expectedContext(), dependencyBootstrap })
    const report = publishedReport(state)
    expect(report.status).toBe('FAIL')
    expect(report.checks.at(-1)).toEqual({ id: 'release-invariants', status: 'FAIL', durationMs: 0 })
    expect(audit.opened.some(({ relativePath }) => relativePath === 'build-resources/installer.nsh')).toBe(true)
    expect(audit.opened.some(({ relativePath }) => relativePath === 'dist')).toBe(true)
    assertEveryInvariantHandleClosedOnce(audit)
  })

  it('attempts every invariant close once after an inner file or directory low-level close throws', async () => {
    for (const closeFailureRelativePath of ['build-resources/installer.nsh', 'dist']) {
      const state = newState()
      const { deps, audit } = makeInvariantHandleAuditedDeps(state, { closeFailureRelativePath })
      const core = await extractedCore(deps)
      const { dependencyBootstrap } = await bootstrapped(core)
      await core.runPreflight({ context: expectedContext(), dependencyBootstrap })
      const report = publishedReport(state)
      expect(report.status).toBe('FAIL')
      expect(report.checks.at(-1)).toEqual({ id: 'release-invariants', status: 'FAIL', durationMs: 0 })
      expect(audit.opened.filter(({ relativePath }) => relativePath === closeFailureRelativePath)).toHaveLength(1)
      assertEveryInvariantHandleClosedOnce(audit)
    }
  })

  it('fails release-invariants on an unexpected dist root member without executing electron-builder', async () => {
    const state = newState()
    const core = await extractedCore(makeDeps(state))
    const { dependencyBootstrap } = await bootstrapped(core)
    state.virtualFiles!.set('dist/rogue.txt', new TextEncoder().encode('must not be packaged\n'))
    await core.runPreflight({ context: expectedContext(), dependencyBootstrap })
    expect(publishedReport(state).checks.at(-1)).toEqual(expect.objectContaining({ id: 'release-invariants', status: 'FAIL' }))
    expect(state.calls).not.toContain('command:electron-builder-win')
  })

  it('fails release-invariants on an extra compiled Main member', async () => {
    const state = newState()
    const core = await extractedCore(makeDeps(state))
    const { dependencyBootstrap } = await bootstrapped(core)
    state.virtualFiles!.set('dist/main/rogue.js', new TextEncoder().encode('module.exports = {};\n'))
    await core.runPreflight({ context: expectedContext(), dependencyBootstrap })
    expect(publishedReport(state).checks.at(-1)).toEqual(expect.objectContaining({ id: 'release-invariants', status: 'FAIL' }))
  })

  it('defers a committed package main and release-script contract break to release-invariants', async () => {
    const manifest = JSON.parse(await fs.readFile(packagePath, 'utf8'))
    manifest.main = 'src/main/index.ts'
    manifest.scripts['release:preflight'] = 'node scripts/release/preflight.mjs --unsafe'
    const bytes = new TextEncoder().encode(JSON.stringify(manifest))
    const state = newState({
      gatePatch: { packageBlobSha256: crypto.createHash('sha256').update(bytes).digest('hex') },
      openReadOverrides: { 'package.json': { bytes, afterReads: 0 } },
    })
    const core = await extractedCore(makeDeps(state))
    const { dependencyBootstrap } = await bootstrapped(core)
    await core.runPreflight({ context: expectedContext(), dependencyBootstrap })
    expect(publishedReport(state).checks.at(-1)).toEqual(expect.objectContaining({ id: 'release-invariants', status: 'FAIL' }))
  })

  it('semantically rejects packaged source maps even when the test-owned hash oracle is unchanged', async () => {
    const builderPath = path.join(workspaceRoot, 'electron-builder.yml')
    const original = await fs.readFile(builderPath, 'utf8')
    const changed = new TextEncoder().encode(original.replace("  - '!dist/**/*.map'", '  - dist/**/*.map'))
    expect(new TextDecoder().decode(changed)).not.toBe(original)
    const state = newState({
      invariantReadOverrides: { 'electron-builder.yml': { bytes: changed, afterReads: 0 } },
      invariantHashOverrides: { 'electron-builder.yml': FIXED_WORKSPACE_HASHES['electron-builder-config'] },
    })
    const core = await extractedCore(makeDeps(state))
    const { dependencyBootstrap } = await bootstrapped(core)
    await core.runPreflight({ context: expectedContext(), dependencyBootstrap })
    expect(publishedReport(state).checks.at(-1)).toEqual(expect.objectContaining({ id: 'release-invariants', status: 'FAIL' }))
    expect(state.calls).not.toContain('command:electron-builder-win')
  })

  it('rejects an extra field on the no-publish builder descriptor despite an unchanged test-owned hash oracle', async () => {
    const relativePath = 'scripts/release/lib/trusted-windows-runner.mjs'
    const original = await fs.readFile(path.join(workspaceRoot, ...relativePath.split('/')), 'utf8')
    const needle = '{"id":"electron-builder-win","executableClass":"node-workspace","argv":["node_modules/electron-builder/cli.js","--win","--publish","never"],"cwdClass"'
    expect(original).toContain(needle)
    const changed = new TextEncoder().encode(original.replace(needle, needle.replace('],"cwdClass"', '],"unsafe":true,"cwdClass"')))
    const state = newState({
      invariantReadOverrides: { [relativePath]: { bytes: changed, afterReads: 0 } },
      invariantHashOverrides: { [relativePath]: FIXED_WORKSPACE_HASHES['trusted-windows-runner'] },
    })
    const core = await extractedCore(makeDeps(state))
    const { dependencyBootstrap } = await bootstrapped(core)
    await core.runPreflight({ context: expectedContext(), dependencyBootstrap })
    expect(publishedReport(state).checks.at(-1)).toEqual(expect.objectContaining({ id: 'release-invariants', status: 'FAIL' }))
  })

  it('fails release-invariants when the policy modules ABI drifts from the completed Node probe', async () => {
    const state = newState({ failAt: 'invariant-toolchain-parity' })
    const core = await extractedCore(makeDeps(state))
    const { dependencyBootstrap } = await bootstrapped(core)
    await core.runPreflight({ context: expectedContext(), dependencyBootstrap })
    expect(publishedReport(state).checks.at(-1)).toEqual(expect.objectContaining({ id: 'release-invariants', status: 'FAIL' }))
    expect(state.calls.filter((call) => call === 'command:test-full')).toHaveLength(1)
  })

  it.each([
    ['runtime', { runtime: 'electron-run-as-node' }],
    ['nodeVersion', { nodeVersion: 'v24.14.0' }],
    ['electronVersion', { electronVersion: '35.7.5' }],
    ['modulesAbi', { modulesAbi: '133' }],
    ['napi', { napi: '9' }],
    ['platform', { platform: 'linux' }],
    ['arch', { arch: 'arm64' }],
    ['sqliteVersion', { sqliteVersion: '3.53.3' }],
  ])('fails the node ABI row on independent %s drift', async (_label, patch) => {
    const state = newState({ commandFailures: { 'node-abi-probe': { status: 'PASS', category: null, exitCode: 0, result: { ...nodeProbe(), ...patch } } } })
    const core = await extractedCore(makeDeps(state))
    const { dependencyBootstrap } = await bootstrapped(core)
    await core.runPreflight({ context: expectedContext(), dependencyBootstrap })
    const report = publishedReport(state)
    expect(report.checks.at(-1)).toMatchObject({ id: 'node-native-abi', status: 'FAIL' })
    expect(state.calls).not.toContain('command:electron-abi-probe')
  })

  it('consumes a token before any lifecycle await and remains terminal after publication ambiguity', async () => {
    const state = newState({ failAt: 'report-rename-ambiguity' })
    const core = await extractedCore(makeDeps(state))
    const { dependencyBootstrap } = await bootstrapped(core)
    const pending = core.runPreflight({ context: expectedContext(), dependencyBootstrap })
    await expect(core.runPreflight({ context: expectedContext(), dependencyBootstrap })).rejects.toThrow()
    await expect(pending).rejects.toThrow()
    expect(state.capabilityCalls.some((call) => call.startsWith('rename:') && call.endsWith(`${path.sep}release-validation${path.sep}reports${path.sep}preflight.json`))).toBe(true)
    expect(state.calls).not.toContain('publish-report')
    await expect(core.runPreflight({ context: expectedContext(), dependencyBootstrap })).rejects.toThrow()
  })

  it('rejects concurrent CONSUMED reuse without closing the first preflight lease', async () => {
    let markEntered!: () => void
    let releaseLifecycle!: (value: unknown) => void
    const entered = new Promise<void>((resolve) => { markEntered = resolve })
    const lifecycleResult = new Promise<unknown>((resolve) => { releaseLifecycle = resolve })
    const state = newState()
    Object.defineProperty(state.commandFailures, 'lifecycle-electron-install', {
      enumerable: true,
      configurable: true,
      get: () => {
        markEntered()
        return lifecycleResult
      },
    })
    const core = await extractedCore(makeDeps(state))
    const { dependencyBootstrap } = await bootstrapped(core)
    const first = core.runPreflight({ context: expectedContext(), dependencyBootstrap })
    await entered
    const effectsAtBarrier = [...state.capabilityCalls]

    await expect(core.runPreflight({ context: expectedContext(), dependencyBootstrap })).rejects.toThrow()
    expect(state.capabilityCalls).toEqual(effectsAtBarrier)

    releaseLifecycle({ status: 'FAIL', category: 'child-nonzero', exitCode: 7 })
    await expect(first).resolves.toMatchObject({ status: 'FAIL' })
    expect(state.calls.filter((call) => call === 'command:lifecycle-electron-install')).toHaveLength(1)
    const effectsAfterOwnerClose = [...state.capabilityCalls]
    const writesAfterOwnerClose = [...state.writes]
    await expect(core.runPreflight({ context: expectedContext(), dependencyBootstrap })).rejects.toThrow()
    expect(state.capabilityCalls).toEqual(effectsAfterOwnerClose)
    expect(state.writes).toEqual(writesAfterOwnerClose)
  })

  it('memoizes a retained lease close failure and never retries its low-level handles', async () => {
    const state = newState()
    const core = await extractedCore(makeDeps(state))
    const { dependencyBootstrap } = await bootstrapped(core)
    const stagingClose = `close:${path.join(workspaceRoot, 'release-validation', 'staging')}`
    const closesBeforeFailure = state.capabilityCalls.filter((call) => call === stagingClose).length
    state.directoryCloseFailure = 'release-validation/staging'
    state.commandFailures['lifecycle-electron-install'] = { status: 'FAIL', category: 'child-nonzero', exitCode: 7 }
    await expect(core.runPreflight({ context: expectedContext(), dependencyBootstrap })).rejects.toThrow(/fixture close failure/iu)
    const effectsAfterFailure = [...state.capabilityCalls]
    await expect(core.runPreflight({ context: expectedContext(), dependencyBootstrap })).rejects.toThrow(/fixture close failure/iu)
    expect(state.capabilityCalls).toEqual(effectsAfterFailure)
    expect(state.capabilityCalls.filter((call) => call === stagingClose)).toHaveLength(closesBeforeFailure + 1)
  })

  it('cannot roll a poisoned metadata-preparing token back to metadata-prepared after concurrent preflight', async () => {
    let releaseMetadata!: () => void
    const metadataBarrier = new Promise<void>((resolve) => { releaseMetadata = resolve })
    const state = newState({ metadataBarrier })
    const core = await extractedCore(makeDeps(state))
    const facts = await core.runEarlyGitPackageGate({ workspaceRoot })
    const dependencyBootstrap = await core.prepareDependencyBootstrap({ workspaceRoot, releaseFacts: facts })
    const preparing = core.prepareReleaseMetadata({ workspaceRoot, releaseFacts: facts, dependencyBootstrap })
    await expect(core.runPreflight({ context: expectedContext(), dependencyBootstrap })).rejects.toThrow()
    const effectsAfterPoison = [...state.capabilityCalls]
    releaseMetadata()
    await expect(preparing).rejects.toThrow(/phase/iu)
    expect(state.writes).not.toContain('metadata')
    await expect(core.prepareReleaseMetadata({ workspaceRoot, releaseFacts: facts, dependencyBootstrap })).rejects.toThrow()
    expect(state.capabilityCalls).toEqual(effectsAfterPoison)
  })
})

describe('bindings and frozen consumers', () => {
  it('Task2C2 lock gate rejects unrelated complete-lock drift after reaching the owned held post-install read', async () => {
    const state = newState()
    const core = await extractedCore(makeDeps(state))
    const { context } = await ownedBindingContextAfterEarlyChildFailure(core, state)
    const lock = JSON.parse(await fs.readFile(path.join(workspaceRoot, 'package-lock.json'), 'utf8'))
    lock.task2c2UnreviewedTopLevel = 'drift'
    const writesBefore = [...state.writes]
    state.openReadOverrides = {
      'package-lock.json': { bytes: new TextEncoder().encode(JSON.stringify(lock)), afterReads: 0 },
    }

    await expect(core.loadPostInstallBindings({ workspaceRoot, context })).rejects.toThrow(/lock binding drifted/iu)
    expect(state.capabilityCalls).toContain(`open:r:${path.join(workspaceRoot, 'package-lock.json')}`)
    expect(state.readCounts?.['package-lock.json']).toBeGreaterThan(0)
    expect(state.writes).toEqual(writesBefore)
  })

  it('rejects a nested duplicate package-lock key inside an owned post-install lease', async () => {
    const state = newState()
    const core = await extractedCore(makeDeps(state))
    const { context } = await ownedBindingContextAfterEarlyChildFailure(core, state)
    const original = await fs.readFile(path.join(workspaceRoot, 'package-lock.json'), 'utf8')
    const needle = '"version": "1.0.1-rc.1"'
    const first = original.indexOf(needle)
    const second = original.indexOf(needle, first + needle.length)
    expect(second).toBeGreaterThan(first)
    const duplicate = `${original.slice(0, second + needle.length)},\n      ${needle}${original.slice(second + needle.length)}`
    const writesBefore = [...state.writes]
    state.openReadOverrides = { 'package-lock.json': { bytes: new TextEncoder().encode(duplicate), afterReads: 0 } }
    await expect(core.loadPostInstallBindings({ workspaceRoot, context })).rejects.toThrow(/package-lock\.json is invalid|lock binding drifted/iu)
    expect(state.writes).toEqual(writesBefore)
  })

  it('returns the exact frozen ordered PostInstallBindings projection read-only', async () => {
    const state = newState()
    const core = await extractedCore(makeDeps(state))
    const { context } = await ownedBindingContextAfterEarlyChildFailure(core, state)
    const writesBefore = [...state.writes]
    const bindings = await core.loadPostInstallBindings({ workspaceRoot, context })
    expect(bindings).toEqual(await expectedBindingsForState(state))
    expect(Object.isFrozen(bindings)).toBe(true)
    expect(Object.isFrozen(bindings.packages)).toBe(true)
    expect(Object.isFrozen(bindings.packageEntries)).toBe(true)
    expect(Object.isFrozen(bindings.workspaceEntries)).toBe(true)
    expect(JSON.stringify(bindings)).not.toMatch(/"(?:handle|descriptor|lease)"\s*:/iu)
    expect(state.writes).toEqual(writesBefore)
    expect(state.capabilityCalls.some((call) => call === `readdir:${path.join(workspaceRoot, 'node_modules')}`)).toBe(true)
  })

  it.each(WORKSPACE_ENTRY_ROWS)('rejects post-gate workspace entry %s byte drift through the owned low-level lease', async (_id, relativePath) => {
    const state = newState()
    const core = await extractedCore(makeDeps(state))
    const { context } = await ownedBindingContextAfterEarlyChildFailure(core, state)
    const writesBefore = [...state.writes]
    const changed = new Uint8Array(await fs.readFile(path.join(workspaceRoot, ...relativePath.split('/'))))
    changed[0] ^= 1
    state.openReadOverrides = { [relativePath]: { bytes: changed, afterReads: 0 } }

    let failure: unknown = null
    try {
      await core.loadPostInstallBindings({ workspaceRoot, context })
    } catch (error) {
      failure = error
    }

    expect(failure).not.toBeNull()
    expect(String((failure as Error).message)).toMatch(/workspace entry drifted/iu)
    expect(state.capabilityCalls).toContain(`open:r:${path.join(workspaceRoot, ...relativePath.split('/'))}`)
    expect(state.writes).toEqual(writesBefore)
  })

  it.each(PACKAGE_ROWS)('rejects lock integrity drift for package %s after reaching the owned low-level lease', async (_name, _version, _integrity, rootRelativePath) => {
    const state = newState()
    const core = await extractedCore(makeDeps(state))
    const { context } = await ownedBindingContextAfterEarlyChildFailure(core, state)
    const writesBefore = [...state.writes]
    const lock = JSON.parse(await fs.readFile(path.join(workspaceRoot, 'package-lock.json'), 'utf8'))
    lock.packages[rootRelativePath].integrity = `sha512-drift-${rootRelativePath}`
    state.openReadOverrides = {
      'package-lock.json': { bytes: new TextEncoder().encode(JSON.stringify(lock)), afterReads: 0 },
    }
    await expect(core.loadPostInstallBindings({ workspaceRoot, context })).rejects.toThrow(/lock binding drifted/iu)
    expect(state.capabilityCalls).toContain(`open:r:${path.join(workspaceRoot, 'package-lock.json')}`)
    expect(state.writes).toEqual(writesBefore)
  })

  it.each(PACKAGE_ROWS)('rejects package identity drift for %s after the final-tree observation', async (name, version, _integrity, rootRelativePath) => {
    const state = newState()
    const core = await extractedCore(makeDeps(state))
    const { context } = await ownedBindingContextAfterEarlyChildFailure(core, state)
    const writesBefore = [...state.writes]
    const relativePath = `${rootRelativePath}/package.json`
    const alteredName = `${name.slice(0, -1)}${name.at(-1) === 'x' ? 'y' : 'x'}`
    state.openReadOverrides = {
      [relativePath]: { bytes: new TextEncoder().encode(JSON.stringify({ name: alteredName, version })), afterReads: 1 },
    }
    await expect(core.loadPostInstallBindings({ workspaceRoot, context })).rejects.toThrow(/package identity drifted/iu)
    expect(state.readCounts?.[relativePath]).toBeGreaterThan(1)
    expect(state.writes).toEqual(writesBefore)
  })

  it.each(PACKAGE_ROWS)('rejects independently observed package tree drift for %s', async (_name, _version, _integrity, rootRelativePath) => {
    const state = newState()
    const core = await extractedCore(makeDeps(state))
    const { context } = await ownedBindingContextAfterEarlyChildFailure(core, state)
    const writesBefore = [...state.writes]
    state.packageTreeDriftRoot = rootRelativePath
    await expect(core.loadPostInstallBindings({ workspaceRoot, context })).rejects.toThrow(/package tree drifted/iu)
    expect(state.capabilityCalls).toContain(`readdir:${path.join(workspaceRoot, ...rootRelativePath.split('/'))}`)
    expect(state.writes).toEqual(writesBefore)
  })

  it.each(PACKAGE_ENTRY_ROWS)('rejects explicit package entry %s byte drift after whole-tree observations', async (id, _packageName, relativePath) => {
    const state = newState()
    const core = await extractedCore(makeDeps(state))
    const { context } = await ownedBindingContextAfterEarlyChildFailure(core, state)
    const writesBefore = [...state.writes]
    const original = state.virtualFiles!.get(relativePath)!
    const changed = new Uint8Array(original)
    changed[0] ^= 1
    state.openReadOverrides = { [relativePath]: { bytes: changed, afterReads: 2 } }
    await expect(core.loadPostInstallBindings({ workspaceRoot, context })).rejects.toThrow(/package entry drifted/iu)
    expect(state.readCounts?.[relativePath]).toBeGreaterThan(2)
    expect(id.length).toBeGreaterThan(0)
    expect(state.writes).toEqual(writesBefore)
  })

  it('rejects a same-path file identity replacement inside an owned binding lease', async () => {
    const state = newState()
    const core = await extractedCore(makeDeps(state))
    const { context } = await ownedBindingContextAfterEarlyChildFailure(core, state)
    const writesBefore = [...state.writes]
    state.openIdentityOverrides = { 'package-lock.json': 'replacement-inode' }
    await expect(core.loadPostInstallBindings({ workspaceRoot, context })).rejects.toThrow(/binding changed/iu)
    expect(state.capabilityCalls).toContain(`open:r:${path.join(workspaceRoot, 'package-lock.json')}`)
    expect(state.writes).toEqual(writesBefore)
  })

  it('loads frozen context without ambient time, metadata refresh, quarantine, lifecycle, or writes', async () => {
    const state = newState()
    const core = await extractedCore(makeDeps(state))
    await completedPreflight(core, state)
    const writesBefore = [...state.writes]
    const callsBefore = state.calls.length
    const clockReadsBefore = state.clockReads
    const environmentReadsBefore = state.environmentReads
    const result = await core.loadFrozenPreflightContext({ workspaceRoot })
    expect(result.context).toBe(state.createdContext)
    expect(result.preflightReference).toEqual(expect.objectContaining({ reportPath: 'release-validation/reports/preflight.json', itemId: 'ARTIFACT-PREFLIGHT' }))
    const frozenCalls = state.calls.slice(callsBefore)
    expect(frozenCalls).toContain('create-context')
    expect(frozenCalls).not.toContain('command:npm-ci-ignore-scripts')
    expect(frozenCalls.some((call) => call.startsWith('command:lifecycle-'))).toBe(false)
    expect(state.writes).toEqual(writesBefore)
    expect([state.clockReads, state.environmentReads]).toEqual([clockReadsBefore, environmentReadsBefore])
  })

  it('loads a bound report only for the fixed item, path, exact hash, context, and fresh binding lease', async () => {
    const state = newState()
    const deps = makeDeps(state)
    const core = await extractedCore(deps)
    const { context, report, preflightReference } = await completedPreflight(core, state)
    const loaded = await core.loadBoundPreflightReport({ workspaceRoot, context, preflightReference })
    expect(loaded).toEqual({ report, bindings: await expectedBindingsForState(state) })
    await expect(core.loadBoundPreflightReport({ workspaceRoot, context, preflightReference: exactReference('0'.repeat(64)) })).rejects.toThrow()
    await expect(core.loadBoundPreflightReport({ workspaceRoot, context, preflightReference: { ...preflightReference, itemId: 'FORGED' } })).rejects.toThrow()
  })

  it('serializes the independent canonical tree fixture with fixed key order and LF hash oracle', async () => {
    const core = await extractedCore()
    const rows = [
      { relativePath: 'b.txt', size: 2, fileSha256: 'b'.repeat(64) },
      { relativePath: 'A.txt', size: 1, fileSha256: 'a'.repeat(64) },
    ]
    const expectedBytes = `[{"relativePath":"A.txt","size":1,"fileSha256":"${'a'.repeat(64)}"},{"relativePath":"b.txt","size":2,"fileSha256":"${'b'.repeat(64)}"}]\n`
    const expectedSha256 = crypto.createHash('sha256').update(expectedBytes).digest('hex')
    expect(core.canonicalTreeFixture(rows)).toEqual({ bytes: expectedBytes, sha256: expectedSha256 })
    const runnerSource = await fs.readFile(runnerPath, 'utf8')
    expect(runnerSource.match(/WORKBENCH_RELEASE_CONTROLLER_V1_START/gu)).toHaveLength(1)
    expect(runnerSource).toContain('[ordered]@{ relativePath = $relative; size = $stream.Length; fileSha256 = Get-StreamSha256 $stream }')
  })
})

describe('native ABI probe executable behavior', () => {
  it('has no exports and import alone performs no protected-module import, database action, or output', async () => {
    await sourceOrFail(probePath)
    const root = await disposableRoot('workbench-preflight-probe-import-')
    const packageRoot = path.join(root, 'node_modules', 'better-sqlite3')
    await fs.mkdir(packageRoot, { recursive: true })
    await fs.copyFile(probePath, path.join(root, 'native-abi-probe.mjs'))
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ type: 'module', exports: { './win32-x64': './win32-x64.js' } }))
    const sentinel = path.join(root, 'import-sentinel')
    await fs.writeFile(path.join(packageRoot, 'win32-x64.js'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(sentinel)},'executed'); export default class {}`)
    const imported = await import(`${pathToFileURL(path.join(root, 'native-abi-probe.mjs')).href}?import=${crypto.randomUUID()}`)
    expect(Object.keys(imported)).toEqual([])
    await expect(fs.stat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('imports the Windows-x64 entry and performs one exact memory query with close in finally', async () => {
    const { result, trace } = await runProbeFixture()
    expect(result).toEqual({ code: 0, stdout: `${JSON.stringify(nodeProbe())}\n`, stderr: '' })
    expect(trace).toEqual([
      ['open', ':memory:'], ['prepare', 'select sqlite_version() as version'], ['get'], ['close'],
    ])
  })

  it('fails closed for caller arguments or caller run-as-node relabeling', async () => {
    await sourceOrFail(probePath)
    const extraArg = await runChild('C:\\Program Files\\nodejs\\node.exe', [probePath, '--mode=node'])
    expect(extraArg.code).not.toBe(0)
    expect(extraArg.stdout).toBe('')
    expect(extraArg.stderr).toBe('Native ABI probe failed.\n')
    const relabel = await runChild('C:\\Program Files\\nodejs\\node.exe', [probePath], { env: { LANG: 'C', LC_ALL: 'C', ELECTRON_RUN_AS_NODE: '1' } })
    expect(relabel.code).not.toBe(0)
    expect(relabel.stdout).toBe('')
  })

  it.each([
    ['constructor throw', { constructorThrows: true }, [['open', ':memory:']]],
    ['prepare throw', { prepareThrows: true }, [['open', ':memory:'], ['prepare', 'select sqlite_version() as version'], ['close']]],
    ['get throw', { getThrows: true }, [['open', ':memory:'], ['prepare', 'select sqlite_version() as version'], ['get'], ['close']]],
    ['missing row key', { rowExpression: '{}' }, [['open', ':memory:'], ['prepare', 'select sqlite_version() as version'], ['get'], ['close']]],
    ['extra row key', { rowExpression: "{version:'3.53.4',extra:true}" }, [['open', ':memory:'], ['prepare', 'select sqlite_version() as version'], ['get'], ['close']]],
    ['array row', { rowExpression: "['3.53.4']" }, [['open', ':memory:'], ['prepare', 'select sqlite_version() as version'], ['get'], ['close']]],
    ['wrong SQLite version', { rowExpression: "{version:'3.53.3'}" }, [['open', ':memory:'], ['prepare', 'select sqlite_version() as version'], ['get'], ['close']]],
    ['accessor row', { rowExpression: "Object.defineProperty({},'version',{enumerable:true,get(){mark(['getter']);return '3.53.4'}})" }, [['open', ':memory:'], ['prepare', 'select sqlite_version() as version'], ['get'], ['close']]],
    ['close throw', { closeThrows: true }, [['open', ':memory:'], ['prepare', 'select sqlite_version() as version'], ['get'], ['close']]],
  ])('emits only the fixed safe failure line and closes exactly once for %s', async (_label, behavior, expectedTrace) => {
    const { result, trace } = await runProbeFixture(behavior)
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Native ABI probe failed.\n')
    expect(trace).toEqual(expectedTrace)
  })

  it('executes the real fixed SQLite probe under both locked runtimes', async () => {
    await sourceOrFail(probePath)
    const node = await runChild('C:\\Program Files\\nodejs\\node.exe', [probePath])
    expect(node).toEqual({ code: 0, stdout: `${JSON.stringify(nodeProbe())}\n`, stderr: '' })
    const electron = await runChild(path.join(workspaceRoot, 'node_modules', 'electron', 'dist', 'electron.exe'), [probePath], {
      env: { LANG: 'C', LC_ALL: 'C', ELECTRON_RUN_AS_NODE: '1' },
    })
    expect(electron).toEqual({ code: 0, stdout: `${JSON.stringify(electronProbe())}\n`, stderr: '' })
  })
})

describe('diagnostic entrypoint contract', () => {
  it('adds only the exact zero-option release preflight package script', async () => {
    const packageJson = JSON.parse(await fs.readFile(packagePath, 'utf8'))
    expect(packageJson.scripts['release:preflight']).toBe('node scripts/release/preflight.mjs')
  })

  it('rejects direct CLI options before bootstrap or report bytes can be written', async () => {
    await sourceOrFail()
    const result = await runChild('C:\\Program Files\\nodejs\\node.exe', [preflightPath, '--freeze'])
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Release preflight failed.\n')
  })

  it('executes the exact production CLI tail with zero arguments and preserves orchestration identity', async () => {
    const fixture = await runExactCliTailFixture()
    expect(fixture.result).toEqual({ code: 0, stdout: 'Release preflight passed.\n', stderr: '' })
    expect(fixture.trace).toEqual([
      'early-gate',
      'dependency-bootstrap',
      'release-metadata',
      'release-context',
      'preflight',
    ])
    expect(fixture.workspaceExists).toBe(false)
    expect(fixture.releaseValidationExists).toBe(false)
    expect(fixture.snapshot.map((entry) => [entry.relativePath, entry.kind])).toEqual([
      ['cli-trace.json', 'file'],
      ['preflight-cli-tail.mjs', 'file'],
    ])
  })

  it('rejects an exact-tail CLI option before any fixture stage or workspace write', async () => {
    const fixture = await runExactCliTailFixture(['--freeze'])
    expect(fixture.result.code).not.toBe(0)
    expect(fixture.result.stdout).toBe('')
    expect(fixture.result.stderr).toBe('Release preflight failed.\n')
    expect(fixture.trace).toBeNull()
    expect(fixture.workspaceExists).toBe(false)
    expect(fixture.releaseValidationExists).toBe(false)
    expect(fixture.snapshot.map((entry) => [entry.relativePath, entry.kind])).toEqual([
      ['preflight-cli-tail.mjs', 'file'],
    ])
  })
})
