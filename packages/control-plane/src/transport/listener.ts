/**
 * The Identity plane's optional native TLS listener (ID-LISTENER).
 *
 * `https.createServer` is a `tls.Server` with the HTTP/1.1 parser attached,
 * so the same raw dispatcher that serves the plain `http.Server` serves
 * here: OAuth protocol paths and Hono alike see one request object whose
 * socket is the `TLSSocket` the handshake ran on.
 *
 * Peer evidence is built on `secureConnection` from what Node verified —
 * `socket.authorized === true` plus `socket.getPeerX509Certificate()` — and
 * kept in a module-private `WeakMap<TLSSocket, VerifiedPeer>` reachable only
 * through {@link peerOf}. Nothing about a request (headers, body, query) can
 * insert into it, and the plain listener never registers anything.
 *
 * Session state on the client-authenticating profiles is a product choice
 * (CONTRACT §4): stateless tickets are off (`SSL_OP_NO_TICKET`), the
 * `resumeSession` hook answers "no session" so the stateful path cannot
 * resume either, and `sessionTimeout` is the one-second floor. Node 24 has
 * no switch that turns the OpenSSL server cache off outright; this trio is
 * what it supports, and the listener test asserts `isSessionReused()` is
 * false on a reconnect that offers the previous session.
 */
import { constants as cryptoConstants } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import type { AddressInfo, Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import {
  type TransportListenerConfig,
  type TransportMaterial,
  loadTransportMaterial,
} from "./config.js";
import { resolveOriginating } from "./ingress.js";
import { stripForwardedEvidence } from "./ingress-evidence-adapter.js";
import {
  type TlsVersion,
  type VerifiedPeer,
  attestPeer,
} from "./peer-evidence.js";
import {
  type RequestEvidence,
  recordRequestEvidence,
} from "./request-evidence.js";
import type { ServiceBindingSet } from "./service-admission.js";

export const TLS_LISTENER_ID = "identity-tls";
export const PLAIN_LISTENER_ID = "identity-plain";
/** `usable_until` bound for direct peers: an hour, or the cert's remainder. */
export const DEFAULT_USABLE_FOR_MS = 60 * 60 * 1000;

const peers = new WeakMap<
  Socket,
  { peer: VerifiedPeer; current: () => boolean }
>();

/**
 * The verified peer of a Node socket, or none.
 *
 * Callers that receive an unparsed socket parse it to `Socket` at that
 * boundary. A plain listener, a missing client certificate, and a socket
 * this registry does not hold all resolve to none.
 */
export function peerOf(socket: Socket): VerifiedPeer | undefined {
  const entry = peers.get(socket);
  return entry?.current() ? entry.peer : undefined;
}

export type RawDispatcher = (req: IncomingMessage, res: ServerResponse) => void;

/** Credential and trust generations after a reload. */
export interface TransportGenerations {
  credentialGeneration: number;
  trustGeneration: number;
}

export interface TransportListener {
  server: https.Server;
  config: TransportListenerConfig;
  /** Current in-memory binding set (from the bindings file at last load). */
  bindings(): ServiceBindingSet;
  /** Bind and resolve with the address. */
  start(): Promise<AddressInfo>;
  /**
   * Explicit renewal (ID-ROTATION): re-read and re-validate key, cert, CA and
   * bindings, then swap the secure context. Server-certificate-only renewal
   * leaves established connections alone. A client trust, ingress trust, or
   * binding change invalidates old evidence and closes existing connections,
   * including handshakes in progress. A rejected candidate changes nothing.
   */
  restartTransport(): Promise<TransportGenerations>;
  credentialGeneration(): number;
  trustGeneration(): number;
  close(): Promise<void>;
}

function tlsVersionOf(socket: TLSSocket): TlsVersion {
  return socket.getProtocol() === "TLSv1.2" ? "tls12" : "tls13";
}

export interface CreateTransportListenerOptions {
  config: TransportListenerConfig;
  material: TransportMaterial;
  dispatch: RawDispatcher;
  clock?: () => Date;
  usableForMs?: number;
  onPeerError?: (code: string) => void;
}

/** Mutable listener state shared by the helpers below. */
interface ListenerState {
  config: TransportListenerConfig;
  material: TransportMaterial;
  clock: () => Date;
  usableForMs: number;
  credentialGeneration: number;
  trustGeneration: number;
  connections: Set<Socket>;
  onPeerError?: ((code: string) => void) | undefined;
}

function secureContextOf(material: TransportMaterial) {
  return {
    cert: material.certPem,
    key: material.keyPem,
    ...(material.clientCaPem ? { ca: material.clientCaPem } : undefined),
  };
}

function serverOptions(
  config: TransportListenerConfig,
  material: TransportMaterial,
): https.ServerOptions {
  const clientAuth = config.policy !== "server_tls";
  return {
    ...secureContextOf(material),
    requestCert: clientAuth,
    rejectUnauthorized: clientAuth,
    minVersion: config.minVersion === "tls12" ? "TLSv1.2" : "TLSv1.3",
    secureOptions: cryptoConstants.SSL_OP_NO_TICKET,
    sessionTimeout: 1,
    handshakeTimeout: 10_000,
    ALPNProtocols: ["http/1.1"],
    maxHeaderSize: 16 * 1024,
    keepAliveTimeout: 5_000,
    headersTimeout: 15_000,
    requestTimeout: 30_000,
  };
}

/** `secureConnection`: register what Node verified, or serve nothing. */
function registerPeer(state: ListenerState, socket: TLSSocket): void {
  if (state.config.policy === "server_tls" || socket.authorized !== true) {
    return;
  }
  const leaf = socket.getPeerX509Certificate();
  if (!leaf) return;
  try {
    const peer = attestPeer({
      source: "direct_tls",
      leaf,
      trustProfile: { name: state.config.trustProfile },
      trustGeneration: state.trustGeneration,
      credentialGeneration: state.credentialGeneration,
      listener: TLS_LISTENER_ID,
      policy: state.config.policy,
      tlsVersion: tlsVersionOf(socket),
      authenticatedAt: state.clock(),
      usableForMs: state.usableForMs,
    });
    peers.set(socket, {
      peer,
      current: () =>
        peer.trustGeneration() === state.trustGeneration &&
        peer.usableAt(state.clock()),
    });
  } catch (error) {
    // A peer we cannot attest is a peer we do not serve.
    state.onPeerError?.(error instanceof Error ? error.message : "attest");
    socket.destroy();
  }
}

/** Record this request's evidence before the dispatcher sees it. */
function prepareRequest(
  state: ListenerState,
  req: IncomingMessage,
): RequestEvidence {
  // SAFETY: the https.Server contract delivers this request on the TLSSocket the handshake ran on.
  const socket: TLSSocket = req.socket as TLSSocket;
  const peer = peerOf(socket);
  const trustGeneration = state.trustGeneration;
  const base = {
    provenance: {
      kind: "tls" as const,
      listener: TLS_LISTENER_ID,
      policy: state.config.policy,
      generation: state.credentialGeneration,
    },
    bindings: state.material.bindings,
    clock: state.clock,
    isCurrent: () => state.trustGeneration === trustGeneration,
    ...(peer ? { peer } : undefined),
  };
  if (state.config.policy !== "trusted_ingress") {
    stripForwardedEvidence(req);
    return recordRequestEvidence(req, base);
  }
  const resolved = resolveOriginating({
    rawHeaders: req.rawHeaders,
    ingressPeer: peer,
    bindings: state.material.bindings,
    trustPem: state.material.ingressTrustPem ?? "",
    listener: TLS_LISTENER_ID,
    trustProfile: state.config.trustProfile,
    trustGeneration: state.trustGeneration,
    credentialGeneration: state.credentialGeneration,
    tlsVersion: tlsVersionOf(socket),
    now: state.clock(),
    usableForMs: state.usableForMs,
  });
  if (resolved.kind === "verified") {
    return recordRequestEvidence(req, {
      ...base,
      originating: resolved.originating,
    });
  }
  if (resolved.kind === "refused") {
    return recordRequestEvidence(req, {
      ...base,
      originatingError: resolved.error,
    });
  }
  return recordRequestEvidence(req, base);
}

/** ID-ROTATION: validate the candidate whole, then swap atomically. */
function restart(
  state: ListenerState,
  server: https.Server,
): TransportGenerations {
  const candidate = loadTransportMaterial(state.config, state.clock());
  const trustChanged =
    candidate.clientCaPem !== state.material.clientCaPem ||
    candidate.ingressTrustPem !== state.material.ingressTrustPem ||
    JSON.stringify(candidate.bindings) !==
      JSON.stringify(state.material.bindings);
  // setSecureContext resets TLS options as well as credentials. Preserve the
  // configured minimum protocol and disabled tickets across every renewal.
  server.setSecureContext(serverOptions(state.config, candidate));
  state.material = candidate;
  state.credentialGeneration += 1;
  if (trustChanged) {
    state.trustGeneration += 1;
    // Include raw sockets: a handshake started under the previous context
    // must not finish later and be attested under the new trust generation.
    for (const socket of state.connections) socket.destroy();
  }
  return {
    credentialGeneration: state.credentialGeneration,
    trustGeneration: state.trustGeneration,
  };
}

function bind(server: https.Server, config: TransportListenerConfig) {
  return new Promise<AddressInfo>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      // SAFETY: Node's listening TCP server contract reports an AddressInfo.
      resolve(server.address() as AddressInfo);
    });
  });
}

