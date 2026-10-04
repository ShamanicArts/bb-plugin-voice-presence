// Tests for the Codex app-server realtime link.
//
// The JSON-RPC framing is exercised against a fake line transport, so this runs
// without spawning anything.
import { describe, expect, it } from "vitest";
import {
  AppServerError,
  CodexAppServer,
  REALTIME_METHODS,
  REALTIME_NOTIFICATIONS,
  codexAppServerArgs,
  initializeParams,
  realtimeApi,
  selectTransportKind,
  type LineTransport,
} from "./codex-app-server";

/** A fake app-server stream that records writes and lets tests emit lines. */
function fakeTransport() {
  const written: Record<string, unknown>[] = [];
  const lines: ((line: string) => void)[] = [];
  let closed: ((reason: string) => void)[] = [];
  const transport: LineTransport = {
    write(line) {
      written.push(JSON.parse(line));
    },
    onLine(handler) {
      lines.push(handler);
    },
    onClose(handler) {
      closed.push(handler);
    },
    close() {},
  };
  return {
    transport,
    written,
    emit: (message: unknown) => {
      for (const handler of lines) handler(`${JSON.stringify(message)}\n`);
    },
    emitRaw: (raw: string) => {
      for (const handler of lines) handler(raw);
    },
    drop: (reason: string) => {
      for (const handler of closed) handler(reason);
    },
  };
}

describe("launch args", () => {
  it("matches the original's app-server command", () => {
    // Ported from codexLaunchArgs.ts: base command, then the feature flag.
    expect(codexAppServerArgs()).toEqual(["app-server"]);
    expect(codexAppServerArgs({ enableRealtimeConversation: true })).toEqual([
      "app-server",
      "--enable",
      "realtime_conversation",
    ]);
    expect(
      codexAppServerArgs({ enableRealtimeConversation: true, listenUnixPath: "/tmp/codex.sock" }),
    ).toEqual([
      "app-server",
      "--listen",
      "unix:///tmp/codex.sock",
      "--enable",
      "realtime_conversation",
    ]);
  });
});

describe("transport selection", () => {
  it("follows the original's capability rules", () => {
    const full = { webrtc: true, pcmWorklet: true, mediaDevices: true };
    expect(selectTransportKind(full)).toBe("webrtc");
    // Explicit preference flips a WebRTC-capable client to the PCM path.
    expect(selectTransportKind(full, true)).toBe("websocket");
    // No WebRTC (the mobile / remote-browser case) falls to PCM.
    expect(selectTransportKind({ ...full, webrtc: false })).toBe("websocket");
    // WebRTC but no worklet still works.
    expect(selectTransportKind({ ...full, pcmWorklet: false }, true)).toBe("webrtc");
    // Neither.
    expect(selectTransportKind({ webrtc: false, pcmWorklet: false, mediaDevices: true })).toBe(
      "unsupported",
    );
  });
});

describe("the notification set agrees with BB's Codex host", () => {
  it("supersets what BB's provider-codex already allowlists", () => {
    // Read out of BB's own host bundle
    // (builtin-plugins/provider-codex/dist/host.js). These eight are what BB
    // recognises and forwards today.
    const bbAllowlist = [
      "thread/realtime/closed",
      "thread/realtime/error",
      "thread/realtime/itemAdded",
      "thread/realtime/outputAudio/delta",
      "thread/realtime/sdp",
      "thread/realtime/started",
      "thread/realtime/transcript/delta",
      "thread/realtime/transcript/done",
    ];
    for (const method of bbAllowlist) {
      expect(REALTIME_NOTIFICATIONS).toContain(method);
    }
    // And the binary emits three more that BB's allowlist does NOT know, so BB
    // would drop them. Recorded here so the gap is visible rather than silent.
    const bbDoesNotKnow = [...REALTIME_NOTIFICATIONS].filter(
      (method) => !bbAllowlist.includes(method),
    );
    expect(bbDoesNotKnow.sort()).toEqual([
      "thread/realtime/item/completed",
      "thread/realtime/item/started",
      "thread/realtime/item/transcript/delta",
    ]);
  });
});

