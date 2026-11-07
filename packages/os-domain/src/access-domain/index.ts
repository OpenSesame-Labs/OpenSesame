/**
 * Access domains: a realm-bound forest of authority containers.
 *
 * The client-plane mirror of `crates/domain/src/access_domain`. An access
 * domain is a named place authority lives, domains nest, and a forest never
 * crosses a realm — the org/project boundary ADR 0038 established. That one
 * refusal is what keeps a vault's project crypto binding from drifting and what
 * keeps a personal project unshareable, however deeply its estate is nested.
 */

export * from "./bridge.js";
export * from "./control.js";
export * from "./forest.js";
export * from "./mutate.js";
export * from "./node.js";
export * from "./realm.js";
export * from "./temporal.js";
