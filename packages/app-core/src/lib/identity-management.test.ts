import type { BoundaryValue } from "@opensesame/os-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { identitySeams } from "./identity.js";
import { listDirectoryUsers } from "./identity-management.js";

const identityFetch = vi.hoisted(() => vi.fn());

Object.assign(identitySeams, {
  identityFetch,
  identityBase: () => "https://identity.example.test",
});

function json(body: BoundaryValue): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/scim+json" },
  });
}

function user(id: string) {
  return {
    id,
    userName: `${id}@example.test`,
    displayName: id.toUpperCase(),
    active: true,
  };
}

describe("the first-party SCIM directory client", () => {
  beforeEach(() => identityFetch.mockReset());

  it("retrieves every server page instead of truncating the directory", async () => {
    identityFetch
      .mockResolvedValueOnce(
        json({
          totalResults: 3,
          startIndex: 1,
          itemsPerPage: 2,
          Resources: [user("one"), user("two")],
        }),
      )
      .mockResolvedValueOnce(
        json({
          totalResults: 3,
          startIndex: 3,
          itemsPerPage: 1,
          Resources: [user("three")],
        }),
      );

    await expect(listDirectoryUsers("org / one")).resolves.toEqual([
      user("one"),
      user("two"),
      user("three"),
    ]);
    expect(identityFetch.mock.calls.map(([path]) => path)).toEqual([
      "/v1/organizations/org%20%2F%20one/scim/v2/Users?startIndex=1&count=200",
      "/v1/organizations/org%20%2F%20one/scim/v2/Users?startIndex=3&count=200",
    ]);
  });

  it("fails closed when a server stops a directory before totalResults", async () => {
    identityFetch.mockResolvedValue(
      json({
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 0,
        Resources: [],
      }),
    );
    await expect(listDirectoryUsers("org_1")).rejects.toThrow(
      "incomplete directory",
    );
    expect(identityFetch).toHaveBeenCalledOnce();
  });
});
