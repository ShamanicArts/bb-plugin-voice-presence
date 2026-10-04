import { describe, expect, it } from "vitest";
import { callStatusLabel } from "./call-presentation";
import {
  CALL_REALTIME_PROMPT,
  boundedCallInitialItems,
  callIdentityInitialItem,
} from "./call-context";
import { sanitizeNarration, takeNarrationChunk } from "./narration";
import { parseRealtimeVoiceEvent, REALTIME_DATA_CHANNEL } from "./realtime-events";

describe("owner-thread call context", () => {
  it("tells realtime to converse quickly and hand durable work back", () => {
    expect(CALL_REALTIME_PROMPT).toContain("primary realtime conversational voice");
    expect(CALL_REALTIME_PROMPT).toContain("Create a handoff only when");
    expect(CALL_REALTIME_PROMPT).toContain("backing thread owns durable work");
  });

  it("keeps only the newest bounded thread context", () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `message ${index}`,
    }));
    const selected = boundedCallInitialItems(messages);
    expect(selected).toHaveLength(24);
    expect(selected[0]?.text).toBe("message 6");
    expect(selected.at(-1)?.text).toBe("message 29");
  });

  it("carries an explicit authoritative owner identity", () => {
    const item = callIdentityInitialItem({
      threadId: "thr_owner",
      threadTitle: "Fix audio",
      projectId: "proj_1",
      providerId: "codex",
    });
    expect(item.role).toBe("developer");
    expect(item.text).toContain("owner thread id: thr_owner");
    expect(item.text).toContain("owner thread title: Fix audio");
    expect(item.text).toContain("only durable worker");
  });
});

describe("realtime ingress", () => {
  it("uses the same WebRTC event channel as the Shove transport", () => {
    expect(REALTIME_DATA_CHANNEL).toBe("oai-events");
  });

  it("turns only an explicit client delegation into a handoff", () => {
    const handoff = parseRealtimeVoiceEvent(
      JSON.stringify({
        type: "delegation.created",
        item: {
          id: "handoff-1",
          type: "delegation",
          target: "client",
          content: [{ type: "input_text", text: "inspect the repository" }],
        },
      }),
    );
    expect(handoff).toEqual({
      type: "handoff",
      id: "handoff-1",
      text: "inspect the repository",
    });
  });

  it("does not mistake an ordinary user transcript for durable work", () => {
    expect(
      parseRealtimeVoiceEvent(
        JSON.stringify({
          type: "turn.done",
          turn: { id: "turn-1", role: "user", transcript: "what did you just say?" },
        }),
      ),
    ).toEqual({
      type: "transcript.done",
      itemId: "turn-1",
      role: "user",
      text: "what did you just say?",
    });
  });
});

describe("thread narration", () => {
  it("strips code, links, urls, and markdown before speech", () => {
    expect(
      sanitizeNarration("## Done\n- [result](https://example.com) `now`\n```ts\nconst secret = 1\n```")
    ).toBe("Done result now code omitted");
  });

  it("emits sentence-sized chunks and retains the remainder", () => {
    const result = takeNarrationChunk(
      "I found the ownership bug and attached the call to its thread. The remaining tests are running now.",
    );
    expect(result.chunk).toBe("I found the ownership bug and attached the call to its thread.");
    expect(result.rest).toBe("The remaining tests are running now.");
  });
});

describe("call lifecycle presentation", () => {
  it("distinguishes joining, connected activity, failure, and disconnection", () => {
    const base = { serverState: "active", phase: "idle" as const, problem: null };
    expect(callStatusLabel({ ...base, serverState: "provisioning", connection: "connecting" }))
      .toBe("Joining call…");
    expect(callStatusLabel({ ...base, connection: "connected", phase: "listening" }))
      .toBe("Listening");
    expect(callStatusLabel({ ...base, connection: "disconnected" }))
      .toBe("Call disconnected");
    expect(callStatusLabel({ ...base, connection: "failed", problem: "No media" }))
      .toBe("Needs attention");
  });
});
