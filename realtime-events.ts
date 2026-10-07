export const REALTIME_DATA_CHANNEL = "oai-events";

export type RealtimeVoiceEvent =
  | { readonly type: "input.speech"; readonly active: boolean; readonly itemId: string | null }
  | { readonly type: "transcript.delta"; readonly itemId: string | null; readonly role: "user" | "assistant"; readonly text: string }
  | { readonly type: "transcript.done"; readonly itemId: string | null; readonly role: "user" | "assistant"; readonly text: string }
  | { readonly type: "handoff"; readonly id: string; readonly text: string }
  | { readonly type: "error"; readonly message: string };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function itemId(message: Record<string, unknown>): string | null {
  const turn = record(message.turn);
  const item = record(message.item);
  const response = record(message.response);
  const candidates = [
    message.item_id,
    message.turn_id,
    message.response_id,
    item?.id,
    turn?.id,
    response?.id,
  ];
  return candidates.find((value) => typeof value === "string" && value.length > 0 && value.length <= 256) as string | undefined
    ?? null;
}

export function parseRealtimeVoiceEvent(data: string): RealtimeVoiceEvent | null {
  let message: Record<string, unknown>;
  try {
    const parsed = record(JSON.parse(data));
    if (parsed === null) return null;
    message = parsed;
  } catch {
    return null;
  }
  const type = typeof message.type === "string" ? message.type : "";
  // Standard Realtime boundary events. GPT-live transcript fragments do not
  // supply equivalent turn boundaries; never synthesize one from a delta gap.
  if (type === "input_audio_buffer.speech_started" || type === "input_audio_buffer.speech_stopped") {
    return { type: "input.speech", active: type.endsWith("speech_started"), itemId: itemId(message) };
  }
  if (type === "delegation.created") {
    const item = record(message.item);
    if (
      item === null ||
      item.type !== "delegation" ||
      item.target !== "client" ||
      typeof item.id !== "string" ||
      item.id.length === 0 ||
      item.id.length > 256 ||
      !Array.isArray(item.content)
    ) return null;
    const text = item.content
      .flatMap((part) => {
        const value = record(part);
        return value?.type === "input_text" && typeof value.text === "string" ? [value.text] : [];
      })
      .join("\n")
      .trim();
    return text.length > 0 && text.length <= 8_000 ? { type: "handoff", id: item.id, text } : null;
  }
  if (type === "turn.done") {
    const turn = record(message.turn) ?? message;
    const role = turn.role;
    const text = typeof turn.transcript === "string" ? turn.transcript.trim() : "";
    return (role === "user" || role === "assistant") && text.length > 0
      ? { type: "transcript.done", itemId: itemId(message), role, text }
      : null;
  }
  if (type === "input_transcript.added" || type === "output_transcript.added") {
    const role = type === "input_transcript.added" ? "user" : "assistant";
    const item = record(message.item);
    const text =
      typeof message.text === "string"
        ? message.text
        : typeof item?.text === "string"
          ? item.text
          : "";
    return text.length > 0
      ? { type: "transcript.delta", itemId: itemId(message), role, text }
      : null;
  }
  const deltaRole =
    type === "conversation.input_transcript.delta" ||
    type === "conversation.item.input_audio_transcription.delta"
      ? "user"
      : type === "conversation.output_transcript.delta" ||
          type === "response.output_text.delta" ||
          type === "response.output_audio_transcript.delta" ||
          type === "response.audio.transcript.delta" ||
          type === "turn.delta"
        ? "assistant"
        : null;
  if (deltaRole !== null) {
    const turn = record(message.turn);
    const text =
      typeof message.delta === "string"
        ? message.delta
        : typeof turn?.delta === "string"
          ? turn.delta
          : typeof turn?.text === "string"
            ? turn.text
            : "";
    return text.length > 0
      ? { type: "transcript.delta", itemId: itemId(message), role: deltaRole, text }
      : null;
  }
  const doneRole =
    type === "conversation.input_transcript.turn_marked" ||
    type === "conversation.item.input_audio_transcription.completed"
      ? "user"
      : type === "response.output_audio_transcript.done" ||
          type === "conversation.output_transcript.done" ||
          type === "response.output_text.done"
        ? "assistant"
        : null;
  if (doneRole !== null) {
    const text =
      typeof message.transcript === "string"
        ? message.transcript.trim()
        : typeof message.text === "string"
          ? message.text.trim()
          : "";
    return text.length > 0
      ? { type: "transcript.done", itemId: itemId(message), role: doneRole, text }
      : null;
  }
  if (type === "error") {
    const error = record(message.error);
    const detail = typeof message.message === "string" ? message.message : error?.message;
    return { type: "error", message: typeof detail === "string" ? detail : "Voice error" };
  }
  return null;
}
