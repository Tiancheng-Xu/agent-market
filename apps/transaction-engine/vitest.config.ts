import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Embedded Postgres fixtures boot WASM; competing workers can starve setup.
    maxWorkers: 1,
    testTimeout: process.env.CI ? 15_000 : 5_000,
  },
});
