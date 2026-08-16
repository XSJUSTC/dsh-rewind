// @xsj/dsh-rewind — host half (permanent bundle plugin).
//
// Rewind a conversation to any user message:
//   1. mark: the client picks a `user/message` event seq. The chat UI hides
//      every node anchored at/after it and pre-fills the composer (unsent,
//      editable). If the agent is running, the live turn is interrupted.
//   2. commit: the next turn that claims a real input message seals the hidden
//      range [targetSeq, current log end]; this session's deriveMessages() is
//      patched to skip hidden surface nodes, so the model never sees the tail
//      while the append-only log keeps every event.
//   3. cancel: clears the pending rewind — hidden rows reappear, nothing sends.
//
// Audit: every state change appends a `hook/invoked` event with payload
// { source: 'xsj.rewind', phase: 'mark' | 'cancel' | 'commit', ... }.
// 'hook/invoked' is a known-but-unused event type in this build, so the
// records are reload-safe and let a fresh boot rebuild committed ranges.

const SOURCE = 'xsj.rewind'
const API = '/api/xsj-rewind'
const MAX_BODY_BYTES = 64 * 1024

export const name = 'xsj-rewind'
export const inject = ['webServer', 'sessions', 'agents']

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        resolve(undefined)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}

function writeJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

export function apply(ctx) {
  const { sessions, agents, webServer } = ctx
  /** sid -> { pending: { targetSeq, markSeq } | null, ranges: { start, end }[], patched, scannedSeq } */
  const states = new Map()

  function stateFor(sid) {
    let st = states.get(sid)
    if (st === undefined) {
      st = { pending: null, ranges: [], patched: false, scannedSeq: 0 }
      states.set(sid, st)
    }
    return st
  }

  // Shadow deriveMessages with a range-filtered, memoized derivation. The
  // agent loop, the request-reconstruction invariant, and the image check all
  // call this one method, so a single patch keeps every reader consistent.
  function ensurePatched(session, st) {
    if (st.patched) return
    const original = session.deriveMessages
    if (typeof original !== 'function') return
    const ranges = st.ranges
    let cacheSig = ''
    let cacheOut = []
    Object.defineProperty(session, 'deriveMessages', {
      configurable: true,
      writable: true,
      value: function deriveMessagesWithRewind() {
        if (ranges.length === 0) return original.call(this)
        const surface = this.surface
        const nodes = surface.nodes
        const sig = `${nodes.length}:${ranges.length}:${surface.replaceGeneration}`
        if (sig === cacheSig) return cacheOut.slice()
        const events = this.events
        const out = []
        for (let i = 0; i < nodes.length; i++) {
          const seq = nodes[i]
          let hidden = false
          for (let j = 0; j < ranges.length; j++) {
            const r = ranges[j]
            if (seq >= r.start && seq <= r.end) {
              hidden = true
              break
            }
          }
          if (hidden) continue
          const message = this.deriveEventMessage(events[seq])
          if (message != null) out.push(message)
        }
        cacheSig = sig
        cacheOut = out
        return out.slice()
      },
    })
    st.patched = true
  }

  // Replay this session's rewind records (incrementally) into memory.
  function rebuild(session, st) {
    const events = session.events
    for (let i = st.scannedSeq; i < events.length; i++) {
      const event = events[i]
      if (event.type !== 'hook/invoked') continue
      const d = event.data
      if (d === null || typeof d !== 'object' || d.source !== SOURCE) continue
      if (d.phase === 'mark' && typeof d.targetSeq === 'number') {
        st.pending = { targetSeq: d.targetSeq, markSeq: event.seq }
      } else if (d.phase === 'cancel') {
        st.pending = null
      } else if (d.phase === 'commit' && typeof d.hiddenFrom === 'number' && typeof d.hiddenTo === 'number') {
        st.ranges.push({ start: d.hiddenFrom, end: d.hiddenTo })
        st.pending = null
      }
    }
    st.scannedSeq = events.length
    // A pending mark from a previous process lifetime is stale (its composer
    // draft is gone); only committed ranges survive a restart.
    if (st.pending !== null && st.pending.markSeq < session.firstLiveSeq) st.pending = null
  }

  function resolveSession(sid) {
    return typeof sid === 'string' && sid.length > 0 ? sessions.get(sid) : undefined
  }

  async function onMark(req, res) {
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'POST only' })
    const body = await readJsonBody(req)
    const session = resolveSession(body && body.sessionId)
    if (session === undefined) return writeJson(res, 404, { ok: false, error: 'unknown session' })
    const seq = body && typeof body.seq === 'number' ? body.seq : -1
    if (!Number.isSafeInteger(seq) || seq < 0) return writeJson(res, 400, { ok: false, error: 'bad seq' })
    const target = session.events[seq]
    if (target === undefined || target.type !== 'user/message') {
      return writeJson(res, 400, { ok: false, error: 'target is not a user message' })
    }
    const st = stateFor(String(session.id))
    rebuild(session, st)
    for (const r of st.ranges) {
      if (seq >= r.start && seq <= r.end) {
        return writeJson(res, 409, { ok: false, error: 'target is inside a committed hidden range' })
      }
    }
    ensurePatched(session, st)
    const preview = body && typeof body.preview === 'string' ? body.preview.slice(0, 120) : ''
    const record = session.append('hook/invoked', { source: SOURCE, phase: 'mark', targetSeq: seq, preview })
    st.pending = { targetSeq: seq, markSeq: record.seq }
    st.scannedSeq = session.seq
    // Interrupt a running turn: its remaining output belongs to the abandoned tail.
    try {
      const agent = agents.get(session.id)
      if (agent !== undefined && agent.status === 'running') agent.cancel({ kind: 'user' }, { keepInbox: true })
    } catch (error) {
      console.error('[xsj-rewind] interrupt failed:', error)
    }
    console.log(`[xsj-rewind] marked session ${String(session.id)} at user/message seq ${seq}`)
    writeJson(res, 200, { ok: true, targetSeq: seq, markSeq: record.seq })
  }

  async function onCancel(req, res) {
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'POST only' })
    const body = await readJsonBody(req)
    const session = resolveSession(body && body.sessionId)
    if (session === undefined) return writeJson(res, 404, { ok: false, error: 'unknown session' })
    const st = stateFor(String(session.id))
    rebuild(session, st)
    if (st.pending !== null) {
      const targetSeq = st.pending.targetSeq
      st.pending = null
      session.append('hook/invoked', { source: SOURCE, phase: 'cancel', targetSeq })
      st.scannedSeq = session.seq
      console.log(`[xsj-rewind] cancelled pending rewind of session ${String(session.id)} (was seq ${targetSeq})`)
    }
    writeJson(res, 200, { ok: true })
  }

  function onState(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const session = resolveSession(url.searchParams.get('sessionId') ?? undefined)
    if (session === undefined) return writeJson(res, 404, { ok: false, error: 'unknown session' })
    const st = stateFor(String(session.id))
    rebuild(session, st)
    ensurePatched(session, st)
    writeJson(res, 200, {
      ok: true,
      pending: st.pending === null ? null : { targetSeq: st.pending.targetSeq, markSeq: st.pending.markSeq },
      ranges: st.ranges.map((r) => ({ start: r.start, end: r.end })),
    })
  }

  ctx.effect(() => webServer.register({ kind: 'exact', path: API + '/mark', handler: onMark }))
  ctx.effect(() => webServer.register({ kind: 'exact', path: API + '/cancel', handler: onCancel }))
  ctx.effect(() => webServer.register({ kind: 'exact', path: API + '/state', handler: onState }))

  // Commit when a pending rewind's session next claims a real input message —
  // before the loop appends it and derives the request.
  ctx.on('agent/pre-step', (payload, next) => {
    try {
      const agent = payload && payload.agent
      if (agent && agent.id !== undefined) {
        const st = states.get(String(agent.id))
        if (st !== undefined && st.pending !== null && Array.isArray(payload.messages) && payload.messages.length > 0) {
          const session = agent.session
          const start = st.pending.targetSeq
          const end = session.seq - 1
          st.ranges.push({ start, end })
          st.pending = null
          ensurePatched(session, st)
          session.append('hook/invoked', {
            source: SOURCE, phase: 'commit', targetSeq: start, hiddenFrom: start, hiddenTo: end,
          })
          st.scannedSeq = session.seq
          console.log(`[xsj-rewind] committed session ${String(agent.id)}: hidden surface range [${start}, ${end}]`)
        }
      }
    } catch (error) {
      console.error('[xsj-rewind] commit failed:', error)
    }
    return next()
  })

  ctx.on('agent/disposed', (payload) => {
    try {
      const agent = payload && payload.agent
      if (agent && agent.id !== undefined) states.delete(String(agent.id))
    } catch {
      /* best-effort cleanup */
    }
  })

  // Unwind every deriveMessages patch with the plugin fiber.
  ctx.effect(() => () => {
    for (const [sid, st] of states) {
      if (!st.patched) continue
      const session = sessions.get(sid)
      if (session !== undefined) {
        try {
          delete session.deriveMessages
        } catch (error) {
          console.error(`[xsj-rewind] failed to unpatch session ${sid}:`, error)
        }
      }
    }
    states.clear()
  })
}
