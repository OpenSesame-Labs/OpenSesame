/**
 * A vault with something in it, made the way a person makes one.
 *
 * Most tutorials are walked on an empty vault. The ones that point at an item's
 * own controls (favorite, edit, copy, trash, share) or at a filter a vault
 * grows once it holds an account are offered only where a vault holds an item, and
 * their steps point at nothing without one. So the walk makes a second pass:
 * it adds an item through the editor, trashes a second, and walks whatever the
 * library now offers that it did not before. Nothing is injected: the items
 * arrive through the same editor and the same Move to trash key a person uses.
 *
 * The installed item types determine whether the seed can create an account
 * or uses a secret instead (ADR 0153, ADR 0165).
 */

import { listedTypes } from "./editor-type.mjs";

/** Opens an in-app path the way the router hears the back button. */
async function openPath(page, path) {
  await page.evaluate((next) => {
    window.history.pushState({}, "", next);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

/**
 * Whether this installation lists account on the new-item type picker.
 * The picker is the bare `/vault/new` editor; a named route shows one type
 * and, when that type is not installed, no picker at all.
 */
async function offersAccount(page, base) {
  await openPath(page, `${base}vault/new`);
  await page
    .getByLabel("Name", { exact: true })
    .first()
    .waitFor({ timeout: 15000 });
  const type = page.getByLabel("Type", { exact: true });
  if ((await type.count()) === 0) return false;
  return (await listedTypes(page)).includes("account");
}

/** Adds one item through the editor and lands on its pane. */
async function addItem(page, base, kind, fields) {
  await openPath(page, `${base}vault/new/${kind}`);
  const name = page.getByLabel("Name", { exact: true }).first();
  await name.waitFor({ timeout: 15000 });
  // The editor applies its new draft after the route transition.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await name.fill(fields.name);
  if (kind === "account") {
    await page
      .getByLabel("Username / ID", { exact: true })
      .fill(fields.username);
    await page.getByLabel("Password", { exact: true }).fill(fields.password);
  } else {
    await page.getByLabel("Secret value", { exact: true }).fill(fields.value);
  }
  await page.getByRole("button", { name: "Save item" }).first().click();
  await page
    .getByRole("heading", { level: 1, name: fields.name })
    .waitFor({ timeout: 15000 });
}

/**
 * One live item and one item in the trash, so item tours have a pane to
 * open and the trash tour has a row to point its keys at. The live item
 * holds a value, so Share once is drawn for the share tour.
 */
export async function seedVault(page, base) {
  const kind = (await offersAccount(page, base)) ? "account" : "secret";
  await addItem(page, base, kind, {
    name: "Tutorial login",
    username: "walker",
    password: "correct-horse-battery-staple-9",
    value: "correct-horse-battery-staple-9",
  });
  const trashName = "Tutorial trash";
  await addItem(page, base, kind, {
    name: trashName,
    username: "walker",
    password: "another-long-password-1234",
    value: "another-long-password-1234",
  });
  await page
    .getByRole("button", { name: "Move to trash", exact: true })
    .click();
  await page.getByRole("button", { name: "Really move to trash?" }).click();
  await openPath(page, `${base}vault?f=trash`);
  await page.getByRole("treeitem", { name: new RegExp(trashName) }).waitFor({
    timeout: 15000,
  });
}
