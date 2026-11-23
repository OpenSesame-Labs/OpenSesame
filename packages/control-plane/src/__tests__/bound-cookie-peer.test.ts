import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

/** What the @hono/node-server adapter hands the app as `c.env`. */
type NodeBindings = { incoming: { socket: { remoteAddress: string } } };
const nodeBindings = (remoteAddress: string): NodeBindings => ({
  incoming: { socket: { remoteAddress } },
});

const mint = (
  app: ReturnType<typeof createControlPlane>["app"],
  index: number,
  env?: NodeBindings,
) =>
  app.request(
    "/v1/bound/session-mint",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
        "user-agent": "same-agent",
      },
      body: JSON.stringify({
        restoreProofHash: createHash("sha256")
          .update(String(index).padStart(64, "0"))
          .digest("hex"),
      }),
    },
    env,
  );

const create = () =>
  createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://localhost",
      issuer: "http://localhost",
    },
  }).app;

it("budgets a bound mint by the connection peer the Node adapter observed", async () => {
  const app = create();
  const statuses: number[] = [];
  for (let index = 0; index < 11; index += 1)
    statuses.push((await mint(app, index, nodeBindings("203.0.113.7"))).status);
  // A peer-keyed bucket allows 60/minute; the header fallback stops at 10.
  expect(statuses).toEqual(new Array(11).fill(201));
  // A second peer with the same User-Agent is its own bucket, so the routed
  // handler keyed on the peer address rather than on the header.
  expect((await mint(app, 99, nodeBindings("198.51.100.2"))).status).toBe(201);
});

it("keeps the header fallback ceiling when no peer is observed", async () => {
  const app = create();
  const statuses: number[] = [];
  for (let index = 0; index < 11; index += 1)
    statuses.push((await mint(app, index)).status);
  expect(statuses.slice(0, 10)).toEqual(new Array(10).fill(201));
  expect(statuses[10]).toBe(429);
});
