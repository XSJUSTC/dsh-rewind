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

    function reattachImages(sid, images) {
      var list = Array.isArray(images) ? images : []
      if (list.length === 0) return Promise.resolve(0)
      var jobs = list.map((img) => {
        var ref = img && img.attachment ? img.attachment : null
        if (ref === null || ref.attachmentId === undefined) return null
        var q = '/image?sessionId=' + encodeURIComponent(sid) + '&attachmentId=' + encodeURIComponent(String(ref.attachmentId))
        return get(q).then((res) => {
          if (!res || res.ok !== true || typeof res.data !== 'string') throw new Error('image read failed')
          var mediaType = res.mediaType || ref.mediaType || 'image/png'
          var name = res.name || ref.name || 'image.png'
          var bytes = b64ToBytes(res.data)
          var file = new File([bytes], name, { type: mediaType })
          return file
        })
      }).filter((job) => job !== null)
      return Promise.all(jobs).then((files) => {
        var real = files.filter((f) => f instanceof File)
        if (real.length === 0) return 0
        var input = document.querySelector('input[type="file"]')
        if (input === null) return 0
        try {
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

    // ----------------------------------------------- per-session UI state --
    // { pending: null | { targetSeq, markSeq }, ranges: {start,end}[], version }
    var states = new Map()
    var listeners = new Set()
    function readState(sid) { return states.get(sid) }
    function writeState(sid, mut) {
      var prev = states.get(sid)
      states.set(sid, {
        pending: mut && Object.prototype.hasOwnProperty.call(mut, 'pending') ? mut.pending : prev ? prev.pending : null,
        ranges: mut && Object.prototype.hasOwnProperty.call(mut, 'ranges') ? mut.ranges : prev ? prev.ranges : [],
        version: (prev ? prev.version : 0) + 1,
      })
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
    var rwResyncing = false
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
    function rwApply(sid) {
      var rows = rwRows()
      var st = readState(sid)
      var pending = st && st.pending ? st.pending : null
      var ranges = (st && st.ranges) || []
      var targetIdx = -1
      if (pending) {
        for (var i = 0; i < rows.length; i++) { if (rwSeq(rows[i]) === pending.targetSeq) { targetIdx = i; break } }
      }
      // An unstamped row is one we have no evidence about (the node view stamps
      // rows in a layout effect, so a freshly sent row is briefly unknown).
      // Hiding on a guess costs a missing rewind button on new messages, so an
      // unknown row falls back to its predecessor's verdict only while that
      // verdict came from a real stamped row; otherwise it stays visible.
      var lastKnownHide = false
      for (var m = 0; m < rows.length; m++) {
        var seq = rwSeq(rows[m])
        var hide
        if (seq !== null) {
          hide = inRanges(seq, ranges) || (targetIdx >= 0 && m >= targetIdx)
          lastKnownHide = hide
        } else if (targetIdx >= 0 && m >= targetIdx) {
          // Below the pending target: everything from here on is part of the
          // abandoned tail, stamped or not.
          hide = true
          lastKnownHide = true
        } else {
          hide = false
        }
        rwSetHidden(rows[m], hide)
      }
      // commit 检测: pending 之后出现了戳 seq > markSeq 的新行 → 从服务端重新同步
      if (pending && !rwResyncing) {
        var boundary = pending.markSeq || pending.targetSeq
        for (var q = Math.max(targetIdx + 1, 0); q < rows.length; q++) {
          var s2 = rwSeq(rows[q])
          if (s2 !== null && s2 > boundary) {
            rwResyncing = true
            get('/state?sessionId=' + encodeURIComponent(sid)).then((res) => {
              rwResyncing = false
              if (res) applyHostState(sid, res)
            }).catch(() => { rwResyncing = false })
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
      })
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
      open: '查看原图',
      openNamed: (n) => '查看 ' + n + ' 原图',
      loading: '加载中…',
      loadFailed: '加载失败，点击重试',
      dialog: '图片预览',
      close: '关闭',
      extra: '附加数据块',
      truncated: (total) => '已截断（共 ' + total + ' 项）',
    } : {
      rewind: 'Rewind to this message',
      cancel: 'Cancel rewind',
      copy: 'Copy',
      copied: 'Copied',
      banner: 'Rewound to an earlier message (its text is in the composer, editable). Sending continues from there and hides the tail from the model; click the ✕ left of Send to cancel.',
      image: 'image',
      open: 'Open original',
      openNamed: (n) => 'Open ' + n,
      loading: 'Loading…',
      loadFailed: 'Load failed — retry',
      dialog: 'Image preview',
      close: 'Close',
      extra: 'Extra content block',
      truncated: (total) => 'Truncated (' + total + ' total)',
    }

    // ------------------------------------------------------------ helpers --
    function contentParts(content) {
      var texts = [], images = [], rest = []
      if (Array.isArray(content)) {
        for (var i = 0; i < content.length; i++) {
          var b = content[i]
          if (b && b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
          else if (b && b.type === 'image' && b.attachment !== undefined) images.push({ attachment: b.attachment })
          else rest.push(b)
        }
      }
      return { text: texts.join(''), images: images, rest: rest }
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
      if (parts.images.length > 0) {
        // 0.1.5-rc.2 no longer exports an ImageGallery component from the
        // attachment module (its client half only exposes apply/inject); the
        // shipped bubble renders images through the renderMessageImages prop,
        // which routes to the conversation.message.images slot. Mirror that.
        // A missing prop must not throw: it would take the whole row — and
        // every sibling row — down with it.
        var renderImages = props.renderMessageImages
        if (typeof renderImages === 'function') {
          stackChildren.push(React.createElement('div', { key: 'images', className: 'xsj-rw-images' },
            renderImages({ images: parts.images, align: 'end', compact: parts.images.length > 1 })))
        } else {
          stackChildren.push(React.createElement('div', { key: 'images', className: 'xsj-rw-images-missing' }, L.image))
        }
      }
      if (parts.text !== '' || parts.rest.length > 0) {
        var bubbleChildren = []
        if (parts.text !== '') {
          // 0.1.5-rc.2 removed primitives.MessageText; the shipped user bubble
          // now renders text through projectUserText (span runs + ref chips),
          // so mirror that here and let CSS handle wrapping.
          bubbleChildren.push(React.createElement('div', { key: 'text', className: 'xsj-rw-text' },
            UiPrimitives.projectUserText(parts.text, [])))
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
        copied ? React.createElement(UiPrimitives.IconCheckOutline16, {}) : React.createElement(UiPrimitives.IconCopyOutline16, {}),
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
        get('/state?sessionId=' + encodeURIComponent(sid)).then((res) => {
          if (live && res) applyHostState(sid, res)
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
        return function () { clearTimeout(t); obs.disconnect(); window.removeEventListener('xsj-rw-stamp', schedule) }
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
      '.xsj-rw-images{display:flex;justify-content:flex-end;max-width:100%}',
      '.xsj-rw-images-missing{color:var(--dsw-alias-label-tertiary,#98a2b3);font-size:13px}',
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
