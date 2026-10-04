import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { ExperimentalPluginWebSocket } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CHANNELS, CHUNK_SAMPLES, SAMPLE_RATE, encodeBase64 } from "./audio";
import {
  CALL_REALTIME_PROMPT,
  boundedCallInitialItems,
  callIdentityInitialItem,
} from "./call-context";
import { hostContract, voiceSignals } from "./host";
import { takeNarrationChunk } from "./narration";

const MIGRATIONS = [
  // One call per thread, enforced by the primary key rather than by timing.
  `CREATE TABLE IF NOT EXISTS voice_calls (
     thread_id            TEXT PRIMARY KEY,
     call_id              TEXT NOT NULL,
     controller_thread_id TEXT NOT NULL,
     project_id           TEXT NOT NULL,
     target_thread_id     TEXT,
     state                TEXT NOT NULL
       CHECK (state IN ('provisioning','active','closed','lost')),
     created_at           TEXT NOT NULL,
     updated_at           TEXT NOT NULL
   )`,
  // Retained for storage compatibility with the pre-0.2 implementation.
  `CREATE TABLE IF NOT EXISTS voice_controllers (
     project_id           TEXT PRIMARY KEY,
     controller_thread_id TEXT NOT NULL,
     created_at           TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS voice_deliveries (
     delivery_id TEXT PRIMARY KEY,
     call_id     TEXT NOT NULL,
     text        TEXT NOT NULL,
     created_at  TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS voice_transcript_items (
     sequence    INTEGER PRIMARY KEY AUTOINCREMENT,
     call_id     TEXT NOT NULL,
     thread_id   TEXT NOT NULL,
     item_id     TEXT NOT NULL,
     role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
     text        TEXT NOT NULL,
     created_at  TEXT NOT NULL,
     UNIQUE (call_id, item_id, role)
   )`,
  `CREATE INDEX IF NOT EXISTS voice_transcript_thread_sequence
     ON voice_transcript_items (thread_id, sequence)`,
  // The thread owns the durable call, while one browser instance owns its
  // microphone/WebRTC transport. Without this lease every open BB client races
  // to negotiate the same call when the global call-changed signal arrives.
  `ALTER TABLE voice_calls ADD COLUMN transport_client_id TEXT`,
];

/** The four verbs of PLAN-18's confirmed v1 boundary, plus a live status read. */
const VERBS = ["create", "status", "steer", "interrupt"] as const;

