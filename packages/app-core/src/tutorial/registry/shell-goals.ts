/**
 * Shell command-bar walkthrough — kept out of `goals.ts` so that file's
 * recorded line debt does not rise (ADR 0093).
 */

import { DURESS_GOALS, DURESS_HELP } from "./duress-goals.js";
import type { GuideGoalDescriptor, HelpTopic } from "./goals.js";
import { KEYBOARD_GOALS } from "./keyboard-goals.js";
import { SETTINGS_GOALS } from "./settings-goals.js";
import { SHELL_TOUR_GOALS } from "./shell-tour-goals.js";
import { VAULT_ITEM_GOALS } from "./vault-item-goals.js";

export const SHELL_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "vault.import",
    title: "Import items from another password manager",
    routes: [],
    guide: [
      "guide/1",
      'goal "vault.import"',
      'say "Import takes a .env, .csv, .json, .1pux, .zip or .kdbx export and merges it into this vault. Nothing leaves the device."',
      'navigate "/vault/list"',
      'wait route "/vault/list" timeout=15000',
      'focus "vault.import" "Select Import and choose a file. On a phone, hold +, slide up to Import, then release. Review the preview before importing." side=bottom',
      'wait target "vault.import" event=activate timeout=60000',
      'success "Choose a file and confirm the import to add its items to your vault."',
      "end",
    ].join("\n"),
  },

  {
    id: "client.command-bar",
    title: "Run a command from the bar",
    routes: [],
    guide: [
      "guide/1",
      'goal "client.command-bar"',
      'say "Use the command bar to navigate, search or copy a field. If it cannot interpret what you type, it sends the text to Support as a question."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'focus "shell.command-bar" "Type a command to go to a section, search or copy a field. Select the arrow to run it." side=bottom',
      "end",
    ].join("\n"),
  },

  ...DURESS_GOALS,
  ...SHELL_TOUR_GOALS,
  ...SETTINGS_GOALS,
  ...VAULT_ITEM_GOALS,
  ...KEYBOARD_GOALS,
];

/** The shell's help topics, drawn beside the walkthroughs they open. */
export const SHELL_HELP: readonly HelpTopic[] = [
  {
    id: "help.vault.import",
    title: "How do I bring items in from another password manager?",
    answer:
      "Import a file from another password manager, an .env file, or an encrypted backup. Review the items before confirming the import.",
    routes: [],
    goal: "vault.import",
    keywords: [
      "import",
      "migrate",
      "bring",
      "move",
      "1password",
      "bitwarden",
      "lastpass",
      "keepass",
      "kdbx",
      "csv",
      "json",
      "env",
      "another password manager",
      "transfer",
      "manifest",
      "sealed store",
    ],
  },
  ...DURESS_HELP,
];
