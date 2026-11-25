import type { BoundaryValue } from "@opensesame/os-domain";
import {
  type BitwardenNativeConfiguration,
  createBitwardenNativeBackend,
} from "./bitwarden-native.js";
import type { BitwardenKdfResourceLimits } from "./bitwarden-native-kdf.js";
import {
  NativeWorkerReply,
  NativeWorkerRequest,
  type NativeWorkerSettings,
  NativeWorkerValue,
} from "./bitwarden-native-worker-protocol.js";
import {
  type SecretBackendTransport,
  guardSecretBackendTransport,
} from "./transport.js";
import {
  type SecretBackend,
  SecretBackendError,
  type SecretBackendSession,
} from "./types.js";

export type BitwardenNativeWorkerPort = {
  send(value: NativeWorkerReply): void;
  close(): void;
};
function configuration(
  settings: NativeWorkerSettings,
): BitwardenNativeConfiguration {
  return {
    ...settings,
    mode: "bitwarden-api",
    token: "",
    projectId: "",
    organizationId: "",
    environment: "",
    secretPath: "",
    passwordListId: "",
    fileFormat: "",
  };
}
function stale(): SecretBackendError {
  return new SecretBackendError(
    "stale",
    "The native Bitwarden worker session ended. Connect again.",
  );
}
function failure(id: number, error: BoundaryValue): NativeWorkerReply {
  return error instanceof SecretBackendError
    ? { id, ok: false, code: error.code, message: error.message }
    : {
        id,
        ok: false,
        code: "response",
        message:
          "The native Bitwarden worker could not complete this operation.",
      };
}
function success(id: number, value: BoundaryValue): NativeWorkerReply {
  const result = NativeWorkerValue.parse(value);
  if (
    new TextEncoder().encode(JSON.stringify(result)).length >
    64 * 1024 * 1024
  )
    throw stale();
  return NativeWorkerReply.parse({ id, ok: true, value: result });
}
/** What the worker may do next. Each phase only ever moves forward. */
type WorkerState =
  | { readonly phase: "awaiting-initialize" }
  | { readonly phase: "initializing" }
  | {
      readonly phase: "ready";
      readonly backend: SecretBackend;
      readonly session: SecretBackendSession;
    }
  | { readonly phase: "ended" };
type ReadyCommand = Exclude<
  NativeWorkerRequest,
  { type: "initialize" } | { type: "dispose" }
>;
type WorkerOperation = () => Promise<BoundaryValue>;

function createOperationRunner(
  port: BitwardenNativeWorkerPort,
  currentState: () => WorkerState,
  check: () => void,
  close: () => void,
) {
  let active = 0;
  let queue = Promise.resolve();
  return {
    active: () => active,
    run(id: number, operation: WorkerOperation): void {
      active++;
      queue = queue
        .then(async () => {
          try {
            const result = await operation();
            check();
            port.send(success(id, result));
          } catch (error) {
            if (currentState().phase !== "ended")
              port.send(
                failure(id, error instanceof Error ? error : undefined),
              );
            const state = currentState();
            // A failed initialization, or a session the provider ended, is final.
            if (state.phase !== "ready" || state.session.signal?.aborted)
              close();
          } finally {
            active--;
          }
        })
        .catch(close);
    },
  };
}
async function invoke(
  backend: SecretBackend,
  session: SecretBackendSession,
  request: ReadyCommand,
) {
  switch (request.type) {
    case "list":
      return backend.listItems(session);
    case "get":
      return backend.getItem(request.selector, session);
    case "notes":
      return backend.getNotes(request.selector, session);
    case "create":
      if (!backend.createItem) throw stale();
      return backend.createItem(request.item, session);
    case "update":
      if (!backend.updateItem) throw stale();
      return backend.updateItem(request.itemId, request.item, session);
    case "delete":
      if (!backend.deleteItem) throw stale();
      await backend.deleteItem(request.itemId, session);
      return null;
  }
}
/**
 * A dedicated worker's messages come only from the page that constructed it:
 * same origin (or the opaque "" a dedicated worker reports), no `source`
 * window, and no transferred ports. Anything else is not the owner.
 */
export function isWorkerOwnerMessage(
  event: Pick<MessageEvent, "origin" | "source" | "ports">,
  ownOrigin: string,
): boolean {
  return (
    (event.origin === "" || event.origin === ownOrigin) &&
    event.source === null &&
    event.ports.length === 0
  );
}
/**
 * Install inside a disposable worker. The host passes a captured fetch port,
 * never ambient fetch, and forwards only messages `isWorkerOwnerMessage`
 * accepted. The runtime is a one-way state machine: exactly one schema-valid
 * `initialize` is admitted, only while awaiting it; every other message before
 * the session is ready, and any second `initialize`, ends the worker.
 */
export function createBitwardenNativeWorkerRuntime(
  port: BitwardenNativeWorkerPort,
  transport: SecretBackendTransport,
  limits: BitwardenKdfResourceLimits,
) {
  const owner = new AbortController();
  const captured = guardSecretBackendTransport(
    transport,
    undefined,
    owner.signal,
  );
  let state: WorkerState = { phase: "awaiting-initialize" };
  let lastId = 0;
  const phase = (): WorkerState["phase"] => state.phase;
  const check = () => {
    if (phase() === "ended") throw stale();
    captured.assertCurrent();
  };
  const dispose = async () => {
    const prior = state;
    if (prior.phase === "ended") return;
    state = { phase: "ended" };
    owner.abort();
    transport.signal.removeEventListener("abort", close);
    try {
      if (prior.phase === "ready")
        await prior.backend.disconnect(prior.session);
    } finally {
      port.close();
    }
  };
  const close = () => {
    void dispose().catch(() => undefined);
  };
  transport.signal.addEventListener("abort", close, { once: true });
  // Runs only from the admitted transition out of "awaiting-initialize".
  const initialize = async (settings: NativeWorkerSettings) => {
    if (phase() !== "initializing") throw stale();
    const backend = createBitwardenNativeBackend(captured, limits);
    let session: SecretBackendSession;
    try {
      session = await backend.authenticate(configuration(settings));
    } finally {
      settings.masterPassword = "";
      settings.clientSecret = "";
    }
    if (phase() !== "initializing") {
      await backend.disconnect(session).catch(() => undefined);
      throw stale();
    }
    check();
    state = { phase: "ready", backend, session };
    return null;
  };
  const command = async (request: ReadyCommand) => {
    const current = state;
    if (current.phase !== "ready" || current.session.signal?.aborted)
      throw stale();
    return invoke(current.backend, current.session, request);
  };
  /** The only transitions: each admitted message yields its single operation. */
  const admit = (
    request: NativeWorkerRequest,
  ): (() => Promise<BoundaryValue>) | undefined => {
    switch (request.type) {
      case "initialize": {
        if (phase() !== "awaiting-initialize") return undefined;
        state = { phase: "initializing" };
        const { settings } = request;
        return () => initialize(settings);
      }
      case "dispose":
        return undefined;
      default:
        return phase() === "ready" ? () => command(request) : undefined;
    }
  };
  const runner = createOperationRunner(port, () => state, check, close);
  return {
    dispose,
    receive(value: BoundaryValue): void {
      if (phase() === "ended") return;
      const parsed = NativeWorkerRequest.safeParse(value);
      if (!parsed.success || parsed.data.id <= lastId || runner.active() >= 4) {
        close();
        return;
      }
      lastId = parsed.data.id;
      const operation = admit(parsed.data);
      if (operation) runner.run(parsed.data.id, operation);
      else close();
    },
  };
}
