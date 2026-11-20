import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guideGoalIds } from "../tutorial/registry/goals.js";
import { toastOf } from "./notice-toast.js";
import { clearNotices, listNotices, setStatusNotice } from "./notices.js";
import {
  TUTORIAL_PAUSE_NOTICE,
  TUTORIAL_QUEUE_LIMIT,
  bindTutorialResume,
  completeQueuedTutorial,
  dequeueTutorial,
  listQueuedTutorials,
  queueTutorial,
  resumeTutorialFromNotice,
  sessionTutorialsPaused,
  setQueuedTutorials,
  setSessionTutorialsPaused,
  storedQueuedGoalIds,
  subscribeSessionTutorialsPaused,
  tutorialQueueSeams,
  tutorialsMaySpeak,
} from "./tutorial-queue.js";
import {
  ONLY_THIS_TUTORIAL,
  PAUSE_ALL_FOR_SESSION,
  RESUME_WALKTHROUGH,
  installTutorialQueueLibraryOptions,
  noteTutorialDeclined,
  postQueuedTutorialNotice,
  refreshQueuedTutorialTrayNotices,
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

  it("dequeues a stored id while its goal is not in the live registry", () => {
    tutorialQueueSeams.write(
      JSON.stringify({ goals: ["feature.unloaded", "vault.lock"] }),
    );
    expect(listQueuedTutorials()).toEqual([{ goalId: "vault.lock" }]);
    dequeueTutorial("feature.unloaded");
    expect(JSON.parse(raw ?? "{}").goals).toEqual(["vault.lock"]);
  });

  it("completes a stored id after its contribution unloads", () => {
    tutorialQueueSeams.write(
      JSON.stringify({ goals: ["feature.unloaded", "vault.lock"] }),
    );
    setStatusNotice({
      id: "tutorial.queue.feature.unloaded",
      tone: "info",
      title: "Unloaded",
      body: "Queued.",
    });
    completeQueuedTutorial("feature.unloaded");
    expect(JSON.parse(raw ?? "{}").goals).toEqual(["vault.lock"]);
    expect(
      listNotices().some(
        (notice) => notice.id === "tutorial.queue.feature.unloaded",
      ),
    ).toBe(false);
    expect(listQueuedTutorials()).toEqual([{ goalId: "vault.lock" }]);
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

  it("drops an unbind without restoring a stale binder underneath", () => {
    const outer: string[] = [];
    const inner: string[] = [];
    const unbindOuter = bindTutorialResume(() => {
      outer.push("outer");
      return false;
    });
    const unbindInner = bindTutorialResume(() => {
      inner.push("inner");
      return true;
    });
    queueTutorial("vault.lock", { title: "Lock the vault" });
    expect(resumeTutorialFromNotice("vault.lock")).toBe(true);
    expect(inner).toEqual(["inner"]);
    expect(listQueuedTutorials()).toEqual([]);
    unbindOuter();
    queueTutorial("vault.lock", { title: "Lock the vault" });
    expect(resumeTutorialFromNotice("vault.lock")).toBe(true);
    expect(inner).toEqual(["inner", "inner"]);
    expect(listQueuedTutorials()).toEqual([]);
    unbindInner();
    queueTutorial("vault.lock", { title: "Lock the vault" });
    expect(resumeTutorialFromNotice("vault.lock")).toBe(false);
    expect(listQueuedTutorials()).toEqual([{ goalId: "vault.lock" }]);
  });

  it("drops the notice when resume succeeds without the binder completing the queue", () => {
    const unbind = bindTutorialResume(() => true);
    queueTutorial("vault.lock", { title: "Lock the vault" });
    setStatusNotice({
      id: "tutorial.queue.vault.lock",
      tone: "info",
      title: "Lock the vault",
      body: "Queued.",
    });
    expect(resumeTutorialFromNotice("vault.lock")).toBe(true);
    expect(listQueuedTutorials()).toEqual([]);
    expect(
      listNotices().some((notice) => notice.id === "tutorial.queue.vault.lock"),
    ).toBe(false);
    unbind();
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

  it("does not queue gate tours declined away from their gate", () => {
    clearNotices();
    expect(noteTutorialDeclined("gate.front-door", "The front door")).toBe(
      false,
    );
    expect(listQueuedTutorials()).toEqual([]);
    expect(
      listNotices().some((notice) => notice.id === TUTORIAL_PAUSE_NOTICE),
    ).toBe(true);
    clearNotices();
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

  it("refuses a new id at the limit instead of evicting the oldest", () => {
    const others = guideGoalIds().filter((id) => id !== "vault.lock");
    expect(others.length).toBeGreaterThanOrEqual(TUTORIAL_QUEUE_LIMIT);
    for (const goalId of others.slice(0, TUTORIAL_QUEUE_LIMIT)) {
      expect(queueTutorial(goalId, { title: "Tour" })).toBe(true);
    }
    const atLimit = storedQueuedGoalIds();
    expect(atLimit).toHaveLength(TUTORIAL_QUEUE_LIMIT);
    expect(queueTutorial("vault.lock", { title: "Lock the vault" })).toBe(
      false,
    );
    expect(storedQueuedGoalIds()).toEqual(atLimit);
    // An id already queued stays success even at the limit.
    expect(queueTutorial(atLimit[0], { title: "Tour" })).toBe(true);
    expect(storedQueuedGoalIds()).toEqual(atLimit);
  });

  it("setQueuedTutorials refuses new ids at the limit, keeping stored ones", () => {
    const ids = guideGoalIds().slice(0, TUTORIAL_QUEUE_LIMIT);
    setQueuedTutorials(ids);
    expect(storedQueuedGoalIds()).toHaveLength(TUTORIAL_QUEUE_LIMIT);
    const atLimit = storedQueuedGoalIds();
    const notStored = guideGoalIds().find((id) => !atLimit.includes(id));
    expect(notStored).toBeDefined();
    setQueuedTutorials([notStored ?? "vault.lock", atLimit[0]]);
    expect(storedQueuedGoalIds()).toEqual(atLimit);
  });

  it("setQueuedTutorials keeps stored ids when the goal is not in the registry", () => {
    tutorialQueueSeams.write(
      JSON.stringify({ goals: ["feature.unloaded", "vault.lock"] }),
    );
    setQueuedTutorials(["settings.danger.review", "vault.lock"]);
    expect(storedQueuedGoalIds()).toEqual(
      expect.arrayContaining([
        "feature.unloaded",
        "vault.lock",
        "settings.danger.review",
      ]),
    );
  });

  it("resume act skips start when live queueableGoal fails", () => {
    let started = false;
    const unbind = bindTutorialResume(() => {
      started = true;
      return true;
    });
    queueTutorial("vault.item.accounts", { title: "Accounts" });
    postQueuedTutorialNotice("vault.item.accounts", { toast: false });
    installTutorialQueueLibraryOptions({
      sectionDrawn: () => false,
      holds: () => false,
    });
    const row = listNotices().find(
      (notice) => notice.id === "tutorial.queue.vault.item.accounts",
    );
    row?.act?.run();
    expect(started).toBe(false);
    expect(JSON.parse(raw ?? "{}").goals).toContain("vault.item.accounts");
    installTutorialQueueLibraryOptions({});
    unbind();
  });

  it("suppresses a restored tray row whose goal is not in the live queue", () => {
    installTutorialQueueLibraryOptions({});
    tutorialQueueSeams.write(
      JSON.stringify({ goals: ["feature.unloaded", "vault.lock"] }),
    );
    setStatusNotice({
      id: "tutorial.queue.feature.unloaded",
      tone: "info",
      title: "Unloaded",
      body: "Queued.",
    });
    refreshQueuedTutorialTrayNotices();
    expect(
      listNotices().some(
        (notice) => notice.id === "tutorial.queue.feature.unloaded",
      ),
    ).toBe(false);
    expect(
      listNotices().some((notice) => notice.id === "tutorial.queue.vault.lock"),
    ).toBe(true);
    expect(listQueuedTutorials()).toEqual([{ goalId: "vault.lock" }]);
    expect(storedQueuedGoalIds()).toEqual(
      expect.arrayContaining(["feature.unloaded", "vault.lock"]),
    );
  });

  it("does not repost resume when live queueableGoal fails on refresh", () => {
    expect(queueTutorial("vault.item.accounts", { title: "Accounts" })).toBe(
      true,
    );
    installTutorialQueueLibraryOptions({ holds: () => false });
    rehydrateTutorialQueueNotices();
    expect(
      listNotices().some(
        (notice) => notice.id === "tutorial.queue.vault.item.accounts",
      ),
    ).toBe(false);
    expect(listQueuedTutorials()).toEqual([{ goalId: "vault.item.accounts" }]);
    expect(JSON.parse(raw ?? "{}").goals).toContain("vault.item.accounts");
    clearNotices();
    installTutorialQueueLibraryOptions({});
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
