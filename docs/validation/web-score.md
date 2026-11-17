# Public web-score gate

`node scripts/quality/web-score.mjs` measures a deployed public site:

- Lighthouse desktop **and mobile**: performance, accessibility,
  best-practices, and SEO must all be `1.0` on each.
- For an origin-root URL only, [Is Agentic](https://is-agentic.com/) checks the
  public origin's agent readiness; its score must be exactly `100`.

Before scoring, a fresh browser must reach the real front door and open setup.
This prevents a loading screen, error, or inert static imitation from passing.
The Lighthouse reports must also identify their largest painted element and
must not attribute it to the startup placeholder; runs with warnings or errors
in scored audits fail instead of presenting incomplete scores as success.
When deliberately auditing a different site, set `WEB_SCORE_EXPECT_APP=0` to
skip this OpenSesame-specific check.

The app currently offers a different default walkthrough when it detects
`navigator.webdriver` (ADR 0221). For OpenSesame checks, Chromium is launched
with `--disable-blink-features=AutomationControlled` so the audit receives the
automatic first-visit tour a person receives. The separate interaction check
verifies this browser setting and exits the tour using its visible control
before opening setup; Lighthouse itself runs without that interaction. Other
sites audited with `WEB_SCORE_EXPECT_APP=0` do not receive this flag.

This gate is separate from `npm run verify`: it needs the public network and a
Chrome/Chromium binary. An origin-root check also needs the Is Agentic service.
It is a delivery check for a published site, not a hermetic unit gate.

The Is Agentic check reads the public `/api/v1/report` score. The allowed age
defaults to the provider's six-hour cache window; a report older than that
triggers a fresh scan through `/api/scan/stream`, and the gate fails if the
report is still stale afterward. Set `WEB_SCORE_MAX_AGENTIC_AGE_MS` to a
shorter value when the gate must prove that the scan is newer than a deploy;
the six-hour default accepts the provider's cached public score and is not a
deploy-freshness proof. The public report score is authoritative; the scan
stream's raw `result.score` can use a different scoring contract.

Lighthouse runs once by default. Set `WEB_SCORE_LIGHTHOUSE_ATTEMPTS` to take
multiple samples when investigating lab variability. Every sample is retained
and all must pass; a favorable run cannot hide a failing or incomplete one.
The script uses `npm exec` to run pinned Lighthouse 12.8.2; the first run
downloads it. Treat scores as diagnostics alongside real journeys and field
data, not as a reason to remove or disguise the designed experience.

## Run

```bash
CHROME_PATH=/path/to/chrome node scripts/quality/web-score.mjs
CHROME_PATH=/path/to/chrome node scripts/quality/web-score.mjs https://example.com/path
```

Defaults to the OpenSesame app,
`https://opensesame-labs.github.io/OpenSesame/`; set `WEB_SCORE_URL` to change
the default. Lighthouse checks the full URL, including path. Is Agentic scores
only an origin, so it is skipped for a path or query, including the default
GitHub Pages URL. Its origin score cannot be attributed to the `/OpenSesame/`
app. Each invocation writes its reports to a new directory under
`work/web-score/`, which is git-ignored; failed and successful Lighthouse
samples remain available there for investigation.
Query strings are rejected by default because signed parameters must not be
copied into local reports; set `WEB_SCORE_ALLOW_QUERY=1` for a deliberate public
URL. Loopback, RFC1918, `.local` and `.internal` hosts are rejected because the
origin may be sent to Is Agentic; set `WEB_SCORE_ALLOW_PRIVATE=1` only for a
host you intend to disclose.

Chrome is discovered from `CHROME_PATH`, common Linux/macOS locations, and the
standard Windows install paths. In a disposable container whose Chrome cannot
use the setuid sandbox, set `WEB_SCORE_NO_SANDBOX=1` explicitly. The script
always uses a throwaway profile, but disabling the renderer sandbox still lets
arbitrary page content reach the host user directly; do not use the opt-in on a
normal workstation.

## What the scores cover

Lighthouse gives lab signals about load and accessibility. Is Agentic gives an
independent signal about whether an autonomous agent can discover, retrieve,
understand, and recover from a public origin. Neither score proves the other,
and neither replaces testing the real interface and its actions.

## Other measurements

For a local production build, run `npm run build -w @opensesame/pages` and
`npm run verify:startup -w @opensesame/pages`. The latter checks the initial
state with JavaScript delayed and disabled, then exercises the real first-run
and returning screens on desktop and phone. It is complementary to Lighthouse:
the startup check is not a performance score and the local static server does
not reproduce a production CDN's compression, latency, or cache headers.

- **Core Web Vitals** — CrUX/PageSpeed field data when a property has enough
  traffic. Lighthouse is the lab check; field data is the production check.
- **Security headers** — `securityheaders.com` or the `headers` block in
  `apps/pages/vercel.json`.
- **OpenSSF Scorecard** — supply-chain posture for the repository, not the
  rendered page; tracked separately from the public-site gate.

Do not add this gate to `npm run verify` until CI provides a stable pinned
Chrome and permits the network calls. It is intentionally opt-in.
