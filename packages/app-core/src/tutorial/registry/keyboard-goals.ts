/**
 * Tutorials for the keyboard (ADR 0156, ADR 0163 §6): moving through a
 * listing, the three keys that reach the shell from anywhere, and macros.
 *
 * A key is taught in the words a person would read it in, and
 * `keymap-tutorials.ts` names the sentence each key is said in, so a rewrite
 * that drops a key from its tour fails a test instead of going unnoticed. The
 * tours say what the default keys do; Settings → Keybindings lists every key
 * and is where a person changes one.
 *
 * Every string is a checked-in literal: nothing here names an item.
 */

import type { GuideGoalDescriptor } from "./goal-types.js";

export const KEYBOARD_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "vault.keys.move",
    title: "Move through the list from the keyboard",
    routes: [],
    libraryOnly: true,
    requires: ["shell.keyboard-primary"],
    guide: [
      "guide/1",
      'goal "vault.keys.move"',
      'say "Use these keys to move through the vault list and the sections tree. F6 moves focus between the two lists."',
      'navigate "/vault"',
      'wait route "/vault" timeout=15000',
      'focus "vault.list" "Press j or the down arrow for the next row, and k or the up arrow for the previous row. Add a count to repeat, such as 3j." side=right',
      'say "gg, Home or 0 goes to the first row; G, End or $ to the last. With a count, 5G goes to row 5."',
      'say "H, M and L go to the top, middle and bottom row of what is on screen."',
      'say "Ctrl-d and Ctrl-u move half a page down and up. Ctrl-f and Ctrl-b, or Page Down and Page Up, move a whole page."',
      'say "Press l or Right Arrow to open an item or folder. Press h, Left Arrow or Backspace to go back."',
      'success "Change shortcuts in Settings → Keybindings."',
      "end",
    ].join("\n"),
  },
  {
    id: "vault.keys.bar",
    title: "The command bar, key help and voice",
    routes: [],
    libraryOnly: true,
    requires: ["shell.keyboard-primary"],
    guide: [
      "guide/1",
      'goal "vault.keys.bar"',
      'say "Use these shortcuts to open the command bar, keyboard help or voice input from the vault."',
      'navigate "/vault"',
      'wait route "/vault" timeout=15000',
      'focus "shell.command-bar" "Press : or Ctrl-l and the cursor jumps here. Type a command: go to a section, search, or copy a field. Enter runs it." side=bottom',
      'say "Press ? to see the current keyboard shortcuts, including any you changed."',
      'say "Press m to start voice input, then press m again to run the recognized command. Voice input needs a microphone and the On-device model enabled in Settings → Features."',
      "end",
    ].join("\n"),
  },
  {
    id: "vault.keys.macros",
    title: "Record and replay a macro",
    routes: [],
    libraryOnly: true,
    requires: ["shell.keyboard-primary"],
    guide: [
      "guide/1",
      'goal "vault.keys.macros"',
      'say "A macro records a sequence of commands under a letter. Press q and then a letter from a through z to start recording."',
      'navigate "/vault"',
      'wait route "/vault" timeout=15000',
      'focus "vault.list" "Use commands such as 3j, gg or l. Press q again to stop recording. The status bar shows when a recording is running." side=right',
      'say "@ and the letter replays it: @a plays register a, 3@a plays it three times, and @@ plays the last one again."',
      'say "Trash, share and delete are left out of a recording, so a replay can never run them."',
      'success "Your recording is named q- followed by its letter. Assign a shortcut in Settings → Keybindings → Macros."',
      "end",
    ].join("\n"),
  },
];
