import { webLocksDouble } from "@opensesame/app-core/lib/__tests__/web-locks-double.js";
import { vi } from "vitest";

/** Test Web Locks honor shared, exclusive and if-available requests. */
export const testLockManager = webLocksDouble();

export function installTestLocks(): void {
  vi.stubGlobal("navigator", { locks: testLockManager });
}
