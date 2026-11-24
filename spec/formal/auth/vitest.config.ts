import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "spec/formal/auth/auth-conformance.test.ts",
      "spec/formal/auth/session-conformance.test.ts",
    ],
  },
});
