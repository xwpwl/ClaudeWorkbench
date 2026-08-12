import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const runnerPath = path.join(workspaceRoot, 'scripts', 'release', 'lib', 'trusted-windows-runner.mjs')
const policyPath = path.join(workspaceRoot, 'scripts', 'release', 'release-toolchain.json')
const reporterPath = path.join(workspaceRoot, 'scripts', 'release', 'vitest-preflight-reporter.mjs')
const runnerUrl = pathToFileURL(runnerPath)

const CONTROLLER_START = '/* WORKBENCH_RELEASE_CONTROLLER_V1_START */'
const CONTROLLER_END = '/* WORKBENCH_RELEASE_CONTROLLER_V1_END */'
const DESCRIPTORS_START = '/* WORKBENCH_RELEASE_DESCRIPTORS_V1_START */'
const DESCRIPTORS_END = '/* WORKBENCH_RELEASE_DESCRIPTORS_V1_END */'
const PARENT_START = '/* WORKBENCH_RELEASE_PARENT_ENGINE_V1_START */'
const PARENT_END = '/* WORKBENCH_RELEASE_PARENT_ENGINE_V1_END */'
const reviewedPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const reviewedNode = 'C:\\Program Files\\nodejs\\node.exe'
const reviewedGit = 'C:\\Program Files\\Git\\cmd\\git.exe'
const reviewedProgramFiles = 'C:\\Program Files'
const reviewedSystem32 = 'C:\\Windows\\System32'
const expectedDescriptorLiteralSha256 = '6183a3f4bc00afdd05edc720f011ed09760d428fbea4251caf8a6b9c7645e293'
const baselineDescriptorLiteralSha256 = 'a298457b298aca67613b2a64975e16c04c4d3bfa7fcaeb8ca98162d3ecf7ef19'
const baselineDescriptorRowsJson = String.raw`[
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
  {"id":"test-full","executableClass":"node-workspace","argv":["node_modules/vitest/vitest.mjs","run"],"cwdClass":"candidate","environment":{},"timeoutMs":900000,"stdoutLimit":4194304,"stderrLimit":1048576,"closureClass":"workspace-final","parser":"zero-exit"},
  {"id":"build-main","executableClass":"node-workspace","argv":["node_modules/vite/bin/vite.js","build","--config","vite.main.config.ts"],"cwdClass":"candidate","environment":{"SOURCE_DATE_EPOCH":"@release-metadata-epoch","WORKBENCH_RELEASE_METADATA_PATH":"@fixed-release-metadata"},"timeoutMs":300000,"stdoutLimit":1048576,"stderrLimit":262144,"closureClass":"workspace-final","parser":"zero-exit"},
  {"id":"build-preload","executableClass":"node-workspace","argv":["node_modules/vite/bin/vite.js","build","--config","vite.preload.config.ts"],"cwdClass":"candidate","environment":{"SOURCE_DATE_EPOCH":"@release-metadata-epoch"},"timeoutMs":300000,"stdoutLimit":1048576,"stderrLimit":262144,"closureClass":"workspace-final","parser":"zero-exit"},
  {"id":"build-renderer","executableClass":"node-workspace","argv":["node_modules/vite/bin/vite.js","build","--config","vite.renderer.config.ts"],"cwdClass":"candidate","environment":{"SOURCE_DATE_EPOCH":"@release-metadata-epoch"},"timeoutMs":300000,"stdoutLimit":1048576,"stderrLimit":262144,"closureClass":"workspace-final","parser":"zero-exit"},
  {"id":"icon-verify","executableClass":"electron-workspace","argv":["scripts/generate-app-icons.mjs","--verify"],"cwdClass":"candidate","environment":{},"timeoutMs":120000,"stdoutLimit":262144,"stderrLimit":65536,"closureClass":"electron-final","parser":"zero-exit"},
  {"id":"node-abi-probe","executableClass":"node-workspace","argv":["scripts/release/native-abi-probe.mjs"],"cwdClass":"candidate","environment":{},"timeoutMs":60000,"stdoutLimit":65536,"stderrLimit":16384,"closureClass":"workspace-final","parser":"native-abi-json"},
  {"id":"electron-abi-probe","executableClass":"electron-workspace","argv":["scripts/release/native-abi-probe.mjs"],"cwdClass":"candidate","environment":{"ELECTRON_RUN_AS_NODE":"1"},"timeoutMs":60000,"stdoutLimit":65536,"stderrLimit":16384,"closureClass":"electron-final","parser":"native-abi-json"},
  {"id":"electron-builder-win","executableClass":"node-workspace","argv":["node_modules/electron-builder/cli.js","--win","--publish","never"],"cwdClass":"candidate","environment":{"SOURCE_DATE_EPOCH":"@release-metadata-epoch","WORKBENCH_RELEASE_METADATA_PATH":"@fixed-release-metadata"},"timeoutMs":900000,"stdoutLimit":4194304,"stderrLimit":1048576,"closureClass":"workspace-final","parser":"zero-exit"}
]`

const expectedDescriptorIds = [
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
] as const

type ExpectedDescriptorRow = {
  id: string
  executableClass: string
  argv: string[]
  cwdClass: string
  environment: Record<string, string>
  timeoutMs: number
  stdoutLimit: number
  stderrLimit: number
  closureClass: string
  parser: string
}

function expectedRow(
  id: string,
  executableClass: string,
  argv: string[],
  cwdClass: string,
  environment: Record<string, string>,
  timeoutMs: number,
  stdoutLimit: number,
  stderrLimit: number,
  closureClass: string,
  parser: string,
): ExpectedDescriptorRow {
  return { id, executableClass, argv, cwdClass, environment, timeoutMs, stdoutLimit, stderrLimit, closureClass, parser }
}

