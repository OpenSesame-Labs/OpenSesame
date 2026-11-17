import {
  hasDraftSaver,
  subscribeDraftSavers,
} from "@opensesame/app-core/lib/dirty-edit.js";
import { useCallback, useContext, useSyncExternalStore } from "react";
import { SupportContext } from "../tutorial/support-context.js";

const no = () => false;
const unsubscribeNothing = () => {};

/** Defer sticky offers while an editor or tutorial needs the whole screen. */
export function useToastSuppression() {
  const support = useContext(SupportContext);
  const subscribe = useCallback(
    (listener: () => void) =>
      support?.subscribe(listener) ?? unsubscribeNothing,
    [support],
  );
  const hasTour = useCallback(
    () => Boolean(support?.view().guide?.tour),
    [support],
  );
  const editing = useSyncExternalStore(subscribeDraftSavers, hasDraftSaver, no);
  const touring = useSyncExternalStore(subscribe, hasTour, no);
  // An editor can register and publish a notice before React renders again.
  const shouldDefer = useCallback(
    () => hasDraftSaver() || hasTour(),
    [hasTour],
  );
  return { deferOffers: editing || touring, shouldDefer };
}
