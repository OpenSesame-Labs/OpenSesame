/**
 * Leaving a tour on purpose queues it and asks about the rest of the session.
 * A stop the product takes itself (a screen changed, a lock) does not.
 */

import { rememberTourAnswered } from "@opensesame/app-core/lib/guidance.js";
import { noteTutorialDeclined } from "@opensesame/app-core/lib/tutorial-queue-present.js";
import { guideGoal } from "@opensesame/app-core/tutorial/registry/goals.js";

export function queueTourExit(goalId: string): void {
  const goal = guideGoal(goalId);
  if (goal === null) return;
  rememberTourAnswered(goal.id);
  noteTutorialDeclined(goal.id, goal.title);
}
