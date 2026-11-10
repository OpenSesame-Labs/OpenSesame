/**
 * Page capture for the install-profile proof: per-step screenshots, the
 * setup-choice and Features/ceremony panels, and the stitched composite PNG.
 * `pwa-install-profile-proof.mjs` owns the builds, the browser, and the walk.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { awaitCapabilitySections } from "../../apps/pages/scripts/lib/always-on.mjs";
import { openSettingsCategory } from "../../apps/pages/scripts/lib/pages-journey.mjs";
import { enterVault } from "../../apps/pages/scripts/lib/verification-checklist-setup.mjs";
import { visibleClick } from "../../apps/pages/scripts/lib/verification-checklist-shot.mjs";
import { isString } from "../lib/json-boundary.mjs";
import {
  readImageWidth,
  stitchPanels,
  widenTo,
} from "./pwa-profile-proof-gate.mjs";

async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

export function proofShot(page, dir, texts, record) {
  return async function shot(step) {
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await page.waitForTimeout(300);
    const file = join(dir, `${step}.png`);
    await page.screenshot({ path: file, animations: "disabled" });
    const text = await page.evaluate(() => document.body.innerText);
    texts.set(step, text);
    record.shots.push(step);
    return text;
  };
}

function textOf(texts, step) {
  const value = texts.get(step);
  return isString(value) ? value : "";
}

function requireCeremony(texts) {
  const ceremony = textOf(texts, "setup-capabilities");
  if (ceremony.includes("Use the minimal configuration")) return;
  throw new Error(
    `custom capabilities ceremony missing; saw: ${ceremony.slice(0, 500)}`,
  );
}

export async function captureChoice(page, walk, stepsDir) {
  const opened = await visibleClick(page, "button", "Set up your own");
  if (!opened) throw new Error(`${walk.name}: Set up your own did not appear`);
  const choice = page.getByRole("button", {
    name: walk.setupChoice,
    exact: true,
  });
  await choice.waitFor({ state: "visible", timeout: 15_000 });
  await choice.scrollIntoViewIfNeeded();
  const path = join(stepsDir, "setup-choice.png");
  await choice.screenshot({ path, animations: "disabled" });
  return path;
}

async function captureFeatures(page, shot, where) {
  await enterVault(page, where);
  await openSettingsCategory(page, "Features");
  const panel = page.locator("[data-testid=features-panel]");
  await panel.waitFor({ state: "visible", timeout: 15_000 });
  await awaitCapabilitySections(page);
  const switchesOn = await panel
    .locator('[role="switch"][aria-checked="true"]')
    .count();
  await page.setViewportSize({ width: 1280, height: 2200 });
  await shot("features");
  return switchesOn;
}

export async function finishProfile(page, shot, walk, where, texts) {
  if (walk.setupChoice === "Custom") {
    requireCeremony(texts);
    return { distinguish: "setup-capabilities", ceremonyReached: true };
  }
  const switchesOn = await captureFeatures(page, shot, where);
  return { distinguish: "features", switchesOn, ceremonyReached: false };
}

const LIVE_PAGES = "https://opensesame-labs.github.io";

export function assertLocalPage(page, name) {
  const url = page.url();
  if (url.startsWith(LIVE_PAGES)) {
    throw new Error(`${name} navigated to live Pages: ${url}`);
  }
}

export async function failureShot(page, root, name) {
  console.error(`[pwa-proof] ${name} failed at ${page.url()}`);
  const failed = join(root, `failure-${name}.png`);
  await page
    .screenshot({ path: failed, animations: "disabled" })
    .catch(() => undefined);
  console.error(`[pwa-proof] ${name} failed; wrote ${failed}`);
}

function requireShot(path) {
  if (!existsSync(path)) throw new Error(`missing screenshot ${path}`);
}

export async function composeProfile(walk, stepsDir, root, distinguish) {
  const frontPath = join(stepsDir, "front-door.png");
  const choicePath = join(stepsDir, "setup-choice.png");
  const statePath = join(stepsDir, `${distinguish}.png`);
  requireShot(frontPath);
  requireShot(choicePath);
  requireShot(statePath);
  const choiceHash = await sha256File(choicePath);
  const distinguishHash = await sha256File(statePath);
  await widenTo(choicePath, await readImageWidth(frontPath));
  const pngPath = join(root, `${walk.name}.png`);
  const stateLabel = distinguish === "features" ? "Features" : "Capabilities";
  await stitchPanels(
    [
      { path: frontPath, label: "Front door" },
      { path: choicePath, label: "Setup choice" },
      { path: statePath, label: stateLabel },
    ],
    pngPath,
  );
  return {
    pngHash: await sha256File(pngPath),
    distinguishHash,
    choiceHash,
  };
}
