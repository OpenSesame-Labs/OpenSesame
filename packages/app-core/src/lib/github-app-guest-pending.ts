/** Retry a converted GitHub App key while its original guest remains open. */
import { captureGuestSessionContext } from "./guest-session-context.js";
import { dismissNotice, setStatusNotice } from "./notices.js";
import { onVaultLock } from "./vault/lock-events.js";

const ID = "github-app.guest-save";
type Pending = {
  retry: (check: () => void) => Promise<void>;
  owner: () => boolean;
  busy: boolean;
};
let pending: Pending | null = null;

export function clearPendingGuestGithubClaim(): void {
  pending = null;
  dismissNotice(ID);
}
onVaultLock(clearPendingGuestGithubClaim);

function show(): void {
  setStatusNotice({
    id: ID,
    tone: "err",
    title: "GitHub App key not saved",
    body: "GitHub created the App, but its key could not be saved. Keep this vault open and try again.",
    retry: () => {
      void retryPendingGuestGithubClaim();
    },
    transient: true,
  });
}

export function stagePendingGuestGithubClaim(retry: Pending["retry"]): void {
  const owner = captureGuestSessionContext();
  if (!owner?.()) return;
  pending = { retry, owner, busy: false };
  show();
}

export async function retryPendingGuestGithubClaim(): Promise<void> {
  const current = pending;
  if (!current || current.busy) return;
  current.busy = true;
  const check = () => {
    if (pending !== current || !current.owner())
      throw new Error("The guest session ended.");
  };
  try {
    check();
    await current.retry(check);
    check();
    clearPendingGuestGithubClaim();
  } catch {
    if (pending === current && current.owner()) show();
  } finally {
    current.busy = false;
  }
}
