import type { Notice } from "@opensesame/app-core/lib/notices.js";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { keyboardIsIdle, landFocus } from "../lib/focus.js";
import { NoticeCorner } from "./NoticeCorner.js";
import { ToastStack } from "./ToastStack.js";

const NoticeSeatContext = createContext<(node: HTMLDivElement | null) => void>(
  () => {},
);

/** A gate owns the flow region where its notices and bell are reachable. */
export function GateNoticeSeat() {
  const place = useContext(NoticeSeatContext);
  return <div className="gate-notice-seat" ref={place} />;
}

/**
 * A shellless screen keeps the bell in its own notice seat when it has one.
 * Other screens keep the flow fallback before their body. Moving the notice
 * surface never remounts the screen or changes the vault gate.
 */
export function Notices({
  shellless,
  children,
}: {
  shellless: boolean;
  children: ReactNode;
}) {
  const [seat, setSeat] = useState<HTMLDivElement | null>(null);
  const [heldNotice, setHeldNotice] = useState<Notice | null>(null);
  const movingFocus = useRef<{
    name: string | null;
    index: number;
    id: string | null;
    dismiss: boolean;
  } | null>(null);
  const place = useCallback((node: HTMLDivElement | null) => {
    const active = document.activeElement;
    const corner = active?.closest(".notice-corner");
    if (active instanceof HTMLButtonElement && corner) {
      const name = active.getAttribute("aria-label");
      const card = active.closest(".notice-corner__card");
      const matches = [...(card ?? corner).querySelectorAll("button")].filter(
        (button) => button.getAttribute("aria-label") === name,
      );
      movingFocus.current = {
        name,
        index: matches.indexOf(active),
        id: card?.getAttribute("data-notice-id") ?? null,
        dismiss: active.classList.contains("notice-dismiss"),
      };
    }
    setSeat(node);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: seat signals a portal move
  useLayoutEffect(() => {
    const previous = movingFocus.current;
    movingFocus.current = null;
    if (!previous || !keyboardIsIdle()) return;
    const corner = document.querySelector(".notice-corner");
    const card = [
      ...(corner?.querySelectorAll(".notice-corner__card") ?? []),
    ].find((item) => item.getAttribute("data-notice-id") === previous.id);
    const scope = previous.id ? card : corner;
    const matches = [...(scope?.querySelectorAll("button") ?? [])].filter(
      (button) => button.getAttribute("aria-label") === previous.name,
    );
    const target = previous.dismiss
      ? card?.querySelector(".notice-dismiss")
      : matches[previous.index];
    if (!landFocus(target)) landFocus(corner?.querySelector(".cx__btn"));
  }, [seat]);
  useLayoutEffect(() => {
    if (shellless) return;
    movingFocus.current = null;
    setHeldNotice(null);
  }, [shellless]);
  return (
    <NoticeSeatContext.Provider value={place}>
      {shellless ? (
        seat ? (
          createPortal(
            <NoticeCorner
              heldNotice={heldNotice}
              onHeldChange={setHeldNotice}
            />,
            seat,
          )
        ) : (
          <NoticeCorner heldNotice={heldNotice} onHeldChange={setHeldNotice} />
        )
      ) : null}
      {children}
      {shellless ? <ToastStack inFlowGateNotices /> : null}
    </NoticeSeatContext.Provider>
  );
}
