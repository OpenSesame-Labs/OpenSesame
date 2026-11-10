/**
 * Shared plumbing for the headless browser benchmark: the loopback dist
 * server, wall-clock timers, install-size measurement, and the empty row.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);

export function dirSizeBytes(root) {
  if (!existsSync(root)) return 0;
  const out = spawnSync("du", ["-sb", root], { encoding: "utf8" });
  if (out.status !== 0 || !out.stdout) return 0;
  const first = out.stdout.trim().split(/\s+/)[0];
  const n = Number(first);
  return Number.isFinite(n) ? n : 0;
}

export function timed(fn) {
  const start = Date.now();
  const value = fn();
  return { value, ms: Date.now() - start };
}

export async function timedAsync(fn) {
  const start = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - start };
}

export function resolveBenchDist() {
  const fromEnv = process.env.OPENSESAME_HEADLESS_BENCH_DIST;
  if (fromEnv !== undefined && existsSync(join(fromEnv, "index.html"))) {
    return resolve(fromEnv);
  }
  const pagesDist = join(repoRoot, "apps/pages/dist");
  if (existsSync(join(pagesDist, "index.html"))) return pagesDist;
  return null;
}

export async function serveDist(dist) {
  const base = "/OpenSesame/";
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.startsWith(base)) rel = rel.slice(base.length);
    if (rel === "" || rel.endsWith("/"))
      rel = `${rel}index.html`.replace(/\/+/g, "/");
    const file = join(dist, rel.replace(/^\//, ""));
    if (!file.startsWith(dist)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const body = await readFile(file);
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
    throw new Error("bench server failed to bind");
  }
  const origin = `http://127.0.0.1:${addr.port}`;
  return {
    origin,
    href: `${origin}${base}`,
    close: () =>
      new Promise((resolveClose) => {
        server.close(() => resolveClose(undefined));
      }),
  };
}

export function emptyRow(backend) {
  return {
    backend,
    install_bytes: 0,
    install_ms: 0,
    capture_ms: 0,
    dom_assert_ms: 0,
    screenshots_ok: false,
    dom_assert_ok: false,
    notes: "",
  };
}
