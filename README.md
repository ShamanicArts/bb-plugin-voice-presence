# BB Voice Presence

Requires BB 0.43+, a connected machine with the Codex CLI, and an existing Codex
login. WebRTC needs microphone permission and a secure browser context.

```sh
bb plugin install https://github.com/ShamanicArts/bb-plugin-voice-presence
```

Voice Presence adds a low-latency voice call to a BB thread. The realtime voice
transport and the durable BB agent have deliberately different jobs:

- The realtime model owns quick spoken conversation.
- The BB thread remains the sole owner of durable work, tools, approvals, and
  repository changes.
- Final captions with provider-issued item identities are persisted against
  that exact thread. Host caption parts without identities remain live captions.
  Delegated work receives the bounded stored call context.
- An explicit client-managed handoff sends its complete request into that exact
  thread immediately. Retries are deduplicated by the delegation identity.
  Caption completion and persistence do not gate task delivery.
- The thread's provider output is narrated back into the active call.
- The microphone can be muted without leaving, and the call can be moved to the
  thread currently in view without renegotiating media.
- A quiet rising chime marks connection; a falling chime marks the end of an
  established call. Muting the microphone keeps these output sounds available.

The call retains an explicit owner thread id and title. If the user navigates to
another thread, the compact call strip names its owner and offers direct Open
and Move here actions. Starting a second call cannot silently replace the first
call's media session. The invisible media owner remains mounted across route
changes, so navigation cannot hang up the call.

## Privacy and context

When a call negotiates, the plugin sends the Codex realtime transport:

- the owner thread id, title, project id, and durable provider id;
- up to 24 recent user/assistant message previews;
- at most 24,000 characters of message context.

This bounded snapshot lets realtime answer questions about the active thread
without creating durable work. The separate voice transport thread is hidden and
scoped to the plugin data directory; it is transport, not a second BB work thread.

## Development

When this checkout is installed directly in a running BB, `dist` backs the live
frontend asset URLs. Building here can expose candidate bytes to new clients
without a plugin reload. Build a source snapshot with `bb plugin build <path>`
in thread storage for isolated acceptance, and keep its artifacts separate until
the change is ready. Reloading this voice plugin disconnects its active call.

```sh
npm install
npm run typecheck
npm test
npm run build
bb plugin reload voice-presence
```

The plugin uses BB server, app, and host entries. `server.ts` owns call identity,
handoffs, and narration; `host.ts` supervises Codex realtime; `app.tsx` owns the
WebRTC media path and call UI.

The tests cover protocol framing, audio conversion, frontend registration,
handoffs, narration, call transfers, and cancellation during negotiation. They
do not place a live call or validate microphone playback on a physical device.

Licensed under MIT. The copied presence orb retains its upstream notice in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
