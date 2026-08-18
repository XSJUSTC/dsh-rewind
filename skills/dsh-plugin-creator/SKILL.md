---
name: dsh-plugin-creator
description: >
  Create permanent bundle plugins for DSH (DeepSeek Harness). Covers the complete
  host+client dual-face architecture, package.json/cordis.patch.yml/profile registration,
  Session API (deriveMessages, surface, append), Slot system (keyed/list/chain, priority
  shadowing, owner props), client bundle format (__ModuleLoader__), UI primitives
  (Tooltip, MessageText, ImageGallery, writeClipboard), common pitfalls (ignorable flag,
  anchorSeq semantics, markSeq boundary, deriveMessages cache), security/perf hardening,
  and GitHub publishing workflow. Use when building, debugging, or publishing a new DSH plugin,
  or when modifying an existing one.
---

# Creating Permanent Bundle Plugins for DSH

A permanent bundle plugin is a self-contained package that extends DSH with host-side
logic (Node.js, full ctx access) and/or client-side UI (browser, React, Slots). It is
installed into a profile, survives process restarts, and is discovered automatically at boot.

**This skill covers permanent plugins only.** For temporary process-local extensions,
see `cordis-plugin-development` (dynamic `cordis_define` plugins).

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│ DSH Process                                              │
│                                                          │
│  Profile boot                                            │
│  ┌─────────────────────────────────────────────────┐     │
│  │ 1. dsh.profile.bundles (ordered)                │     │
│  │ 2. profile cordis.patch.yml                     │     │
│  │ 3. home cordis.patch.yml (~/.dsh/cordis.patch)  │     │
│  │ 4. --patch overlays                             │     │
│  └─────────────────────────────────────────────────┘     │
│         │                                                │
│         ▼                                                │
│  Loader resolves bundle → lib/index.js (ESM)            │
│  ↪ exports: { name, inject, apply(ctx) }                │
│  ↪ inject: ['webServer', 'sessions', 'agents', ...]     │
│         │                                                │
│         ▼                                                │
│  clientModules scan: dsh.client.platform === 'web'       │
│  ↪ serves /plugins/<id>/client.js                       │
│  ↪ injects boot graph into index.html                    │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Browser                                                  │
│                                                          │
│  __DSH_BOOT__ → ClientModuleSystem                       │
│  ┌─────────────────────────────────────────────────┐     │
│  │ Plugins loaded as classic scripts:               │     │
│  │ window.__ModuleLoader__.load({                   │     │
│  │   id: '@scope/plugin',                           │     │
│  │   factory: (require) => { ... }                  │     │
│  │ })                                               │     │
│  └─────────────────────────────────────────────────┘     │
│         │                                                │
│         ▼                                                │
│  Cordis client fiber                                     │
│  ↪ exports: { apply(ctx), inject? }                     │
│  ↪ ctx.get('slots') → slot registration                 │
│  ↪ ctx.get('timer') → timer helpers                     │
│  ↪ React, document, navigator all available             │
└─────────────────────────────────────────────────────────┘
```

**Key distinction vs dynamic plugins:** Permanent plugins run in the real runtime
(no sandbox guard, no `harness.handle`/`host.call` bridge). Host half uses real
`ctx` with full service access. Client half uses real `document`/`navigator`/`React`.

---

## 2. Package Structure

```
my-plugin/
├── package.json          ← dsh.bundle + dsh.client declarations
├── cordis.patch.yml      ← inserts the host row into the composition tree
├── lib/
│   ├── index.js          ← host half (ESM)
│   └── client.js         ← client half (classic script, __ModuleLoader__)
├── README.md
├── README_EN.md
└── LICENSE
```

### 2.1 package.json

```json
{
  "name": "@scope/my-plugin",
  "version": "1.0.0",
  "description": "...",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-ui-slots"
      ],
      "platform": "web"
    }
  },
  "engines": { "node": ">=20" },
  "keywords": ["dsh", "deepseek-harness", "dsh-plugin"],
  "license": "MIT"
}
```

**Critical fields:**
- `dsh.bundle.patch` → path to the bundle-layer YAML (inserted into the composition)
- `dsh.client.platform: "web"` → enables client-modules scan for this package
- `dsh.client.inject` → load-order edges: plugin bundles listed here are materialized first
- `exports["./client"]` → path of the client bundle (served at `/plugins/<id>/client.js`)

### 2.2 cordis.patch.yml

```yaml
# Bundle layer: inserts one host plugin row.
- insert:
    - id: my-feature
      name: '@scope/my-plugin'
