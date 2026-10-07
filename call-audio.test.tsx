// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function connect(persist: () => Promise<unknown> = async () => ({ accepted: true }), suspended = false, connecting = false) {
  let channel!: { onmessage: ((event: { data: string }) => void) | null };
  let frame!: FrameRequestCallback;
  let peer!: { connectionState: string; onconnectionstatechange: (() => void) | null; ontrack?: (event: { track: unknown }) => void };
  const track = { enabled: true, stop: vi.fn() };
  const mic = { getAudioTracks: () => [track], getTracks: () => [track] };
  const contexts: Array<{ close: ReturnType<typeof vi.fn>; notes: Array<{ onended: (() => void) | null; frequency: { setValueAtTime: ReturnType<typeof vi.fn> } }> }> = [];
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => mic } });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("AudioContext", class {
    close = vi.fn(async () => {});
    notes: Array<{ onended: (() => void) | null; frequency: { setValueAtTime: ReturnType<typeof vi.fn> } }> = [];
    constructor() { contexts.push(this); }
    currentTime = 0;
    destination = {};
    state = suspended ? "suspended" : "running";
    resume() { return suspended ? new Promise(() => {}) : Promise.resolve(); }
    createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0) }; }
    createMediaStreamSource() { return { connect: vi.fn() }; }
    createOscillator() {
      const node = { onended: null as (() => void) | null, frequency: { setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() };
      this.notes.push(node);
      return node;
    }
    createGain() { return { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() }; }
  });
  vi.stubGlobal("MediaStream", class { addTrack() {} });
  vi.stubGlobal("RTCPeerConnection", class {
    iceGatheringState = "complete";
    connectionState = connecting ? "connecting" : "connected";
    onconnectionstatechange: (() => void) | null = null;
    constructor() { peer = this; }
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
  let active = { callId: "call", threadId: "owner", threadTitle: "Owner", state: "active", transportOwner: true };
  const slot = renderSlot(app.appOverlays.find((slot) => slot.id === "voice-transport")!, {}, {
    rpc: {
      active_call: () => active,
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
  const changePeer = async (state: string) => { await act(async () => { peer.connectionState = state; peer.onconnectionstatechange?.(); }); };
  const replaceCall = async (callId = "next-call") => {
    const count = contexts.length + 1;
    active = { ...active, callId };
    await slot.emitRealtime("voice-call-changed", { threadId: active.threadId });
    await waitFor(() => expect(contexts).toHaveLength(count));
  };
  const remoteTrack = async () => { await act(async () => peer.ontrack?.({ track: {} })); };
  return { remoteTrack, event, tick, handoff, transcript, track, slot, contexts, changePeer, replaceCall, getActive: () => active, finishConnecting: () => changePeer("connected") };
}
const delegate = { type: "delegation.created", item: { id: "d1", type: "delegation", target: "client", content: [{ type: "input_text", text: "inspect the repository and fix all four voice issues" }] } };

it("delivers the explicit task when captions never produce a matching final identity", async () => {
  const call = await connect();
  await call.event({ type: "conversation.input_transcript.delta", delta: "inspect" });
  await call.slot.emitRealtime("voice-call-event", { kind: "transcript", callId: "call", itemId: null, role: "user", text: "inspect the repository", final: true });
  await call.event(delegate);
  await waitFor(() => expect(call.handoff).toHaveBeenCalledOnce());
  expect(call.handoff).toHaveBeenCalledWith({ callId: "call", handoffId: "d1", utteranceId: null, text: "inspect the repository and fix all four voice issues" });
});

it("caption persistence cannot block a complete explicit delegation", async () => {
  const call = await connect(() => new Promise(() => {}));
  await call.event({ type: "turn.done", turn: { id: "u1", role: "user", transcript: "full caption" } });
  await call.event(delegate);
  await waitFor(() => expect(call.handoff).toHaveBeenCalledOnce());
});

it("ordinary speech and turn-final never start durable work by themselves", async () => {
  const call = await connect();
  await call.event({ type: "conversation.input_transcript.delta", delta: "a question" });
  await call.event({ type: "turn.done", turn: { id: "u1", role: "user", transcript: "a question" } });
  await call.tick();
  expect(call.handoff).not.toHaveBeenCalled();
});

it("ignores late channel events after hangup", async () => {
  const call = await connect();
  cleanup();
  await call.event(delegate);
  expect(call.handoff).not.toHaveBeenCalled();
  expect(call.track.stop).toHaveBeenCalledOnce();
});

function mountCaption(refetch: () => unknown = () => ({ callId: "call", threadId: "owner", threadTitle: "Owner", state: "active", transportOwner: true })) {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
  window.matchMedia = vi.fn(() => ({ matches: false })) as unknown as typeof window.matchMedia;
  return renderSlot(app.composerCustomizations[0]!.banners![0]!, {}, {
    context: { projectId: "project", threadId: "owner" },
    rpc: { active_call: refetch },
  });
}

it("uses server call state in a viewer and never offers control of another device's microphone", async () => {
  let active = { callId: "call", threadId: "owner", threadTitle: "Owner", state: "provisioning", transportOwner: false };
  const viewer = mountCaption(() => active);
  await waitFor(() => expect(viewer.getByRole("status").textContent).toBe("Joining call on another device…"));
  active = { ...active, state: "active" };
  await viewer.emitRealtime("voice-call-changed", { threadId: "owner" });
  await waitFor(() => expect(viewer.getByRole("status").textContent).toBe("Call active on another device"));
  expect(viewer.getByRole("button", { name: "Microphone controlled on call device" }).hasAttribute("disabled")).toBe(true);
  expect(viewer.queryByRole("button", { name: "Mute microphone" })).toBeNull();
});

it("assembles the actual nullable-ID host parts without a late user final replacing streaming agent words", async () => {
  const call = await connect();
  const tray = mountCaption();
  const host = async (role: string, text: string, final = false) => {
    await call.slot.emitRealtime("voice-call-event", { callId: "call", kind: "transcript", itemId: null, role, text, final });
  };
  await host("user", "Please inspect");
  await host("assistant", "I can ");
  await host("user", "Please inspect the repository", true);
  await host("assistant", "pass that request.");
  expect(tray.getByText("I can pass that request.")).toBeTruthy();
  expect(call.transcript).not.toHaveBeenCalled(); // no invented persisted turn
  await call.slot.emitRealtime("voice-call-event", { callId: "wrong", kind: "transcript", itemId: null, role: "assistant", text: "wrong call", final: true });
  expect(tray.queryByText("wrong call")).toBeNull();
  await host("assistant", "I can pass that request.", true);
  await host("user", "Another ");
  await host("user", "question");
  expect(tray.getByText("Another question")).toBeTruthy();
});

it("keeps the active tray and caption through a composer remount while lookup is still pending", async () => {
  const call = await connect();
  let tray = mountCaption();
  await call.slot.emitRealtime("voice-call-event", { callId: "call", kind: "transcript", itemId: null, role: "user", text: "Still speaking", final: false });
  expect(tray.getByText("Still speaking")).toBeTruthy();
  tray.unmount();
  tray = mountCaption(() => new Promise(() => {}));
  expect(tray.getByLabelText("Call controls")).toBeTruthy();
  expect(tray.getByText("Still speaking")).toBeTruthy();
});

it("a replacement call clears the old caption and error even without an intermediate no-call lookup", async () => {
  const call = await connect();
  const tray = mountCaption(call.getActive);
  await call.slot.emitRealtime("voice-call-event", { callId: "call", kind: "transcript", itemId: null, role: "user", text: "Previous call words", final: false });
  await call.event({ type: "error", error: { message: "Previous call failed" } });
  expect(tray.getByText("Previous call failed")).toBeTruthy();
  await call.replaceCall();
  await waitFor(() => expect(tray.queryByText("Previous call failed")).toBeNull());
  expect(tray.queryByText("Previous call words")).toBeNull();
  await call.slot.emitRealtime("voice-call-event", { callId: "next-call", kind: "transcript", itemId: null, role: "user", text: "New call words", final: false });
  expect(tray.getByText("New call words")).toBeTruthy();
  await call.slot.emitRealtime("voice-call-event", { callId: "call", kind: "transcript", itemId: null, role: "assistant", text: "Late old call words", final: true });
  expect(tray.queryByText("Late old call words")).toBeNull();
});

it("a delayed microphone failure from an ended call cannot replace the new connected call state", async () => {
  const call = await connect();
  const tray = mountCaption(call.getActive);
  let rejectCapture!: (error: Error) => void;
  vi.spyOn(navigator.mediaDevices, "getUserMedia").mockImplementationOnce(() =>
    new Promise<MediaStream>((_, reject) => { rejectCapture = reject; }),
  );
  await call.replaceCall("pending-call");
  await call.replaceCall("latest-call");
  await waitFor(() => expect(tray.getByText("Listening for you…")).toBeTruthy());
  await call.tick();
  const status = tray.getByRole("status").textContent;
  await act(async () => rejectCapture(new Error("Old capture permission failed")));
  expect(tray.queryByText("Old capture permission failed")).toBeNull();
  expect(tray.getByRole("status").textContent).toBe(status);
});

it("a delayed playback failure from an ended call cannot replace the new connected call state", async () => {
  const call = await connect();
  const tray = mountCaption(call.getActive);
  let rejectPlayback!: (error: Error) => void;
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(() =>
    new Promise<void>((_, reject) => { rejectPlayback = reject; }),
  );
  await call.remoteTrack();
  await call.replaceCall();
  await waitFor(() => expect(tray.getByText("Listening for you…")).toBeTruthy());
  await call.tick();
  const status = tray.getByRole("status").textContent;
  await act(async () => rejectPlayback(new Error("Old playback blocked")));
  expect(tray.queryByText("Playback was blocked: Old playback blocked")).toBeNull();
  expect(tray.getByRole("status").textContent).toBe(status);
});

it("does not duplicate direct-channel captions when the host relay carries the same words", async () => {
  const call = await connect();
  const tray = mountCaption();
  await call.event({ type: "conversation.input_transcript.delta", delta: "Please " });
  await call.slot.emitRealtime("voice-call-event", { callId: "call", kind: "transcript", itemId: null, role: "user", text: "Please ", final: false });
  await call.event({ type: "conversation.input_transcript.delta", delta: "inspect" });
  await call.slot.emitRealtime("voice-call-event", { callId: "call", kind: "transcript", itemId: null, role: "user", text: "inspect", final: false });
  expect(tray.getByText("Please inspect")).toBeTruthy();
});

it("starts microphone capture and negotiation even when context.resume is waiting for permission or a gesture", async () => {
  const call = await connect(undefined, true);
  await call.event(delegate);
  expect(call.handoff).toHaveBeenCalledOnce();
});

it("does not invite speech just because SDP negotiation completed before the media path connects", async () => {
  const call = await connect(undefined, false, true);
  const tray = mountCaption();
  expect(tray.queryByText("Listening for you…")).toBeNull();
  expect(tray.getByRole("status").textContent).toBe("Joining call…");
  expect(call.contexts[0]!.notes).toHaveLength(0);
  await call.finishConnecting();
  await waitFor(() => expect(tray.getByText("Listening for you…")).toBeTruthy());
  expect(call.contexts[0]!.notes).toHaveLength(2);
});

it("plays connection once across duplicate events, transient recovery, caption remount and phase changes", async () => {
  const call = await connect();
  expect(call.contexts[0]!.notes).toHaveLength(2);
  await call.finishConnecting();
  await call.changePeer("disconnected");
  await call.changePeer("connecting");
  await call.finishConnecting();
  const tray = mountCaption();
  tray.unmount();
  mountCaption();
  await call.tick();
  await call.slot.emitRealtime("voice-call-event", { kind: "closed", callId: "another-call" });
  expect(call.contexts).toHaveLength(1);
  expect(call.contexts[0]!.notes).toHaveLength(2);
});

it("plays end once for confirmed closure then hangup, and lets the end finish after media cleanup", async () => {
  const call = await connect();
  const context = call.contexts[0]!;
  await call.slot.emitRealtime("voice-call-event", { kind: "closed", callId: "call" });
  await call.slot.emitRealtime("voice-call-event", { kind: "closed", callId: "call" });
  await call.changePeer("failed");
  expect(context.notes).toHaveLength(4);
  cleanup();
  expect(call.track.stop).toHaveBeenCalledOnce();
  expect(context.close).not.toHaveBeenCalled();
  for (const note of context.notes.slice(2)) note.onended?.();
  await waitFor(() => expect(context.close).toHaveBeenCalledOnce());
  expect(context.notes).toHaveLength(4);
});

it("does not chime for an unsuccessful call, or queue tones in a permission-suspended context", async () => {
  const call = await connect(undefined, false, true);
  await call.changePeer("failed");
  cleanup();
  expect(call.contexts[0]!.notes).toHaveLength(0);
  expect(call.contexts[0]!.close).toHaveBeenCalledOnce();
  const blocked = await connect(undefined, true);
  await blocked.event(delegate);
  expect(blocked.handoff).toHaveBeenCalledOnce();
  cleanup();
  expect(blocked.contexts[0]!.notes).toHaveLength(0);
  expect(blocked.contexts[0]!.close).toHaveBeenCalledOnce();
});
