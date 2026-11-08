import { listDeviceVaults } from "@opensesame/app-core/lib/vaults.js";
import { type VaultItem, listedItems } from "@opensesame/vault-core";
import { useState } from "react";
import { DeleteVaultSheet } from "../components/DeleteVaultSheet.js";
import { IconKey } from "../components/IconKey.js";
import { IconRefresh, IconTrash, IconX } from "../components/Icons.js";
import { useVault, useVaultStore } from "../lib/vault/hooks.js";
import { TransferVaultSection } from "./settings/TransferVaultSection.js";
import { PURGE_CONFIRM } from "./vault/vault-menu.js";

/** The open vault's name, as the vault list names it — never a raw tomb id. */
function openVaultLabel(): string {
  return (
    listDeviceVaults().find((vault) => vault.state === "open")?.label ??
    "this vault"
  );
}

/** A trashed item: the vault store holds it until it is restored or purged. */
function isTrashed(item: VaultItem): boolean {
  return item.deletedAt != null;
}

/** Deleting the open vault: the row names which vault and what goes with it. */
function DeleteVaultSection({
  confirmDestroy,
  count,
  onArm,
  onCancel,
  onDestroy,
}: {
  confirmDestroy: boolean;
  count: string;
  onArm: () => void;
  onCancel: () => void;
  onDestroy: () => void;
}) {
  return (
    <section className="panel set__danger" id="settings-delete-vault">
      <div className="panel__head">
        <div>
          <h2>Delete this vault</h2>
        </div>
      </div>
      <div className="panel__body">
        <div className="keyed-row">
          <p className="set__danger-target">
            <strong>{openVaultLabel()}</strong>
            {confirmDestroy
              ? ` · ${count} will be unrecoverable. Export first if you are not certain.`
              : ` · ${count}`}
          </p>
          {confirmDestroy ? (
            <>
              <IconKey label="Delete permanently" armed onClick={onDestroy}>
                <IconTrash size={16} />
              </IconKey>
              <IconKey label="Cancel" onClick={onCancel}>
                <IconX size={16} />
              </IconKey>
            </>
          ) : (
            <IconKey label="Delete this vault" onClick={onArm}>
              <IconTrash size={16} />
            </IconKey>
          )}
        </div>
      </div>
    </section>
  );
}

/** The open vault's delete confirmation, naming what goes with it. */
function DestroyConfirm({
  count,
  onDestroy,
  onClose,
}: {
  count: number;
  onDestroy: () => void;
  onClose: () => void;
}) {
  return (
    <DeleteVaultSheet
      label={openVaultLabel()}
      busy={false}
      itemCount={count}
      onDelete={() => {
        onClose();
        onDestroy();
      }}
      onClose={onClose}
    />
  );
}

