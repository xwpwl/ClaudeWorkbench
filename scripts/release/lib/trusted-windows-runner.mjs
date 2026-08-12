import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const POLICY_PATH = path.join(WORKSPACE_ROOT, 'scripts', 'release', 'release-toolchain.json')
const REVIEWED_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const POLICY_KEYS = [
  'architecture',
  'dependencyBootstrap',
  'git',
  'nativeAbi',
  'node',
  'npm',
  'ownerReviewRequired',
  'platform',
  'schemaVersion',
  'windowsController',
]
const SHA256 = /^[a-f0-9]{64}$/u
const COMMIT_SHA = /^[a-f0-9]{40}$/u
const CONTROLLER_STDERR_LIMIT = 32 * 1024
const CONTROLLER_CLEANUP_GRACE_MS = 15_000
const CONTROLLER_ENVELOPE_LIMIT = 256 * 1024
const WINDOWS_COMMAND_LINE_LIMIT = 32_767
const REVIEWED_LIFECYCLE_PAYLOADS = [
  {
    id: 'electron-install',
    packageName: 'electron',
    packageVersion: '35.7.5',
    workingDirectoryRelativePath: 'electron',
    entryRelativePath: 'electron/install.js',
    entrySha256: '3fa1166ed4db6831ed0d1aeec05295e460127d92b1216c794719e817eaefe0fb',
    arguments: [],
  },
  {
    id: 'esbuild-install',
    packageName: 'esbuild',
    packageVersion: '0.28.1',
    workingDirectoryRelativePath: 'esbuild',
    entryRelativePath: 'esbuild/install.js',
    entrySha256: '612294e278914443bdcf81cb17f54afec34dbdd2ebd999a6ee187912320cc315',
    arguments: [],
  },
  {
    id: 'electron-winstaller-select-7z',
    packageName: 'electron-winstaller',
    packageVersion: '5.4.0',
    workingDirectoryRelativePath: 'electron-winstaller',
    entryRelativePath: 'electron-winstaller/script/select-7z-arch.js',
    entrySha256: '3819ea164df4ab1d23a6e3f8a551f2029974aead10422f929d2ad169ef3049f4',
    arguments: [],
  },
]

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const member of Object.values(value)) deepFreeze(member)
    Object.freeze(value)
  }
  return value
}

function exactObject(value, keys) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function relativeWindowsPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 260
    && !path.win32.isAbsolute(value)
    && value.split(/[\\/]/u).every((component) => component !== '' && component !== '.' && component !== '..')
}

function validTreeFact(value) {
  return exactObject(value, ['fileCount', 'totalBytes', 'treeSha256'])
    && positiveInteger(value.fileCount)
    && positiveInteger(value.totalBytes)
    && SHA256.test(value.treeSha256)
}

function rejectDuplicateJsonKeys(text) {
  let offset = 0
  const skipWhitespace = () => {
    while (/\s/u.test(text[offset] ?? '')) offset += 1
  }
  const readString = () => {
    const start = offset
    offset += 1
    while (offset < text.length) {
      if (text[offset] === '\\') offset += 2
      else if (text[offset++] === '"') return JSON.parse(text.slice(start, offset))
    }
    throw new Error('invalid JSON')
  }
  const readValue = () => {
    skipWhitespace()
    if (text[offset] === '"') {
      readString()
      return
    }
    if (text[offset] === '{') {
      offset += 1
      skipWhitespace()
      const keys = new Set()
      if (text[offset] === '}') {
        offset += 1
        return
      }
      for (;;) {
        skipWhitespace()
        if (text[offset] !== '"') throw new Error('invalid JSON')
        const key = readString()
        if (keys.has(key)) throw new Error('duplicate JSON key')
        keys.add(key)
        skipWhitespace()
        if (text[offset++] !== ':') throw new Error('invalid JSON')
        readValue()
        skipWhitespace()
        const delimiter = text[offset++]
        if (delimiter === '}') return
        if (delimiter !== ',') throw new Error('invalid JSON')
      }
    }
    if (text[offset] === '[') {
      offset += 1
      skipWhitespace()
      if (text[offset] === ']') {
        offset += 1
        return
      }
      for (;;) {
        readValue()
        skipWhitespace()
        const delimiter = text[offset++]
        if (delimiter === ']') return
        if (delimiter !== ',') throw new Error('invalid JSON')
      }
    }
    const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(text.slice(offset))
    if (!primitive) throw new Error('invalid JSON')
    offset += primitive[0].length
  }
  readValue()
  skipWhitespace()
  if (offset !== text.length) throw new Error('invalid JSON')
}

function validatePolicy(policy) {
  const lifecycleIds = ['electron-install', 'esbuild-install', 'electron-winstaller-select-7z']
  const valid = exactObject(policy, POLICY_KEYS)
    && policy.schemaVersion === 1
    && policy.platform === 'win32'
    && policy.architecture === 'x64'
    && policy.ownerReviewRequired === true
    && exactObject(policy.node, ['programFilesRelativePath', 'sha256', 'version'])
    && policy.node.programFilesRelativePath === 'nodejs\\node.exe'
    && policy.node.version === 'v24.15.0'
    && policy.node.sha256 === '3331e1ffe19874215472217c5e94f5a0c6d8e18c4ac7111d3937aa0ad5e9b4a5'
    && exactObject(policy.nativeAbi, ['electron', 'hostNode', 'sqlite'])
    && JSON.stringify(Object.keys(policy.nativeAbi)) === JSON.stringify(['hostNode', 'electron', 'sqlite'])
    && exactObject(policy.nativeAbi.hostNode, ['arch', 'modulesAbi', 'napi', 'nodeVersion', 'platform'])
    && JSON.stringify(policy.nativeAbi.hostNode) === JSON.stringify({ nodeVersion: 'v24.15.0', modulesAbi: '137', napi: '10', platform: 'win32', arch: 'x64' })
    && exactObject(policy.nativeAbi.electron, ['arch', 'electronVersion', 'modulesAbi', 'napi', 'nodeVersion', 'platform'])
    && JSON.stringify(policy.nativeAbi.electron) === JSON.stringify({ electronVersion: '35.7.5', nodeVersion: 'v22.16.0', modulesAbi: '133', napi: '10', platform: 'win32', arch: 'x64' })
    && exactObject(policy.nativeAbi.sqlite, ['loaderRelativePath', 'nativeRelativePath', 'nativeSha256', 'packageName', 'packageVersion', 'sqliteVersion'])
    && JSON.stringify(policy.nativeAbi.sqlite) === JSON.stringify({ packageName: 'better-sqlite3', packageVersion: '13.0.2', loaderRelativePath: 'node_modules/better-sqlite3/lib/win32-x64.js', nativeRelativePath: 'node_modules/better-sqlite3/prebuilds/win32-x64.node', nativeSha256: 'ecfb86221a674a6cdba63b1ac162b99386a61d0e38934b6c3dfcd9da11b6ee26', sqliteVersion: '3.53.4' })
    && exactObject(policy.npm, ['fileCount', 'programFilesRelativeRoot', 'totalBytes', 'treeSha256', 'version'])
    && policy.npm.programFilesRelativeRoot === 'nodejs\\node_modules\\npm'
    && policy.npm.version === '11.12.1'
    && policy.npm.fileCount === 1740
    && policy.npm.totalBytes === 10_520_303
    && policy.npm.treeSha256 === 'a2b5872e8b827228d641001876d85ecd661ef9786f0a997923b27d3aa0a1b302'
    && exactObject(policy.git, ['criticalRelativePaths', 'fileCount', 'programFilesRelativeRoot', 'totalBytes', 'treeSha256', 'version'])
    && policy.git.programFilesRelativeRoot === 'Git'
    && policy.git.version === '2.44.0.windows.1'
    && JSON.stringify(policy.git.criticalRelativePaths) === JSON.stringify(['cmd/git.exe', 'mingw64/bin', 'mingw64/libexec/git-core'])
    && policy.git.fileCount === 292
    && policy.git.totalBytes === 187_055_518
    && policy.git.treeSha256 === '249a931b5352181774f454e5c96e72fe4d39bdbf530b5713fe2cd8ef16d42ef5'
    && exactObject(policy.windowsController, ['allowBreakaway', 'cmdSha256', 'cmdSystem32RelativePath', 'killOnJobClose', 'powershellSha256', 'powershellSystem32RelativePath'])
    && policy.windowsController.powershellSystem32RelativePath === 'WindowsPowerShell\\v1.0\\powershell.exe'
    && policy.windowsController.powershellSha256 === '7600ffe12da441fe89d035b13801e8e91d064bc544a27b19a5cf49f6ab8b18f5'
    && policy.windowsController.cmdSystem32RelativePath === 'cmd.exe'
    && policy.windowsController.cmdSha256 === '65ec268add3973b6dca64222985da47caeaee44a340b0ec1466782914fd743d9'
    && policy.windowsController.killOnJobClose === true
    && policy.windowsController.allowBreakaway === false
    && exactObject(policy.dependencyBootstrap, ['electronExecutableSha256', 'finalTree', 'installArguments', 'lifecyclePayloads', 'preLifecycleTree'])
    && JSON.stringify(policy.dependencyBootstrap.installArguments) === JSON.stringify(['ci', '--ignore-scripts', '--no-audit', '--no-fund'])
    && policy.dependencyBootstrap.preLifecycleTree.fileCount === 26_863
    && policy.dependencyBootstrap.preLifecycleTree.totalBytes === 673_636_131
    && policy.dependencyBootstrap.preLifecycleTree.treeSha256 === '075e9bc083e4e2010b46f97b31c5a07c8b4ee5dbbd825e572f2252c578f6e939'
    && policy.dependencyBootstrap.finalTree.fileCount === 26_939
    && policy.dependencyBootstrap.finalTree.totalBytes === 973_620_188
    && policy.dependencyBootstrap.finalTree.treeSha256 === '7cfa28860bfdce9c3ddc289b1aefcb84989eb84cb88585ac95021110a0349a39'
    && policy.dependencyBootstrap.electronExecutableSha256 === '588bd82e36ad1acdae4615b6336284e420704389864f54ef2d10ea66c1a3cde0'
    && validTreeFact(policy.dependencyBootstrap.preLifecycleTree)
    && validTreeFact(policy.dependencyBootstrap.finalTree)
    && Array.isArray(policy.dependencyBootstrap.lifecyclePayloads)
    && policy.dependencyBootstrap.lifecyclePayloads.length === 3
    && JSON.stringify(policy.dependencyBootstrap.lifecyclePayloads) === JSON.stringify(REVIEWED_LIFECYCLE_PAYLOADS)
    && policy.dependencyBootstrap.lifecyclePayloads.every((payload, index) => exactObject(payload, [
      'arguments',
      'entryRelativePath',
      'entrySha256',
      'id',
      'packageName',
      'packageVersion',
      'workingDirectoryRelativePath',
    ])
      && payload.id === lifecycleIds[index]
      && relativeWindowsPath(payload.entryRelativePath)
      && relativeWindowsPath(payload.workingDirectoryRelativePath)
      && SHA256.test(payload.entrySha256)
      && Array.isArray(payload.arguments)
      && payload.arguments.every((argument) => typeof argument === 'string'))
  if (!valid) throw new Error('Release toolchain policy is invalid.')
  return deepFreeze(policy)
}

async function readPolicyFromHandle() {
  const handle = await fs.open(POLICY_PATH, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const bytes = await handle.readFile()
    if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw new Error('BOM')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    rejectDuplicateJsonKeys(text)
    return { policy: validatePolicy(JSON.parse(text)), bytes, handle }
  } catch (error) {
    await handle.close()
    throw error
  }
}

export async function loadReleaseToolchainPolicy() {
  if (arguments.length !== 0) throw new Error('Release toolchain policy request is invalid.')
  try {
    const loaded = await readPolicyFromHandle()
    await loaded.handle.close()
    return loaded.policy
  } catch (error) {
    if (error instanceof Error && error.message === 'Release toolchain policy request is invalid.') throw error
    throw new Error('Release toolchain policy is invalid.')
  }
}

const DESCRIPTOR_ROW_KEYS = [
  'argv',
  'closureClass',
  'cwdClass',
  'environment',
  'executableClass',
  'id',
  'parser',
  'stderrLimit',
  'stdoutLimit',
  'timeoutMs',
]
const REVIEWED_DESCRIPTOR_IDS = [
  'node-version',
  'npm-version',
  'git-version',
  'git-config-audit',
  'git-index-audit',
  'git-replace-audit',
  'git-head',
  'git-symbolic-head',
  'git-status',
  'git-untracked-audit',
  'git-worktree-list',
  'git-source-epoch',
  'git-package-blob-hash',
  'git-diff-quiet',
  'git-main-config-audit',
  'git-main-index-audit',
  'git-main-head',
  'git-main-status',
  'git-main-untracked-audit',
  'npm-ci-ignore-scripts',
  'lifecycle-electron-install',
  'lifecycle-esbuild-install',
  'lifecycle-electron-winstaller',
  'typecheck',
  'typecheck-ipc',
  'lint',
  'test-full',
  'build-main',
  'build-preload',
  'build-renderer',
  'icon-verify',
  'node-abi-probe',
  'electron-abi-probe',
  'electron-builder-win',
]
const DESCRIPTOR_EXECUTABLE_CLASSES = new Set([
  'electron-workspace', 'git', 'git-private-main', 'node', 'node-lifecycle', 'node-workspace', 'npm',
])
const DESCRIPTOR_CLOSURE_CLASSES = new Set([
  'electron-final', 'electron-lifecycle', 'electron-winstaller-lifecycle', 'esbuild-lifecycle',
  'git', 'node', 'npm', 'workspace-final',
])
const DESCRIPTOR_PARSERS = new Set([
  'branch-ref', 'clean-status', 'commit-sha', 'git-config-audit', 'git-index-audit', 'git-version',
  'native-abi-json', 'node-version', 'npm-version', 'quiet-exit', 'sha256-bytes', 'source-epoch',
  'vitest-preflight-json', 'worktree-facts', 'zero-exit',
])
const SAFE_DESCRIPTOR_TEXT = /^[^\u0000-\u001f\u007f\p{Cf}]{1,4096}$/u

function validateDescriptorRows(text, expectedSha256) {
  try {
    if (typeof text !== 'string' || sha256Bytes(Buffer.from(text, 'utf8')) !== expectedSha256) throw new Error('descriptor')
    rejectDuplicateJsonKeys(text)
    const rows = JSON.parse(text)
    if (!Array.isArray(rows) || rows.length !== REVIEWED_DESCRIPTOR_IDS.length) throw new Error('descriptor')
    const ids = new Set()
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      if (!exactObject(row, DESCRIPTOR_ROW_KEYS)
          || row.id !== REVIEWED_DESCRIPTOR_IDS[index]
          || !/^[a-z][a-z0-9-]{0,79}$/u.test(row.id)
          || ids.has(row.id.toLowerCase())
          || !DESCRIPTOR_EXECUTABLE_CLASSES.has(row.executableClass)
          || !DESCRIPTOR_CLOSURE_CLASSES.has(row.closureClass)
          || !DESCRIPTOR_PARSERS.has(row.parser)
          || !Array.isArray(row.argv)
          || row.argv.length > 64
          || !row.argv.every((argument) => typeof argument === 'string' && SAFE_DESCRIPTOR_TEXT.test(argument))
          || !exactObject(row.environment, Object.keys(row.environment))
          || Object.keys(row.environment).length > 32
          || !Object.entries(row.environment).every(([name, value]) => /^[A-Z@][A-Z0-9_@]{0,63}$/u.test(name)
            && typeof value === 'string' && SAFE_DESCRIPTOR_TEXT.test(value))
          || !positiveInteger(row.timeoutMs) || row.timeoutMs > 900_000
          || !positiveInteger(row.stdoutLimit) || row.stdoutLimit > 4_194_304
          || !positiveInteger(row.stderrLimit) || row.stderrLimit > 1_048_576) throw new Error('descriptor')
      ids.add(row.id.toLowerCase())
      const packageCwd = typeof row.cwdClass === 'string' && row.cwdClass.startsWith('package:')
      if (row.cwdClass === 'candidate') {
        if (row.executableClass === 'git-private-main' || row.executableClass === 'node-lifecycle') throw new Error('descriptor')
      } else if (row.cwdClass === 'private-main') {
        if (row.executableClass !== 'git-private-main' || row.closureClass !== 'git') throw new Error('descriptor')
      } else if (!packageCwd || row.executableClass !== 'node-lifecycle') throw new Error('descriptor')
    }
    return deepFreeze(rows)
  } catch {
    throw new Error('Trusted command descriptor matrix is invalid.')
  }
}

