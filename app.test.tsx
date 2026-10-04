// @vitest-environment jsdom
//
// Loads the frontend through the SDK harness, which validates registrations with
// the host's own rules. If a registration is malformed the host drops the whole
// plugin app, and the symptom is simply "nothing appears in the UI" — so this is
// the check that has to pass before anything can render.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

afterEach(() => { cleanup(); document.body.replaceChildren(); });

function mountCompactCall() {
  const composer = document.createElement("div");
  composer.dataset.appComposerRole = "primary";
  composer.innerHTML = '<div data-promptbox-compact><div data-promptbox-action-row><div data-promptbox-standard-actions><button aria-label="Send message">Send</button></div></div></div>';
  document.body.append(composer);
  const start = vi.fn(() => ({ ok: true }));
  const overlay = app.appOverlays.find((slot) => slot.id === "voice-compact-call-action")!;
  const slot = renderSlot(overlay, {}, {
    context: { projectId: "p1", threadId: "t1" },
    rpc: {
      active_call: () => ({ callId: null, threadId: null, threadTitle: null, state: null, transportOwner: false }),
      call_state: () => ({ callId: null, state: null, controllerThreadId: null, transport: null, voiceAvailable: true, voiceDetail: null }),
      call_start: start,
    },
  });
  const button = document.querySelector<HTMLButtonElement>('[aria-label="Start voice call"]')!;
  return { slot, start, button, send: composer.querySelector<HTMLButtonElement>('[aria-label="Send message"]')! };
}

describe("compact call gestures", () => {
  it("ignores a mobile send gesture whose follow-up click lands on Call", () => {
    const { start, button, send } = mountCompactCall();
    fireEvent.pointerDown(send, { button: 0, pointerType: "touch" });
    fireEvent.pointerUp(send, { button: 0, pointerType: "touch" });
    fireEvent.click(button, { detail: 1 });
    expect(start).not.toHaveBeenCalled();
  });

  it("ignores a follow-up click when Call appears after a voice memo finishes", () => {
    const memo = document.createElement("button");
    document.body.append(memo);
    fireEvent.pointerDown(memo, { button: 0, pointerType: "touch" });
    fireEvent.pointerUp(memo, { button: 0, pointerType: "touch" });
    const { start, button } = mountCompactCall();
    fireEvent.click(button, { detail: 1 });
    expect(start).not.toHaveBeenCalled();
  });

  it("starts a call after a deliberate press on Call", async () => {
    const { start, button } = mountCompactCall();
    fireEvent.pointerDown(button, { button: 0, pointerType: "touch" });
    fireEvent.pointerUp(button, { button: 0, pointerType: "touch" });
    fireEvent.click(button, { detail: 1 });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
  });

  it("preserves keyboard and assistive activation", async () => {
    const { start, button } = mountCompactCall();
    fireEvent.click(button, { detail: 0 });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
  });

  it("does not reuse a cancelled call press for a later send gesture", () => {
    const { start, button, send } = mountCompactCall();
    fireEvent.pointerDown(button, { button: 0, pointerType: "touch" });
    fireEvent.pointerCancel(button);
    fireEvent.pointerDown(send, { button: 0, pointerType: "touch" });
    fireEvent.click(button, { detail: 1 });
    expect(start).not.toHaveBeenCalled();
  });
});

describe("call state updates", () => {
  it("does not let an older active-call response replace a newer ended state", async () => {
    let answer!: (value: unknown) => void;
    let requests = 0;
    const action = app.composerCustomizations[0]!.actions![0]!;
    const slot = renderSlot(action, {}, {
      context: { threadId: "t1", projectId: "p1" },
      rpc: {
        active_call: () => {
          requests++;
          if (requests === 1) return new Promise((resolve) => { answer = resolve; });
          return { callId: null, threadId: null, threadTitle: null, state: null, transportOwner: false };
        },
      },
    });
    await slot.emitRealtime("voice-call-changed", { threadId: "t1" });
    await waitFor(() => expect(requests).toBe(2));
    await act(async () => {
      answer({ callId: "old-call", threadId: "t1", threadTitle: "Old call", state: "active", transportOwner: true });
    });
    expect(slot.getByLabelText("Start voice call")).toBeTruthy();
    expect(slot.queryByLabelText("End voice call")).toBeNull();
  });
});

describe("frontend registration", () => {
  it("registers a call action in the composer, not a banner", () => {
    const customization = app.composerCustomizations.find(
      (candidate) => candidate.id === "voice-presence",
    );
    expect(customization).toBeDefined();
    expect(customization?.actions?.map((action) => action.id)).toEqual(["call"]);
    expect(customization?.scopes).toEqual(["thread"]);
  });

  it("registers the orb as a banner, so it lives in the chat column", () => {
    // A viewport-centred app overlay lands over BB's other pane rather than over
    // the pin bar, because the chat column is not the whole window.
    const customization = app.composerCustomizations.find(
      (candidate) => candidate.id === "voice-presence",
    );
    expect(customization?.banners?.map((banner) => banner.id)).toEqual(["orb"]);
    expect(customization?.banners?.[0]?.chrome).toBe("bare");
  });

  it("keeps only the media transport app-wide across thread navigation", () => {
    expect(app.appOverlays.map((overlay) => overlay.id)).toEqual([
      "voice-transport",
      "voice-compact-call-action",
    ]);
  });
});
