import { defineConfig } from "vitest/config";

const mutatedModule = process.env.OPENSESAME_INTERACTION_CLOCK_MUTANT;

export default defineConfig({
  resolve: {
    alias: mutatedModule
      ? [
          {
            find: "../../../packages/control-plane/src/services/interaction-clock.js",
            replacement: mutatedModule,
          },
        ]
      : [],
  },
  test: {
    environment: "node",
    include: ["spec/formal/interaction-clock/clock-conformance.test.ts"],
  },
});
