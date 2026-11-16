import type { ToastMessage } from "@opensesame/app-core/lib/notice-toast.js";
import { useCallback, useEffect, useState } from "react";

export const TOAST_LIMIT = 2;
type Hidden = (toast: ToastMessage) => boolean;
const neverHidden: Hidden = () => false;

/** Hidden offers do not occupy the slots used by visible notices. */
export function withinLimit(
  current: readonly ToastMessage[],
  arrival: ToastMessage,
  hidden: Hidden = neverHidden,
): ToastMessage[] {
  const next = [...current, arrival];
  const group = next.filter((item) => hidden(item) === hidden(arrival));
  while (group.length > TOAST_LIMIT) {
    const echo = group.findIndex((item) => !item.sticky);
    const [removed] = group.splice(Math.max(echo, 0), 1);
    const index = next.indexOf(removed);
    if (index >= 0) next.splice(index, 1);
  }
  return next;
}

export function useToastQueue(
  deferOffers: boolean,
  narrow: boolean,
  shouldDefer: () => boolean,
) {
  const [shown, setShown] = useState<ToastMessage[]>([]);
  const hidden = useCallback(
    (toast: ToastMessage) =>
      toast.sticky === true &&
      (deferOffers || shouldDefer() || (narrow && toast.inTray === true)),
    [deferOffers, narrow, shouldDefer],
  );
  const add = useCallback(
    (toast: ToastMessage) => {
      setShown((current) =>
        withinLimit(
          current.filter((item) => item.id !== toast.id),
          toast,
          hidden,
        ),
      );
    },
    [hidden],
  );
  const dismiss = useCallback((id: string) => {
    setShown((current) => current.filter((item) => item.id !== id));
  }, []);
  useEffect(() => {
    setShown((current) => {
      const next = current.reduce<ToastMessage[]>(
        (held, toast) => withinLimit(held, toast, hidden),
        [],
      );
      return next.length === current.length &&
        next.every((item, i) => item === current[i])
        ? current
        : next;
    });
  }, [hidden]);
  return { shown, add, dismiss };
}
