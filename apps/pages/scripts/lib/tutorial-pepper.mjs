import { closeWithZoomCheck } from "./tutorial-interact.mjs";

const COPIED_MESSAGE = "Copied. Add your secret if pepper is on.";

function keepPepper() {
  return (
    process.env.TUTORIALS_PEPPER_OFF !== "1" &&
    (process.env.TUTORIALS_PEPPER_ON === "1" ||
      Boolean(process.env.TUTORIALS_PEPPER_POSITION) ||
      process.env.TUTORIALS_PEPPER_AFTER_GENERATE === "1")
  );
}

export async function preparePepperStep(page, step, check, first, label) {
  await step("editor.pepper-options", first + 3);
  if (process.env.TUTORIALS_PEPPER_BACK !== "1") return;
  const options = page
    .getByRole("button", { name: "Password options" })
    .first();
  await options.click();
  const waiting = page.locator(
    '.coach[data-coach-target="editor.pepper-options"][data-coach-degraded="true"]',
  );
  await waiting.waitFor({ timeout: 15000 });
  await options.click();
  await step("editor.pepper-options", first + 3);
  check(
    await page.getByLabel("Include pepper").isChecked(),
    `${label}: closing options does not change the pepper choice`,
  );
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await step("editor.password-options", first + 2);
  const next = page.locator(".coach__btn--go");
  check(
    (await next.getAttribute("aria-disabled")) !== "true",
    `${label}: Back recognizes that password options are already open`,
  );
  check(
    (await page.locator(".coach__text").innerText()).includes(
      "Password options are open. Select Next.",
    ),
    `${label}: Back describes the open options`,
  );
  await next.click();
  await step("editor.pepper-options", first + 3);
}

export async function choosePepper(page, check, label, phone) {
  const pepper = page.getByLabel("Include pepper");
  const pepperLabel = page
    .getByText("Include pepper", { exact: true })
    .locator("..");
  check(await pepper.isChecked(), `${label}: pepper stays on by default`);
  if (phone) {
    const bounds = await pepperLabel.boundingBox();
    check(
      Boolean(bounds && bounds.width >= 44 && bounds.height >= 44),
      `${label}: the entire pepper label is a 44px touch target`,
    );
  }
  if (!keepPepper()) {
    if (phone) await pepperLabel.tap();
    else await pepperLabel.click();
    check(
      !(await pepper.isChecked()),
      `${label}: pepper is off for the walkthrough`,
    );
  }
  if (process.env.TUTORIALS_PEPPER_POSITION) {
    await page
      .getByRole("textbox", { name: "Pepper goes", exact: true })
      .fill(
        process.env.TUTORIALS_PEPPER_POSITION === "empty"
          ? "0:"
          : process.env.TUTORIALS_PEPPER_POSITION,
      );
  }
  await page.locator(".coach__btn--go").click();
}

export async function revisitPepper(page, step, check, first, label) {
  const back = page.getByRole("button", { name: "Back", exact: true });
  const next = page.locator(".coach__btn--go");
  const pepper = page.getByLabel("Include pepper");
  const enabled = keepPepper();
  const position = page.getByRole("textbox", {
    name: "Pepper goes",
    exact: true,
  });
  await back.click();
  await step("editor.pepper-options", first + 3);
  check(
    (await pepper.isChecked()) === enabled,
    `${label}: Back keeps the pepper choice`,
  );
  check(
    (await next.getAttribute("aria-disabled")) !== "true",
    `${label}: either pepper choice allows Next`,
  );
  const previousPosition = enabled ? await position.inputValue() : "";
  await pepper.click();
  await step("editor.pepper-options", first + 3);
  check(
    (await pepper.isChecked()) !== enabled,
    `${label}: changing pepper does not advance`,
  );
  await pepper.click();
  check(
    (await pepper.isChecked()) === enabled,
    `${label}: pepper choice can be restored`,
  );
  if (enabled) await position.fill(previousPosition);
  await next.click();
  await step("editor.generate-password", first + 4);
}

async function captureTutorialState(page, name) {
  if (process.env.TUTORIALS_SHOTS !== "1" || !process.env.TUTORIALS_OUT) return;
  const width = page.viewportSize().width;
  await page.screenshot({
    path: `${process.env.TUTORIALS_OUT}/${width}-${name}.png`,
  });
}

export async function recoverEmptyGeneration(
  page,
  step,
  check,
  first,
  label,
  generate,
) {
  if (process.env.TUTORIALS_PEPPER_POSITION !== "empty") return;
  await generate.click();
  const recovery = await step("editor.pepper-options", first + 4);
  check(
    recovery.text.includes("Set the pepper position to end") &&
      (await page
        .getByRole("img", { name: /Set the pepper position to end/ })
        .isVisible()),
    `${label}: an empty pepper slice explains how to recover`,
  );
  await captureTutorialState(page, "pepper-generation-recovery");
  const position = page.getByRole("textbox", {
    name: "Pepper goes",
    exact: true,
  });
  await position.click();
  await position.fill("end");
  await step("editor.generate-password", first + 4);
}

