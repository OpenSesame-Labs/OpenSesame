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
  if (process.env.TUTORIALS_PEPPER_OFF === "1") {
    if (phone) await pepperLabel.tap();
    else await pepperLabel.click();
    check(!(await pepper.isChecked()), `${label}: pepper can be turned off`);
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
  const enabled = process.env.TUTORIALS_PEPPER_OFF !== "1";
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
  await next.click();
  await step("editor.generate-password", first + 4);
}

async function capturePepperRecovery(page, name) {
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
  await capturePepperRecovery(page, "pepper-generation-recovery");
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
  const detail = await step("item.edit", first + 5);
  check(
    detail.text.includes("Select Edit") &&
      (await page.getByText(/No generated characters to copy/).isVisible()),
    `${label}: an empty slice offers editing instead of an empty copy`,
  );
  await capturePepperRecovery(page, "pepper-detail-recovery");
  await page.getByRole("link", { name: "Edit", exact: true }).click();
  const editor = await step("editor.pepper-options", first + 5);
  check(
    editor.text.includes("Set the pepper position to end"),
    `${label}: the editor explains how to restore a copyable password`,
  );
  await capturePepperRecovery(page, "pepper-editor-recovery");
  const position = page.getByRole("textbox", {
    name: "Pepper goes",
    exact: true,
  });
  await position.click();
  await position.fill("end");
}