/* WORKBENCH_RELEASE_DESCRIPTORS_V1_START */
const DESCRIPTOR_ROWS_JSON = String.raw`[
  {"id":"node-version","executableClass":"node","argv":["--version"],"cwdClass":"candidate","environment":{},"timeoutMs":30000,"stdoutLimit":65536,"stderrLimit":16384,"closureClass":"node","parser":"node-version"},
  {"id":"npm-version","executableClass":"npm","argv":["--version"],"cwdClass":"candidate","environment":{},"timeoutMs":30000,"stdoutLimit":65536,"stderrLimit":16384,"closureClass":"npm","parser":"npm-version"},
  {"id":"git-version","executableClass":"git","argv":["--no-pager","--no-optional-locks","--version"],"cwdClass":"candidate","environment":{"GIT_OPTIONAL_LOCKS":"0","GIT_NO_REPLACE_OBJECTS":"1","GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_SYSTEM":"NUL","GIT_CONFIG_GLOBAL":"NUL","GIT_TERMINAL_PROMPT":"0","GIT_CONFIG_COUNT":"7","GIT_CONFIG_KEY_0":"core.fsmonitor","GIT_CONFIG_VALUE_0":"false","GIT_CONFIG_KEY_1":"core.untrackedCache","GIT_CONFIG_VALUE_1":"false","GIT_CONFIG_KEY_2":"core.ignoreStat","GIT_CONFIG_VALUE_2":"false","GIT_CONFIG_KEY_3":"core.sparseCheckout","GIT_CONFIG_VALUE_3":"false","GIT_CONFIG_KEY_4":"core.sparseCheckoutCone","GIT_CONFIG_VALUE_4":"false","GIT_CONFIG_KEY_5":"extensions.worktreeConfig","GIT_CONFIG_VALUE_5":"false","GIT_CONFIG_KEY_6":"core.hooksPath","GIT_CONFIG_VALUE_6":"NUL"},"timeoutMs":30000,"stdoutLimit":65536,"stderrLimit":16384,"closureClass":"git","parser":"git-version"},
  {"id":"git-config-audit","executableClass":"git","argv":["--no-pager","--no-optional-locks","config","--local","--no-includes","-z","--list"],"cwdClass":"candidate","environment":{"GIT_OPTIONAL_LOCKS":"0","GIT_NO_REPLACE_OBJECTS":"1","GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_SYSTEM":"NUL","GIT_CONFIG_GLOBAL":"NUL","GIT_TERMINAL_PROMPT":"0","GIT_CONFIG_COUNT":"7","GIT_CONFIG_KEY_0":"core.fsmonitor","GIT_CONFIG_VALUE_0":"false","GIT_CONFIG_KEY_1":"core.untrackedCache","GIT_CONFIG_VALUE_1":"false","GIT_CONFIG_KEY_2":"core.ignoreStat","GIT_CONFIG_VALUE_2":"false","GIT_CONFIG_KEY_3":"core.sparseCheckout","GIT_CONFIG_VALUE_3":"false","GIT_CONFIG_KEY_4":"core.sparseCheckoutCone","GIT_CONFIG_VALUE_4":"false","GIT_CONFIG_KEY_5":"extensions.worktreeConfig","GIT_CONFIG_VALUE_5":"false","GIT_CONFIG_KEY_6":"core.hooksPath","GIT_CONFIG_VALUE_6":"NUL"},"timeoutMs":30000,"stdoutLimit":65536,"stderrLimit":16384,"closureClass":"git","parser":"git-config-audit"},
  {"id":"git-index-audit","executableClass":"git","argv":["--no-pager","--no-optional-locks","ls-files","--cached","--stage","--debug","--sparse","-z"],"cwdClass":"candidate","environment":{"GIT_OPTIONAL_LOCKS":"0","GIT_NO_REPLACE_OBJECTS":"1","GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_SYSTEM":"NUL","GIT_CONFIG_GLOBAL":"NUL","GIT_TERMINAL_PROMPT":"0","GIT_CONFIG_COUNT":"7","GIT_CONFIG_KEY_0":"core.fsmonitor","GIT_CONFIG_VALUE_0":"false","GIT_CONFIG_KEY_1":"core.untrackedCache","GIT_CONFIG_VALUE_1":"false","GIT_CONFIG_KEY_2":"core.ignoreStat","GIT_CONFIG_VALUE_2":"false","GIT_CONFIG_KEY_3":"core.sparseCheckout","GIT_CONFIG_VALUE_3":"false","GIT_CONFIG_KEY_4":"core.sparseCheckoutCone","GIT_CONFIG_VALUE_4":"false","GIT_CONFIG_KEY_5":"extensions.worktreeConfig","GIT_CONFIG_VALUE_5":"false","GIT_CONFIG_KEY_6":"core.hooksPath","GIT_CONFIG_VALUE_6":"NUL"},"timeoutMs":30000,"stdoutLimit":1048576,"stderrLimit":16384,"closureClass":"git","parser":"git-index-audit"},
  {"id":"git-replace-audit","executableClass":"git","argv":["--no-pager","--no-optional-locks","replace","-l"],"cwdClass":"candidate","environment":{"GIT_OPTIONAL_LOCKS":"0","GIT_NO_REPLACE_OBJECTS":"1","GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_SYSTEM":"NUL","GIT_CONFIG_GLOBAL":"NUL","GIT_TERMINAL_PROMPT":"0","GIT_CONFIG_COUNT":"7","GIT_CONFIG_KEY_0":"core.fsmonitor","GIT_CONFIG_VALUE_0":"false","GIT_CONFIG_KEY_1":"core.untrackedCache","GIT_CONFIG_VALUE_1":"false","GIT_CONFIG_KEY_2":"core.ignoreStat","GIT_CONFIG_VALUE_2":"false","GIT_CONFIG_KEY_3":"core.sparseCheckout","GIT_CONFIG_VALUE_3":"false","GIT_CONFIG_KEY_4":"core.sparseCheckoutCone","GIT_CONFIG_VALUE_4":"false","GIT_CONFIG_KEY_5":"extensions.worktreeConfig","GIT_CONFIG_VALUE_5":"false","GIT_CONFIG_KEY_6":"core.hooksPath","GIT_CONFIG_VALUE_6":"NUL"},"timeoutMs":30000,"stdoutLimit":65536,"stderrLimit":16384,"closureClass":"git","parser":"clean-status"},
  {"id":"git-head","executableClass":"git","argv":["--no-pager","--no-optional-locks","rev-parse","--verify","HEAD"],"cwdClass":"candidate","environment":{"GIT_OPTIONAL_LOCKS":"0","GIT_NO_REPLACE_OBJECTS":"1","GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_SYSTEM":"NUL","GIT_CONFIG_GLOBAL":"NUL","GIT_TERMINAL_PROMPT":"0","GIT_CONFIG_COUNT":"7","GIT_CONFIG_KEY_0":"core.fsmonitor","GIT_CONFIG_VALUE_0":"false","GIT_CONFIG_KEY_1":"core.untrackedCache","GIT_CONFIG_VALUE_1":"false","GIT_CONFIG_KEY_2":"core.ignoreStat","GIT_CONFIG_VALUE_2":"false","GIT_CONFIG_KEY_3":"core.sparseCheckout","GIT_CONFIG_VALUE_3":"false","GIT_CONFIG_KEY_4":"core.sparseCheckoutCone","GIT_CONFIG_VALUE_4":"false","GIT_CONFIG_KEY_5":"extensions.worktreeConfig","GIT_CONFIG_VALUE_5":"false","GIT_CONFIG_KEY_6":"core.hooksPath","GIT_CONFIG_VALUE_6":"NUL"},"timeoutMs":30000,"stdoutLimit":65536,"stderrLimit":16384,"closureClass":"git","parser":"commit-sha"},
  {"id":"git-symbolic-head","executableClass":"git","argv":["--no-pager","--no-optional-locks","symbolic-ref","-q","HEAD"],"cwdClass":"candidate","environment":{"GIT_OPTIONAL_LOCKS":"0","GIT_NO_REPLACE_OBJECTS":"1","GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_SYSTEM":"NUL","GIT_CONFIG_GLOBAL":"NUL","GIT_TERMINAL_PROMPT":"0","GIT_CONFIG_COUNT":"7","GIT_CONFIG_KEY_0":"core.fsmonitor","GIT_CONFIG_VALUE_0":"false","GIT_CONFIG_KEY_1":"core.untrackedCache","GIT_CONFIG_VALUE_1":"false","GIT_CONFIG_KEY_2":"core.ignoreStat","GIT_CONFIG_VALUE_2":"false","GIT_CONFIG_KEY_3":"core.sparseCheckout","GIT_CONFIG_VALUE_3":"false","GIT_CONFIG_KEY_4":"core.sparseCheckoutCone","GIT_CONFIG_VALUE_4":"false","GIT_CONFIG_KEY_5":"extensions.worktreeConfig","GIT_CONFIG_VALUE_5":"false","GIT_CONFIG_KEY_6":"core.hooksPath","GIT_CONFIG_VALUE_6":"NUL"},"timeoutMs":30000,"stdoutLimit":65536,"stderrLimit":16384,"closureClass":"git","parser":"branch-ref"},
  {"id":"git-status","executableClass":"git","argv":["--no-pager","--no-optional-locks","status","--porcelain=v2","-z","--untracked-files=all","--ignore-submodules=none"],"cwdClass":"candidate","environment":{"GIT_OPTIONAL_LOCKS":"0","GIT_NO_REPLACE_OBJECTS":"1","GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_SYSTEM":"NUL","GIT_CONFIG_GLOBAL":"NUL","GIT_TERMINAL_PROMPT":"0","GIT_CONFIG_COUNT":"7","GIT_CONFIG_KEY_0":"core.fsmonitor","GIT_CONFIG_VALUE_0":"false","GIT_CONFIG_KEY_1":"core.untrackedCache","GIT_CONFIG_VALUE_1":"false","GIT_CONFIG_KEY_2":"core.ignoreStat","GIT_CONFIG_VALUE_2":"false","GIT_CONFIG_KEY_3":"core.sparseCheckout","GIT_CONFIG_VALUE_3":"false","GIT_CONFIG_KEY_4":"core.sparseCheckoutCone","GIT_CONFIG_VALUE_4":"false","GIT_CONFIG_KEY_5":"extensions.worktreeConfig","GIT_CONFIG_VALUE_5":"false","GIT_CONFIG_KEY_6":"core.hooksPath","GIT_CONFIG_VALUE_6":"NUL"},"timeoutMs":30000,"stdoutLimit":65536,"stderrLimit":16384,"closureClass":"git","parser":"clean-status"},
  {"id":"git-untracked-audit","executableClass":"git","argv":["--no-pager","--no-optional-locks","ls-files","--others","--exclude-per-directory=.gitignore","-z"],"cwdClass":"candidate","environment":{"GIT_OPTIONAL_LOCKS":"0","GIT_NO_REPLACE_OBJECTS":"1","GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_SYSTEM":"NUL","GIT_CONFIG_GLOBAL":"NUL","GIT_TERMINAL_PROMPT":"0","GIT_CONFIG_COUNT":"7","GIT_CONFIG_KEY_0":"core.fsmonitor","GIT_CONFIG_VALUE_0":"false","GIT_CONFIG_KEY_1":"core.untrackedCache","GIT_CONFIG_VALUE_1":"false","GIT_CONFIG_KEY_2":"core.ignoreStat","GIT_CONFIG_VALUE_2":"false","GIT_CONFIG_KEY_3":"core.sparseCheckout","GIT_CONFIG_VALUE_3":"false","GIT_CONFIG_KEY_4":"core.sparseCheckoutCone","GIT_CONFIG_VALUE_4":"false","GIT_CONFIG_KEY_5":"extensions.worktreeConfig","GIT_CONFIG_VALUE_5":"false","GIT_CONFIG_KEY_6":"core.hooksPath","GIT_CONFIG_VALUE_6":"NUL"},"timeoutMs":30000,"stdoutLimit":65536,"stderrLimit":16384,"closureClass":"git","parser":"clean-status"},
  {"id":"git-worktree-list","executableClass":"git","argv":["--no-pager","--no-optional-locks","worktree","list","--porcelain","-z"],"cwdClass":"candidate","environment":{"GIT_OPTIONAL_LOCKS":"0","GIT_NO_REPLACE_OBJECTS":"1","GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_SYSTEM":"NUL","GIT_CONFIG_GLOBAL":"NUL","GIT_TERMINAL_PROMPT":"0","GIT_CONFIG_COUNT":"7","GIT_CONFIG_KEY_0":"core.fsmonitor","GIT_CONFIG_VALUE_0":"false","GIT_CONFIG_KEY_1":"core.untrackedCache","GIT_CONFIG_VALUE_1":"false","GIT_CONFIG_KEY_2":"core.ignoreStat","GIT_CONFIG_VALUE_2":"false","GIT_CONFIG_KEY_3":"core.sparseCheckout","GIT_CONFIG_VALUE_3":"false","GIT_CONFIG_KEY_4":"core.sparseCheckoutCone","GIT_CONFIG_VALUE_4":"false","GIT_CONFIG_KEY_5":"extensions.worktreeConfig","GIT_CONFIG_VALUE_5":"false","GIT_CONFIG_KEY_6":"core.hooksPath","GIT_CONFIG_VALUE_6":"NUL"},"timeoutMs":30000,"stdoutLimit":65536,"stderrLimit":16384,"closureClass":"git","parser":"worktree-facts"},
  {"id":"git-source-epoch","executableClass":"git","argv":["--no-pager","--no-optional-locks","show","-s","--format=%ct","HEAD"],"cwdClass":"candidate","environment":{"GIT_OPTIONAL_LOCKS":"0","GIT_NO_REPLACE_OBJECTS":"1","GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_SYSTEM":"NUL","GIT_CONFIG_GLOBAL":"NUL","GIT_TERMINAL_PROMPT":"0","GIT_CONFIG_COUNT":"7","GIT_CONFIG_KEY_0":"core.fsmonitor","GIT_CONFIG_VALUE_0":"false","GIT_CONFIG_KEY_1":"core.untrackedCache","GIT_CONFIG_VALUE_1":"false","GIT_CONFIG_KEY_2":"core.ignoreStat","GIT_CONFIG_VALUE_2":"false","GIT_CONFIG_KEY_3":"core.sparseCheckout","GIT_CONFIG_VALUE_3":"false","GIT_CONFIG_KEY_4":"core.sparseCheckoutCone","GIT_CONFIG_VALUE_4":"false","GIT_CONFIG_KEY_5":"extensions.worktreeConfig","GIT_CONFIG_VALUE_5":"false","GIT_CONFIG_KEY_6":"core.hooksPath","GIT_CONFIG_VALUE_6":"NUL"},"timeoutMs":30000,"stdoutLimit":65536,"stderrLimit":16384,"closureClass":"git","parser":"source-epoch"},
  {"id":"git-package-blob-hash","executableClass":"git","argv":["--no-pager","--no-optional-locks","cat-file","blob","HEAD:package.json"],"cwdClass":"candidate","environment":{"GIT_OPTIONAL_LOCKS":"0","GIT_NO_REPLACE_OBJECTS":"1","GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_SYSTEM":"NUL","GIT_CONFIG_GLOBAL":"NUL","GIT_TERMINAL_PROMPT":"0","GIT_CONFIG_COUNT":"7","GIT_CONFIG_KEY_0":"core.fsmonitor","GIT_CONFIG_VALUE_0":"false","GIT_CONFIG_KEY_1":"core.untrackedCache","GIT_CONFIG_VALUE_1":"false","GIT_CONFIG_KEY_2":"core.ignoreStat","GIT_CONFIG_VALUE_2":"false","GIT_CONFIG_KEY_3":"core.sparseCheckout","GIT_CONFIG_VALUE_3":"false","GIT_CONFIG_KEY_4":"core.sparseCheckoutCone","GIT_CONFIG_VALUE_4":"false","GIT_CONFIG_KEY_5":"extensions.worktreeConfig","GIT_CONFIG_VALUE_5":"false","GIT_CONFIG_KEY_6":"core.hooksPath","GIT_CONFIG_VALUE_6":"NUL"},"timeoutMs":30000,"stdoutLimit":65536,"stderrLimit":16384,"closureClass":"git","parser":"sha256-bytes"},
  {"id":"git-diff-quiet","executableClass":"git","argv":["--no-pager","--no-optional-locks","diff-index","--quiet","--no-ext-diff","--no-textconv","--ignore-submodules=none","HEAD","--"],"cwdClass":"candidate","environment":{"GIT_OPTIONAL_LOCKS":"0","GIT_NO_REPLACE_OBJECTS":"1","GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_SYSTEM":"NUL","GIT_CONFIG_GLOBAL":"NUL","GIT_TERMINAL_PROMPT":"0","GIT_CONFIG_COUNT":"7","GIT_CONFIG_KEY_0":"core.fsmonitor","GIT_CONFIG_VALUE_0":"false","GIT_CONFIG_KEY_1":"core.untrackedCache","GIT_CONFIG_VALUE_1":"false","GIT_CONFIG_KEY_2":"core.ignoreStat","GIT_CONFIG_VALUE_2":"false","GIT_CONFIG_KEY_3":"core.sparseCheckout","GIT_CONFIG_VALUE_3":"false","GIT_CONFIG_KEY_4":"core.sparseCheckoutCone","GIT_CONFIG_VALUE_4":"false","GIT_CONFIG_KEY_5":"extensions.worktreeConfig","GIT_CONFIG_VALUE_5":"false","GIT_CONFIG_KEY_6":"core.hooksPath","GIT_CONFIG_VALUE_6":"NUL"},"timeoutMs":30000,"stdoutLimit":65536,"stderrLimit":16384,"closureClass":"git","parser":"quiet-exit"},
  {"id":"git-main-config-audit","executableClass":"git-private-main","argv":["--no-pager","--no-optional-locks","config","--local","--no-includes","-z","--list"],"cwdClass":"private-main","environment":{"GIT_OPTIONAL_LOCKS":"0","GIT_NO_REPLACE_OBJECTS":"1","GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_SYSTEM":"NUL","GIT_CONFIG_GLOBAL":"NUL","GIT_TERMINAL_PROMPT":"0","GIT_CONFIG_COUNT":"7","GIT_CONFIG_KEY_0":"core.fsmonitor","GIT_CONFIG_VALUE_0":"false","GIT_CONFIG_KEY_1":"core.untrackedCache","GIT_CONFIG_VALUE_1":"false","GIT_CONFIG_KEY_2":"core.ignoreStat","GIT_CONFIG_VALUE_2":"false","GIT_CONFIG_KEY_3":"core.sparseCheckout","GIT_CONFIG_VALUE_3":"false","GIT_CONFIG_KEY_4":"core.sparseCheckoutCone","GIT_CONFIG_VALUE_4":"false","GIT_CONFIG_KEY_5":"extensions.worktreeConfig","GIT_CONFIG_VALUE_5":"false","GIT_CONFIG_KEY_6":"core.hooksPath","GIT_CONFIG_VALUE_6":"NUL"},"timeoutMs":30000,"stdoutLimit":65536,"stderrLimit":16384,"closureClass":"git","parser":"git-config-audit"},
  {"id":"git-main-index-audit","executableClass":"git-private-main","argv":["--no-pager","--no-optional-locks","ls-files","--cached","--stage","--debug","--sparse","-z"],"cwdClass":"private-main","environment":{"GIT_OPTIONAL_LOCKS":"0","GIT_NO_REPLACE_OBJECTS":"1","GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_SYSTEM":"NUL","GIT_CONFIG_GLOBAL":"NUL","GIT_TERMINAL_PROMPT":"0","GIT_CONFIG_COUNT":"7","GIT_CONFIG_KEY_0":"core.fsmonitor","GIT_CONFIG_VALUE_0":"false","GIT_CONFIG_KEY_1":"core.untrackedCache","GIT_CONFIG_VALUE_1":"false","GIT_CONFIG_KEY_2":"core.ignoreStat","GIT_CONFIG_VALUE_2":"false","GIT_CONFIG_KEY_3":"core.sparseCheckout","GIT_CONFIG_VALUE_3":"false","GIT_CONFIG_KEY_4":"core.sparseCheckoutCone","GIT_CONFIG_VALUE_4":"false","GIT_CONFIG_KEY_5":"extensions.worktreeConfig","GIT_CONFIG_VALUE_5":"false","GIT_CONFIG_KEY_6":"core.hooksPath","GIT_CONFIG_VALUE_6":"NUL"},"timeoutMs":30000,"stdoutLimit":1048576,"stderrLimit":16384,"closureClass":"git","parser":"git-index-audit"},
  {"id":"git-main-head","executableClass":"git-private-main","argv":["--no-pager","--no-optional-locks","rev-parse","--verify","HEAD"],"cwdClass":"private-main","environment":{"GIT_OPTIONAL_LOCKS":"0","GIT_NO_REPLACE_OBJECTS":"1","GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_SYSTEM":"NUL","GIT_CONFIG_GLOBAL":"NUL","GIT_TERMINAL_PROMPT":"0","GIT_CONFIG_COUNT":"7","GIT_CONFIG_KEY_0":"core.fsmonitor","GIT_CONFIG_VALUE_0":"false","GIT_CONFIG_KEY_1":"core.untrackedCache","GIT_CONFIG_VALUE_1":"false","GIT_CONFIG_KEY_2":"core.ignoreStat","GIT_CONFIG_VALUE_2":"false","GIT_CONFIG_KEY_3":"core.sparseCheckout","GIT_CONFIG_VALUE_3":"false","GIT_CONFIG_KEY_4":"core.sparseCheckoutCone","GIT_CONFIG_VALUE_4":"false","GIT_CONFIG_KEY_5":"extensions.worktreeConfig","GIT_CONFIG_VALUE_5":"false","GIT_CONFIG_KEY_6":"core.hooksPath","GIT_CONFIG_VALUE_6":"NUL"},"timeoutMs":30000,"stdoutLimit":65536,"stderrLimit":16384,"closureClass":"git","parser":"commit-sha"},
  {"id":"git-main-status","executableClass":"git-private-main","argv":["--no-pager","--no-optional-locks","status","--porcelain=v2","-z","--untracked-files=all","--ignore-submodules=none"],"cwdClass":"private-main","environment":{"GIT_OPTIONAL_LOCKS":"0","GIT_NO_REPLACE_OBJECTS":"1","GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_SYSTEM":"NUL","GIT_CONFIG_GLOBAL":"NUL","GIT_TERMINAL_PROMPT":"0","GIT_CONFIG_COUNT":"7","GIT_CONFIG_KEY_0":"core.fsmonitor","GIT_CONFIG_VALUE_0":"false","GIT_CONFIG_KEY_1":"core.untrackedCache","GIT_CONFIG_VALUE_1":"false","GIT_CONFIG_KEY_2":"core.ignoreStat","GIT_CONFIG_VALUE_2":"false","GIT_CONFIG_KEY_3":"core.sparseCheckout","GIT_CONFIG_VALUE_3":"false","GIT_CONFIG_KEY_4":"core.sparseCheckoutCone","GIT_CONFIG_VALUE_4":"false","GIT_CONFIG_KEY_5":"extensions.worktreeConfig","GIT_CONFIG_VALUE_5":"false","GIT_CONFIG_KEY_6":"core.hooksPath","GIT_CONFIG_VALUE_6":"NUL"},"timeoutMs":30000,"stdoutLimit":65536,"stderrLimit":16384,"closureClass":"git","parser":"clean-status"},
  {"id":"git-main-untracked-audit","executableClass":"git-private-main","argv":["--no-pager","--no-optional-locks","ls-files","--others","--exclude-per-directory=.gitignore","-z"],"cwdClass":"private-main","environment":{"GIT_OPTIONAL_LOCKS":"0","GIT_NO_REPLACE_OBJECTS":"1","GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_SYSTEM":"NUL","GIT_CONFIG_GLOBAL":"NUL","GIT_TERMINAL_PROMPT":"0","GIT_CONFIG_COUNT":"7","GIT_CONFIG_KEY_0":"core.fsmonitor","GIT_CONFIG_VALUE_0":"false","GIT_CONFIG_KEY_1":"core.untrackedCache","GIT_CONFIG_VALUE_1":"false","GIT_CONFIG_KEY_2":"core.ignoreStat","GIT_CONFIG_VALUE_2":"false","GIT_CONFIG_KEY_3":"core.sparseCheckout","GIT_CONFIG_VALUE_3":"false","GIT_CONFIG_KEY_4":"core.sparseCheckoutCone","GIT_CONFIG_VALUE_4":"false","GIT_CONFIG_KEY_5":"extensions.worktreeConfig","GIT_CONFIG_VALUE_5":"false","GIT_CONFIG_KEY_6":"core.hooksPath","GIT_CONFIG_VALUE_6":"NUL"},"timeoutMs":30000,"stdoutLimit":65536,"stderrLimit":16384,"closureClass":"git","parser":"clean-status"},
  {"id":"npm-ci-ignore-scripts","executableClass":"npm","argv":["ci","--ignore-scripts","--no-audit","--no-fund"],"cwdClass":"candidate","environment":{"NPM_CONFIG_IGNORE_SCRIPTS":"true","NPM_CONFIG_AUDIT":"false","NPM_CONFIG_FUND":"false","NPM_CONFIG_USERCONFIG":"NUL","NPM_CONFIG_GLOBALCONFIG":"NUL","NPM_CONFIG_UPDATE_NOTIFIER":"false"},"timeoutMs":900000,"stdoutLimit":4194304,"stderrLimit":1048576,"closureClass":"npm","parser":"zero-exit"},
  {"id":"lifecycle-electron-install","executableClass":"node-lifecycle","argv":[],"cwdClass":"package:electron","environment":{},"timeoutMs":120000,"stdoutLimit":262144,"stderrLimit":65536,"closureClass":"electron-lifecycle","parser":"zero-exit"},
  {"id":"lifecycle-esbuild-install","executableClass":"node-lifecycle","argv":[],"cwdClass":"package:esbuild","environment":{},"timeoutMs":120000,"stdoutLimit":262144,"stderrLimit":65536,"closureClass":"esbuild-lifecycle","parser":"zero-exit"},
  {"id":"lifecycle-electron-winstaller","executableClass":"node-lifecycle","argv":[],"cwdClass":"package:electron-winstaller","environment":{},"timeoutMs":120000,"stdoutLimit":262144,"stderrLimit":65536,"closureClass":"electron-winstaller-lifecycle","parser":"zero-exit"},
  {"id":"typecheck","executableClass":"node-workspace","argv":["node_modules/typescript/bin/tsc","--noEmit","-p","tsconfig.json"],"cwdClass":"candidate","environment":{},"timeoutMs":300000,"stdoutLimit":1048576,"stderrLimit":262144,"closureClass":"workspace-final","parser":"zero-exit"},
  {"id":"typecheck-ipc","executableClass":"node-workspace","argv":["node_modules/typescript/bin/tsc","--noEmit","-p","tests/typecheck/tsconfig.json"],"cwdClass":"candidate","environment":{},"timeoutMs":300000,"stdoutLimit":1048576,"stderrLimit":262144,"closureClass":"workspace-final","parser":"zero-exit"},
  {"id":"lint","executableClass":"node-workspace","argv":["node_modules/eslint/bin/eslint.js","src","--ext",".ts,.tsx"],"cwdClass":"candidate","environment":{},"timeoutMs":300000,"stdoutLimit":1048576,"stderrLimit":262144,"closureClass":"workspace-final","parser":"zero-exit"},
  {"id":"test-full","executableClass":"node-workspace","argv":["node_modules/vitest/vitest.mjs","run","--config","vitest.config.ts","--no-cache","--silent","--reporter=./scripts/release/vitest-preflight-reporter.mjs"],"cwdClass":"candidate","environment":{},"timeoutMs":900000,"stdoutLimit":4194304,"stderrLimit":1048576,"closureClass":"workspace-final","parser":"vitest-preflight-json"},
  {"id":"build-main","executableClass":"node-workspace","argv":["node_modules/vite/bin/vite.js","build","--config","vite.main.config.ts"],"cwdClass":"candidate","environment":{"SOURCE_DATE_EPOCH":"@release-metadata-epoch","WORKBENCH_RELEASE_METADATA_PATH":"@fixed-release-metadata"},"timeoutMs":300000,"stdoutLimit":1048576,"stderrLimit":262144,"closureClass":"workspace-final","parser":"zero-exit"},
  {"id":"build-preload","executableClass":"node-workspace","argv":["node_modules/vite/bin/vite.js","build","--config","vite.preload.config.ts"],"cwdClass":"candidate","environment":{"SOURCE_DATE_EPOCH":"@release-metadata-epoch"},"timeoutMs":300000,"stdoutLimit":1048576,"stderrLimit":262144,"closureClass":"workspace-final","parser":"zero-exit"},
  {"id":"build-renderer","executableClass":"node-workspace","argv":["node_modules/vite/bin/vite.js","build","--config","vite.renderer.config.ts"],"cwdClass":"candidate","environment":{"SOURCE_DATE_EPOCH":"@release-metadata-epoch"},"timeoutMs":300000,"stdoutLimit":1048576,"stderrLimit":262144,"closureClass":"workspace-final","parser":"zero-exit"},
  {"id":"icon-verify","executableClass":"electron-workspace","argv":["scripts/generate-app-icons.mjs","--verify"],"cwdClass":"candidate","environment":{},"timeoutMs":120000,"stdoutLimit":262144,"stderrLimit":65536,"closureClass":"electron-final","parser":"zero-exit"},
  {"id":"node-abi-probe","executableClass":"node-workspace","argv":["scripts/release/native-abi-probe.mjs"],"cwdClass":"candidate","environment":{},"timeoutMs":60000,"stdoutLimit":65536,"stderrLimit":16384,"closureClass":"workspace-final","parser":"native-abi-json"},
  {"id":"electron-abi-probe","executableClass":"electron-workspace","argv":["scripts/release/native-abi-probe.mjs"],"cwdClass":"candidate","environment":{"ELECTRON_RUN_AS_NODE":"1"},"timeoutMs":60000,"stdoutLimit":65536,"stderrLimit":16384,"closureClass":"electron-final","parser":"native-abi-json"},
  {"id":"electron-builder-win","executableClass":"node-workspace","argv":["node_modules/electron-builder/cli.js","--win","--publish","never"],"cwdClass":"candidate","environment":{"SOURCE_DATE_EPOCH":"@release-metadata-epoch","WORKBENCH_RELEASE_METADATA_PATH":"@fixed-release-metadata"},"timeoutMs":900000,"stdoutLimit":4194304,"stderrLimit":1048576,"closureClass":"workspace-final","parser":"zero-exit"}
]`;
const DESCRIPTOR_ROWS_SHA256 = '6183a3f4bc00afdd05edc720f011ed09760d428fbea4251caf8a6b9c7645e293'
const DESCRIPTOR_ROWS = validateDescriptorRows(DESCRIPTOR_ROWS_JSON, DESCRIPTOR_ROWS_SHA256)
const DESCRIPTORS = deepFreeze(Object.fromEntries(DESCRIPTOR_ROWS.map((row) => [row.id, row])))
/* WORKBENCH_RELEASE_DESCRIPTORS_V1_END */

