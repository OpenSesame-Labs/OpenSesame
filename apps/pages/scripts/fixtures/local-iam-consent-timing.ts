import "./install-browser-host.js";
import { atRestReady } from "@opensesame/app-core/lib/at-rest/key.js";
import { configureLocalApplication } from "@opensesame/app-core/lib/local-applications.js";
import {
  type LocalDirectoryChange,
  readLocalDirectory,
} from "@opensesame/app-core/lib/local-directory.js";
import { changeLocalDirectory } from "@opensesame/app-core/lib/local-directory-admin.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";

/** Register Test application + callback on the vault the timing walk just unlocked. */
export async function registerConsentTimingApplication(redirectUri: string) {
  await atRestReady();
  if (!vaultStore.open) throw new Error("vault must be unlocked");
  const tomb = vaultStore.activeTomb();
  async function change(command: LocalDirectoryChange) {
    return changeLocalDirectory(
      tomb,
      (await readLocalDirectory(tomb)).revision,
      command,
    );
  }
  let directory = await readLocalDirectory(tomb);
  let app = directory.entries.find((row) => row.kind === "application");
  let org = directory.entries.find((row) => row.kind === "organization");
  let person = directory.entries.find((row) => row.kind === "person");
  if (!person) {
    await change({
      action: "create",
      kind: "person",
      name: "Local test person",
    });
    directory = await readLocalDirectory(tomb);
    person = directory.entries.find((row) => row.kind === "person");
  }
  if (!org) {
    await change({
      action: "create",
      kind: "organization",
      name: "Test organization",
    });
    directory = await readLocalDirectory(tomb);
    org = directory.entries.find((row) => row.kind === "organization");
  }
  if (!app) {
    directory = await change({
      action: "create",
      kind: "application",
      name: "Test application",
    });
    app = directory.entries.find((row) => row.kind === "application");
  }
  if (!person || !org || !app)
    throw new Error("Missing consent timing directory row");
  await change({
    action: "membership",
    organizationId: org.id,
    principalId: person.id,
    role: "owner",
  });
  directory = await readLocalDirectory(tomb);
  await configureLocalApplication(tomb, directory.revision, app.id, {
    applicationId: app.id,
    organizationId: org.id,
    redirectUris: [redirectUri],
    scopes: ["openid", "records:read"],
    scopeRoles: [
      { scope: "openid", roles: ["owner", "admin", "member"] },
      { scope: "records:read", roles: ["owner", "member"] },
    ],
  });
  return { app: app.id, person: person.id };
}
