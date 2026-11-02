#!/usr/bin/env node
/**
 * Serve the built static PWA shipped in this npm package (`dist/`).
 */
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(packageRoot, "dist");
const port = Number(process.env.PORT ?? "5180");

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function resolvePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const relative = decoded === "/" ? "/index.html" : decoded;
  const candidate = normalize(join(distRoot, relative.replace(/^\//u, "")));
  if (!candidate.startsWith(distRoot)) {
    return null;
  }
  return candidate;
}

const server = createServer(async (request, response) => {
  const path = resolvePath(request.url ?? "/");
  if (!path || !existsSync(path)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const info = await stat(path);
  if (!info.isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const type = mime[extname(path)] ?? "application/octet-stream";
  response.writeHead(200, { "content-type": type });
  createReadStream(path).pipe(response);
});

server.listen(port, "localhost", () => {
  process.stdout.write(
    `OpenSesame Pages PWA at http://localhost:${port}/ (dist: ${distRoot})\n`,
  );
});
