import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The Boat relay fixtures bind the same fixed loopback port.
    fileParallelism: false,
  },
});
