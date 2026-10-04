Talk with the agent attached to the BB thread you are already working in.

## Thread-owned calls

Every call has one explicit owner thread. The call tray shows that thread's title
even after you navigate elsewhere, and can take you straight back to it. A second
thread cannot silently steal the active media session.

## Fast voice, durable work

The realtime model handles quick conversation from a bounded snapshot of the
owner thread. Completed voice exchanges are persisted against that owner. When
a request genuinely needs tools, code changes, approvals, or a durable artifact,
an explicit client-managed handoff sends the complete finalized utterance and
bounded active-call context to the owner BB thread exactly once. The thread's
streamed response is then narrated into the same live call.

## Familiar presence

The presence orb reflects listening, muted, thinking, and speaking state in a
compact strip styled like BB's pinned controls. The strip remains visible across
navigation, identifies where the call belongs, and can move it to the current
thread without replacing the media session.
