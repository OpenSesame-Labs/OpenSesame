import type { OrganizationWithdrawalAuditIntent } from "./organization-withdrawal-audit.js";

/** Stage only this transaction's audit-intent changes without losing other orgs' writes. */
export function forkMemoryAuditIntents(
  source: Map<string, OrganizationWithdrawalAuditIntent>,
) {
  const snapshot = new Map(source);
  const staged = new Map(source);
  function changedKeys() {
    return [...new Set([...snapshot.keys(), ...staged.keys()])].filter(
      (key) => snapshot.get(key) !== staged.get(key),
    );
  }
  function validate() {
    return changedKeys().every((key) => source.get(key) === snapshot.get(key));
  }
  return {
    store: staged,
    validate,
    commit() {
      if (!validate())
        throw new Error("Membership audit transaction changed concurrently");
      for (const key of changedKeys()) {
        const value = staged.get(key);
        if (value) source.set(key, value);
        else source.delete(key);
      }
    },
  };
}
