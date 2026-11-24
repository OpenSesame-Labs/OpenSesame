import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import tls from "node:tls";
import { serialize } from "node:v8";
import { PGlite } from "@electric-sql/pglite";
import {
  type Database,
  createEventSealer,
  oidcLookup,
  openOidcRow,
  sealOidcRow,
} from "@opensesame/database";
import * as schema from "@opensesame/database/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authMiddleware } from "../../../packages/control-plane/src/middleware/auth.js";
import type { Variables } from "../../../packages/control-plane/src/middleware/context.js";
import { DurableMap } from "../../../packages/control-plane/src/repos/durable-map.js";
import {
  legacyPrehashedRowId,
  rekeyKeys,
} from "../../../packages/control-plane/src/repos/durable-map-legacy.js";
import {
  decodeRecord,
  encodeRecord,
} from "../../../packages/control-plane/src/repos/durable-record.js";
import {
  type Issued,
  createDisposablePki,
} from "../../../packages/control-plane/src/transport/__tests__/pki.js";
import { mappingBindings } from "../../../packages/control-plane/src/transport/__tests__/server-helpers.js";
import { loadTransportMaterial } from "../../../packages/control-plane/src/transport/config.js";
import {
  createTransportListener,
  peerOf,
} from "../../../packages/control-plane/src/transport/listener.js";
import {
  type AttestedPeer,
  attestPeer,
} from "../../../packages/control-plane/src/transport/peer-evidence.js";
import {
  type ListenerProvenance,
  type RecordEvidenceInput,
  bindingPeerOf,
  recordRequestEvidence,
  requestEvidenceOf,
} from "../../../packages/control-plane/src/transport/request-evidence.js";
import {
  EMPTY_BINDINGS,
  parseServiceBindings,
} from "../../../packages/control-plane/src/transport/service-admission.js";
import { overlapCast } from "../../../packages/os-domain/src/json.js";

const path = process.env.OPENSESAME_AUTH_FORMAL_VECTORS;
if (!path) throw new Error("Run scripts/test/auth-formal.sh for Lean vectors");
const vectors = readFileSync(path, "utf8").trim().split("\n");
/** Rows of one group, titled by their abstract inputs, with the Lean outputs. */
function group(kind: string, inputs: number) {
  const rows = vectors.map((line) => line.split("\t"));
  return rows
    .filter(([name]) => name === kind)
    .map((row) => [row.slice(1, 1 + inputs).join(" "), row.slice(1)] as const);
}
const bit = (value: boolean) => (value ? "1" : "0");
/** `a=b c=d` as a lookup table. */
const table = (pairs: string) =>
  new Map(
    pairs.split(" ").map((pair): [string, string] => {
      const [key = "", value = ""] = pair.split("=");
      return [key, value];
    }),
  );
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

// AUTH-S2: authMiddleware with stores that answer every token the vectors name.
const ALLOWED = "https://app.example";
const EVIL = "https://evil.example";
const sessions = new Map<string, object>();
const tokens = table(
  "pst_bait=ps_bearer pst_ok=ps_bearer pst_cookie=ps_cookie pst_revoked=ps_revoked pst_cookie_revoked=ps_revoked",
);
const live = { expiresAt: new Date(Date.now() + 3_600_000) };
function session(id: string, principalId: string, facts: string, proof = "") {
  const revokedAt = facts === "revoked" ? new Date(0) : undefined;
  const restoreProofHash = digest(proof);
  sessions.set(id, { id, principalId, ...live, revokedAt, restoreProofHash });
}
session("ps_bearer", "prn_bearer", "ok");
session("ps_cookie", "prn_cookie", "ok");
session("ps_revoked", "prn_cookie", "revoked");
const ctx = (allowPrincipalBearer: boolean) => {
  const config = { provisionalCookieName: "os", corsOrigins: [ALLOWED] };
  const withdrawn = async (id: string) => id === "prn_withdrawn";
  const state = (id: string) =>
    id === "prn_suspended" ? "suspended" : "active";
  return overlapCast({
    config: {
      ...config,
      publicUrl: "https://id.example",
      allowPrincipalBearer,
    },
    clock: () => new Date(),
    stores: {
      provisionalTokens: { get: async (token: string) => tokens.get(token) },
      provisionalSessions: { get: async (id: string) => sessions.get(id) },
      organizationMemberships: { hasPendingWithdrawalForPrincipal: withdrawn },
    },
    repos: {
      principals: { getById: async (id: string) => ({ state: state(id) }) },
    },
  });
};
/** The credential that answered: 401, or `principal/session` as the route saw it. */
async function outcome(allow: boolean, headers: Headers) {
  const app = new Hono<{ Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("ctx", ctx(allow));
    await next();
  });
  app.use("*", authMiddleware());
  app.all("*", (c) => {
    const seen = [c.get("principalId"), c.get("provisionalSessionId")];
    return c.text(seen.map((value) => value ?? "-").join("/"));
  });
  const response = await app.request("/v1/x", { method: "POST", headers });
  return response.status === 401 ? "reject" : response.text();
}
const LABELS = table(
  "reject=reject -/-=anonymous prn_bearer/ps_bearer=bearer prn_ok/-=principal prn_cookie/ps_cookie=cookie",
);
const PROOF = "a".repeat(64);
const COOKIES = {
  absent: { origin: ALLOWED },
  cross_origin: { origin: EVIL, cookie: "os=pst_cookie" },
  ok: { origin: ALLOWED, cookie: "os=pst_cookie" },
  revoked: { origin: ALLOWED, cookie: "os=pst_cookie_revoked" },
};

