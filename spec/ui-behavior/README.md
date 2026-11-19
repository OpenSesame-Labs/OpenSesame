# UI behavior models and properties

These finite models cover the connector chooser and local GitHub backup
lifecycle, a shared capability switch, support-route context, and retired
vault-unlock attempts, and the time a transient notice remains visible while
it is read. Each model states its own bounds and assumptions. The
[evidence ledger](../formal-verification/README.md) ties individual claims to
the implementation and tests while recording the remaining proof gaps.
The current configurations check state invariants; they do not establish
liveness or fairness properties.

`ConnectorModes.tla` models two available methods, one unavailable choice and
a group lock. TLC explores all reachable states of that finite model and checks
that the selected method is valid, blocked attempts do not change it, and
allowed attempts take effect. This is a check of the hand-written model, not a
proof of the React implementation. The seeded `fast-check` test in
`ConnectorModes.test.tsx` compares generated interaction sequences with the
same selection and lock rules. The model has no assumptions about provider
credentials, remote configuration, focus, or browser layout.

`ToastReading.tla` models one transient notification with separate pointer
and keyboard-focus states and bounded timer ticks. TLC checks that reading
holds its remaining time and that it disappears only by dismissal or after
its idle time runs out. `ToastStack.reading.test.tsx` exercises the component
with generated input sequences and controlled timers. The model abstracts
event delivery, layout, the notice tray and screen-reader announcements; it
does not prove React refinement or liveness.
The prerelease job also runs `toast-model-fault.test.mjs`: it changes the
model so both pointer and focus are required to hold time and checks that TLC
rejects that deliberate fault with `ReadingHoldsTime`.

To check the model, install Java and download the official
[TLA+ tools 1.7.4 release](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4).
The runner verifies the jar's SHA-256 and stores TLC's temporary state outside
the repository:

```sh
TLA2TOOLS_JAR=/path/to/tla2tools.jar npm run verify:behavior-models -w @opensesame/pages
```

The runner checks every paired TLA+ model and configuration in this directory
and in `spec/auth-verification`. It fails on missing, unpaired, or nonregular
model files. `verify:ui-model` remains an alias for existing workflows.

The [Calculus of Interfaces](https://calculus-of-interfaces.vercel.app/) is a
useful account of reasoning about interaction; it is a research prototype, not
a tool that automatically proves arbitrary React components. This pilot uses
TLC for the finite model and checks the implementation separately.

## Browser properties

```sh
npm run verify:ui-properties -w @opensesame/pages
npm run verify:ui-properties -w @opensesame/pages -- --self-check
```

Bombadil starts isolated local Vite fixtures that import the real shared
connector chooser and capability switch, then generates clicks only on their
controls at phone and desktop widths. The chooser checks naming, one matching
selection, and that locked or unavailable choices cannot trigger changes. The
switch compares requests and visible state to a separate pointer-intent oracle;
an ordinary run must exercise accepted, rejected, and disabled attempts. No
live vault or provider is used. The self-check deliberately introduces a
different mismatch for each fixture and must find the named violation at both
widths. Traces are kept in a newly created temporary directory, whose path is
printed. Replay a trace with `BOMBADIL_REPRODUCE=/path/to/trace-directory`, set
`BOMBADIL_WIDTH` to the original width, and use
`BOMBADIL_TARGET=capability-switch` for switch traces (the default replay target
is `connector-modes`). `BOMBADIL_TIME_LIMIT` changes each exploration duration.
Restricted environments that cannot run Chromium's sandbox may set
`BOMBADIL_NO_SANDBOX=1`; the default leaves the sandbox enabled.
The prerelease qualification workflow runs these commands against the candidate
snapshot. They do not gate pull requests or trunk builds.

The SDK agent test checks the control's discoverability and actions in
isolation. It does not register the SDK's unrestricted page-wide agent bridge.
Production agent operations must remain under OpenSesame's consented WebMCP
capabilities and authority checks before any SDK actions are exposed there.
