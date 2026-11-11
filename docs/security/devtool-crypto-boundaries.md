# Development tool crypto boundaries

The browser extension used to reach `@devicefarmer/adbkit` through WXT and
`web-ext-run`. WXT 0.21 no longer depends on `web-ext-run`, so adbkit,
`node-forge` and `shell-quote` are not installed: nothing in the lockfile
depends on them. The pins stay in `package.json` so that a Firefox runner
which brings the chain back gets the reviewed versions, not the newest ones.

If adbkit returns, it must be release 3.3.8, used only through the existing
ADB server transport: listing devices, shell, sync file listing and upload,
activity launch and port forwarding. It must not parse Android public keys or
create a TCP-to-USB bridge. The patch under `patches/` defers exactly two
imports until `parsePublicKey` or `createTcpUsbBridge` is called. All
transport implementations and the public client factory, default binary,
configured host/port and environment handling remain upstream code. The
`@devicefarmer/adbkit>node-forge` exclusion removes crypto helpers outside
this repository's development-tool scope. Those two helpers fail to load
without node-forge; this is intentional. The patch itself preserves their
upstream behavior when node-forge is installed.

The `promptfoo>jks-js` exclusion similarly disables optional Java KeyStore
conversion. It does not disable Node HTTPS PEM/PFX client certificates or the
Rust host's PKCS#12 support. This configuration is not a general-purpose
redistribution of every optional promptfoo or adbkit feature.

## Regression checks

Run `node --test scripts/security/adbkit-transport.test.mjs` after a frozen
npm install. While adbkit is absent, the suite proves the absence: no locked
package depends on it and it does not resolve from WXT, and the overrides
still pin 3.3.8 and exclude node-forge. For every locked copy that returns,
it proves node-forge is absent and exercises the real installed library
against a fragmented loopback ADB peer: device states, shell output, file
LIST/SEND completion and errors, activity failure and caller fallback, forward
requests, and configured server-start binary arguments. No Android device or
external service is used.
`scripts/security/shell-source-map-upgrade.test.mjs` does the same for
`shell-quote` and checks the installed `source-map-js`.

Separately validate promptfoo CLI/config startup and loopback HTTPS PEM/PFX
requests after installation. The ADB peer test does not substitute for those
consumer checks or a physical Android smoke test.
