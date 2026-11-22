import { defineConfig } from "vitest/config";

const mutatedModule = process.env.OPENSESAME_APPROVAL_MUTANT;

export default defineConfig({
  resolve: {
    alias: mutatedModule
      ? [
          {
            find: "../../../packages/os-domain/src/machines/interaction.js",
            replacement: mutatedModule,
          },
        ]
      : [],
  },
  test: {
    environment: "node",
    include: ["spec/formal/webauthn/approval-conformance.test.ts"],
  },
});
