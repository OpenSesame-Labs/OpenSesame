import { createHmac } from "node:crypto";

/** The code an authenticator produces from the setup key shown in this test vault. */
function authenticatorCode(key) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of key.replace(/\s|=/g, "").toUpperCase()) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error("The setup key is not base32.");
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes))
    .update(counter)
    .digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(number).padStart(6, "0");
}

/** Enroll a disposable vault authenticator and make recovery codes through the UI. */
export async function configureRecoveryCodes(page, { base }) {
  await page.evaluate((path) => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}settings/security`);
  const authenticator = page
    .locator(".sw--method")
    .filter({ has: page.getByText("Authenticator app", { exact: true }) });
  await authenticator.getByRole("button", { name: "Add", exact: true }).click();
  await page
    .getByRole("button", { name: "Can't scan? Type the key instead" })
    .click();
  const key = await page.getByLabel("Setup key", { exact: true }).inputValue();
  await page.getByRole("button", { name: "I scanned it" }).click();
  await page
    .getByLabel("Six digits", { exact: true })
    .fill(authenticatorCode(key));
  await page.getByRole("button", { name: "Turn on", exact: true }).click();
  await page.getByRole("button", { name: "I saved them" }).click();
  await page.getByRole("button", { name: "View recovery codes" }).waitFor();
}