const expectedGitEnvironment = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: 'NUL',
  GIT_CONFIG_GLOBAL: 'NUL',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '7',
  GIT_CONFIG_KEY_0: 'core.fsmonitor',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'core.untrackedCache',
  GIT_CONFIG_VALUE_1: 'false',
  GIT_CONFIG_KEY_2: 'core.ignoreStat',
  GIT_CONFIG_VALUE_2: 'false',
  GIT_CONFIG_KEY_3: 'core.sparseCheckout',
  GIT_CONFIG_VALUE_3: 'false',
  GIT_CONFIG_KEY_4: 'core.sparseCheckoutCone',
  GIT_CONFIG_VALUE_4: 'false',
  GIT_CONFIG_KEY_5: 'extensions.worktreeConfig',
  GIT_CONFIG_VALUE_5: 'false',
  GIT_CONFIG_KEY_6: 'core.hooksPath',
  GIT_CONFIG_VALUE_6: 'NUL',
}
const gitPrefix = ['--no-pager', '--no-optional-locks']
const expectedDescriptorRows: ExpectedDescriptorRow[] = [
  expectedRow('node-version', 'node', ['--version'], 'candidate', {}, 30_000, 65_536, 16_384, 'node', 'node-version'),
  expectedRow('npm-version', 'npm', ['--version'], 'candidate', {}, 30_000, 65_536, 16_384, 'npm', 'npm-version'),
  expectedRow('git-version', 'git', [...gitPrefix, '--version'], 'candidate', expectedGitEnvironment, 30_000, 65_536, 16_384, 'git', 'git-version'),
  expectedRow('git-config-audit', 'git', [...gitPrefix, 'config', '--local', '--no-includes', '-z', '--list'], 'candidate', expectedGitEnvironment, 30_000, 65_536, 16_384, 'git', 'git-config-audit'),
  expectedRow('git-index-audit', 'git', [...gitPrefix, 'ls-files', '--cached', '--stage', '--debug', '--sparse', '-z'], 'candidate', expectedGitEnvironment, 30_000, 1_048_576, 16_384, 'git', 'git-index-audit'),
  expectedRow('git-replace-audit', 'git', [...gitPrefix, 'replace', '-l'], 'candidate', expectedGitEnvironment, 30_000, 65_536, 16_384, 'git', 'clean-status'),
  expectedRow('git-head', 'git', [...gitPrefix, 'rev-parse', '--verify', 'HEAD'], 'candidate', expectedGitEnvironment, 30_000, 65_536, 16_384, 'git', 'commit-sha'),
  expectedRow('git-symbolic-head', 'git', [...gitPrefix, 'symbolic-ref', '-q', 'HEAD'], 'candidate', expectedGitEnvironment, 30_000, 65_536, 16_384, 'git', 'branch-ref'),
  expectedRow('git-status', 'git', [...gitPrefix, 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=none'], 'candidate', expectedGitEnvironment, 30_000, 65_536, 16_384, 'git', 'clean-status'),
  expectedRow('git-untracked-audit', 'git', [...gitPrefix, 'ls-files', '--others', '--exclude-per-directory=.gitignore', '-z'], 'candidate', expectedGitEnvironment, 30_000, 65_536, 16_384, 'git', 'clean-status'),
  expectedRow('git-worktree-list', 'git', [...gitPrefix, 'worktree', 'list', '--porcelain', '-z'], 'candidate', expectedGitEnvironment, 30_000, 65_536, 16_384, 'git', 'worktree-facts'),
  expectedRow('git-source-epoch', 'git', [...gitPrefix, 'show', '-s', '--format=%ct', 'HEAD'], 'candidate', expectedGitEnvironment, 30_000, 65_536, 16_384, 'git', 'source-epoch'),
  expectedRow('git-package-blob-hash', 'git', [...gitPrefix, 'cat-file', 'blob', 'HEAD:package.json'], 'candidate', expectedGitEnvironment, 30_000, 65_536, 16_384, 'git', 'sha256-bytes'),
  expectedRow('git-diff-quiet', 'git', [...gitPrefix, 'diff-index', '--quiet', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', 'HEAD', '--'], 'candidate', expectedGitEnvironment, 30_000, 65_536, 16_384, 'git', 'quiet-exit'),
  expectedRow('git-main-config-audit', 'git-private-main', [...gitPrefix, 'config', '--local', '--no-includes', '-z', '--list'], 'private-main', expectedGitEnvironment, 30_000, 65_536, 16_384, 'git', 'git-config-audit'),
  expectedRow('git-main-index-audit', 'git-private-main', [...gitPrefix, 'ls-files', '--cached', '--stage', '--debug', '--sparse', '-z'], 'private-main', expectedGitEnvironment, 30_000, 1_048_576, 16_384, 'git', 'git-index-audit'),
  expectedRow('git-main-head', 'git-private-main', [...gitPrefix, 'rev-parse', '--verify', 'HEAD'], 'private-main', expectedGitEnvironment, 30_000, 65_536, 16_384, 'git', 'commit-sha'),
  expectedRow('git-main-status', 'git-private-main', [...gitPrefix, 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=none'], 'private-main', expectedGitEnvironment, 30_000, 65_536, 16_384, 'git', 'clean-status'),
  expectedRow('git-main-untracked-audit', 'git-private-main', [...gitPrefix, 'ls-files', '--others', '--exclude-per-directory=.gitignore', '-z'], 'private-main', expectedGitEnvironment, 30_000, 65_536, 16_384, 'git', 'clean-status'),
  expectedRow('npm-ci-ignore-scripts', 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], 'candidate', {
    NPM_CONFIG_IGNORE_SCRIPTS: 'true', NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_USERCONFIG: 'NUL', NPM_CONFIG_GLOBALCONFIG: 'NUL', NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  }, 900_000, 4_194_304, 1_048_576, 'npm', 'zero-exit'),
  expectedRow('lifecycle-electron-install', 'node-lifecycle', [], 'package:electron', {}, 120_000, 262_144, 65_536, 'electron-lifecycle', 'zero-exit'),
  expectedRow('lifecycle-esbuild-install', 'node-lifecycle', [], 'package:esbuild', {}, 120_000, 262_144, 65_536, 'esbuild-lifecycle', 'zero-exit'),
  expectedRow('lifecycle-electron-winstaller', 'node-lifecycle', [], 'package:electron-winstaller', {}, 120_000, 262_144, 65_536, 'electron-winstaller-lifecycle', 'zero-exit'),
  expectedRow('typecheck', 'node-workspace', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'], 'candidate', {}, 300_000, 1_048_576, 262_144, 'workspace-final', 'zero-exit'),
  expectedRow('typecheck-ipc', 'node-workspace', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tests/typecheck/tsconfig.json'], 'candidate', {}, 300_000, 1_048_576, 262_144, 'workspace-final', 'zero-exit'),
  expectedRow('lint', 'node-workspace', ['node_modules/eslint/bin/eslint.js', 'src', '--ext', '.ts,.tsx'], 'candidate', {}, 300_000, 1_048_576, 262_144, 'workspace-final', 'zero-exit'),
  expectedRow('test-full', 'node-workspace', [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--config',
    'vitest.config.ts',
    '--no-cache',
    '--silent',
    '--reporter=./scripts/release/vitest-preflight-reporter.mjs',
  ], 'candidate', {}, 900_000, 4_194_304, 1_048_576, 'workspace-final', 'vitest-preflight-json'),
  expectedRow('build-main', 'node-workspace', ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.main.config.ts'], 'candidate', {
    SOURCE_DATE_EPOCH: '@release-metadata-epoch', WORKBENCH_RELEASE_METADATA_PATH: '@fixed-release-metadata',
  }, 300_000, 1_048_576, 262_144, 'workspace-final', 'zero-exit'),
  expectedRow('build-preload', 'node-workspace', ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.preload.config.ts'], 'candidate', {
    SOURCE_DATE_EPOCH: '@release-metadata-epoch',
  }, 300_000, 1_048_576, 262_144, 'workspace-final', 'zero-exit'),
  expectedRow('build-renderer', 'node-workspace', ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.renderer.config.ts'], 'candidate', {
    SOURCE_DATE_EPOCH: '@release-metadata-epoch',
  }, 300_000, 1_048_576, 262_144, 'workspace-final', 'zero-exit'),
  expectedRow('icon-verify', 'electron-workspace', ['scripts/generate-app-icons.mjs', '--verify'], 'candidate', {}, 120_000, 262_144, 65_536, 'electron-final', 'zero-exit'),
  expectedRow('node-abi-probe', 'node-workspace', ['scripts/release/native-abi-probe.mjs'], 'candidate', {}, 60_000, 65_536, 16_384, 'workspace-final', 'native-abi-json'),
  expectedRow('electron-abi-probe', 'electron-workspace', ['scripts/release/native-abi-probe.mjs'], 'candidate', { ELECTRON_RUN_AS_NODE: '1' }, 60_000, 65_536, 16_384, 'electron-final', 'native-abi-json'),
  expectedRow('electron-builder-win', 'node-workspace', ['node_modules/electron-builder/cli.js', '--win', '--publish', 'never'], 'candidate', {
    SOURCE_DATE_EPOCH: '@release-metadata-epoch', WORKBENCH_RELEASE_METADATA_PATH: '@fixed-release-metadata',
  }, 900_000, 4_194_304, 1_048_576, 'workspace-final', 'zero-exit'),
]

const requiredCaseFixtures = [
  ['migration', 'src/main/database/__tests__/Migration.test.ts', 'SQLite migration > backs up the legacy JSON before importing it'],
  ['current-schema', 'src/main/database/__tests__/ReleaseMigration.test.ts', 'v0.9/v3 to v1.0/v4 release migration > advances the fixed v0.9 fixture to the current schema v7'],
  ['future-schema', 'src/main/database/__tests__/ReleaseMigration.test.ts', 'v0.9/v3 to v1.0/v4 release migration > rejects a schema newer than the v1.0 client'],
  ['legacy-safety', 'src/main/database/__tests__/DatabaseLegacySafety.test.ts', 'legacy database fail-closed safety > rejects a corrupt file with a SQLite header without moving or recreating it'],
  ['sentinel-redaction', 'src/main/diagnostics/__tests__/DiagnosticsExporter.release.test.ts', 'DiagnosticsExporter release privacy boundary > re-sanitizes structured and unstructured log lines before ZIP serialization'],
  ['diagnostics-bounds', 'src/main/diagnostics/__tests__/DiagnosticsExporter.release.test.ts', 'DiagnosticsExporter release privacy boundary > tails oversized logs so stale content cannot inflate the diagnostic archive'],
] as const

type ReporterTestState = 'passed' | 'failed' | 'skipped' | 'pending'

function reporterModule(
  relativePath: string,
  tests: readonly { fullName: string, state: ReporterTestState, mode?: 'run' | 'skip' | 'todo' }[],
  state: 'passed' | 'failed' | 'skipped' | 'pending' | 'queued' = 'passed',
) {
  return {
    type: 'module',
    moduleId: path.join(workspaceRoot, ...relativePath.split('/')),
    state: () => state,
    errors: () => state === 'failed' && tests.length === 0 ? [{ message: 'private collection detail' }] : [],
    children: {
      *allTests() {
        for (const test of tests) {
          yield {
            type: 'test',
            fullName: test.fullName,
            options: { mode: test.mode ?? 'run' },
            result: () => ({ state: test.state }),
          }
        }
      },
    },
  }
}

function passingReporterModules() {
  const grouped = new Map<string, Array<{ fullName: string, state: ReporterTestState }>>()
  for (const [, relativePath, fullName] of requiredCaseFixtures) {
    const rows = grouped.get(relativePath) ?? []
    rows.push({ fullName, state: 'passed' })
    grouped.set(relativePath, rows)
  }
  return [...grouped].map(([relativePath, tests]) => reporterModule(relativePath, tests))
}

async function captureReporterRun(
  modules: readonly unknown[],
  errors: readonly unknown[] = [],
  reason = 'passed',
  initialExitCode: number | undefined = undefined,
): Promise<{ output: string, exitCode: number | undefined, available: boolean }> {
  const loaded = await import(`${pathToFileURL(reporterPath).href}?reporter-test=${crypto.randomUUID()}`).catch(() => null)
  if (loaded === null || typeof loaded.default !== 'function') return { output: '', exitCode: initialExitCode, available: false }
  const reporter = new loaded.default()
  const originalWrite = process.stdout.write
  const originalExitCode = process.exitCode
  let output = ''
  process.exitCode = initialExitCode
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }) as typeof process.stdout.write
  try {
    await reporter.onTestRunEnd(modules, errors, reason)
    return { output, exitCode: process.exitCode, available: true }
  } finally {
    process.stdout.write = originalWrite
    process.exitCode = originalExitCode
  }
}

function extractNamedFunction(source: string, name: string): string {
  const match = new RegExp(`function ${name}\\([^]*?^\\}`, 'mu').exec(source)
  expect(match, `production function ${name}`).not.toBeNull()
  return match?.[0] ?? `function ${name}(){ throw new Error('missing') }`
}

async function extractedMachineParser(): Promise<(row: { parser: string }, result: unknown) => unknown> {
  const source = await fs.readFile(runnerPath, 'utf8')
  const names = [
    'deepFreeze',
    'exactObject',
    'rejectDuplicateJsonKeys',
    'parseStrictJsonObject',
    'parseVitestPreflightSummary',
    'parseNativeAbiSummary',
    'successfulChildResult',
    'oneTrailingLine',
    'parseDescriptorResult',
  ]
  const body = names.map((name) => extractNamedFunction(source, name)).join('\n')
  const context = vm.createContext({ Buffer, JSON, Number, Object, Set, TextDecoder })
  return new vm.Script(`${body}\nparseDescriptorResult`).runInContext(context)
}

async function extractedReporterIncrement(): Promise<(value: number) => number> {
  const source = await fs.readFile(reporterPath, 'utf8')
  const match = /function boundedIncrement\([^]*?^\}/mu.exec(source)
  expect(match, 'production reporter bounded increment').not.toBeNull()
  return new vm.Script(`const MAX_COUNT = 2_147_483_647\n${match?.[0] ?? 'function boundedIncrement(){ return 0 }'}\nboundedIncrement`)
    .runInNewContext({ Error })
}

async function runRealVitestReporter(cwd: string): Promise<{ code: number | null, stdout: string, stderr: string }> {
  const requiredModules = [...new Set(requiredCaseFixtures.map(([, relativePath]) => path.join(workspaceRoot, ...relativePath.split('/'))))]
  return await new Promise((resolve, reject) => {
    const child = spawn(reviewedNode, [
      path.join(workspaceRoot, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      ...requiredModules,
      '--config', path.join(workspaceRoot, 'vitest.config.ts'),
      '--root', workspaceRoot,
      '--no-cache',
      '--silent',
      `--reporter=${reporterPath.replaceAll('\\', '/')}`,
    ], { cwd, env: { LANG: 'C', LC_ALL: 'C' }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.once('error', reject)
    child.once('close', (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }))
  })
}

async function runExtractedCanonicalTree(root: string, selected: readonly string[]): Promise<unknown> {
  const controller = await exactControllerSource()
  const streamHash = /function Get-StreamSha256\([^]*?^\}/mu.exec(controller)?.[0]
  const canonicalTree = /function Get-CanonicalTree\([^]*?^\}/mu.exec(controller)?.[0]
  expect(streamHash, 'controller stream hash function').toBeTruthy()
  expect(canonicalTree, 'controller canonical tree function').toBeTruthy()
  const script = [
    streamHash,
    canonicalTree,
    `$result = Get-CanonicalTree $null ${JSON.stringify(root)} @(${selected.map((item) => JSON.stringify(item)).join(',')}) $false`,
    '[Console]::Out.Write(($result | ConvertTo-Json -Compress))',
  ].join('\n')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return await new Promise((resolve, reject) => {
    const child = spawn(reviewedPowerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      cwd: workspaceRoot, env: { LANG: 'C', LC_ALL: 'C' }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(`Canonical tree fixture failed: ${Buffer.concat(stderr).toString('utf8')}`))
      else resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')))
    })
  })
}

type NodeModulesTreeSnapshot = Readonly<{
  canonicalTreeBytes: string
  fileCount: number
  relativePaths: readonly string[]
  totalBytes: number
  treeSha256: string
}>

async function snapshotNodeModulesTree(root: string): Promise<NodeModulesTreeSnapshot> {
  const rows: Array<{ relativePath: string, size: number, fileSha256: string }> = []
  const visit = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true })
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Vitest cache fixture contains a symbolic link.')
      if (entry.isDirectory()) {
        await visit(absolute)
        continue
      }
      if (!entry.isFile()) throw new Error('Vitest cache fixture contains a non-ordinary file.')
      const bytes = await fs.readFile(absolute)
      rows.push({
        relativePath: path.relative(root, absolute).replaceAll('\\', '/'),
        size: bytes.length,
        fileSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      })
    }
  }
  await visit(root)
  rows.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0)
  const canonicalTreeBytes = `${JSON.stringify(rows)}\n`
  return Object.freeze({
    canonicalTreeBytes,
    fileCount: rows.length,
    relativePaths: Object.freeze(rows.map((row) => row.relativePath)),
    totalBytes: rows.reduce((total, row) => total + row.size, 0),
    treeSha256: crypto.createHash('sha256').update(Buffer.from(canonicalTreeBytes, 'utf8')).digest('hex'),
  })
}

async function createLockedVitestCacheFixture(label: string): Promise<{ nodeModulesRoot: string, root: string }> {
  const parent = path.join(workspaceRoot, 'release-validation', 'task2c1-vitest-cache-fixtures')
  await fs.mkdir(parent, { recursive: true })
  const root = await fs.mkdtemp(path.join(parent, `${label}-`))
  disposableRoots.push(root)
  const nodeModulesRoot = path.join(root, 'node_modules')
  await fs.mkdir(nodeModulesRoot)
  await fs.writeFile(path.join(root, 'vitest.config.mjs'), [
    'export default {',
    "  test: { environment: 'node', globals: true, include: ['tiny.test.mjs'] },",
    '}',
    '',
  ].join('\n'), 'utf8')
  await fs.writeFile(path.join(root, 'tiny.test.mjs'), [
    "import assert from 'node:assert/strict'",
    "test('locked Vitest cache boundary', () => assert.equal(2 + 2, 4))",
    '',
  ].join('\n'), 'utf8')
  return { nodeModulesRoot, root }
}

async function runLockedVitestCacheFixture(root: string, noCache: boolean): Promise<{ code: number | null, stderr: string }> {
  const argv = [
    path.join(workspaceRoot, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    '--root', root,
    '--config', path.join(root, 'vitest.config.mjs'),
    ...(noCache ? ['--no-cache'] : []),
    '--silent',
    '--reporter=default',
  ]
  return await new Promise((resolve, reject) => {
    const child = spawn(reviewedNode, argv, {
      cwd: root,
      env: {
        COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
        LANG: 'C',
        LC_ALL: 'C',
        SystemRoot: 'C:\\Windows',
        WINDIR: 'C:\\Windows',
      },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const stderr: Buffer[] = []
    const timer = setTimeout(() => {
      try { child.kill() } catch { }
      reject(new Error('Locked Vitest cache fixture timed out.'))
    }, 60_000)
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stderr: Buffer.concat(stderr).toString('utf8') })
    })
  })
}

const disposableRoots: string[] = []

afterEach(async () => {
  for (const root of disposableRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true })
  }
})

function occurrences(source: string, marker: string): number {
  return source.split(marker).length - 1
}

function extractBetween(source: string, start: string, end: string): string {
  expect(occurrences(source, start), `${start} count`).toBe(1)
  expect(occurrences(source, end), `${end} count`).toBe(1)
  const startIndex = source.indexOf(start) + start.length
  const endIndex = source.indexOf(end, startIndex)
  expect(endIndex).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

async function sha256File(filePath: string): Promise<string> {
  return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex')
}

async function exactControllerSource(): Promise<string> {
  const source = await fs.readFile(runnerPath, 'utf8')
  const block = extractBetween(source, CONTROLLER_START, CONTROLLER_END)
  const match = /const CONTROLLER_SOURCE = String\.raw\x60([\s\S]*?)\x60\s*$/u.exec(block)
  expect(match).not.toBeNull()
  return match?.[1] ?? ''
}

async function exactLoaderSource(controllerSha256: string): Promise<string> {
  const source = await fs.readFile(runnerPath, 'utf8')
  const match = /const LOADER_SOURCE = String\.raw\x60([\s\S]*?)\x60\r?\nconst ENCODED_LOADER/u.exec(source)
  expect(match).not.toBeNull()
  return (match?.[1] ?? '').replaceAll('${CONTROLLER_SHA256}', controllerSha256)
}

function loaderEnvelope(controllerBytes: Buffer, requestBytes: Buffer, controllerSha256?: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    controllerBase64: controllerBytes.toString('base64'),
    controllerByteLength: controllerBytes.length,
    controllerSha256: controllerSha256 ?? crypto.createHash('sha256').update(controllerBytes).digest('hex'),
    requestBase64: requestBytes.toString('base64'),
    requestByteLength: requestBytes.length,
    requestSha256: crypto.createHash('sha256').update(requestBytes).digest('hex'),
  }) + '\n'
}

