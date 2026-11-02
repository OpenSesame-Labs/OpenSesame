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
  webPwa: Object.freeze({
    name: "@opensesame-labs/web-pwa",
    bin: Object.freeze({
      "opensesame-pages": "./bin/serve.mjs",
    }),
  }),
});
