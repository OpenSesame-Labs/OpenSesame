export const state = (v) =>
  v.writeValue ? "fill allowed" : v.gesture ? "gesture pending" : "idle";

export const step = (action) => {
  if (action === "ExtensionGesture") return "extension arms fill";
  if (action === "PageGesture") return "page tries to arm";
  if (action === "DecideFill") return "decideFill runs";
  return action;
};
