import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertPushWorkerCore, coreWorkerImport } from "./push-worker-core.mjs";

test("the push core URL is source-hash checked", (t) => {
  const dist = mkdtempSync(join(tmpdir(), "opensesame-push-core-"));
  t.after(() => rmSync(dist, { recursive: true }));
  writeFileSync(join(dist, "sw.js"), "core-v1");
  const first = coreWorkerImport(dist);
  writeFileSync(join(dist, "sw.js"), "core-v2");
  const second = coreWorkerImport(dist);
  assert.match(first.digest, /^[a-f0-9]{64}$/);
  assert.notEqual(first.digest, second.digest);
  assert.notEqual(first.url, second.url);
});

test("the emitted push worker keeps both enforced boundaries", () => {
  const expected = {
    digest: "a".repeat(64),
    url: `./sw.js?sha256=${"a".repeat(64)}`,
  };
  const source = `(()=>{self.__OPENSESAME_WORKER_VARIANT__="push";importScripts("${expected.url}")})();`;
  assert.doesNotThrow(() => assertPushWorkerCore(source, expected));
  assert.throws(
    () =>
      assertPushWorkerCore(source.replace(expected.url, "./sw.js"), expected),
    /lost its pinned core import/,
  );
  assert.throws(
    () =>
      assertPushWorkerCore(
        source.replace("__OPENSESAME_WORKER_VARIANT__", "variant"),
        expected,
      ),
    /lost its variant boundary/,
  );
  assert.throws(
    () =>
      assertPushWorkerCore(source.replace("importScripts", "load"), expected),
    /no longer imports the core/,
  );
  assert.throws(
    () => assertPushWorkerCore(`${source};self.__WB_MANIFEST=[]`, expected),
    /duplicated the core manifest/,
  );
  assert.throws(
    () => assertPushWorkerCore(source.slice(5, -5), expected),
    /lost its isolated wrapper/,
  );
});
