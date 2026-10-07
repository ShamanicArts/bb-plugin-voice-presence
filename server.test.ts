// Tests for bb-plugin-voice-presence.
//
// The ported behaviour worth pinning down: the call has one explicit owner,
// ordinary realtime conversation stays out of the durable thread, explicit
// handoffs are deduplicated, and the four durable verbs map to BB primitives.
import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const THREAD = "thr_current";
const PROJECT = "proj_1";

interface Call {
  method: string;
  args: Record<string, unknown>;
}

async function setup(options: { projectId?: string | null } = {}) {
  const calls: Call[] = [];
  let spawned = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "voice-presence",
    sdk: {
      threads: {
        get: async (args) => {
          calls.push({ method: "get", args: { ...args } });
          return {
            id: String(args.threadId),
            projectId: options.projectId ?? PROJECT,
            providerId: "codex",
            title: String(args.threadId) === THREAD ? "Current thread" : "Other thread",
            titleFallback: null,
            status: "active",
          };
        },
        conversationOutline: async () => ({ items: [], maxSeq: 0 }),
        spawn: async (args) => {
          calls.push({ method: "spawn", args: { ...args } });
          spawned += 1;
          return { id: `thr_spawned_${spawned}` };
        },
        listRunning: async () => [],
        send: async (args) => {
          calls.push({ method: "send", args: { ...args } });
          return { queued: false };
        },
        stop: async (args) => {
          calls.push({ method: "stop", args: { ...args } });
          return { stopped: true };
        },
      },
      hosts: { list: async () => [{ id: "host_1", status: "connected" }] },
      system: { config: async () => ({ primaryHostId: "host_1" }) },
    },
  });
  await plugin(bb);

  const rpc = (method: string, input: unknown) => harness.behavior.callRpc(method, input);
  return { bb, harness, calls, rpc, spawnedCount: () => spawned };
}

describe("joining a call on a thread", () => {
  it("attaches to the thread it was started from", async () => {
    const { rpc, spawnedCount } = await setup();
    const started = (await rpc("call_start", { threadId: THREAD })) as {
      callId: string;
      state: string;
      controllerThreadId: string;
    };
    expect(started.state).toBe("provisioning");
    expect(started.callId.startsWith(THREAD)).toBe(true);
    // The compatibility controller id is the owner, not the hidden transport.
    expect(started.controllerThreadId).toBe(THREAD);
    expect(spawnedCount()).toBe(0);
  });

  it("is idempotent — a second press reuses the live call", async () => {
    const { rpc, spawnedCount } = await setup();
    const first = (await rpc("call_start", { threadId: THREAD })) as { callId: string };
    const second = (await rpc("call_start", { threadId: THREAD })) as { callId: string };
    expect(second.callId).toBe(first.callId);
    // Nothing is created, on either press.
    expect(spawnedCount()).toBe(0);
  });

  it("creates no threads across repeated calls", async () => {
    const { rpc, spawnedCount } = await setup();
    await rpc("call_start", { threadId: THREAD });
    await rpc("call_end", { threadId: THREAD });
    await rpc("call_start", { threadId: THREAD });
    // A call must never put the voice in a thread the user is not looking at.
    expect(spawnedCount()).toBe(0);
  });

  it("records the owner without creating a visible BB sidecar thread", async () => {
    const { rpc, calls } = await setup();
    const started = (await rpc("call_start", { threadId: THREAD })) as {
      controllerThreadId: string;
      ownerThreadId: string;
      ownerThreadTitle: string;
    };
    expect(started.controllerThreadId).toBe(THREAD);
    expect(started.ownerThreadId).toBe(THREAD);
    expect(started.ownerThreadTitle).toBe("Current thread");
    expect(calls.some((call) => call.method === "spawn")).toBe(false);
  });

  it("keeps the one live call attached to its original thread", async () => {
    const { rpc } = await setup();
    const first = (await rpc("call_start", { threadId: THREAD })) as { callId: string };
    const second = (await rpc("call_start", { threadId: "thr_other" })) as {
      callId: string;
      ownerThreadId: string;
      ownerThreadTitle: string;
    };
    expect(second.callId).toBe(first.callId);
    expect(second.ownerThreadId).toBe(THREAD);
    expect(second.ownerThreadTitle).toBe("Current thread");
    expect(await rpc("active_call", null)).toMatchObject({
      threadId: THREAD,
      threadTitle: "Current thread",
    });
  });

  it("reports state for a thread with no call", async () => {
    const { rpc } = await setup();
    const state = (await rpc("call_state", { threadId: THREAD })) as {
      callId: string | null;
      state: string | null;
    };
    expect(state.callId).toBeNull();
    expect(state.state).toBeNull();
  });
});

