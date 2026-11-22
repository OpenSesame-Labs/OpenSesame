/** Walk the first-vault tutorial by doing what it asks, including the copy. */

import {
  addTutorialAuthenticator,
  sealFirstVault,
} from "./auth-flow-passkey.mjs";
import { checkZoomViewport } from "./tutorial-interact.mjs";
import { checkKeyboardViewport } from "./tutorial-keyboard-viewport.mjs";
import { tutorialStepChecker } from "./tutorial-measure.mjs";
import {
  choosePepper,
  preparePepperStep,
  recoverEmptyGeneration,
  revisitPepper,
  saveAndCopyPassword,
} from "./tutorial-pepper.mjs";
import { readStep, startTutorial } from "./tutorial-walk.mjs";
import { pickSetupChoice } from "./verification-checklist-setup.mjs";

export async function runFirstVaultPass({
  newPage,
  width,
  setupChoice = "Default",
  ...options
}) {
  for (const protection of ["passkey", "fallback", "pin-only"]) {
    const { page, context } = await newPage(width);
    try {
      await firstVaultPass({
        page,
        context,
        width,
        protection,
        setupChoice,
        ...options,
      });
    } catch (error) {
      options.check(
        false,
        `${protection} first vault: walking threw — ${String(error.message).split("\n").slice(0, 4).join(" ")}`,
      );
    } finally {
      await context.close();
    }
  }
}

async function firstVaultPass({
  page,
  context,
  origin,
  base,
  check,
  phone,
  out,
  width,
  keepShots,
  protection,
  setupChoice,
}) {
  await context.addInitScript(() =>
    Object.defineProperty(navigator, "webdriver", { get: () => false }),
  );
  if (protection === "pin-only") {
    await context.addInitScript(() => {
      Object.defineProperty(globalThis, "PublicKeyCredential", {
        configurable: true,
        value: undefined,
      });
    });
  }
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: "Set up your own" })
    .waitFor({ timeout: 30000 });
  const label = `${protection} first vault`;
  const step = tutorialStepChecker(page, check, phone, 13, label, readStep, {
    out,
    width,
    keepShots,
  });
  await enterVault(page, context, step, check, phone, protection, {
    out,
    width,
    keepShots,
    setupChoice,
  });
  await makePassword(page, step, check, phone, label, protection);
}

async function enterVault(
  page,
  context,
  step,
  check,
  phone,
  protection,
  { out, width, keepShots, setupChoice = "Default" },
) {
  await step("unlock.setup", 1);
  await page.locator(".coach__btn--go").focus();
  await page.keyboard.press("ArrowRight");
  check(
    (await page.locator('.coach[data-coach-target="unlock.setup"]').count()) ===
      1,
    "first vault: Next cannot skip a required action",
  );
  if (phone && page.viewportSize().width <= 390)
    await checkZoomViewport(page, check);
  else
    await page
      .getByRole("button", { name: "Set up your own", exact: true })
      .evaluate((button) => button.click());
  await step("setup.default", 2);
  if (setupChoice === "Minimal" || setupChoice === "Full") {
    await pickSetupChoice(page, setupChoice);
  } else {
    await page
      .getByRole("button", { name: "Default", exact: true })
      .evaluate((button) => button.click());
  }
  await step("unlock.local-only", 3);
  await page.getByRole("button", { name: "Use without an account" }).click();
  await step("unlock.seal-actions", 4);
  // Register after the phone zoom check detaches its separate CDP session.
  if (protection !== "pin-only")
    await addTutorialAuthenticator(context, page, protection === "passkey");
  await sealFirstVault(page, {
    step,
    check,
    phone,
    protection,
    label: `${protection} first vault`,
    out,
    width,
    keepShots,
  });
}

async function makePassword(page, step, check, phone, label, protection) {
  // The passkey road's seal — sealed straight through or fallen back to PIN —
  // holds the seal step until the vault unlocks, so the shell continuation
  // begins right after the gate's four walked steps. Only the PIN-only road
  // walks the four seal fields as tour steps.
  const pinOnly = protection === "pin-only";
  const first = pinOnly ? 9 : 5;
  const total = pinOnly ? 17 : 13;
  const expected = `Step ${first} of ${total}`;
  try {
    await page.waitForFunction(
      (counter) =>
        [
          ...document.querySelectorAll('.coach[data-coach-status="waiting"]'),
        ].some(
          (node) =>
            node.querySelector(".coach__count")?.textContent === counter,
        ),
      expected,
      { timeout: 30000 },
    );
  } catch (error) {
    const state = await page.evaluate(() => ({
      url: location.href,
      heading: document.querySelector("h1")?.textContent?.trim(),
      counters: [...document.querySelectorAll(".coach__count")].map((node) =>
        node.textContent?.trim(),
      ),
      alert: document.querySelector('[role="alert"]')?.textContent?.trim(),
    }));
    throw new Error(
      `First-vault handoff did not reach ${expected}: ${JSON.stringify(state)}`,
      { cause: error },
    );
  }
  const target = await page.evaluate(
    (counter) =>
      [...document.querySelectorAll('.coach[data-coach-status="waiting"]')]
        .find(
          (node) =>
            node.querySelector(".coach__count")?.textContent === counter,
        )
        ?.getAttribute("data-coach-target"),
    expected,
  );
  if (target === "settings.account-pack") {
    await step("settings.account-pack", first, total);
    await page.getByRole("switch", { name: "Account", exact: true }).click();
  } else {
    await step("", first, total);
    await page.locator(".coach__btn--go").click();
  }
  const pathStep = (target, number) => step(target, number, total);
  await passwordSteps(page, pathStep, check, first + 1, label, phone);
}

