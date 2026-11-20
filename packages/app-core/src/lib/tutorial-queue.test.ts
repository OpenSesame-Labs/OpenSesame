import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toastOf } from "./notice-toast.js";
import { clearNotices, listNotices } from "./notices.js";
import {
  TUTORIAL_PAUSE_NOTICE,
  bindTutorialResume,
  completeQueuedTutorial,
  dequeueTutorial,
  listQueuedTutorials,
  queueTutorial,
  resumeTutorialFromNotice,
  sessionTutorialsPaused,
  setSessionTutorialsPaused,
  subscribeSessionTutorialsPaused,
  tutorialQueueSeams,
  tutorialsMaySpeak,
} from "./tutorial-queue.js";
import {
  ONLY_THIS_TUTORIAL,
  PAUSE_ALL_FOR_SESSION,
  RESUME_WALKTHROUGH,
  noteTutorialDeclined,
  rehydrateTutorialQueueNotices,
} from "./tutorial-queue-present.js";

const original = { ...tutorialQueueSeams };
let raw: string | null = null;
let session: string | null = null;

beforeEach(() => {
  raw = null;
  session = null;
  tutorialQueueSeams.read = () => raw;
  tutorialQueueSeams.write = (value) => {
    raw = value;
  };
  tutorialQueueSeams.sessionGet = () => session;
  tutorialQueueSeams.sessionSet = (value) => {
    session = value;
  };
  setSessionTutorialsPaused(false);
  clearNotices();
});

afterEach(() => {
  for (const item of listQueuedTutorials()) dequeueTutorial(item.goalId);
  setSessionTutorialsPaused(false);
  Object.assign(tutorialQueueSeams, original);
  clearNotices();
});

describe("tutorial queue", () => {
  it("keeps registry ids only, once each", () => {
    expect(queueTutorial("ok.id", { title: "" })).toBe(false);
    expect(queueTutorial("vault.lock", { title: "x".repeat(401) })).toBe(false);
    expect(queueTutorial("vault.lock", { title: "Lock the vault" })).toBe(true);
    expect(queueTutorial("vault.lock", { title: "again" })).toBe(true);
    expect(listQueuedTutorials()).toEqual([{ goalId: "vault.lock" }]);
    expect(raw).toBe('{"goals":["vault.lock"]}');
    for (const profile of ["minimal", "default", "custom", "full"]) {
      expect(queueTutorial("vault.lock", { title: profile })).toBe(true);
      expect(raw?.includes(profile)).toBe(false);
    }
  });

  it("drops a corrupt record and unknown ids", () => {
    tutorialQueueSeams.write(
      JSON.stringify({ goals: ["nope.not.a.goal", "vault.lock", 3] }),
    );
    expect(listQueuedTutorials()).toEqual([{ goalId: "vault.lock" }]);
    tutorialQueueSeams.write("{");
    expect(listQueuedTutorials()).toEqual([]);
  });

  it("pauses for this session and clears that pause on reload", () => {
    let seen = 0;
    const stop = subscribeSessionTutorialsPaused(() => {
      seen += 1;
    });
    setSessionTutorialsPaused(true);
    expect(seen).toBe(1);
    expect(sessionTutorialsPaused()).toBe(true);
    expect(tutorialsMaySpeak("auto", sessionTutorialsPaused())).toBe(false);
    expect(tutorialsMaySpeak("off", false)).toBe(false);
    expect(tutorialsMaySpeak("offer", false)).toBe(true);
    setSessionTutorialsPaused(true);
    expect(seen).toBe(1);
    queueTutorial("settings.danger.review", { title: "Tour" });
    // A reload drops sessionStorage. The setter is not what clears it.
    session = null;
    expect(seen).toBe(1);
    expect(sessionTutorialsPaused()).toBe(false);
    expect(listQueuedTutorials()).toEqual([
      { goalId: "settings.danger.review" },
    ]);
    stop();
  });

  it("resumes from the notice onto the tour's home route", () => {
    const started: string[] = [];
    const unbind = bindTutorialResume((goalId, guide, home) => {
      started.push(`${goalId} ${home} ${guide.includes(goalId)}`);
      completeQueuedTutorial(goalId);
      return true;
    });
    queueTutorial("feature.identity", { title: "Turn on Identity" });
    queueTutorial("vault.lock", { title: "Lock the vault" });
    expect(resumeTutorialFromNotice("missing.goal")).toBe(false);
    expect(resumeTutorialFromNotice("feature.identity")).toBe(true);
    expect(started).toEqual(["feature.identity /settings/features true"]);
    expect(listQueuedTutorials()).toEqual([{ goalId: "vault.lock" }]);
    expect(resumeTutorialFromNotice("vault.lock")).toBe(true);
    expect(started[1]).toBe("vault.lock  true");
    unbind();
  });

  it("queues a decline with a resume key and a pause prompt", () => {
    const unbind = bindTutorialResume((goalId) => {
      completeQueuedTutorial(goalId);
      return true;
    });
    expect(noteTutorialDeclined("vault.lock", "Lock the vault")).toBe(true);
    expect(noteTutorialDeclined("vault.lock", "Lock the vault")).toBe(true);
    expect(listQueuedTutorials()).toEqual([{ goalId: "vault.lock" }]);
    const pause = listNotices().find(
      (notice) => notice.id === TUTORIAL_PAUSE_NOTICE,
    );
    expect(pause?.act?.label).toBe(PAUSE_ALL_FOR_SESSION);
    expect(pause?.alt?.label).toBe(ONLY_THIS_TUTORIAL);
    expect(toastOf(pause ?? listNotices()[0]).alt?.label).toBe(
      ONLY_THIS_TUTORIAL,
    );
    pause?.alt?.run();
    expect(sessionTutorialsPaused()).toBe(false);
    expect(
      listNotices().some((notice) => notice.id === TUTORIAL_PAUSE_NOTICE),
    ).toBe(false);
    const queued = listNotices().find(
      (notice) => notice.id === "tutorial.queue.vault.lock",
    );
    expect(queued?.act?.label).toBe(RESUME_WALKTHROUGH);
    queued?.act?.run();
    expect(listQueuedTutorials()).toEqual([]);
    unbind();
  });

  it("pause all queues every unanswered walkthrough", () => {
    clearNotices();
    noteTutorialDeclined("vault.lock", "Lock the vault");
    expect(listQueuedTutorials()).toEqual([{ goalId: "vault.lock" }]);
    const pause = listNotices().find(
      (notice) => notice.id === TUTORIAL_PAUSE_NOTICE,
    );
    pause?.act?.run();
    expect(sessionTutorialsPaused()).toBe(true);
    expect(listQueuedTutorials().length).toBeGreaterThan(1);
  });

  it("skips the pause prompt when the session is already paused", () => {
    setSessionTutorialsPaused(true);
    noteTutorialDeclined("settings.danger.review", "Tour Settings: Danger");
    expect(
      listNotices().some((notice) => notice.id === TUTORIAL_PAUSE_NOTICE),
    ).toBe(false);
    expect(listQueuedTutorials()).toEqual([
      { goalId: "settings.danger.review" },
    ]);
    clearNotices();
    rehydrateTutorialQueueNotices();
    expect(
      listNotices().some((notice) => notice.act?.label === RESUME_WALKTHROUGH),
    ).toBe(true);
    expect(
      listNotices().some((notice) => notice.id === TUTORIAL_PAUSE_NOTICE),
    ).toBe(false);
  });
});
