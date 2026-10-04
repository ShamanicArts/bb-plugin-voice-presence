import { defineConfig } from "vitest/config";

// `@/` alias used by app.tsx; the server tests run in plain node.
export default defineConfig({
  resolve: { alias: { "@": new URL(".", import.meta.url).pathname } },
  test: { environment: "node" },
});
