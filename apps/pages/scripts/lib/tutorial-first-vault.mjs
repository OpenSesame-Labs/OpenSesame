/** Walk the first-vault tutorial by doing what it asks, including the copy. */

import {
  addTutorialAuthenticator,
  sealFirstVault,
} from "./auth-flow-passkey.mjs";
import { checkZoomViewport, closeWithZoomCheck } from "./tutorial-interact.mjs";
import { checkKeyboardViewport } from "./tutorial-keyboard-viewport.mjs";
import { stepChecks } from "./tutorial-measure.mjs";
import { preparePepperStep, revisitPepper } from "./tutorial-pepper.mjs";
import { readStep, startTutorial } from "./tutorial-walk.mjs";

export async function runFirstVaultPass({ newPage, width, ...options }) {
  for (const protection of ["passkey", "fallback"]) {
    const { page, context } = await newPage(width);
    try {
      await firstVaultPass({
        page,
        context,
        width,
        protection,
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
}) {
  await context.addInitScript(() =>
    Object.defineProperty(navigator, "webdriver", { get: () => false }),
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  await addTutorialAuthenticator(context, page, protection === "passkey");
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: "Set up your own" })
    .waitFor({ timeout: 30000 });
  const label = `${protection} first vault`;
  const step = stepChecker(page, check, phone, 16, label, {
    out,
    width,
    keepShots,
  });
  await enterVault(page, step, check, phone, protection, {
    out,
    width,
    keepShots,
  });
  await makePassword(page, step, check, phone, label);
}

function stepChecker(
  page,
  check,
  phone,
  total,
  label,
  { out, width, keepShots } = {},
) {
  return async function step(target, number) {
    await page
      .locator(
        `.coach[data-coach-target="${target}"][data-coach-status="waiting"]`,
      )
      .waitFor({ timeout: 30000 });
    const info = await readStep(page);
    check(info?.target === target, `${label}: target ${target}`);
    const expected = `Step ${number} of ${total}`;
    check(info?.counter === expected, `${label}: progress ${expected}`);
    if (info) {
      for (const [ok, what] of stepChecks(info, { phone }))
        check(ok, `${label} · ${target}: ${what}`);
    }
    if (keepShots)
      await page.screenshot({
        path: `${out}/${width}-${label.replaceAll(" ", "-")}-${String(number).padStart(2, "0")}.png`,
      });
    return info;
  };
}

async function enterVault(
  page,
  step,
  check,
  phone,
  protection,
  { out, width, keepShots },
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
  else await page.getByRole("button", { name: "Set up your own" }).click();
  await step("setup.default", 2);
  await page.getByRole("button", { name: "Default", exact: true }).click();
  await step("unlock.local-only", 3);
  await page.getByRole("button", { name: "Use without an account" }).click();
  await step("unlock.methods", 4);
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

async function makePassword(page, step, check, phone, label) {
  await page.waitForFunction(
    () =>
      [
        ...document.querySelectorAll('.coach[data-coach-status="waiting"]'),
      ].some(
        (node) =>
          node.querySelector(".coach__count")?.textContent === "Step 9 of 16",
      ),
    undefined,
    { timeout: 30000 },
  );
  const target = await page.evaluate(() =>
    [...document.querySelectorAll('.coach[data-coach-status="waiting"]')]
      .find(
        (node) =>
          node.querySelector(".coach__count")?.textContent === "Step 9 of 16",
      )
      ?.getAttribute("data-coach-target"),
  );
  if (target === "settings.account-pack") {
    await step("settings.account-pack", 9);
    await page.getByRole("switch", { name: "Account", exact: true }).click();
  } else {
    await step("", 9);
    await page.locator(".coach__btn--go").click();
  }
  await passwordSteps(page, step, check, 10, label, phone);
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
  const pepperLabel = page.locator(
    'label[data-guide-targets~="editor.pepper"]',
  );
  if (phone) {
    const bounds = await pepperLabel.boundingBox();
    check(
      Boolean(bounds && bounds.width >= 44 && bounds.height >= 44),
      `${label}: the entire pepper label is a 44px touch target`,
    );
    await pepperLabel.tap();
  } else {
    await pepperLabel.click();
  }
  check(
    !(await page.getByLabel("Include pepper").isChecked()),
    `${label}: selecting the highlighted label turns pepper off`,
  );
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

async function saveAndCopyPassword(page, step, check, first, label, generated) {
  await page.getByRole("button", { name: "Save item" }).click();
  await step("item.copy-password", first + 6);
  check(
    await page.locator(".coach__btn").filter({ hasText: "Back" }).isDisabled(),
    `${label}: Back does not return to the closed editor`,
  );
  await page.locator(".coach__btn--go").focus();
  await page.keyboard.press("ArrowRight");
  check(
    (await page
      .locator('.coach[data-coach-target="item.copy-password"]')
      .count()) === 1,
    `${label}: Next cannot skip copying the password`,
  );
  await page
    .getByRole("button", { name: "Copy password", exact: true })
    .first()
    .click();
  await page
    .getByText("Password copied. Your account is saved in your vault.")
    .waitFor({ timeout: 15000 });
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  check(
    copied === generated,
    `${label}: the complete generated password reached the clipboard`,
  );
  await closeWithZoomCheck(page, check);
  await page.waitForTimeout(1600);
  check(
    (await page.locator(".coach").count()) === 0,
    `${label}: finishing does not immediately start another tutorial`,
  );
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
  const step = stepChecker(page, check, phone, 8, "first item", {
    out,
    width,
    keepShots,
  });
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
