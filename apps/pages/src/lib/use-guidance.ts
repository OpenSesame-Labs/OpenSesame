import {
  type GuidanceRecord,
  loadGuidance,
  subscribeGuidance,
} from "@opensesame/app-core/lib/guidance.js";
import { useSyncExternalStore } from "react";

/** What this device has been shown, and how tours are offered (ADR 0221). */
export function useGuidance(): GuidanceRecord {
  return useSyncExternalStore(subscribeGuidance, loadGuidance, loadGuidance);
}
