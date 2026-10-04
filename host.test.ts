import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";

const directory = await mkdtemp(join(tmpdir(), "bb-voice-host-test-"));
const binary = join(directory, "codex-fixture.mjs");
await writeFile(binary, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  const respond = (result) => process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
  if (request.method === "thread/realtime/stop") {
    setTimeout(() => respond({}), 150);
  } else if (request.method === "thread/start") {
    respond({ thread: { id: "fixture-thread" } });
  } else {
    respond({});
  }
});
`);
await chmod(binary, 0o700);
vi.stubEnv("BB_VOICE_CODEX_BINARY", binary);
const { default: entry } = await import("./host");
const harness = experimental_createHostEntryHarness(entry, {
  experimental_paths: { dataDir: directory, tempDir: directory },
});
afterAll(async () => {
  await harness.experimental_dispose();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function start(callId: string) {
  return harness.experimental_call("realtime_start", {
    callId, threadId: `thread-${callId}`, outputModality: "audio", version: "v3",
    voice: null, offerSdp: "fixture-offer", prompt: "Test voice session.", initialItems: [],
  });
}

it("does not dispose a new session when an older stop finishes", async () => {
  await expect(start("a")).resolves.toMatchObject({ ok: true });
  const stop = harness.experimental_call("realtime_stop", { callId: "a" });
  await vi.waitFor(async () => {
    expect(await harness.experimental_call("realtime_state", { callId: "a" })).toMatchObject({ state: "idle" });
  });
  await expect(start("b")).resolves.toMatchObject({ ok: true });
  await stop;
  await expect(harness.experimental_call("realtime_state", { callId: "b" })).resolves.toMatchObject({ state: "live" });
  expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(1);
});
