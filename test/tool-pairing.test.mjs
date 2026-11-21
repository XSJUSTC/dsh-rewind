// @xsj/dsh-rewind — regression test for tool-call pairing across a rewind.
//
// A rewind hides a seq range, and a tool round is spread over two surface
// nodes: the assistant message that carries the call and the tool message that
// answers it. Hiding can therefore cut a round in half. The host also
// re-materializes a pruned tool result as a brand-new event (its seq lands
// outside every hidden range), so the result can survive while its call stays
// hidden. Provider adapters reject that history outright — the DeepSeek
// Messages adapter throws "tool result has no matching call" (or "tool calls
// need immediate results" in the mirror case) and the whole turn dies; every
// retry resends the same broken history and fails the same way.
//
// This test loads the ACTUAL lib/index.js, mounts its host half on a stubbed
// session/agent/webServer, drives mark + commit through the real HTTP handler
// and `agent/pre-step` hook, and replays the host's re-materialization with a
// `replace` node. It then asserts the derivation the model would receive.
//
// Run: node test/tool-pairing.test.mjs   (no dependencies)

import { apply } from '../lib/index.js'

// ------------------------------------------------------------------ events --
// The shapes the host's own deriveEventMessage produces for these event types.
function deriveEventMessage(event) {
  const type = event?.type
  if (type === 'user/message') return { role: 'user', content: event.data.content }
  if (type === 'assistant/message') return event.data.message
  if (type === 'tool/result') return event.data.message
  return null
}

const userMessage = (text) => ({
  type: 'user/message',
  data: { role: 'user', content: [{ type: 'text', text }] },
})
const assistantCall = (...ids) => ({
  type: 'assistant/message',
  data: {
    message: {
      role: 'assistant',
      content: ids.map((id) => ({ type: 'tool-call', id, name: 'pwsh', arguments: '{}' })),
    },
  },
})
const toolResult = (id, text = 'ok') => ({
  type: 'tool/result',
  data: { message: { role: 'tool', toolCallId: id, content: [{ type: 'text', text }] } },
})

// ----------------------------------------------------------------- session --
function makeSession() {
  const events = []
  const shadowed = new Set()
  let generation = 0
  const session = {
    id: 'session-rewind-test',
    get seq() {
      return events.length
    },
    snapshotEvents: () => events,
    eventAt: (seq) => events[seq],
    append(type, data) {
      const event = { type, seq: events.length, data }
      events.push(event)
      return event
    },
    surface: {
      get nodes() {
        return events.map((event) => event.seq).filter((seq) => !shadowed.has(seq))
      },
      get replaceGeneration() {
        return generation
      },
    },
    deriveMessages() {
      return events.map(deriveEventMessage).filter((message) => message !== null)
    },
    deriveEventMessage,
    // The host's prune re-materializes a message as a new event and points the
    // surface node at it; the old event stays in the append-only log.
    replace(oldSeq, type, data) {
      shadowed.add(oldSeq)
      generation += 1
      return this.append(type, data)
    },
  }
  return session
}

// -------------------------------------------------------------------- host --
function mount(session) {
  const handlers = new Map()
  const hooks = new Map()
  const ctx = {
    get: () => undefined,
    effect: (fn) => {
      fn()
      return () => {}
    },
    on: (name, fn) => {
      hooks.set(name, fn)
      return () => {}
    },
    sessions: { get: (id) => (id === session.id ? session : undefined) },
    agents: { get: () => undefined },
    webServer: {
      register: ({ path, handler }) => {
        handlers.set(path, handler)
        return () => {}
      },
    },
  }
  apply(ctx)
  return { handlers, hooks }
}

// `readJsonBody` subscribes to `data`/`end` synchronously; emit right after.
function request(body) {
  const listeners = new Map()
  const req = {
    method: 'POST',
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
      return req
    },
    destroy() {},
  }
  setImmediate(() => {
    for (const fn of listeners.get('data') ?? []) fn(Buffer.from(body))
    for (const fn of listeners.get('end') ?? []) fn()
  })
  return req
}

