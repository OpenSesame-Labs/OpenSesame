import { subscribeContributions } from "@opensesame/app-core/lib/contributions.js";
import { isKnownGuideTarget } from "@opensesame/app-core/tutorial/registry/targets.js";
import { useCallback, useSyncExternalStore } from "react";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";

const target = "shell.share";
const isDeclared = () => isKnownGuideTarget(target);

/** The shell can finish rendering a retired wrapper after its lease ends. */
export function useLiveShareGuideTarget(): (
  node: HTMLButtonElement | null,
) => void {
  const declared = useSyncExternalStore(
    subscribeContributions,
    isDeclared,
    isDeclared,
  );
  const bind = useGuideTarget<HTMLButtonElement>(target);
  return useCallback(
    (node) => bind(node && declared && isDeclared() ? node : null),
    [bind, declared],
  );
}
