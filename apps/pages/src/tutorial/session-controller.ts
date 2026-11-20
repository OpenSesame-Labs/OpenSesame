/**
 * Support session state machine. Split from `session.ts` so the React provider
 * can import the controller without a circular module graph at boot.
 */
import { setStatusNotice } from "@opensesame/app-core/lib/notices.js";
import {
  type TutorialResumeStart,
  bindTutorialResume,
  completeQueuedTutorial,
} from "@opensesame/app-core/lib/tutorial-queue.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { HELP_TOPICS } from "@opensesame/app-core/tutorial/registry/goals.js";
import { rankHelpTopics } from "@opensesame/app-core/tutorial/registry/goals-search.js";
import type { GuideRouteId } from "@opensesame/app-core/tutorial/registry/routes.js";
import { clearMountedGuideTargets } from "@opensesame/app-core/tutorial/registry/targets.js";
import type { GuideProgram } from "@opensesame/guide-lang";
import type { GuideCancelReason } from "@opensesame/guide-runtime";
import { gateSupportAsk } from "./ask-guard.js";
import {
  type GuideOrigin,
  type SupportEngine,
  type SupportHost,
  loadBrowserEngine,
} from "./engine.js";
import { refreshEngineAvailability } from "./refresh-engine.js";
import type {
  SupportController,
  SupportEntryExtras,
  SupportEntryKind,
  SupportSessionDependencies,
  SupportView,
} from "./session.js";
import { noteGrounding, walkthroughsFor } from "./session-grounding.js";
import { emptyView } from "./session-view.js";
import {
  createQueuedResumeHandlers,
  type PendingQueuedResume,
} from "./session-queued-resume.js";
import { queueTourExit } from "./tutorial-exit.js";
import {
  GUIDE_ERROR_TEXT,
  GUIDE_REFUSED_TEXT,
  SUPPORT_ERROR_TEXT,
  UNEXPECTED_TEXT,
} from "./ui/messages.js";