describe("Lean session middleware correspondence", () => {
  it.each(group("bound", 9))("bound %s", async (_title, row) => {
    const [id, proof, named, cookie, origin, facts, same, mine, proven] = row;
    const boundId = id === "1" ? `ps_b${row.slice(0, 9).join("")}` : "bad";
    const target = same === "1" ? boundId : `${boundId}_elsewhere`;
    tokens.set(`pst_${boundId}`, target);
    session(boundId, "prn_bound", facts ?? "", proven === "1" ? PROOF : "x");
    if (target !== boundId) session(target, "prn_bound", facts ?? "");
    const bound = cookie === "1" ? `; os_bound_${boundId}=pst_${boundId}` : "";
    const principal = mine === "1" ? "prn_bound" : "prn_other";
    const headers = new Headers({
      authorization: "Bearer pst_bait",
      origin: origin === "1" ? ALLOWED : EVIL,
      "x-opensesame-session-id": boundId,
      cookie: `os=pst_cookie${bound}`,
      "x-opensesame-principal-id": named === "1" ? principal : "p".repeat(201),
    });
    if (proof === "1") headers.set("x-opensesame-session-proof", PROOF);
    // Only the named session may answer; the bait bearer and cookie never do.
    const seen = await outcome(true, headers);
    const label = seen === `prn_bound/${boundId}` ? "bound" : LABELS.get(seen);
    expect(label ?? "unexpected").toBe(row[9]);
  });

  it.each(group("credential", 4))("credential %s", async (_title, row) => {
    const [bearer, allow, require, cookie, expected] = row;
    const cookies = Object.entries(COOKIES).find(([name]) => name === cookie);
    const headers = new Headers(cookies?.[1]);
    // Every other label is its own token: pst_ok, pst_revoked and the prn_ ones.
    const token = table("none= other=garbage").get(bearer ?? "") ?? bearer;
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (require === "1") headers.set("x-opensesame-require-bearer", "1");
    const seen = await outcome(allow === "1", headers);
    expect(LABELS.get(seen) ?? "unexpected").toBe(expected);
  });
});

// AUTH-S1 storage refinement: the real DurableMap on a migrated PGlite database.
const sealer = createEventSealer("formal-correspondence-event-key-0123456789");
const ROWS = schema.oidcPayloads;
let client: PGlite;
let db: Database;
let models = 0;
const HOUR = 3_600_000;
const expiryOf = (label: string) =>
  label === "forever"
    ? null
    : new Date(Date.now() + (label === "past" ? -HOUR : HOUR));
