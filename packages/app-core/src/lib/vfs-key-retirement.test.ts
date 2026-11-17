import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("does not retain a retired vault key through a held lifetime check", () => {
  const script = `
    import { lockTomb, requireTombCheck, unlockTomb } from './packages/app-core/src/lib/vfs.ts';
    const held = await (async () => {
      const key = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
      );
      const weak = new WeakRef(key);
      unlockTomb('retirement-test', key);
      const check = requireTombCheck('retirement-test');
      check();
      lockTomb('retirement-test');
      return { weak, check };
    })();
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise((resolve) => setImmediate(resolve));
      globalThis.gc();
      if (held.weak.deref() === undefined) {
        try { held.check(); } catch { process.exit(0); }
        throw new Error('A retired check was accepted');
      }
    }
    throw new Error('A retired check retained its vault key');
  `;
  const result = spawnSync(
    process.execPath,
    ["--expose-gc", "--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  expect(result.status, result.error?.message ?? result.stderr).toBe(0);
});