/** Build the listener. `start()` binds it. */
export function createTransportListener(
  options: CreateTransportListenerOptions,
): TransportListener {
  const state: ListenerState = {
    config: options.config,
    material: options.material,
    clock: options.clock ?? (() => new Date()),
    usableForMs: options.usableForMs ?? DEFAULT_USABLE_FOR_MS,
    credentialGeneration: 1,
    trustGeneration: 1,
    connections: new Set(),
    onPeerError: options.onPeerError,
  };
  const server = https.createServer(
    serverOptions(state.config, state.material),
    (req, res) => {
      prepareRequest(state, req);
      options.dispatch(req, res);
    },
  );
  server.on(
    "resumeSession",
    (_id: Buffer, done: (err: null, data: null) => void) => done(null, null),
  );
  const track = (socket: Socket) => {
    state.connections.add(socket);
    socket.once("close", () => state.connections.delete(socket));
  };
  server.on("connection", track);
  server.on("secureConnection", (socket: TLSSocket) => {
    track(socket);
    registerPeer(state, socket);
  });
  return {
    server,
    config: state.config,
    bindings: () => state.material.bindings,
    credentialGeneration: () => state.credentialGeneration,
    trustGeneration: () => state.trustGeneration,
    start: () => bind(server, state.config),
    restartTransport: async () => restart(state, server),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeIdleConnections();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Evidence for a request on the plain listener: provenance only, no peer. */
export function preparePlainRequest(
  req: IncomingMessage,
  bindings: ServiceBindingSet,
  clock?: () => Date,
): RequestEvidence {
  stripForwardedEvidence(req);
  return recordRequestEvidence(req, {
    provenance: { kind: "plain", listener: PLAIN_LISTENER_ID },
    bindings,
    ...(clock ? { clock } : undefined),
  });
}
