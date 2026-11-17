import type { ToastMessage } from "@opensesame/app-core/lib/notice-toast.js";

/** Distinguish duplicate titles without lengthening unique control names. */
export function dismissContext(
  toast: ToastMessage,
  shown: readonly ToastMessage[],
) {
  const normalize = (text: string) => text.trim().replace(/\s+/g, " ");
  const sameTitle = shown.filter(
    (item) =>
      Boolean(item.sticky) === Boolean(toast.sticky) &&
      normalize(item.title) === normalize(toast.title),
  );
  if (sameTitle.length < 2) return toast.title;
  const body = normalize(toast.body);
  const sameBody = sameTitle.filter((item) => normalize(item.body) === body);
  const ordinal =
    sameBody.length > 1
      ? ` (${sameBody.indexOf(toast) + 1} of ${sameBody.length})`
      : "";
  return `${toast.title}${body ? `. ${body}` : ""}${ordinal}`;
}
