import type { ToastMessage } from "@opensesame/app-core/lib/notice-toast.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { matchPath, useLocation } from "react-router";
import { useNarrow } from "../lib/use-narrow.js";
import { vaultPane } from "../lib/vault-list-path.js";

/** How many transient echoes fit; unanswered offers are never evicted. */
export const TOAST_LIMIT = 2;

/** Keep unread echoes bounded without evicting offers or a card being read. */
export function withinLimit(
  current: readonly ToastMessage[],
  arrival: ToastMessage,
  {
    reading = new Set<string>(),
    inlineOffers = false,
  }: {
    reading?: ReadonlySet<string>;
    inlineOffers?: boolean;
  } = {},
): ToastMessage[] {
  const previous = current.findIndex((item) => item.id === arrival.id);
  const next = [...current];
  if (previous < 0) next.push(arrival);
  else next[previous] = arrival;
  const occupied = () =>
    inlineOffers ? next.filter((item) => !item.sticky).length : next.length;
  while (occupied() > TOAST_LIMIT) {
    const echo = next.findIndex(
      (item) => !item.sticky && !reading.has(item.id),
    );
    if (echo < 0) break;
    next.splice(echo, 1);
  }
  return next;
}

/** Keep the phone's fixed toast away from the vault's fixed controls. */
export function useToastPlacement() {
  const location = useLocation();
  const narrow = useNarrow();
  const besideAdd =
    vaultPane(location.pathname, new URLSearchParams(location.search)) ===
    "list";
  const aboveEditor =
    matchPath("/vault/new/:kind?", location.pathname) !== null ||
    matchPath("/vault/:itemId/edit", location.pathname) !== null;
  return {
    className: `toasts${besideAdd ? " toasts--vault-list" : ""}${aboveEditor ? " toasts--vault-editor" : ""}`,
    editing: narrow && aboveEditor,
  };
}

/** Keep offers, active reading and transient arrivals in one queue. */
export function useToastQueue(
  active: boolean,
  inlineOffers: boolean,
  editing: boolean,
) {
  const [shown, setShown] = useState<ToastMessage[]>([]);
  const reading = useRef(
    new Map<string, { pointer: boolean; focus: boolean }>(),
  );
  const handBack = useRef(false);
  const markReading = useCallback(
    (id: string, channel: "pointer" | "focus", value: boolean) => {
      const current = reading.current.get(id) ?? {
        pointer: false,
        focus: false,
      };
      const next = { ...current, [channel]: value };
      if (next.pointer || next.focus) reading.current.set(id, next);
      else reading.current.delete(id);
    },
    [],
  );
  useLayoutEffect(() => {
    if (!active) reading.current.clear();
  }, [active]);
  const add = useCallback(
    (toast: ToastMessage) => {
      const protectedIds = new Set(reading.current.keys());
      setShown((current) =>
        withinLimit(current, toast, {
          reading: protectedIds,
          inlineOffers: inlineOffers || editing,
        }),
      );
    },
    [editing, inlineOffers],
  );
  const dismiss = useCallback((id: string) => {
    if (reading.current.get(id)?.focus) handBack.current = true;
    reading.current.delete(id);
    setShown((current) => current.filter((item) => item.id !== id));
  }, []);
  useEffect(() => {
    if (editing || inlineOffers) return;
    const protectedIds = new Set(reading.current.keys());
    setShown((current) =>
      current.length <= TOAST_LIMIT
        ? current
        : current.reduce<ToastMessage[]>(
            (kept, toast) =>
              withinLimit(kept, toast, { reading: protectedIds }),
            [],
          ),
    );
  }, [editing, inlineOffers]);
  return { shown, markReading, add, dismiss, handBack };
}
