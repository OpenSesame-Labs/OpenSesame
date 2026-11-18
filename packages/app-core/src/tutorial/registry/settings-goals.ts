/**
 * One tour per category of Settings, and one for each row a person comes to
 * Settings to use: the idle timer, the master password, the recovery codes.
 *
 * A tour points at a category or a row and says what it does. It never presses
 * anything and never asks for a secret: a row that opens a sheet is pointed at,
 * and the sheet is where the person types. A row that is drawn only in some
 * states says so (`requires`), because a Settings row acts or is not drawn
 * (ADR 0158) and a tour must not point at one that is not there.
 *
 * Authored, checked-in prose; compiled by the same parser and validator model
 * output goes through (ADR 0088).
 */

import type { GuideGoalDescriptor } from "./goal-types.js";

export const SETTINGS_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "settings.general.review",
    title: "Tour Settings: General",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "settings.general.review"',
      'say "Use General to change the appearance and locking behavior of the app."',
      'navigate "/settings"',
      'wait route "/settings" timeout=15000',
      'focus "settings.general" "Choose the appearance, idle lock time, clipboard timeout and whether to lock when this tab is hidden." side=bottom',
      'success "Return to General to change these settings."',
      "end",
    ].join("\n"),
  },
  {
    id: "settings.keybindings.review",
    title: "Tour Settings: Keybindings",
    routes: ["/settings"],
    libraryOnly: true,
    requires: ["shell.keys"],
    guide: [
      "guide/1",
      'goal "settings.keybindings.review"',
      'say "Use Keybindings to review and change keyboard shortcuts."',
      'navigate "/settings/keybindings"',
      'wait route "/settings/keybindings" timeout=15000',
      'focus "settings.keybindings" "Select a shortcut to record a different key or sequence. Shortcuts for actions that require confirmation, such as trash or share, cannot be reassigned." side=bottom',
      'say "Below the shortcuts, you can assign macros to keys or run them when the vault unlocks or a section opens. Macros do not run commands that require confirmation."',
      'navigate "/settings"',
      'wait route "/settings" timeout=15000',
      'success "Tab, Enter, Escape and F6 stay fixed, so you can always navigate with the keyboard."',
      "end",
    ].join("\n"),
  },
  {
    id: "settings.features.review",
    title: "Tour Settings: Features",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "settings.features.review"',
      'say "Use Features to turn optional parts of OpenSesame on or off."',
      'navigate "/settings/features"',
      'wait route "/settings/features" timeout=15000',
      'focus "settings.features" "Review the available features and their switches here." side=bottom',
      'focus "settings.features-list" "Each section has a switch. Sections with several features also have a tile for each one. Support has tutorials for individual features." side=bottom',
      'success "Return to Features to review the optional parts of the app."',
      "end",
    ].join("\n"),
  },
  {
    id: "settings.integrations.review",
    title: "Tour Settings: Integrations",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "settings.integrations.review"',
      'say "Use Integrations to connect third-party services."',
      'navigate "/settings/integrations"',
      'wait route "/settings/integrations" timeout=15000',
      'focus "settings.integrations" "Integrations lists services such as identity providers, backups, password managers and payment providers." side=bottom',
      'focus "settings.integrations-list" "Choose a provider to open its configuration page and connect it. Its credential is encrypted in your vault." side=bottom',
      'success "Select a provider to review its configuration."',
      "end",
    ].join("\n"),
  },
  {
    id: "settings.vaults.review",
    title: "Tour Settings: Vaults",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "settings.vaults.review"',
      'say "View and manage the vaults on this device."',
      'navigate "/settings/vaults"',
      'wait route "/settings/vaults" timeout=15000',
      'focus "settings.vaults" "View and open the vaults on this device, create a vault, or delete a project vault that is not currently open." side=bottom',
      'success "Return to Vaults to manage the vaults on this device."',
      "end",
    ].join("\n"),
  },
  {
    id: "settings.danger.review",
    title: "Tour Settings: Danger",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "settings.danger.review"',
      'say "Danger contains actions that cannot be undone. Deletions require confirmation."',
      'navigate "/settings/danger"',
      'wait route "/settings/danger" timeout=15000',
      'focus "settings.danger" "Manage trash, delete this vault, or transfer ownership. Export a backup before deleting anything you may need." side=bottom',
      'success "Review the action carefully before confirming a deletion."',
      "end",
    ].join("\n"),
  },
  {
    id: "settings.auto-lock.set",
    title: "Set how long the vault stays open",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "settings.auto-lock.set"',
      'say "The vault can lock automatically after a period of inactivity. Use your unlock method to open it again."',
      'navigate "/settings"',
      'wait route "/settings" timeout=15000',
      'focus "settings.auto-lock" "Choose only when I ask, or an idle time from one minute to twenty-four hours." side=top',
      'wait target "settings.auto-lock" event=activate timeout=60000',
      'say "You can also set a clipboard timeout and lock the vault when this tab is hidden."',
      'success "Your chosen lock time applies when the vault is idle."',
      "end",
    ].join("\n"),
  },
  {
    id: "vault.recovery.view",
    title: "See which recovery codes are left",
    routes: ["/settings/security"],
    libraryOnly: true,
    requires: ["vault.recovery-made"],
    guide: [
      "guide/1",
      'goal "vault.recovery.view"',
      'say "Each recovery code can replace your second step once."',
      'navigate "/settings/security"',
      'wait route "/settings/security" timeout=15000',
      'focus "settings.recovery" "Select View recovery codes to see unused codes, or Make a new set to replace them." side=top',
      'wait target "settings.recovery" event=activate timeout=60000',
      'success "Keep your recovery codes in a safe place separate from your phone."',
      "end",
    ].join("\n"),
  },
];
