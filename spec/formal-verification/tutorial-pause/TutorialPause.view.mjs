function queued(queue) {
  if (queue == null) return 0;
  if (typeof queue.size === "number") return queue.size;
  return [...queue].length;
}

export const state = (v) => {
  if (v.spoken === true || v.spoken === "TRUE") return "a tour may speak";
  if (v.paused === true || v.paused === "TRUE") return "this session is paused";
  if (v.mode === "off") return "guidance is off";
  return queued(v.queue) > 0 ? "tours are queued" : "tours are quiet";
};

export const step = (action) => {
  const name = String(action);
  if (name === "PauseSession") return "pause tutorials for this session";
  if (name === "Reload") return "the tab reloads";
  if (name === "Speak") return "a tour tries to speak";
  if (name === "Superseded") return "a stop the product takes itself";
  if (name.startsWith("Queue")) return "the person leaves a tour";
  if (name.startsWith("Resume")) return "resume from notifications";
  if (name.startsWith("SetMode")) return "guidance mode changes";
  if (name.startsWith("RefuseProfile")) return "a profile name is refused";
  return name;
};
