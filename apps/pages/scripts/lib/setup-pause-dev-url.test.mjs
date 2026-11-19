import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("verify setup pause dev URL phases", () => {
  it("serves main dist through the harness while branch uses dev URL", () => {
    const devUrl = "http://127.0.0.1:4173/";
    const ORIGIN = "https://opensesame-labs.github.io";
    const BASE = "/OpenSesame/";
    const staticHref = `${ORIGIN}${BASE}`;
    function phaseOptions(label) {
      const phaseDevUrl = label === "branch" ? devUrl : "";
      const href = phaseDevUrl || staticHref;
      return { devUrl: phaseDevUrl, href };
    }
    assert.deepEqual(phaseOptions("main"), {
      devUrl: "",
      href: staticHref,
    });
    assert.deepEqual(phaseOptions("branch"), {
      devUrl,
      href: devUrl,
    });
  });
});
