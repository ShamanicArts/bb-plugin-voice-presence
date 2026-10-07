// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function connect(persist: () => Promise<unknown> = async () => ({ accepted: true })) {
  let channel!: { onmessage: ((event: { data: string }) => void) | null };
  let frame!: FrameRequestCallback;
  const track = { enabled: true, stop: vi.fn() };
  const mic = { getAudioTracks: () => [track], getTracks: () => [track] };
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => mic } });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("AudioContext", class {
    state = "running";
    createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0) }; }
    createMediaStreamSource() { return { connect: vi.fn() }; }
    close() { return Promise.resolve(); }
  });
  vi.stubGlobal("MediaStream", class {});
  vi.stubGlobal("RTCPeerConnection", class {
    iceGatheringState = "complete";
    connectionState = "connected";
    localDescription = { sdp: "synthetic-offer" };
    addTrack() {}
    createDataChannel() { channel = { onmessage: null }; return channel; }
    createOffer() { return Promise.resolve({}); }
    setLocalDescription() { return Promise.resolve(); }
    setRemoteDescription() { return Promise.resolve(); }
    close() {}
  });
  const handoff = vi.fn(async () => ({ ok: true, duplicate: false }));
  const transcript = vi.fn(persist);
  const slot = renderSlot(app.appOverlays.find((slot) => slot.id === "voice-transport")!, {}, {
    rpc: {
      active_call: () => ({ callId: "call", threadId: "owner", threadTitle: "Owner", state: "active", transportOwner: true }),
      call_activity: () => ({ agentBusy: true }),
      call_offer: () => ({ ok: true, sdp: "synthetic-answer", detail: null }),
      call_transcript: transcript,
      call_handoff: handoff,
    },
  });
  await waitFor(() => expect(channel?.onmessage).toBeTypeOf("function"));
  await waitFor(() => expect(frame).toBeTypeOf("function"));
  const event = async (payload: unknown) => { await act(async () => channel.onmessage!({ data: JSON.stringify(payload) })); };
  const tick = async () => { await act(async () => frame(performance.now())); };
  return { event, tick, handoff, transcript, track, slot };
}
const delegate = { type: "delegation.created", item: { id: "d1", type: "delegation", target: "client", content: [{ type: "input_text", text: "short request" }] } };

it("actual frontend serializes final persistence and rechecks an interrupt before durable delivery", async () => {
  let finish!: (value: unknown) => void;
  const call = await connect(() => new Promise((resolve) => { finish = resolve; }));
  await call.event({ type: "input_audio_buffer.speech_started", item_id: "u1" });
  await call.event({ type: "conversation.input_transcript.delta", item_id: "u1", delta: "fix" });
  await call.event(delegate);
  expect(call.handoff).not.toHaveBeenCalled();
  await call.event({ type: "input_audio_buffer.speech_stopped", item_id: "u1" });
  await call.tick();
  expect(call.handoff).not.toHaveBeenCalled(); // no invented turn-final from silence
  await call.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "fix the full request" });
  await waitFor(() => expect(call.transcript).toHaveBeenCalledOnce());
  await call.event({ type: "input_audio_buffer.speech_started", item_id: "u2" });
  await act(async () => finish({ accepted: true }));
  expect(call.handoff).not.toHaveBeenCalled();
  await call.event({ type: "input_audio_buffer.speech_stopped", item_id: "u1" }); // late prior stop
  await call.tick();
  expect(call.handoff).not.toHaveBeenCalled();
  await call.event({ type: "input_audio_buffer.speech_stopped", item_id: "u2" });
  await waitFor(() => expect(call.handoff).toHaveBeenCalledOnce());
  expect(call.handoff).toHaveBeenCalledWith({ callId: "call", handoffId: "d1", utteranceId: "u1", text: "fix the full request" });
});

it("hangup while final persistence is pending never delivers later work", async () => {
  let finish!: (value: unknown) => void;
  const call = await connect(() => new Promise((resolve) => { finish = resolve; }));
  await call.event({ type: "conversation.input_transcript.delta", item_id: "u1", delta: "fix" });
  await call.event(delegate);
  await call.event({ type: "turn.done", turn: { id: "u1", role: "user", transcript: "fix all of this" } });
  await waitFor(() => expect(call.transcript).toHaveBeenCalledOnce());
  cleanup();
  await act(async () => finish({ accepted: true }));
  expect(call.handoff).not.toHaveBeenCalled();
  expect(call.track.stop).toHaveBeenCalledOnce();
});

it("accepts an identified host final for this call while ignoring host deltas and unrelated calls", async () => {
  const call = await connect();
  await call.event({ type: "conversation.input_transcript.delta", item_id: "u1", delta: "fix" });
  await call.event(delegate);
  await call.slot.emitRealtime("voice-call-event", { kind: "transcript", callId: "another", itemId: "u1", role: "user", text: "wrong call", final: true });
  await call.slot.emitRealtime("voice-call-event", { kind: "transcript", callId: "call", itemId: "u1", role: "user", text: "unfinished", final: false });
  expect(call.handoff).not.toHaveBeenCalled();
  await call.slot.emitRealtime("voice-call-event", { kind: "transcript", callId: "call", itemId: "u1", role: "user", text: "complete request from host", final: true });
  await waitFor(() => expect(call.handoff).toHaveBeenCalledOnce());
  expect(call.handoff).toHaveBeenCalledWith({ callId: "call", handoffId: "d1", utteranceId: "u1", text: "complete request from host" });
});

it("does not deliver a handoff when final transcript persistence fails", async () => {
  const call = await connect(async () => ({ accepted: false }));
  await call.event({ type: "conversation.input_transcript.delta", item_id: "u1", delta: "fix" });
  await call.event(delegate);
  await call.event({ type: "turn.done", turn: { id: "u1", role: "user", transcript: "complete request" } });
  await call.tick();
  expect(call.handoff).not.toHaveBeenCalled();
});
