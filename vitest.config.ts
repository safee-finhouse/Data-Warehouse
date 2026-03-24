import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30000, // sync tests can take a few seconds
    hookTimeout: 15000,
  },
});