async function runExactLoader(
  envelopeParts: readonly (string | Buffer)[],
  options: { closeStdin?: boolean, delayMs?: number, timeoutMs?: number } = {},
): Promise<{ code: number | null, stdout: string, stderr: string }> {
  const controller = await exactControllerSource()
  const controllerSha256 = crypto.createHash('sha256').update(Buffer.from(controller, 'utf8')).digest('hex')
  const encoded = Buffer.from(await exactLoaderSource(controllerSha256), 'utf16le').toString('base64')
  return await new Promise((resolve, reject) => {
    const child = spawn(reviewedPowerShell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
    ], {
      cwd: workspaceRoot,
      env: { LANG: 'C', LC_ALL: 'C' },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let index = 0
    const timer = setTimeout(() => {
      try { child.kill() } catch { }
      reject(new Error('Exact loader test timed out.'))
    }, options.timeoutMs ?? 15_000)
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
    })
    const writeNext = () => {
      const part = envelopeParts[index++]
      if (part === undefined) {
        if (options.closeStdin !== false) child.stdin.end()
        return
      }
      child.stdin.write(part, () => setTimeout(writeNext, options.delayMs ?? 0))
    }
    writeNext()
  })
}

type ParentTransportOptions = {
  completeOnFinish?: boolean
  completionDelayMs?: number
  stdinBackpressure?: boolean
  stdinError?: boolean
  omitClose?: boolean
  omitExit?: boolean
  omitStdoutEnd?: boolean
  omitStderrEnd?: boolean
  stdout?: Buffer
  stderr?: Buffer
}

class ParentTransport extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin: Writable
  killCalls = 0
  private completed = false
  private readonly options: ParentTransportOptions

  constructor(options: ParentTransportOptions = {}) {
    super()
    this.options = options
    this.stdin = new Writable({
      write: (_chunk, _encoding, callback) => {
        if (options.stdinError) callback(new Error('fixture stdin failure'))
        else callback()
      },
      final: (callback) => {
        if (options.completeOnFinish !== false) setTimeout(() => this.complete(), options.completionDelayMs ?? 0)
        callback()
      },
    })
    if (options.stdinBackpressure) {
      const originalWrite = this.stdin.write.bind(this.stdin)
      this.stdin.write = ((...args: Parameters<Writable['write']>) => {
        originalWrite(...args)
        setTimeout(() => this.stdin.emit('drain'), 0)
        return false
      }) as Writable['write']
    }
  }

  kill(): boolean {
    this.killCalls += 1
    queueMicrotask(() => this.complete())
    return true
  }

  complete(): void {
    if (this.completed) return
    this.completed = true
    if (this.options.stdout) this.stdout.write(this.options.stdout)
    if (this.options.stderr) this.stderr.write(this.options.stderr)
    if (!this.options.omitStdoutEnd) this.stdout.end()
    if (!this.options.omitStderrEnd) this.stderr.end()
    if (!this.options.omitExit) this.emit('exit', 0, null)
    if (!this.options.omitClose) this.emit('close', 0, null)
  }
}

async function extractedParentEngine(): Promise<(controller: ParentTransport, requestLine: Buffer, limits: Record<string, number>, retainedInputs: Array<{ close(): Promise<void> }>) => Promise<unknown>> {
  const source = await fs.readFile(runnerPath, 'utf8')
  const parent = extractBetween(source, PARENT_START, PARENT_END)
  const functionMatch = /async function runControllerProtocol\([\s\S]*?\n\}/u.exec(parent)
  expect(functionMatch, 'marked parent engine must contain the complete self-contained runControllerProtocol function').not.toBeNull()
  const context = vm.createContext({ Buffer, TextDecoder, clearTimeout, queueMicrotask, setTimeout })
  return new vm.Script(`(${functionMatch?.[0] ?? 'undefined'})`).runInContext(context)
}

async function controllerRequest(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const cmdPath = path.win32.join(reviewedSystem32, 'cmd.exe')
  return {
    schemaVersion: 1,
    id: 'test-only-exact-controller',
    controllerCandidate: reviewedPowerShell,
    programFilesCandidate: reviewedProgramFiles,
    executable: reviewedNode,
    argv: ['--version'],
    cwd: workspaceRoot,
    environment: {},
    criticalInputs: [
      { path: reviewedNode, boundary: reviewedProgramFiles, sha256: await sha256File(reviewedNode), protected: true },
      { path: cmdPath, boundary: reviewedSystem32, sha256: await sha256File(cmdPath), protected: true },
    ],
    trees: [],
    timeoutMs: 5_000,
    stdoutLimit: 65_536,
    stderrLimit: 16_384,
    ...overrides,
  }
}

async function runExactController(request: Record<string, unknown>): Promise<{ code: number | null, stdout: string, stderr: string }> {
  return await runExactControllerBytes(Buffer.from(JSON.stringify(request) + '\n', 'utf8'))
}

async function runExactControllerBytes(requestBytes: Buffer): Promise<{ code: number | null, stdout: string, stderr: string }> {
  const controller = await exactControllerSource()
  const controllerBytes = Buffer.from(controller, 'utf8')
  const controllerSha256 = crypto.createHash('sha256').update(controllerBytes).digest('hex')
  const encoded = Buffer.from(await exactLoaderSource(controllerSha256), 'utf16le').toString('base64')
  const envelope = JSON.stringify({
    schemaVersion: 1,
    controllerBase64: controllerBytes.toString('base64'),
    controllerByteLength: controllerBytes.length,
    controllerSha256,
    requestBase64: requestBytes.toString('base64'),
    requestByteLength: requestBytes.length,
    requestSha256: crypto.createHash('sha256').update(requestBytes).digest('hex'),
  })
  return await new Promise((resolve, reject) => {
    const child = spawn(reviewedPowerShell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encoded,
    ], {
      cwd: workspaceRoot,
      env: { LANG: 'C', LC_ALL: 'C' },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timer = setTimeout(() => {
      try { child.kill() } catch { }
      reject(new Error('Exact controller test timed out.'))
    }, 30_000)
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
    child.stdin.end(envelope + '\n')
  })
}

async function copyRunnerWorkspace(policyBytes: Uint8Array, runnerBytes?: Uint8Array): Promise<URL> {
  const parent = path.join(workspaceRoot, 'release-validation', 'task2c1-policy-fixtures')
  await fs.mkdir(parent, { recursive: true })
  const root = await fs.mkdtemp(path.join(parent, 'workspace-'))
  disposableRoots.push(root)
  const libraryDirectory = path.join(root, 'scripts', 'release', 'lib')
  await fs.mkdir(libraryDirectory, { recursive: true })
  const copiedRunnerPath = path.join(libraryDirectory, 'trusted-windows-runner.mjs')
  if (runnerBytes) await fs.writeFile(copiedRunnerPath, runnerBytes)
  else await fs.copyFile(runnerPath, copiedRunnerPath)
  await fs.writeFile(path.join(root, 'scripts', 'release', 'release-toolchain.json'), policyBytes)
  return pathToFileURL(copiedRunnerPath)
}

function synchronizeDescriptorHash(source: string): string {
  const match = /const DESCRIPTOR_ROWS_JSON = String\.raw`([\s\S]*?)`;/u.exec(source)
  if (!match) throw new Error('Descriptor literal not found in test fixture.')
  const digest = crypto.createHash('sha256').update(Buffer.from(match[1], 'utf8')).digest('hex')
  const updated = source.replace(
    /const DESCRIPTOR_ROWS_SHA256 = '[a-f0-9]{64}'/u,
    `const DESCRIPTOR_ROWS_SHA256 = '${digest}'`,
  )
  if (updated === source) throw new Error('Descriptor hash binding not found in test fixture.')
  return updated
}

async function runFixtureGit(root: string, argv: readonly string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(reviewedGit, argv, {
      cwd: root,
      env: {
        SystemRoot: 'C:\\Windows',
        WINDIR: 'C:\\Windows',
        COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
        LANG: 'C',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_SYSTEM: 'NUL',
        GIT_CONFIG_GLOBAL: 'NUL',
        GIT_TERMINAL_PROMPT: '0',
      },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(`Fixture Git failed (${code}): ${Buffer.concat(stderr).toString('utf8')}`))
      else resolve(Buffer.concat(stdout).toString('utf8'))
    })
  })
}

async function gitIndexPath(root: string): Promise<string> {
  const value = (await runFixtureGit(root, ['rev-parse', '--git-path', 'index'])).trim()
  if (!value || /[\u0000\r\n]/u.test(value)) throw new Error('Invalid fixture Git index path.')
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value)
}

async function gitIndexSnapshot(indexPath: string): Promise<Record<string, string>> {
  const stat = await fs.stat(indexPath, { bigint: true })
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    length: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    sha256: await sha256File(indexPath),
  }
}

async function reviewedMainWorktree(): Promise<string> {
  const output = await runFixtureGit(workspaceRoot, ['worktree', 'list', '--porcelain'])
  const blocks = output.trim().split(/\r?\n\r?\n/u)
  const matches = blocks.filter((block) => /(?:^|\r?\n)branch refs\/heads\/main(?:\r?\n|$)/u.test(block))
  if (matches.length !== 1) throw new Error('Expected one main fixture worktree.')
  const first = /^worktree (.+)$/mu.exec(matches[0])?.[1]
  if (!first || /[\u0000\r\n]/u.test(first)) throw new Error('Invalid main fixture worktree path.')
  return path.resolve(first)
}

async function createGitRunnerWorkspace(): Promise<{ root: string, runnerUrl: URL }> {
  const parent = path.join(workspaceRoot, 'release-validation', 'task2c1-git-fixtures')
  await fs.mkdir(parent, { recursive: true })
  const root = await fs.mkdtemp(path.join(parent, 'workspace-'))
  disposableRoots.push(root)
  const libraryDirectory = path.join(root, 'scripts', 'release', 'lib')
  await fs.mkdir(libraryDirectory, { recursive: true })
  await fs.copyFile(runnerPath, path.join(libraryDirectory, 'trusted-windows-runner.mjs'))
  await fs.copyFile(policyPath, path.join(root, 'scripts', 'release', 'release-toolchain.json'))
  await fs.writeFile(path.join(root, 'tracked.txt'), 'reviewed\n', 'utf8')
  await runFixtureGit(root, ['-c', 'core.hooksPath=NUL', 'init', '-b', 'task15'])
  await runFixtureGit(root, ['config', 'user.name', 'Task2C1 Fixture'])
  await runFixtureGit(root, ['config', 'user.email', 'task2c1@example.invalid'])
  await runFixtureGit(root, ['add', 'scripts', 'tracked.txt'])
  await runFixtureGit(root, ['-c', 'core.hooksPath=NUL', 'commit', '--no-gpg-sign', '-m', 'fixture'])
  return { root, runnerUrl: pathToFileURL(path.join(libraryDirectory, 'trusted-windows-runner.mjs')) }
}

const validReleaseMetadata = {
  metadataSchemaVersion: 1,
  purpose: 'candidate',
  productName: 'Claude Workbench',
  appId: 'com.claudeworkbench.app',
  version: '1.0.1-rc.1',
  channel: 'rc',
  buildId: '1.0.1-rc.1+89abcdef0123.20260812T123456Z',
  branch: 'task15',
  commitSha: '89abcdef0123456789abcdef0123456789abcdef',
  commitShort: '89abcdef0123',
  dirty: false,
  buildTimeUtc: '2026-08-12T12:34:56Z',
  nodeVersion: 'v24.15.0',
  npmVersion: '11.12.1',
  electronVersion: '35.7.5',
  sqliteSchemaVersion: 7,
  platform: 'win32',
  arch: 'x64',
  lockfileSha256: 'a'.repeat(64),
  releaseNotesSha256: 'b'.repeat(64),
}

async function createMetadataRunnerWorkspace(metadataBytes: Uint8Array): Promise<{
  markerPath: string
  metadataPath: string
  root: string
  runnerUrl: URL
}> {
  const source = await fs.readFile(runnerPath, 'utf8')
  const originalRow = expectedDescriptorRows[0]
  const fixtureRow = {
    ...originalRow,
    argv: ['metadata-env-probe.mjs'],
    environment: {
      SOURCE_DATE_EPOCH: '@release-metadata-epoch',
      WORKBENCH_RELEASE_METADATA_PATH: '@fixed-release-metadata',
    },
  }
  const modified = source.replace(JSON.stringify(originalRow), JSON.stringify(fixtureRow))
  if (modified === source) throw new Error('Metadata fixture descriptor row was not found.')
  const url = await copyRunnerWorkspace(
    await fs.readFile(policyPath),
    Buffer.from(synchronizeDescriptorHash(modified), 'utf8'),
  )
  const root = path.resolve(path.dirname(fileURLToPath(url)), '..', '..', '..')
  const markerPath = path.join(root, 'metadata-probe.json')
  const metadataPath = path.join(root, 'release-validation', 'staging', 'release-metadata.json')
  await fs.mkdir(path.dirname(metadataPath), { recursive: true })
  await fs.writeFile(metadataPath, metadataBytes)
  await fs.writeFile(path.join(root, 'metadata-env-probe.mjs'), [
    "import fs from 'node:fs'",
    "import path from 'node:path'",
    "const metadataPath = process.env.WORKBENCH_RELEASE_METADATA_PATH ?? ''",
    "let renameSucceeded = false",
    "let lockCode = null",
    "try {",
    "  const moved = `${metadataPath}.moved`",
    "  fs.renameSync(metadataPath, moved)",
    "  renameSucceeded = true",
    "  fs.renameSync(moved, metadataPath)",
    "} catch (error) { lockCode = error?.code ?? 'UNKNOWN' }",
    "fs.writeFileSync(path.join(process.cwd(), 'metadata-probe.json'), JSON.stringify({",
    "  metadataPath,",
    "  sourceDateEpoch: process.env.SOURCE_DATE_EPOCH ?? null,",
    "  renameSucceeded,",
    "  lockCode,",
    "}))",
    "process.stdout.write('v24.15.0\\n')",
    '',
  ].join('\n'), 'utf8')
  return { markerPath, metadataPath, root, runnerUrl: url }
}

const testFullHeldInputs = [
  'node_modules/vitest/vitest.mjs',
  'vitest.config.ts',
  'scripts/release/vitest-preflight-reporter.mjs',
  'package.json',
  'tsconfig.json',
  'src/main/database/__tests__/Migration.test.ts',
  'src/main/database/__tests__/ReleaseMigration.test.ts',
  'src/main/database/__tests__/DatabaseLegacySafety.test.ts',
  'src/main/diagnostics/__tests__/DiagnosticsExporter.release.test.ts',
] as const

