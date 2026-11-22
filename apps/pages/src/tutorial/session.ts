import type { TutorialResumeStart } from "@opensesame/app-core/lib/tutorial-queue.js";
import type { GuideRouteId } from "@opensesame/app-core/tutorial/registry/routes.js";
/**
 * The composition root for in-product support.
 *
 * Everything the feature is made of is assembled here — the registries that
 * decide what a model may be told and what it may name, whichever agent this
 * browser can actually reach, the deterministic guide runtime, and the
 * renderer that draws on the page. Nothing above this file knows any of them
 * exist: the shell gets a button, the panel gets a controller.
 *
 * **The transcript is memory, and only memory.** Nothing here writes to
 * `localStorage`, `sessionStorage`, IndexedDB, a vault item, a query string or
 * a log line. A support conversation is a record of what somebody could not
 * work out on their own, and keeping that is no part of answering it. Locking
 * the vault drops it outright, along with the model session that saw it.
 *
 * Nothing costly is imported at module scope either. A closed panel costs the
 * boot bundle one button and this state machine; the agent adapters, the guide
 * runtime, Driver.js and the capability registry all arrive on first open.
 */
import type {
  GuideCancelReason,
  GuideRuntimeSnapshot,
} from "@opensesame/guide-runtime";
import type {
  SupportAgentAvailability,
  SupportComputerStep,
} from "@opensesame/support-agent";
import type {
  GuideOrigin,
  SupportEngine,
  SupportHost,
  SupportTransport,
} from "./engine.js";
import type { SupportWalkthrough } from "./session-grounding.js";

export type {
  GuideOrigin,
  SupportAcquireResult,
  SupportEngine,
  SupportHost,
  SupportTransport,
} from "./engine.js";
export { loadBrowserEngine } from "./engine.js";
export type { SupportWalkthrough } from "./session-grounding.js";
export type SupportEntryKind = "question" | "answer" | "note";
/** What an answer or note carries besides its text; every member optional. */
export type SupportEntryExtras = {
  readonly thoughts?: string | null;
  readonly computer?: readonly SupportComputerStep[];
  readonly walkthroughs?: readonly SupportWalkthrough[];
};
/**
 * One line of the conversation. Text only — the panel renders it as React text
 * nodes, so there is no markup path from a model into the document.
 */
export type SupportEntry = {
  readonly id: string;
  readonly kind: SupportEntryKind;
  readonly text: string;
  readonly suggestions: readonly string[];
  readonly thoughts: string | null;
  readonly computer: readonly SupportComputerStep[];
  /** Checked-in walkthroughs that go with the written help this line rests on. */
  readonly walkthroughs: readonly SupportWalkthrough[];
};
export type SupportTab = "ask" | "tutorials";

export type SupportView = {
  readonly open: boolean;
  readonly initialTab: SupportTab;
  /** True once the engine has loaded. The written help works before it does. */
  readonly ready: boolean;
  readonly thinking: boolean;
  /** Null until something has reported. */
  readonly availability: SupportAgentAvailability | null;
  readonly transport: SupportTransport;
  /** The remote-transport warning, present only when answers leave the device. */
  readonly warning: string | null;
  readonly transcript: readonly SupportEntry[];
  readonly guide: GuideRuntimeSnapshot | null;
  readonly route: GuideRouteId;
};

export interface SupportController {
  subscribe(listener: () => void): () => void;
  view(): SupportView;
  open(tab?: SupportTab): void;
  close(): void;
  setRoute(route: GuideRouteId): void;
  setNavigator(navigate: (route: GuideRouteId) => boolean): void;
  ask(question: string): Promise<void>;
  /** Stops the question in flight. The panel stays open and keeps its history. */
  cancel(): void;
  clear(): void;
  acquireModel(): Promise<void>;
  /** Puts an authored question and its checked-in answer into the transcript. */
  answerFromAuthoredHelp(question: string, answer: string): void;
  startGuide(source: string, origin?: GuideOrigin): Promise<void>;
  pauseGuide(): void;
  /** Tour controls: each is a no-op when no tour is on a step. */
  nextStep(): void;
  backStep(): void;
  replayGuide(): void;
  /**
   * Leaves the tour. Escape and the close key pass no reason, which is a
   * person's exit. A stop the product takes itself names why, and is not queued.
   */
  stopGuide(reason?: GuideCancelReason): void;
  /**
   * The vault locked. Drops the transcript, the model session and every
   * overlay a walkthrough drew, and resets the panel.
   */
  lock(): void;
  destroy(): void;
  bindTutorialResume(start: TutorialResumeStart): () => void;
  resumeQueuedWalkthrough(
    goalId: string,
    guide: string,
    homeRoute: string,
  ): boolean;
}

export type SupportSessionDependencies = {
  loadEngine: (host: SupportHost) => Promise<SupportEngine>;
  onLock: (handler: () => void) => () => void;
  clearTargets: () => void;
};

export {
  createSupportController,
  supportSessionSeams,
} from "./session-controller.js";

export {
  type SupportAccess,
  SupportProvider,
  SupportRouteOverrideContext,
  useSupport,
  useSupportRoute,
} from "./session-provider.js";
