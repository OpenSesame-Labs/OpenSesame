import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";

/** A phone's offer stays in the tray until answered or its screen is left. */
export function showFirstVisitNotice({
  id,
  title,
  body,
  start,
  answer,
}: {
  id: string;
  title: string;
  body: string;
  start: () => void;
  answer: () => void;
}): () => void {
  setStatusNotice({
    id,
    tone: "info",
    title,
    body,
    transient: true,
    onDismiss: answer,
    act: {
      label: "Start tutorial",
      icon: "play",
      opens: true,
      run: () => {
        dismissNotice(id);
        start();
      },
    },
  });
  return () => dismissNotice(id);
}