/** A changed slice must not make the tutorial claim an empty copy. */
export async function recoverEmptyPepper(page, step, check, first, label) {
  if (process.env.TUTORIALS_PEPPER_AFTER_GENERATE !== "1") return;
  await page
    .getByRole("textbox", { name: "Pepper goes", exact: true })
    .fill("0:");
  await page.getByRole("button", { name: "Save item" }).click();
  await page
    .locator('.coach[data-coach-step="8"][data-coach-target="item.edit"]')
    .waitFor({ timeout: 30000 });
  const detail = await step("item.edit", first + 6);
  check(
    detail.text.includes("Select Edit") &&
      (await page.getByText(/No generated characters to copy/).isVisible()),
    `${label}: an empty slice offers editing instead of an empty copy`,
  );
  await captureTutorialState(page, "pepper-detail-recovery");
  await page.getByRole("link", { name: "Edit", exact: true }).click();
  const editor = await step("editor.pepper-options", first + 6);
  check(
    editor.text.includes("Set the pepper position to end"),
    `${label}: the editor explains how to restore a copyable password`,
  );
  await captureTutorialState(page, "pepper-editor-recovery");
  const position = page.getByRole("textbox", {
    name: "Pepper goes",
    exact: true,
  });
  await position.click();
  await position.fill("end");
  const save = await step("item.editor.save", first + 6);
  check(
    save.text.includes("Select Save item"),
    `${label}: the corrected password is ready to save`,
  );
}

export async function saveAndCopyPassword(
  page,
  step,
  check,
  first,
  label,
  generated,
) {
  await recoverEmptyPepper(page, step, check, first, label);
  await page.getByRole("button", { name: "Save item" }).click();
  await step("item.copy-generated", first + 6);
  check(
    await page.locator(".coach__btn").filter({ hasText: "Back" }).isDisabled(),
    `${label}: Back does not return to the closed editor`,
  );
  await page.locator(".coach__btn--go").focus();
  await page.keyboard.press("ArrowRight");
  check(
    (await page
      .locator('.coach[data-coach-target="item.copy-generated"]')
      .count()) === 1,
    `${label}: Next cannot skip copying the password`,
  );
  const position = process.env.TUTORIALS_PEPPER_POSITION;
  if (position === "3") {
    await page.getByRole("button", { name: "Copy rest of password" }).click();
    await page
      .getByRole("button", { name: "Copied rest of password" })
      .waitFor();
    check(
      (await page
        .locator('.coach[data-coach-target="item.copy-generated"]')
        .count()) === 1,
      `${label}: copying the rest first does not finish the guide`,
    );
    await captureTutorialState(page, "pepper-copy-first");
  }
  await page.locator('[data-guide-targets~="item.copy-generated"]').click();
  let firstPart = "";
  if (position === "3") {
    const rest = page.locator('[data-guide-targets~="item.copy-generated"]');
    await page
      .locator(
        '[data-guide-targets~="item.copy-generated"][aria-label="Copy rest of password"]',
      )
      .waitFor({ state: "visible", timeout: 15000 });
    await step("item.copy-generated", first + 6);
    await captureTutorialState(page, "pepper-copy-rest");
    check(
      (await page
        .locator('.coach[data-coach-target="item.copy-generated"]')
        .count()) === 1,
      `${label}: the guide waits for the remaining part`,
    );
    firstPart = await page.evaluate(() => navigator.clipboard.readText());
    check(
      firstPart === generated.slice(0, 3),
      `${label}: the first part was copied`,
    );
    const origin = new URL(page.url()).origin;
    await page.context().clearPermissions();
    await page.context().grantPermissions(["clipboard-read"], { origin });
    await rest.click();
    await page
      .getByRole("button", { name: "Could not copy rest of password" })
      .waitFor();
    check(
      (await page
        .locator('.coach[data-coach-target="item.copy-generated"]')
        .count()) === 1,
      `${label}: a failed second copy does not finish the guide`,
    );
    await page.context().clearPermissions();
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await rest.click();
  }
  // A successful copy takes the walkthrough directly to completion.
  await page.getByText(COPIED_MESSAGE).waitFor({ timeout: 15000 });
  await captureTutorialState(page, "password-copied");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const pepper = "example-pepper";
  check(
    firstPart + copied === generated &&
      (position !== "3" ||
        `${firstPart}${pepper}${copied}` ===
          `${generated.slice(0, 3)}${pepper}${generated.slice(3)}`),
    `${label}: the copied parts reconstruct the generated password`,
  );
  await closeWithZoomCheck(page, check);
  await page.waitForTimeout(1600);
  check(
    (await page.locator(".coach").count()) === 0,
    `${label}: finishing does not immediately start another tutorial`,
  );
}