```

The `id` is the composition-tree row id (must be unique). The `name` is the npm package
name — the loader resolves it from the profile's `node_modules` (or installation anchor).

---

## 3. Host Half (lib/index.js)

ESM Cordis plugin. Full Node.js access.

### 3.1 Export Shape

```js
export const name = 'my-plugin'
export const inject = ['webServer', 'sessions', 'agents']  // hard deps

export function apply(ctx) {
  const { webServer, sessions, agents } = ctx
  // ...
  ctx.effect(() => () => { /* cleanup on plugin unload */ })
}
```

### 3.2 Common Host Services

| Service | Inject name | Use for |
|---|---|---|
| `webServer` | `'webServer'` | HTTP routes (RPC to client) |
| `sessions` | `'sessions'` | `sessions.get(id)` → live Session |
| `agents` | `'agents'` | `agents.get(id)` → Agent (cancel, status) |
| `systemPrompt` | `'systemPrompt'` | Register prompt sections |
| `tools` | `'tools'` | Register model-callable tools |
| `commands` | `'commands'` | Register slash commands |
| `timer` | `'timer'` | `ctx.timeout()`, `ctx.interval()` |

### 3.3 HTTP Routes (Client↔Host RPC)

```js
ctx.effect(() => webServer.register({
  kind: 'exact',
  path: '/api/my-plugin/mark',
  handler: async (req, res) => {
    const body = await readJsonBody(req)
    // ...
    writeJson(res, 200, { ok: true })
  },
}))
```

**Security:** Add a body size cap (e.g. 64 KB) in `readJsonBody` to prevent memory exhaustion.

### 3.4 Host Events

| Event | Mode | Signature |
|---|---|---|
| `agent/pre-step` | waterfall | `(payload: {agent, messages, turn, step, signal}, next) => Promise<PreStepDecision>` |
| `agent/status` | emit | `(payload: {agent, status: 'idle'|'running'})` |
| `agent/created` | emit | `(payload: {agent})` |
| `agent/disposed` | emit | `(payload: {agent})` |
| `session/event` | emit | `(session, event: SessionEvent)` |
| `session/flush` | parallel | `(session) => Promise<void> \| void` |

**Waterfall events MUST call `next()` and return its result:**
```js
ctx.on('agent/pre-step', (payload, next) => {
  // inspect payload.messages, modify state, etc.
  return next()   // always return next()
})
```

### 3.5 Session API

```js
const session = sessions.get(sessionId)

session.id              // SessionId (branded string)
session.events          // readonly SessionEvent[] (indexed by seq)
session.seq             // next seq = log.length
session.firstLiveSeq    // first seq appended in this process
session.surface         // SessionSurface: { nodes: number[], replaceGeneration }
session.header          // SessionHeader

