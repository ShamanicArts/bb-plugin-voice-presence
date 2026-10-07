// Audio plumbing for the realtime call, as pure functions.
//
// Kept dependency- and DOM-free so the parts that are easy to get subtly wrong —
// base64 framing, level, and the phase arbiter — are testable without a browser
// or a microphone.
//
// The wire format is the app-server's `ThreadRealtimeAudioChunk`
// (`{ data, numChannels, sampleRate, samplesPerChannel? }`), verified against
// `codex app-server generate-json-schema`. The API takes PCM16 as base64.

/** What the app-server accepts and what a browser can produce without resampling tricks. */
export const SAMPLE_RATE = 24_000;
export const CHANNELS = 1;
/** 20 ms at 24 kHz — small enough for low latency, large enough to not flood the socket. */
export const CHUNK_SAMPLES = 480;

// ---------------------------------------------------------------------------
// PCM16 <-> Float32
// ---------------------------------------------------------------------------

/** Float samples in [-1, 1] -> little-endian PCM16 bytes. */
export function floatToPcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0));
    // 0x7fff, not 0x8000: a positive full-scale sample must not wrap negative.
    view.setInt16(index * 2, Math.round(clamped * 0x7fff), true);
  }
  return bytes;
}

/** Little-endian PCM16 bytes -> Float samples in [-1, 1]. */
export function pcm16ToFloat(bytes: Uint8Array): Float32Array {
  const count = Math.floor(bytes.byteLength / 2);
  const samples = new Float32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < count; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 0x8000;
  }
  return samples;
}

// ---------------------------------------------------------------------------
// Base64 (browser and node both, without Buffer)
// ---------------------------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    out += B64[a >> 2];
    out += B64[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : B64[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : B64[c & 0x3f];
  }
  return out;
}

export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/u, "");
  const length = Math.floor((clean.length * 3) / 4);
  const bytes = new Uint8Array(length);
  let byteIndex = 0;
  for (let index = 0; index < clean.length; index += 4) {
    const n1 = B64.indexOf(clean[index] ?? "A");
    const n2 = B64.indexOf(clean[index + 1] ?? "A");
    const n3 = B64.indexOf(clean[index + 2] ?? "A");
    const n4 = B64.indexOf(clean[index + 3] ?? "A");
    const triple =
      (n1 << 18) | ((n2 < 0 ? 0 : n2) << 12) | ((n3 < 0 ? 0 : n3) << 6) | (n4 < 0 ? 0 : n4);
    if (byteIndex < length) bytes[byteIndex++] = (triple >> 16) & 0xff;
    if (byteIndex < length) bytes[byteIndex++] = (triple >> 8) & 0xff;
    if (byteIndex < length) bytes[byteIndex++] = triple & 0xff;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Level
// ---------------------------------------------------------------------------

/**
 * RMS of one frame, scaled into roughly 0..1.
 *
 * The original drives the orb from a continuously sampled 0..1 energy value, so
 * this is the microphone side of that. Clamped rather than normalised per-frame:
 * a level that jumps around with frame size reads as a flickering orb.
 */
export function rmsLevel(samples: Float32Array, gain = 3): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] ?? 0;
    sum += value * value;
  }
  return Math.max(0, Math.min(1, Math.sqrt(sum / samples.length) * gain));
}

/** Smooth a new level into the running one, so the orb breathes instead of twitching. */
export function smoothLevel(previous: number, next: number, attack = 0.5, release = 0.12): number {
  const rate = next > previous ? attack : release;
  return previous + (next - previous) * rate;
}

// ---------------------------------------------------------------------------
// The phase arbiter
// ---------------------------------------------------------------------------

export type CallPhase = "idle" | "listening" | "thinking" | "speaking" | "muted";

export interface PhaseInput {
  /** The call is up and the transport is connected. */
  readonly connected: boolean;
  /** Smoothed microphone level, 0..1. */
  readonly micLevel: number;
  /** Milliseconds since output audio last arrived, or null if never. */
  readonly sinceOutputMs: number | null;
  /** The agent has a turn running. */
  readonly agentBusy: boolean;
  /** Provider speech boundary where available; null means level-only presentation. */
  readonly inputSpeech?: boolean | null;
  readonly muted?: boolean;
}

/** Below this the microphone is hearing room, not a voice. */
const SPEECH_THRESHOLD = 0.09;
/** Output audio is "still arriving" for this long after the last frame. */
const OUTPUT_HOLD_MS = 350;

/**
 * Resolve one phase from the signals available.
 *
 * Explicit input activity keeps the listening state during interruption, then
 * output playback, then agent work. Older level-only callers retain their
 * output-first ordering. This presentation decision never commits audio.
 */
export function resolvePhase(input: PhaseInput): CallPhase {
  if (!input.connected) return "muted";
  if (!input.muted && input.inputSpeech === true) return "listening";
  if (input.sinceOutputMs !== null && input.sinceOutputMs < OUTPUT_HOLD_MS) return "speaking";
  if (input.muted) return "muted";
  if (input.inputSpeech === false) return input.agentBusy ? "thinking" : "idle";
  if (input.micLevel >= SPEECH_THRESHOLD) return "listening";
  if (input.agentBusy) return "thinking";
  return "idle";
}

/** Presentation envelope, independent of frame rate. Never used to finish a turn. */
export function smoothAudioLevel(previous: number, next: number, elapsedMs: number): number {
  const seconds = next > previous ? 0.045 : 0.18;
  const blend = 1 - Math.exp(-Math.max(0, elapsedMs) / (seconds * 1_000));
  return previous + (next - previous) * blend;
}

/** Level fallback for transports without speech boundary events. Tracks room floor
 * and uses hysteresis so a quiet syllable doesn't flicker into agent work.
 * This is visual activity detection, never audio VAD/commit/response control.
 */
export class InputActivity {
  private floor = 0.003;
  private peak = 0.003;
  private active = false;
  /** Speech energy relative to the measured recent peak and room floor. */
  level = 0;

  sample(level: number, elapsedMs: number): boolean {
    const decay = Math.exp(-Math.max(0, elapsedMs) / 1_000);
    this.peak = Math.max(level, this.peak * decay);
    if (!this.active) {
      const blend = 1 - Math.exp(-Math.max(0, elapsedMs) / 3_000);
      this.floor += (Math.min(level, this.floor * 1.5) - this.floor) * blend;
    }
    const onset = Math.max(0.012, this.floor * 3);
    const release = Math.max(this.floor * 1.6, this.peak * 0.12, 0.005);
    this.active = level >= (this.active ? release : onset);
    this.level = Math.max(0, Math.min(1, (level - this.floor) / Math.max(onset, this.peak - this.floor)));
    return this.active;
  }
}

/** Level the orb is fed while nobody is talking, so it never reads as dead. */
export const IDLE_ENERGY_FLOOR = 0.16;
