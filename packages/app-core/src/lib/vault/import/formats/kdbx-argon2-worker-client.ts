/** Run the file-selected Argon2 work away from the UI in a disposable worker. */
import { workerConstructor } from "../../../../ports.js";
import {
  type Argon2,
  type Argon2Options,
  KdbxImportError,
} from "./kdbx-argon2.js";

const DERIVATION_TIMEOUT_MS = 30_000;
let active = false;

async function derive(
  variant: "d" | "id",
  options: Argon2Options,
): Promise<Uint8Array> {
  if (active) {
    throw new KdbxImportError("Another KeePass database is already opening.");
  }
  active = true;
  let worker: Worker | undefined;
  try {
    const Worker = workerConstructor();
    worker = new Worker(new URL("./kdbx-argon2.worker.ts", import.meta.url), {
      type: "module",
      name: "opensesame-kdbx-argon2",
    });
    const isolated = worker;
    return await new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        finish(new KdbxImportError("Opening this database took too long."));
      }, DERIVATION_TIMEOUT_MS);
      function finish(error: KdbxImportError | null, hash?: Uint8Array): void {
        clearTimeout(timer);
        if (error) reject(error);
        else if (hash) resolve(hash);
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
      try {
        isolated.postMessage(
          {
            variant,
            password: password.buffer,
            salt: salt.buffer,
            parallelism: options.parallelism,
            iterations: options.iterations,
            memorySize: options.memorySize,
            hashLength: options.hashLength,
          },
          [password.buffer, salt.buffer],
        );
      } catch {
        password.fill(0);
        salt.fill(0);
        finish(new KdbxImportError("The KeePass worker could not start."));
      }
    });
  } catch (error) {
    if (error instanceof KdbxImportError) throw error;
    throw new KdbxImportError(
      "This browser cannot safely open an Argon2 KeePass database.",
    );
  } finally {
    try {
      worker?.terminate();
    } finally {
      active = false;
    }
  }
}

export const isolatedArgon2: { argon2d: Argon2; argon2id: Argon2 } = {
  argon2d: (options) => derive("d", options),
  argon2id: (options) => derive("id", options),
};
