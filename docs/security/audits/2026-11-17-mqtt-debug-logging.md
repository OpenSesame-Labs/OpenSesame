# MQTT debug logs exposed credentials and live frames — 2026-11-17

## Finding

The Pages live-sharing MQTT carrier passed broker credentials to MQTT.js.
When a browser enabled the MQTT debug namespaces through `localStorage.debug`,
MQTT.js could write its CONNECT packet to the browser console. Its bundled
`mqtt-packet` writer also logged CONNECT strings, including the password, and
its parser and writer logged packet contents. Browser console collection or
inspection could therefore expose a broker credential or a live message,
contrary to [ADR 0157](../../adr/0157-logs-and-events-carry-no-secrets.md).

This finding concerns the browser SDK used by the Pages application. The
regression uses only synthetic credentials and content; no live credential
was collected or included in this report.

## Fix

The carrier supplies MQTT.js's supported no-op client logger. A Pages build
plugin also disables the bundled packet parser and writer debug loggers in
the browser SDK. It pins the SHA-256 of the reviewed SDK bytes and requires
each of the two logger factories to occur exactly once, failing the build if
the package changes until the replacement has been reviewed. The plugin
excludes the SDK from Vite development dependency prebundling so that the same
guard applies in development. It does not alter packet encoding, delivery,
broker authentication, reconnect behavior, or other debug namespaces.

## Validation

`apps/pages/scripts/verify-mqtt-packet-debug.mjs` starts a local authenticated
MQTT broker and enables all debug namespaces in a real Chromium browser. The
unmodified bundled SDK is a negative control: the test requires it to disclose
the synthetic username, password and frame. The protected production bundle
and Vite development server must authenticate, publish and receive the frame
while exposing none of those values in console calls. With
`PAGES_MQTT_TEST_DIST` set, the same test exercises the actual Pages build's
MQTT chunk as well. The bundle CI job runs that complete proof with its own
built distribution. The plugin unit test also checks the SDK integrity pin,
target isolation and development configuration.
