/**
 * Which tutorial teaches each key (ADR 0163 §6). A key is a thing a person
 * does, so it needs a tutorial like any control. Every entry names the goal
 * that teaches it and the words that goal says it in: `coverage.test.ts`
 * fails when the goal does not exist or does not say them.
 *
 * Many keys share a tutorial on purpose (the movement keys are one lesson).
 */
export type KeymapTutorial = Readonly<{ goal: string; says: string }>;

const move = (says: string): KeymapTutorial => ({
  goal: "vault.keys.move",
  says,
});
const macro = (says: string): KeymapTutorial => ({
  goal: "vault.keys.macros",
  says,
});
const bar = (says: string): KeymapTutorial => ({
  goal: "vault.keys.bar",
  says,
});
const item = (goal: string, says: string): KeymapTutorial => ({ goal, says });

export const KEYMAP_TUTORIALS = {
  "section.vault": { goal: "shell.sections", says: "Press g then v" },
  "section.settings": { goal: "shell.sections", says: "Press g then s" },
  "session.join": {
    goal: "shell.sections",
    says: "Press g then j to join a session",
  },
  "listing.next": move("j or the down arrow moves to the next row"),
  "listing.previous": move("k or the up arrow, to the previous"),
  "listing.first": move("gg, Home or 0 goes to the first row"),
  "listing.last": move("G, End or $ to the last"),
  "listing.high": move("H, M and L go to the top, middle and bottom row"),
  "listing.mid": move("H, M and L go to the top, middle and bottom row"),
  "listing.low": move("H, M and L go to the top, middle and bottom row"),
  "listing.half-down": move("Ctrl-d and Ctrl-u move half a page"),
  "listing.half-up": move("Ctrl-d and Ctrl-u move half a page"),
  "listing.page-down": move(
    "Ctrl-f and Ctrl-b, or Page Down and Page Up, move a whole page",
  ),
  "listing.page-up": move(
    "Ctrl-f and Ctrl-b, or Page Down and Page Up, move a whole page",
  ),
  "listing.dive": move("l or the right arrow opens"),
  "listing.climb": move("h, the left arrow or Backspace moves back"),
  "listing.search": item("vault.item.find", "Press / to start a search"),
  "command.palette": bar("Press : or Ctrl-l and the cursor jumps here"),
  "help.keymap": bar("Press ? to see the current keyboard shortcuts"),
  "voice.toggle": bar("Press m to start voice input"),
  "item.copy-secret": item(
    "vault.item.copy",
    "press y on a row to copy its password or secret value",
  ),
  "item.copy-username": item(
    "vault.item.copy",
    "press u on a row to copy the username",
  ),
  "item.edit": item("vault.item.edit", "press e on a row to open its editor"),
  "item.new": item("vault.item.create", "Press n in the list to open New item"),
  "item.favorite": item("vault.item.favorite", "Press . with a row selected"),
  "item.trash": item(
    "vault.item.trash",
    "Press x in the list to trash the row under the cursor",
  ),
  "item.share": item("vault.item.share", "Press s with a row selected"),
  "item.restore": item("vault.item.trash", "press r on a selected row"),
  "item.purge": item("vault.item.trash", "press X twice on a selected row"),
  "register.record": macro(
    "Press q and then a letter from a through z to start recording",
  ),
  "register.replay": macro("@ and the letter replays it"),
} satisfies Readonly<Record<string, KeymapTutorial>>;
