/** Run file-selected KDF work away from the UI in a disposable worker. */
import { workerConstructor } from "../../../../ports.js";
import {
  type Argon2,
  type Argon2Options,
  KdbxImportError,
} from "./kdbx-argon2.js";

const DERIVATION_TIMEOUT_MS = 30_000;
let active = false;
let activeLoad = false;
let loadSignal: AbortSignal | undefined;

type Job =
  | { variant: "d" | "id"; options: Argon2Options }
  | {
      variant: "aes";
      options: { password: Uint8Array; salt: Uint8Array; rounds: number };
    };

function cancelled(): KdbxImportError {
  return new KdbxImportError("Opening this KeePass database was cancelled.");
}

export function throwIfKdbxCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}

/** The SDK does not carry operation identity into its KDF callbacks. */
export async function withKdbxLoad<T>(
  signal: AbortSignal | undefined,
  open: () => Promise<T>,
): Promise<T> {
  if (activeLoad || active)
    throw new KdbxImportError("Another KeePass database is already opening.");
  throwIfKdbxCancelled(signal);
  activeLoad = true;
  loadSignal = signal;
  try {
    const result = await open();
    throwIfKdbxCancelled(signal);
    return result;
  } finally {
    loadSignal = undefined;
    activeLoad = false;
  }
}

function requestWorker(
  isolated: Worker,
  job: Job,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const { options } = job;
  return new Promise<Uint8Array>((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      finish(new KdbxImportError("Opening this database took too long."));
    }, DERIVATION_TIMEOUT_MS);
    const onAbort = () => finish(cancelled());
    function finish(error: KdbxImportError | null, hash?: Uint8Array): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else if (hash) resolve(hash);
    }
    try {
      signal?.addEventListener("abort", onAbort, { once: true });
    } catch {
      finish(new KdbxImportError("The KeePass worker could not start."));
      return;
    }
    if (signal?.aborted) {
      onAbort();
      return;
    }
    isolated.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (
        typeof value === "object" &&
        value !== null &&
        "hash" in value &&
        value.hash instanceof ArrayBuffer &&
        value.hash.byteLength === 32
      ) {
        finish(null, new Uint8Array(value.hash));
      } else {
        finish(new KdbxImportError("This database could not be opened."));
      }
    };
    isolated.onerror = () => {
      finish(new KdbxImportError("The KeePass worker could not start."));
    };
    isolated.onmessageerror = () => {
      finish(new KdbxImportError("The KeePass worker could not respond."));
    };
    if (
      !(options.password instanceof Uint8Array) ||
      !(options.salt instanceof Uint8Array)
    ) {
      finish(new KdbxImportError("Invalid KeePass key derivation input."));
      return;
    }
    const password = new Uint8Array(options.password);
    const salt = new Uint8Array(options.salt);
    const parameters =
      job.variant === "aes"
        ? { rounds: job.options.rounds }
        : {
            parallelism: job.options.parallelism,
            iterations: job.options.iterations,
            memorySize: job.options.memorySize,
            hashLength: job.options.hashLength,
          };
    try {
      isolated.postMessage(
        {
          variant: job.variant,
          password: password.buffer,
          salt: salt.buffer,
          ...parameters,
        },
        [password.buffer, salt.buffer],
      );
    } catch {
      password.fill(0);
      salt.fill(0);
      finish(new KdbxImportError("The KeePass worker could not start."));
    }
  });
}

async function derive(job: Job): Promise<Uint8Array> {
  const signal = loadSignal;
  throwIfKdbxCancelled(signal);
  if (active) {
    throw new KdbxImportError("Another KeePass database is already opening.");
  }
  active = true;
  let worker: Worker | undefined;
  let result: Uint8Array | undefined;
  let failure: KdbxImportError | undefined;
  try {
    const Worker = workerConstructor();
    worker = new Worker(new URL("./kdbx-argon2.worker.ts", import.meta.url), {
      type: "module",
      name: "opensesame-kdbx-argon2",
    });
    result = await requestWorker(worker, job, signal);
  } catch (error) {
    failure =
      error instanceof KdbxImportError
        ? error
        : new KdbxImportError(
            "This browser cannot safely open this KeePass database.",
          );
  }
  try {
    worker?.terminate();
  } catch {
    // An unconfirmed stop cannot safely release the shared work slot.
    throw new KdbxImportError(
      "The KeePass worker could not stop safely. Reload this page before retrying.",
    );
  }
  active = false;
  if (failure) throw failure;
  if (!result) throw new KdbxImportError("This database could not be opened.");
  return result;
}

export const isolatedArgon2: { argon2d: Argon2; argon2id: Argon2 } = {
  argon2d: (options) => derive({ variant: "d", options }),
  argon2id: (options) => derive({ variant: "id", options }),
};

/** Matches the pinned kdbxweb encryptor used by both KDBX 3 and 4. */
export function isolatedAes(
  credentials: Uint8Array,
  key: Uint8Array | ArrayBuffer,
  rounds: number,
): Promise<Uint8Array> {
  const salt = key instanceof ArrayBuffer ? new Uint8Array(key) : key;
  if (
    !(credentials instanceof Uint8Array) ||
    credentials.byteLength !== 32 ||
    !(salt instanceof Uint8Array) ||
    salt.byteLength !== 32 ||
    !Number.isSafeInteger(rounds) ||
    rounds < 1 ||
    rounds > 1 << 24
  )
    throw new KdbxImportError("Invalid KeePass AES key derivation input.");
  return derive({
    variant: "aes",
    options: { password: credentials, salt, rounds },
  });
}
