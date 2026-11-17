import { lockManager, originFiles } from "../ports.js";
import { kvDurability } from "./kv.js";

/** Cookie-setting operations in this app share one browser-wide queue. */
export async function withIdentityCookieLock<T>(
  work: () => Promise<T>,
  requireShared = false,
): Promise<T> {
  const locks = lockManager();
  if (locks) return locks.request("opensesame:identity-cookie-session", work);
  if (requireShared && originFiles() && kvDurability() === "persistent")
    throw new Error(
      "This browser cannot safely change the shared sign-in session.",
    );
  return work();
}
