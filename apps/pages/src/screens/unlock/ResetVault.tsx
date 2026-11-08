import { useState } from "react";
import { DeleteVaultSheet } from "../../components/DeleteVaultSheet.js";
import { IconKey } from "../../components/IconKey.js";
import { IconTrash, IconX } from "../../components/Icons.js";

/**
 * "Forgotten how to unlock?", answered: the consequence in prose, then the
 * two keys — delete this vault, or keep it. The verbs are the keys' names,
 * never words painted on them (DESIGN.md § Actions are symbols). Closed, it
 * is the question itself.
 *
 * The delete key never deletes: it opens the same confirmation sheet every
 * delete road shares, in its locked form — no count (the vault is sealed
 * and is never read to count it), no export (not possible while locked),
 * and the sheet's close key as the way back, so a locked-out person is
 * never one stray press from losing the vault or trapped into deleting it.
 */
export function ResetVault({
  open,
  onOpen,
  onDelete,
  onKeep,
}: {
  open: boolean;
  onOpen: () => void;
  onDelete: () => void;
  onKeep: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!open) {
    return (
      <button type="button" className="unlock__switch" onClick={onOpen}>
        Forgotten how to unlock?
      </button>
    );
  }
  return (
    <div className="unlock__danger">
      <p>
        Deleting removes the encrypted vault from this browser. Without an
        enrolled unlock method its contents are already unrecoverable — this
        only clears the file so you can start again.
      </p>
      <div className="actions">
        <IconKey label="Delete this vault" onClick={() => setConfirming(true)}>
          <IconTrash size={16} />
        </IconKey>
        <IconKey label="Keep it" small onClick={onKeep}>
          <IconX size={16} />
        </IconKey>
      </div>
      {confirming ? (
        <DeleteVaultSheet
          label="This vault"
          busy={false}
          locked
          onDelete={() => {
            setConfirming(false);
            onDelete();
          }}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
}
