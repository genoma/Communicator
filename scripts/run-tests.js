// Test wrapper: `npm test` runs one test file per child process with the
// runner's own process isolation turned OFF (`--experimental-test-isolation=none`
// is the spelling every supported Node accepts; 24+ also accepts
// `--test-isolation=none`).
//
// Why per file: with the default `--test-isolation=process` the runner frames
// each test child's results on that child's stdout, and a file that writes to
// fd 1 — or merely produces many frames — makes the parent silently lose
// results: `test/one-shot.test.js` reported 25 of its 30 tests on Node 24/26 and
// 28 of 30 on Node 22, deterministically, with the bodies still running
// (KNOWN-ISSUES F34/O27, nodejs/node#62693). Running a single file in the
// runner's own process removes the frame channel entirely, so every result is
// reported and the suite counts the same on every Node version. Per-file process
// isolation is preserved — one process per file — so file-level module mocks and
// environment mutations stay contained, and the console guard stays importable
// as belt-and-braces (nothing writes on a protocol channel any more).
//
// `--experimental-test-coverage` keeps the single-run form: V8 coverage cannot
// be merged across processes, and a per-file invocation would report per-file
// tables instead of one project summary.
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.NO_COLOR = '1'
delete process.env.FORCE_COLOR

// The suite must behave the same with or without provider keys: a test that
// needs one stubs it itself (withApiKey), and a developer shell that exports the
// real keys must not change the outcome (CI has none). Clearing them here makes
// `npm test` match CI exactly.
delete process.env.OPENROUTER_API_KEY
delete process.env.VENICE_API_KEY

// COMMUNICATOR_DEBUG makes src/ui/io.js's debug() print the stack of every
// error a run reports, so a developer shell exporting it would fail the tests
// that assert a run's exact stderr. CI never sets it; clearing it here keeps
// the suite's output identical either way.
delete process.env.COMMUNICATOR_DEBUG

// src/constants.js resolves DATA_DIR and DEFAULT_CONFIG_FILE from the home
// directory at module load, so every unhomed test file would read and write the
// developer's real ~/.communicator.json and ~/.communicator/. Pointing HOME
// (POSIX) and USERPROFILE (Windows) at a throwaway directory makes the whole run
// hermetic instead of relying on each file's node:os mock.
const home = mkdtempSync(join(tmpdir(), 'communicator-test-home-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.on('exit', () => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // A leftover temp directory must never fail the run's exit code.
  }
})

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TEST_DIR = join(ROOT, 'test')

// Keeps app console output off a test child's fd 1, where it corrupts the
// runner's frame stream (see scripts/child-console-guard.js). A workaround for
// nodejs/node#62693; the per-file runs below have no frame channel, so this is
// belt-and-braces for the coverage path and for anything a test spawns itself.
const consoleGuard = new URL('./child-console-guard.js', import.meta.url).href

const forwarded = process.argv.slice(2)
const runnerFlags = forwarded.filter((flag) => flag.startsWith('-'))
const requestedFiles = forwarded.filter((flag) => !flag.startsWith('-'))
const coverage = runnerFlags.includes('--experimental-test-coverage')
const files = (requestedFiles.length > 0
  ? requestedFiles
  : readdirSync(TEST_DIR)
      .filter((name) => name.endsWith('.test.js'))
      .sort()
      .map((name) => join('test', name)))

function runnerArgs(file) {
  return [
    '--test',
    '--experimental-test-isolation=none',
    '--experimental-test-module-mocks',
    '--import',
    consoleGuard,
    '--test-reporter=spec',
    ...runnerFlags,
    file,
  ]
}

/** Run one test file and return its exit code and captured output */
function runFile(file) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, runnerArgs(file), {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (err) => resolve({ file, code: 1, ms: 0, stdout: '', stderr: String(err), counts: {} }))
    child.on('close', (code) => resolve({ file, code: code ?? 1, ms: Date.now() - started, stdout, stderr, counts: parseCounts(stdout) }))
  })
}

/** The runner's per-file summary (`ℹ tests N` / `ℹ pass N` / ...) as numbers */
function parseCounts(output) {
  const counts = {}
  for (const line of output.split('\n')) {
    const match = /^ℹ (tests|pass|fail|cancelled|skipped|todo|duration_ms) ([\d.]+)$/.exec(line)
    if (match) counts[match[1]] = Number(match[2])
  }
  return counts
}

/** The file's report without the runner's own per-file summary lines */
function withoutSummary(output) {
  return output
    .split('\n')
    .filter((line) => !line.startsWith('ℹ '))
    .join('\n')
    .replace(/\n{2,}$/, '\n')
}

const pool = Math.max(1, Math.min(8, availableParallelism()))
const startedAt = Date.now()
const results = []
let next = 0

function report(result) {
  const header = result.code === 0 ? `# ${result.file}` : `# ${result.file} (exit ${result.code})`
  process.stdout.write(`\n${header}\n`)
  const body = withoutSummary(result.stdout)
  if (body.trim() !== '') process.stdout.write(body.endsWith('\n') ? body : `${body}\n`)
  if (result.stderr.trim() !== '') process.stdout.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`)
}

async function worker() {
  while (next < files.length) {
    const file = files[next]
    next += 1
    const result = await runFile(file)
    results.push(result)
    report(result)
  }
}

/** One child per file; `--experimental-test-coverage` keeps the single-run form */
async function runCoverage() {
  const child = spawn(process.execPath, ['--test', '--experimental-test-module-mocks', '--import', consoleGuard, ...runnerFlags, ...files], {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
  })
  const code = await new Promise((resolve) => {
    child.on('error', () => resolve(1))
    child.on('close', (exitCode) => resolve(exitCode ?? 1))
  })
  process.exit(code)
}

if (coverage) {
  await runCoverage()
} else {
  await Promise.all(Array.from({ length: pool }, worker))

  const totals = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 }
  for (const result of results) {
    for (const key of Object.keys(totals)) totals[key] += result.counts[key] ?? 0
  }
  const failed = results.filter((result) => result.code !== 0 || (result.counts.fail ?? 0) > 0)
  if (failed.length > 0) {
    process.stdout.write('\n✖ failing files:\n')
    for (const result of failed) {
      process.stdout.write(`  ${result.file} (exit ${result.code})\n`)
      for (const line of withoutSummary(result.stdout).split('\n')) {
        if (/^✖ /.test(line)) process.stdout.write(`    ${line}\n`)
      }
      for (const line of result.stderr.split('\n')) {
        if (line.trim() !== '') process.stdout.write(`    ${line}\n`)
      }
    }
  }
  process.stdout.write(`\nℹ suites ${files.length}\n`)
  process.stdout.write(`ℹ tests ${totals.tests}\n`)
  process.stdout.write(`ℹ pass ${totals.pass}\n`)
  process.stdout.write(`ℹ fail ${totals.fail}\n`)
  process.stdout.write(`ℹ cancelled ${totals.cancelled}\n`)
  process.stdout.write(`ℹ skipped ${totals.skipped}\n`)
  process.stdout.write(`ℹ todo ${totals.todo}\n`)
  process.stdout.write(`ℹ duration_ms ${Date.now() - startedAt}\n`)
  process.exit(failed.length > 0 ? 1 : 0)
}