describe("the four verbs", () => {
  it("create spawns in the call's project and retargets the call", async () => {
    const { rpc, calls } = await setup();
    await rpc("call_start", { threadId: THREAD });
    const result = (await rpc("call_action", {
      threadId: THREAD,
      verb: "create",
      prompt: "investigate the flaky test",
    })) as { ok: boolean; threadId: string | null };

    expect(result.ok).toBe(true);
    expect(result.threadId).toBe("thr_spawned_1");
    const spawn = calls.filter((call) => call.method === "spawn").at(-1);
    expect(spawn?.args).toMatchObject({ projectId: PROJECT, prompt: "investigate the flaky test" });

    // Retargeting is what makes "actually, focus on X" land on the new thread.
    const status = (await rpc("call_action", { threadId: THREAD, verb: "status" })) as {
      threadId: string | null;
    };
    expect(status.threadId).toBe("thr_spawned_1");
  });

  it("steers the target thread in steer mode", async () => {
    const { rpc, calls } = await setup();
    await rpc("call_start", { threadId: THREAD });
    await rpc("call_action", { threadId: THREAD, verb: "steer", prompt: "focus on failures" });
    const send = calls.find((call) => call.method === "send");
    expect(send?.args).toMatchObject({ threadId: THREAD, mode: "steer" });
    expect(send?.args.input).toEqual([
      { type: "text", text: "focus on failures", mentions: [] },
    ]);
  });

  it("interrupts the target thread", async () => {
    const { rpc, calls } = await setup();
    await rpc("call_start", { threadId: THREAD });
    await rpc("call_action", { threadId: THREAD, verb: "interrupt" });
    expect(calls.find((call) => call.method === "stop")?.args).toMatchObject({
      threadId: THREAD,
    });
  });

  it("refuses create and steer without their text", async () => {
    const { rpc } = await setup();
    await rpc("call_start", { threadId: THREAD });
    expect(((await rpc("call_action", { threadId: THREAD, verb: "create" })) as { ok: boolean }).ok).toBe(false);
    expect(((await rpc("call_action", { threadId: THREAD, verb: "steer" })) as { ok: boolean }).ok).toBe(false);
  });

  it("refuses every verb when there is no live call", async () => {
    const { rpc, calls } = await setup();
    const result = (await rpc("call_action", { threadId: THREAD, verb: "interrupt" })) as {
      ok: boolean;
      detail: string;
    };
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("No live voice call");
    expect(calls.some((call) => call.method === "stop")).toBe(false);
  });
});

describe("client-managed handoffs", () => {
  it("delivers durable work to the owner thread exactly once", async () => {
    const { rpc, calls } = await setup();
    const call = (await rpc("call_start", { threadId: THREAD })) as { callId: string };
    const input = { callId: call.callId, handoffId: "handoff-1", text: "fix the failing test" };

    expect(await rpc("call_handoff", input)).toEqual({ ok: true, duplicate: false });
    expect(await rpc("call_handoff", input)).toEqual({ ok: true, duplicate: true });

    const sends = calls.filter((entry) => entry.method === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.args).toMatchObject({ threadId: THREAD, mode: "auto" });
  });

  it("deduplicates two delegation items for one finalized spoken utterance", async () => {
    const { rpc, calls } = await setup();
    const call = (await rpc("call_start", { threadId: THREAD })) as { callId: string };
    const spoken = "Keep the complete spoken request, including this important detail.";
    expect(await rpc("call_transcript", {
      callId: call.callId,
      itemId: "user-transcript-1",
      role: "user",
      text: spoken,
    })).toEqual({ accepted: true, duplicate: false, conflict: false });

    expect(await rpc("call_handoff", {
      callId: call.callId,
      handoffId: "delegation-1",
      utteranceId: "user-transcript-1",
      text: "Condensed request",
    })).toEqual({ ok: true, duplicate: false });
    expect(await rpc("call_handoff", {
      callId: call.callId,
      handoffId: "delegation-2",
      utteranceId: "user-transcript-1",
      text: "Condensed request",
    })).toEqual({ ok: true, duplicate: true });

    const sends = calls.filter((entry) => entry.method === "send");
    expect(sends).toHaveLength(1);
    expect((sends[0]?.args.input as Array<{ text: string }>)[0]?.text).toBe(spoken);
  });

  it("attaches preceding voice-only exchanges when durable work is delegated", async () => {
    const { rpc, calls } = await setup();
    const call = (await rpc("call_start", { threadId: THREAD })) as { callId: string };
    await rpc("call_transcript", {
      callId: call.callId,
      itemId: "user-context",
      role: "user",
      text: "The tray should match pinned things.",
    });
    await rpc("call_transcript", {
      callId: call.callId,
      itemId: "assistant-context",
      role: "assistant",
      text: "I understand the visual direction.",
    });
    await rpc("call_transcript", {
      callId: call.callId,
      itemId: "user-work",
      role: "user",
      text: "Implement that now.",
    });
    await rpc("call_handoff", {
      callId: call.callId,
      handoffId: "delegation-work",
      utteranceId: "user-work",
      text: "implement",
    });

    const sent = calls.find((entry) => entry.method === "send")?.args.input as Array<{ text: string }>;
    expect(sent[0]?.text).toContain("Implement that now.");
    expect(sent[0]?.text).toContain("User: The tray should match pinned things.");
    expect(sent[0]?.text).toContain("Voice: I understand the visual direction.");
  });
});

