/** Configure a same-origin test address through Settings, without making a sign-in. */
export async function configureSignInService(page, { origin, base }) {
  await page.evaluate((path) => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}settings/security`);
  const service = page
    .locator(".sw--method")
    .filter({ has: page.getByText("Sign-in service", { exact: true }) });
  await service.getByRole("button", { name: "Add", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Sign-in service", exact: true })
    .fill(`${origin}${base}test-identity`);
  await page.getByRole("button", { name: "Use this service" }).click();
  await service.getByRole("button", { name: "Change", exact: true }).waitFor();
}
