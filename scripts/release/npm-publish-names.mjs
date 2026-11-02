/**
 * npm registry names for published artifacts. Workspace packages stay
 * `@opensesame/*`; only these `@opensesame-labs/*` names are published.
 */
/** Tyler will confirm the final npm name; keep this single constant in sync. */
export const PWA_NPM_PACKAGE_NAME_PLACEHOLDER = "@opensesame-labs/pages-pwa";

export const NPM_PUBLISH = Object.freeze({
  cli: Object.freeze({
    name: "@opensesame-labs/cli",
    bin: Object.freeze({
      opensesame: "./dist/bin.js",
    }),
  }),
  pagesPwa: Object.freeze({
    name: PWA_NPM_PACKAGE_NAME_PLACEHOLDER,
    bin: Object.freeze({
      "opensesame-pages": "./bin/serve.mjs",
    }),
  }),
});