describe("moving a live call", () => {
  it("moves ownership without replacing the call", async () => {
    const { rpc } = await setup();
    const started = (await rpc("call_start", { threadId: THREAD })) as { callId: string };
    const moved = await rpc("call_move", { callId: started.callId, toThreadId: "thr_other" });
    expect(moved).toMatchObject({ ok: true, threadId: "thr_other", threadTitle: "Other thread" });
    expect(await rpc("active_call", null)).toMatchObject({
      callId: started.callId,
      threadId: "thr_other",
      threadTitle: "Other thread",
    });
  });
});

describe("ending a call", () => {
  it("closes the call and leaves the controller thread alone", async () => {
    const { rpc, calls } = await setup();
    await rpc("call_start", { threadId: THREAD });
    const ended = (await rpc("call_end", { threadId: THREAD })) as { ended: boolean };
    expect(ended.ended).toBe(true);
    // There is no visible or durable BB sidecar thread to stop.
    expect(calls.some((call) => call.method === "stop")).toBe(false);
    const state = (await rpc("call_state", { threadId: THREAD })) as { callId: string | null };
    expect(state.callId).toBeNull();
  });
});

describe("realtime readiness", () => {
  it("degrades to a reported reason instead of throwing", async () => {
    // No API key is reachable from this environment, and the host client is not
    // wired in the fake host — either way the bubble must get a reason, not an
    // exception, because that is what it renders.
    const { rpc } = await setup();
    const state = (await rpc("call_state", { threadId: THREAD })) as {
      voiceAvailable: boolean;
      voiceDetail: string | null;
    };
    expect(state.voiceAvailable).toBe(false);
    expect(typeof state.voiceDetail).toBe("string");
  });
});

describe("browser transport ownership", () => {
  it("keeps a second BB client from replacing the initiating client's live transport", async () => {
    let realtimeStarts = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "voice-presence",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => ({
            id: threadId,
            projectId: PROJECT,
            providerId: "codex",
            title: "Current thread",
            titleFallback: null,
            status: "active",
          }),
          conversationOutline: async () => ({ items: [], maxSeq: 0 }),
          events: { list: async () => [] },
          listRunning: async () => [],
        },
        hosts: { list: async () => [{ id: "host_1", status: "connected" }] },
      system: { config: async () => ({ primaryHostId: "host_1" }) },
      },
      experimental_callHostRpc: ({ method }) => {
        if (method === "realtime_ready") {
          return { ready: true, binary: "codex", detail: null, voices: ["marin"] };
        }
        if (method === "realtime_start") {
          realtimeStarts += 1;
          return realtimeStarts === 1
            ? { ok: true, detail: null }
            : { ok: false, detail: "This call already has a realtime transport." };
        }
        if (method === "realtime_stop") return { ok: true };
        if (method === "realtime_state") return { state: "live", threadId: THREAD };
        if (method === "realtime_say") return { ok: true };
        throw new Error(`Unexpected host call: ${method}`);
      },
    });
    await plugin(bb);
    const rpc = (method: string, input: unknown) => harness.behavior.callRpc(method, input);
    const started = (await rpc("call_start", {
      threadId: THREAD,
      clientInstanceId: "mobile-client",
    })) as { callId: string };

    const mobileNegotiation = rpc("call_offer", {
      threadId: THREAD,
      clientInstanceId: "mobile-client",
      sdp: "mobile-offer",
    });
    await vi.waitFor(() => expect(realtimeStarts).toBe(1));
    await harness.experimental_emitHostSignal("host_1", "realtime_sdp", {
      callId: started.callId,
      sdp: "mobile-answer",
    });
    await expect(mobileNegotiation).resolves.toMatchObject({ ok: true });

    await expect(
      rpc("call_offer", {
        threadId: THREAD,
        clientInstanceId: "desktop-client",
        sdp: "desktop-offer",
      }),
    ).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining("another browser"),
    });
    expect(realtimeStarts).toBe(1);
    expect(
      await rpc("active_call", { clientInstanceId: "mobile-client" }),
    ).toMatchObject({ state: "active", transportOwner: true });
    expect(
      await rpc("active_call", { clientInstanceId: "desktop-client" }),
    ).toMatchObject({ state: "active", transportOwner: false });
  });
});

