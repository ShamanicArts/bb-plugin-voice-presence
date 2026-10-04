export const REALTIME_METHODS = {
  initialize: "initialize",
  start: "thread/realtime/start",
  stop: "thread/realtime/stop",
  appendAudio: "thread/realtime/appendAudio",
  appendText: "thread/realtime/appendText",
  appendSpeech: "thread/realtime/appendSpeech",
  listVoices: "thread/realtime/listVoices",
} as const;

/**
 * app-server -> client notifications.
 *
 * All carry `threadId`. Note the first three `item/*` entries: the binary emits
 * them but BB's own Codex host allowlist only knows `itemAdded`
 * (builtin-plugins/provider-codex/dist/host.js), so BB would drop them today.
 */
export const REALTIME_NOTIFICATIONS = [
  "thread/realtime/started",
  "thread/realtime/sdp",
  "thread/realtime/itemAdded",
  "thread/realtime/item/started",
  "thread/realtime/item/completed",
  "thread/realtime/item/transcript/delta",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "thread/realtime/error",
  "thread/realtime/closed",
] as const;
export type RealtimeNotification = (typeof REALTIME_NOTIFICATIONS)[number];

export type RealtimeConversationVersion = "v1" | "v2" | "v3";
export type RealtimeOutputModality = "text" | "audio";
export type ConversationTextRole = "user" | "developer" | "assistant";

/** The full `RealtimeVoice` enum from the schema. */
export const REALTIME_VOICES = [
  "alloy", "arbor", "ash", "ballad", "breeze", "cedar", "coral", "cove", "echo",
  "ember", "juniper", "maple", "marin", "sage", "shimmer", "sol", "spruce",
  "vale", "verse",
] as const satisfies readonly string[];
export type RealtimeVoice = (typeof REALTIME_VOICES)[number];

/** `ThreadRealtimeAudioChunk` — the chunk nested under `audio` on appendAudio. */
export interface RealtimeAudioChunk {
  /** Base64 PCM. */
  readonly data: string;
  readonly numChannels: number;
  readonly sampleRate: number;
  readonly samplesPerChannel?: number | null;
  readonly itemId?: string | null;
}

/** `ThreadRealtimeInitialItem` — role-bearing history for a V3 session start. */
export interface RealtimeInitialItem {
  readonly role: ConversationTextRole;
  readonly text: string;
}

// ---------------------------------------------------------------------------
// Launch args
// ---------------------------------------------------------------------------

/**
 * Ported from `apps/server/src/provider/Layers/codexLaunchArgs.ts`: `app-server`
 * is the base command and `--enable realtime_conversation` turns the feature on.
 *
 * `--experimental` is NOT added here: the original does not pass it, and it is
 * what the schema GENERATOR needed to emit experimental methods, not something
 * the running server requires. Flagging that honestly rather than quietly
 * adding a flag the source does not have.
 */
export function codexAppServerArgs(options: {
  enableRealtimeConversation?: boolean;
  listenUnixPath?: string;
} = {}): string[] {
  const base = ["app-server"];
  const withListen =
    options.listenUnixPath === undefined
      ? base
      : [...base, "--listen", `unix://${options.listenUnixPath}`];
  return options.enableRealtimeConversation === true
    ? [...withListen, "--enable", "realtime_conversation"]
    : withListen;
}

/**
 * Which media transport this client should use — ported from
 * `selectRealtimeVoiceTransportKind`: WebRTC unless PCM is explicitly preferred,
 * PCM when the client has no WebRTC (mobile and remote browser).
 */
export function selectTransportKind(
  capabilities: { webrtc: boolean; pcmWorklet: boolean; mediaDevices: boolean },
  preferPcm = false,
): "webrtc" | "websocket" | "unsupported" {
  if (!preferPcm && capabilities.webrtc) return "webrtc";
  if (capabilities.pcmWorklet && capabilities.mediaDevices) return "websocket";
  if (capabilities.webrtc) return "webrtc";
  return "unsupported";
}

// ---------------------------------------------------------------------------
// Param builders — exact wire shapes
// ---------------------------------------------------------------------------

