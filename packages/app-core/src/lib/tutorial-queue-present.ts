/**
 * How a queued walkthrough and the session-pause question are shown.
 *
 * A sticky toast carries the worded keys. The same words are a status notice,
 * so the tray keeps them and a reload can put the resume key back. Nothing
 * here is a transcript.
 */

import { loadGuidance } from "./guidance.js";
import { guideGoal, guideGoalIds } from "../tutorial/registry/goals.js";
import { hideToast, showToast } from "./notice-toast.js";
import { dismissNotice, listNotices, setStatusNotice } from "./notices.js";
import {
  TUTORIAL_PAUSE_NOTICE,
  listQueuedTutorials,
  queueTutorial,
  setQueuedTutorials,
  TUTORIAL_QUEUE_LIMIT,
  resumeTutorialFromNotice,
  sessionTutorialsPaused,
  setSessionTutorialsPaused,
  tutorialQueueNoticeId,
} from "./tutorial-queue.js";

export const RESUME_WALKTHROUGH = "Resume walkthrough";
export const PAUSE_ALL_FOR_SESSION = "Pause all for this session";
export const ONLY_THIS_TUTORIAL = "Only this one";

function dismissPausePrompt(): void {
  hideToast(TUTORIAL_PAUSE_NOTICE);
  dismissNotice(TUTORIAL_PAUSE_NOTICE);
}

/**
 * Every walkthrough this device has not answered yet, except ones already
 * queued. The tour just left is usually already in the queue.
 */
export function queueUnansweredWalkthroughs(): number {
  const answered = new Set(loadGuidance().tours);
  const existing = listQueuedTutorials().map((item) => item.goalId);
  const existingSet = new Set(existing);
  const pending: string[] = [];
  for (const goalId of guideGoalIds()) {
    if (answered.has(goalId) && !existingSet.has(goalId)) continue;
    if (existingSet.has(goalId)) continue;
    if (guideGoal(goalId) === null) continue;
    pending.push(goalId);
  }
  const room = Math.max(0, TUTORIAL_QUEUE_LIMIT - existing.length);
  const accepted = pending.slice(0, room);
  setQueuedTutorials([...existing, ...accepted]);
  for (const goalId of accepted) {
    postQueuedTutorialNotice(goalId);
  }
  return accepted.length;
}

/** The tray row and the toast that resumes one queued tour. */
export function postQueuedTutorialNotice(goalId: string): void {
  const goal = guideGoal(goalId);
  if (goal === null) return;
  const id = tutorialQueueNoticeId(goalId);
  const resume = () => {
    resumeTutorialFromNotice(goalId);
  };
  showToast({
    id,
    tone: "info",
    title: goal.title,
    body: "Queued.",
    sticky: true,
    choice: { label: RESUME_WALKTHROUGH, run: resume },
  });
  setStatusNotice({
    id,
    tone: "info",
    title: goal.title,
    body: "Queued.",
    act: { label: RESUME_WALKTHROUGH, worded: true, run: resume },
  });
}

/**
 * Ask whether the rest of this session stays quiet. Skipped when it already
 * is: the queue row is enough.
 */
export function postTutorialPausePrompt(): void {
  if (sessionTutorialsPaused()) return;
  const pauseAll = () => {
    queueUnansweredWalkthroughs();
    setSessionTutorialsPaused(true);
    dismissPausePrompt();
  };
  const onlyThis = () => {
    dismissPausePrompt();
  };
  showToast({
    id: TUTORIAL_PAUSE_NOTICE,
    tone: "warn",
    title: "Tutorials",
    body: "Pause the others for this session?",
    sticky: true,
    choice: { label: PAUSE_ALL_FOR_SESSION, run: pauseAll },
    alt: { label: ONLY_THIS_TUTORIAL, run: onlyThis },
  });
  setStatusNotice({
    id: TUTORIAL_PAUSE_NOTICE,
    tone: "warn",
    title: "Tutorials",
    body: "Pause the others for this session?",
    act: { label: PAUSE_ALL_FOR_SESSION, worded: true, run: pauseAll },
    alt: { label: ONLY_THIS_TUTORIAL, worded: true, run: onlyThis },
  });
}

/**
 * The person declined or left this tour. The title is checked for size and
 * then dropped: the registry is what the notice says.
 */
export function noteTutorialDeclined(goalId: string, title: string): boolean {
  if (!queueTutorial(goalId, { title })) return false;
  postQueuedTutorialNotice(goalId);
  postTutorialPausePrompt();
  return true;
}

/** After tray restore, put resume keys back on the ids that survived. */
export function rehydrateTutorialQueueNotices(): void {
  dismissPausePrompt();
  for (const item of listQueuedTutorials()) {
    postQueuedTutorialNotice(item.goalId);
  }
}