async function passwordSteps(page, step, check, first, label, phone) {
  await openNewAccount(page, step, check, first, label, phone);
  await configurePassword(page, step, check, first, label, phone);
  const generated = await generatePassword(page, step, check, first, label);
  await saveAndCopyPassword(page, step, check, first, label, generated);
}

async function openNewAccount(page, step, check, first, label, phone) {
  await step("vault.create", first);
  await page.locator(".coach__btn--go").focus();
  await page.keyboard.press("ArrowRight");
  check(
    (await page.locator('.coach[data-coach-target="vault.create"]').count()) ===
      1,
    `${label}: Next cannot skip creating the item`,
  );
  await page
    .locator('[data-guide-targets~="vault.create"]:visible')
    .first()
    .click();
  await step("item.editor.name", first + 1);
  check(
    await page.locator(".coach__btn").filter({ hasText: "Back" }).isDisabled(),
    `${label}: Back cannot leave an unsaved editor`,
  );
  if (phone && process.env.TUTORIALS_KEYBOARD_VIEWPORT === "1")
    await checkKeyboardViewport(page, check, label);
  await page.getByLabel("Name", { exact: true }).fill("Tutorial example");
}

async function configurePassword(page, step, check, first, label, phone) {
  if (process.env.TUTORIALS_RECOVERY === "1") {
    await page
      .getByRole("button", { name: "Password options" })
      .first()
      .click();
  }
  await page.locator(".coach__btn--go").click();
  await step("editor.password-options", first + 2);
  if (process.env.TUTORIALS_RECOVERY === "1") {
    check(
      (await page.locator(".coach__btn--go").getAttribute("aria-disabled")) !==
        "true",
      `${label}: options opened early are recognized`,
    );
    check(
      (await page.locator(".coach__text").innerText()).includes(
        "Password options are open. Select Next.",
      ),
      `${label}: instructions acknowledge open password options`,
    );
    await page.locator(".coach__btn--go").click();
  } else {
    await page
      .getByRole("button", { name: "Password options" })
      .first()
      .click();
  }
  await preparePepperStep(page, step, check, first, label);
  await choosePepper(page, check, label, phone);
}

async function generatePassword(page, step, check, first, label) {
  await step("editor.generate-password", first + 4);
  const generate = page
    .getByRole("button", { name: "Generate another password" })
    .first();
  if (process.env.TUTORIALS_PEPPER_BACK === "1") {
    await revisitPepper(page, step, check, first, label);
  }
  if (process.env.TUTORIALS_GENERATION_FAILURE === "1") {
    await page.getByLabel("Password generator").selectOption("rules");
    for (const option of await page
      .locator(".gen__checks input[type=checkbox]")
      .all()) {
      await option.uncheck();
    }
    await generate.click();
    await step("editor.generate-password", first + 4);
    const [errorBox, buttonBox] = await Promise.all([
      page
        .getByRole("img", { name: /Could not generate a password/ })
        .boundingBox(),
      generate.boundingBox(),
    ]);
    check(
      Boolean(
        errorBox && buttonBox && errorBox.x >= buttonBox.x + buttonBox.width,
      ),
      `${label}: generation failure stays clear of the retry button`,
    );
    await page.getByLabel("Capital letters", { exact: true }).check();
  }
  await recoverEmptyGeneration(page, step, check, first, label, generate);
  const password = page.getByLabel("Password", { exact: true }).first();
  const before = await password.inputValue();
  await generate.click();
  await step("item.editor.save", first + 5);
  const generated = await password.inputValue();
  check(
    generated.length > 0 && generated !== before,
    `${label}: a new password was generated`,
  );
  return generated;
}

/** Walk the empty-vault offer through the same password journey. */
export async function firstItemPass({
  page,
  context,
  origin,
  check,
  phone,
  out,
  width,
  keepShots,
}) {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  if (process.env.TUTORIALS_FILTERED_FIRST_ITEM === "1") {
    // Set the existing list's route without a reload, which would lock its vault.
    await page.evaluate(() => {
      const url = new URL(window.location.href);
      url.search = "?f=note";
      window.history.pushState({}, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.waitForURL(/\?f=note/);
  }
  await startTutorial(page, "vault.item.first");
  const step = tutorialStepChecker(
    page,
    check,
    phone,
    9,
    "first item",
    readStep,
    { out, width, keepShots },
  );
  await step("", 1);
  await page.locator(".coach__btn--go").click();
  await passwordSteps(page, step, check, 2, "first item", phone);
}

/** A separate vault keeps this action-based walk from changing other tours. */
export async function walkFirstItem(entries, options) {
  if (!entries.some((entry) => entry.id === "vault.item.first")) return;
  const { width, phone, sealedShell, guarded, origin, check, out, keepShots } =
    options;
  const isolated = await sealedShell(width);
  try {
    await guarded(isolated.page, "first-item", () =>
      firstItemPass({
        ...isolated,
        origin,
        check,
        phone,
        out,
        width,
        keepShots,
      }),
    );
  } finally {
    await isolated.context.close();
  }
}
