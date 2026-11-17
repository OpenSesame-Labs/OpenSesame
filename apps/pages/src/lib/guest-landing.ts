// A keyless guest opens an empty vault when returning after lock. Keep this in
// memory so the router can leave an item URL from the now-cleared vault.
let pending = false;

export function markNewGuestLanding(): void {
  pending = true;
}

export function clearNewGuestLanding(): void {
  pending = false;
}

export function takeNewGuestLanding(): boolean {
  const marked = pending;
  pending = false;
  return marked;
}