async function createTestFullRunnerWorkspace(mode: 'normal' | 'prelaunch-mutation' | 'casefold-collision'): Promise<{
  root: string
  markerPath: string
  releasePath: string
  runnerUrl: URL
  actualInputs: string[]
}> {
  let source = await fs.readFile(runnerPath, 'utf8')
  const row = expectedDescriptorRows.find((item) => item.id === 'test-full')
  if (!row) throw new Error('Missing test-full descriptor fixture.')
  source = source.replace(JSON.stringify(row), JSON.stringify({ ...row, closureClass: 'node' }))
  source = source.replace("node: ['node'],", "node: ['node', 'node-workspace'],")
  if (mode === 'prelaunch-mutation') {
    source = source.replace(
      'async function runControllerParent(request, retainedHandles) {',
      "async function runControllerParent(request, retainedHandles) {\n  if (request.id === 'test-full') await fs.appendFile(request.criticalInputs[3].path, 'prelaunch-mutation')",
    )
  }
  if (mode === 'casefold-collision') {
    source = source.replace(
      "const matches = entries.filter((entry) => entry.name.toLowerCase() === expected.toLowerCase())",
      "const matches = entries.filter((entry) => entry.name.toLowerCase() === expected.toLowerCase())\n    if (relativePath === 'vitest.config.ts' && expected.toLowerCase() === 'vitest.config.ts' && matches.length === 1) matches.push(matches[0])",
    )
  }
  source = synchronizeDescriptorHash(source)
  const parent = path.join(workspaceRoot, 'release-validation', 'task2c1-held-input-fixtures')
  await fs.mkdir(parent, { recursive: true })
  const root = await fs.mkdtemp(path.join(parent, 'workspace-'))
  disposableRoots.push(root)
  const actualRelativePaths = [
    'Node_Modules/VITEST/VITEST.mjs',
    'VITEST.CONFIG.ts',
    'Scripts/Release/VITEST-PREFLIGHT-REPORTER.mjs',
    'PACKAGE.JSON',
    'TSCONFIG.JSON',
    'SRC/Main/Database/__Tests__/MIGRATION.TEST.ts',
    'SRC/Main/Database/__Tests__/RELEASEMIGRATION.TEST.ts',
    'SRC/Main/Database/__Tests__/DATABASELEGACYSAFETY.TEST.ts',
    'SRC/Main/Diagnostics/__Tests__/DIAGNOSTICSEXPORTER.RELEASE.TEST.ts',
  ]
  const actualInputs = actualRelativePaths.map((relativePath) => path.join(root, ...relativePath.split('/')))
  for (const input of actualInputs) await fs.mkdir(path.dirname(input), { recursive: true })
  const markerPath = path.join(root, 'held-state.json')
  const releasePath = path.join(root, 'release-child.txt')
  const summary = JSON.stringify({
    schemaVersion: 1,
    status: 'PASS',
    tests: { files: 4, tests: 6, passed: 6, failed: 0, skipped: 0, todo: 0 },
    requiredCases: requiredCaseFixtures.map(([id]) => id),
  })
  const childSource = [
    "import fs from 'node:fs'",
    "import path from 'node:path'",
    `const expected = ${JSON.stringify(testFullHeldInputs)}`,
    "function find(relativePath) {",
    "  let current = process.cwd()",
    "  for (const component of relativePath.split('/')) {",
    "    const matches = fs.readdirSync(current).filter((name) => name.toLowerCase() === component.toLowerCase())",
    "    if (matches.length !== 1) throw new Error('identity')",
    "    current = path.join(current, matches[0])",
    "  }",
    "  return current",
    "}",
    "const held = []",
    "try {",
    "  for (const relativePath of expected) {",
    "    const input = find(relativePath)",
    "    try { fs.renameSync(input, `${input}.moved`); fs.renameSync(`${input}.moved`, input); held.push(false) }",
    "    catch (error) { held.push(['EACCES','EBUSY','EPERM'].includes(error?.code)) }",
    "  }",
    "  fs.writeFileSync(path.join(process.cwd(), 'held-state.json'), JSON.stringify({ held, argv: process.argv.slice(2) }))",
    "} catch (error) {",
    "  fs.writeFileSync(path.join(process.cwd(), 'held-state.json'), JSON.stringify({ held, fixtureError: error?.message ?? 'unknown' }))",
    "  process.exit(7)",
    "}",
    "const timer = setInterval(() => {",
    "  if (!fs.existsSync(path.join(process.cwd(), 'release-child.txt'))) return",
    "  clearInterval(timer)",
    `  process.stdout.write(${JSON.stringify(`${summary}\n`)})`,
    "}, 20)",
    '',
  ].join('\n')
  await fs.writeFile(actualInputs[0], childSource, 'utf8')
  for (const input of actualInputs.slice(1)) await fs.writeFile(input, `fixture:${path.basename(input)}\n`, 'utf8')
  const libraryDirectory = path.join(root, 'scripts', 'release', 'lib')
  await fs.mkdir(libraryDirectory, { recursive: true })
  await fs.writeFile(path.join(libraryDirectory, 'trusted-windows-runner.mjs'), source, 'utf8')
  await fs.copyFile(policyPath, path.join(root, 'scripts', 'release', 'release-toolchain.json'))
  return { root, markerPath, releasePath, runnerUrl: pathToFileURL(path.join(libraryDirectory, 'trusted-windows-runner.mjs')), actualInputs }
}