/* WORKBENCH_RELEASE_CONTROLLER_V1_START */
const CONTROLLER_SOURCE = String.raw`
param([Parameter(Mandatory = $true)][string]$RequestBase64)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
$CREATE_SUSPENDED = 0x00000004
$CREATE_UNICODE_ENVIRONMENT = 0x00000400
$EXTENDED_STARTUPINFO_PRESENT = 0x00080000
$CREATE_NO_WINDOW = 0x08000000
$PROC_THREAD_ATTRIBUTE_HANDLE_LIST = [UIntPtr]::new([uint64]0x00020002)
$STARTF_USESTDHANDLES = 0x00000100
$HANDLE_FLAG_INHERIT = 0x00000001
$WAIT_OBJECT_0 = 0
$WAIT_TIMEOUT = 258
$INFINITE = 0xffffffff

function New-NativeApi {
  $assemblyName = [Reflection.AssemblyName]::new('WorkbenchReleaseRunnerNativeApi')
  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName, [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $module = $assembly.DefineDynamicModule('WorkbenchReleaseRunnerNativeApi')
  $type = $module.DefineType('WorkbenchReleaseRunnerNativeMethods', [Reflection.TypeAttributes]::Public -bor [Reflection.TypeAttributes]::Sealed -bor [Reflection.TypeAttributes]::Abstract)
  $attributes = [Reflection.MethodAttributes]::Public -bor [Reflection.MethodAttributes]::Static -bor [Reflection.MethodAttributes]::PinvokeImpl
  function Add-NativeMethod([string]$Name, [string]$Library, [Type]$ReturnType, [Type[]]$Parameters, [Runtime.InteropServices.CharSet]$CharSet) {
    $method = $type.DefinePInvokeMethod($Name, $Library, $attributes, [Reflection.CallingConventions]::Standard, $ReturnType, $Parameters, [Runtime.InteropServices.CallingConvention]::Winapi, $CharSet)
    $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
  }
  Add-NativeMethod 'GetSystemDirectoryW' 'kernel32.dll' ([uint32]) ([Type[]]@([Text.StringBuilder], [uint32])) ([Runtime.InteropServices.CharSet]::Unicode)
  Add-NativeMethod 'GetCurrentProcess' 'kernel32.dll' ([IntPtr]) ([Type[]]@()) ([Runtime.InteropServices.CharSet]::None)
  Add-NativeMethod 'SHGetKnownFolderPath' 'shell32.dll' ([int]) ([Type[]]@(([Guid].MakeByRefType()), [uint32], [IntPtr], ([IntPtr].MakeByRefType()))) ([Runtime.InteropServices.CharSet]::Unicode)
  Add-NativeMethod 'CoTaskMemFree' 'ole32.dll' ([void]) ([Type[]]@([IntPtr])) ([Runtime.InteropServices.CharSet]::Unicode)
  Add-NativeMethod 'CreateJobObjectW' 'kernel32.dll' ([IntPtr]) ([Type[]]@([IntPtr], [string])) ([Runtime.InteropServices.CharSet]::Unicode)
  Add-NativeMethod 'SetInformationJobObject' 'kernel32.dll' ([bool]) ([Type[]]@([IntPtr], [int], [IntPtr], [uint32])) ([Runtime.InteropServices.CharSet]::Unicode)
  Add-NativeMethod 'QueryInformationJobObject' 'kernel32.dll' ([bool]) ([Type[]]@([IntPtr], [int], [IntPtr], [uint32], [IntPtr])) ([Runtime.InteropServices.CharSet]::Unicode)
  Add-NativeMethod 'AssignProcessToJobObject' 'kernel32.dll' ([bool]) ([Type[]]@([IntPtr], [IntPtr])) ([Runtime.InteropServices.CharSet]::Unicode)
  Add-NativeMethod 'TerminateJobObject' 'kernel32.dll' ([bool]) ([Type[]]@([IntPtr], [uint32])) ([Runtime.InteropServices.CharSet]::Unicode)
  Add-NativeMethod 'CreatePipe' 'kernel32.dll' ([bool]) ([Type[]]@(([IntPtr].MakeByRefType()), ([IntPtr].MakeByRefType()), [IntPtr], [uint32])) ([Runtime.InteropServices.CharSet]::Unicode)
  Add-NativeMethod 'SetHandleInformation' 'kernel32.dll' ([bool]) ([Type[]]@([IntPtr], [uint32], [uint32])) ([Runtime.InteropServices.CharSet]::Unicode)
  Add-NativeMethod 'CreateProcessW' 'kernel32.dll' ([bool]) ([Type[]]@([string], [Text.StringBuilder], [IntPtr], [IntPtr], [bool], [uint32], [IntPtr], [string], [IntPtr], [IntPtr])) ([Runtime.InteropServices.CharSet]::Unicode)
  Add-NativeMethod 'InitializeProcThreadAttributeList' 'kernel32.dll' ([bool]) ([Type[]]@([IntPtr], [uint32], [uint32], ([UIntPtr].MakeByRefType()))) ([Runtime.InteropServices.CharSet]::Unicode)
  Add-NativeMethod 'UpdateProcThreadAttribute' 'kernel32.dll' ([bool]) ([Type[]]@([IntPtr], [uint32], [UIntPtr], [IntPtr], [UIntPtr], [IntPtr], [IntPtr])) ([Runtime.InteropServices.CharSet]::Unicode)
  Add-NativeMethod 'DeleteProcThreadAttributeList' 'kernel32.dll' ([void]) ([Type[]]@([IntPtr])) ([Runtime.InteropServices.CharSet]::Unicode)
  Add-NativeMethod 'ResumeThread' 'kernel32.dll' ([uint32]) ([Type[]]@([IntPtr])) ([Runtime.InteropServices.CharSet]::Unicode)
  Add-NativeMethod 'WaitForSingleObject' 'kernel32.dll' ([uint32]) ([Type[]]@([IntPtr], [uint32])) ([Runtime.InteropServices.CharSet]::Unicode)
  Add-NativeMethod 'GetExitCodeProcess' 'kernel32.dll' ([bool]) ([Type[]]@([IntPtr], ([uint32].MakeByRefType()))) ([Runtime.InteropServices.CharSet]::Unicode)
  Add-NativeMethod 'TerminateProcess' 'kernel32.dll' ([bool]) ([Type[]]@([IntPtr], [uint32])) ([Runtime.InteropServices.CharSet]::Unicode)
  Add-NativeMethod 'CloseHandle' 'kernel32.dll' ([bool]) ([Type[]]@([IntPtr])) ([Runtime.InteropServices.CharSet]::Unicode)
  Add-NativeMethod 'GetFinalPathNameByHandleW' 'kernel32.dll' ([uint32]) ([Type[]]@([IntPtr], [Text.StringBuilder], [uint32], [uint32])) ([Runtime.InteropServices.CharSet]::Unicode)
  Add-NativeMethod 'GetFileInformationByHandleEx' 'kernel32.dll' ([bool]) ([Type[]]@([IntPtr], [int], [IntPtr], [uint32])) ([Runtime.InteropServices.CharSet]::Unicode)
  Add-NativeMethod 'OpenProcessToken' 'advapi32.dll' ([bool]) ([Type[]]@([IntPtr], [uint32], ([IntPtr].MakeByRefType()))) ([Runtime.InteropServices.CharSet]::None)
  Add-NativeMethod 'DuplicateToken' 'advapi32.dll' ([bool]) ([Type[]]@([IntPtr], [int], ([IntPtr].MakeByRefType()))) ([Runtime.InteropServices.CharSet]::None)
  Add-NativeMethod 'AccessCheck' 'advapi32.dll' ([bool]) ([Type[]]@([IntPtr], [IntPtr], [uint32], [IntPtr], [IntPtr], ([uint32].MakeByRefType()), ([uint32].MakeByRefType()), ([int].MakeByRefType()))) ([Runtime.InteropServices.CharSet]::None)
  Add-NativeMethod 'MapGenericMask' 'advapi32.dll' ([void]) ([Type[]]@(([uint32].MakeByRefType()), [IntPtr])) ([Runtime.InteropServices.CharSet]::None)
  return $type.CreateType()
}

function Exact-Keys($Object, [string[]]$Keys) {
  if ($null -eq $Object) { return $false }
  [string[]]$actual = @($Object.PSObject.Properties.Name)
  [string[]]$wanted = @($Keys)
  [Array]::Sort($actual, [StringComparer]::Ordinal)
  [Array]::Sort($wanted, [StringComparer]::Ordinal)
  if ($actual.Length -ne $wanted.Length) { return $false }
  for ($index = 0; $index -lt $actual.Length; $index += 1) {
    if (-not $actual[$index].Equals($wanted[$index], [StringComparison]::Ordinal)) { return $false }
  }
  return $true
}

function Assert-SafeText([string]$Value, [int]$Maximum) {
  if ($null -eq $Value -or $Value.Length -gt $Maximum -or $Value.IndexOf([char]0) -ge 0 -or $Value -match '[\u0001-\u0008\u000b\u000c\u000e-\u001f]') { throw 'protocol' }
}

function Get-SystemDirectory($Api) {
  $buffer = [Text.StringBuilder]::new(512)
  $length = $Api::GetSystemDirectoryW($buffer, [uint32]$buffer.Capacity)
  if ($length -eq 0 -or $length -ge $buffer.Capacity) { throw 'trust-root' }
  return [IO.Path]::GetFullPath($buffer.ToString())
}

function Get-ProgramFilesDirectory($Api) {
  $folder = [Guid]'905e63b6-c1bf-494e-b29c-65b732d3d21a'
  $pointer = [IntPtr]::Zero
  $result = $Api::SHGetKnownFolderPath([ref]$folder, 0, [IntPtr]::Zero, [ref]$pointer)
  if ($result -ne 0 -or $pointer -eq [IntPtr]::Zero) { throw 'trust-root' }
  try { return [IO.Path]::GetFullPath([Runtime.InteropServices.Marshal]::PtrToStringUni($pointer)) } finally { $Api::CoTaskMemFree($pointer) }
}

function Assert-NonReparsePath([string]$LiteralPath, [string]$Boundary, [bool]$RequireFile) {
  $full = [IO.Path]::GetFullPath($LiteralPath)
  $root = [IO.Path]::GetFullPath($Boundary).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if (-not $full.Equals($root, [StringComparison]::OrdinalIgnoreCase) -and -not $full.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'containment' }
  $current = $root
  $relative = $full.Substring($root.Length).TrimStart([IO.Path]::DirectorySeparatorChar)
  foreach ($component in $relative.Split([IO.Path]::DirectorySeparatorChar, [StringSplitOptions]::RemoveEmptyEntries)) {
    $current = [IO.Path]::Combine($current, $component)
    $item = Get-Item -LiteralPath $current -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
  }
  $final = Get-Item -LiteralPath $full -Force
  if ($RequireFile -and $final.PSIsContainer) { throw 'ordinary' }
  if (-not $RequireFile -and -not $final.PSIsContainer) { throw 'ordinary' }
  return $full
}

function Assert-ProtectedAcl($Api, [string]$LiteralPath) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $processToken = [IntPtr]::Zero
  $impersonationToken = [IntPtr]::Zero
  $mapping = [IntPtr]::Zero
  try {
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or $identity.ImpersonationLevel -ne [Security.Principal.TokenImpersonationLevel]::None) { throw 'elevated' }
    if (-not $Api::OpenProcessToken($Api::GetCurrentProcess(), [uint32]0x000A, [ref]$processToken) -or $processToken -eq [IntPtr]::Zero) { throw 'acl-token' }
    if (-not $Api::DuplicateToken($processToken, 2, [ref]$impersonationToken) -or $impersonationToken -eq [IntPtr]::Zero) { throw 'acl-token' }

    $mapping = [Runtime.InteropServices.Marshal]::AllocHGlobal(16)
    [Runtime.InteropServices.Marshal]::WriteInt32($mapping, 0, 0x00120089)
    [Runtime.InteropServices.Marshal]::WriteInt32($mapping, 4, 0x00120116)
    [Runtime.InteropServices.Marshal]::WriteInt32($mapping, 8, 0x001200A0)
    [Runtime.InteropServices.Marshal]::WriteInt32($mapping, 12, 0x001F01FF)

    $trustedOwners = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
    $full = [IO.Path]::GetFullPath($LiteralPath)
    $root = [IO.Path]::GetPathRoot($full)
    $paths = [Collections.Generic.List[string]]::new()
    $paths.Add($root)
    $current = $root
    foreach ($component in $full.Substring($root.Length).Split([IO.Path]::DirectorySeparatorChar, [StringSplitOptions]::RemoveEmptyEntries)) {
      $current = [IO.Path]::Combine($current, $component)
      $paths.Add($current)
    }

    foreach ($protectedPath in $paths) {
      $acl = Get-Acl -LiteralPath $protectedPath
      $securityDescriptorBytes = $acl.GetSecurityDescriptorBinaryForm()
      $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($securityDescriptorBytes, 0)
      if (-not $acl.AreAccessRulesCanonical -or $null -eq $descriptor.Owner -or $descriptor.Owner.Value -notin $trustedOwners -or $null -eq $descriptor.DiscretionaryAcl) { throw 'acl-owner' }
      foreach ($ace in $descriptor.DiscretionaryAcl) {
        if ($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback -or ($ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed -and $ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessDenied)) { throw 'acl-unsupported' }
      }

      $securityDescriptor = [Runtime.InteropServices.Marshal]::AllocHGlobal($securityDescriptorBytes.Length)
      $privilegeSet = [IntPtr]::Zero
      try {
        [Runtime.InteropServices.Marshal]::Copy($securityDescriptorBytes, 0, $securityDescriptor, $securityDescriptorBytes.Length)
        $privilegeLength = [uint32]0
        $granted = [uint32]0
        $accessStatus = [int]0
        $first = $Api::AccessCheck($securityDescriptor, $impersonationToken, [uint32]0x02000000, $mapping, [IntPtr]::Zero, [ref]$privilegeLength, [ref]$granted, [ref]$accessStatus)
        if (-not $first) {
          if ($privilegeLength -lt 1 -or $privilegeLength -gt 65536) { throw 'acl-check' }
          $privilegeSet = [Runtime.InteropServices.Marshal]::AllocHGlobal([int]$privilegeLength)
          if (-not $Api::AccessCheck($securityDescriptor, $impersonationToken, [uint32]0x02000000, $mapping, $privilegeSet, [ref]$privilegeLength, [ref]$granted, [ref]$accessStatus)) { throw 'acl-check' }
        }
        if ($accessStatus -eq 0) { throw 'acl-read' }
        $Api::MapGenericMask([ref]$granted, $mapping)
        $forbidden = if ($protectedPath.Equals($root, [StringComparison]::OrdinalIgnoreCase)) { [uint32]0x000D0040 } else { [uint32]0x000D0156 }
        if (($granted -band $forbidden) -ne 0) { throw 'acl-write' }
      } finally {
        if ($privilegeSet -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($privilegeSet) }
        [Runtime.InteropServices.Marshal]::FreeHGlobal($securityDescriptor)
      }
    }
  } finally {
    if ($mapping -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($mapping) }
    if ($impersonationToken -ne [IntPtr]::Zero) { [void]$Api::CloseHandle($impersonationToken) }
    if ($processToken -ne [IntPtr]::Zero) { [void]$Api::CloseHandle($processToken) }
    $identity.Dispose()
  }
}

function Get-HandleFacts($Api, [IO.FileStream]$Stream) {
  $handle = $Stream.SafeFileHandle.DangerousGetHandle()
  $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal(24)
  try {
    if (-not $Api::GetFileInformationByHandleEx($handle, 18, $buffer, 24)) { throw 'identity' }
    $bytes = New-Object byte[] 24
    [Runtime.InteropServices.Marshal]::Copy($buffer, $bytes, 0, 24)
  } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }
  $pathBuffer = [Text.StringBuilder]::new(1024)
  $length = $Api::GetFinalPathNameByHandleW($handle, $pathBuffer, [uint32]$pathBuffer.Capacity, 0)
  if ($length -eq 0 -or $length -ge $pathBuffer.Capacity) { throw 'identity' }
  $finalPath = $pathBuffer.ToString()
  if ($finalPath.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) { $finalPath = '\\' + $finalPath.Substring(8) }
  elseif ($finalPath.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) { $finalPath = $finalPath.Substring(4) }
  return [PSCustomObject]@{ Identity = ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant(); FinalPath = [IO.Path]::GetFullPath($finalPath) }
}

function Get-StreamSha256([IO.FileStream]$Stream) {
  $Stream.Position = 0
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($algorithm.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() } finally { $algorithm.Dispose() }
}

function Open-BoundFile($Api, [string]$LiteralPath, [string]$Boundary, [string]$ExpectedHash, [bool]$Protected) {
  $path = Assert-NonReparsePath $LiteralPath $Boundary $true
  if ($Protected) { Assert-ProtectedAcl $Api $path }
  $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $facts = Get-HandleFacts $Api $stream
    if (-not $facts.FinalPath.Equals($path, [StringComparison]::OrdinalIgnoreCase) -or (Get-StreamSha256 $stream) -ne $ExpectedHash) { throw 'identity' }
    return [PSCustomObject]@{ Path = $path; Boundary = $Boundary; ExpectedHash = $ExpectedHash; Protected = $Protected; Stream = $stream; Identity = $facts.Identity; FinalPath = $facts.FinalPath }
  } catch { $stream.Dispose(); throw }
}

function Assert-BoundFile($Api, $Bound) {
  $path = Assert-NonReparsePath $Bound.Path $Bound.Boundary $true
  if ($Bound.Protected) { Assert-ProtectedAcl $Api $path }
  $held = Get-HandleFacts $Api $Bound.Stream
  $short = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $current = Get-HandleFacts $Api $short
    if ($held.Identity -ne $Bound.Identity -or $current.Identity -ne $Bound.Identity -or -not $current.FinalPath.Equals($Bound.FinalPath, [StringComparison]::OrdinalIgnoreCase) -or (Get-StreamSha256 $short) -ne $Bound.ExpectedHash) { throw 'identity' }
  } finally { $short.Dispose() }
}

function Get-CanonicalTree($Api, [string]$Root, [string[]]$Selected, [bool]$Protected) {
  $rows = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
  function Visit([string]$FullPath) {
    $item = Get-Item -LiteralPath $FullPath -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
    if ($item.PSIsContainer) {
      [string[]]$children = @(Get-ChildItem -LiteralPath $FullPath -Force | ForEach-Object { $_.FullName })
      [Array]::Sort($children, [StringComparer]::Ordinal)
      foreach ($child in $children) { Visit $child }
      return
    }
    if ($Protected) { Assert-ProtectedAcl $Api $FullPath }
    $stream = [IO.File]::Open($FullPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
      $rootPrefix = $Root.TrimEnd('\') + '\'
      if (-not $FullPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'tree-containment' }
      $relative = $FullPath.Substring($rootPrefix.Length).Replace('\', '/')
      if ($rows.ContainsKey($relative)) { throw 'tree-duplicate' }
      $rows.Add($relative, [ordered]@{ relativePath = $relative; size = $stream.Length; fileSha256 = Get-StreamSha256 $stream })
    } finally { $stream.Dispose() }
  }
  foreach ($member in $Selected) { Visit ([IO.Path]::Combine($Root, $member.Replace('/', '\'))) }
  [string[]]$relativePaths = @($rows.Keys)
  [Array]::Sort($relativePaths, [StringComparer]::Ordinal)
  $ordered = @($relativePaths | ForEach-Object { $rows[$_] })
  $json = ConvertTo-Json $ordered -Compress -Depth 4
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json + [char]10)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { $hash = ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() } finally { $algorithm.Dispose() }
  $totalBytes = [int64]0
  foreach ($row in $ordered) { $totalBytes += [int64]$row.size }
  return [PSCustomObject]@{ fileCount = $ordered.Count; totalBytes = $totalBytes; treeSha256 = $hash }
}

function Assert-Tree($Api, $Tree) {
  $actual = Get-CanonicalTree $Api $Tree.root @($Tree.selected) ([bool]$Tree.protected)
  if ($actual.fileCount -ne $Tree.fileCount -or $actual.totalBytes -ne $Tree.totalBytes -or $actual.treeSha256 -ne $Tree.treeSha256) { throw 'tree' }
}

function ConvertTo-WindowsArgument([AllowEmptyString()][string]$Value) {
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $builder = [Text.StringBuilder]::new()
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') { $backslashes += 1; continue }
    if ($character -eq '"') {
      [void]$builder.Append(('\' * (($backslashes * 2) + 1)))
      [void]$builder.Append('"')
    } else {
      if ($backslashes -gt 0) { [void]$builder.Append(('\' * $backslashes)) }
      [void]$builder.Append($character)
    }
    $backslashes = 0
  }
  if ($backslashes -gt 0) { [void]$builder.Append(('\' * ($backslashes * 2))) }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function New-KillOnCloseJob($Api) {
  $job = $Api::CreateJobObjectW([IntPtr]::Zero, $null)
  if ($job -eq [IntPtr]::Zero) { throw 'job' }
  $information = [Runtime.InteropServices.Marshal]::AllocHGlobal(144)
  try {
    [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] 144), 0, $information, 144)
    [Runtime.InteropServices.Marshal]::WriteInt32($information, 16, $JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
    if (-not $Api::SetInformationJobObject($job, 9, $information, 144)) { throw 'job' }
    return $job
  } catch { [void]$Api::CloseHandle($job); throw } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($information) }
}

function Set-JobKillOnClose($Api, [IntPtr]$Job, [bool]$Enabled) {
  $information = [Runtime.InteropServices.Marshal]::AllocHGlobal(144)
  try {
    [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] 144), 0, $information, 144)
    [Runtime.InteropServices.Marshal]::WriteInt32($information, 16, $(if ($Enabled) { $JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE } else { 0 }))
    if (-not $Api::SetInformationJobObject($Job, 9, $information, 144)) { throw 'job' }
  } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($information) }
}

function Get-JobActiveCount($Api, [IntPtr]$Job) {
  $information = [Runtime.InteropServices.Marshal]::AllocHGlobal(48)
  try {
    [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] 48), 0, $information, 48)
    if (-not $Api::QueryInformationJobObject($Job, 1, $information, 48, [IntPtr]::Zero)) { throw 'job-query' }
    return [Runtime.InteropServices.Marshal]::ReadInt32($information, 40)
  } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($information) }
}

function New-InheritablePipe($Api) {
  $attributes = [Runtime.InteropServices.Marshal]::AllocHGlobal(24)
  try {
    [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] 24), 0, $attributes, 24)
    [Runtime.InteropServices.Marshal]::WriteInt32($attributes, 0, 24)
    [Runtime.InteropServices.Marshal]::WriteInt32($attributes, 16, 1)
    $read = [IntPtr]::Zero; $write = [IntPtr]::Zero
    if (-not $Api::CreatePipe([ref]$read, [ref]$write, $attributes, 0)) { throw 'pipe' }
    return [PSCustomObject]@{ Read = $read; Write = $write }
  } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($attributes) }
}

function New-EnvironmentBlock($Environment) {
  $rows = [Collections.Generic.List[string]]::new()
  [string[]]$names = @($Environment.PSObject.Properties.Name)
  [Array]::Sort($names, [StringComparer]::OrdinalIgnoreCase)
  foreach ($name in $names) { $rows.Add($name + '=' + [string]$Environment.$name) }
  $bytes = [Text.Encoding]::Unicode.GetBytes(($rows -join [char]0) + [char]0 + [char]0)
  $pointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $pointer, $bytes.Length)
  return $pointer
}

function Assert-NoDuplicateJsonKeys([string]$JsonText) {
  $state = [PSCustomObject]@{ Offset = 0 }
  function Skip-JsonWhitespace {
    while ($state.Offset -lt $JsonText.Length -and $JsonText[$state.Offset] -in @(' ', [char]9, [char]10, [char]13)) { $state.Offset += 1 }
  }
  function Read-JsonString {
    if ($state.Offset -ge $JsonText.Length -or $JsonText[$state.Offset] -ne '"') { throw 'protocol' }
    $start = $state.Offset
    $state.Offset += 1
    while ($state.Offset -lt $JsonText.Length) {
      $character = $JsonText[$state.Offset]
      if ([int]$character -lt 0x20) { throw 'protocol' }
      if ($character -eq '\') {
        $state.Offset += 1
        if ($state.Offset -ge $JsonText.Length) { throw 'protocol' }
        $escape = $JsonText[$state.Offset]
        if ($escape -eq 'u') {
          if ($state.Offset + 4 -ge $JsonText.Length -or -not [Text.RegularExpressions.Regex]::IsMatch($JsonText.Substring($state.Offset + 1, 4), '\A[0-9A-Fa-f]{4}\z')) { throw 'protocol' }
          $state.Offset += 5
          continue
        }
        if ($escape -notin @('"','\','/','b','f','n','r','t')) { throw 'protocol' }
        $state.Offset += 1
        continue
      }
      if ($character -eq '"') {
        $state.Offset += 1
        try { $decoded = ConvertFrom-Json -InputObject $JsonText.Substring($start, $state.Offset - $start) } catch { throw 'protocol' }
        if ($decoded -isnot [string]) { throw 'protocol' }
        return $decoded
      }
      $state.Offset += 1
    }
    throw 'protocol'
  }
  function Read-JsonValue {
    Skip-JsonWhitespace
    if ($state.Offset -ge $JsonText.Length) { throw 'protocol' }
    $character = $JsonText[$state.Offset]
    if ($character -eq '"') { [void](Read-JsonString); return }
    if ($character -eq '{') {
      $state.Offset += 1
      Skip-JsonWhitespace
      $keys = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
      if ($state.Offset -lt $JsonText.Length -and $JsonText[$state.Offset] -eq '}') { $state.Offset += 1; return }
      while ($true) {
        Skip-JsonWhitespace
        $key = Read-JsonString
        if (-not $keys.Add($key)) { throw 'protocol' }
        Skip-JsonWhitespace
        if ($state.Offset -ge $JsonText.Length -or $JsonText[$state.Offset] -ne ':') { throw 'protocol' }
        $state.Offset += 1
        Read-JsonValue
        Skip-JsonWhitespace
        if ($state.Offset -ge $JsonText.Length) { throw 'protocol' }
        $delimiter = $JsonText[$state.Offset]
        $state.Offset += 1
        if ($delimiter -eq '}') { return }
        if ($delimiter -ne ',') { throw 'protocol' }
      }
    }
    if ($character -eq '[') {
      $state.Offset += 1
      Skip-JsonWhitespace
      if ($state.Offset -lt $JsonText.Length -and $JsonText[$state.Offset] -eq ']') { $state.Offset += 1; return }
      while ($true) {
        Read-JsonValue
        Skip-JsonWhitespace
        if ($state.Offset -ge $JsonText.Length) { throw 'protocol' }
        $delimiter = $JsonText[$state.Offset]
        $state.Offset += 1
        if ($delimiter -eq ']') { return }
        if ($delimiter -ne ',') { throw 'protocol' }
      }
    }
    $match = [Text.RegularExpressions.Regex]::Match($JsonText.Substring($state.Offset), '\A(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)')
    if (-not $match.Success) { throw 'protocol' }
    $state.Offset += $match.Length
  }
  Read-JsonValue
  Skip-JsonWhitespace
  if ($state.Offset -ne $JsonText.Length) { throw 'protocol' }
}

function Is-JsonInteger($Value) {
  return $Value -is [int] -or $Value -is [long] -or $Value -is [uint32] -or $Value -is [uint64]
}

function Read-ControllerRequest {
  if ($RequestBase64.Length -le 0 -or $RequestBase64.Length -gt 131072 -or $RequestBase64 -notmatch '^[A-Za-z0-9+/]+={0,2}$') { throw 'protocol' }
  $bytes = [Convert]::FromBase64String($RequestBase64)
  if ($bytes.Length -le 0 -or $bytes.Length -gt 65536) { throw 'protocol' }
  $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
  if (-not $text.EndsWith([string][char]10) -or $text.Substring(0, $text.Length - 1).Contains([char]10)) { throw 'protocol' }
  Assert-NoDuplicateJsonKeys $text.Substring(0, $text.Length - 1)
  $request = $text | ConvertFrom-Json
  if (-not (Exact-Keys $request @('schemaVersion','id','controllerCandidate','programFilesCandidate','executable','argv','cwd','environment','criticalInputs','trees','timeoutMs','stdoutLimit','stderrLimit'))) { throw 'protocol' }
  if (-not (Is-JsonInteger $request.schemaVersion) -or $request.schemaVersion -ne 1 -or -not (Is-JsonInteger $request.timeoutMs) -or $request.timeoutMs -lt 1 -or $request.timeoutMs -gt 900000 -or -not (Is-JsonInteger $request.stdoutLimit) -or $request.stdoutLimit -lt 1 -or $request.stdoutLimit -gt 4194304 -or -not (Is-JsonInteger $request.stderrLimit) -or $request.stderrLimit -lt 1 -or $request.stderrLimit -gt 1048576) { throw 'protocol' }
  if ($request.id -isnot [string] -or $request.controllerCandidate -isnot [string] -or $request.programFilesCandidate -isnot [string] -or $request.executable -isnot [string] -or $request.cwd -isnot [string] -or $request.argv -isnot [Array] -or $request.criticalInputs -isnot [Array] -or $request.trees -isnot [Array] -or $null -eq $request.environment -or $request.environment -is [Array]) { throw 'protocol' }
  Assert-SafeText ([string]$request.id) 80
  Assert-SafeText ([string]$request.controllerCandidate) 32767
  Assert-SafeText ([string]$request.programFilesCandidate) 32767
  Assert-SafeText ([string]$request.executable) 32767
  Assert-SafeText ([string]$request.cwd) 32767
  if (@($request.argv).Count -gt 64 -or @($request.criticalInputs).Count -gt 64 -or @($request.trees).Count -gt 4) { throw 'protocol' }
  foreach ($argument in @($request.argv)) { if ($argument -isnot [string]) { throw 'protocol' }; Assert-SafeText ([string]$argument) 32767 }
  $environmentNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $blockedEnvironmentNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($blockedName in @('SYSTEMROOT','WINDIR','COMSPEC','PATH','PATHEXT','NODE_OPTIONS','NODE_PATH','PSMODULEPATH','TEMP','TMP','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','PROGRAMFILES')) { [void]$blockedEnvironmentNames.Add($blockedName) }
  foreach ($property in $request.environment.PSObject.Properties) { if ($property.Value -isnot [string] -or $blockedEnvironmentNames.Contains($property.Name)) { throw 'protocol' }; Assert-SafeText $property.Name 128; Assert-SafeText ([string]$property.Value) 32767; if (-not $environmentNames.Add($property.Name)) { throw 'protocol' } }
  $executableInputCount = 0
  $criticalInputPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($input in @($request.criticalInputs)) {
    if (-not (Exact-Keys $input @('path','boundary','sha256','protected')) -or $input.path -isnot [string] -or $input.boundary -isnot [string] -or $input.sha256 -isnot [string] -or $input.protected -isnot [bool] -or $input.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'protocol' }
    Assert-SafeText ([string]$input.path) 32767
    Assert-SafeText ([string]$input.boundary) 32767
    if (-not $criticalInputPaths.Add([IO.Path]::GetFullPath([string]$input.path))) { throw 'protocol' }
    if ([IO.Path]::GetFullPath([string]$input.path).Equals([IO.Path]::GetFullPath([string]$request.executable), [StringComparison]::OrdinalIgnoreCase)) { $executableInputCount += 1 }
  }
  if ($executableInputCount -ne 1) { throw 'protocol' }
  $treeRoots = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($tree in @($request.trees)) {
    if (-not (Exact-Keys $tree @('root','selected','fileCount','totalBytes','treeSha256','protected')) -or $tree.root -isnot [string] -or $tree.selected -isnot [Array] -or -not (Is-JsonInteger $tree.fileCount) -or $tree.fileCount -lt 1 -or -not (Is-JsonInteger $tree.totalBytes) -or $tree.totalBytes -lt 1 -or $tree.treeSha256 -isnot [string] -or $tree.protected -isnot [bool] -or $tree.treeSha256 -notmatch '^[a-f0-9]{64}$') { throw 'protocol' }
    Assert-SafeText ([string]$tree.root) 32767
    if (-not $treeRoots.Add([IO.Path]::GetFullPath([string]$tree.root))) { throw 'protocol' }
    $selectedMembers = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($selected in @($tree.selected)) { if ($selected -isnot [string] -or [IO.Path]::IsPathRooted($selected) -or $selected.Split(@('/','\'), [StringSplitOptions]::RemoveEmptyEntries) -contains '..' -or -not $selectedMembers.Add([string]$selected)) { throw 'protocol' }; Assert-SafeText ([string]$selected) 32767 }
  }
  return $request
}

$api = $null
$outerJob = [IntPtr]::Zero
$innerJob = [IntPtr]::Zero
$processHandle = [IntPtr]::Zero
$threadHandle = [IntPtr]::Zero
  $held = [Collections.Generic.List[object]]::new()
$outStream = $null
$errStream = $null
$targetCreated = $false
$targetAssigned = $false
$innerZero = $false
$outerArmed = $false
$category = 'execution'

try {
  $request = Read-ControllerRequest
  $api = New-NativeApi
  if ([IntPtr]::Size -ne 8) { throw 'architecture' }
  $systemDirectory = Get-SystemDirectory $api
  $programFiles = Get-ProgramFilesDirectory $api
  $actualHost = [IO.Path]::GetFullPath([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
  $expectedHost = [IO.Path]::Combine($systemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (-not $actualHost.Equals($expectedHost, [StringComparison]::OrdinalIgnoreCase) -or -not $actualHost.Equals([IO.Path]::GetFullPath($request.controllerCandidate), [StringComparison]::OrdinalIgnoreCase) -or -not $programFiles.Equals([IO.Path]::GetFullPath($request.programFilesCandidate), [StringComparison]::OrdinalIgnoreCase)) { throw 'trust-root' }
  Assert-NonReparsePath $actualHost $systemDirectory $true | Out-Null
  Assert-ProtectedAcl $api $actualHost
  Assert-NonReparsePath $programFiles $programFiles $false | Out-Null
  Assert-ProtectedAcl $api $programFiles

  foreach ($input in @($request.criticalInputs)) {
    $bound = Open-BoundFile $api ([string]$input.path) ([string]$input.boundary) ([string]$input.sha256) ([bool]$input.protected)
    $held.Add($bound)
  }
  foreach ($tree in @($request.trees)) { Assert-Tree $api $tree }

  $outerJob = New-KillOnCloseJob $api
  $outerArmed = $true
  if (-not $api::AssignProcessToJobObject($outerJob, [Diagnostics.Process]::GetCurrentProcess().Handle)) { throw 'outer-assignment' }
  $innerJob = New-KillOnCloseJob $api

  foreach ($bound in $held) { Assert-BoundFile $api $bound }

  $stdinPipe = New-InheritablePipe $api
  $stdoutPipe = New-InheritablePipe $api
  $stderrPipe = New-InheritablePipe $api
  if (-not $api::SetHandleInformation($stdinPipe.Write, $HANDLE_FLAG_INHERIT, 0) -or -not $api::SetHandleInformation($stdoutPipe.Read, $HANDLE_FLAG_INHERIT, 0) -or -not $api::SetHandleInformation($stderrPipe.Read, $HANDLE_FLAG_INHERIT, 0)) { throw 'pipe' }

  $startup = [Runtime.InteropServices.Marshal]::AllocHGlobal(112)
  $processInfo = [Runtime.InteropServices.Marshal]::AllocHGlobal(24)
  $environmentBlock = [IntPtr]::Zero
  $attributeList = [IntPtr]::Zero
  $attributeHandles = [IntPtr]::Zero
  $attributeInitialized = $false
  try {
    [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] 112), 0, $startup, 112)
    [Runtime.InteropServices.Marshal]::WriteInt32($startup, 0, 112)
    [Runtime.InteropServices.Marshal]::WriteInt32($startup, 60, $STARTF_USESTDHANDLES)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($startup, 80, $stdinPipe.Read)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($startup, 88, $stdoutPipe.Write)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($startup, 96, $stderrPipe.Write)
    $attributeSize = [UIntPtr]::Zero
    [void]$api::InitializeProcThreadAttributeList([IntPtr]::Zero, 1, 0, [ref]$attributeSize)
    if ($attributeSize -eq [UIntPtr]::Zero) { throw 'attribute-list' }
    $attributeList = [Runtime.InteropServices.Marshal]::AllocHGlobal([int64]$attributeSize.ToUInt64())
    if (-not $api::InitializeProcThreadAttributeList($attributeList, 1, 0, [ref]$attributeSize)) { throw 'attribute-list' }
    $attributeInitialized = $true
    $attributeHandleBytes = [uint64](3 * [IntPtr]::Size)
    $attributeHandles = [Runtime.InteropServices.Marshal]::AllocHGlobal([int64]$attributeHandleBytes)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($attributeHandles, 0, $stdinPipe.Read)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($attributeHandles, 8, $stdoutPipe.Write)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($attributeHandles, 16, $stderrPipe.Write)
    if (-not $api::UpdateProcThreadAttribute($attributeList, 0, $PROC_THREAD_ATTRIBUTE_HANDLE_LIST, $attributeHandles, [UIntPtr]::new($attributeHandleBytes), [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'attribute-list' }
    [Runtime.InteropServices.Marshal]::WriteIntPtr($startup, 104, $attributeList)
    [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] 24), 0, $processInfo, 24)

    $environment = [ordered]@{ SystemRoot = [IO.Directory]::GetParent($systemDirectory).FullName; WINDIR = [IO.Directory]::GetParent($systemDirectory).FullName; COMSPEC = [IO.Path]::Combine($systemDirectory, 'cmd.exe'); LANG = 'C'; LC_ALL = 'C' }
    foreach ($property in $request.environment.PSObject.Properties) { $environment[$property.Name] = [string]$property.Value }
    $environmentBlock = New-EnvironmentBlock ([PSCustomObject]$environment)
    $commandLine = [Text.StringBuilder]::new((ConvertTo-WindowsArgument ([string]$request.executable)) + ' ' + ((@($request.argv) | ForEach-Object { ConvertTo-WindowsArgument ([string]$_) }) -join ' '))
    $flags = $CREATE_SUSPENDED -bor $CREATE_UNICODE_ENVIRONMENT -bor $CREATE_NO_WINDOW -bor $EXTENDED_STARTUPINFO_PRESENT
    if (-not $api::CreateProcessW([string]$request.executable, $commandLine, [IntPtr]::Zero, [IntPtr]::Zero, $true, $flags, $environmentBlock, [string]$request.cwd, $startup, $processInfo)) { throw 'spawn' }
    $processHandle = [Runtime.InteropServices.Marshal]::ReadIntPtr($processInfo, 0)
    $threadHandle = [Runtime.InteropServices.Marshal]::ReadIntPtr($processInfo, 8)
    $targetCreated = $true
  } finally {
    if ($environmentBlock -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($environmentBlock) }
    if ($attributeInitialized) { $api::DeleteProcThreadAttributeList($attributeList) }
    if ($attributeHandles -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($attributeHandles) }
    if ($attributeList -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($attributeList) }
    [Runtime.InteropServices.Marshal]::FreeHGlobal($startup)
    [Runtime.InteropServices.Marshal]::FreeHGlobal($processInfo)
    [void]$api::CloseHandle($stdinPipe.Read)
    [void]$api::CloseHandle($stdinPipe.Write)
    [void]$api::CloseHandle($stdoutPipe.Write)
    [void]$api::CloseHandle($stderrPipe.Write)
  }

  if (-not $api::AssignProcessToJobObject($innerJob, $processHandle)) {
    [void]$api::TerminateProcess($processHandle, 1)
    [void]$api::WaitForSingleObject($processHandle, 10000)
    throw 'inner-assignment'
  }
  $targetAssigned = $true
  if ($api::ResumeThread($threadHandle) -eq 0xffffffff) { throw 'resume' }
  [void]$api::CloseHandle($threadHandle); $threadHandle = [IntPtr]::Zero

  $outSafe = [Microsoft.Win32.SafeHandles.SafeFileHandle]::new($stdoutPipe.Read, $true)
  $errSafe = [Microsoft.Win32.SafeHandles.SafeFileHandle]::new($stderrPipe.Read, $true)
  $outStream = [IO.FileStream]::new($outSafe, [IO.FileAccess]::Read, 4096, $false)
  $errStream = [IO.FileStream]::new($errSafe, [IO.FileAccess]::Read, 4096, $false)
  $outMemory = [IO.MemoryStream]::new()
  $errCount = [int64]0
  $outBuffer = New-Object byte[] 4096
  $errBuffer = New-Object byte[] 4096
  $outTask = $outStream.ReadAsync($outBuffer, 0, $outBuffer.Length)
  $errTask = $errStream.ReadAsync($errBuffer, 0, $errBuffer.Length)
  $outClosed = $false; $errClosed = $false
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $failure = $null
  while ($true) {
    if ($null -eq $failure -and $watch.ElapsedMilliseconds -gt [int64]$request.timeoutMs) { $failure = 'timeout' }
    if ($outTask.IsCompleted) {
      $read = $outTask.GetAwaiter().GetResult()
      if ($read -eq 0) { $outClosed = $true } else { if ($outMemory.Length + $read -gt [int64]$request.stdoutLimit) { if ($null -eq $failure) { $failure = 'output-limit' } } else { $outMemory.Write($outBuffer, 0, $read) }; $outTask = $outStream.ReadAsync($outBuffer, 0, $outBuffer.Length) }
    }
    if ($errTask.IsCompleted) {
      $read = $errTask.GetAwaiter().GetResult()
      if ($read -eq 0) { $errClosed = $true } else { if ($errCount + $read -gt [int64]$request.stderrLimit) { if ($null -eq $failure) { $failure = 'output-limit' } } else { $errCount += $read }; $errTask = $errStream.ReadAsync($errBuffer, 0, $errBuffer.Length) }
    }
    $processExited = $api::WaitForSingleObject($processHandle, 0) -eq $WAIT_OBJECT_0
    $active = Get-JobActiveCount $api $innerJob
    if ($null -ne $failure) { break }
    if ($processExited -and $outClosed -and $errClosed -and $active -eq 0) { break }
    Start-Sleep -Milliseconds 5
  }

  if ($null -ne $failure) {
    $category = $failure
    $cleanupWatch = [Diagnostics.Stopwatch]::StartNew()
    if (-not $api::TerminateJobObject($innerJob, 1)) { throw 'terminate-job' }
    $remaining = [Math]::Max(0, 10000 - [int]$cleanupWatch.ElapsedMilliseconds)
    if ($remaining -eq 0 -or $api::WaitForSingleObject($processHandle, [uint32]$remaining) -ne $WAIT_OBJECT_0) { throw 'cleanup' }
    while ((-not $outClosed -or -not $errClosed -or (Get-JobActiveCount $api $innerJob) -ne 0) -and $cleanupWatch.ElapsedMilliseconds -lt 10000) {
      if (-not $outClosed -and $outTask.IsCompleted) { $read = $outTask.GetAwaiter().GetResult(); if ($read -eq 0) { $outClosed = $true } else { $outTask = $outStream.ReadAsync($outBuffer, 0, $outBuffer.Length) } }
      if (-not $errClosed -and $errTask.IsCompleted) { $read = $errTask.GetAwaiter().GetResult(); if ($read -eq 0) { $errClosed = $true } else { $errTask = $errStream.ReadAsync($errBuffer, 0, $errBuffer.Length) } }
      Start-Sleep -Milliseconds 5
    }
    if (-not $outClosed -or -not $errClosed -or (Get-JobActiveCount $api $innerJob) -ne 0) { throw 'cleanup' }
    $innerZero = $true
    if ((Get-JobActiveCount $api $outerJob) -ne 1) { throw 'outer-members' }
    Set-JobKillOnClose $api $outerJob $false
    $outerArmed = $false
    [Console]::Out.Write(([ordered]@{ schemaVersion = 1; status = 'FAIL'; category = $category; cleanupConfirmed = $true } | ConvertTo-Json -Compress) + [char]10)
    exit 1
  }

  $innerZero = $true
  $exitCode = [uint32]0
  if (-not $api::GetExitCodeProcess($processHandle, [ref]$exitCode)) { throw 'exit-code' }
  foreach ($tree in @($request.trees)) { Assert-Tree $api $tree }
  foreach ($bound in $held) { Assert-BoundFile $api $bound }
  if ((Get-JobActiveCount $api $outerJob) -ne 1) { throw 'outer-members' }
  Set-JobKillOnClose $api $outerJob $false
  $outerArmed = $false
  [Console]::Out.Write(([ordered]@{ schemaVersion = 1; status = 'PASS'; exitCode = [int64]$exitCode; stdout = [Convert]::ToBase64String($outMemory.ToArray()); cleanupConfirmed = $true } | ConvertTo-Json -Compress) + [char]10)
  exit 0
} catch {
  if ($targetAssigned -and $innerJob -ne [IntPtr]::Zero) {
    try {
      if (-not $api::TerminateJobObject($innerJob, 1)) { throw 'terminate-job' }
      if ($processHandle -ne [IntPtr]::Zero -and $api::WaitForSingleObject($processHandle, 10000) -ne $WAIT_OBJECT_0) { throw 'cleanup' }
    } catch { }
  } elseif ($targetCreated -and $processHandle -ne [IntPtr]::Zero) {
    try {
      if (-not $api::TerminateProcess($processHandle, 1)) { throw 'terminate-process' }
      if ($api::WaitForSingleObject($processHandle, 10000) -ne $WAIT_OBJECT_0) { throw 'cleanup' }
    } catch { }
  }
  # Generic exceptions never produce a cleanup receipt and never disarm the
  # outer Job. Closing its final handle is the fail-closed recovery path.
  exit 1
} finally {
  if ($null -ne $outStream) { $outStream.Dispose() }
  if ($null -ne $errStream) { $errStream.Dispose() }
  foreach ($bound in $held) { $bound.Stream.Dispose() }
  if ($threadHandle -ne [IntPtr]::Zero -and $null -ne $api) { [void]$api::CloseHandle($threadHandle) }
  if ($processHandle -ne [IntPtr]::Zero -and $null -ne $api) { [void]$api::CloseHandle($processHandle) }
  if ($innerJob -ne [IntPtr]::Zero -and $null -ne $api) { [void]$api::CloseHandle($innerJob) }
  if ($outerJob -ne [IntPtr]::Zero -and $null -ne $api) { [void]$api::CloseHandle($outerJob) }
}
`
/* WORKBENCH_RELEASE_CONTROLLER_V1_END */

