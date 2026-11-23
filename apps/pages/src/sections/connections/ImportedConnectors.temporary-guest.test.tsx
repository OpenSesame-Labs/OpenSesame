/** @vitest-environment jsdom */
/**
 * A temporary guest beside a protected guest (the scratch tomb) keeps what it
 * imports: the connector list lands in the tomb that is actually open and is
 * read back from it, never routed to the protected guest's locked tomb.
 * Real VaultStore singleton, real `useVault`, real VFS and sealing.
 */
import {
  DIRECTORY_PATH,
  clearPendingConnectorDirectory,
  connectorDirectorySeams,
  pendingConnectorDirectory,
  syncConnectorDirectory,
} from "@opensesame/app-core/lib/connector-directory.js";
import {
  DECOY_SCRATCH_TOMB,
  presentedTomb,
} from "@opensesame/app-core/lib/duress/store/decoy-scratch.js";
import { kvDelete, kvGet, kvSet } from "@opensesame/app-core/lib/kv.js";
import type { DirectoryConnection } from "@opensesame/app-core/lib/nango-directory.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  BODY_PATH,
  GUEST_TOMB,
  HEADER_PATH,
  tombFileKey,
  vfsFlush,
} from "@opensesame/app-core/lib/vfs.js";
import { createVault } from "@opensesame/vault-core";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useVault } from "../../lib/vault/hooks.js";
import { connectorUnlockEffects } from "../../modules/connectors.external/unlock-effects.js";
import { useImportedDirectory } from "./ImportedConnectors.js";

const github: DirectoryConnection = {
  id: "1",
  connectionId: "octocat",
  integrationId: "github",
  provider: "github",
  displayName: "GitHub",
  endUser: "octo@example.com",
  createdAt: null,
  errors: 0,
};

const GUEST_HEADER = tombFileKey(GUEST_TOMB, HEADER_PATH);
const originalList = connectorDirectorySeams.listDirectory;
let sealedHeader = "";

/** What Connections reads: the open vault's imported list, by `useVault().tomb`. */
function Imported() {
  const { tomb } = useVault();
  const imported = useImportedDirectory(tomb);
  if (!imported.record) return <p>Nothing imported</p>;
  return (
    <ul aria-label="Imported">
      {imported.record.connections.map((row) => (
        <li key={row.id}>{row.displayName}</li>
      ))}
    </ul>
  );
}

beforeEach(async () => {
  connectorDirectorySeams.listDirectory = vi.fn(async () => ({
    integrations: [],
    connections: [github],
  }));
  vaultStore.lock();
  await vaultStore.flushPendingWrites();
  // A guest vault its owner protected with a password: a sealed gate.
  const { header } = await createVault("correct horse battery staple");
  sealedHeader = JSON.stringify(header);
  kvSet(GUEST_HEADER, sealedHeader);
  // An ordinary Continue as guest beside it runs in its own isolated tomb.
  vaultStore.prepareGuestUnlock();
  await vaultStore.createGuest();
});

afterEach(async () => {
  cleanup();
  vaultStore.lock();
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  clearPendingConnectorDirectory();
  connectorDirectorySeams.listDirectory = originalList;
  kvDelete("connector-directory.v1");
  for (const tomb of [GUEST_TOMB, DECOY_SCRATCH_TOMB]) {
    kvDelete(tombFileKey(tomb, HEADER_PATH));
    kvDelete(tombFileKey(tomb, BODY_PATH));
  }
  vi.restoreAllMocks();
});

function protectedGuestUntouched(): void {
  expect(kvGet(GUEST_HEADER)).toBe(sealedHeader);
  expect(kvGet(tombFileKey(GUEST_TOMB, DIRECTORY_PATH))).toBeNull();
}

it("imports connectors into the temporary guest and lists them back", async () => {
  const snap = vaultStore.getSnapshot();
  expect(snap).toMatchObject({ status: "unlocked", guest: true });
  expect(snap.tomb).toMatch(/^guest_[0-9a-f-]{36}$/u);
  expect(presentedTomb(snap.tomb)).toBe(snap.tomb);

  // Connections imports into the open vault, as the page does.
  await syncConnectorDirectory({
    endpoint: "https://api.nango.dev",
    key: "sk-env",
    tomb: snap.tomb,
  });
  expect(pendingConnectorDirectory()).toBeNull();

  render(<Imported />);
  const list = within(await screen.findByRole("list", { name: "Imported" }));
  expect(list.getByText("GitHub")).toBeTruthy();
  protectedGuestUntouched();
});

it("seals a list synced before the vault opened into the temporary guest", async () => {
  // A sync with no open vault waits in memory for the first one to open.
  await syncConnectorDirectory({
    endpoint: "https://api.nango.dev",
    key: "sk-env",
    tomb: null,
  });
  expect(pendingConnectorDirectory()).not.toBeNull();

  // The unlock effect runs with the tomb the shell hands every effect.
  const [seal] = connectorUnlockEffects(new AbortController().signal);
  const { tomb, guest } = vaultStore.getSnapshot();
  await act(async () => {
    await seal?.run({ tomb, guest, signal: new AbortController().signal });
  });
  expect(pendingConnectorDirectory()).toBeNull();

  render(<Imported />);
  const list = within(await screen.findByRole("list", { name: "Imported" }));
  expect(list.getByText("GitHub")).toBeTruthy();
  protectedGuestUntouched();
});
