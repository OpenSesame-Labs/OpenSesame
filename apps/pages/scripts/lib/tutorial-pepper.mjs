export async function preparePepperStep(page, step, check, first, label) {
  await step("editor.pepper", first + 3);
  if (process.env.TUTORIALS_PEPPER_BACK !== "1") return;
  const options = page
    .getByRole("button", { name: "Password options" })
    .first();
  await options.click();
  const waiting = page.locator(
    '.coach[data-coach-target="editor.pepper"][data-coach-degraded="true"]',
  );
  await waiting.waitFor({ timeout: 15000 });
  check(
    (await waiting.locator(".coach__btn--go").getAttribute("aria-disabled")) ===
      "true",
    `${label}: closing options does not turn pepper off or advance`,
  );
  await options.click();
  await step("editor.pepper", first + 3);
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
  await step("editor.pepper", first + 3);
}

export async function revisitPepper(page, step, check, first, label) {
  const back = page.getByRole("button", { name: "Back", exact: true });
  const next = page.locator(".coach__btn--go");
  const pepper = page.getByLabel("Include pepper");
  await back.click();
  await step("editor.pepper", first + 3);
  check(!(await pepper.isChecked()), `${label}: Back keeps pepper off`);
  check(
    (await page.locator(".coach__text").innerText()).includes(
      "Pepper is off. Select Next.",
    ),
    `${label}: Back describes the disabled pepper`,
  );
  check(
    (await next.getAttribute("aria-disabled")) !== "true",
    `${label}: an already disabled pepper allows Next`,
  );
  await next.click();
  await step("editor.generate-password", first + 4);
  await back.click();
  await step("editor.pepper", first + 3);
  await pepper.check();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".coach__btn--go")
        ?.getAttribute("aria-disabled") === "true",
  );
  check(true, `${label}: re-enabling pepper requires turning it off again`);
  await pepper.uncheck();
  await step("editor.generate-password", first + 4);
}
