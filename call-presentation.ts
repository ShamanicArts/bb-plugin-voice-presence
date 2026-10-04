export type CallConnectionState = "connecting" | "connected" | "disconnected" | "failed";

export function callStatusLabel(input: {
  readonly serverState: string | null;
  readonly connection: CallConnectionState;
  readonly phase: "muted" | "idle" | "listening" | "thinking" | "speaking";
  readonly problem: string | null;
}): string {
  if (input.problem !== null || input.connection === "failed") return "Needs attention";
  if (input.connection === "disconnected") return "Call disconnected";
  if (input.serverState === "provisioning" || input.connection === "connecting") {
    return "Joining call…";
  }
  if (input.phase === "speaking") return "Speaking";
  if (input.phase === "listening") return "Listening";
  if (input.phase === "thinking") return "Agent working";
  if (input.phase === "muted") return "Microphone muted";
  return "Call connected";
}