async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { await fs.access(filePath); return } catch { }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${path.basename(filePath)}.`)
}

async function checkNodeSyntax(filePath: string): Promise<{ code: number | null, stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(reviewedNode, ['--check', filePath], { cwd: path.dirname(filePath), shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    const stderr: Buffer[] = []
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stderr: Buffer.concat(stderr).toString('utf8') }))
  })
}

async function createControllerTreeFixture(mode: 'timeout' | 'stdout' | 'stderr'): Promise<{
  markerPath: string
  request: Record<string, unknown>
}> {
  const parent = path.join(workspaceRoot, 'release-validation', 'task2c1-controller-fixtures')
  await fs.mkdir(parent, { recursive: true })
  const root = await fs.mkdtemp(path.join(parent, 'fixture-'))
  disposableRoots.push(root)
  const scriptPath = path.join(root, 'tree-fixture.mjs')
  const markerPath = path.join(root, 'pids.json')
  await fs.writeFile(scriptPath, [
    "import { spawn } from 'node:child_process'",
    "import fs from 'node:fs'",
    "const [markerPath, mode] = process.argv.slice(2)",
    "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })",
    "fs.writeFileSync(markerPath, JSON.stringify({ targetPid: process.pid, descendantPid: descendant.pid }))",
    "if (mode === 'stdout') process.stdout.write(Buffer.alloc(262144, 0x78))",
    "if (mode === 'stderr') process.stderr.write(Buffer.alloc(262144, 0x78))",
    "setInterval(() => {}, 1000)",
    '',
  ].join('\n'), 'utf8')
  const request = await controllerRequest({
    argv: [scriptPath, markerPath, mode],
    timeoutMs: mode === 'timeout' ? 750 : 5_000,
    stdoutLimit: 1_024,
    stderrLimit: 1_024,
  })
  const criticalInputs = [...(request.criticalInputs as Array<Record<string, unknown>>), {
    path: scriptPath,
    boundary: workspaceRoot,
    sha256: await sha256File(scriptPath),
    protected: false,
  }]
  return { markerPath, request: { ...request, criticalInputs } }
}

async function processIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function expectFixtureProcessesDead(markerPath: string): Promise<void> {
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as { targetPid: number, descendantPid: number }
  expect(marker.targetPid).toBeGreaterThan(0)
  expect(marker.descendantPid).toBeGreaterThan(0)
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline && (await processIsAlive(marker.targetPid) || await processIsAlive(marker.descendantPid))) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  expect(await processIsAlive(marker.targetPid), `target PID ${marker.targetPid}`).toBe(false)
  expect(await processIsAlive(marker.descendantPid), `descendant PID ${marker.descendantPid}`).toBe(false)
}

describe('bounded Vitest preflight reporter', () => {
  it('emits one exact compact LF-terminated PASS summary from completed Vitest objects', async () => {
    const result = await captureReporterRun(passingReporterModules())
    expect(result.available, 'the production reporter must be importable').toBe(true)
    expect(result.output).toBe('{"schemaVersion":1,"status":"PASS","tests":{"files":4,"tests":6,"passed":6,"failed":0,"skipped":0,"todo":0},"requiredCases":["migration","current-schema","future-schema","legacy-safety","sentinel-redaction","diagnostics-bounds"]}\n')
    expect(result.exitCode).toBeUndefined()
  })

  it('counts failed, skipped, todo, and pending tests honestly without leaking private names', async () => {
    const modules = passingReporterModules()
    modules.push(reporterModule('tests/private-states.test.ts', [
      { fullName: 'private failed name', state: 'failed' },
      { fullName: 'private skipped name', state: 'skipped', mode: 'skip' },
      { fullName: 'private todo name', state: 'skipped', mode: 'todo' },
      { fullName: 'private pending name', state: 'pending' },
    ]))
    const result = await captureReporterRun(modules)
    expect(result.available, 'the production reporter must be importable').toBe(true)
    expect(result.output).toBe('{"schemaVersion":1,"status":"FAIL","tests":{"files":5,"tests":9,"passed":6,"failed":1,"skipped":1,"todo":1},"requiredCases":["migration","current-schema","future-schema","legacy-safety","sentinel-redaction","diagnostics-bounds"]}\n')
    expect(result.output).not.toMatch(/private|\.test\.ts|\\|\//u)
    expect(result.exitCode).toBe(1)
  })

  it.each([
    ['empty discovery', [], [], 'passed'],
    ['collection failure', [reporterModule('tests/private-collection.test.ts', [], 'failed')], [], 'failed'],
    ['unhandled error', passingReporterModules(), [{ message: 'private unhandled detail' }], 'passed'],
    ['interrupted reason', passingReporterModules(), [], 'interrupted'],
    ['queued reviewed case', [reporterModule(requiredCaseFixtures[0][1], [{ fullName: requiredCaseFixtures[0][2], state: 'passed' }], 'queued')], [], 'passed'],
    ['collapsed hierarchy', [reporterModule(requiredCaseFixtures[0][1], [{ fullName: 'SQLite migration  backs up the legacy JSON before importing it', state: 'passed' }])], [], 'passed'],
    ['different nesting', [reporterModule(requiredCaseFixtures[0][1], [{ fullName: `outer > ${requiredCaseFixtures[0][2]}`, state: 'passed' }])], [], 'passed'],
    ['wrong module', [reporterModule('wrong/Migration.test.ts', [{ fullName: requiredCaseFixtures[0][2], state: 'passed' }])], [], 'passed'],
    ['duplicate predicate', [...passingReporterModules(), reporterModule(requiredCaseFixtures[0][1], [{ fullName: requiredCaseFixtures[0][2], state: 'passed' }])], [], 'passed'],
  ])('fails closed for %s and emits no private detail', async (_label, modules, errors, reason) => {
    const result = await captureReporterRun(modules, errors, reason)
    expect(result.available, 'the production reporter must be importable').toBe(true)
    expect(result.output.endsWith('\n')).toBe(true)
    expect(result.output.split('\n')).toHaveLength(2)
    const summary = JSON.parse(result.output) as { status: string, tests: { files: number, tests: number }, requiredCases: string[] }
    expect(summary.status).toBe('FAIL')
    expect(summary.tests.files).toBeGreaterThanOrEqual(0)
    expect(summary.tests.tests).toBeGreaterThanOrEqual(0)
    expect(new Set(summary.requiredCases).size).toBe(summary.requiredCases.length)
    expect(result.output).not.toMatch(/private|unhandled|wrong\/|Migration\.test/u)
    expect(result.exitCode).toBe(1)
  })

  it('raises only an unset or zero exit code and preserves an existing nonzero code', async () => {
    const missing = passingReporterModules().slice(1)
    expect((await captureReporterRun(missing, [], 'passed', undefined)).exitCode).toBe(1)
    expect((await captureReporterRun(missing, [], 'passed', 0)).exitCode).toBe(1)
    expect((await captureReporterRun(missing, [], 'passed', 130)).exitCode).toBe(130)
  })

  it('uses its module-owned repository root during a real installed Vitest 3.2.7 invocation', async () => {
    const parent = path.join(workspaceRoot, 'release-validation', 'task2c1-reporter-fixtures')
    await fs.mkdir(parent, { recursive: true })
    const alternateCwd = await fs.mkdtemp(path.join(parent, 'cwd-'))
    disposableRoots.push(alternateCwd)
    const result = await runRealVitestReporter(alternateCwd)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.endsWith('\n')).toBe(true)
    expect(result.stdout.slice(0, -1)).not.toMatch(/[\r\n]/u)
    const summary = JSON.parse(result.stdout) as { status: string, tests: { files: number, tests: number, failed: number, skipped: number, todo: number }, requiredCases: string[] }
    expect(summary).toMatchObject({ status: 'PASS', tests: { files: 4, failed: 0, skipped: 0, todo: 0 } })
    expect(summary.tests.tests).toBeGreaterThanOrEqual(6)
    expect(summary.requiredCases).toEqual(requiredCaseFixtures.map(([id]) => id))
    expect(result.stdout).not.toContain(workspaceRoot)
  }, 120_000)

  it('fails closed instead of reporting a saturated count as exact', async () => {
    const increment = await extractedReporterIncrement()
    expect(() => increment(2_147_483_647)).toThrow('Reporter count overflow.')
  })
})

describe('strict descriptor-owned machine result parsers', () => {
  const completeIds = ['migration', 'current-schema', 'future-schema', 'legacy-safety', 'sentinel-redaction', 'diagnostics-bounds']
  const passSummary = '{"schemaVersion":1,"status":"PASS","tests":{"files":4,"tests":6,"passed":6,"failed":0,"skipped":0,"todo":0},"requiredCases":["migration","current-schema","future-schema","legacy-safety","sentinel-redaction","diagnostics-bounds"]}\n'
  const failSummary = '{"schemaVersion":1,"status":"FAIL","tests":{"files":0,"tests":0,"passed":0,"failed":0,"skipped":0,"todo":0},"requiredCases":[]}\n'

  it('preserves real uint32 exits and applies machine status/exit consistency before child classification', async () => {
    const parse = await extractedMachineParser()
    expect(parse({ parser: 'zero-exit' }, { status: 'PASS', exitCode: 0xffff_ffff, stdout: Buffer.alloc(0) })).toEqual({ status: 'FAIL', category: 'child-nonzero', exitCode: 0xffff_ffff })
    expect(parse({ parser: 'vitest-preflight-json' }, { status: 'PASS', exitCode: 0, stdout: Buffer.from(passSummary) })).toEqual({
      status: 'PASS', category: null, exitCode: 0,
      tests: { files: 4, tests: 6, passed: 6, failed: 0, skipped: 0, todo: 0 },
      requiredCases: completeIds,
    })
    expect(parse({ parser: 'vitest-preflight-json' }, { status: 'PASS', exitCode: 0xffff_ffff, stdout: Buffer.from(failSummary) })).toEqual({
      status: 'FAIL', category: 'child-nonzero', exitCode: 0xffff_ffff,
      tests: { files: 0, tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0 }, requiredCases: [],
    })
    expect(parse({ parser: 'vitest-preflight-json' }, { status: 'PASS', exitCode: 0, stdout: Buffer.from(failSummary) })).toEqual({ status: 'FAIL', category: 'invalid-output', exitCode: null })
    expect(parse({ parser: 'vitest-preflight-json' }, { status: 'PASS', exitCode: 7, stdout: Buffer.from(passSummary) })).toEqual({ status: 'FAIL', category: 'invalid-output', exitCode: null })
  })

  it.each([
    ['BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(passSummary)])],
    ['invalid UTF-8', Buffer.from([0xff, 0x0a])],
    ['CRLF', Buffer.from(passSummary.replace(/\n$/u, '\r\n'))],
    ['missing LF', Buffer.from(passSummary.slice(0, -1))],
    ['second object', Buffer.from(`${passSummary}${passSummary}`)],
    ['duplicate nested key', Buffer.from(passSummary.replace('"files":4', '"files":4,"files":4'))],
    ['reordered top-level keys', Buffer.from(passSummary.replace('{"schemaVersion":1,"status":"PASS"', '{"status":"PASS","schemaVersion":1'))],
    ['reordered count keys', Buffer.from(passSummary.replace('"files":4,"tests":6', '"tests":6,"files":4'))],
    ['raw path key', Buffer.from(passSummary.replace('"requiredCases"', '"rawPath":"C:/private","requiredCases"'))],
  ])('rejects reporter %s framing/schema drift without returning summary data', async (_label, bytes) => {
    const parse = await extractedMachineParser()
    expect(parse({ parser: 'vitest-preflight-json' }, { status: 'PASS', exitCode: 1, stdout: bytes })).toEqual({ status: 'FAIL', category: 'invalid-output', exitCode: null })
  })

  it.each([
    ['leading JSON whitespace', Buffer.from(` ${passSummary}`)],
    ['trailing JSON whitespace', Buffer.from(passSummary.replace(/\n$/u, ' \n'))],
  ])('rejects reporter %s even when its PASS payload agrees with child exit zero', async (_label, bytes) => {
    const parse = await extractedMachineParser()
    expect(parse({ parser: 'vitest-preflight-json' }, { status: 'PASS', exitCode: 0, stdout: bytes }))
      .toEqual({ status: 'FAIL', category: 'invalid-output', exitCode: null })
  })

  it.each([
    ['BOM', Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d, 0x0a])],
    ['CRLF', Buffer.from('{}\r\n')],
    ['no LF', Buffer.from('{}')],
    ['duplicate key', Buffer.from('{"runtime":"node","runtime":"electron"}\n')],
    ['multiple objects', Buffer.from('{}\n{}\n')],
    ['invalid UTF-8', Buffer.from([0xff, 0x0a])],
    ['leading JSON whitespace', Buffer.from(' {}\n')],
    ['trailing JSON whitespace', Buffer.from('{} \n')],
  ])('rejects native ABI %s framing before JSON is exposed', async (_label, bytes) => {
    const parse = await extractedMachineParser()
    expect(parse({ parser: 'native-abi-json' }, { status: 'PASS', exitCode: 0, stdout: bytes })).toEqual({ status: 'FAIL', category: 'invalid-output', exitCode: null })
  })

  it('returns the real child observation shape for every successful parser category, including quiet exit 1 as data', async () => {
    const parse = await extractedMachineParser()
    expect(parse({ parser: 'quiet-exit' }, { status: 'PASS', exitCode: 0, stdout: Buffer.alloc(0) }))
      .toEqual({ status: 'PASS', category: null, exitCode: 0, clean: true })
    expect(parse({ parser: 'quiet-exit' }, { status: 'PASS', exitCode: 1, stdout: Buffer.alloc(0) }))
      .toEqual({ status: 'PASS', category: null, exitCode: 1, clean: false })
    expect(parse({ parser: 'clean-status' }, { status: 'PASS', exitCode: 0, stdout: Buffer.alloc(0) }))
      .toEqual({ status: 'PASS', category: null, exitCode: 0, clean: true })
    expect(parse({ parser: 'node-version' }, { status: 'PASS', exitCode: 0, stdout: Buffer.from('v24.15.0\r\n') }))
      .toEqual({ status: 'PASS', category: null, exitCode: 0, value: 'v24.15.0' })
    expect(parse({ parser: 'native-abi-json' }, { status: 'PASS', exitCode: 0, stdout: Buffer.from('{"runtime":"node"}\n') }))
      .toEqual({ status: 'PASS', category: null, exitCode: 0, result: { runtime: 'node' } })
  })
})

describe('reviewed release toolchain policy', () => {
  it('loads the exact reviewed contract as strict UTF-8 and deeply freezes it', async () => {
    const bytes = await fs.readFile(policyPath)
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false)
    expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toBeTruthy()

    const runner = await import(`${runnerUrl.href}?policy=${Date.now()}`)
    expect(runner.loadReleaseToolchainPolicy.length).toBe(0)
    const policy = await runner.loadReleaseToolchainPolicy()
    expect(policy).toMatchObject({
      schemaVersion: 1,
      platform: 'win32',
      architecture: 'x64',
      ownerReviewRequired: true,
      node: {
        version: 'v24.15.0',
        sha256: '3331e1ffe19874215472217c5e94f5a0c6d8e18c4ac7111d3937aa0ad5e9b4a5',
      },
      nativeAbi: {
        hostNode: { nodeVersion: 'v24.15.0', modulesAbi: '137', napi: '10', platform: 'win32', arch: 'x64' },
        electron: { electronVersion: '35.7.5', nodeVersion: 'v22.16.0', modulesAbi: '133', napi: '10', platform: 'win32', arch: 'x64' },
        sqlite: {
          packageName: 'better-sqlite3',
          packageVersion: '13.0.2',
          loaderRelativePath: 'node_modules/better-sqlite3/lib/win32-x64.js',
          nativeRelativePath: 'node_modules/better-sqlite3/prebuilds/win32-x64.node',
          nativeSha256: 'ecfb86221a674a6cdba63b1ac162b99386a61d0e38934b6c3dfcd9da11b6ee26',
          sqliteVersion: '3.53.4',
        },
      },
      npm: {
        version: '11.12.1',
        fileCount: 1740,
        totalBytes: 10_520_303,
        treeSha256: 'a2b5872e8b827228d641001876d85ecd661ef9786f0a997923b27d3aa0a1b302',
      },
      git: {
        version: '2.44.0.windows.1',
        fileCount: 292,
        totalBytes: 187_055_518,
        treeSha256: '249a931b5352181774f454e5c96e72fe4d39bdbf530b5713fe2cd8ef16d42ef5',
      },
    })
    expect(Object.isFrozen(policy.nativeAbi)).toBe(true)
    expect(Object.isFrozen(policy.nativeAbi.hostNode)).toBe(true)
    expect(Object.isFrozen(policy.nativeAbi.electron)).toBe(true)
    expect(Object.isFrozen(policy.nativeAbi.sqlite)).toBe(true)
    expect(policy.dependencyBootstrap.lifecyclePayloads).toEqual([
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
    ])
    expect(policy.dependencyBootstrap.preLifecycleTree).toEqual({
      fileCount: 26_863,
      totalBytes: 673_636_131,
      treeSha256: '075e9bc083e4e2010b46f97b31c5a07c8b4ee5dbbd825e572f2252c578f6e939',
    })
    expect(policy.dependencyBootstrap.finalTree).toEqual({
      fileCount: 26_939,
      totalBytes: 973_620_188,
      treeSha256: '7cfa28860bfdce9c3ddc289b1aefcb84989eb84cb88585ac95021110a0349a39',
    })
    expect(policy.dependencyBootstrap.electronExecutableSha256).toBe(
      '588bd82e36ad1acdae4615b6336284e420704389864f54ef2d10ea66c1a3cde0',
    )
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.node)).toBe(true)
    expect(Object.isFrozen(policy.dependencyBootstrap)).toBe(true)
    expect(Object.isFrozen(policy.dependencyBootstrap.lifecyclePayloads)).toBe(true)
    expect(Object.isFrozen(policy.dependencyBootstrap.lifecyclePayloads[0])).toBe(true)
    await expect(runner.loadReleaseToolchainPolicy({})).rejects.toThrow('Release toolchain policy request is invalid.')
  })

  it.each([
    ['BOM', (text: string) => `\ufeff${text}`],
    ['duplicate decoded key', (text: string) => text.replace('"schemaVersion": 1,', '"schemaVersion": 1,\n  "schemaVersion": 1,')],
    ['unknown deep key', (text: string) => text.replace('"version": "v24.15.0",', '"version": "v24.15.0",\n    "unknown": true,')],
    ['missing native ABI key', (text: string) => text.replace('      "napi": "10",\n      "platform": "win32",', '      "platform": "win32",')],
    ['extra native ABI key', (text: string) => text.replace('      "modulesAbi": "137",', '      "modulesAbi": "137",\n      "unknown": true,')],
    ['reordered native ABI keys', (text: string) => text.replace('      "nodeVersion": "v24.15.0",\n      "modulesAbi": "137",', '      "modulesAbi": "137",\n      "nodeVersion": "v24.15.0",')],
    ['reordered native ABI outer keys', (text: string) => {
      const policy = JSON.parse(text)
      policy.nativeAbi = { electron: policy.nativeAbi.electron, hostNode: policy.nativeAbi.hostNode, sqlite: policy.nativeAbi.sqlite }
      return JSON.stringify(policy)
    }],
    ['wrong native ABI type', (text: string) => text.replace('"modulesAbi": "137"', '"modulesAbi": 137')],
    ['wrong native ABI platform', (text: string) => text.replace('"platform": "win32",\n      "arch": "x64"', '"platform": "linux",\n      "arch": "x64"')],
    ['wrong native loader path', (text: string) => text.replace('node_modules/better-sqlite3/lib/win32-x64.js', '../unreviewed.js')],
    ['wrong native binary hash', (text: string) => text.replace('ecfb86221a67', 'aaaaaaaaaaaa')],
    ['wrong SQLite version', (text: string) => text.replace('"sqliteVersion": "3.53.4"', '"sqliteVersion": "3.53.5"')],
    ['empty lifecycle list', (text: string) => text.replace(/"lifecyclePayloads": \[[\s\S]*?\n    \],\n    "finalTree"/u, '"lifecyclePayloads": [],\n    "finalTree"')],
    ['changed reviewed hash', (text: string) => text.replace('3331e1ffe198', 'aaaaaaaaaaaa')],
  ])('rejects %s without a caller-selected policy path', async (_label, mutate) => {
    const original = await fs.readFile(policyPath, 'utf8')
    const url = await copyRunnerWorkspace(Buffer.from(mutate(original), 'utf8'))
    const runner = await import(`${url.href}?mutation=${crypto.randomUUID()}`)
    await expect(runner.loadReleaseToolchainPolicy()).rejects.toThrow('Release toolchain policy is invalid.')
  })

  it('rejects invalid UTF-8 in the fixed policy bytes', async () => {
    const original = await fs.readFile(policyPath)
    const url = await copyRunnerWorkspace(Buffer.concat([original.subarray(0, 20), Buffer.from([0xff]), original.subarray(21)]))
    const runner = await import(`${url.href}?native-policy-utf8=${crypto.randomUUID()}`)
    await expect(runner.loadReleaseToolchainPolicy()).rejects.toThrow('Release toolchain policy is invalid.')
  })
})

describe('trusted Windows runner production surface', () => {
  it('exports only the zero-argument loader and one-primitive-string runner', async () => {
    const runner = await import(`${runnerUrl.href}?exports=${Date.now()}`)
    expect(Object.keys(runner).sort()).toEqual(['loadReleaseToolchainPolicy', 'runTrustedWindowsCommand'])
    expect(runner.loadReleaseToolchainPolicy.length).toBe(0)
    expect(runner.runTrustedWindowsCommand.length).toBe(1)
    await expect(runner.runTrustedWindowsCommand('node-version', {})).rejects.toThrow('Trusted command descriptor is invalid.')
    await expect(runner.runTrustedWindowsCommand(new String('node-version'))).rejects.toThrow('Trusted command descriptor is invalid.')
    await expect(runner.runTrustedWindowsCommand('runner-fixture-timeout-tree')).rejects.toThrow('Trusted command descriptor is invalid.')
    await expect(runner.runTrustedWindowsCommand('not-a-descriptor')).rejects.toThrow('Trusted command descriptor is invalid.')
  })

  it('contains three unique exact-source bindings and no production fixture or injection seam', async () => {
    const source = await fs.readFile(runnerPath, 'utf8')
    const controller = extractBetween(source, CONTROLLER_START, CONTROLLER_END)
    const descriptors = extractBetween(source, DESCRIPTORS_START, DESCRIPTORS_END)
    const parent = extractBetween(source, PARENT_START, PARENT_END)

    expect(controller.length).toBeGreaterThan(10_000)
    expect(descriptors.length).toBeGreaterThan(2_000)
    expect(parent.length).toBeGreaterThan(1_500)
    expect(source).not.toMatch(/tdd-evidence|runner-fixture-|\bdeps\b|invokeController|validateClosure|options\s*=|Add-Type|ReadToEnd(?:Async)?/u)
    expect([...source.matchAll(/from\s+['"]([^'"]+)['"]/gu)].every((match) => match[1].startsWith('node:'))).toBe(true)
  })

  it('freezes the complete production descriptor matrix and never includes a test command', async () => {
    const source = await fs.readFile(runnerPath, 'utf8')
    const block = extractBetween(source, DESCRIPTORS_START, DESCRIPTORS_END)
    const match = /const DESCRIPTOR_ROWS_JSON = String\.raw`([\s\S]*?)`;/u.exec(block)
    expect(match).not.toBeNull()
    const rows = JSON.parse(match?.[1] ?? 'null') as Array<{ id: string, argv: string[], environment: Record<string, string> }>
    expect(rows).toEqual(expectedDescriptorRows)
    expect(crypto.createHash('sha256').update(Buffer.from(match?.[1] ?? '', 'utf8')).digest('hex')).toBe(
      expectedDescriptorLiteralSha256,
    )
    expect(rows.map((row) => row.id)).toEqual(expectedDescriptorIds)
    expect(new Set(rows.map((row) => row.id).map((id) => id.toLowerCase())).size).toBe(rows.length)
    expect(rows.every((row) => Array.isArray(row.argv) && row.environment && typeof row.environment === 'object')).toBe(true)
    expect(rows.every((row) => Object.keys(row).sort().join(',') === [
      'argv', 'closureClass', 'cwdClass', 'environment', 'executableClass', 'id', 'parser', 'stderrLimit', 'stdoutLimit', 'timeoutMs',
    ].sort().join(','))).toBe(true)
    expect(JSON.stringify(rows)).not.toMatch(/fixture|--publish(?!","never)/iu)
    expect(rows.find((row) => row.id === 'npm-ci-ignore-scripts')?.argv).toEqual([
      'ci',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ])
    const builderArgv = rows.find((row) => row.id === 'electron-builder-win')?.argv
    expect(builderArgv?.[0]).toBe('node_modules/electron-builder/cli.js')
    expect(builderArgv?.slice(1)).toEqual(['--win', '--publish', 'never'])
    expect(rows.find((row) => row.id === 'electron-abi-probe')?.environment).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
    expect(rows.find((row) => row.id === 'build-main')?.environment).toEqual({
      SOURCE_DATE_EPOCH: '@release-metadata-epoch',
      WORKBENCH_RELEASE_METADATA_PATH: '@fixed-release-metadata',
    })
    expect(block).toContain(`const DESCRIPTOR_ROWS_SHA256 = '${expectedDescriptorLiteralSha256}'`)
    expect(block).toContain('validateDescriptorRows(DESCRIPTOR_ROWS_JSON, DESCRIPTOR_ROWS_SHA256)')
    expect(block).not.toContain('deepFreeze(JSON.parse(DESCRIPTOR_ROWS_JSON))')
  })

  it('binds the baseline matrix and proves test-full is the sole 34-row delta', async () => {
    const oracleSource = await fs.readFile(fileURLToPath(import.meta.url), 'utf8')
    const oracleStart = oracleSource.indexOf("it('binds the baseline matrix and proves test-full is the sole 34-row delta'")
    const oracleEnd = oracleSource.indexOf("it('matches the existing-marker canonical tree serializer", oracleStart)
    const commitBindingPattern = new RegExp(['const task2c1a', "Baseline = '[a-f0-9]{40}'"].join(''), 'u')
    const historyLookup = ['runFixtureGit(workspaceRoot, ', "['show'"].join('')
    expect(oracleSource).not.toMatch(commitBindingPattern)
    expect(oracleSource.slice(oracleStart, oracleEnd)).not.toContain(historyLookup)

    const source = await fs.readFile(runnerPath, 'utf8')
    const currentLiteral = /const DESCRIPTOR_ROWS_JSON = String\.raw`([\s\S]*?)`;/u.exec(source)?.[1] ?? ''
    expect(crypto.createHash('sha256').update(Buffer.from(currentLiteral, 'utf8')).digest('hex')).toBe(expectedDescriptorLiteralSha256)
    expect(crypto.createHash('sha256').update(Buffer.from(baselineDescriptorRowsJson, 'utf8')).digest('hex')).toBe(baselineDescriptorLiteralSha256)

    const currentRows = JSON.parse(currentLiteral) as ExpectedDescriptorRow[]
    const baselineRows = JSON.parse(baselineDescriptorRowsJson) as ExpectedDescriptorRow[]
    expect(currentRows).toHaveLength(34)
    expect(baselineRows).toHaveLength(34)
    const changedIndexes = baselineRows.flatMap((baseline, index) => (
      JSON.stringify(baseline) === JSON.stringify(currentRows[index]) ? [] : [index]
    ))
    expect(changedIndexes).toEqual([baselineRows.findIndex((row) => row.id === 'test-full')])
    for (const [index, baseline] of baselineRows.entries()) {
      if (baseline.id === 'test-full') continue
      expect(currentRows[index], `baseline descriptor row ${index}:${baseline.id}`).toEqual(baseline)
    }
    expect(baselineRows.find((row) => row.id === 'test-full')).toEqual(expectedRow(
      'test-full', 'node-workspace', ['node_modules/vitest/vitest.mjs', 'run'], 'candidate', {}, 900_000,
      4_194_304, 1_048_576, 'workspace-final', 'zero-exit',
    ))
    expect(currentRows.find((row) => row.id === 'test-full')).toEqual(expectedRow(
      'test-full', 'node-workspace', ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.config.ts', '--no-cache', '--silent', '--reporter=./scripts/release/vitest-preflight-reporter.mjs'],
      'candidate', {}, 900_000, 4_194_304, 1_048_576, 'workspace-final', 'vitest-preflight-json',
    ))
  })

  it('keeps the locked Vitest node_modules cache tree byte-identical when cache state is absent or pre-existing', async () => {
    const vitestPackage = JSON.parse(await fs.readFile(path.join(workspaceRoot, 'node_modules', 'vitest', 'package.json'), 'utf8')) as { version?: unknown }
    expect(vitestPackage.version).toBe('3.2.7')

    const source = await fs.readFile(runnerPath, 'utf8')
    const literal = /const DESCRIPTOR_ROWS_JSON = String\.raw`([\s\S]*?)`;/u.exec(source)?.[1] ?? '[]'
    const rows = JSON.parse(literal) as ExpectedDescriptorRow[]
    const testFullArgv = rows.find((row) => row.id === 'test-full')?.argv ?? []
    expect(testFullArgv).toEqual([
      'node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      'vitest.config.ts',
      '--no-cache',
      '--silent',
      '--reporter=./scripts/release/vitest-preflight-reporter.mjs',
    ])

    const defaultFixture = await createLockedVitestCacheFixture('default-cache')
    const defaultBefore = await snapshotNodeModulesTree(defaultFixture.nodeModulesRoot)
    const defaultResult = await runLockedVitestCacheFixture(defaultFixture.root, false)
    expect(defaultResult, defaultResult.stderr).toEqual({ code: 0, stderr: '' })
    const defaultAfter = await snapshotNodeModulesTree(defaultFixture.nodeModulesRoot)
    expect(defaultAfter).not.toEqual(defaultBefore)
    const createdResults = defaultAfter.relativePaths.filter((relativePath) => relativePath.endsWith('/results.json'))
    expect(createdResults).toHaveLength(1)

    const emptyFixture = await createLockedVitestCacheFixture('no-cache-empty')
    const emptyBefore = await snapshotNodeModulesTree(emptyFixture.nodeModulesRoot)
    const emptyResult = await runLockedVitestCacheFixture(emptyFixture.root, testFullArgv.includes('--no-cache'))
    expect(emptyResult, emptyResult.stderr).toEqual({ code: 0, stderr: '' })
    expect(await snapshotNodeModulesTree(emptyFixture.nodeModulesRoot)).toEqual(emptyBefore)

    const seededFixture = await createLockedVitestCacheFixture('no-cache-seeded')
    const sentinelPath = path.join(seededFixture.nodeModulesRoot, ...createdResults[0].split('/'))
    const sentinelBytes = Buffer.from('{"version":"sentinel","results":[["protected",{"duration":7,"failed":false}]]}', 'utf8')
    await fs.mkdir(path.dirname(sentinelPath), { recursive: true })
    await fs.writeFile(sentinelPath, sentinelBytes)
    const seededBefore = await snapshotNodeModulesTree(seededFixture.nodeModulesRoot)
    const seededResult = await runLockedVitestCacheFixture(seededFixture.root, testFullArgv.includes('--no-cache'))
    expect(seededResult, seededResult.stderr).toEqual({ code: 0, stderr: '' })
    expect(await snapshotNodeModulesTree(seededFixture.nodeModulesRoot)).toEqual(seededBefore)
    expect(await fs.readFile(sentinelPath)).toEqual(sentinelBytes)
  }, 180_000)

  it('matches the existing-marker canonical tree serializer to independent exact bytes and hash', async () => {
    const parent = path.join(workspaceRoot, 'release-validation', 'task2c1-controller-fixtures')
    await fs.mkdir(parent, { recursive: true })
    const root = await fs.mkdtemp(path.join(parent, 'canonical-tree-'))
    disposableRoots.push(root)
    await fs.mkdir(path.join(root, 'nested'))
    await fs.writeFile(path.join(root, 'a.txt'), 'A')
    await fs.writeFile(path.join(root, 'B.txt'), 'B')
    await fs.writeFile(path.join(root, 'nested', 'c.bin'), 'C')
    const expectedBytes = '[{"relativePath":"B.txt","size":1,"fileSha256":"df7e70e5021544f4834bbee64a9e3789febc4be81470df629cad6ddb03320a5c"},{"relativePath":"a.txt","size":1,"fileSha256":"559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd"},{"relativePath":"nested/c.bin","size":1,"fileSha256":"6b23c0d5f35d1b11f9b683f0b0a617355deb11277d91ae091d399c655b87940d"}]\n'
    const expectedTreeSha256 = crypto.createHash('sha256').update(Buffer.from(expectedBytes, 'utf8')).digest('hex')
    expect(expectedTreeSha256).toBe('cb0d4794516d64c29fd0e3001ac05e1e7d1314fac19401fe337eab07bb0142c5')
    await expect(runExtractedCanonicalTree(root, ['nested/c.bin', 'a.txt', 'B.txt'])).resolves.toEqual({
      fileCount: 3, totalBytes: 3, treeSha256: expectedTreeSha256,
    })
  }, 30_000)

  it.runIf(process.platform === 'win32')('holds all nine alternate-case test-full inputs through execution and releases them after receipt without public leakage', async () => {
    const fixture = await createTestFullRunnerWorkspace('normal')
    expect(await checkNodeSyntax(fixture.actualInputs[0])).toEqual({ code: 0, stderr: '' })
    const runner = await import(`${fixture.runnerUrl.href}?held-inputs=${crypto.randomUUID()}`)
    const pending = runner.runTrustedWindowsCommand('test-full')
    const first = await Promise.race([
      pending.then((result) => ({ kind: 'result' as const, result })),
      waitForFile(fixture.markerPath).then(() => ({ kind: 'marker' as const })),
    ])
    expect(first, 'the copied test-full child must reach the held-handle observation').toEqual({ kind: 'marker' })
    expect(JSON.parse(await fs.readFile(fixture.markerPath, 'utf8'))).toEqual({
      held: Array(9).fill(true),
      argv: [
        'run',
        '--config',
        'vitest.config.ts',
        '--no-cache',
        '--silent',
        '--reporter=./scripts/release/vitest-preflight-reporter.mjs',
      ],
    })
    await fs.writeFile(fixture.releasePath, 'release\n')
    const result = await pending
    expect(result).toEqual({
      status: 'PASS', category: null, exitCode: 0,
      tests: { files: 4, tests: 6, passed: 6, failed: 0, skipped: 0, todo: 0 },
      requiredCases: requiredCaseFixtures.map(([id]) => id),
    })
    const publicBytes = JSON.stringify(result)
    expect(publicBytes).not.toContain(fixture.root)
    for (const relativePath of testFullHeldInputs) expect(publicBytes).not.toContain(relativePath)
    for (const [, , fullName] of requiredCaseFixtures) expect(publicBytes).not.toContain(fullName)
    for (const input of fixture.actualInputs) {
      const moved = `${input}.after-receipt`
      await fs.rename(input, moved)
      await fs.rename(moved, input)
    }
  }, 90_000)

  it.runIf(process.platform === 'win32')('rejects casefold ambiguity before test-full launch', async () => {
    const fixture = await createTestFullRunnerWorkspace('casefold-collision')
    const runner = await import(`${fixture.runnerUrl.href}?casefold-collision=${crypto.randomUUID()}`)
    await expect(runner.runTrustedWindowsCommand('test-full')).rejects.toThrow('Trusted command execution failed.')
    await expect(fs.stat(fixture.markerPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it.runIf(process.platform === 'win32')('detects a test-full input mutation after resolution and before launch', async () => {
    const fixture = await createTestFullRunnerWorkspace('prelaunch-mutation')
    const runner = await import(`${fixture.runnerUrl.href}?prelaunch-mutation=${crypto.randomUUID()}`)
    await expect(runner.runTrustedWindowsCommand('test-full')).resolves.toEqual({
      status: 'FAIL', category: 'cleanup-unconfirmed', exitCode: null,
    })
    await expect(fs.stat(fixture.markerPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 45_000)

  it('rejects a byte-valid descriptor literal mutation before exposing the production surface', async () => {
    const source = await fs.readFile(runnerPath, 'utf8')
    const mutated = source.replace('"timeoutMs":30000', '"timeoutMs":30001')
    expect(mutated).not.toBe(source)
    const url = await copyRunnerWorkspace(
      await fs.readFile(policyPath),
      Buffer.from(mutated, 'utf8'),
    )
    await expect(import(`${url.href}?descriptor-mutation=${crypto.randomUUID()}`)).rejects.toThrow(
      'Trusted command descriptor matrix is invalid.',
    )
  })

  it.each([
    ['a duplicate descriptor ID', (source: string) => source.replace('"id":"npm-version"', '"id":"node-version"')],
    ['an unknown descriptor field', (source: string) => source.replace('"parser":"node-version"}', '"parser":"node-version","unknown":true}')],
    ['a descriptor type drift', (source: string) => source.replace('"timeoutMs":30000', '"timeoutMs":"30000"')],
  ])('rejects %s even when the copied fixture synchronizes its literal hash', async (_label, mutate) => {
    const source = await fs.readFile(runnerPath, 'utf8')
    const mutated = synchronizeDescriptorHash(mutate(source))
    expect(mutated).not.toBe(source)
    const url = await copyRunnerWorkspace(await fs.readFile(policyPath), Buffer.from(mutated, 'utf8'))
    await expect(import(`${url.href}?descriptor-schema=${crypto.randomUUID()}`)).rejects.toThrow(
      'Trusted command descriptor matrix is invalid.',
    )
  })

  it('uses the revised suspended target and two-tier Job architecture', async () => {
    const source = await fs.readFile(runnerPath, 'utf8')
    const controller = extractBetween(source, CONTROLLER_START, CONTROLLER_END)
    expect(controller).toContain('Reflection.Emit')
    expect(controller).toContain('DefinePInvokeMethod')
    expect(controller).toContain('GetSystemDirectoryW')
    expect(controller).toContain('SHGetKnownFolderPath')
    expect(controller).toContain('GetFinalPathNameByHandleW')
    expect(controller).toContain('GetFileInformationByHandleEx')
    expect(controller).toContain('PROC_THREAD_ATTRIBUTE_HANDLE_LIST')
    expect(controller).toContain('OpenProcessToken')
    expect(controller).toContain('DuplicateToken')
    expect(controller).toContain('AccessCheck')
    expect(controller).toContain('MapGenericMask')
    expect(controller).toContain('[Security.AccessControl.CommonAce]')
    expect(controller).toContain("throw 'acl-unsupported'")
    expect(controller).toContain('[uint32]0x000D0156')
    expect(controller).toContain('[uint32]0x000D0040')
    expect(controller).toContain('CreateProcessW')
    expect(controller).toContain('CREATE_SUSPENDED')
    expect(controller).toContain('ResumeThread')
    expect(controller).toContain('TerminateJobObject')
    expect(controller).toContain('QueryInformationJobObject')
    expect(controller).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE')
    expect(controller).not.toContain('JOB_OBJECT_LIMIT_BREAKAWAY_OK')
    expect(controller).not.toContain('JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK')
    expect(controller).not.toContain('CREATE_BREAKAWAY_FROM_JOB')
    expect(controller).not.toContain('GetEffectiveRightsFromAclW')
    expect(controller.indexOf('$api::CreateProcessW')).toBeLessThan(controller.indexOf('$api::AssignProcessToJobObject($innerJob'))
    expect(controller.indexOf('$api::AssignProcessToJobObject($innerJob')).toBeLessThan(controller.indexOf('$api::ResumeThread($threadHandle)'))
  })

  it('binds the literal first host and makes unconfirmed parent cleanup fail closed', async () => {
    const source = await fs.readFile(runnerPath, 'utf8')
    const parent = extractBetween(source, PARENT_START, PARENT_END)
    expect(source).toContain("C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe")
    expect(parent).toContain('cleanup-unconfirmed')
    expect(source).toContain("'-EncodedCommand', ENCODED_LOADER")
    expect(source).toContain('shell: false')
    expect(source).not.toMatch(/\.\.\.process\.env|process\.env\.SystemRoot|process\.env\.WINDIR|process\.env\.ProgramFiles/iu)
    expect(source).not.toMatch(/process\.env\.(?:SOURCE_DATE_EPOCH|WORKBENCH_RELEASE_METADATA_PATH)/u)
    expect(source).toContain('validateReleaseMetadataForChild')
    expect(source).toContain('resolveReleaseBuildEnvironment')
    expect(source).toContain("value === '@fixed-release-metadata'")
    expect(source).toContain("value === '@release-metadata-epoch'")
    expect(parent).not.toMatch(/trim(?:End)?\(/u)
  })

  it('runs the exact extracted controller against the reviewed Node executable', async () => {
    const result = await runExactController(await controllerRequest())
    expect(result, JSON.stringify(result)).toMatchObject({ code: 0, stderr: '' })
    const receipt = JSON.parse(result.stdout)
    expect(receipt).toEqual({
      schemaVersion: 1,
      status: 'PASS',
      exitCode: 0,
      stdout: Buffer.from('v24.15.0\r\n').toString('base64'),
      cleanupConfirmed: true,
    })
  }, 40_000)

  it('runs the reviewed Node, npm, and Git probes through the public production boundary', async () => {
    const runner = await import(`${runnerUrl.href}?live-probes=${Date.now()}`)
    await expect(runner.runTrustedWindowsCommand('node-version')).resolves.toEqual({
      status: 'PASS',
      category: null,
      exitCode: 0,
      value: 'v24.15.0',
    })
    await expect(runner.runTrustedWindowsCommand('npm-version')).resolves.toEqual({
      status: 'PASS',
      category: null,
      exitCode: 0,
      value: '11.12.1',
    })
    await expect(runner.runTrustedWindowsCommand('git-version')).resolves.toEqual({
      status: 'PASS',
      category: null,
      exitCode: 0,
      value: 'git version 2.44.0.windows.1',
    })
  }, 180_000)

  it('suppresses a repository-local fsmonitor command before asking Git for status', async () => {
    const fixture = await createGitRunnerWorkspace()
    const hookPath = path.join(fixture.root, 'untrusted-fsmonitor.cmd')
    const markerPath = path.join(fixture.root, 'fsmonitor-executed.txt')
    await fs.writeFile(hookPath, [
      '@echo off',
      `> "${markerPath}" echo executed`,
      'echo/',
      '',
    ].join('\r\n'), 'utf8')
    await runFixtureGit(fixture.root, [
      'config',
      'core.fsmonitor',
      hookPath.replaceAll('\\', '/'),
    ])

    const runner = await import(`${fixture.runnerUrl.href}?fsmonitor=${crypto.randomUUID()}`)
    await expect(runner.runTrustedWindowsCommand('git-status')).resolves.toMatchObject({ status: 'PASS' })
    await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(runner.runTrustedWindowsCommand('git-config-audit')).resolves.toEqual({
      status: 'PASS',
      category: null,
      exitCode: 0,
      clean: false,
    })
  }, 180_000)

  it('detects hidden index flags even when ordinary Git status reports clean', async () => {
    const fixture = await createGitRunnerWorkspace()
    await runFixtureGit(fixture.root, ['update-index', '--assume-unchanged', 'tracked.txt'])
    await fs.writeFile(path.join(fixture.root, 'tracked.txt'), 'hidden mutation\n', 'utf8')

    const runner = await import(`${fixture.runnerUrl.href}?hidden-index=${crypto.randomUUID()}`)
    await expect(runner.runTrustedWindowsCommand('git-status')).resolves.toEqual({
      status: 'PASS',
      category: null,
      exitCode: 0,
      clean: true,
    })
    await expect(runner.runTrustedWindowsCommand('git-index-audit')).resolves.toEqual({
      status: 'PASS',
      category: null,
      exitCode: 0,
      clean: false,
    })
  }, 180_000)

  it('audits candidate and private main Git facts without changing either index', async () => {
    const mainRoot = await reviewedMainWorktree()
    const candidateIndex = await gitIndexPath(workspaceRoot)
    const mainIndex = await gitIndexPath(mainRoot)
    const before = {
      candidate: await gitIndexSnapshot(candidateIndex),
      main: await gitIndexSnapshot(mainIndex),
    }
    const runner = await import(`${runnerUrl.href}?git-read-only=${crypto.randomUUID()}`)
    for (const id of ['git-config-audit', 'git-index-audit', 'git-replace-audit', 'git-main-config-audit', 'git-main-index-audit']) {
      await expect(runner.runTrustedWindowsCommand(id), id).resolves.toEqual({ status: 'PASS', category: null, exitCode: 0, clean: true })
    }
    expect({
      candidate: await gitIndexSnapshot(candidateIndex),
      main: await gitIndexSnapshot(mainIndex),
    }).toEqual(before)
  }, 240_000)

  it('reports a replacement ref without allowing it to affect Git object reads', async () => {
    const fixture = await createGitRunnerWorkspace()
    await fs.writeFile(path.join(fixture.root, 'tracked.txt'), 'second commit\n', 'utf8')
    await runFixtureGit(fixture.root, ['add', 'tracked.txt'])
    await runFixtureGit(fixture.root, ['-c', 'core.hooksPath=NUL', 'commit', '--no-gpg-sign', '-m', 'second'])
    const head = (await runFixtureGit(fixture.root, ['rev-parse', 'HEAD'])).trim()
    const parent = (await runFixtureGit(fixture.root, ['rev-parse', 'HEAD^'])).trim()
    await runFixtureGit(fixture.root, ['update-ref', `refs/replace/${head}`, parent])

    const runner = await import(`${fixture.runnerUrl.href}?replace-ref=${crypto.randomUUID()}`)
    await expect(runner.runTrustedWindowsCommand('git-replace-audit')).resolves.toEqual({ status: 'PASS', category: null, exitCode: 0, clean: false })
    await expect(runner.runTrustedWindowsCommand('git-head')).resolves.toEqual({ status: 'PASS', category: null, exitCode: 0, commitSha: head })
  }, 180_000)

  it('derives the real child metadata path and epoch from the fixed snapshot while holding it through receipt', async () => {
    const fixture = await createMetadataRunnerWorkspace(Buffer.from(`${JSON.stringify(validReleaseMetadata)}\n`, 'utf8'))
    const previousEpoch = process.env.SOURCE_DATE_EPOCH
    const previousMetadataPath = process.env.WORKBENCH_RELEASE_METADATA_PATH
    process.env.SOURCE_DATE_EPOCH = '1'
    process.env.WORKBENCH_RELEASE_METADATA_PATH = 'C:\\untrusted\\release-metadata.json'
    try {
      const runner = await import(`${fixture.runnerUrl.href}?metadata-env=${crypto.randomUUID()}`)
      await expect(runner.runTrustedWindowsCommand('node-version')).resolves.toEqual({ status: 'PASS', category: null, exitCode: 0, value: 'v24.15.0' })
    } finally {
      if (previousEpoch === undefined) delete process.env.SOURCE_DATE_EPOCH
      else process.env.SOURCE_DATE_EPOCH = previousEpoch
      if (previousMetadataPath === undefined) delete process.env.WORKBENCH_RELEASE_METADATA_PATH
      else process.env.WORKBENCH_RELEASE_METADATA_PATH = previousMetadataPath
    }
    expect(JSON.parse(await fs.readFile(fixture.markerPath, 'utf8'))).toEqual({
      metadataPath: fixture.metadataPath,
      sourceDateEpoch: '1786538096',
      renameSucceeded: false,
      lockCode: expect.stringMatching(/^(?:EACCES|EBUSY|EPERM)$/u),
    })
    const moved = `${fixture.metadataPath}.after-receipt`
    await fs.rename(fixture.metadataPath, moved)
    await fs.rename(moved, fixture.metadataPath)
  }, 60_000)

  it.each([
    ['a BOM', () => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(validReleaseMetadata))])],
    ['invalid UTF-8', () => Buffer.from([0xc3, 0x28])],
    ['a duplicate key', () => Buffer.from(JSON.stringify(validReleaseMetadata).replace('"metadataSchemaVersion":1', '"metadataSchemaVersion":1,"metadataSchemaVersion":1'))],
    ['an unknown key', () => Buffer.from(JSON.stringify({ ...validReleaseMetadata, unknown: true }))],
    ['a missing key', () => {
      const { buildId: _removed, ...metadata } = validReleaseMetadata
      return Buffer.from(JSON.stringify(metadata))
    }],
    ['a wrong field type', () => Buffer.from(JSON.stringify({ ...validReleaseMetadata, dirty: 'false' }))],
    ['a noncanonical timestamp', () => Buffer.from(JSON.stringify({ ...validReleaseMetadata, buildTimeUtc: '2026-08-12T12:34:56.000Z' }))],
    ['an invalid calendar timestamp', () => Buffer.from(JSON.stringify({ ...validReleaseMetadata, buildTimeUtc: '2026-02-30T12:34:56Z' }))],
    ['a mismatched Build ID', () => Buffer.from(JSON.stringify({ ...validReleaseMetadata, buildId: '1.0.1-rc.1+wrong' }))],
  ])('refuses metadata with %s before the target can start', async (_label, bytes) => {
    const fixture = await createMetadataRunnerWorkspace(bytes())
    const runner = await import(`${fixture.runnerUrl.href}?metadata-invalid=${crypto.randomUUID()}`)
    await expect(runner.runTrustedWindowsCommand('node-version')).rejects.toThrow('Trusted command execution failed.')
    await expect(fs.stat(fixture.markerPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it.runIf(process.platform === 'win32')('rejects a reparse-point metadata parent before target creation', async () => {
    const fixture = await createMetadataRunnerWorkspace(Buffer.from(`${JSON.stringify(validReleaseMetadata)}\n`, 'utf8'))
    const outside = await fs.mkdtemp(path.join(path.dirname(fixture.root), 'metadata-outside-'))
    disposableRoots.push(outside)
    const staging = path.dirname(fixture.metadataPath)
    const outsideMetadata = path.join(outside, 'release-metadata.json')
    await fs.writeFile(outsideMetadata, `${JSON.stringify(validReleaseMetadata)}\n`, 'utf8')
    await fs.rm(staging, { recursive: true, force: true })
    await fs.symlink(outside, staging, 'junction')
    try {
      const runner = await import(`${fixture.runnerUrl.href}?metadata-reparse=${crypto.randomUUID()}`)
      await expect(runner.runTrustedWindowsCommand('node-version')).rejects.toThrow('Trusted command execution failed.')
      await expect(fs.stat(fixture.markerPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await fs.unlink(staging)
    }
  }, 30_000)

  it('refuses a final workspace command when the reviewed dependency closure drifts', async () => {
    const runner = await import(`${runnerUrl.href}?closure-drift=${Date.now()}`)
    const driftPath = path.join(workspaceRoot, 'node_modules', 'emoji-regex', 'LICENSE-MIT.txt')
    const original = await fs.readFile(driftPath)
    const originalStat = await fs.stat(driftPath)
    try {
      await fs.appendFile(driftPath, Buffer.from('\nTASK2C1-CLOSURE-DRIFT\n', 'utf8'))
      await expect(runner.runTrustedWindowsCommand('typecheck')).resolves.toEqual({
        status: 'FAIL',
        category: 'cleanup-unconfirmed',
        exitCode: null,
      })
    } finally {
      await fs.writeFile(driftPath, original)
      await fs.utimes(driftPath, originalStat.atime, originalStat.mtime)
    }
  }, 180_000)

  it('round-trips the exact Windows argv vector through CreateProcessW', async () => {
    const parent = path.join(workspaceRoot, 'release-validation', 'task2c1-controller-fixtures')
    await fs.mkdir(parent, { recursive: true })
    const root = await fs.mkdtemp(path.join(parent, 'argv-'))
    disposableRoots.push(root)
    const scriptPath = path.join(root, 'argv-fixture.mjs')
    await fs.writeFile(scriptPath, "process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n')\n", 'utf8')
    const expected = ['', 'plain', 'with space', 'quote"inside', '\\\\', 'trailing\\', '\\\\"quoted', '中文参数']
    const base = await controllerRequest({ argv: [scriptPath, ...expected] })
    const request = {
      ...base,
      criticalInputs: [...(base.criticalInputs as Array<Record<string, unknown>>), {
        path: scriptPath,
        boundary: workspaceRoot,
        sha256: await sha256File(scriptPath),
        protected: false,
      }],
    }
    const result = await runExactController(request)
    expect(result, JSON.stringify(result)).toMatchObject({ code: 0, stderr: '' })
    const receipt = JSON.parse(result.stdout) as { stdout: string }
    expect(JSON.parse(Buffer.from(receipt.stdout, 'base64').toString('utf8'))).toEqual(expected)
  }, 40_000)

  it('rejects duplicate keys, type drift, and blocked environment before target creation', async () => {
    const parent = path.join(workspaceRoot, 'release-validation', 'task2c1-controller-fixtures')
    await fs.mkdir(parent, { recursive: true })
    const root = await fs.mkdtemp(path.join(parent, 'request-'))
    disposableRoots.push(root)
    const markerPath = path.join(root, 'target-started.txt')
    const scriptPath = path.join(root, 'marker-fixture.mjs')
    await fs.writeFile(scriptPath, "import fs from 'node:fs'; fs.writeFileSync(process.argv[2], 'started')\n", 'utf8')
    const base = await controllerRequest({ argv: [scriptPath, markerPath], environment: { SAFE_VALUE: 'yes' } })
    const request = {
      ...base,
      criticalInputs: [...(base.criticalInputs as Array<Record<string, unknown>>), {
        path: scriptPath,
        boundary: workspaceRoot,
        sha256: await sha256File(scriptPath),
        protected: false,
      }],
    }
    const canonical = JSON.stringify(request)
    const duplicateInput = JSON.stringify({
      ...request,
      criticalInputs: [
        ...(request.criticalInputs as Array<Record<string, unknown>>),
        (request.criticalInputs as Array<Record<string, unknown>>)[0],
      ],
    })
    const mutations = [
      canonical.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
      canonical.replace('"SAFE_VALUE":"yes"', '"SAFE_VALUE":"yes","SAFE_VALUE":"again"'),
      canonical.replace(`"argv":[${JSON.stringify(scriptPath)}`, `"argv":[{"unexpected":true},${JSON.stringify(scriptPath)}`),
      canonical.replace('"SAFE_VALUE":"yes"', '"NODE_OPTIONS":"--require=untrusted"'),
      duplicateInput,
    ]
    for (const mutated of mutations) {
      await fs.rm(markerPath, { force: true })
      const result = await runExactControllerBytes(Buffer.from(`${mutated}\n`, 'utf8'))
      expect(result).toEqual({ code: 1, stdout: '', stderr: '' })
      await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  }, 40_000)

  it.each([
    ['timeout', 'timeout'],
    ['stdout overflow', 'stdout'],
    ['stderr overflow', 'stderr'],
  ] as const)('kills the exact target and descendant tree after %s', async (_label, mode) => {
    const fixture = await createControllerTreeFixture(mode)
    const result = await runExactController(fixture.request)
    expect(result, JSON.stringify(result)).toMatchObject({ code: 1, stderr: '' })
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      status: 'FAIL',
      category: mode === 'timeout' ? 'timeout' : 'output-limit',
      cleanupConfirmed: true,
    })
    await expectFixtureProcessesDead(fixture.markerPath)
  }, 40_000)
})

describe.runIf(process.platform === 'win32')('exact small loader envelope', () => {
  it('accepts one canonical envelope delivered in fragmented writes and only after stdin EOF', async () => {
    const controller = Buffer.from(await exactControllerSource(), 'utf8')
    const request = Buffer.from(`${JSON.stringify(await controllerRequest())}\n`, 'utf8')
    const envelope = loaderEnvelope(controller, request)
    const split = Math.floor(envelope.length / 3)
    const result = await runExactLoader([
      envelope.slice(0, split),
      envelope.slice(split, split * 2),
      envelope.slice(split * 2),
    ], { delayMs: 10, timeoutMs: 40_000 })
    expect(result, JSON.stringify(result)).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, status: 'PASS', cleanupConfirmed: true })
  }, 45_000)

  it.each([
    ['BOM before the envelope', (line: string) => `\ufeff${line}`],
    ['CRLF terminator', (line: string) => line.slice(0, -1) + '\r\n'],
    ['missing LF terminator', (line: string) => line.slice(0, -1)],
    ['a second LF-terminated value', (line: string) => `${line}{}\n`],
    ['leading whitespace', (line: string) => ` ${line}`],
    ['reordered exact keys', (line: string) => {
      const value = JSON.parse(line)
      return `${JSON.stringify({ controllerBase64: value.controllerBase64, schemaVersion: 1, controllerByteLength: value.controllerByteLength, controllerSha256: value.controllerSha256, requestBase64: value.requestBase64, requestByteLength: value.requestByteLength, requestSha256: value.requestSha256 })}\n`
    }],
    ['an extra decoded key', (line: string) => line.replace('}\n', ',"extra":true}\n')],
    ['wrong controller byte length', (line: string) => line.replace(/"controllerByteLength":\d+/u, '"controllerByteLength":1')],
    ['wrong request byte length', (line: string) => line.replace(/"requestByteLength":\d+/u, '"requestByteLength":2')],
    ['wrong request digest', (line: string) => line.replace(/"requestSha256":"[a-f0-9]{64}"/u, `"requestSha256":"${'0'.repeat(64)}"`)],
    ['noncanonical request Base64 pad bits', (line: string) => line.replace('"requestBase64":"eA=="', '"requestBase64":"eB=="')],
  ])('rejects %s before compiling the controller', async (_label, mutate) => {
    const controller = Buffer.from(await exactControllerSource(), 'utf8')
    const canonical = loaderEnvelope(controller, Buffer.from('x', 'utf8'))
    const result = await runExactLoader([mutate(canonical)])
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Trusted release controller loader failed.\r\n')
  }, 20_000)

  it('rejects invalid UTF-8 and over-cap decoded request bytes', async () => {
    const controller = Buffer.from(await exactControllerSource(), 'utf8')
    for (const request of [Buffer.from([0xc3, 0x28]), Buffer.alloc(65_537, 0x78)]) {
      const result = await runExactLoader([loaderEnvelope(controller, request)])
      expect(result.code).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('Trusted release controller loader failed.\r\n')
    }
  }, 30_000)
})

describe('extracted Node parent protocol engine', () => {
  const validReceipt = Buffer.from('{"schemaVersion":1,"status":"PASS","exitCode":0,"stdout":"","cleanupConfirmed":true}\n', 'utf8')
  const requestLine = Buffer.from('{"schemaVersion":1}\n', 'utf8')
  const limits = Object.freeze({ deadlineMs: 50, stdoutCapBytes: 4_096, stderrCapBytes: 1_024 })

  function retainedProbe() {
    const order: string[] = []
    return {
      order,
      inputs: [{ async close() { order.push('retained-close') } }],
    }
  }

  function expectNoProtocolListeners(transport: ParentTransport): void {
    for (const event of ['error', 'exit', 'close']) expect(transport.listenerCount(event), `child ${event}`).toBe(0)
    for (const stream of [transport.stdin, transport.stdout, transport.stderr]) {
      for (const event of ['data', 'drain', 'end', 'error', 'finish', 'close']) {
        expect(stream.listenerCount(event), `${event} listener`).toBe(0)
      }
    }
  }

  it('is a self-contained extracted function and accepts a receipt only after process and all pipe barriers', async () => {
    const runControllerProtocol = await extractedParentEngine()
    const retained = retainedProbe()
    const transport = new ParentTransport({ stdout: validReceipt, completionDelayMs: 10 })
    const pending = runControllerProtocol(transport, requestLine, limits, retained.inputs)
    await new Promise((resolve) => setTimeout(resolve, 1))
    expect(retained.order).toEqual([])
    await expect(pending).resolves.toEqual({
      category: 'receipt',
      receipt: { schemaVersion: 1, status: 'PASS', exitCode: 0, stdout: '', cleanupConfirmed: true },
    })
    expect(transport.killCalls).toBe(0)
    expect(retained.order).toEqual(['retained-close'])
    expectNoProtocolListeners(transport)
  })

  it('honors stdin backpressure and requires finish before accepting a receipt', async () => {
    const runControllerProtocol = await extractedParentEngine()
    const retained = retainedProbe()
    const transport = new ParentTransport({ stdout: validReceipt, stdinBackpressure: true })
    await expect(runControllerProtocol(transport, requestLine, limits, retained.inputs)).resolves.toMatchObject({ category: 'receipt' })
    expect(transport.stdin.writableFinished).toBe(true)
    expect(transport.killCalls).toBe(0)
    expect(retained.order).toEqual(['retained-close'])
    expectNoProtocolListeners(transport)
  })

  it.each([
    ['stdin error', { stdinError: true }, limits],
    ['parent deadline', { completeOnFinish: false }, { ...limits, deadlineMs: 5 }],
    ['controller stdout cap', { stdout: Buffer.alloc(4_097, 0x78) }, limits],
    ['controller stderr cap', { stderr: Buffer.alloc(1_025, 0x78) }, limits],
  ])('kills once, waits for the barrier, and fails closed for %s', async (_label, options, caseLimits) => {
    const runControllerProtocol = await extractedParentEngine()
    const retained = retainedProbe()
    const transport = new ParentTransport(options)
    await expect(runControllerProtocol(transport, requestLine, caseLimits, retained.inputs)).resolves.toEqual({ category: 'cleanup-unconfirmed' })
    expect(transport.killCalls).toBe(1)
    expect(retained.order).toEqual(['retained-close'])
    expectNoProtocolListeners(transport)
  })

  it.each([
    ['malformed JSON', Buffer.from('{not-json}\n')],
    ['missing receipt', Buffer.alloc(0)],
    ['multiple receipts', Buffer.concat([validReceipt, validReceipt])],
    ['invalid UTF-8', Buffer.from([0xc3, 0x28, 0x0a])],
    ['noncanonical Base64', Buffer.from('{"schemaVersion":1,"status":"PASS","exitCode":0,"stdout":"eB==","cleanupConfirmed":true}\n')],
  ])('rejects %s only after the full close/EOF barrier', async (_label, stdout) => {
    const runControllerProtocol = await extractedParentEngine()
    const retained = retainedProbe()
    const transport = new ParentTransport({ stdout })
    await expect(runControllerProtocol(transport, requestLine, limits, retained.inputs)).resolves.toEqual({ category: 'cleanup-unconfirmed' })
    expect(retained.order).toEqual(['retained-close'])
    expectNoProtocolListeners(transport)
  })
})