session.append(type, data, opts?)  // append event to log
session.deriveMessages()           // Message[] derived from surface
session.deriveEventMessage(event)  // Message | null
```

### 3.6 Session Events — The `hook/invoked` Trick

**`Session.append()` CANNOT set `ignorable: true`.** Unknown event types without this flag
make the session UNREADABLE on next load (`assertEventsSupported` throws).

**Solution:** Use `hook/invoked` — a known-but-unused event type in this build:

```js
session.append('hook/invoked', {
  source: 'my-plugin',
  phase: 'mark',
  targetSeq: seq,
  preview: '...',
})
```

- `hook/invoked` is in `KNOWN_SESSION_EVENT_TYPES` (no reader/writer in the build)
- Survives process restart (known type → not refused)
- Records show in the raw JSONL session log (audit trail)
- Does NOT show in the trajectory view or chat view (no matching definition)

### 3.7 Patching `deriveMessages`

If you need to alter the model-visible message history for a session (e.g., hide
rewound messages), patch the instance method:

```js
function ensurePatched(session, st) {
  if (st.patched) return
  const original = session.deriveMessages
  if (typeof original !== 'function') return
  const hidden = st.hiddenSet  // Set<number>
  let cacheSig = ''
  let cacheOut = []
  Object.defineProperty(session, 'deriveMessages', {
    configurable: true, writable: true,
    value: function () {
      if (hidden.size === 0) return original.call(this)
      const surface = this.surface
      const nodes = surface.nodes
      const sig = `${nodes.length}:${hidden.size}:${surface.replaceGeneration}`
      if (sig === cacheSig) return cacheOut.slice()
      const out = []
      for (const seq of nodes) {
        if (hidden.has(seq)) continue
        const msg = this.deriveEventMessage(this.events[seq])
        if (msg != null) out.push(msg)
      }
      cacheSig = sig
      cacheOut = out
      return out.slice()
    },
  })
  st.patched = true
}
```

**Why this works:** The agent loop, the request-reconstruction invariant, and the
image-check all call `deriveMessages()` on the session object. One patch keeps
every reader consistent.

**Cleanup:** On plugin dispose, `delete session.deriveMessages` to restore the original.

**Memoization:** Cache by `nodes.length + hidden.size + surface.replaceGeneration`.
Return `.slice()` per call (consumers expect a fresh array).

---

## 4. Client Half (lib/client.js)

**Must be a classic script.** NOT ESM. No `import`/`export`/JSX/TypeScript.

### 4.1 Bundle Wrapper

```js
window.__ModuleLoader__.load({
  id: '@scope/my-plugin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    // Externals from the shell's frozen module table
    var React = require('react')
    var UiPrimitives = require('@deepseek-ai/dsh-client-ui-primitives')
    var UiAttachment = require('@deepseek-ai/dsh-client-ui-attachment')

    // ... your code ...

    exports.name = 'my-plugin'
    exports.inject = ['slots']
    exports.apply = function (ctx) { /* ... */ }
    return module.exports
  },
})
```

### 4.2 Available Externals (module table)

| Specifier | Contents |
|---|---|
| `react` | React, createElement, useState, useEffect, useSyncExternalStore, ... |
| `react/jsx-runtime` | jsx, jsxs, Fragment |
| `react-dom` | ReactDOM |
| `@deepseek-ai/cordis` | Context class |
| `@deepseek-ai/dsh-client-ui-slots` | SlotCore, SlotMap types |
| `@deepseek-ai/dsh-client-ui-primitives` | Tooltip, MessageText, JsonBlock, Button, Input, Menu, writeClipboard, Icon*Outline16 |
| `@deepseek-ai/dsh-client-ui-attachment` | ImageGallery, MessageImage, ImageLoader |

### 4.3 Browser Globals

Permanent client plugins have full access to `document`, `navigator`, `window`, `localStorage`.

**Timers:** Declare `inject: ['timer']` and use `ctx.timeout()` / `ctx.interval()`.

### 4.4 Slot Registration

```js
function apply(ctx) {
  var slots = ctx.slots

  ctx.effect(function () {
    var d1 = slots.inject('conversation.chat.node', function () {
      return slots.register(
        { name: 'conversation.chat.node', key: 'user', priority: -1 },
        function (props) { return React.createElement(UserNodeView, props) }
      )
    })
    var d2 = slots.inject('conversation.input.right', function () {
      return slots.register(
        { name: 'conversation.input.right', id: 'my-button', order: 90 },
        function (props) { return React.createElement(CancelButton, props) }
      )
    })
    return function () { d1(); d2() }
  })
}
```

### 4.5 Slot Kinds

| Kind | Rendering | Registration options |
|---|---|---|
| `single` | One occupant | `priority` (lower renders) |
| `list` | All entries by `order` | `id` (unique cell), `order`, `label`, `priority` |
| `keyed` | Dispatched by `key` | `key`, `priority` (lower renders) |
| `chain` | Selector-routed | `select(owner) => matched \| null` |

**Priority:** Lower number = renders. Default = 0. Use negative to shadow shipped entries.

### 4.6 Key Conversation Slots

| Slot | Kind | Scope | Props |
|---|---|---|---|
| `conversation.chat.node` | keyed | session | `node` (ChatConversationViewNode), `loadImage`, standard props |
| `conversation.chat.assistant-actions` | list | session | `messageId` |
| `conversation.chat.turnTail` | chain | session | `turn`, `seq`, `openFile` |
| `conversation.input.right` | list | session | `session`, `input` (InputZone) |
| `conversation.input.dock` | list | session | `session`, `input` (InputZone) |
| `conversation.composer.bar` | single | session-maybe | `variant`, `blocked`, `disabled`, ... |

**Standard props (session-scoped slots):**
- `sessionId: string`
- `useSession(selector) => S` — snapshot selector hook
- `useSessions(selector) => S` — session list state
- `useInput(selector) => S` — input machine state
- `inputActions: { setDraft, addImages, removeImage, submit }`
- `useProjection` — projection hook

### 4.7 CSS Injection

```js
var tag = document.createElement('style')
tag.setAttribute('data-my-plugin', 'hide')
tag.textContent = '.my-class { display: none }'
document.head.append(tag)

