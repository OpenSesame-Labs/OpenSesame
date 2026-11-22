import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "vitest";
import {
  natsBrowserEntry,
  readNatsBrowserInputs,
  renderNatsBrowserCore,
  validateNatsBrowserSource,
} from "./nats-browser-entry.mjs";

const require = createRequire(import.meta.url);
const input = readNatsBrowserInputs();

test("the selective entry exports the exact upstream carrier functions", () => {
  const official = require("@nats-io/nats-core");
  const websocket = require(input.sources["lib/ws_transport.js"].path);
  assert.equal(websocket.wsconnect, official.wsconnect);
  const source = renderNatsBrowserCore(input);
  assert.match(source, /ws\.wsconnect/);
  assert.doesNotMatch(source, /internal_mod|lib\/mod\.js/);
});

test("every reviewed upstream input is content pinned", () => {
  const changed = `${input.sources["lib/mod.js"].source}\n`;
  assert.throws(
    () => validateNatsBrowserSource("lib/mod.js", changed),
    /pin mismatch/,
  );
  assert.doesNotThrow(() => readNatsBrowserInputs());
});

test("the build plugin rewires only the owned carrier import", () => {
  const plugin = natsBrowserEntry();
  plugin.buildStart();
  const carrier = input.packageRoot.replace(
    /node_modules\/@nats-io\/nats-core$/,
    "apps/pages/src/modules/sharing.live/carriers/nats.ts",
  );
  assert.match(
    plugin.resolveId("@nats-io/nats-core", carrier),
    /nats-core-browser/,
  );
  assert.equal(
    plugin.resolveId("@nats-io/nats-core", "/fixture/other.ts"),
    null,
  );
  assert.match(plugin.load("\0opensesame-nats-core-browser"), /wsconnect/);
});
