import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Integration tests spin up a Docker container; give them headroom.
    // Per-test timeouts in the integration test file override this.
    testTimeout: 15_000,
    hookTimeout: 180_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/bin.ts"],
      thresholds: {
        lines: 90,
        branches: 85,
      },
    },
  },
});
