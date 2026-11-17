import type { AppContext } from "../context.js";

type Work = { organizationId: string; userId: string; cycle: string };
const queues = new WeakMap<AppContext, Map<string, Work>>();

function key(work: Work): string {
  return JSON.stringify([work.organizationId, work.userId, work.cycle]);
}

/** Journals are durable; this queue only avoids repeated full-table scans. */
export function queueScimDeprovision(ctx: AppContext, work: Work): void {
  let queue = queues.get(ctx);
  if (!queue) {
    queue = new Map();
    queues.set(ctx, queue);
  }
  queue.set(key(work), work);
}

export function forgetScimDeprovision(ctx: AppContext, work: Work): void {
  queues.get(ctx)?.delete(key(work));
}

export function queuedScimDeprovisions(ctx: AppContext): Work[] {
  return [...(queues.get(ctx)?.values() ?? [])];
}
