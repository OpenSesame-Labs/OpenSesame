import { writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import net from "node:net";
import { join } from "node:path";
import tls from "node:tls";
import { describe, expect, it } from "vitest";
import {
  type TransportListenerConfig,
  loadTransportMaterial,
} from "../config.js";
import { createTransportListener, peerOf } from "../listener.js";
import { identityMtlsTransport } from "../oauth-transport.js";
import {
  adoptRequestEvidence,
  bindingPeerOf,
  requestEvidenceOf,
} from "../request-evidence.js";
import { createDisposablePki, writeBindings } from "./pki.js";
import { mappingBindings } from "./server-helpers.js";
import { pinnedAgent, rawHandshake, tlsRequest } from "./tls-client.js";

const purpose = "identity_mapping_client";
const operation = "principals.mapping.resolve";

describe("identity trust rotation", () => {
  it("revokes cached socket and replay evidence, including pending handshakes, when the client CA changes", async () => {
    const pki = createDisposablePki();
    const server = pki.issueServer("identity");
    const oldClient = pki.issueClient("old", { dns: ["host.example"] });
    const newCa = pki.otherCa();
    const newClient = newCa.issueClient("new", { dns: ["host.example"] });
    const bindingsFile = writeBindings(pki, mappingBindings("host.example"));
    const config: TransportListenerConfig = {
      host: "127.0.0.1",
      port: 0,
      policy: "mtls_required",
      certFile: server.certPath,
      keyFile: server.keyPath,
      clientCaFile: pki.caCertPath,
      serviceBindingsFile: bindingsFile,
      minVersion: "tls13",
      trustProfile: "client_ca",
    };
    let original: IncomingMessage | undefined;
    const listener = createTransportListener({
      config,
      material: loadTransportMaterial(config),
      dispatch: (req, res) => {
        original = req;
        res.end("ok");
      },
    });
    const agent = pinnedAgent(pki.caCertPem, oldClient);
    try {
      const { port } = await listener.start();
      await tlsRequest({
        port,
        ca: pki.caCertPem,
        identity: oldClient,
        agent,
        path: "/",
      });
      if (!original) throw new Error("request was not dispatched");
      const request: IncomingMessage = original;
      const saved = requestEvidenceOf(request);
      const replay = {} as IncomingMessage;
      adoptRequestEvidence(replay, request);
      const oauth = identityMtlsTransport({
        listener: config,
        mappingAuth: "mtls",
        mappingAuthExplicit: true,
      });
      expect(peerOf(request.socket)).toBeDefined();
      expect(oauth?.peerOf(request.socket)).toBeDefined();
      expect(bindingPeerOf(replay)).toBeDefined();
      expect(saved?.admit(purpose, operation).ok).toBe(true);

      // The server has accepted TCP but the client has not begun TLS yet.
      const accepted = new Promise<void>((resolve) =>
        listener.server.once("connection", () => resolve()),
      );
      const pending = net.connect(port, "127.0.0.1");
      await accepted;
      const pendingClosed = new Promise<void>((resolve) =>
        pending.once("close", () => resolve()),
      );
      writeFileSync(pki.caCertPath, newCa.caCertPem);
      expect(await listener.restartTransport()).toEqual({
        credentialGeneration: 2,
        trustGeneration: 2,
      });
      await pendingClosed;

      expect(peerOf(request.socket)).toBeUndefined();
      expect(oauth?.peerOf(request.socket)).toBeUndefined();
      expect(saved?.peer).toBeUndefined();
      expect(saved?.admit(purpose, operation)).toEqual({
        ok: false,
        code: "evidence_expired",
      });
      expect(bindingPeerOf(replay)).toBeUndefined();
      expect(requestEvidenceOf(replay)?.admit(purpose, operation).ok).toBe(
        false,
      );
      expect(
        (await rawHandshake({ port, ca: pki.caCertPem, identity: oldClient }))
          .kind,
      ).not.toBe("http");
      expect(
        (await rawHandshake({ port, ca: pki.caCertPem, identity: newClient }))
          .kind,
      ).toBe("http");
    } finally {
      agent.destroy();
      await listener.close();
      pki.cleanup();
    }
  });

  it("rechecks bindings on a new connection after a binding change", async () => {
    const pki = createDisposablePki();
    const server = pki.issueServer("identity");
    const client = pki.issueClient("client", { dns: ["host.example"] });
    const bindingsFile = writeBindings(pki, mappingBindings("host.example"));
    const config: TransportListenerConfig = {
      host: "127.0.0.1",
      port: 0,
      policy: "mtls_required",
      certFile: server.certPath,
      keyFile: server.keyPath,
      clientCaFile: pki.caCertPath,
      serviceBindingsFile: bindingsFile,
      minVersion: "tls13",
      trustProfile: "client_ca",
    };
    let request: IncomingMessage | undefined;
    const listener = createTransportListener({
      config,
      material: loadTransportMaterial(config),
      dispatch: (req, res) => {
        request = req;
        res.end("ok");
      },
    });
    const agent = pinnedAgent(pki.caCertPem, client);
    try {
      const { port } = await listener.start();
      await tlsRequest({
        port,
        ca: pki.caCertPem,
        identity: client,
        agent,
        path: "/",
      });
      const prior = requestEvidenceOf(request);
      expect(prior?.admit(purpose, operation).ok).toBe(true);
      writeFileSync(
        bindingsFile,
        JSON.stringify({ revision: 2, bindings: [] }),
      );
      expect((await listener.restartTransport()).trustGeneration).toBe(2);
      expect(prior?.admit(purpose, operation).ok).toBe(false);
      await tlsRequest({
        port,
        ca: pki.caCertPem,
        identity: client,
        path: "/",
      });
      expect(requestEvidenceOf(request)?.admit(purpose, operation)).toEqual({
        ok: false,
        code: "peer_not_bound",
      });
    } finally {
      agent.destroy();
      await listener.close();
      pki.cleanup();
    }
  });

  it("invalidates forwarded evidence when originating trust changes", async () => {
    const pki = createDisposablePki();
    const server = pki.issueServer("identity");
    const ingress = pki.issueClient("edge", { dns: ["edge.example"] });
    const oldCa = pki.otherCa();
    const newCa = pki.otherCa();
    const oldClient = oldCa.issueClient("old-user", { dns: ["user.example"] });
    const newClient = newCa.issueClient("new-user", { dns: ["user.example"] });
    const trustFile = join(pki.dir, "origin-trust.pem");
    writeFileSync(trustFile, oldCa.caCertPem);
    const bindingsFile = writeBindings(pki, {
      revision: 1,
      bindings: [
        {
          id: "edge",
          revision: 1,
          enabled: true,
          revoked: false,
          scope: "deployment",
          trust_profile: { name: "client_ca" },
          peer: { dns_name: "edge.example" },
          service_principal: "svc_edge",
          purpose: "trusted_ingress",
          allowed_operations: ["ingress.forward"],
          allowed_audiences: [],
          not_after: null,
          denied_thumbprints: [],
        },
        ...["edge.example", "user.example"].map((dns) => {
          const set = mappingBindings(dns) as { bindings: object[] };
          return { ...set.bindings[0], id: `mapping-${dns.split(".")[0]}` };
        }),
      ],
    });
    const config: TransportListenerConfig = {
      host: "127.0.0.1",
      port: 0,
      policy: "trusted_ingress",
      certFile: server.certPath,
      keyFile: server.keyPath,
      clientCaFile: pki.caCertPath,
      serviceBindingsFile: bindingsFile,
      ingressOriginatingTrustFile: trustFile,
      minVersion: "tls13",
      trustProfile: "client_ca",
    };
    let request: IncomingMessage | undefined;
    const listener = createTransportListener({
      config,
      material: loadTransportMaterial(config),
      dispatch: (req, res) => {
        request = req;
        res.end("ok");
      },
    });
    const agent = pinnedAgent(pki.caCertPem, ingress);
    const header = (der: Buffer) => `:${der.toString("base64")}:`;
    try {
      const { port } = await listener.start();
      await tlsRequest({
        port,
        ca: pki.caCertPem,
        identity: ingress,
        agent,
        path: "/",
        headers: { "client-cert": header(oldClient.cert.raw) },
      });
      const prior = request;
      expect(bindingPeerOf(prior)?.leafThumbprintSha256()).toBe(
        oldClient.thumbHex,
      );
      expect(requestEvidenceOf(prior)?.admit(purpose, operation).ok).toBe(true);
      writeFileSync(trustFile, newCa.caCertPem);
      expect((await listener.restartTransport()).trustGeneration).toBe(2);
      expect(bindingPeerOf(prior)).toBeUndefined();
      await tlsRequest({
        port,
        ca: pki.caCertPem,
        identity: ingress,
        path: "/",
        headers: { "client-cert": header(oldClient.cert.raw) },
      });
      expect(bindingPeerOf(request)).toBeUndefined();
      expect(requestEvidenceOf(request)?.admit(purpose, operation)).toEqual({
        ok: false,
        code: "forwarded_evidence_unverified",
      });
      await tlsRequest({
        port,
        ca: pki.caCertPem,
        identity: ingress,
        path: "/",
        headers: { "client-cert": header(newClient.cert.raw) },
      });
      expect(bindingPeerOf(request)?.leafThumbprintSha256()).toBe(
        newClient.thumbHex,
      );
      expect(requestEvidenceOf(request)?.admit(purpose, operation).ok).toBe(
        true,
      );
      await tlsRequest({
        port,
        ca: pki.caCertPem,
        identity: ingress,
        path: "/",
      });
      expect(requestEvidenceOf(request)?.admit(purpose, operation)).toEqual({
        ok: false,
        code: "peer_not_bound",
      });
    } finally {
      agent.destroy();
      await listener.close();
      pki.cleanup();
    }
  });

  it("retains TLS protocol and session restrictions after a credential-only reload", async () => {
    const pki = createDisposablePki();
    const server = pki.issueServer("identity");
    const client = pki.issueClient("client");
    const config: TransportListenerConfig = {
      host: "127.0.0.1",
      port: 0,
      policy: "mtls_required",
      certFile: server.certPath,
      keyFile: server.keyPath,
      clientCaFile: pki.caCertPath,
      minVersion: "tls13",
      trustProfile: "client_ca",
    };
    const listener = createTransportListener({
      config,
      material: loadTransportMaterial(config),
      dispatch: (_req, res) => res.end("ok"),
    });
    try {
      const { port } = await listener.start();
      expect(await listener.restartTransport()).toEqual({
        credentialGeneration: 2,
        trustGeneration: 1,
      });
      const tls12Accepted = await new Promise<boolean>((resolve) => {
        const socket = tls.connect({
          host: "127.0.0.1",
          port,
          ca: pki.caCertPem,
          cert: client.certPem,
          key: client.keyPem,
          minVersion: "TLSv1.2",
          maxVersion: "TLSv1.2",
        });
        socket.once("secureConnect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => {
          socket.destroy();
          resolve(false);
        });
      });
      expect(tls12Accepted).toBe(false);
      const first = await rawHandshake({
        port,
        ca: pki.caCertPem,
        identity: client,
      });
      expect(first.kind).toBe("http");
      if (first.kind !== "http") throw new Error("handshake failed");
      expect(first.session).toBeDefined();
      const second = await rawHandshake({
        port,
        ca: pki.caCertPem,
        identity: client,
        ...(first.session ? { session: first.session } : {}),
      });
      expect(second.kind).toBe("http");
      if (second.kind === "http") expect(second.reused).toBe(false);
    } finally {
      await listener.close();
      pki.cleanup();
    }
  });
});
