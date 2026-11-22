import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

// MQTT.js bundles mqtt-packet's debug loggers into its browser distribution.
// Those loggers print the password while writing CONNECT and payloads while
// parsing or writing frames, even when the client logger is disabled.
const MQTT_BROWSER_SHA256 =
  "1bf8d0a77809e4f2ae8ce48f213e96f3c5bc7cea7806741f32bcd8407296b066";
const LOGGERS = [
  'Gt()("mqtt-packet:writeToStream")',
  'Gt()("mqtt-packet:parser")',
];

/** Replace only the reviewed packet logger factories, not the MQTT protocol. */
export function redactMqttPacketLogs(code) {
  if (createHash("sha256").update(code).digest("hex") !== MQTT_BROWSER_SHA256)
    throw new Error("MQTT packet log guard requires the reviewed browser SDK");
  let guarded = code;
  for (const logger of LOGGERS) {
    if (guarded.split(logger).length !== 2)
      throw new Error("MQTT packet log guard could not identify its logger");
    guarded = guarded.replace(logger, "()=>{}");
  }
  return guarded;
}

const moduleId = (path) => path?.replaceAll("\\", "/").split("?")[0];

/** Guard the same npm bytes in production builds and the development server. */
export function mqttPacketDebugGuard(root) {
  const require = createRequire(resolve(root, "apps/pages/package.json"));
  const packageRoot = dirname(require.resolve("mqtt/package.json"));
  const sdk = realpathSync(resolve(packageRoot, "dist/mqtt.esm.js"));
  return {
    name: "opensesame-mqtt-packet-debug-guard",
    enforce: "pre",
    // Vite's prebundler bypasses transform hooks; leave this one SDK to Vite.
    config: () => ({ optimizeDeps: { exclude: ["mqtt"] } }),
    buildStart() {
      redactMqttPacketLogs(readFileSync(sdk, "utf8"));
    },
    transform(code, id) {
      return moduleId(id) === moduleId(sdk) ? redactMqttPacketLogs(code) : null;
    },
  };
}
