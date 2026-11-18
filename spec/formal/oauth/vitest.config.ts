import { defineConfig } from "vitest/config";

const mutant = process.env.OPENSESAME_OAUTH_MUTANT;
const trustMutant = process.env.OPENSESAME_OAUTH_TRUST_MUTANT;

export default defineConfig({
  resolve: {
    alias: [
      ...(mutant
        ? [
            { find: "./federated-pending.js", replacement: mutant },
            {
              find: "../../../packages/control-plane/src/interactions/federated-pending.js",
              replacement: mutant,
            },
          ]
        : []),
      ...(trustMutant
        ? [
            { find: "./federated-trust-binding.js", replacement: trustMutant },
            {
              find: "../../../packages/control-plane/src/interactions/federated-trust-binding.js",
              replacement: trustMutant,
            },
          ]
        : []),
    ],
  },
  test: {
    environment: "node",
    include: [
      "spec/formal/oauth/legacy-conformance.test.ts",
      "packages/control-plane/src/interactions/federated-pending.security.test.ts",
    ],
  },
});