/**
 * `ThreadRealtimeStartTransport` — a union, and the choice decides auth.
 *
 *   { type: "websocket" }        -> the app-server opens its own OpenAI socket,
 *                                   which REQUIRES API-key auth
 *   { type: "webrtc", sdp }      -> media is peer-to-peer with the client's own
 *                                   offer; this is the path the original uses
 *   { type: "existingCall", id } -> rejoin
 *
 * Picking `websocket` is what produced "realtime conversation requires API key
 * auth". That error was a symptom of the wrong transport, not a missing key.
 */
export type RealtimeStartTransport =
  | { readonly type: "websocket" }
  | { readonly type: "webrtc"; readonly sdp: string }
  | { readonly type: "existingCall"; readonly callId: string };

/** `ThreadRealtimeStartParams` minus the rollout knobs, plus what we send. */
export function realtimeStartParams(input: {
  threadId: string;
  outputModality: RealtimeOutputModality;
  transport?: RealtimeStartTransport;
  version?: RealtimeConversationVersion;
  voice?: RealtimeVoice;
  model?: string;
  prompt?: string;
  initialItems?: RealtimeInitialItem[];
  clientManagedHandoffs?: boolean;
}): Record<string, unknown> {
  return {
    threadId: input.threadId,
    outputModality: input.outputModality,
    ...(input.transport === undefined ? {} : { transport: input.transport }),
    ...(input.version === undefined ? {} : { version: input.version }),
    ...(input.voice === undefined ? {} : { voice: input.voice }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    ...(input.initialItems === undefined ? {} : { initialItems: input.initialItems }),
    ...(input.clientManagedHandoffs === undefined
      ? {}
      : { clientManagedHandoffs: input.clientManagedHandoffs }),
  };
}

/** `ThreadRealtimeAppendAudioParams` — the chunk is nested under `audio`. */
export function realtimeAppendAudioParams(input: {
  threadId: string;
  data: string;
  numChannels: number;
  sampleRate: number;
  samplesPerChannel?: number;
  itemId?: string;
}): Record<string, unknown> {
  return {
    threadId: input.threadId,
    audio: {
      data: input.data,
      numChannels: input.numChannels,
      sampleRate: input.sampleRate,
      ...(input.samplesPerChannel === undefined
        ? {}
        : { samplesPerChannel: input.samplesPerChannel }),
      ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
    },
  };
}

/** Non-realtime requests this host needs. */
export const THREAD_METHODS = { start: "thread/start", initialize: "initialize" } as const;

/**
 * `initialize` must be the first request on the connection, or every later call
 * fails with "Not initialized".
 *
 * `capabilities.experimentalApi` is not optional in practice: the whole
 * `thread/realtime/*` surface is marked EXPERIMENTAL, and a client that has not
 * opted in does not get it.
 */
export function initializeParams(input: { name: string; version: string }): Record<string, unknown> {
  return {
    clientInfo: { name: input.name, version: input.version },
    capabilities: { experimentalApi: true },
  };
}

/**
 * `ThreadStartParams`. `cwd` is what makes it a real thread, and it is also what
 * scopes whatever the voice agent may touch — the host passes its own data dir so
 * the conversation thread is not sitting inside someone's repository.
 */
export function threadStartParams(input: {
  cwd: string;
  model?: string;
  ephemeral?: boolean;
}): Record<string, unknown> {
  return {
    cwd: input.cwd,
    // Required for spoken turns to be observable at all: without it the raw
    // Responses API items never reach the event stream, so the user's completed
    // transcription is invisible and nothing can be tied to the thread. This is
    // the `thread/start` flag, not a realtime one.
    experimentalRawEvents: true,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.ephemeral === undefined ? {} : { ephemeral: input.ephemeral }),
  };
}

/** `ThreadStartResponse` carries the thread; the id is what realtime needs. */
export function threadIdFromStartResponse(response: unknown): string | null {
  const thread = (response as { thread?: { id?: unknown } } | null)?.thread;
  return typeof thread?.id === "string" && thread.id !== "" ? thread.id : null;
}

// ---------------------------------------------------------------------------
// JSON-RPC client
// ---------------------------------------------------------------------------

/** One line in and out. `child.stdin` / `child.stdout` satisfy this directly. */
export interface LineTransport {
  write(line: string): void;
  onLine(handler: (line: string) => void): void;
  onClose(handler: (reason: string) => void): void;
  close(): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (cause: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AppServerError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "AppServerError";
    this.code = code;
  }
}