// Cleanup
ctx.effect(function () { return function () { tag.remove() } })
```

### 4.8 UI Primitives

```js
// Tooltip (wraps a child element)
React.createElement(UiPrimitives.Tooltip, { label: 'Hover text', side: 'bottom' },
  React.createElement('button', { onClick: handler }, 'Click'))

// MessageText (plain text with whitespace preservation)
React.createElement(UiPrimitives.MessageText, { text: 'Hello world' })

// JsonBlock (collapsible JSON viewer)
React.createElement(UiPrimitives.JsonBlock, { label: 'Data', payload: obj })

// writeClipboard (async, returns success boolean)
UiPrimitives.writeClipboard(text).then(function (ok) { if (ok) setCopied(true) })

// Icons (React elements)
React.createElement(UiPrimitives.IconCopyOutline16, {})
React.createElement(UiPrimitives.IconCheckOutline16, {})

// ImageGallery
React.createElement(UiAttachment.ImageGallery, {
  images: [{ attachment: ref }], load: props.loadImage,
  align: 'end', labels: imageLabels
})
```

---

## 5. Critical Pitfalls

### 5.1 `Session.append` Cannot Set `ignorable`

Unknown event types brick sessions on reload. **Always use `hook/invoked`** for
custom audit records. See §3.6.

### 5.2 Surface Replace Is Irreversible

`surfaceOp: { op: 'replace', start, end }` permanently shadows surface nodes.
The original events remain in the log, but `deriveMessages()` skips them. There
is no "undo" — a subsequent replace cannot restore the originals.

**Safe approach for reversible hiding:** Patch `deriveMessages()` to filter in-memory,
leaving the log untouched. See §3.7.

### 5.3 `anchorSeq` Semantics Differ by Node Kind

| Kind | anchorSeq source |
|---|---|
| `user` | `user/message` event seq |
| `steering` | `user/message` event seq |
| `assistant-step` | `settled.seq` (assistant/message) if settled; else `firstVisibleSeq` or `step/start` seq |
| `turn-tail` | Closing assistant seq |
| `tool-call` | `tool/call` event seq |
| `compaction` | The compaction checkpoint seq |
| `command` | `command/run` event seq |

**Key insight:** `step/start` comes BEFORE `user/message` in the log. A running
assistant-step's `anchorSeq` (from `step/start`) is LESS than the user message
that initiated the turn. A settled assistant-step's `anchorSeq` (from
`assistant/message`) is GREATER.

### 5.4 markSeq Boundary for Pending Hide

When a rewind is pending (target seq = `targetSeq`), the hide range must distinguish
"existed at mark time" from "arrived after." The mark event's own seq (`markSeq`)
is the clean boundary:

- Pre-existing later user/steering messages have `anchorSeq < markSeq` → hidden.
- The committing message (sent after the mark) has `anchorSeq > markSeq` → visible.
- No flicker: the new message is never hidden even before the host-state refetch.

**Old bug:** Using `targetSeq` as the boundary caused pre-existing later messages
to cap the hide range, leaving them visible.

### 5.5 Client Bundle Must Be Classic Script

`__ModuleLoader__` evaluates bundles via `new Function(factory)` in CJS-like mode.
`import`/`export`/JSX cause SyntaxError. Use `var`, `function`, `require()`.

### 5.6 `deriveMessages` Must Return Fresh Arrays

Consumers may hold a reference across appends. The original returns `[...this.derived]`.
Your patch must also return `.slice()` or a new array each call.

### 5.7 Permanent vs Dynamic Plugins

| Aspect | Permanent (bundle) | Dynamic (cordis_define) |
|---|---|---|
| Runtime ctx | Real cordis ctx | Sandboxed proxy |
| `document`/`navigator` | Available | Available (Client) |
| `harness.handle` / `host.call` | NOT available | Package-private bridge |
| Host↔Client RPC | `webServer.register` + `fetch` | `harness.handle` + `host.call` |
| Persistence | Survives restart | Process-local |
| Slot priority | Explicit (e.g. -1) | Auto-assigned by guard |

---

## 6. Security & Performance

- **Body size cap:** 64 KB on HTTP RPC routes (`req.destroy()` on overflow).
- **No secrets in routes:** Routes are same-origin only (local tool); still validate inputs.
- **`deriveMessages` memo:** Cache by `nodes.length + filterCount + replaceGeneration`.
- **CSS selector performance:** Join hidden keys with `,\n` into one rule; avoid per-node rules.
- **`useSyncExternalStore`:** Store stable snapshot identity (replace object on state change, not mutate).

---

## 7. Installation & Publishing

### 7.1 Install Locally

```powershell
dsh plugin --profile web add <absolute-path-to-plugin>
# or with file: link
dsh plugin --profile web add file:C:/path/to/plugin
# or from GitHub
dsh plugin --profile web add github:User/Repo
```

### 7.2 Profile Registration

The CLI:
1. Runs `pnpm add` in the profile directory.
2. Reconciles `dsh.profile.bundles` — auto-appends packages that declare `dsh.bundle`.
3. Restart DSH → boot merges bundle layers → mounts host rows → client scan serves bundles.

### 7.3 Validate Before Restart

```powershell
dsh web --dump-config 2>&1 | Select-String 'my-plugin'
```

### 7.4 GitHub Publishing Checklist

- `package.json`: `repository`, `keywords`, `author`, `homepage`, `bugs`, `files`
- `README.md` (zh) + `README_EN.md` (en)
- `LICENSE` (MIT)
- `.gitignore` (node_modules, *.log)
- Git: `git init -b main && git add -A && git commit && git push`
- Create repo via `gh repo create` or GitHub API

### 7.5 Install Command for Users

```powershell
# From GitHub
dsh plugin --profile web add github:User/Repo

# From npm (if published)
dsh plugin --profile web add @scope/plugin

# From local path
dsh plugin --profile web add link:C:\path\to\plugin
```

After install: restart DSH and refresh the browser page.

---

## 8. Reference: dsh-rewind as Template

The `@xsj/dsh-rewind` plugin demonstrates every pattern covered here:

- **Host:** `webServer` routes, `agent/pre-step` waterfall, `deriveMessages` patching
  with memo cache, `hook/invoked` audit, `agent.cancel` with `keepInbox`, `ctx.effect`
  lifecycle management, 64 KB body cap.
- **Client:** `__ModuleLoader__` wrapper, `conversation.chat.node` keyed renderer
  (priority -1), `conversation.input.right` list entry, `conversation.input.dock` banner,
  `document.createElement('style')` CSS hiding, `useSyncExternalStore` store,
  `writeClipboard`, `ImageGallery`, `MessageText`, `Tooltip`, `inputActions.setDraft`.
- **Repo:** https://github.com/XSJUSTC/dsh-rewind

Source: `Z:\test\test-dsh-rewind\` or `~/.dsh/plugins\dsh-rewind\`
