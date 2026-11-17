import { readFileSync } from "node:fs";

/**
 * Both Pages and app-core use MSAL. npm may install duplicate copies under
 * the workspaces when another workspace needs an older version. With equal
 * exact pins, resolve from Pages so its redirect bridge and app-core's
 * sign-in runtime share one browser SDK and the matching common library.
 * Different or ranged pins retain each workspace's own resolution.
 */
export function msalDedupe(pagesVersion, coreVersion) {
  return pagesVersion === coreVersion &&
    /^\d+\.\d+\.\d+$/.test(String(pagesVersion))
    ? ["@azure/msal-browser", "@azure/msal-common"]
    : [];
}

export function configuredMsalDedupe() {
  const version = (file) =>
    JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"))
      .dependencies?.["@azure/msal-browser"];
  return msalDedupe(
    version("../package.json"),
    version("../../../packages/app-core/package.json"),
  );
}
