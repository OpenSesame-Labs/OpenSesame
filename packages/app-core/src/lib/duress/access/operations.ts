/**
 * AUTH-D operation helpers — prefer `./protect.js` for new call sites.
 * Kept for stable imports from access tests and older adapters.
 */

export { narrowCapabilities } from "./capability-narrow.js";
export {
  PROTECTED_OPERATIONS,
  type ProtectCheckInput,
  type ProtectedOperation,
  assertProtectedOperation as assertProtectedOperationStrict,
  isProtectedOperation,
  withProtectedOperation,
} from "./protect.js";
