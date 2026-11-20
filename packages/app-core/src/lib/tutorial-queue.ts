/**
 * Queued walkthroughs and the session pause beside them (ADR 0221).
 *
 * The device KV keeps registry goal ids only — the same shape as
 * `guidance.v1`, and the same line: no question, no route, no transcript.
 * Whether every other tour stays quiet is this tab's alone, in
 * sessionStorage, so a reload lets tours speak again and the queue is
 * still there.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { maybeSessionStore } from "../ports.js";
import type { GuideGoalDescriptor } from "../tutorial/registry/goal-types.js";
import { guideGoal } from "../tutorial/registry/goals.js";
import { kvGet, kvSet, kvSetDurable } from "./kv.js";
import { hideToast } from "./notice-toast.js";
import { dismissNotice } from "./notices.js";

export const TUTORIAL_QUEUE_KEY = "tutorial-queue.v1";

/** Owned by the `opensesame.` session prefix. Cleared when the tab reloads. */
export const SESSION_TUTORIALS_PAUSED_KEY = "opensesame.tutorials.paused";

export const TUTORIAL_PAUSE_NOTICE = "tutorial.pause.session";

const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const LIMIT = 80;
const TITLE_LIMIT = 400;

export type QueuedTutorial = Readonly<{ goalId: string }>;

/** Accepted at the boundary and not stored. A huge title is refused. */
export type TutorialQueueMeta = Readonly<{ title: string }>;

export type TutorialResumeStart = (
  goalId: string,
  guide: string,
  homeRoute: string,
) => void;

type PauseListener = () => void;

const pauseListeners = new Set<PauseListener>();
let cache: { raw: string | null; goals: readonly string[] } | null = null;

function sessionGetDefault(): string | null {
  try {
    return maybeSessionStore()?.getItem(SESSION_TUTORIALS_PAUSED_KEY) ?? null;
  } catch {
    return null;
  }
}

function sessionSetDefault(value: string | null): void {
  try {
    const store = maybeSessionStore();
    if (!store) return;
    if (value === null) store.removeItem(SESSION_TUTORIALS_PAUSED_KEY);
    else store.setItem(SESSION_TUTORIALS_PAUSED_KEY, value);
  } catch {
    // Private mode keeps no pause. Tours speak, which is the safe direction.
  }
}

function resumeUnwired(): void {}

function writeQueue(value: string): void {
  kvSet(TUTORIAL_QUEUE_KEY, value);
  void kvSetDurable(TUTORIAL_QUEUE_KEY, value).catch(() => {
    /* memory stays until the tab goes */
  });
}

export const tutorialQueueSeams = {
  read: (): string | null => kvGet(TUTORIAL_QUEUE_KEY),
  write: writeQueue,
  sessionGet: sessionGetDefault,
  sessionSet: sessionSetDefault,
};

export const tutorialResumeSeams: { start: TutorialResumeStart } = {
  start: resumeUnwired,
};

/** Install the support controller's resume. The returned function detaches it. */
export function bindTutorialResume(start: TutorialResumeStart): () => void {
  const previous = tutorialResumeSeams.start;
  tutorialResumeSeams.start = start;
  return () => {
    if (tutorialResumeSeams.start === start) {
      tutorialResumeSeams.start = previous;
    }
  };
}

function readGoals(value: BoundaryValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const entry of value) {
    if (!isString(entry) || !ID.test(entry) || ids.includes(entry)) continue;
    if (guideGoal(entry) === null) continue;
    ids.push(entry);
  }
  return ids.slice(-LIMIT);
}

function parseQueue(raw: string | null): readonly string[] {
  if (!raw) return [];
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(parsed)) return [];
    return readGoals(parsed.goals);
  } catch {
    return [];
  }
}

function loadGoals(): readonly string[] {
  let raw: string | null = null;
  try {
    raw = tutorialQueueSeams.read();
  } catch {
    raw = null;
  }
  if (cache !== null && cache.raw === raw) return cache.goals;
  const goals = parseQueue(raw);
  cache = { raw, goals };
  return goals;
}

function store(goals: readonly string[]): void {
  const raw = JSON.stringify({ goals });
  cache = { raw, goals };
  try {
    tutorialQueueSeams.write(raw);
  } catch {
    // A browser that cannot keep the queue offers the tour from the library.
  }
}

/**
 * Where a resumed tour should be standing. Feature and integration tours
 * belong to their settings pages; every other tour uses its first route.
 */
export function tutorialHomeRoute(goal: GuideGoalDescriptor): string {
  if (goal.id.startsWith("feature.")) return "/settings/features";
  if (goal.id.startsWith("integration.")) return "/settings/integrations";
  return goal.routes[0] ?? "";
}

export function tutorialQueueNoticeId(goalId: string): string {
  return `tutorial.queue.${goalId}`;
}

/** Remember a registry goal. Already queued is success. Titles are not kept. */
export function queueTutorial(
  goalId: string,
  meta: TutorialQueueMeta,
): boolean {
  if (meta.title.length > TITLE_LIMIT) return false;
  if (!ID.test(goalId) || guideGoal(goalId) === null) return false;
  const current = loadGoals();
  if (current.includes(goalId)) return true;
  store([...current, goalId].slice(-LIMIT));
  return true;
}

export function dequeueTutorial(goalId: string): void {
  const current = loadGoals();
  if (!current.includes(goalId)) return;
  store(current.filter((id) => id !== goalId));
}

export function listQueuedTutorials(): readonly QueuedTutorial[] {
  return loadGoals().map((goalId) => ({ goalId }));
}

export function sessionTutorialsPaused(): boolean {
  return tutorialQueueSeams.sessionGet() === "1";
}

export function setSessionTutorialsPaused(paused: boolean): void {
  if (sessionTutorialsPaused() === paused) return;
  tutorialQueueSeams.sessionSet(paused ? "1" : null);
  for (const listener of [...pauseListeners]) listener();
}

/**
 * A new document ends the pause. Navigation inside the tab does not load
 * this again, so the flag survives there and a reload lets tours speak.
 */
export function forgetSessionTutorialPause(): void {
  setSessionTutorialsPaused(false);
}

export function subscribeSessionTutorialsPaused(
  listener: PauseListener,
): () => void {
  pauseListeners.add(listener);
  return () => {
    pauseListeners.delete(listener);
  };
}

/** Auto and offer stay quiet while guidance is off or this session is paused. */
export function tutorialsMaySpeak(mode: string, paused: boolean): boolean {
  return mode !== "off" && !paused;
}

/**
 * The notification's resume: drop the queue row and hand the tour to whoever
 * bound `tutorialResumeSeams`. Allowed while paused and while guidance is off.
 */
export function resumeTutorialFromNotice(goalId: string): boolean {
  const goal = guideGoal(goalId);
  if (goal === null || !loadGoals().includes(goalId)) return false;
  dequeueTutorial(goalId);
  const id = tutorialQueueNoticeId(goalId);
  dismissNotice(id);
  hideToast(id);
  tutorialResumeSeams.start(goal.id, goal.guide, tutorialHomeRoute(goal));
  return true;
}
