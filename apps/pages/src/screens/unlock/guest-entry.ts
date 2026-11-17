import { continueAsGuest } from "@opensesame/app-core/lib/guest-auth.js";
import {
  clearNewGuestLanding,
  markNewGuestLanding,
} from "../../lib/guest-landing.js";

/** A new guest opens an empty vault, even when the old URL named an item. */
export async function startGuestSession(): Promise<void> {
  markNewGuestLanding();
  try {
    await continueAsGuest();
  } catch (error) {
    clearNewGuestLanding();
    throw error;
  }
}
