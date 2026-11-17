/** Decline the optional first-visit walkthrough as a person can in the shell. */
export async function dismissFirstVisitOffer(page) {
  const offer = page.locator(".toast--offer").filter({ hasText: "New here?" });
  if (!(await offer.isVisible())) return false;
  await offer.getByRole("button", { name: "Dismiss", exact: true }).click();
  return true;
}
