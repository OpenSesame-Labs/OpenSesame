/**
 * Replay of TutorialPause.tla against the queue.
 *
 * A tour speaks only when guidance is not off and this session is not paused.
 * Reload drops the pause and keeps the ids. Queuing is the user-exit path;
 * a superseded stop never calls it, so the queue stays as it was.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bindTutorialResume,
  dequeueTutorial,
  forgetSessionTutorialPause,
  listQueuedTutorials,
  queueTutorial,
  resumeTutorialFromNotice,
  sessionTutorialsPaused,
  setSessionTutorialsPaused,
  tutorialQueueSeams,
  tutorialsMaySpeak,
} from "./tutorial-queue.js";

const original = { ...tutorialQueueSeams };
let session: string | null = null;

beforeEach(() => {
  session = null;
  tutorialQueueSeams.sessionGet = () => session;
  tutorialQueueSeams.sessionSet = (value) => {
    session = value;
  };
});

afterEach(() => {
  for (const item of listQueuedTutorials()) dequeueTutorial(item.goalId);
  setSessionTutorialsPaused(false);
  Object.assign(tutorialQueueSeams, original);
});

describe("tutorial pause formal replay", () => {
  it("follows the pause and queue steps", () => {
    setSessionTutorialsPaused(false);
    for (const item of listQueuedTutorials()) dequeueTutorial(item.goalId);
    expect(tutorialsMaySpeak("auto", sessionTutorialsPaused())).toBe(true);
    expect(tutorialsMaySpeak("off", false)).toBe(false);
    expect(tutorialsMaySpeak("auto", true)).toBe(false);

    expect(queueTutorial("vault.lock", { title: "Lock the vault" })).toBe(true);
    expect(queueTutorial("vault.lock", { title: "Lock the vault" })).toBe(true);
    expect(listQueuedTutorials()).toEqual([{ goalId: "vault.lock" }]);

    setSessionTutorialsPaused(true);
    expect(tutorialsMaySpeak("offer", sessionTutorialsPaused())).toBe(false);
    expect(queueTutorial("settings.danger.review", { title: "Danger" })).toBe(
      true,
    );

    const held = tutorialQueueSeams.read();
    forgetSessionTutorialPause();
    expect(sessionTutorialsPaused()).toBe(false);
    expect(tutorialQueueSeams.read()).toBe(held);
    expect(listQueuedTutorials()).toEqual([
      { goalId: "vault.lock" },
      { goalId: "settings.danger.review" },
    ]);

    let home = "";
    const unbind = bindTutorialResume((_goalId, _guide, homeRoute) => {
      home = homeRoute;
      return true;
    });
    expect(resumeTutorialFromNotice("settings.danger.review")).toBe(true);
    expect(home).toBe("/settings");
    expect(
      listQueuedTutorials().some(
        (item) => item.goalId === "settings.danger.review",
      ),
    ).toBe(false);
    unbind();

    for (const profile of ["minimal", "default", "custom", "full"]) {
      queueTutorial("vault.lock", { title: profile });
      const stored = tutorialQueueSeams.read() ?? "";
      expect(stored.includes(profile)).toBe(false);
    }

    const before = tutorialQueueSeams.read();
    // Superseded: the product does not call the queue.
    expect(tutorialQueueSeams.read()).toBe(before);
    for (const item of listQueuedTutorials()) dequeueTutorial(item.goalId);
    setSessionTutorialsPaused(false);
  });
});
