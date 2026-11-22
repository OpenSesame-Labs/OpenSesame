import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import {
  ask,
  decide,
  inboxRefOf,
  principal,
} from "./authorization-requests-fixture.js";

describe("authorization request inbox races", () => {
  it("chaos: two approvers racing get a conflict, never a 500", async () => {
    // Both handlers read the row before either writes, so the second write
    // loses the version check. That is a conflict the caller can act on — a
    // 500 would read as "the decision may or may not have landed".
    const { app, ctx } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    const approver = await principal(app);
    const requester = await principal(app);
    const created = await ask(
      app,
      requester.accessToken,
      await inboxRefOf(app, approver),
    );
    const { authReqId, requestDigest } = overlapCast(await created.json());

    // Hold the first settler at the compare-and-set until the second approver
    // has read the pending row, so the race exercises the version check rather
    // than whichever microtask order the session boundary happens to pick.
    const requests = ctx.repos.authorizationRequests;
    const original = requests.updateWithVersion.bind(requests);
    let markWriteStarted = () => {};
    let releaseWrite = (_value: unknown) => {};
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const writeRelease = new Promise<unknown>((resolve) => {
      releaseWrite = resolve;
    });
    let writes = 0;
    const spy = vi.spyOn(requests, "updateWithVersion").mockImplementation(((
      id: string,
      expectedVersion: number,
      patch: Parameters<typeof original>[2],
    ) => {
      writes += 1;
      if (writes === 1) {
        markWriteStarted();
        return writeRelease.then(() => original(id, expectedVersion, patch));
      }
      return original(id, expectedVersion, patch);
    }) as typeof requests.updateWithVersion);
    try {
      const firstRequest = decide(
        app,
        approver.accessToken,
        authReqId,
        "approve",
        requestDigest,
      );
      const secondRequest = decide(
        app,
        approver.accessToken,
        authReqId,
        "approve",
        requestDigest,
      );
      await writeStarted;
      await Promise.race([firstRequest, secondRequest]);
      releaseWrite(undefined);
      const [first, second] = await Promise.all([firstRequest, secondRequest]);
      const statuses = [first.status, second.status].sort();
      expect(statuses[0]).toBe(200);
      // 409 is the repository's version conflict reaching the caller as a
      // conflict; before this it escaped the handler and became a 500.
      expect(statuses[1]).toBe(409);
    } finally {
      spy.mockRestore();
    }
  });
});
