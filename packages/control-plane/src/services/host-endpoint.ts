import { secureServiceEndpoint } from "../deployment-mode.js";

export function hostApiEndpoint(
  configuredUrl: string,
  path: string,
): URL | undefined {
  try {
    const base = secureServiceEndpoint(configuredUrl);
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    return new URL(path.replace(/^\/+/, ""), base);
  } catch {
    return undefined;
  }
}
