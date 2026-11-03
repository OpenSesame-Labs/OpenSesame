import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { serializeHurlVariables } from "./prepare-vars.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const sha = "d".repeat(40);
const version = "0.0.0-alpha.9";
const hurlBin = process.env.HURL_BIN ?? "hurl";

function hurlOutput(ran) {
  return `${ran.stderr ?? ""}\n${ran.stdout ?? ""}`;
}

function digestFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function stageDist(root) {
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(
    join(dist, "index.html"),
    "<!doctype html><title>OpenSesame</title>",
  );
  writeFileSync(join(dist, "os-runtime-config.json"), "{}");
  writeFileSync(
    join(dist, "manifest.webmanifest"),
    `${JSON.stringify({ name: "OpenSesame", start_url: "/OpenSesame/" })}\n`,
  );
  writeFileSync(
    join(dist, "sw.js"),
    `${"self.addEventListener('install', () => {});\n".repeat(4)}`,
  );
  writeFileSync(
    join(dist, "release.json"),
    `${JSON.stringify({
      format: "opensesame-pages-release",
      version: 1,
      revision: sha,
      sha256: {
        "index.html": digestFile(join(dist, "index.html")),
        "os-runtime-config.json": digestFile(
          join(dist, "os-runtime-config.json"),
        ),
      },
    })}\n`,
  );
  return dist;
}

test("serializeHurlVariables writes key=value lines for Hurl 8", () => {
  const text = serializeHurlVariables({
    pages_base: "https://example.github.io/OpenSesame/",
    github_sha: sha,
    expected_version: version,
    sha256_index: "aa".repeat(32),
  });
  assert.match(
    text,
    /^pages_base=https:\/\/example\.github\.io\/OpenSesame\/\n/m,
  );
  assert.doesNotMatch(text, /^\{/m);
});

test("run.mjs writes Hurl properties file not JSON", () => {
  const runSrc = readFileSync(join(here, "run.mjs"), "utf8");
  assert.match(runSrc, /vars\.properties/u);
  assert.match(runSrc, /serializeHurlVariables\(variables\)/u);
  assert.doesNotMatch(runSrc, /JSON\.stringify\(variables\)/u);
});

test("JSON variables file is rejected by Hurl (regression for cd-pwa smoke)", () => {
  const root = mkdtempSync(join(tmpdir(), "pwa-hurl-json-vars-"));
  const jsonPath = join(root, "vars.json");
  writeFileSync(
    jsonPath,
    `${JSON.stringify({ pages_base: "https://example.github.io/OpenSesame/" })}\n`,
  );
  const ran = spawnSync(
    hurlBin,
    [
      "--test",
      "--variables-file",
      jsonPath,
      "--retry",
      "0",
      "--connect-timeout",
      "2",
      join(here, "registry.hurl"),
    ],
    { encoding: "utf8" },
  );
  if (ran.error?.code === "ENOENT") {
    throw new Error(
      `${hurlBin} is required for Hurl templating regression tests`,
    );
  }
  assert.notEqual(ran.status, 0);
  assert.match(hurlOutput(ran), /Missing value for variable/i);
});

test("pages.hurl rejects Hurl-incompatible != null assertions", () => {
  const pagesHurl = readFileSync(join(here, "pages.hurl"), "utf8");
  assert.doesNotMatch(pagesHurl, /!=\s*null/u);
});

test("pages.hurl runs with properties variables against loopback dist", async () => {
  const root = mkdtempSync(join(tmpdir(), "pwa-hurl-loopback-"));
  const dist = stageDist(root);
  const server = createServer((req, res) => {
    const base = "/OpenSesame/";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.startsWith(base)) rel = rel.slice(base.length);
    if (rel === "" || rel.endsWith("/")) {
      rel = `${rel}index.html`.replace(/\/+/g, "/");
    }
    rel = rel.split("?")[0];
    const file = join(dist, rel.replace(/^\//, ""));
    try {
      const body = readFileSync(file);
      res.writeHead(200);
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolveListen, reject) => {
    server.listen(0, "127.0.0.1", () => resolveListen(undefined));
    server.on("error", reject);
  });
  const addr = server.address();
  if (addr === null || !("port" in addr)) {
    throw new Error("loopback server failed to bind");
  }
  const origin = `http://127.0.0.1:${addr.port}/OpenSesame/`;
  try {
    const vars = {
      pages_base: origin,
      github_sha: sha,
      expected_version: version,
      sha256_index: digestFile(join(dist, "index.html")),
      sha256_os_runtime: digestFile(join(dist, "os-runtime-config.json")),
      sha256_manifest: digestFile(join(dist, "manifest.webmanifest")),
      sha256_sw: digestFile(join(dist, "sw.js")),
    };
    const varPath = join(root, "vars.properties");
    writeFileSync(varPath, serializeHurlVariables(vars));
    const exitCode = await new Promise((resolveRun, rejectRun) => {
      let stderr = "";
      const child = spawn(
        hurlBin,
        [
          "--test",
          "--jobs",
          "1",
          "--variables-file",
          varPath,
          "--retry",
          "0",
          "--connect-timeout",
          "5",
          join(here, "pages.hurl"),
        ],
        { encoding: "utf8" },
      );
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        if (error.code === "ENOENT") {
          rejectRun(
            new Error(
              `${hurlBin} is required for Hurl templating regression tests`,
            ),
          );
          return;
        }
        rejectRun(error);
      });
      child.on("close", (code) => {
        if (code !== 0) {
          rejectRun(new Error(stderr || "pages.hurl loopback run failed"));
          return;
        }
        resolveRun(code);
      });
    });
    assert.equal(exitCode, 0);
  } finally {
    await new Promise((resolveClose) => {
      server.close(() => resolveClose(undefined));
    });
  }
});
