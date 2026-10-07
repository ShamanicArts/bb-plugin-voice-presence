export type CallConnectionState = "connecting" | "connected" | "disconnected" | "failed";

export function callStatusLabel(input: {
  readonly serverState: string | null;
  readonly connection: CallConnectionState;
  readonly phase: "muted" | "idle" | "listening" | "thinking" | "speaking";
  readonly problem: string | null;
  readonly transportOwner?: boolean;
}): string {
  if (input.transportOwner === false) {
    if (input.problem !== null) return "Needs attention";
    if (input.serverState === "provisioning") return "Joining call on another device…";
    if (input.serverState === "active") return "Call active on another device";
    return "Call disconnected";
  }
  if (input.problem !== null || input.connection === "failed") return "Needs attention";
  if (input.connection === "disconnected") return "Call disconnected";
  if (input.serverState === "provisioning" || input.connection === "connecting") {
    return "Joining call…";
  }
  if (input.phase === "speaking") return "Speaking";
  if (input.phase === "listening") return "Listening";
  if (input.phase === "thinking") return "Listening · agent working";
  if (input.phase === "muted") return "Microphone muted";
  return "Call connected";
}