export function createSupportController(
  dependencies: SupportSessionDependencies,
): SupportController {
  let state = emptyView("/vault");
  const listeners = new Set<() => void>();
  const routeListeners = new Set<() => void>();

  let engine: SupportEngine | null = null;
  let loading: Promise<SupportEngine | null> | null = null;
  let stopGuideFeed: (() => void) | null = null;
  let navigator: ((route: GuideRouteId) => boolean) | null = null;
  let pendingQueuedResume: PendingQueuedResume | null = null;
  let queuedResumeLoading = false;
  let unbindResume: (() => void) | null = null;
  let entries = 0;
  let cancelled = false;
  /** Bumped by teardown, so a load in flight cannot install a stale engine. */
  let generation = 0;

  function emit(): void {
    for (const listener of [...listeners]) listener();
  }

  function set(patch: Partial<SupportView>): void {
    state = { ...state, ...patch };
    emit();
  }

  /**
   * A failure is a notice in the tray, never a paragraph inside the sheet.
   *
   * The sheet is where a person is trying to get an answer; an error box in it
   * is explainer copy about the panel rather than the row, field or receipt
   * that failed (`docs/design/controls.md`). The tray already carries every
   * other page condition, so a walkthrough that stopped or a question nothing
   * could answer lands there beside them — and the written help below still
   * works, which is the answer to "what now".
   */
  function notifyFailure(body: string): void {
    setStatusNotice({
      id: "support.failure",
      tone: "warn",
      title: "Support",
      body,
    });
  }

  function push(
    kind: SupportEntryKind,
    text: string,
    suggestions: readonly string[],
    traces?: SupportEntryExtras,
  ): void {
    entries += 1;
    set({
      transcript: [
        ...state.transcript,
        {
          id: `e${entries}`,
          kind,
          text,
          suggestions,
          thoughts: traces?.thoughts ?? null,
          computer: traces?.computer ?? [],
          walkthroughs: traces?.walkthroughs ?? [],
        },
      ],
    });
  }

  const host: SupportHost = {
    navigate: (route) => navigator?.(route),
    currentRoute: () => state.route,
    observeRoute: (route, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        if (state.route === route) {
          queueMicrotask(resolve);
          return;
        }
        const stop = () => {
          routeListeners.delete(check);
          signal.removeEventListener("abort", onAbort);
        };
        const check = () => {
          if (state.route !== route) return;
          stop();
          resolve();
        };
        const onAbort = () => {
          stop();
          reject(new DOMException("aborted", "AbortError"));
        };
        routeListeners.add(check);
        signal.addEventListener("abort", onAbort, { once: true });
      }),
  };

  function ensureEngine(): Promise<SupportEngine | null> {
    if (engine) return Promise.resolve(engine);
    if (!loading) {
      const era = generation;
      loading = dependencies
        .loadEngine(host)
        .then((loaded) => {
          if (era !== generation) {
            loaded.destroy();
            return null;
          }
          engine = loaded;
          stopGuideFeed = loaded.subscribeGuide((snapshot) =>
            set({ guide: snapshot }),
          );
          set({
            ready: true,
            transport: loaded.transport,
            warning: loaded.warning,
          });
          return loaded;
        })
        .catch(() => {
          // Drop a failed chunk load so the next request can retry.
          if (era === generation) {
            loading = null;
            set({ ready: true });
            notifyFailure(UNEXPECTED_TEXT);
          }
          return null;
        });
    }
    return loading;
  }

  const refreshAvailability = () =>
    refreshEngineAvailability(
      ensureEngine,
      () => engine,
      set,
      () => notifyFailure(UNEXPECTED_TEXT),
    );

  async function runProgram(
    program: GuideProgram,
    origin: GuideOrigin,
  ): Promise<void> {
    const loaded = engine;
    if (!loaded) return;
    // A tour points at controls on the page, and this app's sheet covers a
    // third of them — including the statusline the shell targets sit in. So
    // the panel steps aside while one runs; the transcript is still there,
    // and the tour's own card (`CoachHud`) carries the steps.
    set({ open: false });
    const outcome = await loaded.runGuide(program, origin);
    if (engine !== loaded) return;
    if (outcome.kind === "failed") {
      notifyFailure(GUIDE_ERROR_TEXT[outcome.error.code]);
      return;
    }
    if (outcome.kind === "completed") {
      const closing = state.guide?.message;
      if (closing) push("note", closing, []);
      completeQueuedTutorial(outcome.goal);
    }
    if (outcome.kind === "cancelled" && outcome.reason === "user") {
      queueTourExit(outcome.goal);
    }
  }

  async function startGuide(
    source: string,
    origin: GuideOrigin = "model",
  ): Promise<void> {
    if (state.guide !== null || queuedResumeLoading) return;
    const loaded = await ensureEngine();
    if (!loaded) {
      notifyFailure(SUPPORT_ERROR_TEXT.AGENT_UNAVAILABLE);
      return;
    }
    const program =
      origin === "authored"
        ? loaded.compileAuthored(source)
        : loaded.compile(source);
    if (!program) {
      notifyFailure(GUIDE_ERROR_TEXT.GUIDE_VALIDATION_ERROR);
      return;
    }
    await runProgram(program, origin);
  }

  const {
    flushPendingQueuedResume,
    resumeQueuedWalkthrough: resumeQueuedWalkthroughImpl,
  } = createQueuedResumeHandlers({
    getState: () => state,
    getEngine: () => engine,
    ensureEngine,
    getNavigator: () => navigator,
    getPending: () => pendingQueuedResume,
    setPending: (value) => {
      pendingQueuedResume = value;
    },
    guideRunning: () => state.guide !== null,
    queuedResumeLoading: () => queuedResumeLoading,
    setQueuedResumeLoading: (loading) => {
      queuedResumeLoading = loading;
    },
    notifyFailure,
    runAuthoredProgram: (loaded, guide) => {
      const program = loaded.compileAuthored(guide);
      if (!program) {
        notifyFailure(GUIDE_ERROR_TEXT.GUIDE_VALIDATION_ERROR);
        return false;
      }
      void runProgram(program, "authored");
      return true;
    },
  });

  function clearSessionForLock(): void {
    generation += 1;
    stopGuideFeed?.();
    stopGuideFeed = null;
    if (engine) {
      engine.cancelGuide("lock");
      engine.destroy();
    }
    engine = null;
    loading = null;
    dependencies.clearTargets();
    pendingQueuedResume = null;
    queuedResumeLoading = false;
    // Everything the person said, everything that answered, and every overlay
    // it drew goes with the keys.
    state = emptyView(state.route);
    emit();
  }

  function teardown(): void {
    clearSessionForLock();
    unbindResume?.();
    unbindResume = null;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    view() {
      return state;
    },
    open(tab) {
      if (state.open) return;
      const initialTab =
        tab ?? (state.transcript.length === 0 ? "tutorials" : "ask");
      set({ open: true, initialTab });
      void refreshAvailability();
    },
    close() {
      set({ open: false });
    },
    setRoute(route) {
      if (state.route === route) return;
      set({ route });
      for (const listener of [...routeListeners]) listener();
      flushPendingQueuedResume();
    },
    setNavigator(next) {
      navigator = next;
    },
    bindTutorialResume(start: TutorialResumeStart) {
      unbindResume?.();
      unbindResume = bindTutorialResume(start);
      return () => {
        if (unbindResume) {
          unbindResume();
          unbindResume = null;
        }
      };
    },
    resumeQueuedWalkthrough(goalId, guide, homeRoute) {
      return resumeQueuedWalkthroughImpl(goalId, guide, homeRoute);
    },
    async ask(question) {
      const gate = gateSupportAsk(question, state.thinking);
      if (gate.kind === "skip") return;
      const { text } = gate;
      push("question", text, []);
      const loaded = await ensureEngine();
      if (!loaded) {
        const authored = rankHelpTopics(text, state.route).find(
          (e) => e.strong,
        )?.topic;
        if (authored) {
          push("answer", authored.answer, [], {
            walkthroughs: walkthroughsFor([authored]),
          });
          return;
        }
        notifyFailure(SUPPORT_ERROR_TEXT.AGENT_UNAVAILABLE);
        return;
      }
      cancelled = false;
      set({ thinking: true });
      await loaded.session.ask(text);
      if (engine !== loaded) return;
      set({ thinking: false });
      if (cancelled) {
        cancelled = false;
        push("note", SUPPORT_ERROR_TEXT.AGENT_ABORTED, []);
        return;
      }
      const snapshot = loaded.session.snapshot();
      if (snapshot.status === "error") {
        const authored = rankHelpTopics(text, state.route).find(
          (entry) => entry.strong,
        )?.topic;
        if (authored && snapshot.error === "AGENT_UNAVAILABLE") {
          push("answer", authored.answer, [], {
            walkthroughs: walkthroughsFor([authored]),
          });
          void refreshAvailability();
          return;
        }
        notifyFailure(
          SUPPORT_ERROR_TEXT[snapshot.error ?? "AGENT_PROTOCOL_ERROR"],
        );
        void refreshAvailability();
        return;
      }
      const last = snapshot.messages.at(-1);
      if (last && last.role === "assistant") {
        push("answer", last.text, snapshot.suggestedQuestions, {
          thoughts: snapshot.thoughts,
          computer: snapshot.computer,
        });
      }
      // A walkthrough the compiler rejected is reported as a walkthrough that
      // did not run — never as the codes it failed with, and never as the text.
      if (snapshot.guideError) notifyFailure(GUIDE_REFUSED_TEXT);
      if (last && last.role === "assistant") {
        noteGrounding(push, state.route, text, snapshot.grounding);
      }
      if (snapshot.program) await runProgram(snapshot.program, "model");
    },
    cancel() {
      if (!state.thinking) return;
      cancelled = true;
      engine?.session.cancel();
    },
    clear() {
      engine?.session.clear();
      set({ transcript: [] });
    },
    async acquireModel() {
      const loaded = await ensureEngine();
      if (!loaded) return;
      set({ availability: { kind: "downloading", progress: 0 } });
      const result = await loaded.acquire((progress) => {
        if (engine !== loaded) return;
        set({ availability: { kind: "downloading", progress } });
      });
      if (engine !== loaded) return;
      if (result.kind === "failed") {
        notifyFailure(SUPPORT_ERROR_TEXT[result.code]);
      }
      await refreshAvailability();
    },
    answerFromAuthoredHelp(question, answer) {
      push("question", question, []);
      const topic = HELP_TOPICS.find((entry) => entry.answer === answer);
      push("answer", answer, [], {
        walkthroughs: topic ? walkthroughsFor([topic]) : [],
      });
    },
    startGuide(source, origin) {
      return startGuide(source, origin);
    },
    pauseGuide() {
      engine?.pauseGuide();
    },
    nextStep() {
      engine?.nextStep();
    },
    backStep() {
      engine?.backStep();
    },
    replayGuide() {
      engine?.restartGuide();
    },
    stopGuide(reason: GuideCancelReason = "user") {
      engine?.cancelGuide(reason);
    },
    lock() {
      clearSessionForLock();
    },
    destroy() {
      teardown();
      listeners.clear();
      routeListeners.clear();
    },
  };
}

/** Swapped wholesale by tests; the browser wiring is the default. */
export const supportSessionSeams: SupportSessionDependencies = {
  loadEngine: loadBrowserEngine,
  onLock: (handler) => vaultStore.onLock(handler),
  clearTargets: clearMountedGuideTargets,
};
