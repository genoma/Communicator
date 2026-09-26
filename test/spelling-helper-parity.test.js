// The one deliberate exception to the suite's "never compile or spawn a real
// spelling backend" rule: helper.m must stay a line-for-line semantic port of
// the JXA program in jxa.js, and only the real backends can pin that. The file
// skips wherever the platform or the toolchain cannot build, so Linux/Windows CI
// never compiles anything.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHelperBackend, toolchainAvailable } from '../src/spelling/helper-backend.js'
import { createOsascriptBackend } from '../src/spelling/osascript.js'

// The request shapes src/spelling/provider.js sends: `location`/`length` are
// the prose word's own word-aligned range.
const CORPUS = [
  { name: 'check: two typos on one line', request: { op: 'check', text: 'The quick brown fox wrold over teh lazy dog' } },
  { name: 'check: empty line', request: { op: 'check', text: '' } },
  { name: 'check: blank line', request: { op: 'check', text: '   ' } },
  { name: 'check: Italian prose', request: { op: 'check', text: 'questo e bello' } },
  { name: 'check: Russian prose', request: { op: 'check', text: 'привет мир' } },
  { name: 'check: mixed-language line', request: { op: 'check', text: 'this is an English wrnog inside italiano' } },
  { name: 'check: emoji and URL', request: { op: 'check', text: '😀 https://example.com/a?b=1' } },
  { name: 'check: mask-shaped code line', request: { op: 'check', text: 'wrold src/chat.js --rpg' } },
  { name: 'guesses: bare word', request: { op: 'guesses', text: 'teh', location: 0, length: 3 } },
  { name: 'guesses: word inside a line', request: { op: 'guesses', text: 'the wrold is quiet', location: 4, length: 5 } },
  { name: 'correction: typo at the line start', request: { op: 'correction', text: 'teh ', location: 0, length: 3 } },
  { name: 'correction: longer typo at the line start', request: { op: 'correction', text: 'wrold ', location: 0, length: 5 } },
  { name: 'correction: correctly spelled word', request: { op: 'correction', text: 'world ', location: 0, length: 5 } },
  { name: 'completions: bare partial word', request: { op: 'completions', text: 'recon', location: 0, length: 5 } },
  { name: 'completions: partial word inside a sentence', request: { op: 'completions', text: 'I want to recon the server', location: 10, length: 5 } },
]

// Malformed requests are compared as BEHAVIOUR, not as text: the two backends
// word their errors differently and that difference is accepted.
const MALFORMED = [
  { name: 'unknown op', request: { op: 'nope' } },
  { name: 'check without text', request: { op: 'check' } },
]

const settle = (promise) => promise.then((reply) => ({ reply }), (error) => ({ error }))

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const runBoth = (backend, osascript, request) =>
  Promise.all([settle(backend.run(request)), settle(osascript.run(request))])

const describe = ({ reply, error }) => (error ? `rejected with ${error.message}` : `answered ${JSON.stringify(reply)}`)

// The compiled helper echoes the request id and the JXA program writes no id at
// all: the echo belongs to the protocol, not to the answer. The checker answers
// the same guess/completion words in an order that depends on the calling
// process and the machine's dictionary state (observed on the macOS CI runner:
// identical word sets, different order), so word lists are compared as sets;
// ranges and corrections stay exact.
const compare = (reply) =>
  JSON.stringify({
    ...reply,
    id: undefined,
    words: Array.isArray(reply.words) ? [...reply.words].sort() : reply.words,
  })

// A fresh osascript process can answer from a cold system checker while the
// long-lived helper — warmed by the requests before it — answers the full
// result: observed on a loaded macOS CI runner as an empty guess/completion
// list (`completions recon`: 20 words from the helper, [] from osascript) and
// as a `check` that missed one of two typos (helper [[20,5],[31,3]], osascript
// [[20,5]]). That is the checker's own per-machine state, not a port
// divergence, so any reply mismatch is retried; a rejection is never retried
// and a real divergence is deterministic, so it still fails after the retries.
const repliesDiffer = ([helper, jxa]) =>
  !helper.error && !jxa.error && compare(helper.reply) !== compare(jxa.reply)

test('the compiled helper replies to the corpus exactly like the osascript backend', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only')
  if (!(await toolchainAvailable())) return t.skip('no Command Line Tools')

  // Every backend handle is unref'ed on purpose, and Node 22's test process does
  // not hold the event loop open for a pending test promise: without a referenced
  // handle the awaits below die as "Promise resolution is still pending but the
  // event loop has already resolved".
  const anchor = setInterval(() => {}, 1000)
  t.after(() => clearInterval(anchor))

  const cacheDir = await mkdtemp(join(tmpdir(), 'communicator-spelling-parity-'))
  // The helper's cold start (exec + AppKit load) shares its first request's
  // production watchdog, which a loaded CI runner could trip and read as a lost
  // id echo; the fake-spawn suite pins that watchdog path, not the bound itself,
  // and this file asserts no timing.
  const backend = createHelperBackend({ cacheDir, timeoutMs: 5000 })
  const osascript = createOsascriptBackend()
  t.after(async () => {
    backend.dispose()
    await rm(cacheDir, { recursive: true, force: true })
  })

  assert.equal(await backend.whenReady(), true, 'the helper compiled through the real build path')

  // Warm the system checker through the osascript backend before comparing: the
  // cold state is what produced the empty-list mismatches below, and a single
  // discarded request takes the hit instead of the first corpus entry.
  await osascript.run({ op: 'completions', text: 'recon', location: 0, length: 5 }).catch(() => {})

  for (const { name, request } of CORPUS) {
    let pair = await runBoth(backend, osascript, request)
    // Four retries with a growing backoff (250/500/750/1000 ms): a loaded macOS
    // CI runner kept the cold checker empty past the original 500 ms budget.
    for (let attempt = 0; attempt < 4 && repliesDiffer(pair); attempt += 1) {
      await delay(250 * (attempt + 1))
      pair = await runBoth(backend, osascript, request)
    }
    const [helper, jxa] = pair
    const evidence = `${name} (${JSON.stringify(request)}): helper.m ${describe(helper)}, osascript ${describe(jxa)}`
    if (helper.error || jxa.error) assert.fail(`both backends must answer — ${evidence}`)
    // The id echo proves the compiled helper answered: the JXA program writes
    // none, so an unnoticed fallback to osascript could not pass for a match.
    assert.ok(Number.isInteger(helper.reply.id), `the compiled helper must serve the request — ${evidence}`)
    assert.equal(compare(helper.reply), compare(jxa.reply), `the replies differ — ${evidence}`)
  }

  for (const { name, request } of MALFORMED) {
    const [helper, jxa] = await runBoth(backend, osascript, request)
    assert.ok(helper.error, `${name} (${JSON.stringify(request)}): the helper must reject, got ${describe(helper)}`)
    assert.ok(jxa.error, `${name} (${JSON.stringify(request)}): osascript must reject, got ${describe(jxa)}`)
  }
})
