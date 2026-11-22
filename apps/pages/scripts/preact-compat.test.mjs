import assert from "node:assert/strict";
import { test } from "vitest";
import { PREACT_COMPAT_ALIASES, preactCompat } from "./preact-compat.mjs";
import ReactCompat, {
  createElement,
  useOptimistic,
} from "./preact-react-compat.mjs";

test("the React 19 compatibility facade has named and default exports", () => {
  assert.equal(ReactCompat.createElement, createElement);
  assert.equal(ReactCompat.useOptimistic, useOptimistic);
});

test("production maps every React client entry to one compatibility runtime", () => {
  const config = { resolve: { alias: { existing: "/kept" } } };
  preactCompat().config(config);
  assert.deepEqual(config.resolve.alias, {
    ...PREACT_COMPAT_ALIASES,
    existing: "/kept",
  });
  assert.equal(
    config.resolve.alias["react-dom/client"],
    "preact/compat/client",
  );
  assert.equal(config.resolve.alias["react/jsx-runtime"], "preact/jsx-runtime");
  assert.match(config.resolve.alias.react, /preact-react-compat\.mjs$/);
});

test("production aliases retain Vite's ordered alias form", () => {
  const tail = { find: /^@app\//, replacement: "/app/" };
  const config = { resolve: { alias: [tail] } };
  preactCompat().config(config);
  assert.deepEqual(config.resolve.alias.at(-1), tail);
  assert.deepEqual(config.resolve.alias.slice(0, 3), [
    { find: "react-dom/test-utils", replacement: "preact/test-utils" },
    { find: "react-dom/client", replacement: "preact/compat/client" },
    { find: "react-dom", replacement: "preact/compat" },
  ]);
});
