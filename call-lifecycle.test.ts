import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function setup(options: {
  start?: () => Promise<{ ok: boolean; detail: string | null }>;
  append?: () => Promise<{ ok: boolean }>;
} = {}) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "voice-presence",
    sdk: {
      system: { config: async () => ({ primaryHostId: "host_online" }) },
      hosts: { list: async () => [
        { id: "host_offline", status: "disconnected" },
        { id: "host_online", status: "connected" },
      ] },
      threads: {
        get: async ({ threadId }) => ({
          id: threadId, projectId: "proj_1", providerId: "codex",
          title: threadId, titleFallback: null, status: "active",
        }),
        conversationOutline: async () => ({ items: [], maxSeq: 0 }),
        events: { list: async () => [] },
        listRunning: async () => [],
      },
    },
    experimental_callHostRpc: async ({ method }) => {
      if (method === "realtime_ready") return { ready: true, binary: "codex", detail: null, voices: [] };
      if (method === "realtime_start") return options.start?.() ?? { ok: true, detail: null };
      if (method === "realtime_append_text") return options.append?.() ?? { ok: true };
      if (method === "realtime_state") return { state: "live", threadId: "thr_a" };
      if (method === "realtime_stop") return { ok: true };
      throw new Error(`Unexpected host call: ${method}`);
    },
  });
  await plugin(bb);
  disposals.push(() => harness.lifecycle.dispose());
  const rpc = (method: string, input: unknown) => harness.behavior.callRpc(method, input);
  const call = await rpc("call_start", { threadId: "thr_a" }) as { callId: string };
  const negotiate = async () => {
    const result = rpc("call_offer", { threadId: "thr_a", sdp: "offer" });
    await vi.waitFor(() => expect(harness.experimental_hostRpcCalls.some((call) => call.method === "realtime_start")).toBe(true));
    return { result };
  };
  const answer = () => harness.experimental_emitHostSignal("host_online", "realtime_sdp", { callId: call.callId, sdp: "answer" });
  return { call, harness, rpc, negotiate, answer };
}

it("uses the connected primary host rather than the first enrolled host", async () => {
  const { harness } = await setup();
  expect(harness.experimental_hostRpcCalls.find((call) => call.method === "realtime_ready")?.hostId).toBe("host_online");
});

it("does not reactivate a call when an SDP answer arrives after hangup", async () => {
  const start = deferred<{ ok: boolean; detail: string | null }>();
  const { rpc, negotiate, answer } = await setup({ start: () => start.promise });
  const { result } = await negotiate();
  await rpc("call_end", { threadId: "thr_a" });
  await answer();
  start.resolve({ ok: true, detail: null });
  await expect(result).resolves.toMatchObject({ ok: false });
  await expect(rpc("active_call", null)).resolves.toMatchObject({ callId: null });
});

it("rejects a second offer while the first negotiation is pending", async () => {
  const { rpc, negotiate, answer } = await setup();
  const { result } = await negotiate();
  await expect(rpc("call_offer", { threadId: "thr_a", sdp: "second" })).resolves.toMatchObject({ ok: false });
  await answer();
  await expect(result).resolves.toMatchObject({ ok: true, sdp: "answer" });
  await expect(rpc("call_offer", { threadId: "thr_a", sdp: "retry" })).resolves.toMatchObject({ ok: false });
  await expect(rpc("active_call", null)).resolves.toMatchObject({ state: "active" });
});

it("releases call ownership after a host start throws", async () => {
  const { rpc } = await setup({ start: async () => { throw new Error("host disconnected"); } });
  await expect(rpc("call_offer", { threadId: "thr_a", sdp: "offer" })).resolves.toMatchObject({ ok: false });
  await expect(rpc("active_call", null)).resolves.toMatchObject({ callId: null });
  await expect(rpc("call_start", { threadId: "thr_b" })).resolves.toMatchObject({ ownerThreadId: "thr_b" });
});

it.each(["throw", "reject"])("keeps the call attached to its owner when a move fails: %s", async (failure) => {
  const { call, rpc, negotiate, answer } = await setup({ append: async () => {
    if (failure === "throw") throw new Error("connection lost");
    return { ok: false };
  } });
  const { result } = await negotiate();
  await answer();
  await result;
  await expect(rpc("call_move", { callId: call.callId, toThreadId: "thr_b" })).resolves.toMatchObject({ ok: false });
  await expect(rpc("active_call", null)).resolves.toMatchObject({ threadId: "thr_a" });
});

it("does not move a call that ends while its new context is being sent", async () => {
  const append = deferred<{ ok: boolean }>();
  const { call, harness, rpc, negotiate, answer } = await setup({ append: () => append.promise });
  const { result } = await negotiate();
  await answer();
  await result;
  const move = rpc("call_move", { callId: call.callId, toThreadId: "thr_b" });
  await vi.waitFor(() => expect(harness.experimental_hostRpcCalls.some((call) => call.method === "realtime_append_text")).toBe(true));
  await rpc("call_end", { threadId: "thr_a" });
  append.resolve({ ok: true });
  await expect(move).resolves.toMatchObject({ ok: false });
  await expect(rpc("active_call", null)).resolves.toMatchObject({ callId: null });
});

it("cancels an unanswered negotiation when the plugin is disposed", async () => {
  const { harness, negotiate } = await setup();
  const { result } = await negotiate();
  await harness.lifecycle.dispose();
  await expect(result).resolves.toMatchObject({ ok: false });
});
