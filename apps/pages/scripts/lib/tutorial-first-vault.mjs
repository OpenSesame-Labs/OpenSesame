/** Walk the first-vault tutorial by doing what it asks, including the copy. */
import { PIN } from "./pages-journey.mjs";
import { stepChecks } from "./tutorial-measure.mjs";
import { readStep, startTutorial } from "./tutorial-walk.mjs";

export async function firstVaultPass({
  page,
  context,
  origin,
  base,
  check,
  phone,
}) {
  // Test the same automatic first-run behavior a person sees, rather than
  // the opt-in offer used by WebDriver-controlled browsers.
  await context.addInitScript(() =>
    Object.defineProperty(navigator, "webdriver", { get: () => false }),
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: "Set up your own" })
    .waitFor({ timeout: 30000 });
  const step = stepChecker(page, check, phone, 12, "first vault");
  await enterVault(page, step, check);
  await makePassword(page, step, check);
}

function stepChecker(page, check, phone, total, label) {
  return async function step(target, number) {
    await page
      .locator(
        `.coach[data-coach-target="${target}"][data-coach-status="waiting"]`,
      )
      .waitFor({ timeout: 30000 });
    const info = await readStep(page);
    check(
      info?.target === target,
      `${label}: step ${number} targets ${target}`,
    );
    check(
      info?.counter === `Step ${number} of ${total}`,
      `${label}: step ${number} keeps one progress count`,
    );
    if (info) {
      for (const [ok, what] of stepChecks(info, { phone }))
        check(ok, `${label} · ${target}: ${what}`);
    }
  };
}

async function enterVault(page, step, check) {
  await step("unlock.setup", 1);
  await page.locator(".coach__btn--go").focus();
  await page.keyboard.press("ArrowRight");
  check(
    (await page.locator('.coach[data-coach-target="unlock.setup"]').count()) ===
      1,
    "first vault: Next cannot skip a required action",
  );
  await page.getByRole("button", { name: "Set up your own" }).click();
  await step("setup.default", 2);
  await page.getByRole("button", { name: "Default", exact: true }).click();
  await step("unlock.local-only", 3);
  await page.getByRole("button", { name: "Use without an account" }).click();
  await step("unlock.seal", 4);
  await page.getByRole("tab", { name: "PIN", exact: true }).click();
  await page.getByLabel("Device PIN", { exact: true }).fill(PIN);
  await page.getByLabel("Confirm PIN", { exact: true }).fill(PIN);
  await page.getByLabel("I understand this vault cannot be recovered.").check();
  await page.getByRole("button", { name: "Seal with PIN" }).click();
}

async function makePassword(page, step, check) {
  await page.waitForFunction(
    () =>
      [
        ...document.querySelectorAll('.coach[data-coach-status="waiting"]'),
      ].some(
        (node) =>
          node.querySelector(".coach__count")?.textContent === "Step 5 of 12",
      ),
    undefined,
    { timeout: 30000 },
  );
  const target = await page.evaluate(() =>
    [...document.querySelectorAll('.coach[data-coach-status="waiting"]')]
      .find(
        (node) =>
          node.querySelector(".coach__count")?.textContent === "Step 5 of 12",
      )
      ?.getAttribute("data-coach-target"),
  );
  if (target === "settings.account-pack") {
    await step("settings.account-pack", 5);
    await page.getByRole("switch", { name: "Account", exact: true }).click();
  } else {
    await step("", 5);
    await page.locator(".coach__btn--go").click();
  }
  await passwordSteps(page, step, check, 6, "first vault");
}

async function passwordSteps(page, step, check, first, label) {
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
  await page.getByLabel("Name", { exact: true }).fill("Tutorial example");
  // A person may open the next panel before advancing from the name step.
  if (process.env.TUTORIALS_RECOVERY === "1") {
    await page
      .getByRole("button", { name: "Password options" })
      .first()
      .click();
  }
  await page.locator(".coach__btn--go").click();
  await step("editor.password-options", first + 2);
  await page.getByRole("button", { name: "Password options" }).first().click();
  if (process.env.TUTORIALS_RECOVERY === "1") {
    await recoverPasswordOptions(page, check, label);
  }
  await step("editor.pepper", first + 3);
  await page.getByLabel("Include pepper").uncheck();
  await step("editor.generate-password", first + 4);
  const password = page.getByLabel("Password", { exact: true }).first();
  const before = await password.inputValue();
  await page
    .getByRole("button", { name: "Generate another password" })
    .first()
    .click();
  await step("item.editor.save", first + 5);
  const generated = await password.inputValue();
  check(
    generated.length > 0 && generated !== before,
    `${label}: a new password was generated`,
  );
  await page.getByRole("button", { name: "Save item" }).click();
  await step("item.copy-password", first + 6);
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
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.waitForTimeout(1600);
  check(
    (await page.locator(".coach").count()) === 0,
    `${label}: finishing does not immediately start another tutorial`,
  );
}

async function recoverPasswordOptions(page, check, label) {
  const missing = page.locator(
    '.coach[data-coach-target="editor.pepper"][data-coach-status="waiting"][data-coach-degraded="true"]',
  );
  await missing.waitFor({ timeout: 15000 });
  check(
    (await missing.locator(".coach__btn--go").getAttribute("aria-disabled")) ===
      "true",
    `${label}: a missing required action cannot be skipped`,
  );
  await page.getByRole("button", { name: "Password options" }).first().click();
  await page
    .locator(
      '.coach[data-coach-target="editor.pepper"][data-coach-status="waiting"][data-coach-degraded="false"]',
    )
    .waitFor({ timeout: 15000 });
  check(true, `${label}: reopening the panel restores the required target`);
}

/** Walk the empty-vault offer through the same password journey. */
export async function firstItemPass({ page, context, origin, check, phone }) {
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
  const step = stepChecker(page, check, phone, 8, "first item");
  await step("", 1);
  await page.locator(".coach__btn--go").click();
  await passwordSteps(page, step, check, 2, "first item");
}

/** A separate vault keeps this action-based walk from changing other tours. */
export async function walkFirstItem(entries, options) {
  if (!entries.some((entry) => entry.id === "vault.item.first")) return;
  const { width, phone, sealedShell, guarded, origin, check } = options;
  const isolated = await sealedShell(width);
  try {
    await guarded(isolated.page, "first-item", () =>
      firstItemPass({ ...isolated, origin, check, phone }),
    );
  } finally {
    await isolated.context.close();
  }
}
