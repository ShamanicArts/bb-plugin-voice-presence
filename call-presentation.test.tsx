// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { CallTray, CssOrb } from "./app";
import { deriveVoicePresenceIdentity } from "./src/presence/voicePresenceIdentity";
const identity = deriveVoicePresenceIdentity({ threadId: "preview" });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps status and named controls accessible when the WebGL orb falls back", () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  window.matchMedia = vi.fn(() => ({ matches: false })) as unknown as typeof window.matchMedia;
  const setMuted = vi.fn();
  const view = render(<CallTray
    audio={{ activity: { current: 0.4 }, phase: "listening", error: null, transcript: "caption", connection: "connected", muted: false, setMuted }}
    identity={identity} awayFromOwner ownerTitle="A very long thread title" status="Listening" detail={null} transcript="caption"
    inCall canMove open={() => {}} moveHere={async () => {}} end={async () => {}} reconnect={async () => {}} />);
  expect(view.getByRole("status").textContent).toBe("Listening");
  expect(view.getByRole("button", { name: "Mute microphone" }).getAttribute("aria-pressed")).toBe("false");
  expect(view.getByRole("button", { name: "End voice call" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Move here" })).toBeTruthy();
  expect(view.container.querySelector("canvas")).toBeNull();
});

it("the CSS fallback reacts to changing energy and respects reduced motion and muted appearance", () => {
  let frame!: FrameRequestCallback;
  let reduced = false;
  window.matchMedia = vi.fn(() => ({ get matches() { return reduced; } })) as unknown as typeof window.matchMedia;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const activityLevel = { current: 0.1 };
  const view = render(<CssOrb phase="listening" identity={identity} activityLevel={activityLevel} />);
  const orb = view.container.firstElementChild as HTMLElement;
  const initial = orb.style.transform;
  activityLevel.current = 0.7;
  frame(100);
  expect(orb.style.transform).not.toBe(initial);
  reduced = true;
  frame(200);
  expect(orb.style.transform).toBe("none");
  view.rerender(<CssOrb phase="muted" identity={identity} activityLevel={activityLevel} />);
  expect(orb.style.opacity).toBe("0.6");
});
