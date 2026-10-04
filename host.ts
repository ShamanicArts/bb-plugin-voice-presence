import { execFile, spawn } from "node:child_process";
import { defineRpcContract, experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  CodexAppServer,
  REALTIME_VOICES,
  codexAppServerArgs,
  realtimeApi,
  type LineTransport,
  type RealtimeApi,
} from "./codex-app-server";

/** Where the codex CLI lives unless the operator points at another build. */
const CODEX_BINARY = process.env.BB_VOICE_CODEX_BINARY ?? "codex";

const sessionState = z.enum(["idle", "starting", "live", "failed", "closed"]);

const signals = {
  /** The remote SDP for a WebRTC session. The client completes the peer here. */
  realtime_sdp: { payload: z.object({ callId: z.string(), sdp: z.string() }) },
  /** Base64 PCM the client should play. */
  realtime_output_audio: {
    payload: z.object({ callId: z.string(), data: z.string(), numChannels: z.number(), sampleRate: z.number() }),
  },
  realtime_transcript: {
    payload: z.object({
      callId: z.string(),
      itemId: z.string().nullable(),
      text: z.string(),
      final: z.boolean(),
      /** "user" or "assistant" — the app-server tells us whose words these are. */
      role: z.string(),
    }),
  },
  realtime_error: { payload: z.object({ callId: z.string(), message: z.string() }) },
  realtime_closed: { payload: z.object({ callId: z.string(), reason: z.string().nullable() }) },
} as const;

/** Exported so the server entry can subscribe to these with full typing. */
export const voiceSignals = signals;

/**
 * Actually check the binary responds, rather than reporting ready because the
 * code path exists. A UI that claims ready and then fails on press is worse than
 * one that says it cannot.
 */
function probeBinary(binary: string): Promise<{ ok: boolean; detail: string | null }> {
  return new Promise((resolve) => {
    execFile(binary, ["--version"], { timeout: 5_000 }, (error, stdout) => {
      if (error !== null) {
        resolve({ ok: false, detail: `${binary} --version failed: ${error.message}` });
        return;
      }
      resolve({ ok: true, detail: stdout.trim() });
    });
  });
}

