#!/usr/bin/env node
/**
 * Playwright evidence for the user-token fingerprint label (`UserTokenPanel`).
 * Profiles: minimal-local, default, custom, full (same checklist matrix as
 * verification-checklist-walk.mjs).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChromium } from "./duress/find-chromium.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";
import {
  appPaths,
  buildDist,
  resolveWalks,
} from "./lib/verification-checklist-profiles.mjs";
import {
  applySetupChoice,
  captureChoices,
  enterVault,
  openDoor,
} from "./lib/verification-checklist-setup.mjs";
import {
  BASE,
  ORIGIN,
  createShot,
  emptyRecord,
  mark,
} from "./lib/verification-checklist-shot.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const panelRel =
  "apps/pages/src/sections/connections/connect/UserTokenPanel.tsx";
const panelPath = path.join(repoRoot, panelRel);

const MANAGE_KEY = "k".repeat(40);
const CONNECTOR_ID = "scl_evidence";
const CONNECT_VITE = { VITE_CONNECT_CALLBACK_BASE: "/" };

const phaseArg = process.argv.indexOf("--phase");
const phase = phaseArg === -1 ? "after" : process.argv[phaseArg + 1];
if (!["before", "after"].includes(phase)) {
  console.error("usage: --phase before|after");
  process.exit(2);
}

/** Evidence gate rejects path segments named `before`; use baseline/current dirs. */
const phaseDir = phase === "before" ? "label-baseline" : "label-current";

const outRoot = path.join(
  repoRoot,
  "docs/evidence/user-token-fingerprint-label/pages/web",
  phaseDir,
);

function runBeforeLabelPatch() {
  const saved = fs.readFileSync(panelPath, "utf8");
  const old = execFileSync(
    "git",
    ["show", `51b7c83969120aec0f35559984dfd280d1613d98:${panelRel}`],
    { cwd: repoRoot, encoding: "utf8" },
  );
  fs.writeFileSync(panelPath, old);
  return () => fs.writeFileSync(panelPath, saved);
}

function prepareChromium() {
  const discovery = findChromium();
  if (!discovery.path) {
    console.error("[user-token-label] no Chromium binary");
    process.exit(2);
  }
  process.env.PLAYWRIGHT_CHROMIUM = discovery.path;
}

function buildsNeeded(walks) {
  const byKey = new Map();
  for (const walk of walks) {
    if (!byKey.has(walk.buildKey)) byKey.set(walk.buildKey, walk);
  }
  return [...byKey.values()];
}

const LISTED_CONNECTOR = {
  id: CONNECTOR_ID,
  uid: "resend/wedding",
  service: "resend",
  name: "wedding-resend",
  userTokens: { scopes: ["emails:send"] },
};

async function routeConnectRelay(page) {
  await page.route("**/api/connect/**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (url.endsWith("/api/connect/connectors") && method === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ connectors: [LISTED_CONNECTOR] }),
      });
    }
    if (url.endsWith("/api/connect/connector/read")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          connector: {
            id: CONNECTOR_ID,
            uid: "resend/wedding",
            type: "oauth",
            data: {},
          },
        }),
      });
    }
    if (url.endsWith("/api/connect/token-check")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          subject: "user",
          expiresAt: 1_900_000_000_000,
          scopes: ["emails:send"],
          fingerprint: "0123456789ab",
          verified: { status: 200, ok: true, account: "wedding.example" },
        }),
      });
    }
    return route.fulfill({ status: 404, body: "{}" });
  });
}

