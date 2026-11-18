/** Process-local rate budget for interaction activation ceremonies. */

const ACTIVATION_WINDOW_MS = 60_000;
const ACTIVATION_PER_PRINCIPAL = 20;
const ACTIVATION_GLOBAL = 500;
const ACTIVATION_MAX_KEYS = 2048;
const ACTIVATION_GLOBAL_KEY = "__global__";
const activationBudget = new Map<string, number[]>();

/** A person approving has no reason to mint ceremonies in a hot loop. */
export function consumeActivationBudget(
  principalId: string,
  now: number,
): boolean {
  for (const [key, times] of activationBudget) {
    const live = times.filter((at) => now - at < ACTIVATION_WINDOW_MS);
    if (live.length === 0) activationBudget.delete(key);
    else if (live.length !== times.length) activationBudget.set(key, live);
  }
  const global = activationBudget.get(ACTIVATION_GLOBAL_KEY) ?? [];
  const key = `principal:${principalId}`;
  const mine = activationBudget.get(key) ?? [];
  if (
    global.length >= ACTIVATION_GLOBAL ||
    mine.length >= ACTIVATION_PER_PRINCIPAL
  ) {
    return false;
  }
  global.push(now);
  mine.push(now);
  activationBudget.set(ACTIVATION_GLOBAL_KEY, global);
  activationBudget.set(key, mine);
  while (activationBudget.size > ACTIVATION_MAX_KEYS) {
    const victim = [...activationBudget.keys()].find(
      (candidate) => candidate !== ACTIVATION_GLOBAL_KEY,
    );
    if (victim === undefined) break;
    activationBudget.delete(victim);
  }
  return true;
}

/** Test hook: the budget is process-global and must not leak between suites. */
export function resetInteractionActivationBudget(): void {
  activationBudget.clear();
}
