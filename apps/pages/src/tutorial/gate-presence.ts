const listeners = new Set<() => void>();
let count = 0;

function notify(): void {
  for (const listener of listeners) listener();
}

export function enterGate(): () => void {
  count += 1;
  notify();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    count -= 1;
    notify();
  };
}

export function subscribeGatePresence(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function gateIsPresent(): boolean {
  return count > 0;
}