describe("owner-thread narration", () => {
  it("reads supported event pages and sends the response back into the call", async () => {
    const eventListInputs: Array<Record<string, unknown>> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "voice-presence",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => ({
            id: threadId,
            projectId: PROJECT,
            providerId: "codex",
            title: "Current thread",
            titleFallback: null,
            status: "active",
          }),
          conversationOutline: async () => ({ items: [], maxSeq: 10 }),
          events: {
            list: async (input) => {
              eventListInputs.push({ ...input });
              return eventListInputs.length === 1
                ? ([
                    {
                      id: "event-11",
                      threadId: THREAD,
                      seq: 11,
                      createdAt: 11,
                      scope: { kind: "turn", turnId: "turn-1" },
                      type: "item/completed",
                      data: {
                        providerThreadId: "provider-thread",
                        item: {
                          type: "agentMessage",
                          id: "message-1",
                          text: "The owner thread responded and this sentence should be narrated.",
                        },
                      },
                    },
                  ] as never)
                : [];
            },
          },
          listRunning: async () => [],
        },
        hosts: { list: async () => [{ id: "host_1", status: "connected" }] },
      system: { config: async () => ({ primaryHostId: "host_1" }) },
      },
      experimental_callHostRpc: ({ method }) => {
        if (method === "realtime_ready") {
          return { ready: true, binary: "codex", detail: null, voices: ["marin"] };
        }
        if (method === "realtime_start") return { ok: true, detail: null };
        if (method === "realtime_say") return { ok: true };
        if (method === "realtime_stop") return { ok: true };
        if (method === "realtime_state") return { state: "live", threadId: THREAD };
        throw new Error(`Unexpected host call: ${method}`);
      },
    });
    await plugin(bb);
    const started = (await harness.behavior.callRpc("call_start", { threadId: THREAD })) as {
      callId: string;
    };
    const negotiation = harness.behavior.callRpc("call_offer", {
      threadId: THREAD,
      sdp: "offer",
    });
    await vi.waitFor(() => {
      expect(
        harness.experimental_hostRpcCalls.some((call) => call.method === "realtime_start"),
      ).toBe(true);
    });
    await harness.experimental_emitHostSignal("host_1", "realtime_sdp", {
      callId: started.callId,
      sdp: "answer",
    });
    await expect(negotiation).resolves.toMatchObject({ ok: true, sdp: "answer" });

    await vi.waitFor(() => {
      expect(
        harness.experimental_hostRpcCalls.some((call) => call.method === "realtime_say"),
      ).toBe(true);
    });
    expect(eventListInputs[0]).toMatchObject({
      threadId: THREAD,
      afterSeq: "10",
      limit: "100",
    });
    expect(
      harness.experimental_hostRpcCalls.find((call) => call.method === "realtime_say")?.input,
    ).toMatchObject({
      callId: started.callId,
      text: "The owner thread responded and this sentence should be narrated.",
    });
  });
});

it("refuses an identified handoff until its finalized user transcript exists", async () => {
  const { rpc, calls, harness } = await setup();
  const call = await rpc("call_start", { threadId: THREAD }) as { callId: string };
  const handoff = { callId: call.callId, handoffId: "race", utteranceId: "in-flight", text: "partial" };
  expect(await rpc("call_handoff", handoff)).toEqual({ ok: false, duplicate: false });
  expect(calls.some((entry) => entry.method === "send")).toBe(false);
  await rpc("call_transcript", { callId: call.callId, itemId: "in-flight", role: "user", text: "complete spoken request" });
  expect(await rpc("call_handoff", handoff)).toEqual({ ok: true, duplicate: false });
  expect((calls.find((entry) => entry.method === "send")?.args.input as Array<{ text: string }>)[0]?.text)
    .toBe("complete spoken request");
  await harness.lifecycle.dispose();
});
