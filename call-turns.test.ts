import { describe, expect, it } from "vitest";
import { InputActivity, resolvePhase, smoothAudioLevel } from "./audio";
import { parseRealtimeVoiceEvent } from "./realtime-events";
import { voicePresenceRenderPolicy } from "./src/presence/voicePresenceRenderPolicy";

describe("presentation activity, separate from audio turn semantics", () => {
  it("keeps quiet varying speech listening while the backing agent works", () => {
    const detector = new InputActivity();
    let level = 0;
    for (const signal of [0.028, 0.015, 0.021, 0.008, 0.024, 0.009]) {
      level = smoothAudioLevel(level, signal, 60);
      expect(resolvePhase({ connected: true, micLevel: level, sinceOutputMs: null,
        agentBusy: true, inputSpeech: detector.sample(level, 60) })).toBe("listening");
    }
    for (let i = 0; i < 50; i++) {
      level = smoothAudioLevel(level, 0.001, 20);
      detector.sample(level, 20);
    }
    expect(detector.sample(level, 20)).toBe(false);
  });
  it("gives provider speech priority over quiet levels and stale output during interruption", () => {
    const base = { connected: true, micLevel: 0.001, sinceOutputMs: 100, agentBusy: true };
    expect(resolvePhase({ ...base, inputSpeech: true })).toBe("listening");
    expect(resolvePhase({ ...base, inputSpeech: false })).toBe("speaking");
    expect(resolvePhase({ ...base, sinceOutputMs: 900, inputSpeech: false })).toBe("thinking");
    expect(resolvePhase({ ...base, sinceOutputMs: null, inputSpeech: true, muted: true })).toBe("muted");
    expect(resolvePhase({ ...base, connected: false, inputSpeech: true })).toBe("muted");
  });
  it("has the same envelope after equal elapsed time at different frame rates", () => {
    let fast = 0;
    let slow = 0;
    for (let i = 0; i < 60; i++) fast = smoothAudioLevel(fast, 0.1, 1000 / 60);
    for (let i = 0; i < 12; i++) slow = smoothAudioLevel(slow, 0.1, 1000 / 12);
    expect(fast).toBeCloseTo(slow, 10);
  });
  it("parses documented speech boundaries, but never promotes a transcript fragment to completion", () => {
    expect(parseRealtimeVoiceEvent(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "u1" })))
      .toEqual({ type: "input.speech", active: true, itemId: "u1" });
    expect(parseRealtimeVoiceEvent(JSON.stringify({ type: "input_audio_buffer.speech_stopped", item_id: "u1" })))
      .toEqual({ type: "input.speech", active: false, itemId: "u1" });
    expect(parseRealtimeVoiceEvent(JSON.stringify({ type: "conversation.input_transcript.delta", item_id: "u1", delta: "half a" }))?.type)
      .toBe("transcript.delta");
  });
  it("animates software-rendered speech within the degraded budget while respecting motion and visibility", () => {
    const base = { phase: "listening" as const, documentVisible: true, presented: true,
      reducedMotion: false, softwareRenderer: true, performanceMode: "normal" as const };
    expect(voicePresenceRenderPolicy(base)).toBe("degraded");
    expect(voicePresenceRenderPolicy({ ...base, reducedMotion: true })).toBe("static");
    expect(voicePresenceRenderPolicy({ ...base, documentVisible: false })).toBe("paused");
  });
});
