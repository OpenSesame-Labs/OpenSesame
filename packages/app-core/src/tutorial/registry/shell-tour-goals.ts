/**
 * Tours of the frame the app is drawn in: the sections, the statusline and,
 * on a narrow screen, the two keys that stand in for them (ADR 0163).
 *
 * The rail and the statusline are drawn only on a wide screen, and the Sections
 * key and the More key only on a narrow one, so each tour says which it is for
 * (`requires`): a tour that pointed at a control the screen does not draw would
 * point at nothing. A section a plan may leave out has its own tour, contributed
 * by the capability that draws it (`section-nav-goals.ts`).
 *
 * Authored, checked-in prose; compiled by the same parser and validator model
 * output goes through (ADR 0088).
 */

import type { GuideGoalDescriptor } from "./goal-types.js";
import { isTouchGuide } from "./touch-guide.js";

export const SHELL_TOUR_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "shell.sections",
    title: "Find your way around",
    routes: [],
    libraryOnly: true,
    requires: ["shell.wide"],
    get guide() {
      const touch = isTouchGuide();
      return [
        "guide/1",
        'goal "shell.sections"',
        'say "Use the list on the left to move between sections."',
        'navigate "/vault"',
        'wait route "/vault" timeout=15000',
        touch
          ? 'focus "nav.vault" "Select Vault to see your accounts, passkeys, cards, secrets and notes." side=right'
          : 'focus "nav.vault" "Vault contains your accounts, passkeys, cards, secrets and notes. Press g then v from anywhere to return to it." side=right',
        'navigate "/settings"',
        'wait route "/settings" timeout=15000',
        touch
          ? 'focus "nav.settings" "Select Settings to change how the app works. Use the row at the top to return to the vault." side=right'
          : 'focus "nav.settings" "Press g then s to open Settings. Use the row at the top to return to the vault." side=right',
        'say "Access, Connections, Identity, Wallet and Activity appear when you turn them on in Settings › Features."',
        touch
          ? 'say "You can also join a session that someone shares with you."'
          : 'say "Press g then j to join a session somebody shared. You can join even if this device already has a vault."',
        'success "Choose a section from the list whenever you need it."',
        "end",
      ].join("\n");
    },
  },
  {
    id: "shell.sections.phone",
    title: "Find your way around on a phone",
    routes: [],
    libraryOnly: true,
    requires: ["shell.narrow"],
    guide: [
      "guide/1",
      'goal "shell.sections.phone"',
      'say "Use Sections in the top bar to move around the app."',
      'navigate "/vault"',
      'wait route "/vault" timeout=15000',
      'focus "nav.menu" "Select Sections to open Vault, Settings and any other sections you have turned on." side=bottom',
      'say "Choose a section from the menu to open it."',
      'success "Select More in the top bar to see connection status, notifications and help."',
      "end",
    ].join("\n"),
  },
  {
    id: "shell.statusline",
    title: "Read the statusline",
    routes: [],
    libraryOnly: true,
    requires: ["shell.wide"],
    guide: [
      "guide/1",
      'goal "shell.statusline"',
      'say "The strip along the bottom of the screen is the statusline: the Support mark, the command bar, and the bell."',
      'navigate "/vault"',
      'wait route "/vault" timeout=15000',
      'focus "shell.notifications" "Select the bell to read notices such as pending links, failed syncs and expiring items. A dot means a notice is waiting." side=top',
      'wait target "notifications.health" event=appear timeout=60000',
      'say "When the password health report has findings, the notices carry a Review passwords link that opens it. It appears only while there is something to review."',
      'success "That is the statusline. Support and the command bar have tours of their own."',
      "end",
    ].join("\n"),
  },
  {
    id: "shell.more",
    title: "Read the More key on a phone",
    routes: [],
    libraryOnly: true,
    requires: ["shell.narrow"],
    guide: [
      "guide/1",
      'goal "shell.more"',
      'say "More brings together connection status, notifications and help."',
      'navigate "/vault"',
      'wait route "/vault" timeout=15000',
      'focus "shell.connectivity" "Select More to see connections, notifications and help. A dot means something needs your attention." side=bottom',
      'success "Return to More whenever you want to check these details."',
      "end",
    ].join("\n"),
  },
];
