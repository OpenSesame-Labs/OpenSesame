import { describe, expect, it } from "vitest";
import gate from "../../../../../spec/conformance/cli-app-integration.json" with {
  type: "json",
};
import {
  cliAppIntegrationPolicy,
  isCliAppApprovalBlocked,
} from "./policy-runtime.js";
import { CliAppIntegrationStore } from "./session.js";

describe("cli app integration session store", () => {
  for (const caseRow of gate.sessionCases) {
    it(caseRow.id, () => {
      let now = 1_000_000;
      const store = new CliAppIntegrationStore(() => now);
      const terminalSessionId = caseRow.terminalSessionId;
      const verb = "reveal";
      // Keep lifecycle cases for the eventual provenance-backed implementation.
      if (!gate.approvalAvailable) {
        expect(store.ensure(terminalSessionId, verb).status).toBe("denied");
        return;
      }
      if (caseRow.action === "approve") {
        const pending = store.ensure(terminalSessionId, verb);
        expect(pending.status).toBe("pending");
        const requestId = pending.requestId;
        expect(requestId).toBeTruthy();
        const approved = store.approve(requestId ?? "", terminalSessionId);
        expect(approved.status).toBe("approved");
        if (caseRow.idlePastSeconds) {
          now += caseRow.idlePastSeconds * 1000;
        }
        if ("hardPastSeconds" in caseRow && caseRow.hardPastSeconds) {
          now += caseRow.hardPastSeconds * 1000;
        }
        const queryId =
          caseRow.queryAs === "other"
            ? (caseRow.otherTerminalSessionId ?? "missing")
            : terminalSessionId;
        const check = store.ensure(queryId, verb);
        expect(check.status).toBe(caseRow.expectEnsure);
        return;
      }
      if (caseRow.action === "pendingExpire") {
        const pending = store.ensure(terminalSessionId, verb);
        expect(pending.status).toBe("pending");
        if (caseRow.pendingPastSeconds) {
          now += caseRow.pendingPastSeconds * 1000;
        }
        expect(store.listPending()).toHaveLength(0);
        expect(store.ensure(terminalSessionId, verb).status).toBe("pending");
        return;
      }
      if (caseRow.action === "deny") {
        const pending = store.ensure(terminalSessionId, verb);
        const denied = store.deny(pending.requestId ?? "", terminalSessionId);
        expect(denied.status).toBe("denied");
        expect(store.ensure(terminalSessionId, verb).status).toBe("denied");
      }
    });
  }

  it("refuses approve while app approval is paused", () => {
    const store = new CliAppIntegrationStore();
    const pending = store.ensure("term-x", "reveal");
    expect(store.approve(pending.requestId ?? "", "term-y").status).toBe(
      "denied",
    );
  });

  it("refuses all verbs and existing session state while app approval is paused", () => {
    expect(cliAppIntegrationPolicy.approvalAvailable).toBe(
      gate.approvalAvailable,
    );
    expect(isCliAppApprovalBlocked()).toBe(!gate.approvalAvailable);
    const store = new CliAppIntegrationStore(() => 1_000);
    const approved = Reflect.get(store, "approved");
    expect(approved).toBeInstanceOf(Map);
    if (!(approved instanceof Map)) throw new Error("missing approved store");
    approved.set("term", {
      terminalSessionId: "term",
      approvedAtMs: 1_000,
      lastActivityMs: 1_000,
    });
    for (const verb of [
      "run",
      "pass-reveal",
      "read",
      "reveal",
      "env-resolve",
      "unknown",
    ]) {
      expect(store.ensure("term", verb).status).toBe("denied");
    }
    expect(store.listPending()).toEqual([]);
    expect(store.checkApproved("term")).toBe("denied");
    expect(store.approve("existing", "term").status).toBe("denied");
  });
});
