import { expect, test } from "vitest";
import { phaseOptions } from "../verify-setup-tutorial-pause.mjs";
import { SETUP_PAUSE_INIT } from "./setup-pause-freeze.mjs";
import { collectHarnessFailures } from "./setup-pause-run-build.mjs";

test("serves main dist through the harness while branch uses dev URL", () => {
  const devUrl = "http://127.0.0.1:4173/";
  const origin = "https://opensesame-labs.github.io";
  const base = "/OpenSesame/";
  const staticHref = `${origin}${base}`;
  expect(phaseOptions("main", devUrl, origin, base)).toEqual({
    devUrl: "",
    href: staticHref,
  });
  expect(phaseOptions("branch", devUrl, origin, base)).toEqual({
    devUrl,
    href: devUrl,
  });
  expect(phaseOptions("branch", "", origin, base)).toEqual({
    devUrl: "",
    href: staticHref,
  });
});

test("reduced motion stub matches reduce only", () => {
  const native = [];
  const window = {
    matchMedia(query) {
      native.push(query);
      return { matches: false, media: query };
    },
  };
  const math = { random: Math.random.bind(Math) };
  new Function("window", "Math", SETUP_PAUSE_INIT)(window, math);
  expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(
    true,
  );
  expect(
    window.matchMedia("(prefers-reduced-motion: no-preference)").matches,
  ).toBe(false);
  expect(window.matchMedia("(min-width: 800px)").matches).toBe(false);
  expect(native).toEqual(["(min-width: 800px)"]);
});

test("collectHarnessFailures surfaces dev URL hard faults", () => {
  const failures = [];
  collectHarnessFailures(
    {
      log: [
        { kind: "PAGE-ERROR", detail: "TypeError: boom" },
        { kind: "MISSING-ASSET", detail: "/assets/missing.js" },
        {
          kind: "LOOPBACK-REQUEST",
          detail: "GET http://127.0.0.1:9/secret",
        },
        { kind: "PASS", detail: "setup frame is visible" },
      ],
      failures: ["[dev] extra"],
    },
    "branch",
    failures,
  );
  expect(failures).toEqual([
    "[branch] PAGE-ERROR: TypeError: boom",
    "[branch] MISSING-ASSET: /assets/missing.js",
    "[branch] LOOPBACK-REQUEST: GET http://127.0.0.1:9/secret",
    "[branch] [dev] extra",
  ]);
  const missing = [];
  collectHarnessFailures(null, "branch", missing);
  expect(missing).toEqual([
    "[branch] PAGE-ERROR, MISSING-ASSET, and LOOPBACK-REQUEST were not observed",
  ]);
});
