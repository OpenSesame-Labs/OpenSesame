/** Guest rows and their protected on-device vaults. */
import type { OrgVaultRef } from "@opensesame/os-domain";
import { isGuestVaultId } from "./guest-vault-id.js";
import { guestVaultLabel } from "./local-guest.js";
import { headerCarriesGate } from "./vault/header-gate.js";
import { GUEST_TOMB, readTombHeader, vaultStore } from "./vault/store.js";
import { listTombs } from "./vfs.js";
import { guestReservationPresent } from "./vfs-registry.js";

export type DeviceVaultKind = "personal" | "project" | "guest";

export type DeviceVaultState =
  /** The tomb this session is scoped to, and it is open. */
  | "open"
  /** A sealed vault; unlocking is what opening it means. */
  | "locked"
  /** Registered but never sealed — it opens by sealing it. */
  | "empty";

export type DeviceVault = {
  /** The tomb name — a project id, `personal`, or `guest`. */
  readonly id: string;
  readonly kind: DeviceVaultKind;
  /** What to call it — a sealed name once known, else a label from the id. */
  readonly label: string;
  /** True when `label` is a real name rather than derived from the id. */
  readonly named: boolean;
  /** When the tomb was sealed, from its plaintext header. */
  readonly sealedAt: string | null;
  readonly state: DeviceVaultState;
  /** Opens with the key this session already holds — no prompt on switch. */
  readonly sharedKey: boolean;
  /**
   * Published `owner/slug` when the tomb header carries one that still
   * parses. Guest rows leave this unset. The sealed display name stays
   * `label` once it is known.
   */
  readonly address?: OrgVaultRef | null;
};

/** The guest road as a row: not a vault on disk, but a peer in the list. */
export function guestVault(state: DeviceVaultState = "empty"): DeviceVault {
  return {
    id: GUEST_TOMB,
    kind: "guest",
    label: guestVaultLabel(),
    named: true,
    sealedAt: null,
    state,
    sharedKey: false,
    address: null,
  };
}

/** An independent entry remains available when the legacy guest is protected. */
export const NEW_GUEST_ROAD = "guest-new";

export function protectedGuests(): DeviceVault[] {
  const current = vaultStore.getSnapshot();
  return listTombs()
    .filter(isGuestVaultId)
    .flatMap((id) => {
      if (guestReservationPresent(id)) return [];
      const header = readTombHeader(id);
      if (!headerCarriesGate(header)) return [];
      return [
        {
          id,
          kind: "guest" as const,
          label: id === GUEST_TOMB ? "guest" : `guest · ${id.slice(-4)}`,
          named: false,
          sealedAt: header?.createdAt ?? null,
          state:
            current.status === "unlocked" && current.tomb === id
              ? ("open" as const)
              : ("locked" as const),
          sharedKey: false,
          address: null,
        },
      ];
    });
}
