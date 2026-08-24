import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_COUNT = 2_147_483_647
const REPORTER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const REQUIRED_CASES = Object.freeze([
  Object.freeze({ id: 'migration', modulePath: 'src/main/database/__tests__/Migration.test.ts', fullName: 'SQLite migration > backs up the legacy JSON before importing it' }),
  Object.freeze({ id: 'current-schema', modulePath: 'src/main/database/__tests__/ReleaseMigration.test.ts', fullName: 'v0.9/v3 to v1.0/v4 release migration > advances the fixed v0.9 fixture to the current schema v7' }),
  Object.freeze({ id: 'future-schema', modulePath: 'src/main/database/__tests__/ReleaseMigration.test.ts', fullName: 'v0.9/v3 to v1.0/v4 release migration > rejects a schema newer than the v1.0 client' }),
  Object.freeze({ id: 'legacy-safety', modulePath: 'src/main/database/__tests__/DatabaseLegacySafety.test.ts', fullName: 'legacy database fail-closed safety > rejects a corrupt file with a SQLite header without moving or recreating it' }),
  Object.freeze({ id: 'sentinel-redaction', modulePath: 'src/main/diagnostics/__tests__/DiagnosticsExporter.release.test.ts', fullName: 'DiagnosticsExporter release privacy boundary > re-sanitizes structured and unstructured log lines before ZIP serialization' }),
  Object.freeze({ id: 'diagnostics-bounds', modulePath: 'src/main/diagnostics/__tests__/DiagnosticsExporter.release.test.ts', fullName: 'DiagnosticsExporter release privacy boundary > tails oversized logs so stale content cannot inflate the diagnostic archive' }),
])

function boundedIncrement(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= MAX_COUNT) throw new Error('Reporter count overflow.')
  return value + 1
}

function moduleRelativePath(moduleId) {
  if (typeof moduleId !== 'string') return null
  const normalized = moduleId.replaceAll('\\', '/')
  const root = REPORTER_ROOT.replaceAll('\\', '/')
  const prefix = `${root}/`
  if (!normalized.toLowerCase().startsWith(prefix.toLowerCase())) return null
  const relative = normalized.slice(prefix.length)
  if (!relative || relative.startsWith('/') || relative.split('/').some((part) => !part || part === '.' || part === '..')) return null
  return relative
}

function raiseFailureExitCode() {
  if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 1
}

export default class VitestPreflightReporter {
  onTestRunEnd(testModules, unhandledErrors, reason) {
    const counts = { files: 0, tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0 }
    const matches = new Map(REQUIRED_CASES.map((item) => [item.id, 0]))
    let policyFailure = reason !== 'passed' || !Array.isArray(unhandledErrors) || unhandledErrors.length !== 0

    for (const module of Array.isArray(testModules) ? testModules : []) {
      const moduleState = typeof module?.state === 'function' ? module.state() : 'pending'
      const completed = moduleState === 'passed' || moduleState === 'failed' || moduleState === 'skipped'
      if (!completed) {
        policyFailure = true
        continue
      }
      counts.files = boundedIncrement(counts.files)
      if (moduleState !== 'passed') policyFailure = true
      const relativePath = moduleRelativePath(module.moduleId)
      let tests
      try { tests = [...module.children.allTests()] } catch { tests = []; policyFailure = true }
      for (const test of tests) {
        const result = typeof test?.result === 'function' ? test.result() : { state: 'pending' }
        if (result?.state === 'pending') {
          policyFailure = true
          continue
        }
        counts.tests = boundedIncrement(counts.tests)
        if (result?.state === 'passed') counts.passed = boundedIncrement(counts.passed)
        else if (result?.state === 'failed') counts.failed = boundedIncrement(counts.failed)
        else if (result?.state === 'skipped' && test?.options?.mode === 'todo') counts.todo = boundedIncrement(counts.todo)
        else if (result?.state === 'skipped') counts.skipped = boundedIncrement(counts.skipped)
        else policyFailure = true
        for (const item of REQUIRED_CASES) {
          if (relativePath === item.modulePath && test?.fullName === item.fullName) {
            matches.set(item.id, boundedIncrement(matches.get(item.id) ?? 0))
          }
        }
      }
    }

    const requiredCases = REQUIRED_CASES.filter((item) => matches.get(item.id) === 1).map((item) => item.id)
    const reconciled = counts.tests === counts.passed + counts.failed + counts.skipped + counts.todo
    const pass = !policyFailure
      && counts.files >= 1
      && counts.tests >= 1
      && reconciled
      && counts.failed === 0
      && counts.skipped === 0
      && counts.todo === 0
      && REQUIRED_CASES.every((item) => matches.get(item.id) === 1)
    if (!pass) raiseFailureExitCode()
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: pass ? 'PASS' : 'FAIL', tests: counts, requiredCases })}\n`)
  }
}