export const rpcContract = defineRpcContract({
  call_start: {
    input: z.object({
      threadId: z.string().min(1),
      clientInstanceId: z.string().min(1).max(256).optional(),
    }),
    output: z.object({
      callId: z.string(),
      state: z.string(),
      controllerThreadId: z.string(),
      ownerThreadId: z.string(),
      ownerThreadTitle: z.string(),
      voiceAvailable: z.boolean(),
      voiceDetail: z.string().nullable(),
    }),
  },
  call_state: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({
      callId: z.string().nullable(),
      state: z.string().nullable(),
      controllerThreadId: z.string().nullable(),
      transport: z.string().nullable(),
      voiceAvailable: z.boolean(),
      voiceDetail: z.string().nullable(),
    }),
  },
  /** Whether the target thread has a turn running, so the orb is not guessing. */
  call_activity: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ agentBusy: z.boolean() }),
  },
  call_end: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ ended: z.boolean() }),
  },
  /**
   * The live call, independent of route context.
   *
   * The orb is an app overlay, and an overlay cannot be relied on to know which
   * thread the route is showing — so it asks the server for the call that is
   * actually up instead of looking one up by a thread id it may not have.
   */
  active_call: {
    input: z.union([
      z.null(),
      z.object({ clientInstanceId: z.string().min(1).max(256) }),
    ]),
    output: z.object({
      callId: z.string().nullable(),
      threadId: z.string().nullable(),
      threadTitle: z.string().nullable(),
      state: z.string().nullable(),
      transportOwner: z.boolean(),
    }),
  },
  /**
   * Media telemetry for one call: bytes of microphone audio sent and of model
   * audio received. Logged once per call, because "is audio actually flowing" is
   * otherwise unanswerable from the server side.
   */
  call_media: {
    input: z.object({
      callId: z.string().min(1),
      bytesOut: z.number().nonnegative(),
      bytesIn: z.number().nonnegative(),
      audioContext: z.string(),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  call_handoff: {
    input: z.object({
      callId: z.string().min(1),
      handoffId: z.string().min(1).max(256),
      utteranceId: z.string().min(1).max(256).nullable().optional(),
      text: z.string().min(1).max(120_000),
    }),
    output: z.object({ ok: z.boolean(), duplicate: z.boolean() }),
  },
  call_transcript: {
    input: z.object({
      callId: z.string().min(1),
      itemId: z.string().min(1).max(256),
      role: z.enum(["user", "assistant"]),
      text: z.string().min(1).max(120_000),
    }),
    output: z.object({
      accepted: z.boolean(),
      duplicate: z.boolean(),
      conflict: z.boolean(),
    }),
  },
  call_move: {
    input: z.object({ callId: z.string().min(1), toThreadId: z.string().min(1) }),
    output: z.object({
      ok: z.boolean(),
      threadId: z.string().nullable(),
      threadTitle: z.string().nullable(),
      detail: z.string().nullable(),
    }),
  },
  /** What a spoken turn may ask for, per PLAN-18. */
  call_offer: {
    input: z.object({
      threadId: z.string().min(1),
      sdp: z.string().min(1),
      clientInstanceId: z.string().min(1).max(256).optional(),
    }),
    output: z.object({
      ok: z.boolean(),
      sdp: z.string().nullable(),
      detail: z.string().nullable(),
    }),
  },
  call_say: {
    input: z.object({ threadId: z.string().min(1), text: z.string().min(1).max(2_000) }),
    output: z.object({ ok: z.boolean() }),
  },
  call_action: {
    input: z.object({
      threadId: z.string().min(1),
      verb: z.enum(VERBS),
      targetThreadId: z.string().min(1).nullable().optional(),
      prompt: z.string().min(1).max(8_000).nullable().optional(),
    }),
    output: z.object({
      ok: z.boolean(),
      detail: z.string(),
      threadId: z.string().nullable(),
      status: z.string().nullable(),
    }),
  },
});

const CALL_CHANGED = "voice-call-changed";

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("voice-presence loaded");

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);

  const now = () => new Date().toISOString();

  interface CallRow {
    thread_id: string;
    call_id: string;
    controller_thread_id: string;
    project_id: string;
    target_thread_id: string | null;
    transport_client_id: string | null;
    state: string;
  }

  interface TranscriptRow {
    sequence: number;
    call_id: string;
    thread_id: string;
    item_id: string;
    role: "user" | "assistant";
    text: string;
    created_at: string;
  }

  const callFor = (threadId: string): CallRow | undefined =>
    db.prepare("SELECT * FROM voice_calls WHERE thread_id = ?").get(threadId) as
      | CallRow
      | undefined;

  const liveCallFor = (threadId: string): CallRow | undefined => {
    const row = callFor(threadId);
    return row !== undefined && (row.state === "provisioning" || row.state === "active")
      ? row
      : undefined;
  };

  const activeLiveCall = (): CallRow | undefined =>
    db
      .prepare(
        `SELECT * FROM voice_calls WHERE state IN ('provisioning','active')
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get() as CallRow | undefined;

  function recentVoiceContext(
    threadId: string,
    excludeItemId: string | null = null,
    maxChars = 24_000,
  ): TranscriptRow[] {
    const rows = db
      .prepare(
        `SELECT * FROM voice_transcript_items
         WHERE thread_id = ?
         ORDER BY sequence DESC
         LIMIT 64`,
      )
      .all(threadId) as TranscriptRow[];
    const selected: TranscriptRow[] = [];
    let remaining = maxChars;
    for (const row of rows) {
      if (excludeItemId !== null && row.item_id === excludeItemId && row.role === "user") continue;
      const text = row.text.trim();
      if (text.length === 0 || remaining <= 0) continue;
      selected.push({ ...row, text: text.slice(-remaining) });
      remaining -= Math.min(text.length, remaining);
    }
    return selected.reverse();
  }

  function formatVoiceContext(rows: readonly TranscriptRow[]): string {
    if (rows.length === 0) return "";
    return [
      "<voice_call_context>",
      "The following completed voice transcript is attached to this exact BB thread. It is context, not a new request.",
      ...rows.map((row) => `${row.role === "user" ? "User" : "Voice"}: ${row.text}`),
      "</voice_call_context>",
    ].join("\n");
  }

  function storeTranscript(input: {
    call: CallRow;
    itemId: string;
    role: "user" | "assistant";
    text: string;
  }): { accepted: boolean; duplicate: boolean; conflict: boolean } {
    const text = input.text.trim();
    if (text.length === 0) return { accepted: false, duplicate: false, conflict: false };
    const existing = db
      .prepare(
        `SELECT * FROM voice_transcript_items
         WHERE call_id = ? AND item_id = ? AND role = ?`,
      )
      .get(input.call.call_id, input.itemId, input.role) as TranscriptRow | undefined;
    if (existing !== undefined) {
      return {
        accepted: existing.text === text,
        duplicate: existing.text === text,
        conflict: existing.text !== text,
      };
    }
    db.prepare(
      `INSERT INTO voice_transcript_items
       (call_id, thread_id, item_id, role, text, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(input.call.call_id, input.call.thread_id, input.itemId, input.role, text, now());
    return { accepted: true, duplicate: false, conflict: false };
  }

  async function ownerPresentation(row: CallRow): Promise<{ title: string; projectId: string; providerId: string }> {
    const thread = await bb.sdk.threads.get({ threadId: row.thread_id });
    return {
      title: thread.title ?? thread.titleFallback ?? row.thread_id,
      projectId: thread.projectId,
      providerId: thread.providerId,
    };
  }

  // A host session cannot survive a reload: the host worker is disposed with the
  // plugin. So any call still marked live in the durable row is a phantom, and
  // leaving it "active" means the bubble looks like a call that nobody is
  // holding. Reconcile at load — the original's drop-and-redial discipline
  // applied to startup. The controller thread is left alone; it is durable.
  const reconciled = db
    .prepare(
      `UPDATE voice_calls SET state = 'lost', updated_at = ?
       WHERE state IN ('provisioning','active')`,
    )
    .run(now());
  if (reconciled.changes > 0) {
    bb.log.warn(
      `marked ${reconciled.changes} voice call(s) lost on load: the host session did not survive the reload`,
    );
  }

  // -- Host readiness -------------------------------------------------------

  const hostClient = bb.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: voiceSignals,
  });

  /** Which host is holding the audio for a call, so frames can be routed. */
  const hostForCall = new Map<string, string>();

  /** The channel the UI subscribes to for transcript and call events. */
  const VOICE_EVENT = "voice-call-event";

  /** Answers waiting for the app-server's SDP, keyed by call. */
  const sdpWaiters = new Map<string, {
    resolve: (sdp: string | null) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const pendingOffers = new Map<string, object>();
  const movingCalls = new Set<string>();

  function settleOffer(callId: string, sdp: string | null): void {
    const waiter = sdpWaiters.get(callId);
    if (waiter === undefined) return;
    clearTimeout(waiter.timer);
    sdpWaiters.delete(callId);
    waiter.resolve(sdp);
  }

  function cancelOffer(callId: string): void {
    pendingOffers.delete(callId);
    settleOffer(callId, null);
  }

  /** Live audio clients, and which call each one is speaking into. */
  const sockets = new Set<ExperimentalPluginWebSocket>();
  const socketBinding = new Map<
    ExperimentalPluginWebSocket,
    { callId: string; hostId: string }
  >();

  function broadcast(payload: unknown): void {
    const text = JSON.stringify(payload);
    for (const socket of sockets) {
      try {
        socket.send(text);
      } catch {
        sockets.delete(socket);
        socketBinding.delete(socket);
      }
    }
  }

  async function primaryHostId(): Promise<string> {
    const [hosts, config] = await Promise.all([bb.sdk.hosts.list(), bb.sdk.system.config()]);
    const host = hosts.find((host) => host.id === config.primaryHostId && host.status === "connected") ??
      hosts.find((host) => host.status === "connected");
    if (host === undefined) {
      throw new Error("No connected host is available for audio.");
    }
    return host.id;
  }

  /** Return a readiness failure as a reason the call UI can display. */
  async function voiceReadiness(): Promise<{ available: boolean; detail: string | null }> {
    try {
      const hostId = await primaryHostId();
      const result = await hostClient.call("realtime_ready", null, {
        hostId,
        timeoutMs: 10_000,
      });
      // `PluginRpcResult<Method>` is the OUTPUT VALUE, not an {ok,error} union:
      // the client throws on failure and the catch below reports it. Reaching for
      // `result.ok`/`result.error` here is what produced the nonsense reason
      // "Cannot read properties of undefined (reading 'code')" on the first run.
      return { available: result.ready, detail: result.detail };
    } catch (cause) {
      return {
        available: false,
        detail: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  async function busyFor(threadId: string | null): Promise<boolean> {
    if (threadId === null) return false;
    try {
      const running = await bb.sdk.threads.listRunning();
      return running.some((thread) => thread.id === threadId);
    } catch {
      return false;
    }
  }

  bb.agents.contributeInstructions(({ threadId }) => {
    const context = formatVoiceContext(recentVoiceContext(threadId, null, 3_200));
    if (context === "") return null;
    return [
      "This thread has a persistent Voice Presence call transcript. Treat it as ordinary conversation context from this thread. A spoken exchange is not automatically a request to start work; only act on the current user request.",
      context,
    ].join("\n\n");
  });

  bb.rpc.register(rpcContract, {
    call_start: async ({ threadId, clientInstanceId = "legacy-client" }) => {
      const readiness = await voiceReadiness();
      const existing = activeLiveCall();
      if (existing !== undefined) {
        const owner = await ownerPresentation(existing);
        const hostId = hostForCall.get(existing.call_id);
        if (hostId === undefined) {
          return {
            callId: existing.call_id,
            state: existing.state,
            controllerThreadId: existing.thread_id,
            ownerThreadId: existing.thread_id,
            ownerThreadTitle: owner.title,
            voiceAvailable: false,
            voiceDetail:
              existing.thread_id === threadId
                ? "The call is waiting for media negotiation."
                : `A call is already attached to ${owner.title}.`,
          };
        }
        try {
          const session = await hostClient.call(
            "realtime_state",
            { callId: existing.call_id },
            { hostId, timeoutMs: 10_000 },
          );
          const live = session.state === "live";
          return {
            callId: existing.call_id,
            state: existing.state,
            controllerThreadId: existing.thread_id,
            ownerThreadId: existing.thread_id,
            ownerThreadTitle: owner.title,
            voiceAvailable: live,
            voiceDetail:
              existing.thread_id !== threadId
                ? `A call is already attached to ${owner.title}.`
                : live
                  ? null
                  : `Realtime session is ${session.state}.`,
          };
        } catch (cause) {
          return {
            callId: existing.call_id,
            state: existing.state,
            controllerThreadId: existing.thread_id,
            ownerThreadId: existing.thread_id,
            ownerThreadTitle: owner.title,
            voiceAvailable: false,
            voiceDetail: cause instanceof Error ? cause.message : String(cause),
          };
        }
      }
      const owner = await bb.sdk.threads.get({ threadId });
      const ownerTitle = owner.title ?? owner.titleFallback ?? threadId;
      // `voiceReadiness` and the owner lookup are asynchronous. Recheck after
      // both so two simultaneous presses on different threads cannot create two
      // live rows before the single host transport arbitrates them.
      const raceWinner = activeLiveCall();
      if (raceWinner !== undefined) {
        const winner = await ownerPresentation(raceWinner);
        return {
          callId: raceWinner.call_id,
          state: raceWinner.state,
          controllerThreadId: raceWinner.thread_id,
          ownerThreadId: raceWinner.thread_id,
          ownerThreadTitle: winner.title,
          voiceAvailable: false,
          voiceDetail: `A call is already attached to ${winner.title}.`,
        };
      }
      const callId = `${threadId}:${Date.now()}`;
      const stamp = now();
      db.prepare(
        `INSERT INTO voice_calls (thread_id, call_id, controller_thread_id, project_id,
                                  target_thread_id, transport_client_id, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'provisioning', ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           call_id = excluded.call_id,
           controller_thread_id = excluded.controller_thread_id,
           project_id = excluded.project_id,
           target_thread_id = excluded.target_thread_id,
           transport_client_id = excluded.transport_client_id,
           state = 'provisioning',
           updated_at = excluded.updated_at`,
      ).run(threadId, callId, threadId, owner.projectId, threadId, clientInstanceId, stamp, stamp);
      bb.realtime.publish(CALL_CHANGED, { threadId });
      return {
        callId,
        state: "provisioning",
        controllerThreadId: threadId,
        ownerThreadId: threadId,
        ownerThreadTitle: ownerTitle,
        voiceAvailable: readiness.available,
        voiceDetail: readiness.detail,
      };
    },

    /**
     * Negotiate the call with the client's WebRTC offer.
     *
     * The answer arrives asynchronously as a `thread/realtime/sdp` notification,
     * so the waiter is registered BEFORE the start call — otherwise a fast answer
     * is dropped on the floor and the call hangs until the timeout.
     */
    active_call: async (input) => {
      const row = activeLiveCall();
      let title: string | null = null;
      if (row !== undefined) {
        try {
          title = (await ownerPresentation(row)).title;
        } catch {
          title = row.thread_id;
        }
      }
      return {
        callId: row?.call_id ?? null,
        threadId: row?.thread_id ?? null,
        threadTitle: title,
        state: row?.state ?? null,
        transportOwner:
          row !== undefined &&
          row.transport_client_id === (input?.clientInstanceId ?? "legacy-client"),
      };
    },

    call_media: ({ callId, bytesOut, bytesIn, audioContext }) => {
      bb.log.info(
        `voice media ${callId}: audioContext=${audioContext} micBytesOut=${bytesOut} modelBytesIn=${bytesIn}`,
      );
      return { ok: true };
    },
    call_transcript: ({ callId, itemId, role, text }) => {
      const call = activeLiveCall();
      if (call === undefined || call.call_id !== callId) {
        return { accepted: false, duplicate: false, conflict: false };
      }
      const result = storeTranscript({ call, itemId, role, text });
      if (result.conflict) {
        bb.log.warn(`voice transcript conflict call=${callId} item=${itemId} role=${role}`);
      }
      return result;
    },
    call_handoff: async ({ callId, handoffId, utteranceId, text }) => {
      const call = activeLiveCall();
      if (call === undefined || call.call_id !== callId) {
        return { ok: false, duplicate: false };
      }
      const transcript = utteranceId === null || utteranceId === undefined
        ? undefined
        : db
            .prepare(
              `SELECT * FROM voice_transcript_items
               WHERE call_id = ? AND item_id = ? AND role = 'user'`,
            )
            .get(callId, utteranceId) as TranscriptRow | undefined;
      const durableText = transcript?.text.trim() || text.trim();
      const stableUtteranceId = utteranceId ?? transcript?.item_id ?? handoffId;
      const deliveryId = `utterance:${callId}:${stableUtteranceId}`;
      const inserted = db
        .prepare(
          `INSERT OR IGNORE INTO voice_deliveries (delivery_id, call_id, text, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(deliveryId, callId, durableText, now());
      if (inserted.changes === 0) return { ok: true, duplicate: true };
      try {
        const context = formatVoiceContext(recentVoiceContext(call.thread_id, stableUtteranceId));
        const providerText = context === "" ? durableText : `${durableText}\n\n${context}`;
        await bb.sdk.threads.send({
          threadId: call.thread_id,
          mode: "auto",
          input: [{ type: "text", text: providerText, mentions: [] }],
        });
        return { ok: true, duplicate: false };
      } catch (cause) {
        db.prepare("DELETE FROM voice_deliveries WHERE delivery_id = ?").run(deliveryId);
        bb.log.warn(
          `voice handoff rejected: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        return { ok: false, duplicate: false };
      }
    },
    call_move: async ({ callId, toThreadId }) => {
      const call = activeLiveCall();
      if (call === undefined || call.call_id !== callId) {
        return { ok: false, threadId: null, threadTitle: null, detail: "The call is no longer active." };
      }
      if (call.thread_id === toThreadId) {
        const owner = await ownerPresentation(call);
        return { ok: true, threadId: toThreadId, threadTitle: owner.title, detail: null };
      }
      if (movingCalls.has(callId) || pendingOffers.has(callId)) {
        return { ok: false, threadId: null, threadTitle: null, detail: "The call is already connecting or moving." };
      }
      movingCalls.add(callId);
      try {
        const [target, outline] = await Promise.all([
          bb.sdk.threads.get({ threadId: toThreadId }),
          bb.sdk.threads.conversationOutline({ threadId: toThreadId }),
        ]);
        const title = target.title ?? target.titleFallback ?? toThreadId;
        const hostId = hostForCall.get(callId);
        if (hostId !== undefined) {
          const updated = await hostClient.call(
            "realtime_append_text",
            {
              callId,
              role: "developer",
              text: [
                callIdentityInitialItem({
                  threadId: toThreadId,
                  threadTitle: title,
                  projectId: target.projectId,
                  providerId: target.providerId,
                }).text,
                "Authoritative context for the new owner thread:",
                ...boundedCallInitialItems(
                  outline.items.map((item) => ({ role: item.role, text: item.preview })),
                ).map((item) => `${item.role === "user" ? "User" : "Assistant"}: ${item.text}`),
                formatVoiceContext(recentVoiceContext(toThreadId)),
              ].filter((part) => part !== "").join("\n\n"),
            },
            { hostId, timeoutMs: 15_000 },
          );
          if (!updated.ok) throw new Error("The voice session did not accept the new thread context.");
        }
        const current = activeLiveCall();
        if (current?.call_id !== callId || current.thread_id !== call.thread_id) {
          throw new Error("The call ended or changed while moving.");
        }
        db.transaction(() => {
          db.prepare(
            `DELETE FROM voice_calls
             WHERE thread_id = ? AND call_id != ? AND state IN ('closed','lost')`,
          ).run(toThreadId, callId);
          db.prepare(
            `UPDATE voice_calls
             SET thread_id = ?, controller_thread_id = ?, project_id = ?, target_thread_id = ?, updated_at = ?
             WHERE call_id = ?`,
          ).run(toThreadId, toThreadId, target.projectId, toThreadId, now(), callId);
          db.prepare("UPDATE voice_transcript_items SET thread_id = ? WHERE call_id = ?").run(toThreadId, callId);
        })();
        if (hostId !== undefined) {
          stopNarration(callId);
          startNarration(callId, toThreadId, hostId, outline.maxSeq);
        }
        bb.realtime.publish(CALL_CHANGED, { threadId: call.thread_id });
        bb.realtime.publish(CALL_CHANGED, { threadId: toThreadId });
        return { ok: true, threadId: toThreadId, threadTitle: title, detail: null };
      } catch (cause) {
        return {
          ok: false,
          threadId: null,
          threadTitle: null,
          detail: cause instanceof Error ? cause.message : String(cause),
        };
      } finally {
        movingCalls.delete(callId);
      }
    },
    call_offer: async ({ threadId, sdp, clientInstanceId = "legacy-client" }) => {
      const call = liveCallFor(threadId);
      if (call === undefined) {
        return { ok: false, sdp: null, detail: "No live call on this thread." };
      }
      if (call.transport_client_id !== clientInstanceId) {
        return {
          ok: false,
          sdp: null,
          detail: "This call's media transport belongs to another browser.",
        };
      }
      if (pendingOffers.has(call.call_id) || movingCalls.has(call.call_id)) {
        return { ok: false, sdp: null, detail: "The call is already connecting or moving." };
      }
      if (call.state === "active" && hostForCall.has(call.call_id)) {
        return { ok: false, sdp: null, detail: "This call already has a realtime transport." };
      }
      const offer = {};
      pendingOffers.set(call.call_id, offer);
      const isCurrent = () => pendingOffers.get(call.call_id) === offer &&
        liveCallFor(threadId)?.call_id === call.call_id;
      try {
        let hostId: string;
        try {
          hostId = await primaryHostId();
        } catch (cause) {
          return {
            ok: false,
            sdp: null,
            detail: cause instanceof Error ? cause.message : String(cause),
          };
        }
        let context: {
          title: string;
          projectId: string;
          providerId: string;
          maxSeq: number;
          messages: Array<{ role: "user" | "assistant"; text: string }>;
        };
        try {
          const [owner, outline] = await Promise.all([
            bb.sdk.threads.get({ threadId }),
            bb.sdk.threads.conversationOutline({ threadId }),
          ]);
          context = {
            title: owner.title ?? owner.titleFallback ?? threadId,
            projectId: owner.projectId,
            providerId: owner.providerId,
            maxSeq: outline.maxSeq,
            messages: outline.items.map((item) => ({ role: item.role, text: item.preview })),
          };
        } catch (cause) {
          return {
            ok: false,
            sdp: null,
            detail: `Could not read the owner thread: ${cause instanceof Error ? cause.message : String(cause)}`,
          };
        }
        if (!isCurrent()) return { ok: false, sdp: null, detail: "The call ended during negotiation." };
        hostForCall.set(call.call_id, hostId);

        const answer = new Promise<string | null>((resolve) => {
          const timer = setTimeout(() => {
            settleOffer(call.call_id, null);
          }, 30_000);
          sdpWaiters.set(call.call_id, { resolve, timer });
        });

        let started: { ok: boolean; detail: string | null };
        try {
          started = await hostClient.call(
            "realtime_start",
            {
              callId: call.call_id,
              threadId,
              outputModality: "audio",
              version: "v3",
              voice: null,
              offerSdp: sdp,
              prompt: CALL_REALTIME_PROMPT,
              initialItems: [
                {
                  ...callIdentityInitialItem({
                    threadId,
                    threadTitle: context.title,
                    projectId: context.projectId,
                    providerId: context.providerId,
                  }),
                  text: [
                    callIdentityInitialItem({
                      threadId,
                      threadTitle: context.title,
                      projectId: context.projectId,
                      providerId: context.providerId,
                    }).text,
                    formatVoiceContext(recentVoiceContext(threadId)),
                  ].filter((part) => part !== "").join("\n\n").slice(0, 24_000),
                },
                ...boundedCallInitialItems(context.messages),
              ],
            },
            { hostId, timeoutMs: 45_000 },
          );
        } catch (cause) {
          try {
            await hostClient.call("realtime_stop", { callId: call.call_id }, { hostId, timeoutMs: 15_000 });
          } catch {
            // The host may have disconnected before returning the start result.
          }
          if (isCurrent()) {
            hostForCall.delete(call.call_id);
            db.prepare("UPDATE voice_calls SET state = 'lost', updated_at = ? WHERE call_id = ?").run(now(), call.call_id);
            bb.realtime.publish(CALL_CHANGED, { threadId });
          }
          return {
            ok: false,
            sdp: null,
            detail: cause instanceof Error ? cause.message : String(cause),
          };
        }
        if (!isCurrent()) {
          try {
            await hostClient.call("realtime_stop", { callId: call.call_id }, { hostId, timeoutMs: 15_000 });
          } catch {
            // A cancelled negotiation may have already closed its host session.
          }
          return { ok: false, sdp: null, detail: "The call ended during negotiation." };
        }
        if (!started.ok) {
          hostForCall.delete(call.call_id);
          db.prepare("UPDATE voice_calls SET state = 'lost', updated_at = ? WHERE call_id = ?")
            .run(now(), call.call_id);
          bb.realtime.publish(CALL_CHANGED, { threadId });
          return { ok: false, sdp: null, detail: started.detail };
        }

        const answered = await answer;
        if (!isCurrent()) return { ok: false, sdp: null, detail: "The call ended during negotiation." };
        if (answered !== null) {
          db.prepare("UPDATE voice_calls SET state = 'active', updated_at = ? WHERE call_id = ?")
            .run(now(), call.call_id);
          startNarration(call.call_id, call.thread_id, hostId, context.maxSeq);
          bb.realtime.publish(CALL_CHANGED, { threadId });
        } else {
          try {
            await hostClient.call(
              "realtime_stop",
              { callId: call.call_id },
              { hostId, timeoutMs: 15_000 },
            );
          } catch {
            // The failed negotiation is already being discarded locally.
          }
          hostForCall.delete(call.call_id);
          if (isCurrent()) {
            db.prepare("UPDATE voice_calls SET state = 'lost', updated_at = ? WHERE call_id = ?")
              .run(now(), call.call_id);
            bb.realtime.publish(CALL_CHANGED, { threadId });
          }
        }
        return answered === null
          ? { ok: false, sdp: null, detail: "The app-server returned no SDP answer in time." }
          : { ok: true, sdp: answered, detail: null };
      } finally {
        if (pendingOffers.get(call.call_id) === offer) {
          pendingOffers.delete(call.call_id);
          settleOffer(call.call_id, null);
        }
      }
    },

    call_state: async ({ threadId }) => {
      const readiness = await voiceReadiness();
      const call = liveCallFor(threadId);
      return {
        callId: call?.call_id ?? null,
        state: call?.state ?? null,
        controllerThreadId: call?.thread_id ?? null,
        transport: null,
        voiceAvailable: readiness.available,
        voiceDetail: readiness.detail,
      };
    },

    call_activity: async ({ threadId }) => {
      const call = liveCallFor(threadId);
      return { agentBusy: await busyFor(call?.target_thread_id ?? threadId) };
    },

    call_end: async ({ threadId }) => {
      const call = liveCallFor(threadId);
      if (call === undefined) return { ended: false };
      cancelOffer(call.call_id);
      db.prepare("UPDATE voice_calls SET state = 'closed', updated_at = ? WHERE call_id = ?").run(now(), call.call_id);
      const hostId = hostForCall.get(call.call_id);
      if (hostId !== undefined) {
        try {
          await hostClient.call("realtime_stop", { callId: call.call_id }, { hostId, timeoutMs: 15_000 });
        } catch {
          // Nothing useful to do; the row still closes.
        }
        hostForCall.delete(call.call_id);
      }
      stopNarration(call.call_id);
      broadcast({ type: "callEnded", callId: call.call_id });
      bb.realtime.publish(CALL_CHANGED, { threadId });
      return { ended: true };
    },

    /**
     * The four verbs. Each maps onto a BB primitive rather than a bespoke path,
     * because that is the capability shuv2code had to build and BB already has.
     */
    /** The narrator speaking — the proactive-speech half of the original. */
    call_say: async ({ threadId, text }) => {
      const call = liveCallFor(threadId);
      if (call === undefined) return { ok: false };
      const hostId = hostForCall.get(call.call_id);
      if (hostId === undefined) return { ok: false };
      try {
        const said = await hostClient.call(
          "realtime_say",
          { callId: call.call_id, text },
          { hostId, timeoutMs: 15_000 },
        );
        return { ok: said.ok };
      } catch {
        return { ok: false };
      }
    },

    call_action: async ({ threadId, verb, targetThreadId, prompt }) => {
      const call = liveCallFor(threadId);
      if (call === undefined) {
        return { ok: false, detail: "No live voice call on this thread.", threadId: null, status: null };
      }
      const target = targetThreadId ?? call.target_thread_id ?? threadId;
      try {
        switch (verb) {
          case "create": {
            if (prompt === null || prompt === undefined) {
              return { ok: false, detail: "create needs a prompt.", threadId: null, status: null };
            }
            // Resolve the current project from the owner thread.
            // the call is actually on, at the moment the user asks.
            const owner = await bb.sdk.threads.get({ threadId: call.thread_id });
            const projectId = (owner as { projectId?: string }).projectId;
            if (typeof projectId !== "string" || projectId === "") {
              return { ok: false, detail: "This thread has no project to create in.", threadId: null, status: null };
            }
            const created = await bb.sdk.threads.spawn({
              projectId,
              environment: { type: "project-default" },
              prompt,
            });
            // The new thread becomes the call's target, which is what makes
            // "actually, focus on X" work on the thing just created.
            db.prepare(
              "UPDATE voice_calls SET target_thread_id = ?, updated_at = ? WHERE thread_id = ?",
            ).run(created.id, now(), threadId);
            bb.realtime.publish(CALL_CHANGED, { threadId });
            return {
              ok: true,
              detail: `Created thread ${created.id}.`,
              threadId: created.id,
              status: null,
            };
          }
          case "status": {
            const thread = await bb.sdk.threads.get({ threadId: target });
            const status = (thread as { status?: string }).status ?? "unknown";
            return {
              ok: true,
              detail: (thread as { title?: string }).title ?? "",
              threadId: target,
              status,
            };
          }
          case "steer": {
            if (prompt === null || prompt === undefined) {
              return { ok: false, detail: "steer needs text.", threadId: null, status: null };
            }
            // `steer` in, `steer` out: this is the same-turn correction path from
            // PLAN-18 ("actually, focus on the failing tests"), and BB resolves it.
            await bb.sdk.threads.send({
              threadId: target,
              mode: "steer",
              input: [{ type: "text", text: prompt, mentions: [] }],
            });
            return { ok: true, detail: `Steered ${target}.`, threadId: target, status: null };
          }
          case "interrupt": {
            await bb.sdk.threads.stop({ threadId: target });
            return { ok: true, detail: `Interrupted ${target}.`, threadId: target, status: null };
          }
        }
      } catch (cause) {
        return {
          ok: false,
          detail: cause instanceof Error ? cause.message : String(cause),
          threadId: null,
          status: null,
        };
      }
    },
  });

  // -- Live audio ------------------------------------------------------------
  //
  // One socket per client carrying PCM both ways. Mic frames come in as binary
  // and go straight to the host's app-server; speech comes back as host signals
  // and is fanned out to every listening socket. This is the `websocket` half of
  // the transport split — the half a remote browser or a phone uses, since it
  // needs no WebRTC negotiation.
  bb.http.experimental_websocket(
    "/audio",
    () => ({
      onOpen(socket) {
        sockets.add(socket);
        socket.send(
          JSON.stringify({
            type: "hello",
            sampleRate: SAMPLE_RATE,
            channels: CHANNELS,
            chunkSamples: CHUNK_SAMPLES,
          }),
        );
      },
      onMessage(socket, data) {
        if (typeof data === "string") {
          let message: { type?: string; callId?: string };
          try {
            message = JSON.parse(data) as { type?: string; callId?: string };
          } catch {
            return;
          }
          if (message.type === "start") {
            const callId = message.callId ?? "";
            const hostId = hostForCall.get(callId);
            if (hostId === undefined) {
              socket.send(
                JSON.stringify({ type: "error", message: "No host is holding this call." }),
              );
              return;
            }
            socketBinding.set(socket, { callId, hostId });
            socket.send(JSON.stringify({ type: "ready" }));
          }
          return;
        }
        const binding = socketBinding.get(socket);
        if (binding === undefined || data.byteLength === 0) return;
        const samplesPerChannel = Math.floor(data.byteLength / 2);
        if (samplesPerChannel === 0) return;
        // Not awaited: audio must not queue behind its own round trip. A dropped
        // frame is better than a growing buffer.
        void hostClient
          .call(
            "realtime_append_audio",
            {
              callId: binding.callId,
              data: encodeBase64(data),
              numChannels: CHANNELS,
              sampleRate: SAMPLE_RATE,
              samplesPerChannel,
            },
            { hostId: binding.hostId, timeoutMs: 15_000 },
          )
          .catch(() => undefined);
      },
      onClose(socket) {
        sockets.delete(socket);
        socketBinding.delete(socket);
      },
      onError(socket) {
        sockets.delete(socket);
        socketBinding.delete(socket);
      },
    }),
    { auth: "local" },
  );

  interface NarrationState {
    readonly callId: string;
    readonly threadId: string;
    readonly hostId: string;
    afterSeq: number;
    buffer: string;
    itemId: string | null;
    tail: Promise<void>;
  }

  const narration = new Map<string, NarrationState>();

  async function flushNarration(state: NarrationState, force: boolean): Promise<void> {
    while (state.buffer !== "") {
      const next = takeNarrationChunk(state.buffer, force);
      state.buffer = next.rest;
      if (next.chunk === null) return;
      await hostClient.call(
        "realtime_say",
        { callId: state.callId, text: next.chunk },
        { hostId: state.hostId, timeoutMs: 20_000 },
      );
      if (!force) return;
    }
  }

  async function drainNarration(state: NarrationState): Promise<void> {
    try {
      let rows;
      do {
        rows = await bb.sdk.threads.events.list({
          threadId: state.threadId,
          afterSeq: String(state.afterSeq),
          order: "asc",
          limit: "100",
          types: ["item/agentMessage/delta", "item/completed", "turn/completed"],
        });
        for (const row of rows) {
          state.afterSeq = Math.max(state.afterSeq, row.seq);
          if (row.type === "item/agentMessage/delta") {
            if (state.itemId !== null && state.itemId !== row.data.itemId) {
              await flushNarration(state, true);
              state.buffer = "";
            }
            state.itemId = row.data.itemId;
            state.buffer += row.data.delta;
            await flushNarration(state, false);
            continue;
          }
          if (row.type === "item/completed" && row.data.item.type === "agentMessage") {
            if (state.itemId !== row.data.item.id) {
              state.buffer = row.data.item.text;
            }
            state.itemId = row.data.item.id;
            await flushNarration(state, true);
            state.buffer = "";
            state.itemId = null;
            continue;
          }
          if (row.type === "turn/completed") {
            await flushNarration(state, true);
            state.buffer = "";
            state.itemId = null;
          }
        }
      } while (rows.length === 100);
    } catch (cause) {
      bb.log.warn(
        `voice narration failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  function startNarration(callId: string, threadId: string, hostId: string, afterSeq: number): void {
    if (narration.has(callId)) return;
    const state: NarrationState = {
      callId,
      threadId,
      hostId,
      afterSeq,
      buffer: "",
      itemId: null,
      tail: Promise.resolve(),
    };
    narration.set(callId, state);
    state.tail = state.tail.then(() => drainNarration(state));
  }

  function stopNarration(callId: string): void {
    narration.delete(callId);
  }

  bb.events.on("experimental_thread.events", ({ thread, sequence }) => {
    for (const state of narration.values()) {
      if (state.threadId !== thread.id || sequence <= state.afterSeq) continue;
      state.tail = state.tail.then(() => drainNarration(state));
    }
  });

  // Host signals are the other half of the call: whatever the app-server says is
  // republished on a plugin realtime channel so the UI can subscribe directly.
  //
  // This is also the transcript path. It went dead when the client moved to
  // WebRTC, because the events were only being broadcast over the audio socket
  // that the WebRTC path no longer opens.
  const disposeSignals = [
    hostClient.experimental_onSignal("realtime_output_audio", ({ payload }) => {
      broadcast({ type: "outputAudio", ...payload });
    }),
    hostClient.experimental_onSignal("realtime_sdp", ({ payload }) => {
      settleOffer(payload.callId, payload.sdp);
      broadcast({ type: "sdp", ...payload });
    }),
    hostClient.experimental_onSignal("realtime_transcript", ({ payload }) => {
      bb.log.info(`transcript role=${payload.role} final=${String(payload.final)} chars=${payload.text.length}`);
      if (
        payload.final &&
        payload.itemId !== null &&
        (payload.role === "user" || payload.role === "assistant")
      ) {
        const call = activeLiveCall();
        if (call !== undefined && call.call_id === payload.callId) {
          storeTranscript({
            call,
            itemId: payload.itemId,
            role: payload.role,
            text: payload.text,
          });
        }
      }
      broadcast({ type: "transcript", ...payload });
      bb.realtime.publish(VOICE_EVENT, { kind: "transcript", ...payload });
    }),
    hostClient.experimental_onSignal("realtime_error", ({ payload }) => {
      broadcast({ type: "error", ...payload });
      bb.realtime.publish(VOICE_EVENT, { kind: "error", ...payload });
    }),
    hostClient.experimental_onSignal("realtime_closed", ({ payload }) => {
      broadcast({ type: "closed", ...payload });
      bb.realtime.publish(VOICE_EVENT, { kind: "closed", ...payload });
      const call = db
        .prepare("SELECT * FROM voice_calls WHERE call_id = ?")
        .get(payload.callId) as CallRow | undefined;
      if (call !== undefined) {
        cancelOffer(payload.callId);
        stopNarration(payload.callId);
        hostForCall.delete(payload.callId);
        db.prepare("UPDATE voice_calls SET state = 'lost', updated_at = ? WHERE call_id = ? AND state IN ('provisioning','active')")
          .run(now(), payload.callId);
        bb.realtime.publish(CALL_CHANGED, { threadId: call.thread_id });
      }
    }),
  ];

  bb.onDispose(() => {
    for (const callId of pendingOffers.keys()) cancelOffer(callId);
    narration.clear();
    for (const dispose of disposeSignals) dispose();
    for (const socket of sockets) {
      try {
        socket.close();
      } catch {
        // Already gone.
      }
    }
    sockets.clear();
    socketBinding.clear();
    bb.log.info("voice-presence disposed");
  });
}

export { MIGRATIONS, VERBS };
