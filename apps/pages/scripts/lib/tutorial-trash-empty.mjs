import { listTutorials } from "./tutorial-walk.mjs";

/** Check the library and walk Move to Trash before anything has been trashed. */
export async function verifyEmptyTrash(page, { check, walkOne, phone, width }) {
  const tutorials = await listTutorials(page);
  const trash = tutorials.find((entry) => entry.id === "vault.item.trash");
  check(Boolean(trash), "Move to Trash is offered when Trash is empty");
  check(
    !tutorials.some((entry) => entry.id === "vault.item.restore"),
    "Restore from Trash is offered only when Trash contains an item",
  );
  if (trash) await walkOne(page, trash, { phone, width });
}
