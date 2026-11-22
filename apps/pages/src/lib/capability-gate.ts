import { useComposition } from "../bindings/capabilities.js";

/** Whether a capability is approved under the current plan, and its lifecycle. */
export function useCapabilityGate(id: string) {
  const snapshot = useComposition();
  const state = snapshot.plan?.capabilities[id] ?? null;
  return {
    approved: state?.approved === true,
    lifecycle: snapshot.lifecycle[id] ?? null,
    state,
  };
}
