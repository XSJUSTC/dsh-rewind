// @xsj/dsh-rewind — client half (permanent bundle plugin, no build step).
//
// Classic-script bundle contract: executing this file only REGISTERS the
// factory; the web module system materializes it once at mount. Externals
// (react, ui primitives) resolve through the shell's frozen module table.
//
// What the user sees:
//   - every user message row carries a rewind (↺) action beside copy;
//   - clicking it interrupts any running turn, hides that message and
//     everything after it, and pre-fills the composer (unsent, editable);
//   - while a rewind is pending, a ✕ button appears left of the send button
//     (cancel: restore the hidden rows, keep the draft, send nothing), plus a
//     banner above the composer explaining the state;
//   - after the next send, the tail stays hidden from both the chat view and
//     the model; the durable log keeps every event (see the host half).
//
// Hiding is pure DOM (inline display:none on the chat view's
// data-chat-flow-key rows), driven by the composer-mounted cancel entry
// (always present for the active session), so cancelling or switching
// sessions restores the untouched shipped UI.

window.__ModuleLoader__.load({
  id: '@xsj/dsh-rewind',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var UiPrimitives = require('@deepseek-ai/dsh-client-ui-primitives')

    var API = '/api/xsj-rewind'

    // ---------------------------------------------------------------- http --
    function post(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json()).catch(() => null)
    }
    function get(path) {
      return fetch(API + path).then((r) => r.json()).catch(() => null)
    }

    // ---------------------------------------------- image re-attachment --
    // Rewind pre-fills only the text draft; images must be re-attached to the
    // composer. The composer exposes a hidden <input type=file multiple> whose
    // change handler runs the official intake (createDrafts + addAttachments +
    // image-limit checks). We read each durable image's bytes from the host and
    // feed them back through that same input, so re-attachment inherits every
    // shipped guard instead of bypassing it.
    function b64ToBytes(b64) {
      var bin = atob(b64)
      var bytes = new Uint8Array(bin.length)
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return bytes
    }

    // Serialized: the composer intake appends whatever the input carries, so two
// overlapping re-attachments would race on the same <input>. One queue per
// page keeps each batch's files intact.
    var reattachChain = Promise.resolve()

    function reattachImages(sid, images) {
      var list = Array.isArray(images) ? images : []
      if (list.length === 0) return Promise.resolve(0)
      reattachChain = reattachChain.then(() => reattachBatch(sid, list), () => reattachBatch(sid, list))
      return reattachChain
    }

    function reattachBatch(sid, list) {
      var jobs = list.map((img) => {
        var ref = img && img.attachment ? img.attachment : null
        if (ref === null || ref.attachmentId === undefined) return null
        var q = '/image?sessionId=' + encodeURIComponent(sid) + '&attachmentId=' + encodeURIComponent(String(ref.attachmentId))
        return get(q).then((res) => {
          if (!res || res.ok !== true || typeof res.data !== 'string') throw new Error('image read failed')
          var mediaType = res.mediaType || ref.mediaType || 'image/png'
          var name = res.name || ref.name || 'image.png'
          return new File([b64ToBytes(res.data)], name, { type: mediaType })
        })
      }).filter((job) => job !== null)
      return Promise.all(jobs).then((files) => {
        var real = files.filter((f) => f instanceof File)
        if (real.length === 0) return 0
        var input = composerFileInput()
        if (input === null) {
          console.warn('[xsj-rewind] composer file input not found — images not re-attached')
          return 0
        }
        try {
          // Reset first: assigning an identical FileList is a no-op and would
          // fire no change event. The intake clears value itself, but a failed
          // previous batch could have left a stale selection behind.
          input.value = ''
          var dt = new DataTransfer()
          real.forEach((f) => dt.items.add(f))
          input.files = dt.files
          input.dispatchEvent(new Event('change', { bubbles: true }))
          return real.length
        } catch (e) {
          console.error('[xsj-rewind] reattach failed:', e)
          return 0
        }
      })
    }

    // The composer owns the only multiple-file input, but other plugins may
    // mount their own. Prefer one inside the live composer subtree and require
    // the `multiple` attribute the intake needs. `data-composer-card` is the
    // composer card's own attribute in the current shell; the older
    // `data-composer` / `data-dsh-composer` spellings are kept so the scoping
    // still works on hosts that used them.
    function composerFileInput() {
      var roots = document.querySelectorAll('[data-composer-card], [data-composer-seat], [data-composer], [data-dsh-composer], form')
      for (var i = 0; i < roots.length; i++) {
        var found = roots[i].querySelector('input[type="file"][multiple]')
        if (found !== null) return found
      }
      return document.querySelector('input[type="file"][multiple]')
    }

    // ----------------------------------------------- per-session UI state --
    // { pending: null | { targetSeq, markSeq }, ranges: {start,end}[], version,
    //   fetched: bool, fetchFailed: bool }
    // `fetched` distinguishes "the host told us there are no ranges" from "we
    // have not heard back yet". Without it an unknown session and an
    // all-visible session are indistinguishable, so a cold load (or a failed
    // /state read) would render a committed rewind's tail as visible.
    // Bounded: a long-lived page visits many sessions, and an unbounded map
    // would retain one record per session forever. Oldest entries evict first;
    // the composer re-fetches /state when a session becomes active again.
    var MAX_TRACKED_SESSIONS = 24
    var states = new Map()
    var listeners = new Set()
    function readState(sid) { return states.get(sid) }
    function writeState(sid, mut) {
      var prev = states.get(sid)
      states.delete(sid)
      states.set(sid, {
        pending: mut && Object.prototype.hasOwnProperty.call(mut, 'pending') ? mut.pending : prev ? prev.pending : null,
        ranges: mut && Object.prototype.hasOwnProperty.call(mut, 'ranges') ? mut.ranges : prev ? prev.ranges : [],
        // Sticky: once the host has answered for this session, a later write
        // (e.g. a local mark) must not reset the flag and re-blind the driver.
        fetched: mut && Object.prototype.hasOwnProperty.call(mut, 'fetched') ? mut.fetched : prev ? prev.fetched : false,
        fetchFailed: mut && Object.prototype.hasOwnProperty.call(mut, 'fetchFailed') ? mut.fetchFailed : prev ? prev.fetchFailed : false,
        version: (prev ? prev.version : 0) + 1,
      })
      // Map preserves insertion order, so the first key is the least recently
      // written one.
      while (states.size > MAX_TRACKED_SESSIONS) {
        var oldest = states.keys().next()
        if (oldest.done) break
        states.delete(oldest.value)
      }
      Array.from(listeners).forEach((fn) => {
        try { fn() } catch (e) { console.error('[xsj-rewind]', e) }
      })
    }
    function subscribe(fn) {
      listeners.add(fn)
      return function () { listeners.delete(fn) }
    }
    function useRewind(sid) {
      return React.useSyncExternalStore(subscribe, () => readState(sid))
    }
    // =============================================== DOM-native driver ====
    // Per-session resync latch: a module-level flag would let one session's
    // in-flight /state read suppress another session's commit detection.
    var rwResyncing = new Set()
    function rwFlowList() { return document.querySelector('[data-chat-flow]') }
    function rwRows() {
      var list = rwFlowList()
      if (!list) return []
      return Array.prototype.slice.call(list.children).filter((el) => {
        return el.getAttribute && (el.hasAttribute('data-chat-flow-key') || el.hasAttribute('data-chat-anchor-key'))
      })
    }
    function rwSeq(el) {
      var v = el.getAttribute('data-xsj-seq')
      if (v === null || v === '') return null
      var n = Number(v)
      return Number.isFinite(n) ? n : null
    }
    // Only the `user`/`steering` renderers are shadowed by this plugin, so only
    // those rows were ever stamped with their seq. Every other kind — most
    // importantly the model's own `assistant-step` output, plus tool calls,
    // context and command rows — rendered through the shipped renderer and
    // stayed unstamped. A committed range could therefore never hide them:
    // rwSeq() returned null and, once `pending` cleared, the row fell through to
    // the "no evidence" branch — i.e. visible. That is the reported defect: the
    // user message disappears, the model's answer stays on screen.
    //
    // The fix does not need a guessed seq. A hidden range is a contiguous span of
    // the flow, and the flow is rendered in seq order, so a row is inside some
    // range exactly when it sits after a row already known to be hidden and
    // before the next row known to be visible. Stamped rows supply both kinds of
    // evidence — a row is "known hidden" when its seq falls in a committed range
    // or at/after a pending target, and "known visible" when its seq is outside
    // every range and before the pending target. Unstamped rows are then decided
    // by their bracketing, which is what makes the model's output hide with the
    // prompt that produced it.
    function rwRowVerdicts(rows, ranges, targetIdx) {
      var verdicts = new Array(rows.length)
      for (var i = 0; i < rows.length; i++) {
        var seq = rwSeq(rows[i])
        if (seq === null) { verdicts[i] = null; continue }
        verdicts[i] = inRanges(seq, ranges) || (targetIdx >= 0 && i >= targetIdx)
      }
      return verdicts
    }
    // Fill each unknown verdict from the evidence around it. A row with no stamp of
    // its own is the body of the turn it follows, so it belongs to the side of
    // the nearest stamped row BEFORE it — that is what keeps an assistant answer
    // with the prompt that produced it. `after` alone is not enough: a row just
    // above a hidden range would otherwise be swept in, hiding the answer to a
    // prompt that is still visible.
    //
    // A leading run of unstamped rows (no evidence before it) has only the
    // following evidence to go on, so it inherits that. With no evidence at all
    // it stays visible, because hiding on a guess costs a missing rewind button
    // on new messages.
    function rwSolveVerdicts(verdicts) {
      var n = verdicts.length
      var before = new Array(n)
      var seen = null
      for (var i = 0; i < n; i++) {
        if (verdicts[i] !== null) seen = verdicts[i]
        before[i] = seen
      }
      var after = new Array(n)
      seen = null
      for (var j = n - 1; j >= 0; j--) {
        if (verdicts[j] !== null) seen = verdicts[j]
        after[j] = seen
      }
      var out = new Array(n)
      for (var k = 0; k < n; k++) {
        if (verdicts[k] !== null) { out[k] = verdicts[k]; continue }
        out[k] = before[k] !== null ? before[k] : after[k] === true
      }
      return out
    }
    function rwSetHidden(el, hide) {
      if (hide) {
        if (el.getAttribute('data-xsj-hidden') !== '1') {
          el.setAttribute('data-xsj-hidden', '1')
          el.style.setProperty('display', 'none', 'important')
        }
      } else if (el.getAttribute('data-xsj-hidden') === '1') {
        el.removeAttribute('data-xsj-hidden')
        el.style.removeProperty('display')
      }
    }
    function inRanges(seq, ranges) {
      return ranges.some((r) => seq >= r.start && seq <= r.end)
    }
    // Unhide every row this plugin hid. Only rows carrying the marker are
    // touched, so a row hidden by some other feature keeps its display value.
    // Queried rather than taken from rwRows() because teardown can run while the
    // flow list is being replaced, and an orphaned row must still be released.
    function rwRestoreAll() {
      var marked = document.querySelectorAll('[data-xsj-hidden="1"]')
      for (var i = 0; i < marked.length; i++) {
        rwSetHidden(marked[i], false)
      }
    }
    function rwApply(sid) {
      var rows = rwRows()
      var st = readState(sid)
      // Before the host has answered for this session we know nothing about its
      // committed ranges. Deciding "all visible" here would flash the rewound
      // tail on every cold load, and a failed /state read would leave it visible
      // permanently — the UI disagreeing with the model's actual context.
      //
      // But a locally recorded pending mark is real state the host has already
      // acknowledged via /mark, so it must still be applied: only hold when we
      // have nothing at all to act on.
      var unfetched = !st || st.fetched !== true
      if (unfetched && (!st || st.pending == null)) {
        // Nothing known and nothing pending: keep the current verdicts and let
        // the fetch (or its retry) decide.
        if (st && st.fetchFailed === true) rwRefetch(sid)
        return
      }
      var pending = st.pending
      // Committed ranges are only trustworthy once the host has answered; a
      // local mark never invents one.
      var ranges = unfetched ? [] : (st.ranges || [])
      if (unfetched && st.fetchFailed === true) rwRefetch(sid)
      var targetIdx = -1
      if (pending) {
        for (var i = 0; i < rows.length; i++) { if (rwSeq(rows[i]) === pending.targetSeq) { targetIdx = i; break } }
      }
      // Only stamped rows carry direct evidence; every other kind — notably the
      // model's assistant output — is resolved from its neighbours. Without
      // this, a committed range hid the user prompt but left the answer visible.
      var verdicts = rwSolveVerdicts(rwRowVerdicts(rows, ranges, targetIdx))
      for (var m = 0; m < rows.length; m++) {
        rwSetHidden(rows[m], verdicts[m] === true)
      }
      // commit 检测: pending 之后出现了戳 seq > markSeq 的新行 → 从服务端重新同步
      if (pending && !rwResyncing.has(sid)) {
        var boundary = pending.markSeq || pending.targetSeq
        for (var q = Math.max(targetIdx + 1, 0); q < rows.length; q++) {
          var s2 = rwSeq(rows[q])
          if (s2 !== null && s2 > boundary) {
            rwResyncing.add(sid)
            get('/state?sessionId=' + encodeURIComponent(sid)).then((res) => {
              rwResyncing.delete(sid)
              if (res) applyHostState(sid, res)
            }).catch(() => { rwResyncing.delete(sid) })
            break
          }
        }
      }
    }

    function applyHostState(sid, res) {
      if (!res || res.ok !== true) return
      writeState(sid, {
        pending: res.pending ? {
          targetSeq: res.pending.targetSeq,
          markSeq: typeof res.pending.markSeq === 'number' ? res.pending.markSeq : res.pending.targetSeq,
        } : null,
        ranges: Array.isArray(res.ranges) ? res.ranges : [],
        fetched: true,
        fetchFailed: false,
      })
    }
    // Read this session's rewind state and record that the host has answered.
    // Resolves true only when a usable answer arrived, so the caller can flag a
    // failure and the driver can retry instead of leaving rows visible.
    function rwLoadState(sid) {
      return get('/state?sessionId=' + encodeURIComponent(sid)).then((res) => {
        if (!res || res.ok !== true) return false
        applyHostState(sid, res)
        return true
      }).catch(() => false)
    }
    // One in-flight retry per session. The retry writes state only when the flag
// actually changes: writeState bumps `version`, which re-runs the driver effect,
// so an unconditional write on every failed retry would schedule the next retry
// and loop forever against a host that stays down.
    var rwRetrying = new Set()
    function rwRefetch(sid) {
      if (rwRetrying.has(sid)) return
      var cur = readState(sid)
      if (cur && cur.fetched === true) return
      rwRetrying.add(sid)
      setTimeout(() => {
        rwRetrying.delete(sid)
        rwLoadState(sid).then((ok) => {
          if (ok) return
          var now = readState(sid)
          // Already flagged: leave the version alone so the driver stays idle
          // until the next real mutation or a fresh mount asks again.
          if (now && now.fetchFailed === true) return
          writeState(sid, { fetchFailed: true })
        })
      }, 2000)
    }

    // -------------------------------------------------------------- i18n --
    var zh = (typeof navigator !== 'undefined' ? navigator.language || '' : '').toLowerCase().indexOf('zh') === 0
    var L = zh ? {
      rewind: '回退到此消息',
      cancel: '取消回溯',
      copy: '复制',
      copied: '已复制',
      banner: '已回退到一条历史消息（其内容在输入框中，可编辑）。发送后将从此处继续，后续消息对模型不可见；点输入框右侧 ✕ 取消回溯。',
      image: '图片',
      extra: '附加数据块',
      truncated: (total) => '已截断（共 ' + total + ' 项）',
    } : {
      rewind: 'Rewind to this message',
      cancel: 'Cancel rewind',
      copy: 'Copy',
      copied: 'Copied',
      banner: 'Rewound to an earlier message (its text is in the composer, editable). Sending continues from there and hides the tail from the model; click the ✕ left of Send to cancel.',
      image: 'image',
      extra: 'Extra content block',
      truncated: (total) => 'Truncated (' + total + ' total)',
    }

    // ------------------------------------------------------------ helpers --
    // `image` and `file` blocks are both attachments and keep their source
    // order; anything else is free-form content the JSON fallback renders. The
    // shipped row splits exactly these three ways, so a row this plugin shadows
    // must not downgrade a file card into a raw JSON block.
    function contentParts(content) {
      var texts = [], attachments = [], images = [], rest = []
      if (Array.isArray(content)) {
        for (var i = 0; i < content.length; i++) {
          var b = content[i]
          if (b && b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
          else if (b && b.type === 'image' && b.attachment !== undefined) {
            var source = { attachment: b.attachment }
            images.push(source)
            attachments.push({ image: source })
          } else if (b && b.type === 'file' && b.attachment !== undefined) attachments.push({ file: b.attachment })
          else rest.push(b)
        }
      }
      return { text: texts.join(''), attachments: attachments, images: images, rest: rest }
    }
    // File attachment card: name, upper-cased extension and human size, the
    // same three facts the shipped bubble shows.
    function fileCard(file, key) {
      var name = typeof file.name === 'string' ? file.name : ''
      var ext = typeof UiPrimitives.fileExtension === 'function' ? String(UiPrimitives.fileExtension(name)) : ''
      var size = typeof UiPrimitives.fileSizeText === 'function' && typeof file.bytes === 'number'
        ? String(UiPrimitives.fileSizeText(file.bytes))
        : ''
      var meta = [ext.toUpperCase().slice(0, 8), size].filter(Boolean).join(' ')
      var icon = typeof UiPrimitives.FileTypeIcon === 'function'
        ? React.createElement(UiPrimitives.FileTypeIcon, { key: 'icon', path: name, className: 'xsj-rw-file-icon' })
        : null
      return React.createElement('span', { key: key, className: 'xsj-rw-file', title: name },
        icon,
        React.createElement('span', { key: 'body', className: 'xsj-rw-file-body' },
          React.createElement('span', { key: 'name', className: 'xsj-rw-file-name' }, name),
          meta === '' ? null : React.createElement('span', { key: 'meta', className: 'xsj-rw-file-meta' }, meta)))
    }
    function pad2(n) { return n < 10 ? '0' + n : String(n) }
    function fmtClock(time) {
      try {
        var d = new Date(time)
        var now = new Date()
        var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes())
        if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm
        return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm
      } catch (e) { return '' }
    }
    function svgIcon(paths) {
      return React.createElement('svg', {
        viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      }, paths)
    }
    // The primitives icon set became weight-suffixed (`IconCopyOutlineRegular`)
    // and the old bare `…16` names are gone; resolve across both spellings so a
    // newer host and an older one both work. A missing member reaches
    // createElement as `undefined`, which is an invalid element type: it throws
    // while rendering the row, and the slot boundary then abdicates the whole
    // `user`/`steering` cell back to the shipped renderer — no rewind button,
    // and no seq stamp for the hiding driver to work from.
    function primitiveIcon(names) {
      for (var i = 0; i < names.length; i++) {
        if (typeof UiPrimitives[names[i]] === 'function') return UiPrimitives[names[i]]
      }
      return null
    }
    var COPY_ICON = primitiveIcon(['IconCopyOutlineRegular', 'IconCopyOutline16'])
    var CHECK_ICON = primitiveIcon(['IconCheckOutlineRegular', 'IconCheckOutline16'])
    function iconElement(component) {
      return component === null ? null : React.createElement(component, {})
    }
    var REWIND_ICON = svgIcon([
      React.createElement('path', { key: 'arc', d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }),
      React.createElement('path', { key: 'head', d: 'M3 3v5h5' }),
    ])
    var CANCEL_ICON = svgIcon([
      React.createElement('path', { key: 'a', d: 'M18 6 6 18' }),
      React.createElement('path', { key: 'b', d: 'M6 6l12 12' }),
    ])
    function iconButton(tooltip, className, icon, handlers) {
      return React.createElement(UiPrimitives.Tooltip, { label: tooltip, side: handlers.side },
        React.createElement('button', {
          type: 'button', className, 'aria-label': tooltip, onClick: handlers.onClick,
          disabled: handlers.disabled,
        }, icon))
    }

    // -------------------------------------------- user message node view --
    // Faithful replacement for the shipped user/steering row (bubble + copy +
    // clock), adding the rewind action. Registered with a shadowing priority
    // so this cell replaces the shipped renderer while the plugin is mounted.
    function UserNodeView(props) {
      var node = props.node
      var data = node && node.data ? node.data : { content: [] }
      var parts = contentParts(data.content)
      var sid = props.sessionId
      var copiedState = React.useState(false)
      var copied = copiedState[0]
      var setCopied = copiedState[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var rootRef = React.useRef(null)
      React.useLayoutEffect(() => {
        try {
          var el = rootRef.current
          if (!el || !el.closest) return
          var row = el.closest('[data-chat-flow-key]') || el.closest('[data-chat-anchor-key]')
          if (row && typeof data.seq === 'number' && row.getAttribute('data-xsj-seq') !== String(data.seq)) {
            row.setAttribute('data-xsj-seq', String(data.seq))
            window.dispatchEvent(new Event('xsj-rw-stamp'))
          }
        } catch (e) { /* ignore */ }
      })

      function onCopy() {
        if (copied) return
        UiPrimitives.writeClipboard(parts.text).then((ok) => {
          if (ok) setCopied(true)
        }).catch(() => { /* clipboard unavailable */ })
      }
      function onRewind() {
        if (busy) return
        setBusy(true)
        post('/mark', { sessionId: sid, seq: data.seq, preview: parts.text.slice(0, 120) }).then((res) => {
          if (res && res.ok === true) {
            writeState(sid, { pending: {
              targetSeq: data.seq,
              markSeq: typeof res.markSeq === 'number' ? res.markSeq : data.seq,
            } })
            if (props.inputActions && typeof props.inputActions.setDraft === 'function') {
              props.inputActions.setDraft(parts.text)
            }
            // Re-attach any images that rode the original message, so they end
            // up back in the composer instead of being dropped by the rewind.
            if (parts.images.length > 0) {
              reattachImages(sid, parts.images).catch((e) => {
                console.error('[xsj-rewind] image reattach failed:', e)
              })
            }
          } else {
            console.error('[xsj-rewind] mark rejected:', res && res.error)
          }
        }).catch((e) => {
          console.error('[xsj-rewind] mark failed:', e)
        }).then(() => { setBusy(false) })
      }

      var stackChildren = []
      if (parts.attachments.length > 0) {
        // 0.1.5-rc.2 no longer exports an ImageGallery component from the
        // attachment module (its client half only exposes apply/inject); the
        // shipped bubble renders images through the renderMessageImages prop,
        // which routes to the conversation.message.images slot. Mirror that.
        // A missing prop must not throw: it would take the whole row — and
        // every sibling row — down with it.
        var renderImages = props.renderMessageImages
        var compactAttachments = parts.attachments.length > 1
        var attachmentNodes = []
        var renderedImages = 0
        for (var ai = 0; ai < parts.attachments.length; ai++) {
          var attachment = parts.attachments[ai]
          if (attachment.file !== undefined) {
            attachmentNodes.push(fileCard(attachment.file, 'file-' + ai))
          } else if (typeof renderImages === 'function') {
            renderedImages++
            attachmentNodes.push(React.createElement('div', { key: 'image-' + ai, className: 'xsj-rw-image' },
              renderImages({ images: [attachment.image], align: 'end', compact: compactAttachments })))
          }
        }
        if (attachmentNodes.length > 0) {
          stackChildren.push(React.createElement('div', { key: 'attachments', className: 'xsj-rw-attachments' }, attachmentNodes))
        }
        if (renderedImages < parts.images.length) {
          stackChildren.push(React.createElement('div', { key: 'images-missing', className: 'xsj-rw-images-missing' }, L.image))
        }
      }
      if (parts.text !== '' || parts.rest.length > 0) {
        var bubbleChildren = []
        if (parts.text !== '') {
          // 0.1.5-rc.2 removed primitives.MessageText; the shipped user bubble
          // now renders text through projectUserText (span runs + ref chips),
          // so mirror that here and let CSS handle wrapping. Session labels and
          // skill names arrive on the node and decorate `@label` / `/skill`
          // tokens; the shipped row passes both, so dropping them would render
          // a rewound row's references as plain text.
          bubbleChildren.push(React.createElement('div', { key: 'text', className: 'xsj-rw-text' },
            UiPrimitives.projectUserText(
              parts.text,
              Array.isArray(data.referenceLabels) ? data.referenceLabels : [],
              Array.isArray(data.skillNames) ? data.skillNames : [],
              'skill',
              typeof props.openFile === 'function' && typeof props.openSkill === 'function'
                ? { openFile: props.openFile, openSkill: props.openSkill }
                : undefined)))
        }
        parts.rest.forEach((block, i) => {
          bubbleChildren.push(React.createElement(UiPrimitives.JsonBlock, {
            key: 'rest-' + i, label: L.extra, payload: block, truncatedLabel: L.truncated,
          }))
        })
        stackChildren.push(React.createElement('div', { key: 'bubble', className: 'xsj-rw-bubble' }, bubbleChildren))
      }

      var actionsChildren = []
      if (typeof data.time === 'number') {
        actionsChildren.push(React.createElement('span', { key: 'clock', className: 'xsj-rw-clock' }, fmtClock(data.time)))
      }
      actionsChildren.push(iconButton(copied ? L.copied : L.copy, 'xsj-rw-action',
        copied ? iconElement(CHECK_ICON) : iconElement(COPY_ICON),
        { onClick: onCopy, side: 'bottom' }))
      actionsChildren.push(iconButton(L.rewind, 'xsj-rw-action xsj-rw-trigger', REWIND_ICON,
        { onClick: onRewind, disabled: busy, side: 'bottom' }))

      return React.createElement('div', { className: 'xsj-rw-row', 'data-time-hover-root': true, ref: rootRef },
        React.createElement('div', { key: 'stack', className: 'xsj-rw-stack' }, stackChildren),
        React.createElement('div', { key: 'actions', className: 'xsj-rw-actions' }, actionsChildren))
    }

    // ------------------------------------------------- cancel + css driver --
    // Mounted in the composer tool row for the active session: owns the host
    // state sync (attach + commit detection) and drives the row hiding.
    function CancelButton(props) {
      var sid = props.sessionId
      var st = useRewind(sid)
      var pending = st && st.pending ? st.pending : null

      // Attach: rebuild UI state from the server (covers refresh & restart).
      React.useEffect(() => {
        var live = true
        rwLoadState(sid).then((ok) => {
          if (live && !ok) writeState(sid, { fetchFailed: true })
        })
        return function () { live = false }
      }, [sid])

      // DOM driver: rerun on any state version bump and on chat mutations.
      React.useEffect(() => {
        var t = 0
        function schedule() {
          clearTimeout(t)
          t = setTimeout(() => { try { rwApply(sid) } catch (e) { console.error('[xsj-rewind] hide', e) } }, 150)
        }
        schedule()
        var obs = new MutationObserver(schedule)
        obs.observe(document.body, { childList: true, subtree: true })
        window.addEventListener('xsj-rw-stamp', schedule)
        return function () {
          clearTimeout(t)
          obs.disconnect()
          window.removeEventListener('xsj-rw-stamp', schedule)
          // Hiding is applied to the live DOM, so it must be undone on teardown.
          // Without this, a session switch, a composer remount, or an owner
          // change leaves the last-painted rows hidden with no driver left to
          // restore them — blank rows in a session that was never rewound.
          try { rwRestoreAll() } catch (e) { console.error('[xsj-rewind] restore', e) }
        }
      }, [sid, st ? st.version : 0])

      function onCancel() {
        post('/cancel', { sessionId: sid }).then((res) => {
          if (res && res.ok === true) writeState(sid, { pending: null })
        }).catch((e) => { console.error('[xsj-rewind] cancel failed:', e) })
      }

      if (pending === null) return null
      return iconButton(L.cancel, 'xsj-rw-cancel', CANCEL_ICON, { onClick: onCancel, side: 'top' })
    }

    // -------------------------------------------------------------- banner --
    function Banner(props) {
      var st = useRewind(props.sessionId)
      var pending = st && st.pending ? st.pending : null
      if (pending === null) return null
      return React.createElement('div', { className: 'xsj-rw-banner' },
        React.createElement('span', { className: 'xsj-rw-banner-icon', 'aria-hidden': true }, '↺'),
        React.createElement('span', null, L.banner))
    }

    var BASE_CSS = [
      '.xsj-rw-row{display:flex;flex-direction:column;align-items:flex-end;gap:6px;min-width:0}',
      '.xsj-rw-stack{display:flex;flex-direction:column;align-items:flex-end;gap:8px;min-width:0;max-width:min(525px,82%)}',
      '.xsj-rw-bubble{background:var(--dsw-specific-bubble,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,inherit);border-radius:22px;padding:10px 16px;font-size:16px;line-height:24px;max-width:100%;box-sizing:border-box;overflow-wrap:anywhere}',
      '.xsj-rw-bubble p{margin:0}',
      '.xsj-rw-attachments{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;max-width:100%}',
      '.xsj-rw-image{display:flex;max-width:100%}',
      '.xsj-rw-images-missing{color:var(--dsw-alias-label-tertiary,#98a2b3);font-size:13px}',
      '.xsj-rw-file{display:inline-flex;align-items:center;gap:8px;max-width:min(320px,100%);box-sizing:border-box;padding:8px 12px;border-radius:12px;background:var(--dsw-specific-bubble,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,inherit)}',
      '.xsj-rw-file-icon{flex:none}',
      '.xsj-rw-file-body{display:flex;flex-direction:column;min-width:0}',
      '.xsj-rw-file-name{font-size:14px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.xsj-rw-file-meta{color:var(--dsw-alias-label-tertiary,#98a2b3);font-size:12px;line-height:16px}',
      '.xsj-rw-text{white-space:pre-wrap;word-break:break-word}',
      '.xsj-rw-actions{display:flex;align-items:center;gap:2px;height:28px}',
      '.xsj-rw-clock{color:var(--dsw-alias-label-tertiary,#98a2b3);white-space:nowrap;padding-right:10px;font-size:14px;line-height:24px;font-variant-numeric:tabular-nums}',
      '.xsj-rw-action{width:28px;height:28px;color:var(--dsw-alias-label-tertiary,#98a2b3);cursor:pointer;background:transparent;border:none;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;padding:6px}',
      '.xsj-rw-action:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));color:var(--dsw-alias-label-secondary,inherit)}',
      '.xsj-rw-action:disabled{opacity:.45;cursor:default}',
      '@media(hover:hover){[data-time-hover-root] .xsj-rw-clock,[data-time-hover-root] .xsj-rw-action{opacity:0;transition:opacity 80ms}[data-time-hover-root]:hover .xsj-rw-clock,[data-time-hover-root]:hover .xsj-rw-action,[data-time-hover-root]:focus-within .xsj-rw-clock,[data-time-hover-root]:focus-within .xsj-rw-action{opacity:1}}',
      '@media(hover:hover){[data-time-hover-root] .xsj-rw-trigger{opacity:.55}[data-time-hover-root]:hover .xsj-rw-trigger{opacity:1}}',
      '.xsj-rw-cancel{width:28px;height:28px;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;background:transparent;border:none;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;padding:6px}',
      '.xsj-rw-cancel:hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(220,60,60,.14));color:var(--dsw-alias-state-error-primary,#d44444)}',
      '.xsj-rw-banner{width:100%;max-width:min(var(--dsh-composer-card-max-width,780px),100%);box-sizing:border-box;display:flex;align-items:center;gap:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary,inherit);border-radius:10px;padding:6px 12px;font-size:13px;line-height:20px;margin:0 auto 6px}',
      '.xsj-rw-banner-icon{flex:none;font-size:14px}',
    ].join('\n')

    // -------------------------------------------------------------- apply --
    function apply(ctx) {
      // Resolve the slots service defensively: a bundle may be evaluated before
      // the slot service is published, and a hard access would throw out of
      // apply() and silently lose every registration below.
      var slots = ctx && (ctx.get ? ctx.get('slots') : ctx.slots)

      var baseTag = document.createElement('style')
      baseTag.setAttribute('data-xsj-rewind', 'base')
      // Claim the tag for this bundle. Style claiming runs when a client module
      // is materialized and adopts every `style:not([data-plugin])`, so an
      // untagged tag created here (apply() runs after materialization) would be
      // owned by whichever plugin materializes next — and that plugin's HMR
      // replacement would then delete this sheet and every rule below with it.
      baseTag.setAttribute('data-plugin', '@xsj/dsh-rewind')
      baseTag.textContent = BASE_CSS
      document.head.append(baseTag)

      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        console.warn('[xsj-rewind] slots service unavailable — renderer registration skipped')
        return
      }

      // Keyed slots throw on a duplicate same-key/same-priority registration
      // (e.g. a client HMR rebuild racing its own teardown). Guard every
      // registration so one failure cannot take down the others.
      var mounted = []
      function tryRegister(label, options, component) {
        try {
          var dispose = slots.register(options, component)
          mounted.push(label)
          return dispose
        } catch (e) {
          console.warn('[xsj-rewind] register failed for', label, (e && e.message) || e)
          return function () { /* nothing to dispose */ }
        }
      }

      // priority -1 beats the shipped renderer's default 0 (lowest renders), so
      // this plugin owns the row while mounted; unloading restores the shipped
      // one because its own registration was never removed.
      ctx.effect(() => {
        var disposers = [
          slots.inject('conversation.chat.node', () => [
            tryRegister('chat.node:user',
              { name: 'conversation.chat.node', key: 'user', priority: -1 },
              (props) => React.createElement(UserNodeView, props)),
            tryRegister('chat.node:steering',
              { name: 'conversation.chat.node', key: 'steering', priority: -1 },
              (props) => React.createElement(UserNodeView, props)),
          ]),
          slots.inject('conversation.input.right', () => {
            return tryRegister('input.right:cancel',
              { name: 'conversation.input.right', id: 'xsj-rewind-cancel', order: 90, label: L.cancel },
              (props) => React.createElement(CancelButton, props))
          }),
          slots.inject('conversation.input.dock', () => {
            return tryRegister('input.dock:banner',
              { name: 'conversation.input.dock', id: 'xsj-rewind-banner', order: 90, label: 'rewind' },
              (props) => React.createElement(Banner, props))
          }),
        ]
        if (mounted.length > 0) {
          console.info('[xsj-rewind] client mounted:', mounted.join(', '))
        }
        return () => {
          disposers.forEach((d) => {
            try { d() } catch (e) { /* stale disposer */ }
          })
        }
      })
      ctx.effect(() => () => baseTag.remove())
    }

    exports.name = 'xsj-rewind'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