const CONTROLLER_BYTES = Buffer.from(CONTROLLER_SOURCE, 'utf8')
const CONTROLLER_SHA256 = sha256Bytes(CONTROLLER_BYTES)
const CONTROLLER_BASE64 = CONTROLLER_BYTES.toString('base64')
const LOADER_SOURCE = String.raw`
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false, $true), $false, 4096, $false)
  $characters = New-Object char[] 4096
  $textBuilder = [Text.StringBuilder]::new()
  while (($count = $reader.Read($characters, 0, $characters.Length)) -gt 0) {
    if ($textBuilder.Length + $count -gt 262144) { throw 'loader-protocol' }
    [void]$textBuilder.Append($characters, 0, $count)
  }
  if ($textBuilder.Length -le 0) { throw 'loader-protocol' }
  $text = $textBuilder.ToString()
  $pattern = '\A\{"schemaVersion":1,"controllerBase64":"([A-Za-z0-9+/]+={0,2})","controllerByteLength":([1-9][0-9]{0,5}),"controllerSha256":"([a-f0-9]{64})","requestBase64":"([A-Za-z0-9+/]+={0,2})","requestByteLength":([1-9][0-9]{0,5}),"requestSha256":"([a-f0-9]{64})"\}\n\z'
  $match = [Text.RegularExpressions.Regex]::Match($text, $pattern, [Text.RegularExpressions.RegexOptions]::CultureInvariant)
  if (-not $match.Success -or $match.Groups[3].Value -ne '${CONTROLLER_SHA256}') { throw 'loader-protocol' }
  $controllerBytes = [Convert]::FromBase64String($match.Groups[1].Value)
  if ($controllerBytes.Length -le 0 -or $controllerBytes.Length -gt 65536 -or $controllerBytes.Length -ne [int]$match.Groups[2].Value -or [Convert]::ToBase64String($controllerBytes) -cne $match.Groups[1].Value) { throw 'loader-protocol' }
  $controllerText = [Text.UTF8Encoding]::new($false, $true).GetString($controllerBytes)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { $actualHash = ([BitConverter]::ToString($algorithm.ComputeHash($controllerBytes))).Replace('-', '').ToLowerInvariant() } finally { $algorithm.Dispose() }
  if ($actualHash -ne '${CONTROLLER_SHA256}') { throw 'loader-protocol' }
  $requestBytes = [Convert]::FromBase64String($match.Groups[4].Value)
  if ($requestBytes.Length -le 0 -or $requestBytes.Length -gt 65536 -or $requestBytes.Length -ne [int]$match.Groups[5].Value -or [Convert]::ToBase64String($requestBytes) -cne $match.Groups[4].Value) { throw 'loader-protocol' }
  [void][Text.UTF8Encoding]::new($false, $true).GetString($requestBytes)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { $requestHash = ([BitConverter]::ToString($algorithm.ComputeHash($requestBytes))).Replace('-', '').ToLowerInvariant() } finally { $algorithm.Dispose() }
  if ($requestHash -ne $match.Groups[6].Value) { throw 'loader-protocol' }
  $controller = [ScriptBlock]::Create($controllerText)
  & $controller $match.Groups[4].Value
} catch {
  [Console]::Error.WriteLine('Trusted release controller loader failed.')
  exit 1
}
`
const ENCODED_LOADER = Buffer.from(LOADER_SOURCE, 'utf16le').toString('base64')

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function assertNonReparsePath(target, boundary, requireFile) {
  const absoluteTarget = path.resolve(target)
  const absoluteBoundary = path.resolve(boundary)
  const relative = path.relative(absoluteBoundary, absoluteTarget)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('containment')
  let current = absoluteBoundary
  const components = relative === '' ? [] : relative.split(path.sep)
  for (const component of components) {
    current = path.join(current, component)
    const stat = await fs.lstat(current)
    if (stat.isSymbolicLink()) throw new Error('reparse')
  }
  const final = await fs.lstat(absoluteTarget)
  if (final.isSymbolicLink() || (requireFile ? !final.isFile() : !final.isDirectory())) throw new Error('ordinary')
  const real = await fs.realpath(absoluteTarget)
  if (path.resolve(real).toLowerCase() !== absoluteTarget.toLowerCase()) throw new Error('canonical')
  return absoluteTarget
}

