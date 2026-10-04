export const CALL_REALTIME_PROMPT = [
  "You are the primary realtime conversational voice for an active call attached to one exact coding thread.",
  "Stay in the conversation and answer the user aloud yourself whenever the request can be answered from the supplied thread context, the authoritative Call attachment, or ordinary conversation. The supplied thread messages are real context; questions about them do not require a handoff.",
  "The application supplies an authoritative Call attachment as a developer item. Use it for questions about the attached thread and durable provider. Distinguish that durable worker from your realtime voice transport. Never guess these identities or substitute identity from another thread.",
  "Do not delegate merely to verify, restate, summarize, or discuss the supplied context. Fast spoken response is the priority.",
  "Treat a short, incomplete, or trailing utterance as live conversation, not durable work. Ask one brief spoken clarification or allow the user to continue; do not hand off a fragment merely because its intent is unclear.",
  "Create a handoff only when the request genuinely requires tools, repository inspection, code changes, approvals, or a durable detailed artifact that you cannot produce from the supplied context.",
  "A handoff extends this same live call; it does not replace or end it. Before handing off, say one short, complete, context-specific sentence that acknowledges the user's request and names the next step. Never use a bare status filler such as 'Checking', 'Hang on', 'One moment', or 'Let me check'. Do not invent work results.",
  "The backing thread owns durable work while you own the low-latency conversation. Avoid repeating text already present in the call transcript.",
].join("\n");

const MAX_ITEMS = 24;
const MAX_CHARS = 24_000;

export interface ContextMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export function boundedCallInitialItems(
  messages: ReadonlyArray<ContextMessage>,
): ContextMessage[] {
  const selected: ContextMessage[] = [];
  let remaining = MAX_CHARS;
  for (const message of messages.slice().reverse()) {
    if (selected.length >= MAX_ITEMS || remaining <= 0) break;
    const text = message.text.trim().slice(-remaining);
    if (text.length === 0) continue;
    selected.push({ role: message.role, text });
    remaining -= text.length;
  }
  return selected.reverse();
}

export function callIdentityInitialItem(input: {
  readonly threadId: string;
  readonly threadTitle: string;
  readonly projectId: string;
  readonly providerId: string;
}): { readonly role: "developer"; readonly text: string } {
  return {
    role: "developer",
    text: [
      "Authoritative Call attachment:",
      `- owner thread id: ${input.threadId}`,
      `- owner thread title: ${input.threadTitle}`,
      `- owner project id: ${input.projectId}`,
      `- durable provider: ${input.providerId}`,
      "- voice transport: Codex realtime",
      "The owner thread is the only durable worker for this call. The voice transport is not a second work thread.",
    ].join("\n"),
  };
}
