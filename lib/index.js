// @xsj/dsh-rewind — host half (permanent bundle plugin).
//
// Rewind a conversation to any user message:
//   1. mark: the client picks a `user/message` event seq. The chat UI hides
//      that message and everything after it, and pre-fills the composer
//      (unsent, editable). If the agent is running, the live turn is
//      interrupted.
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

export const name = 'xsj-rewind'
export const inject = ['webServer', 'sessions', 'agents', 'attachments']

const SOURCE = 'xsj.rewind'
const API = '/api/xsj-rewind'
const MAX_BODY_BYTES = 64 * 1024

// ------------------------------------------------------------------ http --
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

function bodySeq(body) {
  const seq = body?.seq
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined
}

// ---------------------------------------------------------------- events --
// Read helpers prefer the official accessors and fall back to the plain
// arrays so the plugin keeps working across host release lines.
function eventsOf(session) {
  return typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events
}

function eventAt(session, seq) {
  return typeof session.eventAt === 'function' ? session.eventAt(seq) : eventsOf(session)?.[seq]
}

// Locate the durable image reference whose attachmentId matches, scanning the
// session log the same way the api controller authorizes image reads.
function imageRefInContent(content, attachmentId) {
  if (!Array.isArray(content)) return undefined
  for (const value of content) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    if (value.type === 'image' && typeof value.attachment === 'object' && value.attachment !== null && String(value.attachment.attachmentId) === attachmentId) {
      return value.attachment
    }
    if (value.type === 'tool-result') {
      const nested = imageRefInContent(value.content, attachmentId)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

function findReferencedImage(session, attachmentId) {
  const events = eventsOf(session) ?? []
  for (const event of events) {
    const data = event?.data
    if (data === null || typeof data !== 'object') continue
    const direct = imageRefInContent(data.content, attachmentId)
    if (direct !== undefined) return direct
    const message = imageRefInContent(data.message?.content, attachmentId)
    if (message !== undefined) return message
    for (const inserted of data.inserted ?? []) {
      const found = imageRefInContent(inserted.content, attachmentId)
      if (found !== undefined) return found
    }
  }
  return undefined
}

// ----------------------------------------------------------------- state --
// sid -> { pending: { targetSeq, markSeq } | null, ranges: {start,end}[],
//          patched, scannedSeq }
export function apply(ctx) {
  const { sessions, agents, webServer, attachments } = ctx
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
  // The `ranges` array is captured by identity and mutated in place (push) —
  // the closure always observes the current ranges without re-patching.
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
        const nodes = this.surface.nodes
        const sig = `${nodes.length}:${ranges.length}:${this.surface.replaceGeneration}`
        if (sig === cacheSig) return cacheOut.slice()
        const events = eventsOf(this)
        const out = []
        for (const seq of nodes) {
          if (ranges.some((r) => seq >= r.start && seq <= r.end)) continue
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
    const events = eventsOf(session) ?? []
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
    if (typeof sid !== 'string' || sid.length === 0) return undefined
    return sessions.get(sid)
  }

  async function onMark(req, res) {
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'POST only' })
    const body = await readJsonBody(req)
    const session = resolveSession(body?.sessionId)
    if (session === undefined) return writeJson(res, 404, { ok: false, error: 'unknown session' })
    const seq = bodySeq(body)
    if (seq === undefined) return writeJson(res, 400, { ok: false, error: 'bad seq' })
    const target = eventAt(session, seq)
    if (target === undefined || target.type !== 'user/message') {
      return writeJson(res, 400, { ok: false, error: 'target is not a user message' })
    }
    const st = stateFor(String(session.id))
    rebuild(session, st)
    if (st.ranges.some((r) => seq >= r.start && seq <= r.end)) {
      return writeJson(res, 409, { ok: false, error: 'target is inside a committed hidden range' })
    }
    ensurePatched(session, st)
    const preview = typeof body?.preview === 'string' ? body.preview.slice(0, 120) : ''
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
    const session = resolveSession(body?.sessionId)
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
    writeJson(res, 200, {
      ok: true,
      pending: st.pending === null ? null : { targetSeq: st.pending.targetSeq, markSeq: st.pending.markSeq },
      ranges: st.ranges.map((r) => ({ start: r.start, end: r.end })),
    })
  }

  // Read back the durable bytes of one image in this session, so the client
  // can re-attach it to the composer on rewind. The session log provably
  // references the attachment (authorization), and readImage verifies the
  // stored object's integrity before it leaves the host.
  async function onImage(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const session = resolveSession(url.searchParams.get('sessionId') ?? undefined)
    if (session === undefined) return writeJson(res, 404, { ok: false, error: 'unknown session' })
    const attachmentId = url.searchParams.get('attachmentId')
    if (attachmentId === null || attachmentId.length === 0) return writeJson(res, 400, { ok: false, error: 'bad attachmentId' })
    const ref = findReferencedImage(session, attachmentId)
    if (ref === undefined) return writeJson(res, 404, { ok: false, error: 'image not referenced by this session' })
    try {
      const { ref: stored, data } = await attachments.readImage(ref)
      return writeJson(res, 200, {
        ok: true,
        mediaType: stored.mediaType,
        name: typeof stored.name === 'string' ? stored.name : undefined,
        data: Buffer.from(data).toString('base64'),
      })
    } catch (error) {
      console.error('[xsj-rewind] image read failed:', error)
      return writeJson(res, 500, { ok: false, error: 'attachment read failed' })
    }
  }

  const withErrLog = (fn) => async (req, res) => {
    try {
      await fn(req, res)
    } catch (error) {
      console.error('[xsj-rewind]', error?.stack || String(error))
      try {
        writeJson(res, 500, { ok: false, error: String(error?.message || error).slice(0, 120) })
      } catch { /* response already gone */ }
    }
  }
  ctx.effect(() => webServer.register({ kind: 'exact', path: API + '/mark', handler: withErrLog(onMark) }))
  ctx.effect(() => webServer.register({ kind: 'exact', path: API + '/cancel', handler: withErrLog(onCancel) }))
  ctx.effect(() => webServer.register({ kind: 'exact', path: API + '/state', handler: withErrLog(onState) }))
  ctx.effect(() => webServer.register({ kind: 'exact', path: API + '/image', handler: withErrLog(onImage) }))

  // Commit when a pending rewind's session next claims a real input message —
  // before the loop appends it and derives the request.
  ctx.on('agent/pre-step', (payload, next) => {
    try {
      const agent = payload?.agent
      const st = agent?.id !== undefined ? states.get(String(agent.id)) : undefined
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
    } catch (error) {
      console.error('[xsj-rewind] commit failed:', error)
    }
    return next()
  })

  ctx.on('agent/disposed', (payload) => {
    try {
      const agent = payload?.agent
      if (agent?.id !== undefined) states.delete(String(agent.id))
    } catch { /* best-effort cleanup */ }
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