async function openBoundFile(target, boundary, expectedHash) {
  const absolute = await assertNonReparsePath(target, boundary, true)
  const handle = await fs.open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat()
    const bytes = await handle.readFile()
    const pathStat = await fs.lstat(absolute)
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || before.dev !== pathStat.dev || before.ino !== pathStat.ino || sha256Bytes(bytes) !== expectedHash) throw new Error('identity')
    return { path: absolute, boundary: path.resolve(boundary), expectedHash, handle, dev: before.dev, ino: before.ino }
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function recheckBoundFile(bound) {
  await assertNonReparsePath(bound.path, bound.boundary, true)
  const held = await bound.handle.stat()
  const short = await fs.open(bound.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const current = await short.stat()
    const bytes = await short.readFile()
    if (held.dev !== bound.dev || held.ino !== bound.ino || current.dev !== bound.dev || current.ino !== bound.ino || sha256Bytes(bytes) !== bound.expectedHash) throw new Error('identity')
  } finally {
    await short.close()
  }
}

async function resolveCaseFoldedWorkspaceFile(relativePath) {
  if (typeof relativePath !== 'string' || path.posix.isAbsolute(relativePath)
      || relativePath.includes('\\')
      || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('identity')
  let current = WORKSPACE_ROOT
  for (const expected of relativePath.split('/')) {
    const entries = await fs.readdir(current, { withFileTypes: true })
    const matches = entries.filter((entry) => entry.name.toLowerCase() === expected.toLowerCase())
    if (matches.length !== 1) throw new Error('identity')
    current = path.join(current, matches[0].name)
  }
  await assertNonReparsePath(current, WORKSPACE_ROOT, true)
  return current
}

function programFilesRoot() {
  return 'C:\\Program Files'
}

function system32Root() {
  return 'C:\\Windows\\System32'
}

function lifecyclePayload(policy, id) {
  const payload = policy.dependencyBootstrap.lifecyclePayloads.find((row) => row.id === id)
  if (!payload) throw new Error('descriptor')
  return payload
}

const RELEASE_METADATA_PATH = path.join(
  WORKSPACE_ROOT,
  'release-validation',
  'staging',
  'release-metadata.json',
)
const RELEASE_METADATA_KEYS = [
  'appId', 'arch', 'branch', 'buildId', 'buildTimeUtc', 'channel', 'commitSha', 'commitShort', 'dirty',
  'electronVersion', 'lockfileSha256', 'metadataSchemaVersion', 'nodeVersion', 'npmVersion', 'platform',
  'productName', 'purpose', 'releaseNotesSha256', 'sqliteSchemaVersion', 'version',
]
const UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u

function validateReleaseMetadataForChild(metadata) {
  const canonicalTime = typeof metadata?.buildTimeUtc === 'string'
    && UTC_SECONDS.test(metadata.buildTimeUtc)
    && new Date(metadata.buildTimeUtc).toISOString().replace('.000Z', 'Z') === metadata.buildTimeUtc
  const epoch = canonicalTime ? Date.parse(metadata.buildTimeUtc) / 1000 : Number.NaN
  const valid = exactObject(metadata, RELEASE_METADATA_KEYS)
    && metadata.metadataSchemaVersion === 1
    && metadata.purpose === 'candidate'
    && metadata.productName === 'Claude Workbench'
    && metadata.appId === 'com.claudeworkbench.app'
    && metadata.version === '1.0.1-rc.1'
    && metadata.channel === 'rc'
    && metadata.branch === 'task15'
    && COMMIT_SHA.test(metadata.commitSha)
    && /^[a-f0-9]{7,16}$/u.test(metadata.commitShort)
    && metadata.commitSha.startsWith(metadata.commitShort)
    && metadata.dirty === false
    && canonicalTime
    && Number.isSafeInteger(epoch)
    && epoch >= 946_684_800
    && /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(metadata.nodeVersion)
    && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(metadata.npmVersion)
    && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(metadata.electronVersion)
    && metadata.sqliteSchemaVersion === 7
    && metadata.platform === 'win32'
    && metadata.arch === 'x64'
    && SHA256.test(metadata.lockfileSha256)
    && SHA256.test(metadata.releaseNotesSha256)
    && metadata.buildId === `${metadata.version}+${metadata.commitShort}.${metadata.buildTimeUtc.replace(/[-:]/gu, '')}`
  if (!valid) throw new Error('release-metadata')
  return { epoch: String(epoch) }
}

async function readFrozenReleaseMetadata() {
  const absolute = await assertNonReparsePath(RELEASE_METADATA_PATH, WORKSPACE_ROOT, true)
  const handle = await fs.open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat()
    const bytes = await handle.readFile()
    if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw new Error('release-metadata')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    rejectDuplicateJsonKeys(text)
    const facts = validateReleaseMetadataForChild(JSON.parse(text))
    const current = await fs.lstat(absolute)
    if (!current.isFile() || current.isSymbolicLink() || before.dev !== current.dev || before.ino !== current.ino) {
      throw new Error('release-metadata')
    }
    return { path: absolute, sha256: sha256Bytes(bytes), epoch: facts.epoch }
  } finally {
    await handle.close()
  }
}

