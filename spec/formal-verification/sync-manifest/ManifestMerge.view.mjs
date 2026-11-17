export const state = (v) =>
  v.tombstoned ? "item trashed" : v.manifestHasPath ? "manifest seen" : "idle";

export const step = (action) => {
  if (action === "TombstoneItem") return "the item is deleted";
  if (action === "ImportManifest") return "manifest import runs";
  return action;
};
