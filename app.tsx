import { Component, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { callStatusLabel, type CallConnectionState } from "./call-presentation";
import { parseRealtimeVoiceEvent, REALTIME_DATA_CHANNEL, type RealtimeVoiceEvent } from "./realtime-events";
import { VoicePresence } from "./src/presence/VoicePresence";
import { voicePhaseStyle } from "./src/presence/voicePresenceTheme";
import { deriveVoicePresenceIdentity } from "./src/presence/voicePresenceIdentity";
import type { VoicePresencePhase } from "./src/presence/voicePresenceTheme";
import type { VoicePresenceIdentity } from "./src/presence/voicePresenceIdentity";
import { InputActivity, resolvePhase, rmsLevel, smoothAudioLevel } from "./audio";
import { CallHandoffQueue } from "./call-turns";
import { usePortalScopeProps } from "./lib/portal-scope";

const CLIENT_INSTANCE_STORAGE_KEY = "bb.voice-presence.client-instance";
const CLIENT_INSTANCE_ID = (() => {
  try {
    const existing = window.sessionStorage.getItem(CLIENT_INSTANCE_STORAGE_KEY);
    if (existing !== null && existing !== "") return existing;
    const created = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `voice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.sessionStorage.setItem(CLIENT_INSTANCE_STORAGE_KEY, created);
    return created;
  } catch {
    return `voice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
})();

/** Above this the remote track is carrying a voice, not room tone. */
const SPEAKING_THRESHOLD = 0.045;

/**
 * Keeps a failure inside the orb from taking the whole plugin surface down.
 *
 * The presence renderer takes a WebGL context; if the browser refuses one its
 * `getContext` returns null and the component throws. Unhandled, that unmounts
 * this overlay, and the symptom is that pressing call makes everything vanish.
 */
class OrbBoundary extends Component<
  { readonly children: ReactNode; readonly fallback: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * The orb without WebGL: same theme tokens and phase colours, so a machine that
 * cannot give a GL context still gets an orb rather than a hole.
 */
export function CssOrb({ phase, identity, activityLevel }: { phase: VoicePresencePhase; identity: VoicePresenceIdentity; activityLevel: { current: number } }) {
  const orb = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    const tick = () => {
      const level = Math.max(0, Math.min(1, activityLevel.current));
      if (orb.current !== null) {
        orb.current.style.transform = reduced.matches ? "none" : `scale(${0.78 + level * 0.22})`;
        orb.current.style.opacity = String(phase === "muted" ? 0.6 : 0.7 + level * 0.3);
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [activityLevel, phase]);
  return (
    <div
      aria-hidden="true"
      ref={orb}
      className="size-full motion-safe:transition-transform motion-safe:duration-100"
      style={{
        ...voicePhaseStyle(phase, identity),
        background: "radial-gradient(circle at 34% 32%, var(--voice-highlight) 0%, var(--voice-accent) 46%, transparent 72%)",
        opacity: phase === "muted" ? 0.6 : 0.95,
      }}
    />
  );
}

/** A telephone handset - a call, not a microphone. */
function PhoneIcon(): ReactNode {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z" />
    </svg>
  );
}

function MicrophoneIcon({ muted }: { muted: boolean }): ReactNode {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 5.12 2.12A3 3 0 0 0 15 12V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-12 4.9M5 10v2a7 7 0 0 0 7 7v3M8 22h8" />
      {muted ? <path d="m3 3 18 18" /> : null}
    </svg>
  );
}

/**
 * The call that is actually up, from the server rather than from the route.
 *
 * An app overlay has no reliable thread context, so looking a call up by
 * `useBbContext().threadId` is what made the orb render nothing while the
 * composer button correctly went away.
 */
function useActiveCall() {
  const rpc = useRpc<typeof rpcContract>();
  const [active, setActive] = useState<{
    callId: string | null;
    threadId: string | null;
    threadTitle: string | null;
    state: string | null;
    transportOwner: boolean;
  }>({ callId: null, threadId: null, threadTitle: null, state: null, transportOwner: false });
  const request = useRef(0);

  const refetch = useCallback(() => {
    const token = ++request.current;
    rpc.call("active_call", { clientInstanceId: CLIENT_INSTANCE_ID }).then((result) => {
      if (token === request.current) setActive(result);
    }, () => undefined);
  }, [rpc]);

  useEffect(() => {
    refetch();
    return () => { ++request.current; };
  }, [refetch]);

  useRealtime("voice-call-changed", useCallback(() => refetch(), [refetch]));

  return { rpc, active, refetch };
}

/** Wait for ICE gathering, or send what we have. */
function waitForIce(peer: RTCPeerConnection, timeoutMs = 3_000): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      peer.removeEventListener("icegatheringstatechange", onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (peer.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    peer.addEventListener("icegatheringstatechange", onChange);
  });
}

interface LiveAudio {
  readonly activity: { current: number };
  readonly phase: VoicePresencePhase;
  readonly error: string | null;
  readonly transcript: string;
  readonly connection: CallConnectionState;
  readonly muted: boolean;
  readonly setMuted: (muted: boolean) => void;
}

/**
 * The live call over WebRTC.
 *
 * Mic into the peer connection, remote track straight into an AnalyserNode —
 * which gives playback and the output level the `speaking` phase needs.
 */
function useCallAudio(
  callId: string | null,
  threadId: string | null,
  agentBusy: boolean,
): LiveAudio {
  const rpc = useRpc<typeof rpcContract>();
  // Read through a ref. If the rpc client's identity changes, an effect that
  // depends on it tears the peer connection down and renegotiates mid-call — the
  // media log showed exactly that, as `closed` between two live reports.
  const rpcRef = useRef(rpc);
  useEffect(() => {
    rpcRef.current = rpc;
  }, [rpc]);
  // Same reasoning for the thread: it comes from a call lookup that can flip
  // while refetching, and a flip renegotiated the whole connection.
  const threadRef = useRef(threadId);
  useEffect(() => {
    threadRef.current = threadId;
  }, [threadId]);
  const activity = useRef(0);
  const micRef = useRef<MediaStream | null>(null);
  const [phase, setPhase] = useState<VoicePresencePhase>("muted");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [connection, setConnection] = useState<CallConnectionState>("disconnected");
  const [muted, setMutedState] = useState(false);
  const mutedRef = useRef(false);
  const receiveHostFinal = useRef<((event: RealtimeVoiceEvent) => void) | null>(null);
  // Codex also relays finalized transcripts through the host signal path. Use
  // its explicit item identity if the direct channel final arrives late or is
  // absent; never promote a host delta to a completed user utterance.
  useRealtime("voice-call-event", useCallback((payload: unknown) => {
    const event = payload as { callId?: string; kind?: string; final?: boolean; itemId?: string | null; role?: string; text?: string } | null;
    if (event?.callId !== callId || event.kind !== "transcript" || event.final !== true ||
      typeof event.itemId !== "string" || event.itemId.length === 0 ||
      typeof event.text !== "string" || event.text.trim() === "" ||
      (event.role !== "user" && event.role !== "assistant")) return;
    receiveHostFinal.current?.({ type: "transcript.done", itemId: event.itemId, role: event.role, text: event.text });
  }, [callId]));

  const setMuted = useCallback((next: boolean) => {
    mutedRef.current = next;
    setMutedState(next);
    for (const track of micRef.current?.getAudioTracks() ?? []) track.enabled = !next;
  }, []);

  // Read through a ref, NOT through the effect's dependencies. `agentBusy`
  // changes every couple of seconds, and depending on it directly tore the whole
  // peer connection down and rebuilt it on each poll — which reset the phase to
  // `muted` continuously and made the orb look like it had vanished.
  const agentBusyRef = useRef(agentBusy);
  useEffect(() => {
    agentBusyRef.current = agentBusy;
  }, [agentBusy]);

  useEffect(() => {
    if (callId === null || threadId === null) {
      activity.current = 0;
      setPhase("muted");
      setError(null);
      setTranscript("");
      setConnection("disconnected");
      setMuted(false);
      return;
    }

    setPhase("thinking");
    setConnection("connecting");

    let disposed = false;
    let mic: MediaStream | null = null;
    let context: AudioContext | null = null;
    let frame: number | null = null;
    let peerRef: RTCPeerConnection | null = null;
    let mediaTimer: number | null = null;
    let micLevel = 0;
    let outputLevel = 0;
    let inputSpeech: boolean | null = null;
    let speechItemId: string | null = null;
    let inputActive = false;
    let lastOutputAt: number | null = null;
    let previousTick = performance.now();
    const inputActivity = new InputActivity();
    const handoffs = new CallHandoffQueue();
    // Persist a final caption before delivering a handoff that references it.
    let persistence: Promise<unknown> = Promise.resolve();
    const reportError = (cause: unknown) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
    };
    const deliver = (request: { id: string; utteranceId: string | null; text: string }) => {
      persistence = persistence.then(async () => {
        if (disposed) return;
        if (inputSpeech === true && !mutedRef.current) {
          handoffs.defer(request);
          return;
        }
        const result = await rpcRef.current.call("call_handoff", {
          callId, handoffId: request.id, utteranceId: request.utteranceId, text: request.text,
        });
        if (!result.ok) throw new Error("The voice request could not be handed to the thread.");
      }).catch(reportError);
    };
    const flushHandoffs = () => {
      // Only an explicit provider boundary holds a finalized request. Local
      // energy is presentation, not a reliable turn boundary or a work veto.
      for (const request of handoffs.ready(inputSpeech === true && !mutedRef.current)) deliver(request);
    };
    const resumeOnGestureRef: { current: (() => void) | null } = { current: null };

    const start = async () => {
      try {
        if (typeof RTCPeerConnection === "undefined") {
          setError("This browser has no WebRTC, which the call transport needs.");
          setConnection("failed");
          return;
        }
        context = new AudioContext();
        // Browsers create an AudioContext SUSPENDED until a gesture. A suspended
        // context plays nothing and leaves both analysers at zero — which is why
        // there was no voice out and why the orb never reacted to anything.
        if (context.state === "suspended") {
          await context.resume().catch(() => undefined);
        }
        const resumeOnGesture = () => {
          if (context !== null && context.state === "suspended") {
            void context.resume().catch(() => undefined);
          }
        };
        resumeOnGestureRef.current = resumeOnGesture;
        window.addEventListener("pointerdown", resumeOnGesture);
        window.addEventListener("keydown", resumeOnGesture);
        // One report per call: proves microphone audio is leaving and model audio
        // is arriving, without putting telemetry in the UI.
        mediaTimer = window.setTimeout(() => {
          void peer
            ?.getStats()
            .then((report) => {
              let bytesOut = 0;
              let bytesIn = 0;
              report.forEach((entry) => {
                const row = entry as { type?: string; kind?: string; bytesSent?: number; bytesReceived?: number };
                if (row.type === "outbound-rtp" && row.kind === "audio") bytesOut += row.bytesSent ?? 0;
                if (row.type === "inbound-rtp" && row.kind === "audio") bytesIn += row.bytesReceived ?? 0;
              });
              return rpcRef.current.call("call_media", {
                callId,
                bytesOut,
                bytesIn,
                audioContext: context?.state ?? "unknown",
              });
            })
            .catch(() => undefined);
        }, 12_000);
        mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (disposed) return;
        micRef.current = mic;
        for (const track of mic.getAudioTracks()) track.enabled = !mutedRef.current;

        // Mic level for `listening`. Deliberately not routed to the speakers.
        const micAnalyser = context.createAnalyser();
        micAnalyser.fftSize = 1024;
        context.createMediaStreamSource(mic).connect(micAnalyser);
        const micSamples = new Float32Array(micAnalyser.fftSize);

        const peer = new RTCPeerConnection({
          // A peer connection to a remote realtime endpoint needs a way to learn
          // its own reachable address; without STUN the client can produce no
          // usable candidate and the media path never comes up.
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        peerRef = peer;
        peer.onconnectionstatechange = () => {
          if (disposed) return;
          if (peer.connectionState === "connected") {
            setConnection("connected");
          } else if (peer.connectionState === "failed") {
            setConnection("failed");
            setError("The call connection failed.");
          } else if (
            peer.connectionState === "disconnected" ||
            peer.connectionState === "closed"
          ) {
            setConnection("disconnected");
          } else {
            setConnection("connecting");
          }
        };
        for (const track of mic.getTracks()) peer.addTrack(track, mic);
        // The realtime events channel the app-server's webrtc transport expects
        // alongside audio.
        // The realtime events channel. Raw provider events arrive here, and they
        // are the only place a spoken turn is marked complete — ported from
        // `VoiceSessionController`'s normalizer.
        const events = peer.createDataChannel(REALTIME_DATA_CHANNEL);
        let fallbackTranscriptSequence = 0;
        const transcriptDrafts = new Map<
          "user" | "assistant",
          { itemId: string; text: string }
        >();
        const effectiveItemId = (role: "user" | "assistant", rawItemId: string): string => {
          if (!rawItemId.startsWith("live-")) return rawItemId;
          return transcriptDrafts.get(role)?.itemId
            ?? `live-${role}:${++fallbackTranscriptSequence}`;
        };
        const receive = (parsed: RealtimeVoiceEvent) => {
          if (disposed) return;
          if (parsed.type === "input.speech") {
            if (!parsed.active && speechItemId !== null && parsed.itemId !== speechItemId) return;
            if (parsed.active) {
              speechItemId = parsed.itemId;
              const stableItemId = effectiveItemId("user", parsed.itemId);
              if (transcriptDrafts.get("user")?.itemId !== stableItemId) {
                transcriptDrafts.set("user", { itemId: stableItemId, text: "" });
              }
              handoffs.draft(stableItemId);
            }
            inputSpeech = parsed.active;
            inputActive = parsed.active && !mutedRef.current;
            // An interruption must not leave a stale output hold on screen.
            if (inputActive) lastOutputAt = null;
            flushHandoffs();
            return;
          }
          if (parsed.type === "handoff") {
            const request = handoffs.request(parsed.id, parsed.text, inputSpeech === true && !mutedRef.current);
            if (request !== null) deliver(request);
            return;
          }
          if (parsed.type === "error") {
            setError(parsed.message);
            return;
          }
          if (parsed.type === "transcript.done") {
            setTranscript(parsed.text);
            const stableItemId = effectiveItemId(parsed.role, parsed.itemId);
            if (transcriptDrafts.get(parsed.role)?.itemId === stableItemId) transcriptDrafts.delete(parsed.role);
            persistence = persistence.then(async () => {
              if (disposed) return;
              const result = await rpcRef.current.call("call_transcript", {
                callId,
                itemId: stableItemId,
                role: parsed.role,
                text: parsed.text,
              });
              if (!result.accepted) throw new Error("The spoken request could not be saved.");
              if (parsed.role === "user") {
                handoffs.finalize(stableItemId, parsed.text);
                flushHandoffs();
              }
            }).catch(reportError);
            return;
          }
          const current = transcriptDrafts.get(parsed.role);
          const stableItemId = effectiveItemId(parsed.role, parsed.itemId);
          const next = current?.itemId === stableItemId
            ? `${current.text}${parsed.text}`
            : parsed.text;
          transcriptDrafts.set(parsed.role, { itemId: stableItemId, text: next });
          if (parsed.role === "user") handoffs.draft(stableItemId);
          setTranscript(next);
        };
        receiveHostFinal.current = receive;
        events.onmessage = (event) => {
          const parsed = parseRealtimeVoiceEvent(String(event.data));
          if (parsed !== null) receive(parsed);
        };

        // Remote audio: played through an <audio> element, exactly as the
        // original does (`createAudioElement`, `playRemoteAudio`). Routing the
        // stream through WebAudio into the context destination is what produced a
        // call with no sound in it.
        const remoteAnalyser = context.createAnalyser();
        remoteAnalyser.fftSize = 1024;
        const remoteSamples = new Float32Array(remoteAnalyser.fftSize);
        const remote = new MediaStream();
        const remoteAudio = document.createElement("audio");
        remoteAudio.autoplay = true;
        peer.ontrack = (event) => {
          remote.addTrack(event.track);
          if (remoteAudio.srcObject !== remote) {
            remoteAudio.srcObject = remote;
          }
          void remoteAudio.play().catch((cause: unknown) => {
            // The original reports this as `client.playback-error`; surfacing it
            // beats a silent call.
            setError(
              `Playback was blocked: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
          });
          if (context === null) return;
          // Analyser for the orb's `speaking` phase only — not to destination, so
          // the voice is heard once rather than twice.
          const source = context.createMediaStreamSource(remote);
          source.connect(remoteAnalyser);
        };

        const offer = await peer.createOffer({ offerToReceiveAudio: true });
        await peer.setLocalDescription(offer);
        await waitForIce(peer);
        if (disposed) return;
        const localSdp = peer.localDescription?.sdp;
        if (localSdp === undefined || localSdp === "") {
          setError("Could not build a WebRTC offer.");
          setConnection("failed");
          return;
        }

        const negotiated = await rpcRef.current.call("call_offer", {
          threadId: threadRef.current ?? "",
          sdp: localSdp,
          clientInstanceId: CLIENT_INSTANCE_ID,
        });
        if (disposed) return;
        if (!negotiated.ok || negotiated.sdp === null) {
          setError(negotiated.detail ?? "The call could not be negotiated.");
          setConnection("failed");
          return;
        }
        await peer.setRemoteDescription({ type: "answer", sdp: negotiated.sdp });
        setConnection("connected");

        const tick = () => {
          if (disposed) return;
          micAnalyser.getFloatTimeDomainData(micSamples);
          remoteAnalyser.getFloatTimeDomainData(remoteSamples);
          const now = performance.now();
          const elapsedMs = now - previousTick;
          previousTick = now;
          micLevel = mutedRef.current ? 0 : smoothAudioLevel(micLevel, rmsLevel(micSamples), elapsedMs);
          outputLevel = smoothAudioLevel(outputLevel, rmsLevel(remoteSamples), elapsedMs);
          inputActive = !mutedRef.current && (inputSpeech ?? inputActivity.sample(micLevel, elapsedMs));
          if (outputLevel > SPEAKING_THRESHOLD) lastOutputAt = now;
          activity.current = Math.max(micLevel, outputLevel);
          flushHandoffs();
          setPhase(
            resolvePhase({
              connected: peer.connectionState === "connected",
              micLevel: mutedRef.current ? 0 : micLevel,
              inputSpeech: inputActive,
              muted: mutedRef.current,
              sinceOutputMs: lastOutputAt === null ? null : now - lastOutputAt,
              agentBusy: agentBusyRef.current,
            }),
          );
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        setError(detail);
        setPhase("thinking");
        setConnection("failed");
      }
    };

    void start();

    return () => {
      disposed = true;
      receiveHostFinal.current = null;
      window.removeEventListener("pointerdown", resumeOnGestureRef.current ?? (() => undefined));
      window.removeEventListener("keydown", resumeOnGestureRef.current ?? (() => undefined));
      if (frame !== null) cancelAnimationFrame(frame);
      if (mediaTimer !== null) window.clearTimeout(mediaTimer);
      for (const track of mic?.getTracks() ?? []) track.stop();
      if (micRef.current === mic) micRef.current = null;
      peerRef?.close();
      void context?.close().catch(() => undefined);
      activity.current = 0;
    };
    // Only the call id may restart the connection. `agentBusy`, `rpc` and
    // `threadId` are all read through refs so a re-render or a refetch cannot
    // tear down live audio.
  }, [callId]);

  return { activity, phase, error, transcript, connection, muted, setMuted };
}

const EMPTY_ACTIVITY = { current: 0 };
const EMPTY_LIVE_AUDIO: LiveAudio = {
  activity: EMPTY_ACTIVITY,
  phase: "muted",
  error: null,
  transcript: "",
  connection: "disconnected",
  muted: false,
  setMuted: () => undefined,
};
let liveAudioSnapshot: LiveAudio = EMPTY_LIVE_AUDIO;
const liveAudioListeners = new Set<() => void>();

function publishLiveAudio(next: LiveAudio): void {
  liveAudioSnapshot = next;
  for (const listener of liveAudioListeners) listener();
}

function useLiveAudioSnapshot(): LiveAudio {
  return useSyncExternalStore(
    (listener) => {
      liveAudioListeners.add(listener);
      return () => liveAudioListeners.delete(listener);
    },
    () => liveAudioSnapshot,
    () => EMPTY_LIVE_AUDIO,
  );
}

/** App-wide, invisible media owner. Composer banners may remount on navigation; the call must not. */
function VoiceTransport(): null {
  const { rpc, active } = useActiveCall();
  const [agentBusy, setAgentBusy] = useState(false);
  const inCall = active.callId !== null;
  const ownsTransport = inCall && active.transportOwner;
  const audio = useCallAudio(
    ownsTransport ? active.callId : null,
    ownsTransport ? active.threadId : null,
    agentBusy,
  );

  useEffect(() => publishLiveAudio(audio), [audio]);

  useEffect(() => {
    if (!ownsTransport || active.threadId === null) {
      setAgentBusy(false);
      return;
    }
    let cancelled = false;
    const tick = () => {
      if (active.threadId === null) return;
      rpc.call("call_activity", { threadId: active.threadId }).then(
        (result) => {
          if (!cancelled) setAgentBusy(result.agentBusy);
        },
        () => undefined,
      );
    };
    tick();
    const timer = window.setInterval(tick, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active.threadId, ownsTransport, rpc]);

  return null;
}

/**
 * The call button, in the composer's action row beside the microphone.
 * Renders nothing while a call is up — the orb owns that state.
 */
function CallButton(): ReactNode {
  const { threadId } = useBbContext();
  const navigate = useBbNavigate();
  const { active, rpc, refetch } = useActiveCall();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const gestureButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    // A mobile submit/recording gesture can change the composer layout before
    // its compatibility click arrives. Never inherit that gesture (or an old
    // cancelled press) just because the call button is now under the finger.
    const resetGesture = () => { gestureButton.current = null; };
    document.addEventListener("pointerdown", resetGesture, true);
    document.addEventListener("pointercancel", resetGesture, true);
    return () => {
      document.removeEventListener("pointerdown", resetGesture, true);
      document.removeEventListener("pointercancel", resetGesture, true);
    };
  }, []);

  const inCall = active.callId !== null;
  const ownsCall = inCall && active.threadId === threadId;

  if (threadId === null) return null;

  // A toggle, not a button that vanishes. While a call is up this is the hang-up
  // control, so there is always a way out of a call from where it started.
  return (
    <button
      type="button"
      disabled={busy}
      aria-label={ownsCall ? "End voice call" : inCall ? "Open active voice call" : "Start voice call"}
      title={
        actionError ?? (ownsCall
          ? "Hang up"
          : inCall
            ? `Open call on ${active.threadTitle ?? active.threadId ?? "another thread"}`
            : "Voice call")
      }
      aria-pressed={inCall}
      onPointerDown={(event) => {
        if (event.button === 0) gestureButton.current = event.currentTarget;
      }}
      onClick={(event) => {
        const pressedButton = gestureButton.current;
        gestureButton.current = null;
        if (event.detail > 0 && pressedButton !== event.currentTarget) {
          event.preventDefault();
          return;
        }
        if (inCall && !ownsCall && active.threadId !== null) {
          navigate.toThread(active.threadId);
          return;
        }
        setBusy(true);
        setActionError(null);
        const result = ownsCall
          ? rpc.call("call_end", { threadId })
          : rpc.call("call_start", { threadId, clientInstanceId: CLIENT_INSTANCE_ID });
        void result.then(refetch).catch((cause: unknown) => {
          setActionError(cause instanceof Error ? cause.message : String(cause));
        }).finally(() => setBusy(false));
      }}
      className={
        inCall
          ? "flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors disabled:opacity-50"
          : "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
      }
    >
      <PhoneIcon />
    </button>
  );
}

const COMPACT_COMPOSER_ACTION_TARGET =
  '[data-app-composer-role="primary"] [data-promptbox-compact] [data-promptbox-action-row] > [data-promptbox-standard-actions]';

/**
 * BB's public composer action slot is intentionally absent while the composer
 * is compact. Keep the call control in the control row anyway: this bridge
 * mounts only the existing icon into the compact row, before BB's native
 * mic/submit controls. It contributes no tray, banner, or idle chrome.
 */
function CompactCallButton(): ReactNode {
  const portalScope = usePortalScopeProps();
  const [mount, setMount] = useState<HTMLSpanElement | null>(null);

  useEffect(() => {
    let currentMount: HTMLSpanElement | null = null;

    const sync = () => {
      const target = document.querySelector<HTMLElement>(COMPACT_COMPOSER_ACTION_TARGET);
      if (target === currentMount?.parentElement) return;

      currentMount?.remove();
      currentMount = null;

      if (target !== null) {
        const next = document.createElement("span");
        next.dataset.voicePresenceCompactAction = "";
        next.className = "contents";
        target.prepend(next);
        currentMount = next;
      }
      setMount(currentMount);
    };

    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-promptbox-compact"],
    });
    return () => {
      observer.disconnect();
      currentMount?.remove();
    };
  }, []);

  if (mount === null) return null;
  return createPortal(
    <span {...portalScope} className="contents">
      <CallButton />
    </span>,
    mount,
  );
}

function VoiceOrb(): ReactNode {
  const route = useBbContext();
  const navigate = useBbNavigate();
  const { rpc, active } = useActiveCall();
  const [hostTranscript, setHostTranscript] = useState("");
  const [eventError, setEventError] = useState<string | null>(null);
  const [closedNotice, setClosedNotice] = useState<{
    threadId: string;
    title: string;
    status: "Call ended" | "Call disconnected";
    detail: string | null;
  } | null>(null);
  const lastActive = useRef<{ threadId: string; title: string } | null>(null);
  const transportClosed = useRef(false);

  const inCall = active.callId !== null;
  const threadId = active.threadId;
  const audio = useLiveAudioSnapshot();

  const end = useCallback(() => {
    if (threadId === null) return Promise.resolve();
    return rpc.call("call_end", { threadId }).then(() => undefined);
  }, [rpc, threadId]);

  const moveHere = useCallback(() => {
    if (active.callId === null || route.threadId === null) return Promise.resolve();
    return rpc.call("call_move", { callId: active.callId, toThreadId: route.threadId }).then(
      (result) => {
        if (!result.ok) setEventError(result.detail ?? "The call could not be moved.");
      },
    );
  }, [active.callId, route.threadId, rpc]);

  const reconnect = useCallback(() => {
    const owner = threadId ?? closedNotice?.threadId ?? null;
    if (owner === null) return Promise.resolve();
    setClosedNotice(null);
    return rpc.call("call_start", {
      threadId: owner,
      clientInstanceId: CLIENT_INSTANCE_ID,
    }).then(() => undefined);
  }, [closedNotice?.threadId, rpc, threadId]);

  useRealtime(
    "voice-call-event",
    useCallback((payload: unknown) => {
      const event = payload as {
        kind?: string;
        text?: string;
        final?: boolean;
        message?: string;
        reason?: string | null;
      };
      if (event.kind === "transcript" && typeof event.text === "string") {
        const text = event.text;
        setHostTranscript((current) => (event.final === true ? text : current + text));
      }
      if (event.kind === "error") setEventError(event.message ?? "Voice error");
      if (event.kind === "closed") {
        transportClosed.current = true;
        const previous = lastActive.current;
        if (previous !== null) {
          setClosedNotice({
            ...previous,
            status: "Call disconnected",
            detail: event.reason ?? "The voice connection closed.",
          });
        }
      }
    }, []),
  );

  useEffect(() => {
    if (inCall && threadId !== null) {
      lastActive.current = {
        threadId,
        title: active.threadTitle ?? threadId,
      };
      transportClosed.current = false;
      setClosedNotice(null);
      return;
    }
    const previous = lastActive.current;
    if (previous === null) return;
    lastActive.current = null;
    if (!transportClosed.current) {
      setClosedNotice({ ...previous, status: "Call ended", detail: null });
      const timer = window.setTimeout(() => setClosedNotice(null), 3_000);
      return () => window.clearTimeout(timer);
    }
  }, [active.threadTitle, inCall, threadId]);

  useEffect(() => {
    if (inCall) return;
    setHostTranscript("");
    setEventError(null);
  }, [inCall]);

  const displayThreadId = threadId ?? closedNotice?.threadId ?? null;
  if (displayThreadId === null) return null;

  const identity = deriveVoicePresenceIdentity({ threadId: displayThreadId });
  const problem = audio.error ?? eventError;
  const transcript = audio.transcript || hostTranscript;
  const awayFromOwner = route.threadId !== displayThreadId;
  const ownerTitle = active.threadTitle ?? closedNotice?.title ?? displayThreadId;
  const status = inCall
    ? callStatusLabel({
        serverState: active.state,
        connection: audio.connection,
        phase: audio.phase,
        problem,
      })
    : (closedNotice?.status ?? "Call ended");
  const detail = inCall ? problem : closedNotice?.detail ?? null;

  return <CallTray
    audio={audio} identity={identity} awayFromOwner={awayFromOwner} ownerTitle={ownerTitle}
    status={status} detail={detail} transcript={transcript} inCall={inCall}
    canMove={route.threadId !== null && inCall}
    open={() => navigate.toThread(displayThreadId)} moveHere={moveHere} end={end} reconnect={reconnect}
  />;
}

/** Plugin-owned tray shared by the live slot and isolated presentation checks. */
export function CallTray({ audio, identity, awayFromOwner, ownerTitle, status, detail, transcript,
  inCall, canMove, open, moveHere, end, reconnect }: {
  audio: LiveAudio; identity: VoicePresenceIdentity; awayFromOwner: boolean; ownerTitle: string;
  status: string; detail: string | null; transcript: string; inCall: boolean; canMove: boolean;
  open: () => void; moveHere: () => Promise<void>; end: () => Promise<void>; reconnect: () => Promise<void>;
}): ReactNode {
  return (
    <aside
      aria-label="Call controls"
      className="mx-auto mb-1.5 min-w-0 w-full max-w-xl border-b border-border pb-1.5 text-foreground"
    >
      <style>{`
        @keyframes voice-call-status-enter { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
        .voice-call-status { animation: voice-call-status-enter 180ms ease-out; }
        @media (prefers-reduced-motion: reduce) { .voice-call-status { animation: none; } }
      `}</style>
      <div className="flex min-w-0 min-h-12 flex-wrap items-center gap-2 px-1 py-1">
        <div
          className="relative size-11 shrink-0 overflow-hidden rounded-full border border-border/70 bg-background"
          style={voicePhaseStyle(audio.phase, identity)}
        >
          <OrbBoundary fallback={<CssOrb phase={audio.phase} identity={identity} activityLevel={audio.activity} />}>
            <VoicePresence phase={audio.phase} identity={identity} activityLevel={audio.activity} />
          </OrbBoundary>
        </div>
        <div className="min-w-0 flex-1 basis-32">
          <p className="truncate text-[11px] font-medium text-muted-foreground">
            {awayFromOwner ? `Call from ${ownerTitle}` : ownerTitle}
          </p>
          <p key={status} className="voice-call-status text-[11px] text-muted-foreground" role="status">{status}</p>
          <p
            className={`line-clamp-2 text-sm leading-snug [overflow-wrap:anywhere] ${detail === null ? "" : "text-destructive"}`}
            aria-live="polite"
            aria-atomic="true"
          >
            {detail ?? (transcript || (inCall ? "Listening for you…" : status))}
          </p>
        </div>
        {awayFromOwner ? (
          <div className="flex max-w-full flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={open}
              className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Open
            </button>
            {!canMove ? null : (
              <button
                type="button"
                onClick={() => void moveHere()}
                className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                Move here
              </button>
            )}
          </div>
        ) : null}
        {inCall ? (
          <div className="flex max-w-full flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => audio.setMuted(!audio.muted)}
              aria-label={audio.muted ? "Unmute microphone" : "Mute microphone"}
              aria-pressed={audio.muted}
              className="flex size-7 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <MicrophoneIcon muted={audio.muted} />
            </button>
            <button
              type="button"
              onClick={() => void end()}
              aria-label="End voice call"
              className="rounded-full border border-border px-2 py-0.5 text-xs font-medium text-foreground transition-colors hover:border-destructive hover:bg-destructive hover:text-destructive-foreground"
            >
              End
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void reconnect()}
            className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Reconnect
          </button>
        )}
      </div>
    </aside>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "voice-transport", component: VoiceTransport });
  app.slots.experimental_appOverlay({
    id: "voice-compact-call-action",
    component: CompactCallButton,
  });
  // In the composer's control row, immediately before BB's own microphone and
  // submit buttons.
  app.composer.customize({
    id: "voice-presence",
    scopes: ["thread"],
    actions: [{ id: "call", component: CallButton }],
    // The call tray participates in composer layout, so it never covers thread
    // output while the model is responding.
    banners: [{ id: "orb", chrome: "bare", component: VoiceOrb }],
  });
});
