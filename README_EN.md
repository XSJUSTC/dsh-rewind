# @xsj/dsh-rewind

English | [简体中文](./README.md)

A conversation-rewind plugin for DSH (DeepSeek Harness). A permanent bundle
plugin with a host half and a web client half — zero dependencies, zero build
steps.

## Features

![Rewind action preview](screenshot.png)

- Every user message row gains a **↺ rewind** action beside the copy icon.
  Clicking it:
  - **interrupts the current turn** if the model is still thinking/streaming;
  - hides that message and everything after it from the chat view (as if the
    tail never happened);
  - pre-fills the composer with the message text — **unsent and editable**;
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
- **UI hiding**: chat rows carry `data-chat-flow-key`; the plugin maintains one
  dynamic `display:none` rule set for the hidden keys. Cancelling or switching
  sessions restores everything without touching any shipped renderer.
- **Rewind icon**: takes over the `user`/`steering` cells of
  `conversation.chat.node` at priority `-1` (the slot system's native shadowing),
  replicating the native bubble (MessageText / ImageGallery / Tooltip /
  writeClipboard) plus the ↺ button.

## Porting

The plugin has no npm dependencies: the host half uses only Node builtins and
injected services; the client half pulls `react`,
`@deepseek-ai/dsh-client-ui-primitives`, and
`@deepseek-ai/dsh-client-ui-attachment` from the shell's frozen module table
via `window.__ModuleLoader__`. Clone this repo on any machine and follow
"Install".

## License

[MIT](./LICENSE)
