# Connector-mode behavior pilot

The shared connector method chooser is a first, deliberately narrow example of
specifying UI behavior before expanding this approach to other controls.

`ConnectorModes.tla` models two available methods, one unavailable choice and
a group lock. TLC explores all reachable states of that finite model and checks
that the selected method is valid, blocked attempts do not change it, and
allowed attempts take effect. This is a check of the hand-written model, not a
proof of the React implementation. The seeded `fast-check` test in
`ConnectorModes.test.tsx` compares generated interaction sequences with the
same selection and lock rules. The model has no assumptions about provider
credentials, remote configuration, focus, or browser layout.

To check the model, install Java and download the official
[TLA+ tools 1.7.4 release](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4).
The runner verifies the jar's SHA-256 and stores TLC's temporary state outside
the repository:

```sh
TLA2TOOLS_JAR=/path/to/tla2tools.jar npm run verify:ui-model -w @opensesame/pages
```

The [Calculus of Interfaces](https://calculus-of-interfaces.vercel.app/) is a
useful account of reasoning about interaction; it is a research prototype, not
a tool that automatically proves arbitrary React components. This pilot uses
TLC for the finite model and checks the implementation separately.

## Browser properties

```sh
npm run verify:ui-properties -w @opensesame/pages
npm run verify:ui-properties -w @opensesame/pages -- --self-check
```

Bombadil starts an isolated local Vite fixture that imports the real shared
component, then generates clicks on only the fixture's controls at phone and
desktop widths. It checks naming, one matching selection, and that locked or
unavailable choices cannot trigger changes. No live vault or provider is used.
The self-check deliberately reports a mismatched selected value and must find
the named violation. Traces are kept in a newly created temporary directory,
whose path is printed. Replay a trace with
`BOMBADIL_REPRODUCE=/path/to/trace-directory` and set `BOMBADIL_WIDTH` to the
original width. `BOMBADIL_TIME_LIMIT` changes each exploration duration.
Restricted environments that cannot run Chromium's sandbox may set
`BOMBADIL_NO_SANDBOX=1`; the default leaves the sandbox enabled.
These two pilot commands are not yet run by CI.

The SDK agent test checks the control's discoverability and actions in
isolation. It does not register the SDK's unrestricted page-wide agent bridge.
Production agent operations must remain under OpenSesame's consented WebMCP
capabilities and authority checks before any SDK actions are exposed there.
