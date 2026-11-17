import type { WaitInstruction } from "@opensesame/guide-lang";
import type { GuideBeat, GuidePlan } from "./plan.js";
import type { GuideRuntimePorts, GuideTourView } from "./ports.js";

export function viewOf(
  plan: GuidePlan,
  beat: GuideBeat,
  degraded: boolean,
  satisfied = false,
) {
  const view: GuideTourView = {
    step: Math.min(beat.ordinal + 1, plan.stepCount),
    count: plan.stepCount,
    kind: beat.kind,
    message: beat.message,
    target: beat.target,
    side: beat.side,
    action: beat.until !== null && !satisfied,
    degraded,
    canBack: beat.ordinal > 0,
  };
  return view;
}

/** Settles when the program's own wait would settle; rejects on abort. */
export function observeWait(
  ports: GuideRuntimePorts,
  wait: WaitInstruction,
  signal: AbortSignal,
): Promise<void> {
  if (wait.subject === "target") {
    return ports.targets.observe(wait.target, wait.event, signal);
  }
  if (wait.subject === "route") return ports.routes.observe(wait.route, signal);
  return ports.state.observe(wait.predicate, wait.expected, signal);
}

/**
 * Whether the wait is already true. A step that points at something the
 * person is already standing on must not skip itself — it holds for Next like
 * any other, and only a wait that is still to happen is theirs to satisfy.
 * An activation is an edge, so it is never already true.
 */
export function alreadyHolds(
  ports: GuideRuntimePorts,
  wait: WaitInstruction,
): boolean {
  if (wait.subject === "route") return ports.routes.current() === wait.route;
  if (wait.subject === "state") {
    return ports.state.read(wait.predicate) === wait.expected;
  }
  if (wait.event === "appear") return ports.targets.isMounted(wait.target);
  if (wait.event === "disappear") return !ports.targets.isMounted(wait.target);
  return false;
}
