/// <reference lib="webworker" />

import { argon2d, argon2id } from "hash-wasm";

type Work = {
  variant: "d" | "id";
  password: ArrayBuffer;
  salt: ArrayBuffer;
  parallelism: number;
  iterations: number;
  memorySize: number;
  hashLength: number;
};

self.addEventListener("message", (event: MessageEvent<Work>) => {
  void (async () => {
    const { variant, password, salt, ...parameters } = event.data;
    const passwordBytes = new Uint8Array(password);
    const saltBytes = new Uint8Array(salt);
    try {
      const hash = await (variant === "id" ? argon2id : argon2d)({
        ...parameters,
        password: passwordBytes,
        salt: saltBytes,
        outputType: "binary",
      });
      self.postMessage({ hash: new Uint8Array(hash).buffer });
    } catch {
      self.postMessage({ error: true });
    } finally {
      passwordBytes.fill(0);
      saltBytes.fill(0);
    }
  })();
});
