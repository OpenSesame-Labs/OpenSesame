import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  tailscaleKindPrefix,
  tailscaleVendorStem,
} from "./provider-secret-patterns.mjs";
import {
  findTailscaleKeyMaterialViolations,
  isScannablePath,
} from "./tailscale-key-material-gate.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tailscale-material-"));
  return {
    root,
    write(relPath, text) {
      const absolute = join(root, relPath);
      mkdirSync(join(absolute, ".."), { recursive: true });
      writeFileSync(absolute, text);
      return relPath;
    },
    scan(files) {
      return findTailscaleKeyMaterialViolations({ root, files });
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("gate script names and pattern source omit the provider stem", () => {
  const stem = tailscaleVendorStem();
  const patterns = readFileSync(
    new URL("./provider-secret-patterns.mjs", import.meta.url),
    "utf8",
  );
  const names = readdirSync(new URL(".", import.meta.url));
  assert.equal(patterns.includes(`${stem}-`), false);
  for (const name of names) assert.equal(name.includes(stem), false, name);
});

test("the repository has no committed Tailscale key material", () => {
  const violations = findTailscaleKeyMaterialViolations();
  assert.deepEqual(violations, [], violations.join("\n"));
});

test("a source literal is reported with its path", () => {
  const dir = fixture();
  try {
    const secret = `${tailscaleKindPrefix("api")}abcd1234`;
    dir.write("src/example.ts", `export const key = "${secret}";\n`);
    assert.deepEqual(dir.scan(["src/example.ts"]), ["src/example.ts:1"]);
  } finally {
    dir.cleanup();
  }
});

test("pull-request prose that embeds key material fails", () => {
  const dir = fixture();
  try {
    const secret = `${tailscaleKindPrefix("client")}abcd1234`;
    const rel = ".github/pull_request_template.md";
    dir.write(rel, `Shipped a client secret ${secret} in the notes.\n`);
    assert.equal(isScannablePath(rel), true);
    assert.deepEqual(dir.scan([rel]), [`${rel}:1`]);
  } finally {
    dir.cleanup();
  }
});

test("a bare vendor separator without a kind is not key material", () => {
  const dir = fixture();
  try {
    const marker = `${tailscaleVendorStem()}-`;
    dir.write("src/check.rs", `assert!(!json.contains("${marker}"));\n`);
    assert.deepEqual(dir.scan(["src/check.rs"]), []);
  } finally {
    dir.cleanup();
  }
});

test("lockfiles and build directories are not scanned", () => {
  const secret = `${tailscaleKindPrefix("auth")}abcd1234`;
  const samples = [
    "package-lock.json",
    "Cargo.lock",
    "node_modules/pkg/index.js",
    "target/debug/out.rs",
    "dist/app.js",
  ];
  for (const path of samples) assert.equal(isScannablePath(path), false, path);
  const dir = fixture();
  try {
    for (const path of samples) dir.write(path, `const key = "${secret}";\n`);
    assert.deepEqual(dir.scan(samples), []);
  } finally {
    dir.cleanup();
  }
});
