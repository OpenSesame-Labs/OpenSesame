import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("pages pwa serve binds PORT and optional HOST", () => {
  const source = readFileSync(
    new URL("./pages-pwa-serve.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /process\.env\.PORT \?\? "5180"/);
  assert.match(source, /process\.env\.HOST \?\? "localhost"/);
  assert.match(source, /server\.listen\(port, host/);
});
