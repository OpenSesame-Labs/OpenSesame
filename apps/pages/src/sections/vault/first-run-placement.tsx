import type { ComponentProps, ReactNode } from "react";
import type { VaultPane } from "../../lib/vault-list-path.js";
import { FirstItemOffer } from "./FirstItemOffer.js";

/**
 * Where the first-run offer stands among the vault's panes. Both panes stay
 * mounted on a phone, so the roads are drawn in one only: on the section tree
 * a phone lands on (ADR 0221), and in the list everywhere else.
 */
export function firstRunPlacement(
  narrow: boolean,
  showing: VaultPane,
  offer: ComponentProps<typeof FirstItemOffer>,
): { tree: ReactNode; list: ReactNode } {
  const element = <FirstItemOffer {...offer} />;
  return narrow && showing === "tree"
    ? { tree: element, list: null }
    : { tree: null, list: element };
}
