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
    var UiAttachment = require('@deepseek-ai/dsh-client-ui-attachment')

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
      var hideFlags = new Array(rows.length).fill(false)
      for (var j = 0; j < rows.length; j++) {
        var seq = rwSeq(rows[j])
        var hide = (targetIdx >= 0 && j >= targetIdx) || (seq !== null && inRanges(seq, ranges))
        hideFlags[j] = hide
      }
      // 未打戳的行(如助手续行)跟随上一个已打戳行的判定
      var lastKnownHide = false
      for (var m = 0; m < rows.length; m++) {
        if (rwSeq(rows[m]) !== null || (targetIdx >= 0 && m >= targetIdx)) lastKnownHide = hideFlags[m]
        rwSetHidden(rows[m], lastKnownHide)
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
    var imageLabels = {
      image: L.image,
      open: L.open,
      openNamed: L.openNamed,
      loading: L.loading,
      loadFailed: L.loadFailed,
      lightbox: { dialog: L.dialog, close: L.close },
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
          } else {
            console.error('[xsj-rewind] mark rejected:', res && res.error)
          }
        }).catch((e) => {
          console.error('[xsj-rewind] mark failed:', e)
        }).then(() => { setBusy(false) })
      }

      var stackChildren = []
      if (parts.images.length > 0) {
        stackChildren.push(React.createElement(UiAttachment.ImageGallery, {
          key: 'images', images: parts.images, load: props.loadImage, align: 'end', labels: imageLabels,
        }))
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
      var slots = ctx.slots

      var baseTag = document.createElement('style')
      baseTag.setAttribute('data-xsj-rewind', 'base')
      baseTag.textContent = BASE_CSS
      document.head.append(baseTag)

      ctx.effect(() => {
        var disposers = [
          slots.inject('conversation.chat.node', () => [
            slots.register({ name: 'conversation.chat.node', key: 'user', priority: -1 }, (props) => {
              return React.createElement(UserNodeView, props)
            }),
            slots.register({ name: 'conversation.chat.node', key: 'steering', priority: -1 }, (props) => {
              return React.createElement(UserNodeView, props)
            }),
          ]),
          slots.inject('conversation.input.right', () => {
            return slots.register({ name: 'conversation.input.right', id: 'xsj-rewind-cancel', order: 90, label: L.cancel }, (props) => {
              return React.createElement(CancelButton, props)
            })
          }),
          slots.inject('conversation.input.dock', () => {
            return slots.register({ name: 'conversation.input.dock', id: 'xsj-rewind-banner', order: 90, label: 'rewind' }, (props) => {
              return React.createElement(Banner, props)
            })
          }),
        ]
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
