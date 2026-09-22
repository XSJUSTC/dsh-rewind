// @xsj/dsh-rewind — regression test for the row-hiding logic.
//
// Loads the ACTUAL lib/client.js from this package, extracts the DOM-native
// driver region, and exercises it against a minimal DOM shim. This catches the
// class of bug reported against 2.3.0: only user/steering rows carried a seq
// stamp, so a committed range hid the prompt but left the model's answer on
// screen.
//
// Run: node test/hiding.test.mjs   (no dependencies)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'lib', 'client.js')
const src = readFileSync(SRC, 'utf8')

// ---------------------------------------------------------------- extract --
// The driver is a contiguous region of the bundle, followed by rwApply. Pull
// both out and evaluate them with shims, so the test tracks the real source
// instead of a copy that can drift.
const regionStart = src.indexOf('// =============================================== DOM-native driver ====')
const applyAt = src.indexOf('function rwApply(sid) {')
if (regionStart < 0 || applyAt < 0) {
  console.error('FAIL: could not locate the driver region in lib/client.js')
  process.exit(1)
}
const region = src.slice(regionStart, applyAt)
let depth = 1
let i = applyAt + 'function rwApply(sid) {'.length
for (; i < src.length && depth > 0; i++) {
  if (src[i] === '{') depth++
  else if (src[i] === '}') depth--
}
const rwApplySrc = src.slice(applyAt, i)

// ------------------------------------------------------------------- dom ---
function makeEl(attrs) {
  const m = new Map(Object.entries(attrs).map(([k, v]) => [k, String(v)]))
  const el = {
    _display: null,
    getAttribute: (k) => (m.has(k) ? m.get(k) : null),
    setAttribute: (k, v) => {
      m.set(k, String(v))
      if (k === 'data-xsj-hidden' && v === '1') el._display = 'none'
    },
    removeAttribute: (k) => {
      m.delete(k)
      if (k === 'data-xsj-hidden') el._display = null
    },
    hasAttribute: (k) => m.has(k),
    style: {
      setProperty: (k, v) => { if (k === 'display') el._display = v },
      removeProperty: (k) => { if (k === 'display') el._display = null },
    },
  }
  return el
}
// Only user/steering rows carry a seq stamp — the condition the bug report
// describes. Assistant/tool/context rows must still be hidden by the driver.
const U = (seq, key) => makeEl({ 'data-chat-flow-key': key, 'data-chat-flow-kind': 'user', 'data-xsj-seq': seq })
const ASST = (key) => makeEl({ 'data-chat-flow-key': key, 'data-chat-flow-kind': 'assistant-step' })
const TOOL = (key) => makeEl({ 'data-chat-flow-key': key, 'data-chat-flow-kind': 'tool-call' })

let flow = []
const doc = {
  querySelector: (sel) => (sel === '[data-chat-flow]' ? { children: flow } : null),
  querySelectorAll: (sel) => (sel === '[data-xsj-hidden="1"]'
    ? flow.filter((r) => r.getAttribute('data-xsj-hidden') === '1')
    : []),
}
const states = new Map()

const factory = new Function('__doc', '__states', `
const document = __doc;
function rwRows() {
  const list = document.querySelector('[data-chat-flow]');
  if (!list) return [];
  return Array.prototype.slice.call(list.children).filter((el) =>
    el.getAttribute && (el.hasAttribute('data-chat-flow-key') || el.hasAttribute('data-chat-anchor-key')));
}
function readState(sid) { return __states.get(sid); }
function rwRefetch() {}
function get() { return Promise.resolve(null); }
function applyHostState() {}
${region}
${rwApplySrc}
return { rwApply, rwRestoreAll, rwSolveVerdicts, rwRowVerdicts };
`)
const D = factory(doc, states)

// ------------------------------------------------------------------ cases --
// 7 rows: u0 a1 u2 a3(tool) u4 a5. Indices 0..6.
function scene() {
  flow = [U(0, 'u0'), ASST('a1'), U(2, 'u2'), ASST('a3'), TOOL('t3'), U(4, 'u4'), ASST('a5')]
}
const shown = () => flow.map((r) => (r._display === 'none' ? 'H' : '.')).join('')

let failed = 0
function check(label, got, want) {
  const ok = got === want
  if (!ok) failed++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(50)} ${got.padEnd(8)} (want ${want})`)
}

console.log('rewind row hiding — regression against lib/client.js\n')

console.log('committed hidden range')
scene(); states.set('s', { pending: null, ranges: [{ start: 2, end: 5 }], fetched: true, fetchFailed: false })
D.rwApply('s')
check('model output hides with its prompt', shown(), '..HHHHH')

console.log('\npending rewind (before send)')
scene(); states.set('s', { pending: { targetSeq: 2, markSeq: 100 }, ranges: [], fetched: true })
D.rwApply('s')
check('abandoned tail hidden', shown(), '..HHHHH')

console.log('\ncancel / idle')
scene(); states.set('s', { pending: null, ranges: [], fetched: true })
D.rwApply('s')
check('everything visible', shown(), '.......')

console.log('\ncold load before /state answers')
scene(); states.delete('s')
D.rwApply('s')
check('nothing asserted (no flash)', shown(), '.......')
states.set('s', { pending: null, ranges: [{ start: 2, end: 5 }], fetched: true, fetchFailed: false })
D.rwApply('s')
check('hidden once the host answers', shown(), '..HHHHH')

console.log('\nlocal mark while state is unfetched')
scene(); states.set('s', { pending: { targetSeq: 2, markSeq: 100 }, ranges: [], fetched: false })
D.rwApply('s')
check('a real mark still applies', shown(), '..HHHHH')

console.log('\nteardown')
scene(); states.set('s', { pending: null, ranges: [{ start: 2, end: 5 }], fetched: true })
D.rwApply('s')
D.rwRestoreAll()
check('restore releases hidden rows', shown(), '.......')

console.log('\ndisjoint ranges')
scene(); states.set('s', { pending: null, ranges: [{ start: 0, end: 1 }, { start: 4, end: 5 }], fetched: true })
D.rwApply('s')
check('two ranges', shown(), 'HH...HH')

console.log('\nedge: an unstamped row above the range is not swept in')
// Rows: u0(0) a1 u2(2) a3 t3 u4(4) a5. Range [4,5] covers seq 4 (index 5) and
// the assistant row that follows it (index 6). a1/a3 sit BEFORE the range and
// must stay visible — that is the over-hiding regression the first cut of the
// fix introduced.
scene(); states.set('s', { pending: null, ranges: [{ start: 4, end: 5 }], fetched: true })
D.rwApply('s')
check('range [4,5] keeps the earlier answer visible', shown(), '.....HH')

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) FAILED`)
process.exit(failed === 0 ? 0 : 1)