export const hostContract = defineRpcContract({
  /** Whether this machine can hold a call, and why not if it cannot. */
  realtime_ready: {
    input: z.null(),
    output: z.object({
      ready: z.boolean(),
      binary: z.string(),
      detail: z.string().nullable(),
      voices: z.array(z.string()),
    }),
  },
  realtime_start: {
    input: z.object({
      callId: z.string().min(1),
      threadId: z.string().min(1),
      outputModality: z.enum(["text", "audio"]),
      version: z.enum(["v1", "v2", "v3"]).nullable(),
      voice: z.string().nullable(),
      /**
       * The client's WebRTC SDP offer. Present means the media is peer-to-peer
       * and needs no API key; absent means the app-server would open its own
       * socket, which does require one.
       */
      offerSdp: z.string().nullable(),
      prompt: z.string().min(1).max(16_000),
      initialItems: z
        .array(
          z.object({
            role: z.enum(["user", "assistant", "developer"]),
            text: z.string().min(1).max(24_000),
          }),
        )
        .max(25),
    }),
    output: z.object({ ok: z.boolean(), detail: z.string().nullable() }),
  },
  realtime_append_audio: {
    input: z.object({
      callId: z.string().min(1),
      data: z.string().min(1),
      numChannels: z.number().int().positive(),
      sampleRate: z.number().int().positive(),
      samplesPerChannel: z.number().int().positive().nullable(),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  realtime_append_text: {
    input: z.object({
      callId: z.string().min(1),
      text: z.string().min(1),
      role: z.enum(["user", "developer", "assistant"]),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  /**
   * The narrator speaking. `appendSpeech` is the app-server's "say this" call,
   * and it is what the original's narration policy drives for proactive speech.
   */
  realtime_say: {
    input: z.object({ callId: z.string().min(1), text: z.string().min(1).max(2_000) }),
    output: z.object({ ok: z.boolean() }),
  },
  realtime_stop: {
    input: z.object({ callId: z.string().min(1) }),
    output: z.object({ ok: z.boolean() }),
  },
  realtime_state: {
    input: z.object({ callId: z.string().min(1) }),
    output: z.object({ state: sessionState, threadId: z.string().nullable() }),
  },
});

/** Frame a child process's stdout into lines. */
function childTransport(child: ReturnType<typeof spawn>): LineTransport {
  const lineHandlers: ((line: string) => void)[] = [];
  const closeHandlers: ((reason: string) => void)[] = [];
  let buffer = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      for (const handler of lineHandlers) handler(line);
      index = buffer.indexOf("\n");
    }
  });
  const close = (reason: string) => {
    for (const handler of closeHandlers) handler(reason);
  };
  child.on("exit", (code, signal) => close(`exit ${code ?? signal ?? "unknown"}`));
  child.on("error", (cause) => close(cause.message));
  return {
    write: (line) => {
      child.stdin?.write(line);
    },
    onLine: (handler) => lineHandlers.push(handler),
    onClose: (handler) => closeHandlers.push(handler),
    close: () => {
      child.kill();
    },
  };
}

interface Session {
  callId: string;
  threadId: string;
  /** The app-server's own thread, which is what realtime actually attaches to. */
  codexThreadId: string | null;
  state: z.infer<typeof sessionState>;
  app: CodexAppServer;
  api: RealtimeApi;
  /**
   * Keeps the host worker alive for the life of the call. Without this the
   * daemon may stop an idle worker mid-conversation, because an open RPC is not
   * itself a reason to stay resident.
   */
  lease: { dispose(): Promise<void> };
}

let session: Session | null = null;

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: signals,
  handlers: {
    realtime_ready: async () => {
      const probe = await probeBinary(CODEX_BINARY);
      return {
        ready: probe.ok,
        binary: CODEX_BINARY,
        detail: probe.detail,
        voices: [...REALTIME_VOICES],
      };
    },

    realtime_start: async (
      { callId, threadId, outputModality, version, voice, offerSdp, prompt, initialItems },
      context,
    ) => {
      if (session !== null) {
        return {
          ok: false,
          detail:
            session.callId === callId
              ? "This call already has a realtime transport."
              : `Another call already owns the realtime transport (${session.threadId}).`,
        };
      }

      const child = spawn(CODEX_BINARY, codexAppServerArgs({ enableRealtimeConversation: true }), {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const app = new CodexAppServer(childTransport(child));
      const api = realtimeApi(app);
      // Fire-and-forget: a dropped signal must never take the session down, and
      // emitSignal is async while the notification handlers are not.
      const emit = (signal: keyof typeof signals, payload: unknown) => {
        void context
          .experimental_emitSignal(signal, payload as never)
          .catch(() => undefined);
      };

      // Retain the worker before anything can fail, so the lease is never leaked.
      const lease = context.experimental_retainWorker();

      // Wire the notifications the client needs, mapping each to a signal.
      app.on("thread/realtime/sdp", (params) => {
        const value = params as { sdp?: string };
        if (typeof value.sdp === "string") {
          emit("realtime_sdp", { callId, sdp: value.sdp });
        }
      });
      app.on("thread/realtime/outputAudio/delta", (params) => {
        const value = params as {
          audio?: { data?: string; numChannels?: number; sampleRate?: number };
        };
        if (typeof value.audio?.data === "string") {
          emit("realtime_output_audio", {
            callId,
            data: value.audio.data,
            numChannels: value.audio.numChannels ?? 1,
            sampleRate: value.audio.sampleRate ?? 24_000,
          });
        }
      });
      // Delta notifications carry `delta`, not `text` — reading `text` here
      // silently dropped every streamed fragment, which is why only the final
      // transcript ever appeared.
      app.on("thread/realtime/transcript/delta", (params) => {
        const value = params as {
          delta?: string;
          role?: string;
          itemId?: string;
          item_id?: string;
          turnId?: string;
          turn_id?: string;
          responseId?: string;
          response_id?: string;
        };
        if (typeof value.delta === "string") {
          emit("realtime_transcript", {
            callId,
            itemId:
              value.itemId ?? value.item_id ?? value.turnId ?? value.turn_id
              ?? value.responseId ?? value.response_id ?? null,
            text: value.delta,
            final: false,
            role: typeof value.role === "string" ? value.role : "assistant",
          });
        }
      });
      app.on("thread/realtime/transcript/done", (params) => {
        const value = params as {
          text?: string;
          role?: string;
          itemId?: string;
          item_id?: string;
          turnId?: string;
          turn_id?: string;
          responseId?: string;
          response_id?: string;
        };
        emit("realtime_transcript", {
          callId,
          itemId:
            value.itemId ?? value.item_id ?? value.turnId ?? value.turn_id
            ?? value.responseId ?? value.response_id ?? null,
          text: value.text ?? "",
          final: true,
          role: typeof value.role === "string" ? value.role : "assistant",
        });
      });
      app.on("thread/realtime/error", (params) => {
        const value = params as { message?: string };
        emit("realtime_error", { callId, message: value.message ?? "unknown realtime error" });
      });
      app.on("thread/realtime/closed", (params) => {
        const value = params as { reason?: string };
        emit("realtime_closed", { callId, reason: value.reason ?? null });
        if (session === current) {
          const closed = current;
          session = null;
          closed.state = "closed";
          closed.app.dispose();
          void closed.lease.dispose();
        }
      });

      const current: Session = {
        callId,
        threadId,
        codexThreadId: null,
        state: "starting",
        app,
        api,
        lease,
      };
      session = current;

      try {
        // Handshake first: without it every later request fails "Not initialized",
        // and without `experimentalApi` the realtime methods are not offered.
        await api.initialize({ name: "bb-voice-presence", version: "0.3.5" });
        // A realtime session needs a real app-server thread. Create one scoped to
        // this plugin's own data dir, so the voice thread is not sitting inside a
        // repository and cannot quietly act on one.
        const codexThreadId = await api.createThread({
          cwd: context.experimental_paths.dataDir,
        });
        await api.start({
          threadId: codexThreadId,
          outputModality,
          // WebRTC when the client brought an offer — that path is peer-to-peer
          // and needs no API key. Falling back to `websocket` would make the
          // app-server open its own socket, which does.
          ...(offerSdp === null
            ? { transport: { type: "websocket" as const } }
            : { transport: { type: "webrtc" as const, sdp: offerSdp } }),
          clientManagedHandoffs: true,
          prompt,
          initialItems,
          ...(version === null ? {} : { version }),
          ...(voice === null ? {} : { voice: voice as (typeof REALTIME_VOICES)[number] }),
        });
        if (session !== current) return { ok: false, detail: "The call ended during negotiation." };
        current.state = "live";
        current.codexThreadId = codexThreadId;
        return { ok: true, detail: null };
      } catch (cause) {
        current.state = "failed";
        app.dispose();
        await lease.dispose();
        if (session === current) session = null;
        return {
          ok: false,
          detail: cause instanceof Error ? cause.message : String(cause),
        };
      }
    },

    realtime_append_audio: async (input) => {
      if (
        session === null ||
        session.callId !== input.callId ||
        session.codexThreadId === null
      ) return { ok: false };
      try {
        await session.api.appendAudio({
          threadId: session.codexThreadId,
          data: input.data,
          numChannels: input.numChannels,
          sampleRate: input.sampleRate,
          ...(input.samplesPerChannel === null
            ? {}
            : { samplesPerChannel: input.samplesPerChannel }),
        });
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },

    realtime_append_text: async ({ callId, text, role }) => {
      if (session === null || session.callId !== callId || session.codexThreadId === null) {
        return { ok: false };
      }
      try {
        await session.api.appendText({ threadId: session.codexThreadId, text, role });
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },

    realtime_say: async ({ callId, text }) => {
      if (session === null || session.callId !== callId || session.codexThreadId === null) {
        return { ok: false };
      }
      try {
        await session.api.appendSpeech({ threadId: session.codexThreadId, text });
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },

    realtime_stop: async ({ callId }) => {
      if (session === null || session.callId !== callId) return { ok: false };
      const current = session;
      session = null;
      try {
        if (current.codexThreadId !== null) {
          await current.api.stop({ threadId: current.codexThreadId });
        }
      } catch {
        // Stopping a dead link is still stopped.
      }
      current.app.dispose();
      await current.lease.dispose();
      return { ok: true };
    },

    realtime_state: ({ callId }) =>
      session === null || session.callId !== callId
        ? { state: "idle" as const, threadId: null }
        : { state: session.state, threadId: session.threadId },
  },
  dispose: async () => {
    const current = session;
    session = null;
    current?.app.dispose();
    await current?.lease.dispose();
  },
});
