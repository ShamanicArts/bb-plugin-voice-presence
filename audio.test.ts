// Tests for the audio plumbing.
import { describe, expect, it } from "vitest";
import {
  CHANNELS,
  CHUNK_SAMPLES,
  SAMPLE_RATE,
  decodeBase64,
  encodeBase64,
  floatToPcm16,
  pcm16ToFloat,
  resolvePhase,
  rmsLevel,
  smoothLevel,
} from "./audio";

describe("PCM conversion", () => {
  it("round-trips a signal within PCM16 resolution", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 0.25, -0.25, 0.999, -0.999]);
    const back = pcm16ToFloat(floatToPcm16(samples));
    for (let index = 0; index < samples.length; index += 1) {
      expect(Math.abs((back[index] ?? 0) - (samples[index] ?? 0))).toBeLessThan(0.001);
    }
  });

  it("clamps full scale without wrapping", () => {
    // The bug this guards: scaling by 0x8000 sends +1.0 to a large NEGATIVE
    // sample. Scaling by 0x7fff keeps the range symmetric instead, so negative
    // full scale lands on -32767 rather than -32768 — one LSB less range, and no
    // sign flip at the loudest possible input.
    const bytes = floatToPcm16(new Float32Array([1, -1, 2, -2]));
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(0, true)).toBe(32767);
    expect(view.getInt16(2, true)).toBe(-32767);
    // Out-of-range input clamps rather than wrapping.
    expect(view.getInt16(4, true)).toBe(32767);
    expect(view.getInt16(6, true)).toBe(-32767);
  });

  it("writes little-endian", () => {
    const bytes = floatToPcm16(new Float32Array([1]));
    expect([...bytes]).toEqual([0xff, 0x7f]);
  });

  it("reads odd-length byte input without throwing", () => {
    expect(pcm16ToFloat(new Uint8Array([0x00, 0x40, 0x7f])).length).toBe(1);
  });
});

describe("base64", () => {
  it("matches Node's encoder for every padding case", () => {
    for (let length = 0; length <= 8; length += 1) {
      const bytes = new Uint8Array(length).map((_, index) => ((index * 37 + length) % 256));
      expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    }
  });

  it("round-trips through the wire form", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect([...decodeBase64(encodeBase64(bytes))]).toEqual([...bytes]);
  });

  it("decodes the padded form it produced", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect([...decodeBase64("AQID")]).toEqual([...bytes]);
    expect([...decodeBase64("AQID")]).toEqual([...bytes]);
  });
});

describe("level", () => {
  it("is zero for silence and clamps a loud signal to one", () => {
    expect(rmsLevel(new Float32Array(480))).toBe(0);
    const loud = new Float32Array(480).map(() => 1);
    expect(rmsLevel(loud)).toBe(1);
  });

  it("is empty-safe", () => {
    expect(rmsLevel(new Float32Array(0))).toBe(0);
  });

  it("rises with amplitude", () => {
    const quiet = rmsLevel(new Float32Array(480).map((_, i) => 0.05 * Math.sin(i / 4)));
    const loud = rmsLevel(new Float32Array(480).map((_, i) => 0.5 * Math.sin(i / 4)));
    expect(loud).toBeGreaterThan(quiet);
  });

  it("smoothes with a faster attack than release, so the orb breathes", () => {
    // Jumping to full goes up quickly; falling back is slower.
    const up = smoothLevel(0, 1);
    const down = smoothLevel(1, 0);
    expect(up).toBeGreaterThan(1 - down);
  });
});

describe("phase arbiter", () => {
  const base = { connected: true, micLevel: 0, sinceOutputMs: null, agentBusy: false };

  it("is muted when the call is not connected", () => {
    expect(resolvePhase({ ...base, connected: false, micLevel: 1 })).toBe("muted");
  });

  it("puts live output audio ahead of the microphone", () => {
    // Both talking at once: being spoken to is the more immediate fact.
    expect(resolvePhase({ ...base, sinceOutputMs: 10, micLevel: 0.9, agentBusy: true })).toBe(
      "speaking",
    );
  });

  it("holds speaking briefly after the last output frame", () => {
    expect(resolvePhase({ ...base, sinceOutputMs: 200 })).toBe("speaking");
    // Past the hold window it releases.
    expect(resolvePhase({ ...base, sinceOutputMs: 900 })).toBe("idle");
  });

  it("listens when the microphone hears speech", () => {
    expect(resolvePhase({ ...base, micLevel: 0.4 })).toBe("listening");
    // Room noise below the threshold does not count as speech.
    expect(resolvePhase({ ...base, micLevel: 0.02 })).toBe("idle");
  });

  it("thinks while the agent works, below the microphone", () => {
    expect(resolvePhase({ ...base, agentBusy: true })).toBe("thinking");
    expect(resolvePhase({ ...base, agentBusy: true, micLevel: 0.5 })).toBe("listening");
  });
});

describe("chunk shape", () => {
  it("is 20ms of mono audio at the app-server's rate", () => {
    expect(CHANNELS).toBe(1);
    expect(SAMPLE_RATE).toBe(24_000);
    expect(CHUNK_SAMPLES).toBe(SAMPLE_RATE / 50);
    // One chunk encodes to a byte length the contract accepts.
    const bytes = floatToPcm16(new Float32Array(CHUNK_SAMPLES));
    expect(bytes.byteLength).toBe(CHUNK_SAMPLES * 2);
    expect(encodeBase64(bytes).length).toBeGreaterThan(0);
  });
});
