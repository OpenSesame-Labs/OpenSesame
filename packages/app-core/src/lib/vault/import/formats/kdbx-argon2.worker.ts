/// <reference lib="webworker" />

import { argon2d, argon2id } from "hash-wasm";
import { KeyEncryptorAes } from "kdbxweb";

type Argon2Work = {
  variant: "d" | "id";
  password: ArrayBuffer;
  salt: ArrayBuffer;
  parallelism: number;
  iterations: number;
  memorySize: number;
  hashLength: number;
};
type AesWork = {
  variant: "aes";
  password: ArrayBuffer;
  salt: ArrayBuffer;
  rounds: number;
};

self.addEventListener(
  "message",
  (event: MessageEvent<Argon2Work | AesWork>) => {
    void (async () => {
      const work = event.data;
      const { password, salt } = work;
      const passwordBytes = new Uint8Array(password);
      const saltBytes = new Uint8Array(salt);
      try {
        if (work.variant === "aes" && !globalThis.crypto?.subtle)
          throw new Error("WebCrypto is required for KeePass AES derivation.");
        const hash =
          work.variant === "aes"
            ? await KeyEncryptorAes.encrypt(
                passwordBytes,
                saltBytes,
                work.rounds,
              )
            : await (work.variant === "id" ? argon2id : argon2d)({
                parallelism: work.parallelism,
                iterations: work.iterations,
                memorySize: work.memorySize,
                hashLength: work.hashLength,
                password: passwordBytes,
                salt: saltBytes,
                outputType: "binary",
              });
        const result = new Uint8Array(hash);
        hash.fill(0);
        self.postMessage({ hash: result.buffer }, [result.buffer]);
      } catch {
        self.postMessage({ error: true });
      } finally {
        passwordBytes.fill(0);
        saltBytes.fill(0);
      }
    })();
  },
);
