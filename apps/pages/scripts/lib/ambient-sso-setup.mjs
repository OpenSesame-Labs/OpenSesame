import { addCapabilities, lockVault, sealWithPin } from "./pages-journey.mjs";

/** Approve optional ambient SSO and return to a locked vault before boot. */
export async function prepareAmbientInstallation(page) {
  await sealWithPin(page);
  await addCapabilities(page, ["Ambient single sign-on"]);
  await lockVault(page);
}
