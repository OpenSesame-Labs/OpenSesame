/**
 * The core's portable entry (ADR 0133 §6): what an isolate loads after the
 * runtime contract is installed. Loading it installs no host and touches no
 * platform global; the embedder calls `configureHost(createSandboxHost())`
 * before using anything that reads a port.
 */

export {
  VaultCorruptError,
  WrongPasswordError,
  buildRows,
  createItem,
  hostOf,
  openVaultFile,
  readVaultFile,
  searchMatches,
  sortItems,
} from "@opensesame/vault-core";
export { configureHost } from "../host.js";
export { testWebsitePattern } from "../lib/vault/website-pattern.js";
export { createSandboxHost } from "./host.js";