function slot(row: typeof ROWS.$inferSelect | undefined) {
  if (!row) return "-";
  const value: string = decodeRecord(openOidcRow(sealer, row));
  const at = row.expiresAt?.getTime();
  return `${value}:${at === undefined ? "forever" : at < Date.now() ? "past" : "future"}`;
}
async function rowAt(model: string, id: string) {
  const rows = await db.select().from(ROWS).where(eq(ROWS.id, id));
  return slot(rows.find((row) => row.model === model));
}
/** A keyed row as `DurableMap` writes it; `L` is a pre-2026-11-23 legacy row. */
async function seed(model: string, key: string, value: string, expiry: string) {
  const legacy = value === "L";
  const payload = legacy
    ? { value: serialize(value).toString("base64") }
    : encodeRecord(model, key, value);
  const row = sealOidcRow(sealer, model, legacy ? digest(key) : key, payload);
  await db.insert(ROWS).values({ ...row, expiresAt: expiryOf(expiry) });
}

describe("Lean durable storage correspondence", () => {
  beforeAll(async () => {
    client = new PGlite();
    const folder = new URL(
      "../../../packages/database/drizzle",
      import.meta.url,
    );
    await migrate(drizzle(client), { migrationsFolder: folder.pathname });
    db = overlapCast(drizzle(client, { schema }));
  }, 120_000);
  afterAll(() => client?.close());

  it.each(group("storage", 3))("storage %s", async (_title, row) => {
    const [op, keyed, legacy, ...expected] = row;
    models += 1;
    const model = `OpenSesame:FormalStore${models}`;
    const map = new DurableMap<string>(db, model, true, null, 10, sealer);
    if (keyed !== "absent") await seed(model, "k", "K", keyed ?? "");
    if (legacy !== "absent") await seed(model, "k", "L", legacy ?? "");
    await seed(model, "o", "O", "future");
    const operations = {
      get: async () => (await map.get("k")) ?? "-",
      set: async () => {
        await map.set("k", "W");
        return "ok";
      },
      claim: async () => bit(await map.claim("k", "W")),
      delete: async () => bit(await map.delete("k")),
      take: async () => (await map.take("k")) ?? "-",
      adopt: async () => bit(await map.adoptLegacyRow("k")),
      migrate: async () => String(await rekeyKeys(map, ["k"])),
    };
    const run = Object.entries(operations).find(([name]) => name === op);
    const result = await run?.[1]();
    const ids = (key: string) => [
      oidcLookup(sealer, model, "id", key),
      legacyPrehashedRowId(sealer, model, key),
    ];
    const [keyedRow, legacyRow, other, otherLegacy] = await Promise.all(
      [...ids("k"), ...ids("o")].map((id) => rowAt(model, id)),
    );
    const untouched = other === "O:future" && otherLegacy === "-";
    const pending = String((await map.legacyRows()).length);
    const after = (await map.get("k")) ?? "-";
    const observed = [result, keyedRow, legacyRow, after, pending];
    expect([...observed, bit(untouched)]).toEqual(expected);
  });
});

// IDENTITY-TLS1: request evidence and listener trust generations.
const pki = createDisposablePki("formal-ca");
const client1 = pki.issueClient("client", { dns: ["client.example"] });
const ingress = pki.issueClient("ingress", { dns: ["ingress.example"] });
const base = new Date(Date.now() + 600_000);
const allowed = mappingBindings("client.example");
const allowing = parseServiceBindings(JSON.stringify(allowed));
const PURPOSE = [
  "identity_mapping_client",
  "principals.mapping.resolve",
] as const;
const policies = ["server_tls", "mtls_required", "trusted_ingress"] as const;
const GENERATIONS = { trustGeneration: 1, credentialGeneration: 1 };
/** How a peer reached the listener: directly, or asserted by an ingress. */
type Hop = Pick<AttestedPeer, "source" | "policy" | "ingress">;
const DIRECT: Hop = { source: "direct_tls", policy: "mtls_required" };
function attested(cert: Issued, state: string, hop = DIRECT) {
  if (state === "absent") return undefined;
  const at = new Date(base.getTime() - (state === "usable" ? 100 : 5_000));
  const leaf = { leaf: cert.cert, trustProfile: { name: "client_ca" } };
  const fixed = { listener: "identity-tls", tlsVersion: "tls13" } as const;
  const timing = { authenticatedAt: at, usableForMs: 1_000 };
  return attestPeer({ ...leaf, ...fixed, ...GENERATIONS, ...timing, ...hop });
}
afterAll(() => pki.cleanup());

