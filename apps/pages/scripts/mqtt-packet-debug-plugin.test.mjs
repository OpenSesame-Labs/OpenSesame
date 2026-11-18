import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { mqttPacketDebugGuard } from "./mqtt-packet-debug-plugin.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(resolve(root, "apps/pages/package.json"));
const sdk = realpathSync(
  resolve(dirname(require.resolve("mqtt/package.json")), "dist/mqtt.esm.js"),
);

test("guards only the pinned MQTT browser module in builds and development", () => {
  const plugin = mqttPacketDebugGuard(root);
  const code = readFileSync(sdk, "utf8");
  const guarded = plugin.transform(code, sdk);
  assert.equal(plugin.enforce, "pre");
  assert.deepEqual(plugin.config().optimizeDeps.exclude, ["mqtt"]);
  assert.equal(plugin.transform(code, "/unrelated.js"), null);
  assert.equal(plugin.transform(code, `${sdk}?v=test`), guarded);
  assert.equal(plugin.transform(code, sdk.replaceAll("/", "\\")), guarded);
  assert.ok(guarded);
  assert.ok(!guarded.includes('Gt()("mqtt-packet:writeToStream")'));
  assert.ok(!guarded.includes('Gt()("mqtt-packet:parser")'));
  assert.throws(
    () => plugin.transform(`${code}\n// changed`, sdk),
    /reviewed browser SDK/,
  );
});
