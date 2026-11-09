/**
 * The two tours that put something into the vault: the guided first item an
 * empty vault offers, and adding an item any time after. Both open the list
 * pane (`/vault/list`) — a phone's bare `/vault` is the section tree, where
 * neither the list nor New item is mounted — and both wait for the person
 * to press New item themselves: a tour points, the person acts.
 *
 * The first-item tour's Save step waits until the vault HOLDS an item
 * (`vault.has-items`), not for Save to be pressed or the editor to
 * close: `activate` fires before the form runs, so a rejected draft
 * would complete the step, and Cancel or Escape closes the editor
 * without a write. Only a save that actually seals makes the predicate
 * true. A successful save lands on the item's own page — so the tour
 * then opens the list itself and finishes standing over the saved
 * item. Like every beat the step can be skipped with Next; no editor
 * action completes it early.
 */

import type { GuideGoalDescriptor } from "./goal-types.js";

export const FIRST_ITEM_GOAL: GuideGoalDescriptor = {
  id: "vault.item.first",
  title: "Add your first password",
  routes: [],
  requires: ["vault.empty"],
  guide: [
    "guide/1",
    'goal "vault.item.first"',
    'say "This walkthrough adds the vault\'s first item, step by step. Use a real login when you are ready — or a practice one you delete after; fake details are fine. The tour points and explains; only you type, and only you save."',
    'navigate "/vault/list"',
    'wait route "/vault/list" timeout=15000',
    'focus "vault.create" "New item opens the editor. Press it when you are ready — nothing is stored until you save inside the editor." side=bottom',
    'wait target "vault.create" event=activate timeout=60000',
    'wait target "item.editor.name" event=appear timeout=15000',
    'focus "item.editor.name" "Name the item: the site or service it is for, as you would look for it later. For a practice run, Practice is a fine name." side=bottom',
    'say "Under the name are the website, username and password fields. Fill in what you have; anything blank can be added later by editing the item. This tour never points at the password field and never reads what you type."',
    'focus "item.editor.save" "When the fields hold what they should, press Save — it seals the item into the vault on this device. The tour waits here until the item is saved; take as long as you need, and fix anything the editor asks about first." side=top',
    'wait state "vault.has-items" is=true timeout=60000',
    'navigate "/vault/list"',
    'wait route "/vault/list" timeout=15000',
    'wait target "vault.list" event=appear timeout=15000',
    'focus "vault.list" "Saved items stand in this list — yours included, once you have saved it. Open it any time to copy its password without showing it." side=right',
    'success "Because the vault lives in this browser, set up a backup next — the Export walkthrough shows how, and the unlock screen will remind you until one is working."',
    "end",
  ].join("\n"),
};

export const CREATE_ITEM_GOAL: GuideGoalDescriptor = {
  id: "vault.item.create",
  title: "Add an item to the vault",
  routes: [],
  guide: [
    "guide/1",
    'goal "vault.item.create"',
    'say "Items are sealed on this device. Nothing you type here is uploaded anywhere."',
    'navigate "/vault/list"',
    'wait route "/vault/list" timeout=15000',
    'focus "vault.list" "Everything the vault holds is listed here, grouped by folder and narrowed by whichever filter is active." side=right',
    'focus "vault.create" "New item opens the editor for the kind the current filter names — an account unless you narrowed the list. Nothing is stored until you save. The n key does the same from the list." side=bottom',
    'wait target "vault.create" event=activate timeout=60000',
    'success "Name it, enter the secret and save. The item is sealed with the rest of the vault."',
    "end",
  ].join("\n"),
};
