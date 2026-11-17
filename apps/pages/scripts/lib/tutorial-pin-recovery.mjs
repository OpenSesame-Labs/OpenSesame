/** Check that a person can correct skipped PIN fields before sealing. */
export async function revisitIncompletePin(page, step, check) {
  if (process.env.TUTORIALS_PIN_BACK !== "1") return;
  for (const [target, number] of [
    ["unlock.seal-pin-confirm", 6],
    ["unlock.seal-ack", 7],
    ["unlock.seal", 8],
  ]) {
    await page.locator(".coach__btn--go").click();
    await step(target, number);
  }
  check(
    await page.getByRole("button", { name: "Seal with PIN" }).isDisabled(),
    "first vault: incomplete PIN details cannot seal the vault",
  );
  for (const [target, number] of [
    ["unlock.seal-ack", 7],
    ["unlock.seal-pin-confirm", 6],
    ["unlock.seal-pin-entry", 5],
  ]) {
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await step(target, number);
  }
}
