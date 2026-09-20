# @xsj/dsh-rewind

English | [简体中文](./README.md)

A conversation-rewind plugin for DSH (DeepSeek Harness). A permanent bundle
plugin with a host half and a web client half — zero dependencies, zero build
steps.

## Features

- Every user message row gains a **↺ rewind** action beside the copy icon.
  Clicking it:
  - **interrupts the current turn** if the model is still thinking/streaming;
  - hides that message and everything after it from the chat view (as if the
    tail never happened);
  - pre-fills the composer with the message text — **unsent and editable**;
  - **re-attaches any images** that rode the message back into the composer
    (the host reads the original bytes from the session log and feeds them back
    through the official attachment intake, so image count/size limits apply);
  - on the next send, the model only sees the truncated history (everything
    before the rewind point) plus your new message.
- While a rewind is pending:
  - a banner above the composer explains the state;
  - a **✕ "cancel rewind" button sits left of the send button** — clicking it
    restores the hidden messages, keeps your draft, and sends nothing.
- Once sent (rewind committed), the hidden tail never reappears in the chat
  view and never enters the model context again.
- Only user messages can be rewound; assistant messages have no rewind entry
  (the host validates the event type).

## Version compatibility

- **v2.3.0 is verified against dsh 0.1.5-rc.2** while keeping earlier 0.1.x
  hosts working — event-log access prefers the official `snapshotEvents()` /
  `eventAt()` and falls back to `session.events` on older hosts.
- Changes in v2.3.0:
  - Rewind now **re-attaches images**: the host half exposes
    `/api/xsj-rewind/image` to read a message's durable image bytes by
    attachmentId, and the client rebuilds `File` objects and feeds them back
    through the composer's hidden file input, inheriting the shipped image
    count/size validation.
  - **Fixed a cascading render crash on image messages**: the client half of
    `@deepseek-ai/dsh-client-ui-attachment` exports only `apply`/`inject` in
    0.1.5-rc.2 (no `ImageGallery` component), so referencing it threw inside
    any image-bearing user row and the React error boundary widened the damage
    to the surrounding rows — the rewind button vanished across a whole span of
    messages. Images now render through the shipped `renderMessageImages` prop
    (routed to the `conversation.message.images` slot).
  - **Hardened slot registration**: the `slots` service is resolved
    defensively and each seat registers under its own `try/catch`. A single
    registration conflict (e.g. a client HMR rebuild race) previously aborted
    `apply()`, leaving the stylesheet injected with every renderer lost.
  - **Safer DOM hide driver**: an unstamped row no longer inherits a
    neighbour's hidden verdict, so a freshly sent message cannot be hidden
    while its view is still stamping.
  - **Serialized image re-attachment** so concurrent rewinds cannot race on the
    same file input.
  - The host half resolves `attachments` at call time (`ctx.get`), so a missing
    attachment provider no longer blocks the mount; the image endpoint alone
    degrades to a 501.
  - Resource bounds: the per-session state table and the image-reference cache
    are capped, and image responses plus attachmentId length are validated.
- Changes in v2.2.0:
  - Adapted to 0.1.5-rc.2: `primitives.MessageText` was removed; the user
    bubble now renders text through the same `projectUserText()` helper the
    shipped bubble uses (reference/session chips included);
  - Client inject declaration updated: dropped the retired
    `@deepseek-ai/dsh-client-runtime`;
  - Dead code and debug scaffolding removed (debug log file, fuzzy session
    resolution, two unused code paths).
- Known symptoms of ≤2.1.2 on dsh 0.1.5-rc.2: user message rows crash while
  rendering, no rewind button — upgrade to ≥2.3.0.

## Security notes

- The four endpoints (`mark` / `cancel` / `state` / `image`) register on the dsh
  web server and therefore **follow dsh's own local-trust model**: `dsh web`
  listens on `127.0.0.1` by default, so they are reachable from this machine
  only and do not pass through dsh's API authentication layer. If you bind dsh
  web to a routable address (e.g. `0.0.0.0`), these endpoints become reachable
  too — restrict them at the network layer (firewall or an authenticating
  reverse proxy) in that case.
- The `/image` endpoint is scoped by the session log: it returns bytes only for
  attachments **that session actually references** (matched by attachmentId
  against the event stream). There is no path-based or arbitrary-id read. The
  bytes come from dsh's `attachments.readImage`, which verifies integrity.
- Limits: 64 KB request bodies, 256-character attachment ids, 64 MB per image
  response.
- The plugin collects and reports nothing; all state stays in the local session
  log.

## Log & recovery

- The session log (an append-only event stream) **never loses a message**.
- Every state change appends a `hook/invoked` event with payload
  `{ source: 'xsj.rewind', phase: 'mark' | 'cancel' | 'commit', targetSeq, hiddenFrom?, hiddenTo?, preview? }`.
  The type is a known-but-unused reserved entry in this build, so the records
  are reload-safe.
- After a process restart, opening a session replays these records to rebuild
  the hidden ranges — model-side and UI-side hiding stay consistent across
  restarts.
- The trajectory view does not render this reserved event type; audit the raw
  session JSONL log directly.

## Install

```powershell
# from anywhere; the path points at your clone of this repo:
dsh plugin --profile web add <absolute path to this repo>

# restart the DSH process, then refresh the browser page
```

The command registers the package into the profile
(`~/.dsh/profiles/<name>/package.json`: `dependencies` + `dsh.profile.bundles`).
At boot the profile merges this package's `cordis.patch.yml`, inserting the
host plugin row; the web client scan then serves `lib/client.js` automatically.

## Uninstall

```powershell
dsh plugin --profile web remove @xsj/dsh-rewind
# restart DSH. Rewind records in session logs are harmless (hook/invoked is a
# known event type).
```

## How it works

- **Model-side truncation**: patches the live `Session` object's
  `deriveMessages()` to skip hidden surface ranges (memoized by a signature of
  surface size / range count / replace generation). The request builder, the
  `llm/stream` reconstruction invariant, and the image check all share this
  one method, so every reader stays consistent. No message event is ever
  added, removed, or rewritten.
- **Interrupt**: on mark, a running agent is cancelled with
  `agent.cancel({ kind: 'user' }, { keepInbox: true })`; queued messages
  survive and continue from the rewind point.
- **Commit point**: inside the `agent/pre-step` waterfall, the first step that
  claims a real input message seals the hidden range
  `[targetSeq, current log end]`; the new message is appended afterwards and
  stays visible.
- **UI hiding**: purely DOM-driven — chat rows carry `data-chat-flow-key`; the
  client stamps each row with its seq and a MutationObserver applies inline
  `display:none` to hidden rows. Nothing depends on the host store's internal
  shape; cancelling or switching sessions restores everything without touching
  any shipped renderer.
- **Rewind icon**: takes over the `user`/`steering` cells of
  `conversation.chat.node` at priority `-1` (the slot system's native
  shadowing), replicating the native bubble (projectUserText / ImageGallery /
  Tooltip / writeClipboard) plus the ↺ button.

## Porting

The plugin has no npm dependencies: the host half uses only Node builtins and
injected services; the client half pulls `react`,
`@deepseek-ai/dsh-client-ui-primitives`, and
`@deepseek-ai/dsh-client-ui-attachment` from the shell's frozen module table
via `window.__ModuleLoader__`. Clone this repo on any machine and follow
"Install".

## License

[MIT](./LICENSE)
