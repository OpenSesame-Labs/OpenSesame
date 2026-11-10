/**
 * Deleting a vault from this device, as a ceremony in a sheet — the one
 * confirmation every delete road shares (Settings → Vaults, Settings →
 * Danger, and the unlock screen's forgotten-key road).
 *
 * The facts are only ever what the road can know. A locked vault is never
 * read first, so a locked road says what is cleared and that it cannot be
 * exported or recovered, and never invents a count. The open vault's road
 * knows its count and names it. The sheet's close key is the only
 * non-destructive way out and takes the focus first; the danger key is the
 * one press that deletes. Export stays its own road — it is named in the
 * facts, never run from inside a delete.
 */

import { CeremonySheet } from "./CeremonySheet.js";
import { type CeremonyFact, CeremonyShell } from "./CeremonyShell.js";
import { IconTrash } from "./Icons.js";

export function DeleteVaultSheet({
  label,
  busy,
  itemCount,
  locked = false,
  onDelete,
  onClose,
}: {
  label: string;
  busy: boolean;
  /** What goes with it, when the vault is open and the count is knowable. */
  itemCount?: number;
  /** A locked vault: nothing read, nothing countable, no export first. */
  locked?: boolean;
  onDelete: () => void;
  onClose: () => void;
}) {
  const facts: CeremonyFact[] = locked
    ? [
        { key: "Cleared", value: "its files in this browser" },
        { key: "Read first", value: "nothing; it is locked" },
        { key: "Export first", value: "not possible while locked" },
        { key: "Recoverable", value: "no" },
      ]
    : itemCount !== undefined
      ? [
          {
            key: "Cleared",
            value: `${itemCount} sealed ${itemCount === 1 ? "item" : "items"} in this browser`,
          },
          { key: "Recoverable", value: "no — export first if not certain" },
        ]
      : [
          { key: "Cleared", value: "its files in this browser" },
          { key: "Read first", value: "nothing; it is locked" },
          { key: "Recoverable", value: "no" },
        ];
  return (
    <CeremonySheet
      title="Delete a vault"
      mark={<IconTrash size={20} />}
      onClose={onClose}
    >
      <CeremonyShell
        name={label}
        facts={facts}
        primary={{
          label: "Delete vault",
          tone: "danger",
          busy,
          onClick: onDelete,
        }}
      />
    </CeremonySheet>
  );
}
