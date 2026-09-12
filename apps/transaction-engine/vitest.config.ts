import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: process.env.CI ? 15_000 : 5_000,
  },
});