describe("JSON-RPC framing", () => {
  it("ignores JSON primitives and malformed errors without losing the pending response", async () => {
    const fake = fakeTransport();
    const app = new CodexAppServer(fake.transport);
    const pending = app.request("x");
    for (const value of [null, false, 1, "log", [], { id: 1, error: null }, { id: 1, error: { code: "bad", message: 1 } }]) {
      expect(() => fake.emit(value)).not.toThrow();
    }
    fake.emit({ id: 1, result: "response" });
    await expect(pending).resolves.toBe("response");
    app.dispose();
  });
  it("correlates responses by id, even out of order", async () => {
    const fake = fakeTransport();
    const app = new CodexAppServer(fake.transport);
    const first = app.request("a");
    const second = app.request("b");
    expect(fake.written).toHaveLength(2);
    const [idA, idB] = fake.written.map((message) => message.id as number);

    // Reply to the SECOND request first.
    fake.emit({ jsonrpc: "2.0", id: idB, result: { which: "b" } });
    fake.emit({ jsonrpc: "2.0", id: idA, result: { which: "a" } });

    expect(await first).toEqual({ which: "a" });
    expect(await second).toEqual({ which: "b" });
  });

  it("sends well-formed requests", async () => {
    const fake = fakeTransport();
    const app = new CodexAppServer(fake.transport);
    void app.request(REALTIME_METHODS.listVoices, { any: 1 });
    expect(fake.written[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "thread/realtime/listVoices",
      params: { any: 1 },
    });
  });

  it("rejects with the app-server's error", async () => {
    const fake = fakeTransport();
    const app = new CodexAppServer(fake.transport);
    const pending = app.request("x");
    fake.emit({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "realtime unavailable" } });
    await expect(pending).rejects.toBeInstanceOf(AppServerError);
    await expect(pending).rejects.toThrow("realtime unavailable");
  });

  it("routes notifications to their subscribers and ignores other lines", async () => {
    const fake = fakeTransport();
    const app = new CodexAppServer(fake.transport);
    const sdp: unknown[] = [];
    const transcripts: unknown[] = [];
    app.on("thread/realtime/sdp", (params) => sdp.push(params));
    app.on("thread/realtime/transcript/delta", (params) => transcripts.push(params));

    fake.emit({ jsonrpc: "2.0", method: "thread/realtime/sdp", params: { sdp: "v=0" } });
    fake.emit({ jsonrpc: "2.0", method: "thread/realtime/transcript/delta", params: { text: "hi" } });
    fake.emit({ jsonrpc: "2.0", method: "thread/status/changed", params: {} });
    // A non-JSON line (the app-server logs too) must not throw.
    fake.emitRaw("not json at all\n");

    expect(sdp).toEqual([{ sdp: "v=0" }]);
    expect(transcripts).toEqual([{ text: "hi" }]);
  });

  it("unsubscribes cleanly", () => {
    const fake = fakeTransport();
    const app = new CodexAppServer(fake.transport);
    const seen: unknown[] = [];
    const off = app.on("thread/realtime/started", (params) => seen.push(params));
    fake.emit({ jsonrpc: "2.0", method: "thread/realtime/started", params: { ok: 1 } });
    off();
    fake.emit({ jsonrpc: "2.0", method: "thread/realtime/started", params: { ok: 2 } });
    expect(seen).toEqual([{ ok: 1 }]);
  });

  it("fails pending requests when the app-server goes away", async () => {
    const fake = fakeTransport();
    const app = new CodexAppServer(fake.transport);
    const pending = app.request("x");
    fake.drop("process exited");
    await expect(pending).rejects.toThrow(/closed/i);
  });

  it("times out rather than hanging a turn forever", async () => {
    const fake = fakeTransport();
    const app = new CodexAppServer(fake.transport, { timeoutMs: 10 });
    await expect(app.request("x")).rejects.toThrow(/timed out/u);
  });
});

