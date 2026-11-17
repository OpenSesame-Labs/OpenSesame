/** Exercise the guest password path on a phone with a real vault and clipboard. */
import { toTheList } from "./phone-vault.mjs";

async function section(page, name) {
  await page.getByRole("button", { name: "Sections", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Sections", exact: true });
  await drawer.getByRole("link", { name, exact: true }).click();
}

async function createGuestAccount(page, base, check) {
  await page
    .getByRole("button", { name: "Skip sign-in and continue as guest" })
    .click();
  await page.getByRole("button", { name: "Lock vault" }).first().waitFor();
  check(
    new URL(page.url()).pathname === `${base}vault`,
    "a new guest starts at the vault even when the old URL named an item",
  );
  await section(page, "Settings");
  await page
    .getByRole("link", { name: "Item types", exact: true })
    .first()
    .click();
  const account = page.getByRole("switch", { name: "Account", exact: true });
  if ((await account.getAttribute("aria-checked")) !== "true") {
    await account.click();
  }
  await page
    .locator('[data-guide-targets~="settings.account-ready"]')
    .waitFor();
  await section(page, "Vault");
  await toTheList(page);
  await page
    .getByRole("link", { name: "New item", exact: true })
    .first()
    .click();
  await page.getByLabel("Type", { exact: true }).click();
  await page
    .locator('[role="listbox"][aria-label="Type choices"] [data-key="account"]')
    .click();
  await page.getByLabel("Name", { exact: true }).fill("Guest test account");
  await page.getByLabel("Username / ID", { exact: true }).fill("example-user");
  await page.getByRole("button", { name: "Add address" }).click();
  await page
    .getByLabel("Address 1", { exact: true })
    .fill("https://example.test");
  await page.getByRole("button", { name: "Password options" }).click();
  await page.getByLabel("Include pepper").uncheck();
  await page.getByRole("button", { name: "Generate another password" }).click();
  await page.getByRole("button", { name: "Save item" }).click();
  await page
    .getByRole("heading", { level: 1, name: "Guest test account" })
    .waitFor();
}

async function regenerateAndCopy(page, check) {
  check(
    (await page
      .getByRole("button", { name: "Request password rotation" })
      .count()) === 0,
    "guest account does not offer an unavailable provider rotation",
  );
  await page
    .getByRole("link", { name: "Edit to generate", exact: true })
    .click();
  const password = page.getByLabel("Password", { exact: true }).first();
  await password.waitFor();
  const previous = await password.inputValue();
  await page.getByRole("button", { name: "Generate another password" }).click();
  const generated = await password.inputValue();
  check(
    generated.length > 0 && generated !== previous,
    "guest password is regenerated locally",
  );
  await page.getByRole("button", { name: "Save item" }).click();
  await page
    .getByRole("heading", { level: 1, name: "Guest test account" })
    .waitFor();
  await page
    .getByRole("button", { name: "Copy password", exact: true })
    .click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  check(
    copied === generated,
    "copy returns the newly generated and saved password",
  );
  check(
    (await page.getByText("The rotation could not be queued.").count()) === 0,
    "generating a guest password does not report a rotation failure",
  );
}

async function restartGuest(page, check) {
  await page.getByRole("button", { name: "Lock vault" }).first().click();
  await page.getByRole("heading", { name: "Guest vault cleared" }).waitFor();
  check(
    (await page
      .getByRole("button", { name: "Forgotten how to unlock?" })
      .count()) === 0,
    "an ended keyless guest does not offer a misleading unlock reset",
  );
  await page.getByRole("button", { name: "Continue as guest" }).click();
  await page.getByRole("button", { name: "Lock vault" }).first().waitFor();
  await toTheList(page);
  await page
    .getByRole("link", { name: "New item", exact: true })
    .first()
    .waitFor();
  check(
    (await page.getByText("Guest test account", { exact: true }).count()) === 0,
    "continuing as guest opens an empty vault instead of the previous item",
  );
}

export async function guestPasswordPass({
  page,
  context,
  origin,
  base,
  check,
}) {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  await page.goto(`${origin}${base}vault/previous-guest-item`, {
    waitUntil: "networkidle",
  });
  await createGuestAccount(page, base, check);
  await regenerateAndCopy(page, check);
  await restartGuest(page, check);
}

export async function walkGuestPassword(options) {
  const { phone, wants, newPage, width, origin, base, check } = options;
  if (!phone || !wants("gate.guest")) return;
  const { page, context } = await newPage(width);
  try {
    await guestPasswordPass({ page, context, origin, base, check });
  } catch (error) {
    check(
      false,
      `guest password: walking threw — ${String(error.message).split("\n").slice(0, 4).join(" ")}`,
    );
  } finally {
    await context.close();
  }
}