/** The trashed items, each restorable or deletable — the delete armed. */
function TrashList({
  armPurge,
  purgeArmedId,
  purge,
  restore,
  trashed,
}: {
  armPurge: (id: string) => void;
  purgeArmedId: string | null;
  purge: (id: string) => void;
  restore: (id: string) => void;
  trashed: VaultItem[];
}) {
  return (
    <ul className="set__trash-list">
      {trashed.map((item) => {
        const armed = purgeArmedId === item.id;
        return (
          <li className="set__trash-row" key={item.id}>
            <span className="set__trash-name">{item.name}</span>
            <span className="set__trash-when">
              {new Date(item.deletedAt ?? "").toLocaleDateString()}
            </span>
            <span className="set__trash-keys">
              <button
                type="button"
                className="icon-btn icon-btn--sm"
                aria-label={`Restore ${item.name}`}
                title={`Restore ${item.name}`}
                onClick={() => restore(item.id)}
              >
                <IconRefresh size={15} />
              </button>
              <button
                type="button"
                className={`icon-btn icon-btn--sm${armed ? " is-armed" : ""}`}
                aria-label={
                  armed ? PURGE_CONFIRM : `Delete ${item.name} permanently`
                }
                title={
                  armed ? PURGE_CONFIRM : `Delete ${item.name} permanently`
                }
                onClick={() => {
                  if (armed) {
                    purge(item.id);
                  } else {
                    armPurge(item.id);
                  }
                }}
              >
                <IconTrash size={15} />
              </button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}


/** The trash section: what is in it, and emptying it behind an armed key. */
function TrashSection({
  trashed,
  trashCount,
  emptyArmed,
  purgeArmedId,
  onArmEmpty,
  onEmpty,
  onCancelEmpty,
  onArmPurge,
  onPurge,
  onRestore,
}: {
  trashed: VaultItem[];
  trashCount: string;
  emptyArmed: boolean;
  purgeArmedId: string | null;
  onArmEmpty: () => void;
  onEmpty: () => void;
  onCancelEmpty: () => void;
  onArmPurge: (id: string) => void;
  onPurge: (id: string) => void;
  onRestore: (id: string) => void;
}) {
  return (
      <section className="panel set__danger" id="settings-trash">
        <div className="panel__head">
          <div>
            <h2>Trash</h2>
          </div>
        </div>
        <div className="panel__body">
          {trashed.length === 0 ? (
            <p className="set__danger-target">Trash is empty.</p>
          ) : (
            <>
              <div className="keyed-row">
                <p className="set__danger-target">
                  {trashCount} in the trash
                  {emptyArmed
                    ? " · emptying is unrecoverable. Export first if you are not certain."
                    : ""}
                </p>
                {emptyArmed ? (
                  <>
                    <IconKey
                      label="Empty the trash"
                      armed
                      onClick={onEmpty}
                    >
                      <IconTrash size={16} />
                    </IconKey>
                    <IconKey
                      label="Cancel"
                      onClick={onCancelEmpty}
                    >
                      <IconX size={16} />
                    </IconKey>
                  </>
                ) : (
                  <IconKey label="Empty the trash" onClick={onArmEmpty}>
                    <IconTrash size={16} />
                  </IconKey>
                )}
              </div>
              <TrashList
                armPurge={onArmPurge}
                purgeArmedId={purgeArmedId}
                purge={onPurge}
                restore={onRestore}
                trashed={trashed}
              />
            </>
          )}
        </div>
      </section>
  );
}

/**
 * Deleting the open vault, and the trash it holds. The vault row names
 * which vault and what goes with it before the key is pressed; the
 * trash lists what is in it, restores one, or empties it — each key
 * ending the row it acts on (DESIGN.md § Keys have a home), and each
 * destructive one armed a press before it fires.
 */
export function SettingsDangerPanel() {
  const { items } = useVault();
  const store = useVaultStore();
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const [destroySheet, setDestroySheet] = useState(false);
  const [emptyArmed, setEmptyArmed] = useState(false);
  const [purgeArmedId, setPurgeArmedId] = useState<string | null>(null);
  const listed = listedItems(items);
  const trashed = listed.filter(isTrashed);
  const noun = listed.length === 1 ? "item" : "items";
  const count = `${listed.length} ${noun} (${trashed.length} in trash)`;
  const trashCount = `${trashed.length} ${
    trashed.length === 1 ? "item" : "items"
  }`;

  // One armed key at a time: arming a second spends the first.
  const armEmpty = () => {
    setPurgeArmedId(null);
    setEmptyArmed(true);
  };
  const armPurge = (id: string) => {
    setEmptyArmed(false);
    setPurgeArmedId(id);
  };

  return (
    <>
      <TransferVaultSection />

      {/* Proportional friction: an empty vault arms in place; a vault with
          anything in it gets the confirmation sheet, naming the count. */}
      <DeleteVaultSection
        confirmDestroy={confirmDestroy}
        count={count}
        onArm={() =>
          listed.length > 0 ? setDestroySheet(true) : setConfirmDestroy(true)
        }
        onCancel={() => setConfirmDestroy(false)}
        onDestroy={() => void store.destroy()}
      />
      {destroySheet ? (
        <DestroyConfirm
          count={listed.length}
          onDestroy={() => void store.destroy()}
          onClose={() => setDestroySheet(false)}
        />
      ) : null}

      <TrashSection
        trashed={trashed}
        trashCount={trashCount}
        emptyArmed={emptyArmed}
        purgeArmedId={purgeArmedId}
        onArmEmpty={armEmpty}
        onEmpty={() => {
          setEmptyArmed(false);
          setPurgeArmedId(null);
          void store.emptyTrash();
        }}
        onCancelEmpty={() => setEmptyArmed(false)}
        onArmPurge={armPurge}
        onPurge={(id) => {
          setPurgeArmedId(null);
          void store.purgeItem(id);
        }}
        onRestore={(id) => {
          setPurgeArmedId(null);
          void store.restoreItem(id);
        }}
      />
    </>
  );
}