async function mark(session, env, seq) {
  const res = {
    status: 0,
    body: '',
    writeHead(code) {
      this.status = code
    },
    end(text) {
      this.body = text
    },
  }
  const body = JSON.stringify({ sessionId: session.id, seq, preview: 'rewind' })
  await env.handlers.get('/api/xsj-rewind/mark')(request(body), res)
  const parsed = JSON.parse(res.body)
  if (!parsed.ok) throw new Error(`mark failed: ${res.body}`)
  return parsed
}

// The host commits the pending rewind on the next pre-step that claims a real
// input message — before the loop appends it and derives the request.
function commit(session, env) {
  const preStep = env.hooks.get('agent/pre-step')
  preStep({ agent: { id: session.id, session }, messages: [{ role: 'user', content: [] }] }, () => {})
}

// The invariant every provider adapter enforces. Mirrors the DeepSeek Messages
// serializer: a result must answer a call of the immediately preceding
// assistant message, and no call may be left without one.
function pairingErrors(messages) {
  const errors = []
  let pending = new Set()
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!pending.delete(message.toolCallId)) errors.push(`orphan result ${message.toolCallId}`)
      continue
    }
    if (pending.size > 0) errors.push(`unanswered call ${[...pending].join(',')}`)
    pending = new Set(
      message.role === 'assistant'
        ? message.content.filter((block) => block.type === 'tool-call').map((block) => block.id)
        : [],
    )
  }
  if (pending.size > 0) errors.push(`unanswered call ${[...pending].join(',')}`)
  return errors
}

const shape = (messages) =>
  messages.map((m) => `${m.role}${m.role === 'tool' ? `:${m.toolCallId}` : ''}`).join(' ')

let failed = 0
function check(label, got, want) {
  const ok = got === want
  if (!ok) failed++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(56)} ${String(got).padEnd(30)} (want ${want})`)
}

// ------------------------------------------------------------------- cases --
function round() {
  const session = makeSession()
  session.append('user/message', userMessage('A').data)
  session.append('assistant/message', assistantCall('c1').data)
  session.append('tool/result', toolResult('c1').data)
  session.append('user/message', userMessage('B').data)
  session.append('assistant/message', assistantCall('c2').data)
  session.append('tool/result', toolResult('c2').data)
  const env = mount(session)
  return { session, env }
}

console.log('rewind tool pairing — regression against lib/index.js\n')

console.log('a rewind that hides a whole tool round')
{
  const { session, env } = round()
  await mark(session, env, 3)
  commit(session, env)
  const messages = session.deriveMessages()
  check('hidden round is gone, earlier round intact', shape(messages), 'user assistant tool:c1')
  check('history is serializable', pairingErrors(messages).join('; '), '')
}

console.log('\nhost re-materializes a hidden result outside the range')
{
  const { session, env } = round()
  await mark(session, env, 3)
  commit(session, env)
  // Turn N: the host prunes the (hidden) result of c2 and re-appends it.
  session.replace(5, 'tool/result', toolResult('c2').data)
  const messages = session.deriveMessages()
  check('orphan result is dropped', shape(messages), 'user assistant tool:c1')
  check('history is serializable', pairingErrors(messages).join('; '), '')
}

console.log('\nhost re-materializes a result, then a later rewind hides the copy')
{
  const { session, env } = round()
  // Prune before any rewind: the node for c1's result now points at a new event.
  session.replace(2, 'tool/result', toolResult('c1').data)
  await mark(session, env, 3)
  commit(session, env)
  const messages = session.deriveMessages()
  check('call without a result is stripped', shape(messages), 'user')
  check('history is serializable', pairingErrors(messages).join('; '), '')
}

console.log('\na duplicated result for the same call')
{
  const { session, env } = round()
  session.append('tool/result', toolResult('c1').data)
  await mark(session, env, 3)
  commit(session, env)
  const messages = session.deriveMessages()
  check('only the first result is kept', shape(messages), 'user assistant tool:c1')
  check('history is serializable', pairingErrors(messages).join('; '), '')
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) FAILED`)
process.exit(failed === 0 ? 0 : 1)