async function resolveReleaseBuildEnvironment(row, criticalInputs) {
  const values = Object.values(row.environment)
  const needsMetadata = values.includes('@fixed-release-metadata') || values.includes('@release-metadata-epoch')
  if (!needsMetadata) return { ...row.environment }
  const metadata = await readFrozenReleaseMetadata()
  criticalInputs.push({
    path: metadata.path,
    boundary: WORKSPACE_ROOT,
    sha256: metadata.sha256,
    protected: false,
  })
  const environment = Object.fromEntries(Object.entries(row.environment).map(([name, value]) => [
    name,
    value === '@fixed-release-metadata'
      ? metadata.path
      : value === '@release-metadata-epoch'
        ? metadata.epoch
        : value,
  ]))
  if (Object.values(environment).some((value) => value.startsWith('@'))) throw new Error('release-metadata')
  return environment
}

async function resolveDescriptor(row, policy, privateMainPath) {
  const programFiles = programFilesRoot()
  const node = path.win32.join(programFiles, policy.node.programFilesRelativePath)
  const npmRoot = path.win32.join(programFiles, policy.npm.programFilesRelativeRoot)
  const npmCli = path.win32.join(npmRoot, 'bin', 'npm-cli.js')
  const gitRoot = path.win32.join(programFiles, policy.git.programFilesRelativeRoot)
  const git = path.win32.join(gitRoot, 'cmd', 'git.exe')
  const electron = path.join(WORKSPACE_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  let executable = node
  let argv = [...row.argv]
  let cwd = WORKSPACE_ROOT
  const criticalInputs = []
  const trees = []

  const lifecyclePayloadIds = {
    'electron-lifecycle': 'electron-install',
    'esbuild-lifecycle': 'esbuild-install',
    'electron-winstaller-lifecycle': 'electron-winstaller-select-7z',
  }

  const executableClassesByClosure = {
    node: ['node'],
    npm: ['npm'],
    git: ['git', 'git-private-main'],
    'electron-lifecycle': ['node-lifecycle'],
    'esbuild-lifecycle': ['node-lifecycle'],
    'electron-winstaller-lifecycle': ['node-lifecycle'],
    'workspace-final': ['node-workspace'],
    'electron-final': ['electron-workspace'],
  }
  if (!Object.hasOwn(executableClassesByClosure, row.closureClass)
      || !executableClassesByClosure[row.closureClass].includes(row.executableClass)) throw new Error('descriptor')

  if (row.cwdClass === 'candidate') {
    if (row.executableClass === 'git-private-main' || row.executableClass === 'node-lifecycle') throw new Error('descriptor')
  } else if (row.cwdClass === 'private-main') {
    if (row.executableClass !== 'git-private-main' || typeof privateMainPath !== 'string') throw new Error('private-main')
    cwd = privateMainPath
  } else if (!row.cwdClass.startsWith('package:') || row.executableClass !== 'node-lifecycle') {
    throw new Error('descriptor')
  }

  criticalInputs.push({ path: node, boundary: programFiles, sha256: policy.node.sha256, protected: true })
  criticalInputs.push({ path: path.win32.join(system32Root(), policy.windowsController.cmdSystem32RelativePath), boundary: system32Root(), sha256: policy.windowsController.cmdSha256, protected: true })

  if (row.executableClass === 'npm') {
    argv = [npmCli, ...argv]
    criticalInputs.push({ path: npmCli, boundary: programFiles, sha256: sha256Bytes(await fs.readFile(npmCli)), protected: true })
    trees.push({
      root: npmRoot,
      selected: [''],
      fileCount: policy.npm.fileCount,
      totalBytes: policy.npm.totalBytes,
      treeSha256: policy.npm.treeSha256,
      protected: true,
    })
  } else if (row.executableClass === 'git' || row.executableClass === 'git-private-main') {
    executable = git
    criticalInputs.splice(0, 1, { path: git, boundary: programFiles, sha256: sha256Bytes(await fs.readFile(git)), protected: true })
    trees.push({ root: gitRoot, selected: policy.git.criticalRelativePaths, fileCount: policy.git.fileCount, totalBytes: policy.git.totalBytes, treeSha256: policy.git.treeSha256, protected: true })
  } else if (row.executableClass === 'electron-workspace') {
    executable = electron
    criticalInputs.splice(0, 1, { path: electron, boundary: WORKSPACE_ROOT, sha256: policy.dependencyBootstrap.electronExecutableSha256, protected: false })
    const entry = path.join(WORKSPACE_ROOT, argv[0])
    criticalInputs.push({ path: entry, boundary: WORKSPACE_ROOT, sha256: sha256Bytes(await fs.readFile(entry)), protected: false })
    argv[0] = entry
  } else if (row.executableClass === 'node-workspace') {
    const entry = row.id === 'test-full'
      ? await resolveCaseFoldedWorkspaceFile(argv[0])
      : path.join(WORKSPACE_ROOT, argv[0])
    criticalInputs.push({ path: entry, boundary: WORKSPACE_ROOT, sha256: sha256Bytes(await fs.readFile(entry)), protected: false })
    argv[0] = entry
  } else if (row.executableClass === 'node-lifecycle') {
    const payloadId = lifecyclePayloadIds[row.closureClass]
    const payload = lifecyclePayload(policy, payloadId)
    if (row.cwdClass !== `package:${payload.workingDirectoryRelativePath}`) throw new Error('descriptor')
    const entry = path.join(WORKSPACE_ROOT, 'node_modules', payload.entryRelativePath)
    cwd = path.join(WORKSPACE_ROOT, 'node_modules', payload.workingDirectoryRelativePath)
    argv = [entry, ...payload.arguments]
    criticalInputs.push({ path: entry, boundary: WORKSPACE_ROOT, sha256: payload.entrySha256, protected: false })
  }

  if (row.closureClass === 'workspace-final' || row.closureClass === 'electron-final') {
    trees.push({
      root: path.join(WORKSPACE_ROOT, 'node_modules'),
      selected: [''],
      fileCount: policy.dependencyBootstrap.finalTree.fileCount,
      totalBytes: policy.dependencyBootstrap.finalTree.totalBytes,
      treeSha256: policy.dependencyBootstrap.finalTree.treeSha256,
      protected: false,
    })
  }

  if (row.id === 'test-full') {
    for (const relativePath of [
      'vitest.config.ts',
      'scripts/release/vitest-preflight-reporter.mjs',
      'package.json',
      'tsconfig.json',
      'src/main/database/__tests__/Migration.test.ts',
      'src/main/database/__tests__/ReleaseMigration.test.ts',
      'src/main/database/__tests__/DatabaseLegacySafety.test.ts',
      'src/main/diagnostics/__tests__/DiagnosticsExporter.release.test.ts',
    ]) {
      const input = await resolveCaseFoldedWorkspaceFile(relativePath)
      criticalInputs.push({ path: input, boundary: WORKSPACE_ROOT, sha256: sha256Bytes(await fs.readFile(input)), protected: false })
    }
  }

  const environment = await resolveReleaseBuildEnvironment(row, criticalInputs)

  return {
    schemaVersion: 1,
    id: row.id,
    controllerCandidate: REVIEWED_POWERSHELL,
    programFilesCandidate: programFiles,
    executable,
    argv,
    cwd,
    environment,
    criticalInputs,
    trees,
    timeoutMs: row.timeoutMs,
    stdoutLimit: row.stdoutLimit,
    stderrLimit: row.stderrLimit,
  }
}

/* WORKBENCH_RELEASE_PARENT_ENGINE_V1_START */
async function runControllerProtocol(controller, requestLine, limits, retainedInputs) {
  const cleanupUnconfirmed = Object.freeze({ category: 'cleanup-unconfirmed' })
  if (!Buffer.isBuffer(requestLine)
      || requestLine.length === 0
      || !limits
      || !Number.isSafeInteger(limits.deadlineMs)
      || limits.deadlineMs < 1
      || !Number.isSafeInteger(limits.stdoutCapBytes)
      || limits.stdoutCapBytes < 1
      || !Number.isSafeInteger(limits.stderrCapBytes)
      || limits.stderrCapBytes < 1
      || !Array.isArray(retainedInputs)) return cleanupUnconfirmed

  return await new Promise((resolve) => {
    const listeners = []
    const stdoutChunks = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let forced = null
    let settled = false
    let killRequested = false
    let processError = false
    let processExited = false
    let processClosed = false
    let processExitCode = null
    let stdinFinished = false
    let stdinClosed = false
    let stdinFailed = false
    let stdinEndCalled = false
    let stdoutEnded = false
    let stdoutClosed = false
    let stdoutFailed = false
    let stderrEnded = false
    let stderrClosed = false
    let stderrFailed = false
    let writeCallbackComplete = false
    let drainComplete = true

    const listen = (emitter, event, handler, once = false) => {
      listeners.push([emitter, event, handler])
      emitter[once ? 'once' : 'on'](event, handler)
    }
    const removeListeners = () => {
      for (const [emitter, event, handler] of listeners.splice(0)) emitter.off(event, handler)
    }
    const forceTermination = (reason) => {
      if (forced === null) {
        forced = reason
        if (!killRequested) {
          killRequested = true
          try { controller.kill() } catch { }
        }
      }
    }

    const barrierComplete = () => {
      const processTerminal = processClosed && (processExited || processError)
      const stdinTerminal = stdinFinished || (stdinFailed && stdinClosed)
      const stdoutTerminal = stdoutClosed && (stdoutEnded || stdoutFailed)
      const stderrTerminal = stderrClosed && (stderrEnded || stderrFailed)
      return processTerminal && stdinTerminal && stdoutTerminal && stderrTerminal
    }
    const parseReceipt = () => {
      if (forced !== null || processError || stderrBytes !== 0) return cleanupUnconfirmed
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(stdoutChunks, stdoutBytes))
        if (!text.endsWith('\n') || text.includes('\r') || text.slice(0, -1).includes('\n')) return cleanupUnconfirmed
        const pass = /^\{"schemaVersion":1,"status":"PASS","exitCode":(0|[1-9][0-9]{0,9}),"stdout":"([A-Za-z0-9+/]*={0,2})","cleanupConfirmed":true\}\n$/u.exec(text)
        if (pass) {
          const exitCode = Number(pass[1])
          const payload = Buffer.from(pass[2], 'base64')
          if (processExitCode !== 0 || !Number.isSafeInteger(exitCode) || exitCode > 0xffff_ffff || payload.toString('base64') !== pass[2]) return cleanupUnconfirmed
          return Object.freeze({
            category: 'receipt',
            receipt: Object.freeze({ schemaVersion: 1, status: 'PASS', exitCode, stdout: pass[2], cleanupConfirmed: true }),
          })
        }
        const failure = /^\{"schemaVersion":1,"status":"FAIL","category":"(timeout|output-limit|execution)","cleanupConfirmed":true\}\n$/u.exec(text)
        if (!failure || processExitCode !== 1) return cleanupUnconfirmed
        return Object.freeze({
          category: 'receipt',
          receipt: Object.freeze({ schemaVersion: 1, status: 'FAIL', category: failure[1], cleanupConfirmed: true }),
        })
      } catch {
        return cleanupUnconfirmed
      }
    }
    const maybeSettle = async () => {
      if (settled || !barrierComplete()) return
      settled = true
      clearTimeout(deadline)
      removeListeners()
      let result = parseReceipt()
      for (const retained of retainedInputs) {
        try { await retained.close() } catch { result = cleanupUnconfirmed }
      }
      resolve(result)
    }
    const deadline = setTimeout(() => forceTermination('timeout'), limits.deadlineMs)

    listen(controller.stdout, 'data', (chunk) => {
      const bytes = Buffer.from(chunk)
      if (stdoutBytes + bytes.length > limits.stdoutCapBytes) forceTermination('stdout-limit')
      else {
        stdoutChunks.push(bytes)
        stdoutBytes += bytes.length
      }
    })
    listen(controller.stdout, 'end', () => { stdoutEnded = true; void maybeSettle() })
    listen(controller.stdout, 'error', () => { stdoutFailed = true; forceTermination('stdout'); void maybeSettle() })
    listen(controller.stdout, 'close', () => { stdoutClosed = true; void maybeSettle() })
    listen(controller.stderr, 'data', (chunk) => {
      stderrBytes += Buffer.byteLength(chunk)
      if (stderrBytes > limits.stderrCapBytes) forceTermination('stderr-limit')
    })
    listen(controller.stderr, 'end', () => { stderrEnded = true; void maybeSettle() })
    listen(controller.stderr, 'error', () => { stderrFailed = true; forceTermination('stderr'); void maybeSettle() })
    listen(controller.stderr, 'close', () => { stderrClosed = true; void maybeSettle() })
    listen(controller, 'error', () => { processError = true; forceTermination('spawn'); void maybeSettle() })
    listen(controller, 'exit', (code) => { processExited = true; processExitCode = code; void maybeSettle() })
    listen(controller, 'close', () => { processClosed = true; void maybeSettle() })
    listen(controller.stdin, 'error', () => { stdinFailed = true; forceTermination('stdin'); void maybeSettle() })
    listen(controller.stdin, 'finish', () => { stdinFinished = true; void maybeSettle() })
    listen(controller.stdin, 'close', () => {
      stdinClosed = true
      if (!stdinFinished) {
        stdinFailed = true
        forceTermination('stdin-close')
      }
      void maybeSettle()
    })

    const maybeEndInput = () => {
      if (stdinEndCalled || !writeCallbackComplete || !drainComplete) return
      stdinEndCalled = true
      try { controller.stdin.end() } catch {
        stdinFailed = true
        forceTermination('stdin-end')
      }
    }
    try {
      const accepted = controller.stdin.write(requestLine, (error) => {
        writeCallbackComplete = true
        if (error) {
          stdinFailed = true
          forceTermination('stdin-write')
        } else maybeEndInput()
      })
      if (accepted === false) {
        drainComplete = false
        listen(controller.stdin, 'drain', () => { drainComplete = true; maybeEndInput() }, true)
      } else if (accepted !== true) forceTermination('stdin-partial')
    } catch {
      stdinFailed = true
      forceTermination('stdin-write')
    }
  })
}
/* WORKBENCH_RELEASE_PARENT_ENGINE_V1_END */

