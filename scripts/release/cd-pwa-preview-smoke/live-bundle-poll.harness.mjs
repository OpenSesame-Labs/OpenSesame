import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const pagesBase = "https://example.github.io/OpenSesame/";

export function manualClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
}

export function stageDist() {
  const root = mkdtempSync(join(tmpdir(), "pwa-shell-poll-"));
  const dist = join(root, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "assets", "preload.js"), "export const pre = 1;\n");
  writeFileSync(join(dist, "assets", "app.css"), "body{color:CanvasText}\n");
  writeFileSync(
    join(dist, "assets", "main.js"),
    "export const ready = true;\n",
  );
  writeFileSync(join(dist, "boot.js"), "window.__boot = true;\n");
  writeFileSync(
    join(dist, "index.html"),
    [
      "<!doctype html><html><head>",
      '<link rel="stylesheet" href="/OpenSesame/assets/app.css">',
      '<link rel="modulepreload" crossorigin href="/OpenSesame/assets/preload.js">',
      '<script type="module" crossorigin src="/OpenSesame/assets/main.js?release=1"></script>',
      '<script src="/OpenSesame/boot.js"></script>',
      '<link rel="modulepreload" href="/OpenSesame/assets/preload.js">',
      '<script src="https://cdn.example/remote.js"></script>',
      "</head><body></body></html>",
    ].join(""),
  );
  return { root, dist };
}

export function stageManyShellAssets(count) {
  const fixture = stageDist();
  let html = "<!doctype html><head>";
  for (let i = 0; i < count; i++) {
    writeFileSync(
      join(fixture.dist, `assets/${i}.js`),
      `export const n=${i};\n`,
    );
    html += `<link rel="modulepreload" href="/OpenSesame/assets/${i}.js">`;
  }
  writeFileSync(join(fixture.dist, "index.html"), `${html}</head>`);
  return fixture;
}

export function envFor(dist, extra = {}) {
  return {
    PAGES_URL: pagesBase,
    STAGED_DIST: dist,
    ...extra,
  };
}

export function hrefOf(url) {
  return url instanceof URL ? url.href : String(url);
}