describe("Lean transport evidence correspondence", () => {
  it.each(group("evidence", 6))("evidence %s", (_title, row) => {
    const [policy, current, peerAt, originAt, error, bind, ...expected] = row;
    const viaIngress = policy === "trusted_ingress";
    const peer = attested(viaIngress ? ingress : client1, peerAt ?? "");
    const hop: Hop = {
      source: "trusted_ingress_assertion",
      policy: "trusted_ingress",
    };
    if (peer) hop.ingress = peer;
    const originating = attested(client1, originAt ?? "", hop);
    const req = new IncomingMessage(new net.Socket());
    const tlsPolicy = policies.find((name) => name === policy);
    const provenance: ListenerProvenance = tlsPolicy
      ? {
          kind: "tls",
          listener: "identity-tls",
          policy: tlsPolicy,
          generation: 1,
        }
      : { kind: "plain", listener: "identity-plain" };
    const input: RecordEvidenceInput = {
      provenance,
      bindings: bind === "1" ? allowing : EMPTY_BINDINGS,
      clock: () => base,
      isCurrent: () => current === "1",
    };
    if (peer) input.peer = peer;
    if (originating) input.originating = originating;
    if (error === "1") input.originatingError = "forwarded evidence refused";
    const record = recordRequestEvidence(req, input);
    const admitted = record.admit(...PURPOSE);
    const chosen = bindingPeerOf(req);
    const party = chosen === originating ? "originating" : "peer";
    expect([
      bit(record.peer !== undefined),
      bit(record.originating !== undefined),
      admitted.ok ? "ok" : admitted.code,
      chosen === undefined ? "none" : party,
    ]).toEqual(expected);
    if (chosen !== undefined) expect([peer, originating]).toContain(chosen);
  });

  it.each(group("listener", 1))("listener %s", async (_title, row) => {
    const [sequence, ...expected] = row;
    const server = pki.issueServer("identity");
    const bindingsFile = `${pki.dir}/formal-bindings-${sequence}.json`;
    // A trust change alternates two binding documents; a credential-only
    // reload rewrites the same one.
    const peer = { dns_name: "other.example" };
    const other = { ...allowed.bindings[0], id: "other", peer };
    const documents = [JSON.stringify(allowed)];
    documents.push(JSON.stringify(mappingBindings("client.example", [other])));
    let version = 0;
    writeFileSync(bindingsFile, documents[version] ?? "");
    const config = {
      ...{ host: "127.0.0.1", port: 0, policy: "mtls_required" as const },
      ...{ certFile: server.certPath, keyFile: server.keyPath },
      ...{ clientCaFile: pki.caCertPath, serviceBindingsFile: bindingsFile },
      ...{ minVersion: "tls13" as const, trustProfile: "client_ca" },
    };
    let captured: IncomingMessage | undefined;
    const listener = createTransportListener({
      config,
      material: loadTransportMaterial(config, base),
      clock: () => base,
      dispatch: (req) => {
        captured = req;
      },
    });
    // The real listener handlers run on a socket Node reports as verified.
    const socket = new tls.TLSSocket(new net.Socket());
    socket.on("error", () => undefined);
    const verified = { authorized: true, getProtocol: () => "TLSv1.3" };
    const leaf = { getPeerX509Certificate: () => client1.cert };
    Object.assign(socket, verified, leaf);
    listener.server.emit("secureConnection", socket);
    const response: ServerResponse = overlapCast({});
    listener.server.emit("request", new IncomingMessage(socket), response);
    const record = captured && requestEvidenceOf(captured);
    let generations = GENERATIONS;
    for (const step of sequence === "-" ? [] : [...(sequence ?? "")]) {
      if (step === "t") version = 1 - version;
      writeFileSync(bindingsFile, documents[version] ?? "");
      generations = await listener.restartTransport();
    }
    const admitted = record?.admit(...PURPOSE);
    const stale = record?.peer === undefined;
    // Stale evidence is refused everywhere at once; current evidence admits.
    expect(peerOf(socket) === undefined).toBe(stale);
    expect(admitted?.ok).toBe(!stale);
    if (stale)
      expect(admitted).toEqual({ ok: false, code: "evidence_expired" });
    const { credentialGeneration: cred, trustGeneration: trust } = generations;
    const observed = [String(cred), String(trust), bit(stale)];
    expect([...observed, bit(socket.destroyed)]).toEqual(expected);
    await listener.close();
  });
});
