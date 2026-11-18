import { isKnownGuidePredicate, readGuidePredicate } from "./state.js";

/** Use the primary pointer, not screen width, to choose instructional copy. */
export function isTouchGuide(): boolean {
  return (
    isKnownGuidePredicate("shell.touch") && readGuidePredicate("shell.touch")
  );
}