async function armConnectRelay(page, shot, origin, base, profileName) {
  const command = page.locator("#command-bar-input");
  const openConnections = async () => {
    await page.goto(`${origin}${base}connections`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForURL(/\/connections/, { timeout: 60_000 });
  };
  if (await command.isVisible().catch(() => false)) {
    await command.fill("connections");
    await page.keyboard.press("Enter");
    const navigated = await page
      .waitForURL(/\/connections/, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (!navigated) await openConnections();
  } else {
    await openConnections();
  }
  await shot("connections-landing");
  const importKey = page.getByRole("button", { name: "Import connectors" });
  const importVisible = await importKey
    .waitFor({
      state: "visible",
      timeout: profileName === "minimal-local" ? 15_000 : 60_000,
    })
    .then(() => true)
    .catch(() => false);
  if (!importVisible) {
    return { panelReachable: false };
  }
  await importKey.click();
  const vercel = page.getByRole("button", { name: /Vercel Connect/i });
  await vercel.click();
  const keyField = page.getByLabel("Relay management key");
  if (await keyField.isVisible().catch(() => false)) {
    await keyField.fill(MANAGE_KEY);
    await page.getByRole("button", { name: "Seal in vault" }).click();
    await page
      .getByRole("button", { name: "Seal in vault" })
      .waitFor({ state: "hidden", timeout: 120_000 })
      .catch(() => undefined);
    await shot("connect-after-seal");
  }
  const reload = page.getByRole("button", { name: "Reload connections" });
  if (await reload.isEnabled().catch(() => false)) {
    const listed = page.waitForResponse(
      (resp) =>
        resp.url().includes("/api/connect/connectors") && resp.status() === 200,
      { timeout: 60_000 },
    );
    await reload.click();
    await listed;
  }
  await page
    .locator(".conn-service", { hasText: "wedding-resend" })
    .waitFor({ state: "visible", timeout: 60_000 });
  return { panelReachable: true };
}

async function captureTokenLabel(page, walk, origin, base) {
  const record = emptyRecord(walk);
  const shotDir = path.join(outRoot, walk.name);
  fs.mkdirSync(shotDir, { recursive: true });
  const shot = createShot(page, shotDir, record);

  await routeConnectRelay(page);
  await openDoor(page, shot, record, `${origin}${base}`);
  await captureChoices(page, shot, record);
  const setupOptions =
    walk.name === "custom" ? { enableConnectorsExternal: true } : {};
  const where = await applySetupChoice(
    page,
    shot,
    record,
    walk.setupChoice,
    setupOptions,
  );
  const entry = await enterVault(page, where);
  record.entry = entry;
  await shot(`vault-${entry}`);

  const relay = await armConnectRelay(page, shot, origin, base, walk.name);
  if (relay.panelReachable === false) {
    const absentImport = page.getByRole("button", {
      name: "Import connectors",
    });
    mark(
      record,
      "minimal-no-import",
      (await absentImport.count()) === 0,
      "UserTokenPanel not installable without connectors.external",
    );
    await page.screenshot({
      path: path.join(shotDir, "user-token-fingerprint-label.png"),
      fullPage: true,
    });
    console.error(`[user-token-label] ${walk.name} ${phase} furthest-state ok`);
    return;
  }

  await page
    .locator(".conn-service", { hasText: "wedding-resend" })
    .getByRole("link", { name: /Settings/ })
    .click();
  await page.waitForURL(/\/connections\/resend\/scl_evidence/, {
    timeout: 60_000,
  });
  await shot("resend-settings");

  const testButton = page.getByRole("button", { name: "Test user token" });
  await testButton.waitFor({ state: "visible", timeout: 120_000 });

  await testButton.click();
  const label =
    phase === "before" ? "sha256:0123456789ab…" : "scrypt:0123456789ab…";
  await page.getByText(label).waitFor({ timeout: 120_000 });

  await page.screenshot({
    path: path.join(shotDir, "user-token-fingerprint-label.png"),
    fullPage: true,
  });
  console.error(`[user-token-label] ${walk.name} ${phase} ok`);
}

async function main() {
  prepareChromium();
  const restore = phase === "before" ? runBeforeLabelPatch() : () => undefined;
  const { appRoot, scriptsDir, profilesDir } = appPaths();
  const origin = process.env.PAGES_ORIGIN ?? ORIGIN;
  const base = process.env.VITE_BASE ?? BASE;
  try {
    const onlyArg = process.argv.indexOf("--only");
    const only =
      onlyArg === -1
        ? undefined
        : process.argv[onlyArg + 1]?.split(",").map((name) => name.trim());
    const walks = resolveWalks(profilesDir, only);
    const dists = new Map();
    for (const walk of buildsNeeded(walks)) {
      const outDir = path.join(
        appRoot,
        "dist-profiles",
        `verification-${walk.buildKey === "stock" ? "stock" : walk.buildKey}`,
      );
      buildDist({
        appRoot,
        scriptsDir,
        outDir,
        capabilityProfile: walk.capabilityProfile,
        viteEnv: CONNECT_VITE,
      });
      dists.set(walk.buildKey, outDir);
    }
    for (const walk of walks) {
      const dist = dists.get(walk.buildKey);
      const harness = createHarness({
        dist,
        origin,
        base,
        out: path.join(outRoot, walk.name),
      });
      const browser = await harness.launch({
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      try {
        const opened = await harness.newPage(browser);
        await captureTokenLabel(opened.page, walk, origin, base);
        await opened.context.close();
      } finally {
        await browser.close();
      }
    }
  } finally {
    restore();
  }
}

await main();
