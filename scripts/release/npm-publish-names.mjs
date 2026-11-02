/**
 * npm registry names for published artifacts. Workspace packages stay
 * `@opensesame/*`; only these `@opensesame-labs/*` names are published.
 */
export const NPM_PUBLISH = Object.freeze({
  cli: Object.freeze({
    name: "@opensesame-labs/cli",
    bin: Object.freeze({
      opensesame: "./dist/bin.js",
    }),
  }),
  envSpecBridge: Object.freeze({
    name: "@opensesame-labs/env-spec-bridge",
    bin: Object.freeze({
      "opensesame-env-parse": "./opensesame-env-parse.mjs",
    }),
  }),
});