function controllerStdoutLimit(childStdoutLimit) {
  return Math.ceil(childStdoutLimit / 3) * 4 + 4096
}

function createControllerEnvelope(request) {
  const requestBytes = Buffer.from(`${JSON.stringify(request)}\n`, 'utf8')
  if (requestBytes.length === 0 || requestBytes.length > 65_536) throw new Error('protocol')
  const envelope = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    controllerBase64: CONTROLLER_BASE64,
    controllerByteLength: CONTROLLER_BYTES.length,
    controllerSha256: CONTROLLER_SHA256,
    requestBase64: requestBytes.toString('base64'),
    requestByteLength: requestBytes.length,
    requestSha256: sha256Bytes(requestBytes),
  })}\n`, 'utf8')
  if (envelope.length === 0 || envelope.length > CONTROLLER_ENVELOPE_LIMIT) throw new Error('protocol')
  return envelope
}

async function runControllerParent(request, retainedHandles) {
  const controllerHandle = await openBoundFile(REVIEWED_POWERSHELL, system32Root(), '7600ffe12da441fe89d035b13801e8e91d064bc544a27b19a5cf49f6ab8b18f5')
  let protocolOwnsHandle = false
  try {
    for (const retained of retainedHandles) await recheckBoundFile(retained)
    await recheckBoundFile(controllerHandle)
    const envelope = createControllerEnvelope(request)
    if (ENCODED_LOADER.length + 256 >= WINDOWS_COMMAND_LINE_LIMIT) throw new Error('loader-command-line')
    const controller = spawn(REVIEWED_POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED_LOADER], {
      cwd: WORKSPACE_ROOT,
      env: { LANG: 'C', LC_ALL: 'C' },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    protocolOwnsHandle = true
    const protocol = await runControllerProtocol(controller, envelope, {
      deadlineMs: request.timeoutMs + CONTROLLER_CLEANUP_GRACE_MS,
      stdoutCapBytes: controllerStdoutLimit(request.stdoutLimit),
      stderrCapBytes: CONTROLLER_STDERR_LIMIT,
    }, [{ close: async () => controllerHandle.handle.close() }])
    if (protocol.category !== 'receipt') return deepFreeze({ status: 'FAIL', category: 'cleanup-unconfirmed' })
    const receipt = protocol.receipt
    if (receipt.status === 'FAIL') return deepFreeze({ status: 'FAIL', category: receipt.category })
    const stdout = Buffer.from(receipt.stdout, 'base64')
    if (stdout.length > request.stdoutLimit) return deepFreeze({ status: 'FAIL', category: 'cleanup-unconfirmed' })
    return { status: 'PASS', exitCode: receipt.exitCode, stdout }
  } catch {
    return deepFreeze({ status: 'FAIL', category: 'cleanup-unconfirmed' })
  } finally {
    if (!protocolOwnsHandle) {
      try { await controllerHandle.handle.close() } catch { }
    }
  }
}

function oneTrailingLine(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  if (!/^[^\r\n]*(?:\r?\n)?$/u.test(text)) throw new Error('output')
  return text.endsWith('\r\n') ? text.slice(0, -2) : text.endsWith('\n') ? text.slice(0, -1) : text
}

function parseStrictJsonObject(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  if (text.startsWith('\ufeff') || !text.endsWith('\n') || text.includes('\r') || text.slice(0, -1).includes('\n')) throw new Error('output')
  const json = text.slice(0, -1)
  if (json[0] !== '{' || json.at(-1) !== '}') throw new Error('output')
  rejectDuplicateJsonKeys(json)
  const value = JSON.parse(json)
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('output')
  return value
}

function parseVitestPreflightSummary(bytes) {
  const value = parseStrictJsonObject(bytes)
  const requiredOrder = ['migration', 'current-schema', 'future-schema', 'legacy-safety', 'sentinel-redaction', 'diagnostics-bounds']
  if (!exactObject(value, ['schemaVersion', 'status', 'tests', 'requiredCases'])
      || JSON.stringify(Object.keys(value)) !== JSON.stringify(['schemaVersion', 'status', 'tests', 'requiredCases'])
      || value.schemaVersion !== 1
      || !['PASS', 'FAIL'].includes(value.status)
      || !exactObject(value.tests, ['files', 'tests', 'passed', 'failed', 'skipped', 'todo'])
      || JSON.stringify(Object.keys(value.tests)) !== JSON.stringify(['files', 'tests', 'passed', 'failed', 'skipped', 'todo'])
      || !Object.values(value.tests).every((count) => Number.isSafeInteger(count) && count >= 0 && count <= 2_147_483_647)
      || value.tests.tests !== value.tests.passed + value.tests.failed + value.tests.skipped + value.tests.todo
      || !Array.isArray(value.requiredCases)
      || value.requiredCases.some((id, index) => id !== requiredOrder.filter((item) => value.requiredCases.includes(item))[index])
      || new Set(value.requiredCases).size !== value.requiredCases.length) throw new Error('output')
  const complete = value.requiredCases.length === requiredOrder.length
    && value.requiredCases.every((id, index) => id === requiredOrder[index])
  const passSemantics = value.tests.files >= 1 && value.tests.tests >= 1
    && value.tests.failed === 0 && value.tests.skipped === 0 && value.tests.todo === 0
    && value.tests.passed === value.tests.tests && complete
  if (value.status === 'PASS' && !passSemantics) throw new Error('output')
  return value
}

function parseNativeAbiSummary(bytes) {
  return parseStrictJsonObject(bytes)
}

function successfulChildResult(exitCode, fields = {}) {
  return deepFreeze({ status: 'PASS', category: null, exitCode, ...fields })
}

const REVIEWED_LOCAL_GIT_CONFIG = Object.freeze({
  'core.bare': 'false',
  'core.filemode': 'false',
  'core.ignorecase': 'true',
  'core.logallrefupdates': 'true',
  'core.repositoryformatversion': '0',
  'core.symlinks': 'false',
})

function safeLocalIdentity(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !/[\u0000-\u001f\u007f\p{Cf}]/u.test(value)
}

function parseGitConfigAudit(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (!text.endsWith('\0')) throw new Error('git-config-output')
  const records = text.slice(0, -1).split('\0')
  const values = new Map()
  for (const record of records) {
    const newline = record.indexOf('\n')
    if (newline <= 0 || record.indexOf('\n', newline + 1) !== -1) throw new Error('git-config-output')
    const key = record.slice(0, newline)
    const value = record.slice(newline + 1)
    if (!/^[a-z][a-z0-9.-]{0,127}$/u.test(key) || values.has(key)) throw new Error('git-config-output')
    values.set(key, value)
  }
  const exactCore = Object.entries(REVIEWED_LOCAL_GIT_CONFIG).every(([key, value]) => values.get(key) === value)
  const expectedKeys = new Set([...Object.keys(REVIEWED_LOCAL_GIT_CONFIG), 'user.name', 'user.email'])
  const clean = exactCore
    && values.size === expectedKeys.size
    && [...values.keys()].every((key) => expectedKeys.has(key))
    && safeLocalIdentity(values.get('user.name'))
    && safeLocalIdentity(values.get('user.email'))
  return deepFreeze({ status: 'PASS', clean })
}

function parseGitIndexAudit(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (text.length === 0) throw new Error('git-index-output')
  const header = /^(100644) ([a-f0-9]{40}) ([0-3])\t([^\0\r\n]+)\0/u
  const details = /^  ctime: \d+:\d+\n  mtime: \d+:\d+\n  dev: \d+\tino: \d+\n  uid: \d+\tgid: \d+\n  size: \d+\tflags: (\d+)\n/u
  const paths = new Set()
  let offset = 0
  let clean = true
  while (offset < text.length) {
    const headerMatch = header.exec(text.slice(offset))
    if (!headerMatch) throw new Error('git-index-output')
    const relativePath = headerMatch[4]
    if (path.posix.isAbsolute(relativePath)
        || relativePath.split('/').some((component) => component === '' || component === '.' || component === '..')
        || /[\\\u0000-\u001f\u007f\p{Cf}]/u.test(relativePath)
        || paths.has(relativePath)) throw new Error('git-index-output')
    paths.add(relativePath)
    offset += headerMatch[0].length
    const detailMatch = details.exec(text.slice(offset))
    if (!detailMatch) throw new Error('git-index-output')
    if (headerMatch[3] !== '0' || BigInt(detailMatch[1]) !== 0n) clean = false
    offset += detailMatch[0].length
  }
  return deepFreeze({ status: 'PASS', clean })
}

function parseWorktreeFacts(bytes, includePrivatePath = false) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const fields = text.split('\0')
  const rows = []
  let current = null
  for (const field of fields) {
    if (field === '') continue
    if (field.startsWith('worktree ')) {
      if (current) rows.push(current)
      current = { path: field.slice(9), head: null, branch: null, bare: false, locked: false }
    } else if (current && field.startsWith('HEAD ')) current.head = field.slice(5)
    else if (current && field.startsWith('branch ')) current.branch = field.slice(7)
    else if (current && field === 'bare') current.bare = true
    else if (current && field.startsWith('locked')) current.locked = true
    else if (current && field.startsWith('prunable')) { }
    else throw new Error('worktree-output')
  }
  if (current) rows.push(current)
  if (rows.length === 0 || rows.some((row) => !COMMIT_SHA.test(row.head ?? '') || (row.branch !== null && !row.branch.startsWith('refs/heads/')))) throw new Error('worktree-output')
  return rows.map((row) => includePrivatePath ? row : { head: row.head, branch: row.branch, bare: row.bare, locked: row.locked })
}

function parseDescriptorResult(row, controllerResult) {
  if (controllerResult.status !== 'PASS') return deepFreeze({ ...controllerResult, exitCode: null })
  const realExit = Number.isSafeInteger(controllerResult.exitCode)
    && controllerResult.exitCode >= 0 && controllerResult.exitCode <= 0xffff_ffff
  if (!realExit) return deepFreeze({ status: 'FAIL', category: 'invalid-output', exitCode: null })
  if (row.parser === 'zero-exit') return deepFreeze(controllerResult.exitCode === 0
    ? { status: 'PASS', category: null, exitCode: 0 }
    : { status: 'FAIL', category: 'child-nonzero', exitCode: controllerResult.exitCode })
  if (row.parser === 'quiet-exit') return controllerResult.exitCode === 0
    ? successfulChildResult(0, { clean: true })
    : controllerResult.exitCode === 1
      ? successfulChildResult(1, { clean: false })
      : deepFreeze({ status: 'FAIL', category: 'child-nonzero', exitCode: controllerResult.exitCode })
  if (row.parser === 'vitest-preflight-json') {
    try {
      const summary = parseVitestPreflightSummary(controllerResult.stdout)
      if (summary.status === 'PASS' && controllerResult.exitCode === 0) return deepFreeze({ status: 'PASS', category: null, exitCode: 0, tests: summary.tests, requiredCases: summary.requiredCases })
      if (summary.status === 'FAIL' && controllerResult.exitCode > 0) return deepFreeze({ status: 'FAIL', category: 'child-nonzero', exitCode: controllerResult.exitCode, tests: summary.tests, requiredCases: summary.requiredCases })
    } catch { }
    return deepFreeze({ status: 'FAIL', category: 'invalid-output', exitCode: null })
  }
  if (controllerResult.exitCode !== 0) return deepFreeze({ status: 'FAIL', category: 'child-nonzero', exitCode: controllerResult.exitCode })
  if (row.parser === 'git-config-audit') return successfulChildResult(0, { clean: parseGitConfigAudit(controllerResult.stdout).clean })
  if (row.parser === 'git-index-audit') return successfulChildResult(0, { clean: parseGitIndexAudit(controllerResult.stdout).clean })
  if (row.parser === 'sha256-bytes') return successfulChildResult(0, { sha256: sha256Bytes(controllerResult.stdout) })
  if (row.parser === 'clean-status') return successfulChildResult(0, { clean: controllerResult.stdout.length === 0 })
  if (row.parser === 'worktree-facts') return successfulChildResult(0, { worktrees: parseWorktreeFacts(controllerResult.stdout) })
  if (row.parser === 'native-abi-json') {
    try { return successfulChildResult(0, { result: parseNativeAbiSummary(controllerResult.stdout) }) } catch { }
    return deepFreeze({ status: 'FAIL', category: 'invalid-output', exitCode: null })
  }
  const value = oneTrailingLine(controllerResult.stdout)
  if (row.parser === 'node-version' && value === 'v24.15.0') return successfulChildResult(0, { value })
  if (row.parser === 'npm-version' && value === '11.12.1') return successfulChildResult(0, { value })
  if (row.parser === 'git-version' && value === 'git version 2.44.0.windows.1') return successfulChildResult(0, { value })
  if (row.parser === 'commit-sha' && COMMIT_SHA.test(value)) return successfulChildResult(0, { commitSha: value })
  if (row.parser === 'branch-ref' && /^refs\/heads\/[A-Za-z0-9._/-]+$/u.test(value)) return successfulChildResult(0, { branchRef: value })
  if (row.parser === 'source-epoch' && /^[1-9]\d{8,12}$/u.test(value)) return successfulChildResult(0, { sourceDateEpoch: Number(value) })
  return deepFreeze({ status: 'FAIL', category: 'invalid-output', exitCode: null })
}

async function privateMainPath(policy, retained) {
  const row = DESCRIPTORS['git-worktree-list']
  const request = await resolveDescriptor(row, policy)
  const result = await runControllerParent(request, retained)
  if (result.status !== 'PASS' || result.exitCode !== 0) throw new Error('private-main')
  const rows = parseWorktreeFacts(result.stdout, true)
  const matches = rows.filter((item) => item.branch === 'refs/heads/main' && item.bare === false && item.locked === false)
  if (matches.length !== 1) throw new Error('private-main')
  await assertNonReparsePath(matches[0].path, path.parse(matches[0].path).root, false)
  return matches[0].path
}

export async function runTrustedWindowsCommand(descriptorId) {
  if (arguments.length !== 1 || typeof descriptorId !== 'string' || !Object.hasOwn(DESCRIPTORS, descriptorId)) {
    throw new Error('Trusted command descriptor is invalid.')
  }
  const retained = []
  try {
    const loaded = await readPolicyFromHandle()
    const policyStat = await loaded.handle.stat()
    retained.push({
      path: POLICY_PATH,
      boundary: WORKSPACE_ROOT,
      expectedHash: sha256Bytes(loaded.bytes),
      handle: loaded.handle,
      dev: policyStat.dev,
      ino: policyStat.ino,
    })
    const row = DESCRIPTORS[descriptorId]
    const mainPath = row.executableClass === 'git-private-main' ? await privateMainPath(loaded.policy, retained) : undefined
    const request = await resolveDescriptor(row, loaded.policy, mainPath)
    const result = await runControllerParent(request, retained)
    return parseDescriptorResult(row, result)
  } catch (error) {
    if (error instanceof Error && error.message === 'Trusted command descriptor is invalid.') throw error
    throw new Error('Trusted command execution failed.')
  } finally {
    for (const retainedFile of retained) {
      try { await retainedFile.handle.close() } catch { }
    }
  }
}
