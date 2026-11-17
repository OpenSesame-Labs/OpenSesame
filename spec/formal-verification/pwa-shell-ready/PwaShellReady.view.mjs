export const state = (v) => {
  if (v.status === "locked") return "vault locked";
  if (v.timedOut) return "shell opened after wait";
  if (v.actGen === v.compGen && v.planVault === v.vault) return "shell ready";
  return "vault open, composition activating";
};

export const step = (action) => {
  if (action === "UnlockPersonal") return "the vault unlocks";
  if (action === "PlanForPersonal") return "the vault plan loads";
  if (action === "ClearStaleLatch") return "the stale open latch clears";
  if (action === "ActivationCatchUp") return "modules finish activating";
  if (action === "ReadyOpens") return "the shell mounts";
  if (action === "WaitTimeout") return "the wait times out";
  return action;
};
