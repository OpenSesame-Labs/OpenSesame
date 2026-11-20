import { setStatusNotice } from "@opensesame/app-core/lib/notices.js";
import { completeQueuedTutorial } from "@opensesame/app-core/lib/tutorial-queue.js";
import type { GuideRouteId } from "@opensesame/app-core/tutorial/registry/routes.js";
import type { GuideProgram } from "@opensesame/guide-lang";
import type { GuideOrigin, SupportEngine, SupportHost } from "./engine.js";
import { guideSnapshotActive } from "./guide-snapshot-active.js";
import { refreshEngineAvailability } from "./refresh-engine.js";
import type {
  SupportEntryExtras,
  SupportEntryKind,
  SupportSessionDependencies,
  SupportView,
} from "./session.js";
import {
  type PendingQueuedResume,
  createQueuedResumeHandlers,
} from "./session-queued-resume.js";
import { emptyView } from "./session-view.js";
import { queueTourExit } from "./tutorial-exit.js";
import {
  GUIDE_ERROR_TEXT,
  SUPPORT_ERROR_TEXT,
  UNEXPECTED_TEXT,
} from "./ui/messages.js";

export type SupportAskBinding = {
  ask: (question: string) => Promise<void>;
  cancel: () => void;
  answerFromAuthoredHelp: (question: string, answer: string) => void;
};

export class SupportControllerCore {
  state = emptyView("/vault");
  readonly listeners = new Set<() => void>();
  readonly routeListeners = new Set<() => void>();

  engine: SupportEngine | null = null;
  loading: Promise<SupportEngine | null> | null = null;
  stopGuideFeed: (() => void) | null = null;
  navigator: ((route: GuideRouteId) => boolean) | null = null;
  pendingQueuedResume: PendingQueuedResume | null = null;
  queuedResumeLoading = false;
  unbindResume: (() => void) | null = null;
  entries = 0;
  cancelled = false;
  /** Bumped by teardown, so a load in flight cannot install a stale engine. */
  generation = 0;

  readonly host: SupportHost;

  constructor(readonly dependencies: SupportSessionDependencies) {
    this.host = this.createHost();
  }

  emit(): void {
    for (const listener of [...this.listeners]) listener();
  }

  set(patch: Partial<SupportView>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  notifyFailure(body: string): void {
    setStatusNotice({
      id: "support.failure",
      tone: "warn",
      title: "Support",
      body,
    });
  }

  push(
    kind: SupportEntryKind,
    text: string,
    suggestions: readonly string[],
    traces?: SupportEntryExtras,
  ): void {
    this.entries += 1;
    this.set({
      transcript: [
        ...this.state.transcript,
        {
          id: `e${this.entries}`,
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

  private createHost(): SupportHost {
    return {
      navigate: (route) => this.navigator?.(route),
      currentRoute: () => this.state.route,
      observeRoute: (route, signal) =>
        new Promise<void>((resolve, reject) => {
          if (signal.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          if (this.state.route === route) {
            queueMicrotask(resolve);
            return;
          }
          const stop = () => {
            this.routeListeners.delete(check);
            signal.removeEventListener("abort", onAbort);
          };
          const check = () => {
            if (this.state.route !== route) return;
            stop();
            resolve();
          };
          const onAbort = () => {
            stop();
            reject(new DOMException("aborted", "AbortError"));
          };
          this.routeListeners.add(check);
          signal.addEventListener("abort", onAbort, { once: true });
        }),
    };
  }

  ensureEngine(): Promise<SupportEngine | null> {
    if (this.engine) return Promise.resolve(this.engine);
    if (!this.loading) {
      const era = this.generation;
      this.loading = this.dependencies
        .loadEngine(this.host)
        .then((loaded) => {
          if (era !== this.generation) {
            loaded.destroy();
            return null;
          }
          this.engine = loaded;
          this.stopGuideFeed = loaded.subscribeGuide((snapshot) =>
            this.set({ guide: snapshot }),
          );
          this.set({
            ready: true,
            transport: loaded.transport,
            warning: loaded.warning,
          });
          return loaded;
        })
        .catch(() => {
          if (era === this.generation) {
            this.loading = null;
            this.set({ ready: true });
            this.notifyFailure(UNEXPECTED_TEXT);
          }
          return null;
        });
    }
    return this.loading;
  }

  refreshAvailability = (): Promise<void> =>
    refreshEngineAvailability(
      () => this.ensureEngine(),
      () => this.engine,
      (patch) => this.set(patch),
      () => this.notifyFailure(UNEXPECTED_TEXT),
    );

  async runProgram(program: GuideProgram, origin: GuideOrigin): Promise<void> {
    const loaded = this.engine;
    if (!loaded) return;
    this.set({ open: false });
    const outcome = await loaded.runGuide(program, origin);
    if (this.engine !== loaded) return;
    if (outcome.kind === "failed") {
      this.notifyFailure(GUIDE_ERROR_TEXT[outcome.error.code]);
      return;
    }
    if (outcome.kind === "completed") {
      const closing = this.state.guide?.message;
      if (closing) this.push("note", closing, []);
      completeQueuedTutorial(outcome.goal);
    }
    if (outcome.kind === "cancelled" && outcome.reason === "user") {
      queueTourExit(outcome.goal);
    }
  }

  async startGuide(
    source: string,
    origin: GuideOrigin = "model",
  ): Promise<void> {
    if (guideSnapshotActive(this.state.guide) || this.queuedResumeLoading)
      return;
    const loaded = await this.ensureEngine();
    if (!loaded) {
      this.notifyFailure(SUPPORT_ERROR_TEXT.AGENT_UNAVAILABLE);
      return;
    }
    const program =
      origin === "authored"
        ? loaded.compileAuthored(source)
        : loaded.compile(source);
    if (!program) {
      this.notifyFailure(GUIDE_ERROR_TEXT.GUIDE_VALIDATION_ERROR);
      return;
    }
    await this.runProgram(program, origin);
  }

  clearSessionForLock(): void {
    this.generation += 1;
    this.stopGuideFeed?.();
    this.stopGuideFeed = null;
    if (this.engine) {
      this.engine.cancelGuide("lock");
      this.engine.destroy();
    }
    this.engine = null;
    this.loading = null;
    this.dependencies.clearTargets();
    this.pendingQueuedResume = null;
    this.queuedResumeLoading = false;
    this.state = emptyView(this.state.route);
    this.emit();
  }

  teardown(): void {
    this.clearSessionForLock();
    this.unbindResume?.();
    this.unbindResume = null;
  }

  createQueuedResume() {
    return createQueuedResumeHandlers({
      getState: () => this.state,
      getEngine: () => this.engine,
      ensureEngine: () => this.ensureEngine(),
      loadGeneration: () => this.generation,
      getNavigator: () => this.navigator,
      getPending: () => this.pendingQueuedResume,
      setPending: (value) => {
        this.pendingQueuedResume = value;
      },
      guideRunning: () => guideSnapshotActive(this.state.guide),
      queuedResumeLoading: () => this.queuedResumeLoading,
      setQueuedResumeLoading: (loading) => {
        this.queuedResumeLoading = loading;
      },
      notifyFailure: (body) => this.notifyFailure(body),
      runAuthoredProgram: (loaded, guide) => {
        const program = loaded.compileAuthored(guide);
        if (!program) {
          this.notifyFailure(GUIDE_ERROR_TEXT.GUIDE_VALIDATION_ERROR);
          return false;
        }
        void this.runProgram(program, "authored");
        return true;
      },
    });
  }
}