describe("the realtime calls", () => {
  it("starts a session with the schema's required fields", async () => {
    const fake = fakeTransport();
    const app = new CodexAppServer(fake.transport);
    const api = realtimeApi(app);
    const pending = api.start({
      threadId: "thr_1",
      outputModality: "audio",
      version: "v3",
      voice: "marin",
    });
    // `threadId` and `outputModality` are the only required fields, and the
    // chunk-free optional ones must simply be absent rather than null.
    expect(fake.written[0]).toMatchObject({
      method: "thread/realtime/start",
      params: { threadId: "thr_1", outputModality: "audio", version: "v3", voice: "marin" },
    });
    fake.emit({ jsonrpc: "2.0", id: 1, result: { threadId: "thr_1", version: 3 } });
    expect(await pending).toEqual({ threadId: "thr_1", version: 3 });
  });

  it("omits optional start fields it was not given", async () => {
    const fake = fakeTransport();
    const app = new CodexAppServer(fake.transport);
    void realtimeApi(app).start({ threadId: "thr_1", outputModality: "text" });
    const params = fake.written[0]?.params as Record<string, unknown>;
    expect(Object.keys(params).sort()).toEqual(["outputModality", "threadId"]);
  });

  it("passes the attached thread context and client-managed handoff policy", () => {
    const fake = fakeTransport();
    const app = new CodexAppServer(fake.transport);
    void realtimeApi(app).start({
      threadId: "voice_transport",
      outputModality: "audio",
      clientManagedHandoffs: true,
      prompt: "Stay attached to the owner thread.",
      initialItems: [
        { role: "developer", text: "owner thread: thr_1" },
        { role: "user", text: "the latest context" },
      ],
    });
    expect(fake.written[0]?.params).toMatchObject({
      clientManagedHandoffs: true,
      prompt: "Stay attached to the owner thread.",
      initialItems: [
        { role: "developer", text: "owner thread: thr_1" },
        { role: "user", text: "the latest context" },
      ],
    });
  });

  it("nests the audio chunk the way the wire format requires", async () => {
    const fake = fakeTransport();
    const app = new CodexAppServer(fake.transport);
    void realtimeApi(app).appendAudio({
      threadId: "thr_1",
      data: "AAAA",
      numChannels: 1,
      sampleRate: 24_000,
      samplesPerChannel: 480,
    });
    // `ThreadRealtimeAppendAudioParams` = { threadId, audio: ThreadRealtimeAudioChunk }.
    // An earlier version of this file sent `audioBase64`/`format`/`sequence`
    // flat, which was shuv2code's RPC shape rather than the app-server's.
    expect(fake.written[0]).toMatchObject({
      method: "thread/realtime/appendAudio",
      params: {
        threadId: "thr_1",
        audio: { data: "AAAA", numChannels: 1, sampleRate: 24_000, samplesPerChannel: 480 },
      },
    });
    const params = fake.written[0]?.params as { audio: Record<string, unknown> };
    expect(params.audio.itemId).toBeUndefined();
  });

  it("routes the sdp notification that a WebRTC client needs", () => {
    const fake = fakeTransport();
    const app = new CodexAppServer(fake.transport);
    const answers: unknown[] = [];
    app.on("thread/realtime/sdp", (params) => answers.push(params));
    fake.emit({
      jsonrpc: "2.0",
      method: "thread/realtime/sdp",
      params: { threadId: "thr_1", sdp: "v=0" },
    });
    expect(answers).toEqual([{ threadId: "thr_1", sdp: "v=0" }]);
  });
});

describe("the handshake", () => {
  it("opts into the experimental API, without which realtime is not offered", () => {
    const params = initializeParams({ name: "bb-voice-presence", version: "0.1.0" }) as {
      clientInfo: { name: string; version: string };
      capabilities: { experimentalApi: boolean };
    };
    expect(params.clientInfo.name).toBe("bb-voice-presence");
    expect(params.clientInfo.version).toBe("0.1.0");
    expect(params.capabilities.experimentalApi).toBe(true);
  });

  it("is sent before any other request", async () => {
    const fake = fakeTransport();
    const app = new CodexAppServer(fake.transport);
    const api = realtimeApi(app);
    const handshake = api.initialize({ name: "bb-voice-presence", version: "0.1.0" });
    expect(fake.written[0]?.method).toBe("initialize");
    fake.emit({ jsonrpc: "2.0", id: 1, result: { codexHome: "/tmp" } });
    await handshake;
    const created = api.createThread({ cwd: "/tmp" });
    expect(fake.written[1]?.method).toBe("thread/start");
    fake.emit({ jsonrpc: "2.0", id: 2, result: { thread: { id: "cx_1" } } });
    expect(await created).toBe("cx_1");
  });

  it("refuses to invent a thread id when the app-server omits one", async () => {
    const fake = fakeTransport();
    const app = new CodexAppServer(fake.transport);
    const pending = realtimeApi(app).createThread({ cwd: "/tmp" });
    fake.emit({ jsonrpc: "2.0", id: 1, result: {} });
    await expect(pending).rejects.toThrow(/no thread id/u);
  });
});
