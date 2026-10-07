import { afterEach, expect, it, vi } from "vitest";
import { CallAudioCues } from "./call-cues";

afterEach(() => vi.useRealTimers());

it("an optional audio-node failure cannot block connection, end or context cleanup", async () => {
  const context = {
    state: "running", currentTime: 0,
    createOscillator: vi.fn(() => { throw new Error("audio unavailable"); }),
    close: vi.fn(async () => {}),
  };
  const cues = new CallAudioCues(context as unknown as AudioContext);
  expect(() => { cues.connected(); cues.connected(); cues.end(); cues.end(); cues.dispose(); cues.dispose(); }).not.toThrow();
  await Promise.resolve();
  expect(context.createOscillator).toHaveBeenCalledTimes(2);
  expect(context.close).toHaveBeenCalledOnce();
});

it("closes a suspended output context even if its end events never arrive", async () => {
  vi.useFakeTimers();
  const nodes: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
  const context = {
    state: "running", currentTime: 0, destination: {},
    createOscillator: () => {
      const node = { frequency: { setValueAtTime() {} }, connect() {}, disconnect: vi.fn(), start() {}, stop() {}, onended: null };
      nodes.push(node);
      return node;
    },
    createGain: () => {
      const node = { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect: vi.fn() };
      nodes.push(node);
      return node;
    },
    close: vi.fn(async () => {}),
  };
  const cues = new CallAudioCues(context as unknown as AudioContext);
  cues.connected();
  cues.dispose();
  context.state = "suspended";
  expect(context.close).not.toHaveBeenCalled();
  await vi.runAllTimersAsync();
  expect(context.close).toHaveBeenCalledOnce();
  expect(nodes.every((node) => node.disconnect.mock.calls.length > 0)).toBe(true);
  cues.connected();
  cues.end();
  cues.dispose();
  expect(context.close).toHaveBeenCalledOnce();
});
