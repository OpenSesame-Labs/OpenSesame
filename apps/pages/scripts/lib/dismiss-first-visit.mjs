/** Decline the optional first-visit walkthrough as a person can in the shell. */
export async function dismissFirstVisitOffer(page) {
  const offers = page.locator(
    '[data-first-visit-offer] aside[aria-label$=" walkthrough"]',
  );
  for (const offer of await offers.all()) {
    if (!(await offer.isVisible())) continue;
    await offer.getByRole("button", { name: "Not now", exact: true }).click();
    return true;
  }
  return false;
}
