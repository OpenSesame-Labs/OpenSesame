import type { ToastMessage } from "@opensesame/app-core/lib/notice-toast.js";
import { type FocusEvent, useEffect, useRef, useState } from "react";

/** Hold the remaining idle time while either input is reading the card. */
export function useToastReading(
  toast: ToastMessage,
  onDone: (id: string) => void,
  onReading: (id: string, channel: "pointer" | "focus", value: boolean) => void,
  duration: number,
) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const left = useRef(duration);
  const since = useRef(0);
  const { sticky } = toast;
  // A replacement with the same id is a new message, even while it is read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the message object is replaced
  useEffect(() => {
    left.current = duration;
  }, [toast, duration]);
  useEffect(() => {
    if (hovered || focused || sticky) return;
    since.current = Date.now();
    const timer = setTimeout(() => onDone(toast.id), left.current);
    return () => {
      clearTimeout(timer);
      left.current -= Date.now() - since.current;
    };
  }, [hovered, focused, sticky, onDone, toast]);

  return {
    enter: () => {
      onReading(toast.id, "pointer", true);
      setHovered(true);
    },
    leave: () => {
      onReading(toast.id, "pointer", false);
      setHovered(false);
    },
    focus: () => {
      onReading(toast.id, "focus", true);
      setFocused(true);
    },
    blur: (event: FocusEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget)) return;
      onReading(toast.id, "focus", false);
      setFocused(false);
    },
  };
}