/**
 * A minimal JSON-RPC client for the app-server stream: correlated requests with
 * a timeout, and notification fan-out.
 */
export class CodexAppServer {
  #transport: LineTransport;
  #pending = new Map<number, Pending>();
  #handlers = new Map<string, Set<(params: unknown) => void>>();
  #nextId = 1;
  #closed = false;
  #timeoutMs: number;

  constructor(transport: LineTransport, options: { timeoutMs?: number } = {}) {
    this.#transport = transport;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    transport.onLine((line) => this.#handleLine(line));
    transport.onClose((reason) => this.#abortAll(new Error(`App-server closed: ${reason}`)));
  }

  #handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Not fatal: the app-server writes log lines to this stream too.
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    const message = parsed as Record<string, unknown>;
    if (typeof message.method === "string" && message.id === undefined) {
      if (typeof message.params !== "object" || message.params === null || Array.isArray(message.params)) return;
      for (const handler of this.#handlers.get(message.method) ?? []) {
        handler(message.params);
      }
      return;
    }
    if (typeof message.id !== "number") return;
    let error: { code: number; message: string } | undefined;
    if (message.error !== undefined) {
      const value = message.error;
      if (typeof value !== "object" || value === null ||
        !("code" in value) || typeof value.code !== "number" ||
        !("message" in value) || typeof value.message !== "string") return;
      error = { code: value.code, message: value.message };
    }
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (error !== undefined) {
      pending.reject(new AppServerError(error.code, error.message));
    } else {
      pending.resolve(message.result);
    }
  }

  #abortAll(cause: Error): void {
    this.#closed = true;
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(cause);
    }
    this.#pending.clear();
  }

  request<Result = unknown>(method: string, params?: unknown): Promise<Result> {
    if (this.#closed) return Promise.reject(new Error("App-server link is closed."));
    const id = this.#nextId++;
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`App-server request timed out: ${method}`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.#transport.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (cause) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(cause);
      }
    });
  }

  on(method: RealtimeNotification | string, handler: (params: unknown) => void): () => void {
    const set = this.#handlers.get(method) ?? new Set();
    set.add(handler);
    this.#handlers.set(method, set);
    return () => {
      set.delete(handler);
    };
  }

  dispose(): void {
    this.#abortAll(new Error("App-server link disposed."));
    this.#transport.close();
  }
}

/** The realtime half, expressed as the calls the transport makes. */
export function realtimeApi(app: CodexAppServer) {
  return {
    /**
     * Handshake. Must happen before anything else, and must opt into the
     * experimental API or the realtime methods are not offered at all.
     */
    initialize: (input: { name: string; version: string }) =>
      app.request(REALTIME_METHODS.initialize, initializeParams(input)),
    /**
     * A realtime session must attach to a real app-server thread, so one is
     * created first. Without this, `thread/realtime/start` is naming a thread the
     * fresh app-server has never heard of.
     */
    createThread: async (input: Parameters<typeof threadStartParams>[0]) => {
      const response = await app.request(THREAD_METHODS.start, threadStartParams(input));
      const id = threadIdFromStartResponse(response);
      if (id === null) throw new Error("App-server returned no thread id from thread/start.");
      return id;
    },
    start: (input: Parameters<typeof realtimeStartParams>[0]) =>
      app.request(REALTIME_METHODS.start, realtimeStartParams(input)),
    stop: (input: { threadId: string }) => app.request(REALTIME_METHODS.stop, input),
    /** Returns `{ voices }`. */
    listVoices: () => app.request<{ voices: RealtimeVoice[] }>(REALTIME_METHODS.listVoices),
    appendAudio: (input: Parameters<typeof realtimeAppendAudioParams>[0]) =>
      app.request(REALTIME_METHODS.appendAudio, realtimeAppendAudioParams(input)),
    appendText: (input: { threadId: string; text: string; role?: ConversationTextRole }) =>
      app.request(REALTIME_METHODS.appendText, input),
    appendSpeech: (input: { threadId: string; text: string }) =>
      app.request(REALTIME_METHODS.appendSpeech, input),
  };
}

export type RealtimeApi = ReturnType<typeof realtimeApi>;
